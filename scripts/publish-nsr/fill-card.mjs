#!/usr/bin/env node
// fill-card.mjs — fill a model card's {{PLACEHOLDER}} markers from the artifacts
// that were actually produced, never from a number someone typed in a message.
//
// Why this exists: lane-mine's point, and it is the right one — a figure quoted
// in prose goes stale the moment the thing it describes is rebuilt, and nobody
// notices because prose does not fail. manifest.json and results/*.json are
// generated at build time, so a card filled from them cannot disagree with the
// artifact it ships beside. scripts/publish-nsr/launch.sh already refuses to
// publish a card with markers left in it; this is the other half.
//
// Usage:
//   CARD=scripts/publish-nsr/cards/cshl-encoder-bge-m3.md \
//   EVAL_VERSION=cshl-eval-v1 TRAIN_NAME=parity \
//   node scripts/publish-nsr/fill-card.mjs            # writes <card> in place
//   DRY=1 ... node scripts/publish-nsr/fill-card.mjs  # report only
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { neon } from '@neondatabase/serverless'

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
}

const CARD = process.env.CARD ?? (() => { throw new Error('set CARD=<path>') })()
const VERSION = process.env.EVAL_VERSION ?? 'cshl-eval-v1'
const TRAIN_NAME = process.env.TRAIN_NAME ?? 'parity'
const EVAL_DIR = join(process.cwd(), 'data/eval', VERSION)
const RESULTS = join(EVAL_DIR, 'results')

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null)
const manifest = readJson(join(EVAL_DIR, 'manifest.json'))
const trainManifest = readJson(join(process.cwd(), 'data/train', TRAIN_NAME, 'manifest.json'))
const results = {}
if (existsSync(RESULTS)) {
  for (const f of readdirSync(RESULTS).filter((f) => f.endsWith('.json'))) {
    const r = readJson(join(RESULTS, f))
    if (r?.arm) results[r.arm] = r
  }
}

// blended = the headline segment; families are reported separately because TITLE
// is leaked by construction and must never be averaged into a headline.
const blended = (arm, family, metric) => {
  const m = results[arm]?.metrics
  if (!m) return null
  const fam = family && m[family] ? m[family] : Object.keys(m).find((k) => k !== 'TITLE')
  const v = m[fam]?.blended?.[metric]
  return v == null ? null : v.toFixed(3)
}

const FAM = process.env.HEADLINE_FAMILY ?? null
const famCount = (name) => manifest?.families?.find((f) => f.family === name)?.frozen ?? null

const values = {
  // corpus / provenance
  TOTAL_N: manifest?.corpus?.n_total?.toLocaleString(),
  TOTAL_PUBLISHED: manifest?.corpus?.published?.toLocaleString(),
  HARVEST_DATE: manifest?.frozen_at?.slice(0, 10),
  LICENSE_MIX: manifest?.corpus?.license_mix,
  // benchmark
  N_QUERIES: manifest?.queries?.toLocaleString(),
  N_QRELS: manifest?.qrels?.toLocaleString(),
  N_ARMS: Object.keys(results).length || null,
  N_LEAKS: manifest?.leak_audit?.verbatim_in_own_document,
  N_AUDITED: manifest?.leak_audit?.audited?.toLocaleString(),
  N_MESH: famCount('MESH')?.toLocaleString(),
  N_CITE: famCount('CITE')?.toLocaleString(),
  N_SYNTH: famCount('SYNTH')?.toLocaleString(),
  N_TITLE: famCount('TITLE')?.toLocaleString(),
  N_CAT: famCount('CATEGORY')?.toLocaleString(),
  // training
  N_PAIRS: trainManifest?.pairs?.toLocaleString(),
  N_NEGS: trainManifest?.negs_per_pair,
  N_GROUPS: trainManifest?.groups?.toLocaleString(),
  // arms
  FTS_R1: blended('fts', FAM, 'r1'), FTS_R10: blended('fts', FAM, 'r10'), FTS_NDCG: blended('fts', FAM, 'ndcg10'),
  BGE_R1: blended('bge-m3', FAM, 'r1'), BGE_R10: blended('bge-m3', FAM, 'r10'), BGE_NDCG: blended('bge-m3', FAM, 'ndcg10'),
  MEDCPT_R1: blended('medcpt', FAM, 'r1'), MEDCPT_R10: blended('medcpt', FAM, 'r10'), MEDCPT_NDCG: blended('medcpt', FAM, 'ndcg10'),
  SPECTER_R1: blended('specter2', FAM, 'r1'), SPECTER_R10: blended('specter2', FAM, 'r10'), SPECTER_NDCG: blended('specter2', FAM, 'ndcg10'),
  SCINCL_R1: blended('scincl', FAM, 'r1'), SCINCL_R10: blended('scincl', FAM, 'r10'), SCINCL_NDCG: blended('scincl', FAM, 'ndcg10'),
  RXIV_R1: blended('cshl', FAM, 'r1'), RXIV_R10: blended('cshl', FAM, 'r10'), RXIV_NDCG: blended('cshl', FAM, 'ndcg10'),
  CSHL_R1: blended('cshl', FAM, 'r1'), CSHL_R10: blended('cshl', FAM, 'r10'), CSHL_NDCG: blended('cshl', FAM, 'ndcg10'),
}

