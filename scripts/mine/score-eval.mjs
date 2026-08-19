// scripts/mine/score-eval.mjs — INDEPENDENT baseline scoring against frozen
// cshl-eval-v1 (LANE-MINE, commissioned by the lead).
//
//   node --env-file=.env.local scripts/mine/score-eval.mjs --arm fts [--n 2000]
//   node --env-file=.env.local scripts/mine/score-eval.mjs --arm bge|medcpt|specter2
//   node --env-file=.env.local scripts/mine/score-eval.mjs --arm rrf --combine fts,bge
//   node --env-file=.env.local scripts/mine/score-eval.mjs --probe          # cost measurement
//
// DELIBERATELY INDEPENDENT of scripts/eval/ (rig-port's harness). I built
// cshl-eval-v1, so I am the wrong person to own the scorer that grades our own
// encoder against it — if my dataset and my scorer share a wrong assumption I am
// the least likely to see it. Two implementations agreeing is the strongest
// evidence available; two disagreeing is the cheapest bug-finder we have. So:
// no shared code, no shared intermediate numbers, compare only finished tables.
//
// METHOD, stated explicitly so a disagreement with rig-port is diagnosable
// rather than merely a discrepancy:
//   · Queries come from the frozen file, verbatim. Gold is `positive.slug`.
//   · Retrieval is over the WHOLE 433,449-paper corpus, not the 9 candidates in
//     each row. Scoring against a row's own negatives would measure reranking,
//     not retrieval, and would flatter every arm.
//   · R@k = share of queries whose gold key appears in the top k. Single gold
//     per query, so R@k here is also hit-rate@k; MRR reported alongside.
//   · FTS: the query is lowercased, split to alphanumeric tokens >2 chars, and
//     OR-ed into a tsquery. OR, not AND: a MeSH query is 5 descriptors and
//     ANDing them returns nothing. ts_rank_cd then rewards documents matching
//     more of them, which is the behaviour a search box actually has.

import { psqlRows, readJsonl, log, has, numArg, strArg, h32 } from "./lib.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

// Corpus document frequency, already computed for the EXTRACT family. Used here
// to prune the tsquery: OR-ing every token of a MeSH query drags in terms like
// "humans" or "patients" that match a large fraction of 433,449 documents, and
// ts_rank_cd then has to score that whole bitmap. Measured cost of the naive
// form: 6.3 s/query — 17 hours for the frozen set. Pruning by df is not a
// shortcut, it is what a real retrieval system does: a term present in a third
// of the corpus carries almost no ranking signal and costs the most to score.
const DF = (() => {
  try {
    const j = JSON.parse(readFileSync("data/mine/raw/extract-df.json", "utf8"));
    return { N: j.docs, df: new Map(Object.entries(j.df)) };
  } catch { return null; }
})();
const DF_MAX = numArg("--df-max", 0.02);      // drop tokens in >2% of documents
const MAX_TOKENS = numArg("--max-tokens", 12);

const EVALF = "data/mine/eval/cshl-eval-v1.retrieval.jsonl";
const OUT = "data/mine/results";
mkdirSync(OUT, { recursive: true });

const K = [1, 5, 10];
const KMAX = Math.max(...K);
const N = numArg("--n", 0);            // 0 = all 10,000
const BATCH = numArg("--batch", 100);

const sq = (s) => String(s).replace(/'/g, "''");

// tsquery from free text: OR of the content tokens (see METHOD above).
function tsq(text) {
  let toks = [...new Set(String(text).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2))];
  if (DF) {
    const cap = DF.N * DF_MAX;
    const scored = toks.map((w) => [w, DF.df.get(w) ?? 1]).sort((a, b) => a[1] - b[1]);
    const kept = scored.filter(([, d]) => d <= cap);
    // If pruning empties the query, keep the most selective tokens anyway —
    // a query of only common words still has to return something.
    toks = (kept.length ? kept : scored).slice(0, MAX_TOKENS).map(([w]) => w);
  } else toks = toks.slice(0, MAX_TOKENS);
  return toks.join(" | ");
}

