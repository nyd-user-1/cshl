#!/usr/bin/env node
// to-groups.mjs — miner triplets -> 44b train.py's train-groups.jsonl.
// Ported from scripts/rerank-nsr/pairs-to-groups.mjs at 8c1b05b, which consumed
// NSR's bespoke {query, positive:{slug,title,abstract}, negatives:[...]} shape.
//
// CHANGED vs the NSR original:
//   - input is the SAME miner contract the encoder trainer consumes
//     (data/mine/triplets.jsonl, keys only) — one harvest feeds both models
//     instead of two mining passes with two chances to disagree about holdout.
//   - text is resolved from `preprints` at convert time, not carried in the file.
//   - the held-out guard is identical to scripts/train/to-flag.mjs and
//     scripts/eval/build-rxiv-eval.mjs (same hash, same fraction) and audits
//     what is EMITTED, not what is read.
//
// Out: {q, pos, negs[], src} — the shape train.py:68 reuses instead of mining.
// Usage: IN=data/mine/triplets.jsonl NAME=full node scripts/rerank-nsr/to-groups.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { neon } from '@neondatabase/serverless'

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
}
const IN = process.env.IN ?? 'data/mine/triplets.jsonl'
const NAME = process.env.NAME ?? 'full'
const OUT = process.env.OUT ?? `data/reranker/${NAME}`
const NEGS = Number(process.env.NEGS ?? 7)
const QUERY_CHARS = Number(process.env.QUERY_CHARS ?? 600)
// NOT the embed recipe, deliberately. A cross-encoder sees (query, document)
// pairs bounded by what the SERVING path sends — api/_lib/embed.ts rerank()
// slices query to 600 and each document to 900. Training on 4,000-char
// documents it will never see at serve time is the mismatch, not the fix.
// If those serving limits change, change these with them.
const DOC_CHARS = Number(process.env.DOC_CHARS ?? 900)
const HOLDOUT = Number(process.env.HOLDOUT ?? 0.25)
const h32 = (s) => parseInt(createHash('md5').update(s).digest('hex').slice(0, 8), 16) / 0xffffffff
const isHeldOut = (k) => h32(`holdout:${k}`) < HOLDOUT

if (!existsSync(IN)) { console.error(`no triplet file at ${IN} — see scripts/train/to-flag.mjs for the contract`); process.exit(2) }
const url = process.env.DATABASE_URL_UNPOOLED
if (!url.replace(/^[^@]+@/, '').startsWith('ep-orange-water-aut2eymf.')) throw new Error('FENCE FAIL')
const sql = neon(url)

const rows = readFileSync(IN, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const keys = [...new Set(rows.flatMap((r) => [r.anchor_key, ...(r.positives ?? []), ...(r.negatives ?? [])]).filter(Boolean))]
const text = new Map()
for (let i = 0; i < keys.length; i += 5000) {
  const got = await sql.query(`SELECT key_number, left(trim(coalesce(title,'') || E'\n\n' || coalesce(abstract,'')), ${DOC_CHARS}) AS t FROM preprints WHERE key_number = ANY($1)`, [keys.slice(i, i + 5000)])
  for (const g of got) text.set(g.key_number, g.t)
}
console.log(`${rows.length} records, resolved ${text.size}/${keys.length} keys`)

const groups = []
const used = new Set()
let emptied = 0, heldSkipped = 0
for (const r of rows) {
  if (r.anchor_key && isHeldOut(r.anchor_key)) { heldSkipped++; continue }
  const pos = (r.positives ?? []).find((k) => !isHeldOut(k) && text.get(k))
  if (!pos) { heldSkipped++; continue }
  const negs = (r.negatives ?? []).filter((k) => !isHeldOut(k) && text.get(k)).slice(0, NEGS)
  if (!negs.length) { emptied++; continue }   // a group with no negatives teaches nothing
  const q = String(r.query ?? text.get(r.anchor_key) ?? '').slice(0, QUERY_CHARS)
  if (!q) { emptied++; continue }
  used.add(pos); negs.forEach((k) => used.add(k)); if (r.anchor_key) used.add(r.anchor_key)
  groups.push({ q, pos: text.get(pos), negs: negs.map((k) => text.get(k)), src: r.source ?? 'unknown' })
}
// prove the split, do not assert it
const bleed = [...used].filter(isHeldOut)
console.log(`groups ${groups.length} · dropped held-out ${heldSkipped} · dropped empty-negatives ${emptied}`)
console.log(`holdout bleed into emitted groups: ${bleed.length} (must be 0)`)
if (bleed.length) { console.error('HOLDOUT BLEED — nothing written.'); process.exit(1) }

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'train-groups.jsonl'), groups.map((g) => JSON.stringify(g)).join('\n') + '\n')
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({
  name: NAME, built_at: new Date().toISOString(), input: IN,
  input_md5: createHash('md5').update(readFileSync(IN)).digest('hex').slice(0, 16),
  groups: groups.length, negs_per_group: NEGS, holdout_fraction: HOLDOUT,
  disjointness: { pass: true, held_out_papers_in_output: 0 },
}, null, 2))
console.log(`wrote ${OUT}/train-groups.jsonl — train.py:68 will REUSE these rather than mine its own`)
