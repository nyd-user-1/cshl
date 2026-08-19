#!/usr/bin/env node
// qemb-from-run.mjs — take the query vectors the TRAIN BOX produced with the
// fresh checkpoint (train.sh §5b), subset them to a benchmark's query set, and
// install them as an arm's qemb file — refusing, loudly, if they are not what
// they claim to be.
//
// WHY THIS IS A SCRIPT AND NOT A `jq` ONE-LINER: the single clearest failure in
// this program was two arms scored from one model. Two query-vector files came
// out byte-identical, both with the right dimension, the right row count, the
// right query strings and plausible floats, and NOTHING raised an error. The
// guard that would have caught it is a cross-arm digest comparison that treats
// identical checksums as fatal rather than as output. That guard is below, and
// it is the reason this file exists.
//
// Usage:
//   SRC=/path/qemb-<run>.jsonl ARM=cshl_qp VERSION=cshl-eval-2k EXPECT_DIM=1024 \
//     node scripts/eval/qemb-from-run.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const SRC = process.env.SRC ?? (() => { throw new Error('set SRC') })()
const ARM = process.env.ARM ?? (() => { throw new Error('set ARM') })()
const VERSION = process.env.VERSION ?? 'cshl-eval-2k'
const EXPECT_DIM = Number(process.env.EXPECT_DIM ?? 1024)
const ROOT = join(process.cwd(), 'data/eval', VERSION)
const QEMB = join(ROOT, 'qemb')
mkdirSync(QEMB, { recursive: true })

const fail = (m) => { console.error(`FATAL: ${m}`); process.exit(1) }

// The benchmark decides which qids are in scope — not the source file.
const wanted = new Map()
for (const l of readFileSync(join(ROOT, 'queries.jsonl'), 'utf8').split('\n')) {
  if (!l) continue
  const o = JSON.parse(l)
  wanted.set(o.qid, o.text)
}
console.log(`${VERSION}: ${wanted.size.toLocaleString()} queries in the frozen benchmark`)

const picked = new Map()
let srcRows = 0
for (const l of readFileSync(SRC, 'utf8').split('\n')) {
  if (!l) continue
  srcRows++
  const o = JSON.parse(l)
  if (wanted.has(o.qid)) picked.set(o.qid, o.v)
}
console.log(`source ${SRC}: ${srcRows.toLocaleString()} rows -> ${picked.size.toLocaleString()} matched this benchmark`)

// ── assertions, every one re-derived from the vectors themselves ─────────────
const missing = [...wanted.keys()].filter((q) => !picked.has(q))
if (missing.length) fail(`${missing.length} benchmark queries have no vector (e.g. ${missing.slice(0, 3).join(', ')})`)

const dims = new Set(), norms = []
let nonFinite = 0, allZero = 0
for (const v of picked.values()) {
  dims.add(v.length)
  let s = 0, nz = 0
  for (const x of v) { if (!Number.isFinite(x)) nonFinite++; s += x * x; if (x !== 0) nz++ }
  if (nz === 0) allZero++
  norms.push(Math.sqrt(s))
}
if (dims.size !== 1) fail(`mixed dimensions in one file: ${[...dims].join(', ')}`)
const dim = [...dims][0]
if (dim !== EXPECT_DIM) fail(`dim ${dim}, expected ${EXPECT_DIM}`)
if (nonFinite) fail(`${nonFinite} non-finite components`)
if (allZero) fail(`${allZero} all-zero vectors`)
norms.sort((a, b) => a - b)
const nMin = norms[0], nMax = norms[norms.length - 1]
// Our arm is a cosine model and train.sh §5b normalizes. If these are not unit
// vectors, the corpus side (TEI, which normalizes) and the query side disagree.
if (Math.abs(nMin - 1) > 0.01 || Math.abs(nMax - 1) > 0.01) fail(`vectors are not unit-norm: min ${nMin.toFixed(4)} max ${nMax.toFixed(4)}`)
console.log(`rows ${picked.size.toLocaleString()} · dim ${dim} · norms [${nMin.toFixed(4)}, ${nMax.toFixed(4)}] · non-finite 0 · all-zero 0`)

// Write in the benchmark's own query order, so the file is comparable run to run.
const dest = join(QEMB, `${ARM}.jsonl`)
const body = [...wanted.keys()].map((qid) => JSON.stringify({ qid, v: picked.get(qid) })).join('\n') + '\n'
const digest = createHash('md5').update(body).digest('hex')

// ── the cross-arm digest guard ───────────────────────────────────────────────
// Two different encoders cannot produce identical floats over identical text.
// If they did, at most one of them is the model we think it is.
for (const f of readdirSync(QEMB)) {
  if (!f.endsWith('.jsonl') || f === `${ARM}.jsonl`) continue
  const other = createHash('md5').update(readFileSync(join(QEMB, f))).digest('hex')
  if (other === digest) fail(`byte-identical to qemb/${f} (md5 ${digest}) — two arms, one model. Refusing to write.`)
  console.log(`  distinct from qemb/${f} (${other.slice(0, 12)}… vs ${digest.slice(0, 12)}…) OK`)
}
if (existsSync(dest)) console.log(`NOTE: overwriting existing ${dest}`)
writeFileSync(dest, body)
console.log(`wrote ${dest}  md5 ${digest}`)
