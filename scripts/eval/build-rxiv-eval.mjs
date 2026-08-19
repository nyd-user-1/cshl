#!/usr/bin/env node
// build-rxiv-eval.mjs — freeze the rxiv retrieval benchmark. Ported from
// scripts/eval/build-nsr-eval.mjs (LANE-EVAL Phase 1) at 8c1b05b.
//
// CHANGED vs the NSR original:
//   - NSR's two families were welded in (KW from nsr.sentence_groups, EX from
//     nsr_exfor). This corpus has no in-DB gold, so families are PLUGGABLE:
//     each one is a jsonl file the miner lane drops in data/mine/ (contract in
//     LANE-RIG-PORT.md REPORT §4), plus one built-in family (TITLE) that needs
//     no external data at all — so the harness is runnable the day it is
//     written instead of the day the harvest lands.
//   - segments are rxiv's: server, era (posted year band), published (has a
//     journal DOI), abstract length band. NSR's era/richness/reftype are gone.
//   - the holdout hash is over the business key, same construction; the
//     manifest now records per-family provenance + the miner file's own hash,
//     because "which harvest produced this benchmark" is the question a frozen
//     set has to answer six weeks later.
//
// Read-only against Neon; writes data/eval/cshl-eval-v1/.
// Env: DATABASE_URL_UNPOOLED. FAMILIES=TITLE,MESH,CITE,SYNTH (default: all found)
//      CENSUS=1 reports what is available and writes nothing.
import { neon } from '@neondatabase/serverless'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
}

const VERSION = process.env.EVAL_VERSION ?? 'cshl-eval-v1'
const OUT = join(process.cwd(), 'data/eval', VERSION)
const MINE = join(process.cwd(), 'data/mine')
const HOLDOUT = Number(process.env.HOLDOUT ?? 0.25)
const CAP = Number(process.env.FAMILY_CAP ?? 5000)   // per family, after holdout
const CENSUS = !!process.env.CENSUS

export const h32 = (s) => parseInt(createHash('md5').update(s).digest('hex').slice(0, 8), 16) / 0xffffffff
export const isHeldOut = (key) => h32(`holdout:${key}`) < HOLDOUT

const url = process.env.DATABASE_URL_UNPOOLED
if (!url) throw new Error('DATABASE_URL_UNPOOLED not set')
const host = url.replace(/^[^@]+@/, '').replace(/[/?].*$/, '')
if (!host.startsWith('ep-orange-water-aut2eymf.')) throw new Error(`FENCE FAIL: ${host}`)
const sql = neon(url)
const q = (t, p = []) => sql.query(t, p)

// The HTTP driver caps a response at 64MB — page by key, keyset style, exactly
// as the embed worker claims.
async function pageByKey(base, params, pageSize = 20000) {
  const out = []
  let last = ''
  for (;;) {
    const rows = await q(`${base} AND p.key_number > $${params.length + 1} ORDER BY p.key_number LIMIT $${params.length + 2}`, [...params, last, pageSize])
    if (!rows.length) break
    out.push(...rows)
    last = rows[rows.length - 1].key_number
    if (rows.length < pageSize) break
  }
  return out
}

// ── segments (rxiv's, not NSR's) ─────────────────────────────────────────────
export const era = (y) => (y == null ? 'unknown' : y < 2020 ? 'pre2020' : y < 2023 ? '2020-2022' : '2023+')
export const lenBand = (n) => (n < 1000 ? 'short' : n < 2500 ? 'medium' : 'long')
export const segmentsFor = (d) => [
  'blended', `server:${d.server}`, `era:${era(d.pub_year)}`,
  `published:${d.published ? 'yes' : 'no'}`, `abstract:${lenBand(d.abs_len)}`,
]

// ── family loaders ───────────────────────────────────────────────────────────
// Contract (LANE-MINE handoff): data/mine/<family>.jsonl, one JSON object/line:
//   { "qid": "MESH-000001", "family": "MESH", "text": "<the query string>",
//     "positives": ["<key_number>", ...], "source": "pubmed:12345", "meta": {} }
// Everything else is ignored. `positives` must be business keys of THIS corpus.
function loadMinedFamily(file) {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  const rows = []
  for (const l of lines) {
    const o = JSON.parse(l)
    if (!o.qid || !o.text || !Array.isArray(o.positives) || !o.positives.length) continue
    rows.push({ qid: o.qid, family: o.family ?? 'MINED', text: String(o.text), positives: o.positives.map(String), source: o.source ?? null })
  }
  return rows
}

// TITLE: the built-in, zero-dependency family. The title is the query, the
// paper is the answer, and the DOCUMENT the arms search is title||abstract —
// so this family is LEXICALLY LEAKED by construction and is NOT a quality
// measure. It exists to prove the harness end to end (plumbing, segments,
// metrics, arm wiring) on day zero, and as a floor: an arm that cannot find a
// paper from its own title is broken, not merely weak. Reported separately and
// never blended into a headline number.
async function buildTitleFamily(docs) {
  return docs
    .filter((d) => d.title && d.title.trim().length >= 25)
    .map((d) => ({ qid: `TITLE-${d.key_number}`, family: 'TITLE', text: d.title.trim(), positives: [d.key_number], source: 'preprints.title' }))
}