async function loadQueries() {
  const rows = [];
  for await (const r of readJsonl(EVALF)) {
    if (!r.query || !r.positive?.slug) continue;
    rows.push({ q: r.query, gold: r.positive.slug, family: r.meta?.family ?? "?" });
  }
  if (!N) return rows;
  // Deterministic subsample, stratified by nothing but the hash — same rows for
  // every arm and every rerun, so arms stay comparable and the choice is not mine.
  return rows.map((r) => [h32(`scoresample:${r.gold}:${r.q}`), r])
    .sort((a, b) => a[0] - b[0]).slice(0, N).map(([, r]) => r);
}

// ── freeze the scoring subsample as its own artifact ─────────────────────────
// The moment two arms score different query sets the cross-arm comparison is
// meaningless — and a benchmark table whose arms are not comparable is worse
// than no table, because it still looks authoritative. So the subsample is
// frozen with its selection rule and a checksum, exactly like the benchmark, and
// every arm (including rig-port's number for our own encoder) scores this file.
async function freezeSubsample() {
  const n = numArg("--n", 2000);
  const all = [];
  for await (const r of readJsonl(EVALF)) if (r.query && r.positive?.slug) all.push(r);
  const picked = all.map((r) => [h32(`scoresample:${r.positive.slug}:${r.query}`), r])
    .sort((a, b) => a[0] - b[0]).slice(0, n).map(([, r]) => r);
  const path = `data/mine/eval/cshl-eval-v1.subsample-${n}.jsonl`;
  writeFileSync(path, picked.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
  const fam = {};
  for (const r of picked) fam[r.meta?.family ?? "?"] = (fam[r.meta?.family ?? "?"] || 0) + 1;
  const manifest = {
    name: `cshl-eval-v1.subsample-${n}`,
    parent: "cshl-eval-v1.retrieval.jsonl",
    parent_rows: all.length,
    rows: picked.length,
    sha256: sha,
    selection_rule: "lowest N by md5('scoresample:' + positive.slug + ':' + query)[0:8] / 0xffffffff — deterministic, reproducible without this lane",
    families: fam,
    why: "Full-10k FTS scoring measured at 104 min/arm; the subsample makes the five-arm table achievable tonight. EVERY arm must score THIS file — cross-arm comparison is void otherwise. Absolute numbers will differ on the full 10,000; that is a stated follow-up, not a hidden caveat.",
    at: new Date().toISOString(),
  };
  writeFileSync(`data/mine/eval/subsample-manifest.json`, JSON.stringify(manifest, null, 2));
  log(`froze ${path}`);
  log(`  rows ${picked.length} · families ${JSON.stringify(fam)} · sha256 ${sha}`);
  return manifest;
}

// ── FTS arm ──────────────────────────────────────────────────────────────────
async function runFts(queries) {
  const ranks = [];
  for (let i = 0; i < queries.length; i += BATCH) {
    const b = queries.slice(i, i + BATCH);
    const values = b.map((r, j) => `(${j}, '${sq(tsq(r.q))}', '${sq(r.gold)}')`).join(",");
    const sql = `
WITH q(i, tq, gold) AS (VALUES ${values})
SELECT q.i, q.gold, coalesce(r.pos, 0)
FROM q LEFT JOIN LATERAL (
  SELECT rn AS pos FROM (
    SELECT p.key_number, row_number() OVER (ORDER BY ts_rank_cd(p.fts, tsq) DESC) AS rn
    FROM preprints p, to_tsquery('english', q.tq) tsq
    WHERE p.fts @@ tsq
    ORDER BY ts_rank_cd(p.fts, tsq) DESC
    LIMIT ${KMAX}
  ) t WHERE t.key_number = q.gold
) r ON true
ORDER BY q.i;`;
    const out = await psqlRows(sql);
    for (const [j, , pos] of out) ranks[i + Number(j)] = Number(pos) || 0;
    if ((i / BATCH) % 5 === 0) log(`  fts ${i + b.length}/${queries.length}`);
  }
  return ranks;
}

// ── dense arms ───────────────────────────────────────────────────────────────
// One implementation, parameterised by (table, operator), so MedCPT and SPECTER2
// slot in the moment their query-side vectors exist. The operator is NOT
// cosmetic: MedCPT ranks by dot product over raw [CLS] vectors, not cosine, and
// using the wrong one silently reorders every result list.
const ARMS = {
  bge:      { table: "preprint_embeddings",           op: "<=>", dim: 1024, note: "cosine distance" },
  medcpt:   { table: "preprint_embeddings_medcpt",    op: "<#>", dim: 768,  note: "negative inner product — MedCPT ranks by dot product on raw [CLS], not cosine" },
  specter2: { table: "preprint_embeddings_specter2",  op: "<=>", dim: 768,  note: "cosine distance" },
  cshl:     { table: "preprint_embeddings_cshl",      op: "<=>", dim: 1024, note: "our fine-tune — rig-port's number, not mine to publish" },
};

const EF_SEARCH = numArg("--ef-search", 100);   // HNSW recall knob; default 40 is too tight for R@10

async function encodeCloudflare(texts) {
  const acct = process.env.CF_ACCOUNT_ID, tok = process.env.CF_AI_TOKEN;
  if (!acct || !tok) throw new Error("CF_ACCOUNT_ID / CF_AI_TOKEN not set");
  const url = `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/@cf/baai/bge-m3`;
  const out = [];
  for (let i = 0; i < texts.length; i += 50) {
    const chunk = texts.slice(i, i + 50);
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: chunk }),
    });
    const j = await res.json();
    if (!j.success) throw new Error("cloudflare: " + JSON.stringify(j.errors).slice(0, 200));
    out.push(...(j.result?.data ?? []));
    if (i % 500 === 0) log(`  encoded ${i + chunk.length}/${texts.length}`);
  }
  return out;
}

