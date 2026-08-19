// Gate 2 for LANE-RERANK: metrics for raw bge-m3 top-50 vs reranked top-50,
// per family × segment, from the box's reranked-<run>.json + the frozen qrels.
//   node scripts/eval/score-rerank.mjs <reranked.json> [--out data/eval/nsr-eval-v1/results/RR.json]
// Recall@k / MRR / nDCG@10; a hit = any judged key_number in the top-k
// (twins are not folded here — this is a paired comparison, same list both
// sides, so the twin rule cancels).
import { readFileSync, writeFileSync } from 'node:fs'
const [file, ...rest] = process.argv.slice(2)
const out = rest.includes('--out') ? rest[rest.indexOf('--out') + 1] : 'data/eval/nsr-eval-v1/results/RR.json'
const EV = 'data/eval/nsr-eval-v1'
const qrels = new Map()
for (const line of readFileSync(`${EV}/qrels.tsv`, 'utf8').split('\n')) {
  if (!line.trim()) continue
  const [qid, key] = line.split('\t'); if (qid === 'qid') continue
  if (!qrels.has(qid)) qrels.set(qid, new Set()); qrels.get(qid).add(key)
}
const queries = new Map()
for (const line of readFileSync(`${EV}/queries.jsonl`, 'utf8').split('\n')) {
  if (!line.trim()) continue; const q = JSON.parse(line); queries.set(q.qid, q)
}
const segsOf = (q) => ['blended', `era:${q.era}`, `richness:${q.richness}`, `reftype:${q.reftype}`]
const metrics = (ranked, rel) => {
  const hitAt = (k) => ranked.slice(0, k).some((x) => rel.has(x)) ? 1 : 0
  let rr = 0; const i = ranked.findIndex((x) => rel.has(x)); if (i >= 0) rr = 1 / (i + 1)
  let dcg = 0; ranked.slice(0, 10).forEach((x, j) => { if (rel.has(x)) dcg += 1 / Math.log2(j + 2) })
  const ideal = Math.min(rel.size, 10); let idcg = 0; for (let j = 0; j < ideal; j++) idcg += 1 / Math.log2(j + 2)
  return { r1: hitAt(1), r5: hitAt(5), r10: hitAt(10), r50: hitAt(50), mrr: rr, ndcg10: idcg ? dcg / idcg : 0 }
}
const rows = JSON.parse(readFileSync(file, 'utf8'))
const agg = { raw: {}, reranked: {} }
const add = (side, fam, seg, m) => {
  const a = (agg[side][fam] ||= {}); const c = (a[seg] ||= { n: 0, r1: 0, r5: 0, r10: 0, r50: 0, mrr: 0, ndcg10: 0 })
  c.n++; for (const k of ['r1', 'r5', 'r10', 'r50', 'mrr', 'ndcg10']) c[k] += m[k]
}
let scored = 0
for (const r of rows) {
  const q = queries.get(r.qid); const rel = qrels.get(r.qid); if (!q || !rel) continue
  scored++
  const mr = metrics(r.raw_top50, rel), mk = metrics(r.reranked_top50, rel)
  for (const seg of segsOf(q)) { add('raw', r.family, seg, mr); add('reranked', r.family, seg, mk) }
}
for (const side of ['raw', 'reranked']) for (const fam of Object.keys(agg[side])) for (const seg of Object.keys(agg[side][fam])) {
  const c = agg[side][fam][seg]; for (const k of ['r1', 'r5', 'r10', 'r50', 'mrr', 'ndcg10']) c[k] = +(c[k] / c.n).toFixed(4)
}
writeFileSync(out, JSON.stringify({ arm: 'reranked-top50', source: file, n_queries: scored, metrics: agg }, null, 1))
let gate = true
for (const fam of Object.keys(agg.raw)) {
  console.log(`\n### ${fam} — raw bge-m3 top-50 vs +reranker (R@1 / R@10 / nDCG@10)`)
  console.log('| segment | n | raw | reranked | ΔR@10 |'); console.log('|---|---:|---|---|---:|')
  for (const seg of Object.keys(agg.raw[fam])) {
    const a = agg.raw[fam][seg], b = agg.reranked[fam][seg]
    const ok = b.r10 >= a.r10 && b.ndcg10 >= a.ndcg10; gate &&= ok
    const f = (m) => `${m.r1.toFixed(3)} / ${m.r10.toFixed(3)} / ${m.ndcg10.toFixed(3)}`
    console.log(`| ${seg} | ${a.n} | ${f(a)} | **${f(b)}** | ${((b.r10 - a.r10) / (a.r10 || 1) * 100).toFixed(0)}% ${ok ? '✓' : '✗'} |`)
  }
}
const kb = agg.raw.KW?.blended, kd = agg.reranked.KW?.blended
if (kb && kd) console.log(`\nGate 2: reranked ≥ raw on R@10 & nDCG@10 in every segment → ${gate}; blended KW nDCG@10 relative ${((kd.ndcg10 - kb.ndcg10) / kb.ndcg10 * 100).toFixed(0)}% (gate ≥ +10%)`)
console.log(`wrote ${out} (${scored} queries)`)
