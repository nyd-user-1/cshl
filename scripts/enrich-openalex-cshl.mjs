// scripts/enrich-openalex-cshl.mjs — LANE-KEYWORDS.
//
// Harvest OpenAlex concepts / keywords / topics for every paper in `preprints`
// (433,449 rows) and land them in ONE new table, `preprint_openalex`.
//
//   node --env-file=.env.local scripts/enrich-openalex-cshl.mjs --budget
//   node --env-file=.env.local scripts/enrich-openalex-cshl.mjs --probe
//   node --env-file=.env.local scripts/enrich-openalex-cshl.mjs --ddl
//   node --env-file=.env.local scripts/enrich-openalex-cshl.mjs --fetch [--limit N]
//   node --env-file=.env.local scripts/enrich-openalex-cshl.mjs --write
//   node --env-file=.env.local scripts/enrich-openalex-cshl.mjs --sweep   (free, then --write again)
//   node --env-file=.env.local scripts/enrich-openalex-cshl.mjs --verify
//
// Adapted from scripts/enrich-openalex-batch.mjs, which ran this recipe at 300k
// scale against `nsr`. What changed and why:
//
//   · INSERT-ONLY INTO A TABLE THIS LANE OWNS. The NSR script UPDATEs columns on
//     the main row; here a concurrent training pipeline is live, so this lane
//     touches nothing it does not own. `preprints`, every preprint_embeddings*,
//     and every benchmark artefact are read-only to this file. The only DDL is
//     CREATE TABLE IF NOT EXISTS preprint_openalex.
//   · DB FENCE, copied from scripts/mine/lib.mjs: the endpoint host must be
//     ep-orange-water-aut2eymf or no connection opens at all.
//   · The payload is the keyword surface, not the OA/PDF surface: keywords,
//     topics (with subfield/field/domain), concepts (with level), mesh, sdgs.
//
// ── SPEND ────────────────────────────────────────────────────────────────────
// OpenAlex credits (per request): singleton-by-DOI 0 · list+filter 1 · search 10.
// 10,000 credits/day free with a key, resets midnight UTC, and the key is SHARED
// with other projects — so the pool is READ before a run, never assumed.
// 433,449 DOIs at 100/request = ~4,335 credits. No S3, no model compute, $0.
//
// ⚠ A 429's rate-limit headers LIE (measured in NSR): a pace-429 reports
// `x-ratelimit-remaining: 0` byte-identically to a genuinely exhausted pool.
// Exhaustion is therefore judged ONLY from the last SUCCESSFUL (2xx) reading.
//
// Crash safety: every fetched page lands in data/openalex-cshl/page-NNNN.json
// before the next request goes out, and --fetch skips any page already on disk.

import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";

// ── args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const numArg = (flag, dflt) => {
  const i = args.indexOf(flag);
  if (i < 0) return dflt;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : dflt;
};

const BATCH = Math.min(numArg("--batch", 100), 100);  // DOIs per pipe-joined filter
const RPS = Math.min(numArg("--rps", 8), 20);         // pace ceiling, aggregate
const CONC = Math.max(1, Math.min(numArg("--concurrency", 4), 8));
const LIMIT = numArg("--limit", 0);
const MAX_CREDITS = numArg("--max-credits", 7000);
const FLOOR = numArg("--floor", 300);                 // stop with this much left
const WRITE_CHUNK = Math.min(numArg("--write-chunk", 25000), 25000);

const API = "https://api.openalex.org";
const KEY = process.env.OPENALEX_API_KEY || "";
const MAILTO = process.env.OPENALEX_MAILTO || "brendan@nysgpt.com";
const PAGES = "data/openalex-cshl";
const UA = "cshl-rxivgpt-mine/0.1 (+https://cshl.nysgpt.com; brendan@nysgpt.com)";

// `select` takes TOP-LEVEL field names only (a dotted path is a 400).
const SELECT = [
  "id", "doi", "type", "keywords", "topics", "primary_topic", "concepts",
  "mesh", "sustainable_development_goals", "cited_by_count",
].join(",");

