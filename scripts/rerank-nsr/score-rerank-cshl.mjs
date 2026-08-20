#!/usr/bin/env node
// score-rerank-cshl.mjs — raw vs reranked over the SAME frozen top-50 list.
//
// LANE-RERANK G5: scripts/eval/score-rerank.mjs is NSR-shaped — it hardcodes
// data/eval/nsr-eval-v1 and the segments era/richness/reftype. CSHL's benchmark
// segments are server/era/published/abstract. Rather than edit that file (it is
// LANE-EVAL's and still correct for NSR), this is the CSHL twin. `era` and
// `lenBand` are IMPORTED from score.mjs so the segment definitions cannot drift
// from the encoder rows this will be compared against.
//
// Also writes paired-test.mjs-shaped perquery files for BOTH sides, so McNemar
// runs over the same {arm,keys,hits10} contract every other arm already uses.
//
// Usage: IN=reranked.json BASE=cshl_qp EVAL_VERSION=cshl-eval-2k \
//        node scripts/rerank-nsr/score-rerank-cshl.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { era, lenBand } from '../eval/score.mjs'

const VERSION = process.env.EVAL_VERSION ?? 'cshl-eval-2k'
const ROOT = join(process.cwd(), 'data/eval', VERSION)
const RESULTS = join(ROOT, 'results')
const IN = process.env.IN ?? 'data/reranker/eval/reranked.json'
const BASE = process.env.BASE ?? 'cshl_qp'
const ARM = process.env.ARM ?? `${BASE}+cshl_rr`
mkdirSync(RESULTS, { recursive: true })

