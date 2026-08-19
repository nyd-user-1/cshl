// scripts/mine/citations.mjs — the citation-graph harvester (LANE-MINE task 1).
//
//   node --env-file=.env.local scripts/mine/citations.mjs --race [--n 1000]
//   node --env-file=.env.local scripts/mine/citations.mjs --walk [--server both]
//   node --env-file=.env.local scripts/mine/citations.mjs --gapfill
//   node --env-file=.env.local scripts/mine/citations.mjs --resolve
//
// Signal: cited = positive, citation-of-citation-not-cited = hard negative
// (the SPECTER/SciNCL recipe). What matters for triplet mining is the IN-CORPUS
// edge, so every reference is resolved back to our business key where it exists;
// out-of-corpus references are kept for later graph enrichment.
//
// ── why the source walk and not DOI batching ─────────────────────────────────
// OpenAlex bills 1 credit per filter call against a 10,000/day pool that is
// SHARED with the 44b project. Batching our DOIs 50 at a time costs ~8.7k
// credits — most of the day's pool. Cursor-walking the two rxiv *sources*
// instead (bioRxiv S4306402567, medRxiv S3005729997) returns 200 works/call,
// costs ~2.1k credits for the same corpus, and hands back the
// OpenAlex-work-id → DOI map we need to resolve references — for free, because
// every rxiv work in the graph is in the walk. DOI batching survives only as
// the gap-fill for papers the source walk misses.

import {
  Pacer, fetchRetry, jsonlWriter, existingKeys, readJsonl, psqlRows, rowCounts,
  log, has, numArg, strArg, chunk, bareDoi, bareW, human, bytesOf, elapsed,
} from "./lib.mjs";
import { existsSync, writeFileSync, readFileSync } from "node:fs";

const OA = "https://api.openalex.org";
const OA_KEY = process.env.OPENALEX_API_KEY || "";
const MAILTO = process.env.OPENALEX_MAILTO || "brendan@nysgpt.com";
const S2 = "https://api.semanticscholar.org/graph/v1/paper/batch";
const S2_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY || "";

// OpenAlex source ids for the two servers (verified against /sources).
const SOURCES = {
  biorxiv: "S4306402567",
  medrxiv: "S3005729997",
};

const RAW = "data/mine/raw/openalex-works.jsonl";
const GAP = "data/mine/raw/openalex-gapfill.jsonl";
const OUT = "data/mine/citations.jsonl";
const STATE = "data/mine/raw/walk-state.json";

const RPS = numArg("--rps", 8);
const CONC = numArg("--concurrency", 4);
const FLOOR = numArg("--floor", 500);      // stop with this many OpenAlex credits left
const N = numArg("--n", 1000);

const oaUrl = (path, params) => {
  const u = new URL(OA + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("mailto", MAILTO);
  if (OA_KEY) u.searchParams.set("api_key", OA_KEY);
  return u.toString();
};

let creditsLeft = Infinity;
function noteCredits(headers) {
  const r = Number(headers.get("x-ratelimit-remaining"));
  if (Number.isFinite(r)) creditsLeft = r;
}

// ── sample DOIs from the corpus (read-only) ──────────────────────────────────
async function sampleDois(n) {
  const rows = await psqlRows(
    `SELECT key_number, server, doi FROM preprints ORDER BY md5(key_number) LIMIT ${n};`
  );
  return rows.map(([key, server, doi]) => ({ key, server, doi }));
}

// ── arm A: OpenAlex, DOIs batched into one filter ────────────────────────────
async function armOpenAlexBatch(sample, batchSize = 50) {
  const pacer = new Pacer(RPS, CONC);
  const batches = chunk(sample, batchSize);
  const t0 = Date.now();
  let calls = 0, found = 0, refsTotal = 0, withRefs = 0, errors = 0;
  const byDoi = new Map();
  await Promise.all(batches.map(async (b) => {
    const filter = "doi:" + b.map((r) => bareDoi(r.doi)).join("|");
    const url = oaUrl("/works", { filter, select: "id,doi,referenced_works", "per-page": String(batchSize) });
    const res = await fetchRetry(url, { pacer });
    calls++;
    if (!res.ok || !res.json?.results) { errors++; return; }
    noteCredits(res.headers);
    for (const w of res.json.results) {
      const d = bareDoi(w.doi);
      const refs = (w.referenced_works || []).map(bareW);
      byDoi.set(d, { w: bareW(w.id), refs });
      found++; refsTotal += refs.length; if (refs.length) withRefs++;
    }
  }));
  const secs = (Date.now() - t0) / 1000;
  return { arm: `openalex-batch/${batchSize}`, calls, secs, rps: calls / secs, papers: sample.length, found, withRefs, refsTotal, errors, byDoi };
}

// ── arm B: Semantic Scholar graph batch ──────────────────────────────────────
async function armS2Batch(sample, batchSize = 500) {
  const pacer = new Pacer(numArg("--s2-rps", 1), 1);   // S2 keys are rate-tiered; start polite
  const batches = chunk(sample, batchSize);
  const t0 = Date.now();
  let calls = 0, found = 0, refsTotal = 0, withRefs = 0, errors = 0, nulls = 0;
  const byDoi = new Map();
  for (const b of batches) {
    const res = await fetchRetry(`${S2}?fields=externalIds,referenceCount,references.externalIds`, {
      pacer, method: "POST",
      headers: { "x-api-key": S2_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ ids: b.map((r) => "DOI:" + bareDoi(r.doi)) }),
      timeoutMs: 180_000,
    });
    calls++;
    if (!res.ok || !Array.isArray(res.json)) { errors++; continue; }
    for (let i = 0; i < res.json.length; i++) {
      const w = res.json[i];
      if (!w) { nulls++; continue; }
      const refs = (w.references || []).map((r) => r?.externalIds?.DOI).filter(Boolean).map(bareDoi);
      byDoi.set(bareDoi(b[i].doi), { w: w.paperId, refs, declared: w.referenceCount ?? 0 });
      found++; refsTotal += refs.length; if (refs.length) withRefs++;
    }
  }
  const secs = (Date.now() - t0) / 1000;
  return { arm: `s2-batch/${batchSize}`, calls, secs, rps: calls / secs, papers: sample.length, found, withRefs, refsTotal, errors, nulls, byDoi };
}