// ── psql plumbing (fenced) ───────────────────────────────────────────────────
const EXPECT_HOST = "ep-orange-water-aut2eymf";
const raw = process.env.DATABASE_URL_UNPOOLED ?? "";
if (!raw) throw new Error("DATABASE_URL_UNPOOLED not set (run with --env-file=.env.local)");
const url = new URL(raw);
if (!url.hostname.startsWith(EXPECT_HOST + ".")) {
  throw new Error(`FENCE FAIL: endpoint is '${url.hostname}', expected '${EXPECT_HOST}.*' — refusing.`);
}
const PG_ENV = {
  ...process.env,
  PGHOST: url.hostname, PGPORT: url.port || "5432",
  PGDATABASE: url.pathname.slice(1),
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGSSLMODE: "require",
};

function psql(stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1"], { env: PG_ENV });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error(`psql exit ${c}: ${err.slice(0, 1500)}`))));
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

function csvField(v) {
  if (v === null || v === undefined) return "";
  let s = String(v).replace(/\u0000/g, "").replace(/[\r\n]+/g, " ");
  if (s === "") return '""';
  if (/[",]/.test(s)) s = `"${s.replaceAll('"', '""')}"`;
  return s;
}
const csvRow = (f) => f.map(csvField).join(",");

// ── helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const n = (v) => Number(v ?? 0).toLocaleString("en-US");
const pct = (a, b) => `${((100 * a) / Math.max(b, 1)).toFixed(2)}%`;
const shortId = (u) => (u ? String(u).replace(/^https?:\/\/openalex\.org\//, "") : null);

function normDoi(rawDoi) {
  if (!rawDoi) return null;
  let d = String(rawDoi).trim().toLowerCase();
  d = d.replace(/^https?:\/\/(dx\.)?doi\.org\//, "").replace(/^doi:/, "");
  const m = d.match(/10\.\d{4,9}\/[^\s;]+/);
  if (!m) return null;
  d = m[0].replace(/[.,;]+$/, "");
  return d.length > 5 ? d : null;
}
const filterSafe = (d) => d && !d.includes(",") && !d.includes("|");

// ── the API layer ────────────────────────────────────────────────────────────
const usage = {
  calls: 0, credits: 0, limit: null, remaining: null, resetSeconds: null,
  free: 0, errors: 0, retries: 0, throttles: 0, notFound: 0,
  paceGap: 1000 / RPS, minGap: 1000 / RPS, okStreak: 0,
};
let aborted = null;

/** `remaining` is trusted ONLY off a 2xx — see the header note. */
function readUsage(res) {
  const g = (h) => { const v = res.headers.get(h); return v == null ? null : Number(v); };
  const used = g("x-ratelimit-credits-used");
  const rem = g("x-ratelimit-remaining");
  const lim = g("x-ratelimit-limit");
  const reset = g("x-ratelimit-reset");
  if (used != null && Number.isFinite(used)) { usage.credits += used; if (used === 0) usage.free++; }
  if (res.ok && rem != null && Number.isFinite(rem)) usage.remaining = rem;
  if (lim != null && Number.isFinite(lim)) usage.limit = lim;
  if (reset != null && Number.isFinite(reset)) usage.resetSeconds = reset;
  return { used, rem, lim, reset };
}

/** One request. The api_key never reaches a log line — `redact` is what prints. */
async function oa(path, { redact = path } = {}) {
  if (aborted) return null;
  if (usage.credits >= MAX_CREDITS) {
    aborted = `local ceiling: --max-credits ${MAX_CREDITS} reached`;
    return null;
  }
  const sep = path.includes("?") ? "&" : "?";
  const auth = [KEY ? `api_key=${encodeURIComponent(KEY)}` : "", MAILTO ? `mailto=${encodeURIComponent(MAILTO)}` : ""]
    .filter(Boolean).join("&");
  const full = `${API}${path}${auth ? sep + auth : ""}`;

  let delay = 1500;
  for (let attempt = 0; attempt < 6; attempt++) {
    let res;
    try {
      res = await fetch(full, { headers: { "User-Agent": UA } });
    } catch {
      usage.retries++;
      await sleep(delay); delay = Math.min(delay * 2, 20000);
      continue;
    }
    usage.calls++;
    const u = readUsage(res);

    if (res.ok) {
      if (u.rem != null && u.rem <= FLOOR) aborted = `budget floor: ${n(u.rem)} credits left (--floor ${FLOOR})`;
      if (++usage.okStreak >= 250) { usage.okStreak = 0; usage.paceGap = Math.max(usage.minGap, usage.paceGap * 0.9); }
      return { data: await res.json(), used: u.used };
    }
    if (res.status === 404) { usage.notFound++; return { data: null, used: u.used }; }
    if (res.status === 429) {
      if (usage.remaining != null && usage.remaining <= FLOOR) {
        aborted = `daily allowance exhausted — last good reading ${n(usage.remaining)} credits, resets in ${u.reset ?? "?"}s. Stopped, not billed.`;
        return null;
      }
      usage.throttles++;
      usage.okStreak = 0;
      usage.paceGap = Math.min(usage.paceGap * 1.25, 1000);
      if (usage.throttles === 1 || usage.throttles % 25 === 0) {
        console.log(`  ~ throttled (429) — easing to ~${(1000 / usage.paceGap).toFixed(1)} req/s`);
      }
      usage.retries++;
      await sleep(delay); delay = Math.min(delay * 2, 30000);
      continue;
    }
    if (res.status >= 500) { usage.retries++; await sleep(delay); delay = Math.min(delay * 2, 30000); continue; }
    usage.errors++;
    if (usage.errors <= 5) {
      let body = "";
      try { body = (await res.text()).slice(0, 300); } catch { /* body already consumed */ }
      console.log(`  ! HTTP ${res.status} on ${redact}${body ? ` — ${body}` : ""}`);
    }
    return null;
  }
  usage.errors++;
  return null;
}

// A shared pace cursor so CONC workers still sum to RPS overall.
let paceCursor = 0;
async function pace() {
  const gap = usage.paceGap;
  const now = Date.now();
  const slot = Math.max(now, paceCursor);
  paceCursor = slot + gap;
  if (slot > now) await sleep(slot - now);
}

/** FREE by-DOI singleton — the `doi:` prefix must stay literal to bill 0. */
async function fetchOneByDoi(doi) {
  const r = await oa(`/works/doi:${encodeURIComponent(doi)}?select=${SELECT}`, { redact: `/works/doi:${doi}` });
  return r?.data ?? null;
}

/**
 * One filter call resolves up to BATCH works for 1 credit. per-page is set ABOVE
 * the batch size deliberately: a DOI filter can return MORE works than values
 * given (OpenAlex holds merged/duplicate works sharing a DOI), and at
 * per-page == batch the overflow falls off page 1.
 */
async function fetchByDois(dois) {
  const q = `/works?filter=doi:${dois.map(encodeURIComponent).join("|")}&per-page=200&select=${SELECT}`;
  const r = await oa(q, { redact: `/works?filter=doi:[${dois.length} dois]` });
  const page1 = r?.data;
  if (!page1?.results) return null;
  const results = [...page1.results];
  const count = page1.meta?.count ?? results.length;
  if (count > results.length) {
    const r2 = await oa(`${q}&page=2`, { redact: `/works?filter=doi:[${dois.length} dois]&page=2` });
    results.push(...(r2?.data?.results ?? []));
  }
  return results;
}

// ── distilling one work ──────────────────────────────────────────────────────
const slimKeywords = (w) => {
  const out = (w.keywords ?? []).map((k) => ({
    id: shortId(k.id)?.replace(/^keywords\//, "") ?? null,
    name: k.display_name ?? null,
    score: k.score ?? null,
  })).filter((k) => k.name);
  return out.length ? out : null;
};

const slimTopics = (w) => {
  const out = (w.topics ?? []).map((t) => ({
    id: shortId(t.id),
    name: t.display_name ?? null,
    score: t.score ?? null,
    subfield: t.subfield?.display_name ?? null,
    field: t.field?.display_name ?? null,
    domain: t.domain?.display_name ?? null,
  })).filter((t) => t.name);
  return out.length ? out : null;
};

const slimConcepts = (w) => {
  const out = (w.concepts ?? []).map((c) => ({
    id: shortId(c.id),
    name: c.display_name ?? null,
    level: c.level ?? null,
    score: c.score ?? null,
  })).filter((c) => c.name);
  return out.length ? out : null;
};

const slimMesh = (w) => {
  const out = (w.mesh ?? []).map((m) => ({
    ui: m.descriptor_ui ?? null,
    descriptor: m.descriptor_name ?? null,
    qualifier: m.qualifier_name ?? null,
    major: m.is_major_topic ?? false,
  })).filter((m) => m.descriptor);
  return out.length ? out : null;
};

const slimSdg = (w) => {
  const out = (w.sustainable_development_goals ?? [])
    .map((s) => ({ name: s.display_name ?? null, score: s.score ?? null }))
    .filter((s) => s.name);
  return out.length ? out : null;
};

const distill = (w) => ({
  openalex_id: shortId(w.id),
  work_type: w.type ?? null,
  oa_keywords: slimKeywords(w),
  oa_topics: slimTopics(w),
  oa_primary_topic: w.primary_topic?.display_name ?? null,
  oa_concepts: slimConcepts(w),
  oa_mesh: slimMesh(w),
  oa_sdg: slimSdg(w),
  cited_by: w.cited_by_count ?? null,
});

// ── P0: DDL — the one table this lane owns ───────────────────────────────────
const DDL = `CREATE TABLE IF NOT EXISTS preprint_openalex (
  key_number       text PRIMARY KEY,
  doi              text NOT NULL,
  openalex_id      text,
  work_type        text,
  oa_keywords      jsonb,
  oa_topics        jsonb,
  oa_primary_topic text,
  oa_concepts      jsonb,
  oa_mesh          jsonb,
  oa_sdg           jsonb,
  cited_by         integer,
  fetched_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS preprint_openalex_oaid_idx ON preprint_openalex (openalex_id);`;

async function phaseDdl() {
  await psql(DDL);
  console.log("P0  preprint_openalex ready (created if absent). No other table touched.");
  console.log((await psql(`\\d preprint_openalex`)).trim());
}

// ── P1: export ───────────────────────────────────────────────────────────────
async function exportRows() {
  const t0 = Date.now();
  const out = await psql(`\\copy (SELECT key_number, doi FROM preprints WHERE doi IS NOT NULL ORDER BY key_number) TO STDOUT WITH (FORMAT text)`);
  const rows = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const t = line.indexOf("\t");
    if (t < 0) continue;
    rows.push({ key_number: line.slice(0, t), doi: line.slice(t + 1) });
  }
  console.log(`P1  exported ${n(rows.length)} DOI-bearing preprints in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return rows;
}

/** key_number rows → { batches: [[doi,...]], byDoi: Map<doi, key_number[]>, unusable } */
function planBatches(rows) {
  const byDoi = new Map();
  let unusable = 0, unsafe = 0;
  for (const r of rows) {
    const d = normDoi(r.doi);
    if (!d) { unusable++; continue; }
    if (!byDoi.has(d)) byDoi.set(d, []);
    byDoi.get(d).push(r.key_number);
  }
  // A comma or pipe inside a filter value would silently split the batch, so
  // those DOIs skip the filter lane and fall to the free singleton sweep.
  const dois = [...byDoi.keys()].filter((d) => { if (filterSafe(d)) return true; unsafe++; return false; });
  const batches = [];
  for (let i = 0; i < dois.length; i += BATCH) batches.push(dois.slice(i, i + BATCH));
  return { batches, byDoi, unusable, unsafe, uniqueDois: dois.length };
}

// ── P2: batch fetch ──────────────────────────────────────────────────────────
const pagePath = (i) => `${PAGES}/page-${String(i).padStart(5, "0")}.json`;

async function phaseFetch() {
  mkdirSync(PAGES, { recursive: true });
  const rows = await exportRows();
  const plan = planBatches(rows);
  let batches = plan.batches;
  if (LIMIT) batches = batches.slice(0, LIMIT);

  const todo = batches.map((b, i) => i).filter((i) => !existsSync(pagePath(i)));
  console.log(`P2  ${n(plan.uniqueDois)} unique DOIs → ${n(batches.length)} filter requests (${BATCH}/request)`);
  console.log(`    ${n(batches.length - todo.length)} pages already on disk, ${n(todo.length)} to fetch`);
  console.log(`    projected spend ~${n(todo.length)} credits · pace ≤${RPS} req/s × ${CONC} workers`);
  if (plan.unusable || plan.unsafe) console.log(`    ${n(plan.unusable)} DOIs unparseable, ${n(plan.unsafe)} filter-unsafe (free singleton lane)`);
  if (!todo.length) { console.log("    nothing to fetch"); return; }

  const t0 = Date.now();
  let done = 0, works = 0;
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      if (aborted) return;
      const k = cursor++;
      if (k >= todo.length) return;
      const i = todo[k];
      await pace();
      const results = await fetchByDois(batches[i]);
      if (results == null) continue;               // error/abort: page stays absent, re-runnable
      writeFileSync(pagePath(i), JSON.stringify({ batch: i, dois: batches[i], results }));
      works += results.length;
      if (++done % 100 === 0 || done === todo.length) {
        const el = (Date.now() - t0) / 1000;
        const rate = done / Math.max(el, 0.001);
        console.log(`    ${n(done)}/${n(todo.length)} pages · ${n(works)} works · ${rate.toFixed(1)} req/s · ${n(usage.credits)} credits · eta ${((todo.length - done) / Math.max(rate, 0.01) / 60).toFixed(1)}m`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONC, todo.length) }, worker));

  console.log(`P2  ${n(done)} pages fetched in ${((Date.now() - t0) / 60000).toFixed(1)}m · ${n(works)} works`);
  reportUsage();
  if (aborted) console.log(`  ! aborted: ${aborted}`);
}

/**
 * Free singleton sweep over DOIs the filter lane never resolved. 0 credits.
 * OpenAlex's DOI *filter* index lags its entity store, so a work can be
 * retrievable at /works/doi:X while absent from ?filter=doi:X.
 */
async function phaseSweep() {
  const p = `${PAGES}/unmatched-dois.json`;
  if (!existsSync(p)) { console.log("no unmatched-dois.json — run --write first"); return; }
  const missing = JSON.parse(readFileSync(p, "utf8"));
  const found = await sweepMisses(missing);
  writeFileSync(`${PAGES}/sweep.json`, JSON.stringify({ results: [...found.values()] }));
  reportUsage();
}

async function sweepMisses(missing) {
  if (!missing.length) return new Map();
  console.log(`    free singleton sweep over ${n(missing.length)} unmatched DOIs (0 credits)`);
  const found = new Map();
  let cursor = 0, done = 0;
  const t0 = Date.now();
  const worker = async () => {
    for (;;) {
      if (aborted) return;
      const i = cursor++;
      if (i >= missing.length) return;
      await pace();
      const w = await fetchOneByDoi(missing[i]);
      if (w) found.set(missing[i], w);
      if (++done % 500 === 0) console.log(`      ${n(done)}/${n(missing.length)} · ${n(found.size)} recovered · ${(done / ((Date.now() - t0) / 1000)).toFixed(1)} req/s`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONC, missing.length) }, worker));
  console.log(`    sweep recovered ${n(found.size)}/${n(missing.length)}`);
  return found;
}

// ── P3: write back — INSERT ONLY, into preprint_openalex ─────────────────────
// STREAMING, not gathered. The first cut of this held every fetched work in one
// Map the way the NSR script does, and V8 died on it: 2.3 GB of page JSON inflates
// past the default heap once it is parsed into objects. NSR got away with it on a
// payload a fraction of this size. Here each page is parsed, distilled, appended
// to the pending CSV chunk and released, so resident memory tracks WRITE_CHUNK
// rather than the corpus.
async function phaseWrite() {
  await psql(DDL);
  const rows = await exportRows();
  const plan = planBatches(rows);

  const t0 = Date.now();
  const files = readdirSync(PAGES).filter((f) => /^page-\d+\.json$/.test(f) || f === "sweep.json").sort();
  const seen = new Set();            // DOIs already staged — pages can overlap
  let pending = [];
  let written = 0, chunkNo = 0, works = 0;

  const flush = async () => {
    if (!pending.length) return;
    chunkNo++;
    const csv = pending.join("\n");
    const count = pending.length;
    pending = [];
    await writeChunk(csv, chunkNo, count);
    written += count;
  };

  for (const f of files) {
    let page;
    try { page = JSON.parse(readFileSync(`${PAGES}/${f}`, "utf8")); } catch { console.log(`  ! unreadable ${f}, skipping`); continue; }
    for (const w of page.results ?? []) {
      const d = normDoi(w.doi);
      if (!d || seen.has(d)) continue;
      const keys = plan.byDoi.get(d);
      if (!keys) continue;           // OpenAlex returned a work we never asked for
      seen.add(d);
      works++;
      const p = distill(w);
      for (const k of keys) {
        pending.push(csvRow([
          k, d, p.openalex_id, p.work_type,
          p.oa_keywords ? JSON.stringify(p.oa_keywords) : null,
          p.oa_topics ? JSON.stringify(p.oa_topics) : null,
          p.oa_primary_topic,
          p.oa_concepts ? JSON.stringify(p.oa_concepts) : null,
          p.oa_mesh ? JSON.stringify(p.oa_mesh) : null,
          p.oa_sdg ? JSON.stringify(p.oa_sdg) : null,
          p.cited_by,
        ]));
      }
      if (pending.length >= WRITE_CHUNK) await flush();
    }
  }
  await flush();

  const missing = [...plan.byDoi.keys()].filter((d) => !seen.has(d));
  console.log(`P3  ${n(files.length)} pages → ${n(works)} distinct works · ${n(written)} rows upserted in ${((Date.now() - t0) / 60000).toFixed(1)}m`);
  console.log(`    ${n(missing.length)} DOIs unmatched (${pct(plan.byDoi.size - missing.length, plan.byDoi.size)} of ${n(plan.byDoi.size)} DOIs resolved)`);
  writeFileSync(`${PAGES}/unmatched-dois.json`, JSON.stringify(missing));
}

async function writeChunk(csv, ci, count) {
  {
    const sql = `BEGIN;
CREATE TEMP TABLE stage_oakw (
  key_number text, doi text, openalex_id text, work_type text,
  oa_keywords jsonb, oa_topics jsonb, oa_primary_topic text, oa_concepts jsonb,
  oa_mesh jsonb, oa_sdg jsonb, cited_by int
) ON COMMIT DROP;
COPY stage_oakw FROM STDIN WITH (FORMAT csv);
${csv}
\\.
WITH ins AS (
  INSERT INTO preprint_openalex AS t
    (key_number, doi, openalex_id, work_type, oa_keywords, oa_topics,
     oa_primary_topic, oa_concepts, oa_mesh, oa_sdg, cited_by)
  SELECT s.key_number, s.doi, s.openalex_id, s.work_type, s.oa_keywords, s.oa_topics,
         s.oa_primary_topic, s.oa_concepts, s.oa_mesh, s.oa_sdg, s.cited_by
  FROM stage_oakw s
  ON CONFLICT (key_number) DO UPDATE SET
    doi = EXCLUDED.doi, openalex_id = EXCLUDED.openalex_id, work_type = EXCLUDED.work_type,
    oa_keywords = EXCLUDED.oa_keywords, oa_topics = EXCLUDED.oa_topics,
    oa_primary_topic = EXCLUDED.oa_primary_topic, oa_concepts = EXCLUDED.oa_concepts,
    oa_mesh = EXCLUDED.oa_mesh, oa_sdg = EXCLUDED.oa_sdg, cited_by = EXCLUDED.cited_by,
    fetched_at = now()
  RETURNING 1
) SELECT 'upserted: ' || count(*) FROM ins;
COMMIT;`;

    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        const out = await psql(sql);
        console.log(`    chunk ${ci} (${n(count)} rows) — ${out.trim()}`);
        ok = true;
      } catch (e) {
        console.log(`    chunk ${ci} attempt ${attempt} failed: ${e.message.slice(0, 300)}`);
        if (attempt === 3) throw e;
        await sleep(2000 * attempt);
      }
    }
  }
}

// ── P4: verify — the haul, measured ──────────────────────────────────────────
async function phaseVerify() {
  const out = await psql(`\\pset footer off
SELECT (SELECT count(*) FROM preprints) AS corpus,
       count(*) AS enriched,
       count(openalex_id) AS with_oa_id,
       count(oa_keywords) AS with_keywords,
       count(oa_topics) AS with_topics,
       count(oa_concepts) AS with_concepts,
       count(oa_mesh) AS with_oa_mesh
FROM preprint_openalex;
\\echo
SELECT round(avg(jsonb_array_length(oa_keywords)), 2) AS mean_kw_per_paper,
       min(jsonb_array_length(oa_keywords)) AS min_kw,
       max(jsonb_array_length(oa_keywords)) AS max_kw,
       round(avg(jsonb_array_length(oa_topics)), 2) AS mean_topics
FROM preprint_openalex WHERE oa_keywords IS NOT NULL;
\\echo
SELECT count(DISTINCT k->>'name') AS distinct_keywords FROM preprint_openalex, jsonb_array_elements(oa_keywords) k;
SELECT count(DISTINCT t->>'name') AS distinct_topics, count(DISTINCT t->>'subfield') AS distinct_subfields, count(DISTINCT t->>'field') AS distinct_fields FROM preprint_openalex, jsonb_array_elements(oa_topics) t;
\\echo
SELECT work_type, count(*) FROM preprint_openalex GROUP BY 1 ORDER BY 2 DESC LIMIT 8;
\\echo
SELECT p.server, count(*) AS corpus, count(o.key_number) AS enriched,
       round(100.0*count(o.key_number)/count(*), 2) AS pct
FROM preprints p LEFT JOIN preprint_openalex o USING (key_number) GROUP BY 1 ORDER BY 1;`);
  console.log(out.trim());
}

// ── probe / budget ───────────────────────────────────────────────────────────
async function phaseProbe() {
  const i = args.indexOf("--dois");
  let dois;
  if (i >= 0 && args[i + 1]) {
    dois = args[i + 1].split(",").map(normDoi).filter(Boolean);
  } else {
    const out = await psql(`\\copy (SELECT doi FROM preprints ORDER BY random() LIMIT 3) TO STDOUT WITH (FORMAT text)`);
    dois = out.split("\n").filter(Boolean).map(normDoi).filter(Boolean);
  }
  console.log(`probe DOIs: ${dois.join(", ")}`);
  const results = await fetchByDois(dois);
  if (!results) { console.log("probe FAILED — no results"); reportUsage(); return; }
  console.log(`probe returned ${results.length} works`);
  for (const w of results) {
    console.log(`\n  ${normDoi(w.doi)}`);
    console.log(`  distilled: ${JSON.stringify(distill(w), null, 2).slice(0, 1400)}`);
  }
  reportUsage();
}

async function phaseBudget() {
  // a free singleton: 0 credits, and its 2xx headers are the only honest reading
  const out = await psql(`\\copy (SELECT doi FROM preprints ORDER BY key_number LIMIT 1) TO STDOUT WITH (FORMAT text)`);
  await fetchOneByDoi(normDoi(out.trim()));
  reportUsage();
}

function reportUsage() {
  console.log(`  usage: ${n(usage.calls)} calls · ${n(usage.credits)} credits spent · ${n(usage.free)} free · remaining ${usage.remaining == null ? "?" : n(usage.remaining)}/${usage.limit == null ? "?" : n(usage.limit)}` +
    ` · ${n(usage.throttles)} throttles · ${n(usage.retries)} retries · ${n(usage.errors)} errors · ${n(usage.notFound)} 404s` +
    (usage.resetSeconds != null ? ` · resets in ${(usage.resetSeconds / 3600).toFixed(1)}h` : ""));
}

// ── main ─────────────────────────────────────────────────────────────────────
if (!KEY) console.log("! OPENALEX_API_KEY not set — running unauthenticated");
if (has("--budget")) await phaseBudget();
else if (has("--probe")) await phaseProbe();
else if (has("--ddl")) await phaseDdl();
else if (has("--fetch")) await phaseFetch();
else if (has("--write")) await phaseWrite();
else if (has("--sweep")) await phaseSweep();
else if (has("--verify")) await phaseVerify();
else console.log("pick a phase: --budget | --probe | --ddl | --fetch | --write | --sweep | --verify");