async function runDense(armName, queries, vectors) {
  const a = ARMS[armName];
  const ranks = [];
  const B = numArg("--dense-batch", 25);
  for (let i = 0; i < queries.length; i += B) {
    const b = queries.slice(i, i + B);
    const vs = vectors.slice(i, i + B);
    const values = b.map((r, j) => `(${j}, '[${vs[j].join(",")}]'::vector(${a.dim}), '${sq(r.gold)}')`).join(",");
    const sql = `SET hnsw.ef_search = ${EF_SEARCH};
WITH q(i, v, gold) AS (VALUES ${values})
SELECT q.i, q.gold, coalesce(r.pos, 0)
FROM q LEFT JOIN LATERAL (
  SELECT rn AS pos FROM (
    SELECT e.key_number, row_number() OVER (ORDER BY e.embedding ${a.op} q.v) AS rn
    FROM ${a.table} e ORDER BY e.embedding ${a.op} q.v LIMIT ${KMAX}
  ) t WHERE t.key_number = q.gold
) r ON true
ORDER BY q.i;`;
    const out = await psqlRows(sql);
    for (const [j, , pos] of out) ranks[i + Number(j)] = Number(pos) || 0;
    if ((i / B) % 10 === 0) log(`  ${armName} ${i + b.length}/${queries.length}`);
  }
  return ranks;
}

