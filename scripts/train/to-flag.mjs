#!/usr/bin/env node
// to-flag.mjs — turn the miner lane's triplets into FlagEmbedding's train.jsonl,
// and refuse to emit a set that leaks the eval holdout.
// Ported from scripts/train-nsr/to-flag.mjs at 8c1b05b.
//
// CHANGED vs the NSR original:
//   - input is the miner lane's contract file, not NSR's bespoke anchor format
//     (contract in LANE-RIG-PORT.md REPORT §3; coordinate there, not in code).
//   - text is resolved from `preprints` by business key at convert time, so the
//     triplet file only ever carries keys — a mined set stays valid when the
//     input recipe changes.
//   - THE DISJOINTNESS GATE IS NOW A HARD FAILURE, not a report line. NSR's
//     first sweep leaked held-out papers into 24.7% of negative slots and the
//     whole encoder had to be retrained. Same hash rule as the benchmark
//     builder, imported from it so the two can never drift.
//
// Usage: node scripts/train/to-flag.mjs [--allow-holdout-negatives]
//   IN=data/mine/triplets.jsonl OUT=data/train/<name>/train.jsonl NEGS=8
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { neon } from '@neondatabase/serverless'
import { recipeSql, assertWorkerMatches, CAP as CANON_CAP } from '../eval/recipe.mjs'

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
}

const IN = process.env.IN ?? 'data/mine/triplets.jsonl'
const NAME = process.env.NAME ?? 'full'
const OUT = process.env.OUT ?? `data/train/${NAME}/train.jsonl`
const NEGS = Number(process.env.NEGS ?? 8)
// The training string MUST be the embedded string. Do not re-derive it here —
// scripts/eval/recipe.mjs is canonical and worker.mjs is its source of truth.
const CAP = Number(process.env.CAP ?? CANON_CAP)
const HOLDOUT = Number(process.env.HOLDOUT ?? 0.25)
const ALLOW = process.argv.includes('--allow-holdout-negatives')

const h32 = (s) => parseInt(createHash('md5').update(s).digest('hex').slice(0, 8), 16) / 0xffffffff
const isHeldOut = (key) => h32(`holdout:${key}`) < HOLDOUT

if (!existsSync(IN)) {
  console.error(`no triplet file at ${IN}.`)
  console.error(`This is the LANE-MINE handoff. Expected one JSON object per line:`)
  console.error(`  {"anchor_key":"2024.01.02.123456","query":"<text or null>",`)
  console.error(`   "positives":["<key>",...],"negatives":["<key>",...],"source":"citations|mesh|synth"}`)
  console.error(`If "query" is null the anchor paper's own title+abstract is used as the query`)
  console.error(`(doc-doc contrastive, the SPECTER/SciNCL recipe).`)
  process.exit(2)
}

const url = process.env.DATABASE_URL_UNPOOLED
const host = url.replace(/^[^@]+@/, '').replace(/[/?].*$/, '')
if (!host.startsWith('ep-orange-water-aut2eymf.')) throw new Error(`FENCE FAIL: ${host}`)
const sql = neon(url)

await assertWorkerMatches()   // fails loudly if the box-side recipe has drifted
const rows = readFileSync(IN, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
console.log(`${rows.length} mined records from ${IN} (recipe cap ${CAP}, canonical)`)

// resolve every key we need, in one pass
const keys = [...new Set(rows.flatMap((r) => [r.anchor_key, ...(r.positives ?? []), ...(r.negatives ?? [])]).filter(Boolean))]
const text = new Map()
for (let i = 0; i < keys.length; i += 5000) {
  const got = await sql.query(
    `SELECT key_number, ${recipeSql('preprints', CAP)} AS t
       FROM preprints WHERE key_number = ANY($1)`, [keys.slice(i, i + 5000)])
  for (const g of got) text.set(g.key_number, g.t)
}
console.log(`resolved ${text.size}/${keys.length} keys to text`)

// ── the gate ────────────────────────────────────────────────────────────────
const audit = { records: rows.length, anchors_held_out: 0, positives_held_out: 0, negatives_held_out: 0 }
for (const r of rows) {
  if (r.anchor_key && isHeldOut(r.anchor_key)) audit.anchors_held_out++
  audit.positives_held_out += (r.positives ?? []).filter(isHeldOut).length
  audit.negatives_held_out += (r.negatives ?? []).filter(isHeldOut).length
}
console.log('holdout audit (pre-filter):', JSON.stringify(audit))

const out = []
const used = { anchors: new Set(), positives: new Set(), negatives: new Set() }
let dropped = 0
for (const r of rows) {
  if (r.anchor_key && isHeldOut(r.anchor_key)) { dropped++; continue }
  const pos = (r.positives ?? []).filter((k) => !isHeldOut(k) && text.get(k))
  const neg = (r.negatives ?? []).filter((k) => (ALLOW || !isHeldOut(k)) && text.get(k)).slice(0, NEGS)
  if (!pos.length || neg.length < Math.min(2, NEGS)) { dropped++; continue }
  const query = r.query ?? text.get(r.anchor_key)
  if (!query) { dropped++; continue }
  if (r.anchor_key) used.anchors.add(r.anchor_key)
  pos.forEach((k) => used.positives.add(k))
  neg.forEach((k) => used.negatives.add(k))
  out.push({ query, pos: pos.map((k) => text.get(k)), neg: neg.map((k) => text.get(k)) })
}
console.log(`emitting ${out.length} pairs (${dropped} records dropped)`)

// Disjointness is audited on what was EMITTED, not on what was read — auditing
// the input is how you get a scary red failure for papers you correctly dropped.
const post = {
  anchors: [...used.anchors].filter(isHeldOut).length,
  positives: [...used.positives].filter(isHeldOut).length,
  negatives: [...used.negatives].filter(isHeldOut).length,
}
console.log('holdout audit (emitted):', JSON.stringify(post))
const pass = post.anchors === 0 && post.positives === 0 && (ALLOW || post.negatives === 0)
if (!pass) {
  console.error('DISJOINTNESS FAIL — held-out papers survived into the output. Nothing written.')
  process.exit(1)
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, out.map((o) => JSON.stringify(o)).join('\n') + '\n')
writeFileSync(join(dirname(OUT), 'manifest.json'), JSON.stringify({
  name: NAME, built_at: new Date().toISOString(), input: IN,
  input_md5: createHash('md5').update(readFileSync(IN)).digest('hex').slice(0, 16),
  pairs: out.length, negs_per_pair: NEGS, char_cap: CAP, holdout_fraction: HOLDOUT,
  holdout_rule: 'md5("holdout:" || key_number) — identical to scripts/eval/build-rxiv-eval.mjs',
  audit_pre_filter: audit,
  disjointness: { pass: true, held_out_anchors_in_output: post.anchors,
                  held_out_positives_in_output: post.positives,
                  held_out_negatives_in_output: post.negatives,
                  held_out_negatives_allowed: ALLOW },
}, null, 2))
console.log(`wrote ${OUT} + manifest.json — disjointness.pass = true`)