// ── stratified cap: proportional over (server, era) cells, deterministic ─────
function stratifiedSample(rows, cap, cellFn) {
  if (rows.length <= cap) return rows
  const cells = new Map()
  for (const r of rows) {
    const k = cellFn(r)
    if (!cells.has(k)) cells.set(k, [])
    cells.get(k).push(r)
  }
  for (const arr of cells.values()) arr.sort((a, b) => (h32(a.qid) - h32(b.qid)))
  const total = rows.length
  const out = []
  const quota = new Map()
  for (const [k, arr] of cells) quota.set(k, Math.min(arr.length, Math.max(1, Math.floor((arr.length / total) * cap))))
  for (const [k, arr] of cells) out.push(...arr.slice(0, quota.get(k)))
  // distribute the remainder over the cells that still have rows, largest first
  let i = 0
  const order = [...cells.keys()].sort((a, b) => cells.get(b).length - cells.get(a).length)
  while (out.length < cap) {
    const k = order[i++ % order.length]
    const arr = cells.get(k)
    const taken = quota.get(k)
    if (taken >= arr.length) { if (order.every((kk) => quota.get(kk) >= cells.get(kk).length)) break; continue }
    out.push(arr[taken]); quota.set(k, taken + 1)
  }
  return out.slice(0, cap)
}

// ── main ─────────────────────────────────────────────────────────────────────
const [{ n_total, n_embeddable }] = await q(`
  SELECT count(*)::int AS n_total,
         count(*) FILTER (WHERE length(regexp_replace(coalesce(title,'') || coalesce(abstract,''), '\\s+', '', 'g')) >= 20)::int AS n_embeddable
    FROM preprints`)
console.log(`corpus: ${n_total} rows, ${n_embeddable} embeddable`)

const docs = await pageByKey(
  `SELECT p.key_number, p.server, p.pub_year, p.title,
          (p.published_doi IS NOT NULL) AS published,
          length(coalesce(p.abstract,'')) AS abs_len
     FROM preprints p WHERE true`, [])
console.log(`loaded ${docs.length} doc rows for segmentation`)
const docBy = new Map(docs.map((d) => [d.key_number, d]))

const held = docs.filter((d) => isHeldOut(d.key_number))
console.log(`holdout: ${held.length}/${docs.length} papers (${((held.length / docs.length) * 100).toFixed(1)}%, target ${HOLDOUT * 100}%)`)

// discover families
const wanted = (process.env.FAMILIES ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const mined = existsSync(MINE) ? readdirSync(MINE).filter((f) => f.endsWith('.jsonl')) : []
console.log(`mined family files in data/mine/: ${mined.length ? mined.join(', ') : '(none yet)'}`)

let all = []
const famStats = []
const addFamily = (name, rows, source) => {
  const before = rows.length
  // every positive must be a real paper AND held out — a query whose answer the
  // trainer saw is not a measurement.
  const kept = rows
    .map((r) => ({ ...r, positives: r.positives.filter((k) => docBy.has(k) && isHeldOut(k)) }))
    .filter((r) => r.positives.length)
  const capped = stratifiedSample(kept, CAP, (r) => {
    const d = docBy.get(r.positives[0])
    return `${d.server}|${era(d.pub_year)}`
  })
  famStats.push({ family: name, source, raw: before, after_holdout: kept.length, frozen: capped.length })
  all.push(...capped)
}

if (!wanted.length || wanted.includes('TITLE')) {
  addFamily('TITLE', await buildTitleFamily(held), 'preprints.title (built-in)')
}
for (const f of mined) {
  const name = f.replace(/\.jsonl$/, '').toUpperCase()
  if (wanted.length && !wanted.includes(name)) continue
  const rows = loadMinedFamily(join(MINE, f))
  addFamily(name, rows, `data/mine/${f} md5=${createHash('md5').update(readFileSync(join(MINE, f))).digest('hex').slice(0, 12)}`)
}

console.table(famStats)

// leak audit: a query whose text appears verbatim inside its own document is
// not a retrieval measurement. NSR ran this and reported 0/0; we must too.
// (TITLE is leaked BY CONSTRUCTION and is excluded from the audit + flagged.)
const auditable = all.filter((r) => r.family !== 'TITLE')
let leaks = 0
for (let i = 0; i < auditable.length; i += 500) {
  const batch = auditable.slice(i, i + 500)
  const rows = await q(
    `SELECT count(*)::int AS n FROM unnest($1::text[], $2::text[]) AS t(k, txt)
       JOIN preprints p ON p.key_number = t.k
      WHERE position(lower(t.txt) in lower(coalesce(p.title,'') || ' ' || coalesce(p.abstract,''))) > 0`,
    [batch.map((r) => r.positives[0]), batch.map((r) => r.text)])
  leaks += rows[0].n
}
console.log(`leak audit (non-TITLE families): ${leaks}/${auditable.length} queries appear verbatim in their own document`)

if (CENSUS) { console.log('CENSUS=1 — nothing written'); process.exit(0) }
if (!all.length) { console.log('no families produced any query — nothing to freeze'); process.exit(1) }

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'queries.jsonl'), all.map((r) => {
  const d = docBy.get(r.positives[0])
  return JSON.stringify({ qid: r.qid, family: r.family, text: r.text, server: d.server, pub_year: d.pub_year, published: d.published, abs_len: d.abs_len })
}).join('\n') + '\n')
writeFileSync(join(OUT, 'qrels.tsv'), all.flatMap((r) => r.positives.map((k) => `${r.qid}\t${k}`)).join('\n') + '\n')
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({
  version: VERSION,
  frozen_at: new Date().toISOString(),
  corpus: { n_total, n_embeddable, holdout_fraction: HOLDOUT, holdout_papers: held.length },
  holdout_rule: 'md5("holdout:" || key_number) first 8 hex / 0xffffffff < HOLDOUT — split by PAPER, never by query',
  families: famStats,
  leak_audit: { audited: auditable.length, verbatim_in_own_document: leaks, note: 'TITLE excluded — leaked by construction, reported separately, never blended' },
  queries: all.length,
  qrels: all.reduce((a, r) => a + r.positives.length, 0),
}, null, 2))
console.log(`froze ${all.length} queries -> ${OUT}`)
