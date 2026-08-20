#!/usr/bin/env node
// paired-test.mjs — paired McNemar + bootstrap CI on two arms' per-query hits.
//
// Two aggregate R@10 numbers with overlapping error bars are not a result. The
// arms are scored on the SAME queries, so the comparison should be paired:
// what matters is the queries where exactly one arm hit, not the totals.
//
// Consumes the `<arm>.perquery.json` files score-docdoc.mjs already writes
// ({arm, hits10:[0|1,…], keys:[…]}) and asserts the two arms were scored over
// the same keys in the same order before comparing anything.
//
// Usage: A=cshl_qp B=medcpt DIR=data/eval/cshl-eval-docdoc/results \
//          node scripts/eval/paired-test.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.DIR ?? 'data/eval/cshl-eval-docdoc/results'
const A = process.env.A ?? (() => { throw new Error('set A') })()
const B = process.env.B ?? (() => { throw new Error('set B') })()
const RESAMPLES = Number(process.env.RESAMPLES ?? 5000)
const SEED = Number(process.env.SEED ?? 20260819)

// FAMILY=MESH|AUTHORKW restricts the comparison to one query family. The
// aggregate over both families is a different question from "did we beat
// MedCPT on MeSH": the two families have different difficulty and different
// n, so a blended win can hide a per-family loss. score.mjs writes the family
// vector into perquery.json precisely so this can be sliced without re-scoring.
const FAMILY = process.env.FAMILY ?? ''
const load = (arm) => JSON.parse(readFileSync(join(DIR, `${arm}.perquery.json`), 'utf8'))
let a = load(A), b = load(B)
if (FAMILY) {
  if (!a.family || !b.family) { console.error(`FATAL: FAMILY=${FAMILY} requested but ${!a.family ? A : B}.perquery.json has no family vector (doc->doc results do not carry one)`); process.exit(1) }
  const keep = a.family.map((f, i) => (f === FAMILY ? i : -1)).filter((i) => i >= 0)
  if (!keep.length) { console.error(`FATAL: no queries with family '${FAMILY}' (have: ${[...new Set(a.family)].join(', ')})`); process.exit(1) }
  const sub = (o) => ({ ...o, keys: keep.map((i) => o.keys[i]), hits10: keep.map((i) => o.hits10[i]), family: keep.map((i) => o.family[i]) })
  // Slice B by A's positions only after the pairing check below confirms the
  // two files are in the same order — so slice both by the SAME index list and
  // let that check run on the sliced arrays.
  a = sub(a); b = sub(b)
  console.log(`FAMILY=${FAMILY}: ${keep.length.toLocaleString()} of the ${load(A).hits10.length.toLocaleString()} scored queries`)
}

// Pairing is the entire premise. Check it rather than assume it.
if (a.hits10.length !== b.hits10.length) { console.error(`FATAL: ${A} has ${a.hits10.length} queries, ${B} has ${b.hits10.length}`); process.exit(1) }
const mismatched = a.keys.reduce((n, k, i) => n + (k === b.keys[i] ? 0 : 1), 0)
if (mismatched) { console.error(`FATAL: ${mismatched} positions where the two arms scored different queries — not a paired comparison`); process.exit(1) }
const n = a.hits10.length

let n01 = 0, n10 = 0, both = 0, neither = 0
const diffs = new Array(n)
for (let i = 0; i < n; i++) {
  const x = a.hits10[i], y = b.hits10[i]
  if (x && !y) n10++; else if (!x && y) n01++; else if (x && y) both++; else neither++
  diffs[i] = x - y
}
const rA = a.hits10.reduce((s, x) => s + x, 0) / n
const rB = b.hits10.reduce((s, x) => s + x, 0) / n

// Exact two-sided binomial McNemar over the discordant pairs. Exact rather than
// the chi-square approximation: the discordant counts here are in the hundreds
// but the approximation is what people get wrong, and exact costs nothing.
function exactMcNemar(k, m) {
  if (m === 0) return 1
  // sum of binomial(m, 0.5) pmf over outcomes at least as extreme as k
  const logC = (mm, kk) => { let s = 0; for (let i = 0; i < kk; i++) s += Math.log(mm - i) - Math.log(i + 1); return s }
  const pmf = (kk) => Math.exp(logC(m, kk) - m * Math.LN2)
  const t = pmf(k)
  let p = 0
  for (let i = 0; i <= m; i++) { const v = pmf(i); if (v <= t * (1 + 1e-9)) p += v }
  return Math.min(1, p)
}
const p = exactMcNemar(Math.min(n10, n01), n10 + n01)

// Deterministic bootstrap: a seeded PRNG, so the CI is reproducible. Resampling
// the paired DIFFERENCES, not the two arms independently.
let s = SEED >>> 0
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
const means = new Array(RESAMPLES)
for (let r = 0; r < RESAMPLES; r++) {
  let acc = 0
  for (let i = 0; i < n; i++) acc += diffs[(rnd() * n) | 0]
  means[r] = acc / n
}
means.sort((x, y) => x - y)
const lo = means[Math.floor(0.025 * RESAMPLES)], hi = means[Math.floor(0.975 * RESAMPLES)]

const f = (x) => (x >= 0 ? '+' : '') + x.toFixed(4)
console.log(`paired on ${n.toLocaleString()} queries (same keys, same order — asserted)`)
console.log(`  ${A}  R@10 ${rA.toFixed(4)}`)
console.log(`  ${B}  R@10 ${rB.toFixed(4)}`)
console.log(`  both hit ${both} · neither ${neither} · ${A}-only ${n10} · ${B}-only ${n01}`)
console.log(`  ΔR@10 ${f(rA - rB)}   exact McNemar p = ${p < 1e-4 ? p.toExponential(2) : p.toFixed(4)}`)
console.log(`  bootstrap 95% CI on ${A} − ${B}: [${f(lo)}, ${f(hi)}]  (${RESAMPLES.toLocaleString()} resamples, seed ${SEED})`)
console.log(JSON.stringify({ a: A, b: B, n, r10_a: +rA.toFixed(4), r10_b: +rB.toFixed(4),
  a_only: n10, b_only: n01, delta: +(rA - rB).toFixed(4), p, ci95: [+lo.toFixed(4), +hi.toFixed(4)], resamples: RESAMPLES, seed: SEED }))