const queries = readFileSync(join(ROOT, 'queries.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const qrels = new Map()
for (const line of readFileSync(join(ROOT, 'qrels.tsv'), 'utf8').split('\n').filter(Boolean)) {
  const [qid, key] = line.split('\t')
  if (!qrels.has(qid)) qrels.set(qid, new Set())
  qrels.get(qid).add(key)
}

// identical to score.mjs:metricsFor — same definitions, so these rows are
// directly comparable to the encoder-only rows in results/*.json
function metricsFor(ranked, positives) {
  let firstRank = Infinity
  for (let i = 0; i < ranked.length; i++) if (positives.has(ranked[i])) { firstRank = i + 1; break }
  const recallAt = (k) => (ranked.slice(0, k).some((id) => positives.has(id)) ? 1 : 0)
  const idealRel = Math.min(positives.size, 10)
  const idcg = Array.from({ length: idealRel }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0)
  const dcg = ranked.slice(0, 10).reduce((s, id, i) => s + (positives.has(id) ? 1 / Math.log2(i + 2) : 0), 0)
  return { r1: recallAt(1), r5: recallAt(5), r10: recallAt(10), r50: recallAt(50),
           mrr: Number.isFinite(firstRank) ? 1 / firstRank : 0, ndcg10: idcg > 0 ? dcg / idcg : 0 }
}
const segmentsFor = (q) => ['blended', `server:${q.server}`, `era:${era(q.pub_year)}`,
                            `published:${q.published ? 'yes' : 'no'}`, `abstract:${lenBand(q.abs_len)}`]
const M = ['r1', 'r5', 'r10', 'r50', 'mrr', 'ndcg10']

const rows = JSON.parse(readFileSync(IN, 'utf8'))
const byQid = new Map(rows.map((r) => [r.qid, r]))
console.log(`${rows.length} reranked rows vs ${queries.length} benchmark queries`)

// sanity: reranking must be a PERMUTATION of the raw list, nothing added or dropped
let permBad = 0
for (const r of rows) {
  const a = [...r.raw_top50].sort().join('|'), b = [...r.reranked_top50].sort().join('|')
  if (a !== b) permBad++
}
console.log(`permutation check: ${permBad} rows where reranked is NOT a permutation of raw (must be 0)`)
if (permBad) { console.error('REFUSING — the reranker changed the candidate set, not just its order.'); process.exit(1) }

const agg = { raw: {}, reranked: {} }
const perq = { raw: [], reranked: [] }
let scored = 0, missing = 0
for (const q of queries) {
  const r = byQid.get(q.qid); const rel = qrels.get(q.qid)
  if (!r || !rel) { missing++; perq.raw.push(0); perq.reranked.push(0); continue }
  scored++
  const mr = metricsFor(r.raw_top50, rel), mk = metricsFor(r.reranked_top50, rel)
  perq.raw.push(mr.r10); perq.reranked.push(mk.r10)
  for (const seg of segmentsFor(q)) {
    for (const [side, m] of [['raw', mr], ['reranked', mk]]) {
      const a = (agg[side][q.family] ??= {})
      const c = (a[seg] ??= Object.fromEntries([['n', 0], ...M.map((k) => [k, 0])]))
      c.n++; for (const k of M) c[k] += m[k]
    }
  }
}
for (const side of ['raw', 'reranked']) for (const f of Object.keys(agg[side])) for (const s of Object.keys(agg[side][f])) {
  const c = agg[side][f][s]; for (const k of M) c[k] = +(c[k] / c.n).toFixed(4)
}
console.log(`scored ${scored}, missing from rerank ${missing}`)

// paired-test.mjs contract: {arm, version, keys, family, hits10}
const keys = queries.map((q) => q.qid), family = queries.map((q) => q.family)
for (const [side, name] of [['raw', `${BASE}_rawtop50`], ['reranked', ARM]]) {
  writeFileSync(join(RESULTS, `${name}.perquery.json`),
    JSON.stringify({ arm: name, version: VERSION, keys, family, hits10: perq[side] }))
}
// SHAPE FIX (LANE-QP3, 2026-08-20). This file used to write
//   metrics: { raw: {FAM:{seg}}, reranked: {FAM:{seg}} }
// while EVERY encoder arm written by score.mjs writes
//   metrics: {FAM:{seg}}
// Two costs, both paid: (a) any generic reader — fill-card.mjs does exactly this —
// resolves `metrics[family]` to undefined and silently emits null; (b) a human
// opening the file sees `metrics.raw` FIRST, and `metrics.raw` is byte-identical
// to the base encoder's own results row, so the file reads as if the rerank did
// nothing. Both are silent failures. `metrics` now means the same thing for every
// arm in results/ — THIS arm's numbers — and the base encoder's top-50 baseline
// moves to `base_metrics`, named for what it is.
writeFileSync(join(RESULTS, `${ARM}.json`), JSON.stringify({
  arm: ARM, version: VERSION, source: IN, base_arm: BASE, n_queries: scored,
  note: 'SYSTEM arm: encoder retrieval + cross-encoder rerank of its top-50. Not an encoder-vs-encoder row.',
  metrics_note: `metrics = the SYSTEM (${ARM}); base_metrics = ${BASE}'s own top-50 in retrieval order, the paired baseline. Same shape as every encoder arm, so metrics[family].blended[k] is comparable across all of results/.`,
  scored_at: new Date().toISOString(),
  metrics: agg.reranked,
  base_metrics: agg.raw,
}, null, 1))

let gate = true
for (const fam of Object.keys(agg.raw)) {
  console.log(`\n### ${fam} — ${BASE} top-50 raw vs +cshl-RR   (R@1 / R@10 / nDCG@10)`)
  console.log('| segment | n | raw | reranked | ΔR@10 | ΔnDCG@10 |')
  console.log('|---|---:|---|---|---:|---:|')
  for (const seg of Object.keys(agg.raw[fam])) {
    const a = agg.raw[fam][seg], b = agg.reranked[fam][seg]
    const d10 = a.r10 ? ((b.r10 - a.r10) / a.r10) * 100 : 0
    const dnd = a.ndcg10 ? ((b.ndcg10 - a.ndcg10) / a.ndcg10) * 100 : 0
    const ok = b.r10 >= a.r10 && b.ndcg10 >= a.ndcg10
    if (!ok) gate = false
    console.log(`| ${seg} | ${a.n} | ${a.r1} / ${a.r10} / ${a.ndcg10} | **${b.r1} / ${b.r10} / ${b.ndcg10}** | ${d10 >= 0 ? '+' : ''}${d10.toFixed(0)}% | ${dnd >= 0 ? '+' : ''}${dnd.toFixed(0)}% ${ok ? '✓' : '✗'} |`)
  }
}
console.log(`\ngate (reranked >= raw on R@10 AND nDCG@10 in every segment, both families): ${gate}`)
console.log(`wrote ${RESULTS}/${ARM}.json + ${BASE}_rawtop50.perquery.json + ${ARM}.perquery.json`)