// ── arm C: OpenAlex source cursor walk (throughput probe only) ───────────────
async function armWalkProbe(pages = 8) {
  const pacer = new Pacer(RPS, 1);          // cursor paging is inherently serial
  const t0 = Date.now();
  let cursor = "*", calls = 0, works = 0, refsTotal = 0, withRefs = 0;
  while (calls < pages && cursor) {
    const url = oaUrl("/works", {
      filter: `primary_location.source.id:${SOURCES.biorxiv}`,
      select: "id,doi,referenced_works", "per-page": "200", cursor,
    });
    const res = await fetchRetry(url, { pacer });
    calls++;
    if (!res.ok || !res.json?.results) break;
    noteCredits(res.headers);
    for (const w of res.json.results) {
      const refs = w.referenced_works || [];
      works++; refsTotal += refs.length; if (refs.length) withRefs++;
    }
    cursor = res.json.meta?.next_cursor || null;
  }
  const secs = (Date.now() - t0) / 1000;
  return { arm: "openalex-walk/200", calls, secs, rps: calls / secs, papers: works, found: works, withRefs, refsTotal, errors: 0 };
}

function reportRow(r) {
  return [
    r.arm.padEnd(22),
    String(r.calls).padStart(6),
    r.secs.toFixed(1).padStart(7) + "s",
    r.rps.toFixed(2).padStart(6) + " req/s",
    ((r.found / r.papers) * 100).toFixed(1).padStart(6) + "% found",
    ((r.withRefs / r.papers) * 100).toFixed(1).padStart(6) + "% w/refs",
    (r.refsTotal / Math.max(1, r.found)).toFixed(1).padStart(6) + " refs/paper",
    (r.papers / r.secs).toFixed(0).padStart(6) + " papers/s",
  ].join(" | ");
}

// ── race ─────────────────────────────────────────────────────────────────────
async function race() {
  const counts = await rowCounts();
  log(`corpus right now: ${counts.preprints} preprints (${counts.published} with a published DOI)`);
  const sample = await sampleDois(N);
  log(`probe sample: ${sample.length} DOIs (deterministic md5 order, not random — reruns compare like for like)`);

  const results = [];
  results.push(await armOpenAlexBatch(sample, 50));
  log(reportRow(results[0]));
  results.push(await armS2Batch(sample, 500));
  log(reportRow(results[1]));
  results.push(await armWalkProbe(numArg("--walk-pages", 8)));
  log(reportRow(results[2]));

  // Agreement: where both resolved the same paper, how do the reference sets compare?
  const [oa, s2] = results;
  let both = 0, oaOnly = 0, s2Only = 0, oaRefs = 0, s2Refs = 0;
  for (const r of sample) {
    const d = bareDoi(r.doi);
    const a = oa.byDoi.get(d), b = s2.byDoi.get(d);
    if (a && b) { both++; oaRefs += a.refs.length; s2Refs += b.refs.length; }
    else if (a) oaOnly++;
    else if (b) s2Only++;
  }
  log(`agreement: both=${both} openalex-only=${oaOnly} s2-only=${s2Only} | on the shared set, refs/paper openalex=${(oaRefs / Math.max(1, both)).toFixed(1)} s2=${(s2Refs / Math.max(1, both)).toFixed(1)}`);
  log(`openalex credits left today: ${creditsLeft}`);

  writeFileSync("data/mine/raw/race.json", JSON.stringify({
    n: sample.length, at: new Date().toISOString(), creditsLeft,
    arms: results.map(({ byDoi, ...r }) => r),
    agreement: { both, oaOnly, s2Only, oaRefsPerPaper: oaRefs / Math.max(1, both), s2RefsPerPaper: s2Refs / Math.max(1, both) },
  }, null, 2));
  log("wrote data/mine/raw/race.json");
}

