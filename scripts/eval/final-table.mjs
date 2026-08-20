#!/usr/bin/env node
// final-table.mjs — LANE-QP3's morning report table.
//
// The lead's addition (b): the vs-stock-bge-m3 rows belong ALONGSIDE the
// vs-MedCPT rows, not in a separate document. Two different questions get asked
// of this program and they have different baselines:
//   "did the fine-tune work?"        -> vs stock bge-m3, the model we started from
//   "are we competitive?"            -> vs MedCPT, the domain incumbent
// A table with only one of them invites the other to be guessed at.
//
// Reads every results/*.json. Encoder arms carry metrics:{FAM:{seg}}; SYSTEM
// arms (encoder+reranker) carry the same shape since the shape fix, with the
// paired baseline under base_metrics — so one accessor works for both and a
// system row can never again be read as its base encoder's row.
//
//   EVAL_VERSION=cshl-eval-2k node scripts/eval/final-table.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const V = process.env.EVAL_VERSION ?? 'cshl-eval-2k'
const R = join(process.cwd(), 'data/eval', V, 'results')
const METRIC = process.env.METRIC ?? 'r10'
const arms = {}
for (const f of readdirSync(R).filter((f) => f.endsWith('.json') && !f.endsWith('.perquery.json'))) {
  const j = JSON.parse(readFileSync(join(R, f), 'utf8'))
  if (j?.arm) arms[j.arm] = j
}
const g = (arm, fam, m = METRIC) => arms[arm]?.metrics?.[fam]?.blended?.[m] ?? null
const STOCK = 'bge-m3', MEDCPT = 'medcpt', MEDCPT_SYS = 'medcpt+medcpt_ce'
const fmt = (v) => (v == null ? '—' : v.toFixed(4))
const rel = (v, b) => (v == null || b == null ? '—' : `${v - b >= 0 ? '+' : ''}${(((v - b) / b) * 100).toFixed(1)}%`)
const abs = (v, b) => (v == null || b == null ? '—' : `${v - b >= 0 ? '+' : ''}${(v - b).toFixed(4)}`)

// Blended-across-families, weighted by family n — the single headline number
// D8's target 0.6510 is stated in.
const blend = (arm, m = METRIC) => {
  const mm = arms[arm]?.metrics; if (!mm) return null
  let num = 0, den = 0
  for (const fam of ['MESH', 'AUTHORKW']) { const b = mm[fam]?.blended; if (!b) return null; num += b[m] * b.n; den += b.n }
  return den ? num / den : null
}

const ENCODERS = (process.env.ENCODERS ?? 'bge-m3,specter2,medcpt,cshl,cshl_qp,cshl_qp2,cshl_qp3').split(',').filter((a) => arms[a])
const SYSTEMS  = (process.env.SYSTEMS  ?? 'cshl_qp+cshl_rr,cshl_qp2+cshl_rr,cshl_qp3+cshl_rr,medcpt+cshl_rr,medcpt+medcpt_ce').split(',').filter((a) => arms[a])

const section = (title, list, vsSysBaseline) => {
  console.log(`\n### ${title} — R@${METRIC.slice(1)} on ${V}, blended segment\n`)
  console.log('| arm | MESH | AUTHORKW | blended | vs stock bge-m3 (MESH / AUTHORKW) | vs MedCPT (MESH / AUTHORKW) |')
  console.log('|---|---:|---:|---:|---:|---:|')
  const bStockM = g(STOCK, 'MESH'), bStockA = g(STOCK, 'AUTHORKW')
  const cmp = vsSysBaseline ?? MEDCPT
  const bMedM = g(cmp, 'MESH'), bMedA = g(cmp, 'AUTHORKW')
  for (const a of list) {
    const mM = g(a, 'MESH'), mA = g(a, 'AUTHORKW')
    const star = a.startsWith('cshl_qp3') ? '**' : ''
    console.log(`| ${star}\`${a}\`${star} | ${fmt(mM)} | ${fmt(mA)} | ${fmt(blend(a))} | ${rel(mM, bStockM)} / ${rel(mA, bStockA)} | ${abs(mM, bMedM)} / ${abs(mA, bMedA)} |`)
  }
  console.log(`\nvs-stock column is RELATIVE (the fine-tune question); vs-${cmp} column is ABSOLUTE Δ (the competitive question, and the units the McNemar tests are in).`)
}

section('ENCODER vs ENCODER', ENCODERS, MEDCPT)
section('SYSTEM vs SYSTEM (encoder + cross-encoder rerank of its top-50)', SYSTEMS, MEDCPT_SYS)

console.log('\n### D8 targets\n')
const t = [
  ['encoder AUTHORKW  > 0.8076 (medcpt)',        g('cshl_qp3', 'AUTHORKW'), 0.8076],
  ['system  AUTHORKW  > 0.8577 (medcpt+CE)',     g('cshl_qp3+cshl_rr', 'AUTHORKW'), 0.8577],
  ['system  blended   > 0.6510 (medcpt+CE)',     blend('cshl_qp3+cshl_rr'), 0.6510],
]
console.log('| target | achieved | verdict |'); console.log('|---|---:|---|')
for (const [label, v, target] of t) {
  console.log(`| ${label} | ${v == null ? '—' : v.toFixed(4)} | ${v == null ? 'NOT YET SCORED' : v > target ? '**MET**' : `missed by ${(target - v).toFixed(4)}`} |`)
}
