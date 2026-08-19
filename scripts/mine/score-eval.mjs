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
import { mkdirSync, writeFileSync } from "node:fs";

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
  const toks = [...new Set(String(text).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2))];
  return toks.slice(0, 40).join(" | ");
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
if (has("--probe")) { await probe(); }
else if (arm === "fts") {
  const queries = await loadQueries();
  log(`${arm}: ${queries.length} queries from frozen cshl-eval-v1.retrieval.jsonl`);
  const t0 = Date.now();
  const ranks = await runFts(queries);
  report("fts", queries, ranks, { wall_clock_s: (Date.now() - t0) / 1000, subsample: N || null });
} else {
  console.log("usage: score-eval.mjs --probe | --arm fts [--n N]");
}