// ── full source walk (sharded by publication year) ───────────────────────────
// One 1,700-page cursor is a single point of failure and latency-bound at ~1.5
// req/s. Sharding by publication_year gives ~22 independent cursors we can run
// concurrently at the same aggregate pace, each resumable on its own — same
// credit cost, a fraction of the wall-clock.
const YEARS = {
  biorxiv: [2013, 2026],
  medrxiv: [2019, 2026],
};

async function walk() {
  const which = strArg("--server", "both");
  const servers = which === "both" ? ["biorxiv", "medrxiv"] : [which];
  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  const out = jsonlWriter(RAW);
  const pacer = new Pacer(RPS, CONC);
  const shards = [];
  for (const server of servers) {
    const [a, b] = YEARS[server];
    for (let y = a; y <= b; y++) shards.push({ server, year: y, id: `${server}:${y}` });
  }
  const pending = shards.filter((s) => !state[s.id]?.done);
  log(`walk: ${shards.length} shards (${pending.length} outstanding), ${CONC} in flight, ≤${RPS} req/s aggregate`);

  let works = 0, calls = 0, stopped = false;
  const runShard = async (sh) => {
    let cursor = state[sh.id]?.cursor ?? "*";
    let n = state[sh.id]?.works ?? 0;
    while (cursor && !stopped) {
      if (creditsLeft < FLOOR) { stopped = true; log(`STOP: OpenAlex credits ${creditsLeft} < floor ${FLOOR}. State saved — rerun after the daily reset.`); break; }
      const url = oaUrl("/works", {
        filter: `primary_location.source.id:${SOURCES[sh.server]},publication_year:${sh.year}`,
        select: "id,doi,referenced_works,publication_year", "per-page": "200", cursor,
      });
      const res = await fetchRetry(url, { pacer });
      calls++;
      if (!res.ok || !res.json?.results) { log(`${sh.id}: page failed (HTTP ${res.status}) — shard left open, rerun resumes`); return; }
      noteCredits(res.headers);
      for (const w of res.json.results) {
        await out.write({ w: bareW(w.id), doi: bareDoi(w.doi), server: sh.server, year: w.publication_year ?? null, refs: (w.referenced_works || []).map(bareW) });
        works++; n++;
      }
      cursor = res.json.meta?.next_cursor || null;
      state[sh.id] = { cursor, works: n, done: !cursor };
      writeFileSync(STATE, JSON.stringify(state, null, 2));
      if (calls % 40 === 0) log(`${works} works · ${calls} calls · ${(works / elapsed()).toFixed(0)} works/s · credits ${creditsLeft}`);
    }
    if (!cursor) log(`${sh.id}: complete (${n} works)`);
  };

  // Bounded fan-out: the Pacer already caps concurrency, this just keeps the
  // shard queue from materialising 22 promises that all sit on the bucket.
  const queue = [...pending];
  await Promise.all(Array.from({ length: Math.min(CONC, queue.length) }, async () => {
    while (queue.length && !stopped) await runShard(queue.shift());
  }));

  await out.drain(); await out.close();
  const doneCount = shards.filter((s) => state[s.id]?.done).length;
  log(`walk: ${works} works this run · ${calls} calls · ${doneCount}/${shards.length} shards complete · ${human(bytesOf(RAW))} at ${RAW}`);
}