// ── report ───────────────────────────────────────────────────────────────────
function report(arm, queries, ranks, extra = {}) {
  const fams = [...new Set(queries.map((r) => r.family))].sort();
  const calc = (idx) => {
    const rs = idx.map((i) => ranks[i] ?? 0);
    const at = (k) => rs.filter((r) => r > 0 && r <= k).length / rs.length;
    const mrr = rs.reduce((a, r) => a + (r > 0 ? 1 / r : 0), 0) / rs.length;
    return { n: rs.length, ...Object.fromEntries(K.map((k) => [`R@${k}`, at(k)])), MRR: mrr };
  };
  const all = calc(queries.map((_, i) => i));
  const byFam = Object.fromEntries(fams.map((f) => [f, calc(queries.map((r, i) => [r, i]).filter(([r]) => r.family === f).map(([, i]) => i))]));
  const fmt = (m) => `n=${String(m.n).padStart(5)}  ` + K.map((k) => `R@${k}=${(m[`R@${k}`] * 100).toFixed(2)}%`).join("  ") + `  MRR=${m.MRR.toFixed(4)}`;
  log("");
  log(`══ ${arm} ══  (retrieval over the full 433,449-paper corpus)`);
  log(`  ALL       ${fmt(all)}`);
  for (const f of fams) log(`  ${f.padEnd(9)} ${fmt(byFam[f])}`);
  const res = { arm, at: new Date().toISOString(), corpus: 433449, method: "OR-tsquery + ts_rank_cd, full-corpus retrieval, gold = positive.slug", all, byFamily: byFam, ...extra };
  writeFileSync(`${OUT}/${arm}.json`, JSON.stringify(res, null, 2));
  writeFileSync(`${OUT}/${arm}.ranks.json`, JSON.stringify(ranks));
  log(`  → ${OUT}/${arm}.json`);
  return res;
}

// ── probe: what does one FTS query actually cost? ────────────────────────────
async function probe() {
  const queries = (await loadQueries()).slice(0, 20);
  log(`probing FTS cost on 20 queries (of ${(await loadQueries()).length} in the frozen file)`);
  const t0 = Date.now();
  await runFts(queries);
  const secs = (Date.now() - t0) / 1000;
  log(`20 queries in ${secs.toFixed(1)}s → ${(secs / 20 * 1000).toFixed(0)} ms/query`);
  log(`projected: 2,000 queries ≈ ${(secs / 20 * 2000 / 60).toFixed(1)} min · 10,000 ≈ ${(secs / 20 * 10000 / 60).toFixed(1)} min`);
}

// ── main ─────────────────────────────────────────────────────────────────────
const arm = strArg("--arm", "");
if (has("--freeze-subsample")) { await freezeSubsample(); }
else if (has("--probe")) { await probe(); }
else if (arm === "fts") {
  const queries = await loadQueries();
  log(`${arm}: ${queries.length} queries from frozen cshl-eval-v1.retrieval.jsonl`);
  const t0 = Date.now();
  const ranks = await runFts(queries);
  report("fts", queries, ranks, { wall_clock_s: (Date.now() - t0) / 1000, subsample: N || null });
} else if (ARMS[arm]) {
  const queries = await loadQueries();
  log(`${arm}: ${queries.length} queries · table ${ARMS[arm].table} · operator ${ARMS[arm].op} (${ARMS[arm].note}) · hnsw.ef_search=${EF_SEARCH}`);
  const t0 = Date.now();
  let vectors;
  if (arm === "bge") {
    log("  encoding queries via Cloudflare @cf/baai/bge-m3 (the path the app already uses in production)");
    vectors = await encodeCloudflare(queries.map((r) => r.q));
  } else {
    const vf = strArg("--query-vectors", "");
    if (!vf) { console.log(`${arm} needs --query-vectors <file.jsonl> ({q, vector}) — no local torch, so the query encoder must come from the rig lane`); process.exit(1); }
    const byQ = new Map();
    for await (const r of readJsonl(vf)) byQ.set(r.q ?? r.query, r.vector ?? r.embedding);
    vectors = queries.map((r) => byQ.get(r.q));
    const missing = vectors.filter((v) => !v).length;
    if (missing) { console.log(`${missing} of ${queries.length} queries have no vector in ${vf} — refusing to score a partial set`); process.exit(1); }
  }
  if (vectors.length !== queries.length) { console.log(`encoder returned ${vectors.length} vectors for ${queries.length} queries — refusing`); process.exit(1); }
  const ranks = await runDense(arm, queries, vectors);
  report(arm, queries, ranks, { wall_clock_s: (Date.now() - t0) / 1000, subsample: N || null, table: ARMS[arm].table, operator: ARMS[arm].op, ef_search: EF_SEARCH });
} else {
  console.log("usage: score-eval.mjs --probe | --arm fts|bge|medcpt|specter2 [--n N] [--query-vectors f.jsonl]");
}
