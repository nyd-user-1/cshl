#!/usr/bin/env node
// paired-test.mjs — McNemar on paired R@10 hits between two scored arms.
//
// Both arms answered the SAME 300 queries against the SAME 10k slice, so the
// comparison is paired and the right test is McNemar's on the discordant pairs
// (queries one arm got and the other missed). A difference in means says nothing
// about whether the arms actually disagree per query.
import { readFileSync } from 'node:fs'

const [, , armA, armB] = process.argv
if (!armA || !armB) { console.error('usage: paired-test.mjs <fileA> <fileB>'); process.exit(2) }
const load = (f) => JSON.parse(readFileSync(`data/kb-slice/results/${f}.json`, 'utf8'))
const QRELS = new Map()
for (const l of readFileSync('data/kb-slice/qrels.tsv', 'utf8').split('\n').filter(Boolean)) {
  const [qid, k] = l.split('\t'); if (!QRELS.has(qid)) QRELS.set(qid, new Set()); QRELS.get(qid).add(k)
}
const QF = new Map(readFileSync('data/kb-slice/queries.jsonl', 'utf8').split('\n').filter(Boolean)
  .map(JSON.parse).map((q) => [q.qid, q.family]))
const A = load(armA), B = load(armB)
const hit = (per, qid) => (per[qid] ?? []).slice(0, 10).some((k) => QRELS.get(qid)?.has(k))

// two-sided exact binomial on the discordant pairs (McNemar, exact form)
function exactP(b, c) {
  const n = b + c; if (!n) return 1
  const lc = (n, k) => { let s = 0; for (let i = 0; i < k; i++) s += Math.log(n - i) - Math.log(i + 1); return s }
  const pmf = (k) => Math.exp(lc(n, k) + n * Math.log(0.5))
  const obs = pmf(Math.min(b, c)); let p = 0
  for (let k = 0; k <= n; k++) { const v = pmf(k); if (v <= obs * 1.0000001) p += v }
  return Math.min(1, p)
}
for (const seg of ['blended', 'MESH', 'AUTHORKW']) {
  const qids = [...QRELS.keys()].filter((q) => seg === 'blended' || QF.get(q) === seg)
  let b = 0, c = 0, aH = 0, bH = 0
  for (const q of qids) {
    const x = hit(A.perQuery, q), y = hit(B.perQuery, q)
    if (x) aH++; if (y) bH++
    if (x && !y) b++; if (!x && y) c++
  }
  const n = qids.length
  console.log(`${seg.padEnd(9)} n=${String(n).padEnd(4)} ${armA} ${(aH / n).toFixed(4)}  vs  ${armB} ${(bH / n).toFixed(4)}   Δ=${((aH - bH) / n >= 0 ? '+' : '') + ((aH - bH) / n).toFixed(4)}  discordant ${b}/${c}  p=${exactP(b, c).toExponential(2)}`)
}
