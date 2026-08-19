#!/usr/bin/env node
// import-frozen.mjs — convert lane-mine's frozen cshl-eval-v1 retrieval set into
// the harness format (queries.jsonl + qrels.tsv + manifest.json).
//
// Their rows are self-contained (embed_text inlined) so the benchmark is
// publishable on its own; the harness only needs the query, the gold key, and
// the segment fields. Segments come from the DATABASE rather than from their
// file, because segments are properties of the corpus and I'd rather two lanes
// disagree loudly than silently share a stale copy.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { neon } from '@neondatabase/serverless'
for (const l of readFileSync('.env.local','utf8').split('\n')) { const m=l.match(/^([A-Z0-9_]+)=(.*)$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'') }
const SRC = process.env.SRC ?? 'data/mine/eval/cshl-eval-v1.retrieval.jsonl'
const VERSION = process.env.EVAL_VERSION ?? 'cshl-eval-v1'
const OUT = join(process.cwd(), 'data/eval', VERSION)
mkdirSync(OUT, { recursive: true })
const sql = neon(process.env.DATABASE_URL_UNPOOLED)

const rows = readFileSync(SRC, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
console.log(`${rows.length} frozen retrieval rows from ${SRC}`)

const keys = [...new Set(rows.map((r) => r.positive?.slug).filter(Boolean))]
const meta = new Map()
for (let i = 0; i < keys.length; i += 5000) {
  const got = await sql.query(
    `SELECT key_number, server, pub_year, (published_doi IS NOT NULL) published,
            length(coalesce(abstract,'')) abs_len
       FROM preprints WHERE key_number = ANY($1)`, [keys.slice(i, i + 5000)])
  for (const g of got) meta.set(g.key_number, g)
}
console.log(`resolved ${meta.size}/${keys.length} gold keys against the live corpus`)
const missing = keys.filter((k) => !meta.has(k))
if (missing.length) console.log(`WARNING ${missing.length} gold keys are not in preprints — e.g. ${missing.slice(0,3).join(', ')}`)

const fam = {}
const q = [], qrels = []
rows.forEach((r, i) => {
  const k = r.positive?.slug
  const m = meta.get(k)
  if (!k || !m || !r.query) return
  const family = (r.meta?.family ?? r.family ?? 'RETRIEVAL').toUpperCase()
  fam[family] = (fam[family] ?? 0) + 1
  const qid = `${family}-${String(i).padStart(6, '0')}`
  q.push(JSON.stringify({ qid, family, text: String(r.query), server: m.server, pub_year: m.pub_year, published: m.published, abs_len: m.abs_len }))
  qrels.push(`${qid}\t${k}`)
})
writeFileSync(join(OUT, 'queries.jsonl'), q.join('\n') + '\n')
writeFileSync(join(OUT, 'qrels.tsv'), qrels.join('\n') + '\n')
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({
  version: VERSION, imported_at: new Date().toISOString(), source: SRC,
  source_manifest: 'data/mine/eval/manifest.json (lane-mine, FROZEN)',
  queries: q.length, qrels: qrels.length, families: fam,
  gold_keys_resolved: meta.size, gold_keys_missing: missing.length,
}, null, 2))
console.log(`families: ${JSON.stringify(fam)}`)
console.log(`wrote ${q.length} queries -> ${OUT}`)