// ── gap fill: corpus DOIs the source walk did not return ─────────────────────
async function gapfill() {
  const inWalk = new Set();
  for await (const r of readJsonl(RAW)) if (r.doi) inWalk.add(r.doi);
  log(`walk covers ${inWalk.size} distinct DOIs`);
  const rows = await psqlRows(`SELECT key_number, server, doi FROM preprints;`);
  const missing = rows.filter(([, , doi]) => !inWalk.has(bareDoi(doi)));
  log(`corpus ${rows.length} papers → ${missing.length} not in the walk (${((missing.length / rows.length) * 100).toFixed(2)}%)`);
  if (!missing.length) return;

  const done = await existingKeys(GAP, "doi");
  const todo = missing.filter(([, , doi]) => !done.has(bareDoi(doi)));
  log(`gap-fill: ${todo.length} to fetch (${done.size} already on disk), ~${Math.ceil(todo.length / 50)} credits`);
  const out = jsonlWriter(GAP);
  const pacer = new Pacer(RPS, CONC);
  let hit = 0;
  const batches = chunk(todo, 50);
  for (const b of batches) {
    if (creditsLeft < FLOOR) { log(`STOP: credits ${creditsLeft} < floor ${FLOOR}`); break; }
    const url = oaUrl("/works", { filter: "doi:" + b.map(([, , d]) => bareDoi(d)).join("|"), select: "id,doi,referenced_works,publication_year", "per-page": "50" });
    const res = await fetchRetry(url, { pacer });
    if (!res.ok || !res.json?.results) continue;
    noteCredits(res.headers);
    const seen = new Set();
    for (const w of res.json.results) {
      const d = bareDoi(w.doi);
      seen.add(d); hit++;
      const row = b.find(([, , dd]) => bareDoi(dd) === d);
      await out.write({ w: bareW(w.id), doi: d, server: row?.[1] ?? null, year: w.publication_year ?? null, refs: (w.referenced_works || []).map(bareW) });
    }
    // Record the misses too, so a rerun does not re-spend on papers OpenAlex simply does not have.
    for (const [, server, d] of b) if (!seen.has(bareDoi(d))) await out.write({ w: null, doi: bareDoi(d), server, year: null, refs: [], absent: true });
  }
  await out.drain(); await out.close();
  log(`gap-fill: resolved ${hit} of ${todo.length}`);
}

// ── resolve: raw OpenAlex works → data/mine/citations.jsonl ──────────────────
async function resolve() {
  // 1. corpus map: bare DOI → {key, server}
  const rows = await psqlRows(`SELECT key_number, server, doi FROM preprints;`);
  const byDoi = new Map(rows.map(([key, server, doi]) => [bareDoi(doi), { key, server }]));
  log(`corpus map: ${byDoi.size} DOIs`);

  // 2. W-id → corpus key, built from the walk itself (this is why the walk is the
  //    right primary path: it *is* the identifier bridge).
  const wToKey = new Map();
  for (const src of [RAW, GAP]) {
    for await (const r of readJsonl(src)) {
      if (!r.w || !r.doi) continue;
      const c = byDoi.get(r.doi);
      if (c) wToKey.set(r.w, c.key);
    }
  }
  log(`openalex-work → corpus-key bridge: ${wToKey.size} entries`);

  // 3. emit
  const out = jsonlWriter(OUT);
  let papers = 0, edges = 0, inEdges = 0, withIn = 0;
  const seen = new Set();
  for (const src of [RAW, GAP]) {
    for await (const r of readJsonl(src)) {
      const c = byDoi.get(r.doi);
      if (!c || seen.has(c.key)) continue;
      seen.add(c.key);
      const refsIn = [];
      for (const w of r.refs) { const k = wToKey.get(w); if (k && k !== c.key) refsIn.push(k); }
      await out.write({
        key: c.key, server: c.server, doi: r.doi, openalex_id: r.w,
        refs: r.refs, refs_in: [...new Set(refsIn)],
        n_refs: r.refs.length, n_refs_in: new Set(refsIn).size,
        source: "openalex",
      });
      papers++; edges += r.refs.length; inEdges += refsIn.length; if (refsIn.length) withIn++;
    }
  }
  await out.drain(); await out.close();
  log(`citations.jsonl: ${papers} papers · ${edges} reference edges · ${inEdges} in-corpus edges · ${withIn} papers with ≥1 in-corpus edge · ${human(bytesOf(OUT))}`);
  writeFileSync("data/mine/raw/citations-stats.json", JSON.stringify({ papers, edges, inEdges, withIn, corpus: byDoi.size, at: new Date().toISOString() }, null, 2));
}

// ── main ─────────────────────────────────────────────────────────────────────
const t = Date.now();
if (has("--race")) await race();
else if (has("--walk")) await walk();
else if (has("--gapfill")) await gapfill();
else if (has("--resolve")) await resolve();
else console.log("usage: citations.mjs --race [--n 1000] | --walk | --gapfill | --resolve");
log(`done in ${((Date.now() - t) / 1000).toFixed(1)}s`);