// Corpus provenance comes from the database, not from the benchmark manifest:
// the manifest describes a frozen SLICE, the card describes the CORPUS, and the
// card is wrong the moment those two are conflated.
try {
  const sql = neon(process.env.DATABASE_URL_UNPOOLED)
  const rows = await sql.query(`
    SELECT server, count(*)::int n, min(posted_date) lo, max(posted_date) hi,
           count(*) FILTER (WHERE published_doi IS NOT NULL)::int pub
      FROM preprints GROUP BY server ORDER BY server`)
  const lic = await sql.query(`
    SELECT count(DISTINCT license)::int kinds,
           round(100.0 * count(*) FILTER (WHERE license LIKE 'cc%') / nullif(count(*),0), 1) pct_cc
      FROM preprints`)
  let total = 0, totalPub = 0
  for (const r of rows) {
    const K = r.server === 'biorxiv' ? 'BIORXIV' : 'MEDRXIV'
    values[`${K}_N`] = r.n.toLocaleString()
    values[`${K}_RANGE`] = `${r.lo} → ${r.hi}`
    values[`${K}_PUBLISHED`] = `${r.pub.toLocaleString()} (${((r.pub / r.n) * 100).toFixed(1)}%)`
    total += r.n; totalPub += r.pub
  }
  values.TOTAL_N ??= total.toLocaleString()
  values.TOTAL_PUBLISHED ??= `${totalPub.toLocaleString()} (${((totalPub / total) * 100).toFixed(1)}%)`
  values.LICENSE_MIX ??= `${lic[0].kinds} distinct licenses, ${lic[0].pct_cc}% Creative Commons`
  values.HARVEST_DATE ??= new Date().toISOString().slice(0, 10)
} catch (e) {
  console.log(`(corpus stats unavailable: ${e.message})`)
}

let card = readFileSync(CARD, 'utf8')
const found = [...new Set([...card.matchAll(/\{\{([A-Z_0-9]+)\}\}/g)].map((m) => m[1]))]
const filled = [], missing = []
for (const key of found) {
  const v = values[key]
  if (v === null || v === undefined || v === '') { missing.push(key); continue }
  card = card.replaceAll(`{{${key}}}`, String(v))
  filled.push(`${key}=${v}`)
}
console.log(`card: ${CARD}`)
console.log(`filled ${filled.length}: ${filled.join(' ') || '(none)'}`)
if (missing.length) {
  console.log(`\nSTILL MISSING ${missing.length}: ${missing.join(', ')}`)
  console.log('These have no artifact to read yet, or need a human sentence (caveats, spend).')
  console.log('The publisher will refuse to push until they are gone — that is intended.')
}
if (!process.env.DRY) { writeFileSync(CARD, card); console.log(`\nwrote ${CARD}`) }
else console.log('\nDRY=1 — not written')
