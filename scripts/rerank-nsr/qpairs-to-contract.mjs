#!/usr/bin/env node
// qpairs-to-contract.mjs — LANE-MINE's query-pair shape -> the keys-only miner
// contract scripts/rerank-nsr/to-groups.mjs already consumes. An ADAPTER, not a
// second converter: no holdout logic, no text, no sampling policy of its own
// beyond a deterministic take-first-N. to-groups.mjs stays the single place the
// held-out rule and the emit-side bleed proof live (LANE-RERANK G1).
//
// in   {query, positive:{slug}, negatives:[{slug,source}], meta:{family,...}}
// out  {query, positives:[key], negatives:[key], source}     (no anchor_key —
//      these queries are TEXT, not papers; to-groups.mjs already guards `r.anchor_key`)
//
// Usage: IN=data/mine/cshl-query-pairs.train.jsonl N=40000 \
//        OUT=data/mine/rerank-input.jsonl node scripts/rerank-nsr/qpairs-to-contract.mjs
import { createReadStream, writeFileSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'

const IN = process.env.IN ?? 'data/mine/cshl-query-pairs.train.jsonl'
const OUT = process.env.OUT ?? 'data/mine/rerank-input.jsonl'
const N = Number(process.env.N ?? 40000)

const out = []
const fam = {}
let read = 0, noQuery = 0, noPos = 0, noNegs = 0
const rl = createInterface({ input: createReadStream(IN), crlfDelay: Infinity })
for await (const line of rl) {
  if (!line) continue
  read++
  const r = JSON.parse(line)
  const q = typeof r.query === 'string' ? r.query.trim() : ''
  if (!q) { noQuery++; continue }                       // doc->doc records (triplets) land here
  const pos = r.positive?.slug
  if (!pos) { noPos++; continue }
  const negs = (r.negatives ?? []).map((n) => n?.slug).filter(Boolean)
  if (!negs.length) { noNegs++; continue }
  const f = r.meta?.family ?? 'unknown'
  fam[f] = (fam[f] ?? 0) + 1
  out.push({ query: q, positives: [pos], negatives: negs, source: f })
  if (out.length >= N) break                            // deterministic: file order, take-first-N
}
rl.close()
writeFileSync(OUT, out.map((o) => JSON.stringify(o)).join('\n') + '\n')
const pct = (n) => ((100 * n) / out.length).toFixed(1) + '%'
console.log(`read ${read} lines of ${IN}`)
console.log(`  dropped: no-query ${noQuery} · no-positive ${noPos} · no-negatives ${noNegs}`)
console.log(`wrote ${out.length} records -> ${OUT} (${(statSync(OUT).size / 1e6).toFixed(1)} MB)`)
console.log(`  family mix: ${Object.entries(fam).map(([k, v]) => `${k} ${v} (${pct(v)})`).join(' · ')}`)
