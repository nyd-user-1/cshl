#!/usr/bin/env node
// build-slice.mjs — carve a fair, reproducible slice of the CSHL corpus for the
// AWS Bedrock Knowledge Base head-to-head.
//
// WHY A SLICE IS DANGEROUS, AND HOW THIS ONE IS BUILT
// Retrieval difficulty scales with haystack size. Our published numbers
// (cshl_qp MeSH R@10 0.4319) are measured against all 433,449 documents. Load
// 10k into a KB, score it, and the managed service looks better than it is —
// it is solving a 43x easier problem. So the slice is a CLOSED WORLD that both
// systems must search:
//
//   queries  = N per family, taken in frozen-file order (no RNG, reproducible)
//   slice    = every gold document for those queries
//              + deterministic fill to SLICE_SIZE, ordered by md5(key_number)
//
// Our arms are then re-scored RESTRICTED TO THE SAME key_number set. Neither
// side can retrieve a document the other cannot see. Anything less and the
// comparison is decoration.
//
// Document text is `title\n\nabstract` — the exact shape our own encoders were
// trained and embedded on, so the managed embedder sees what ours saw.
//
// Env: DATABASE_URL_UNPOOLED, SLICE_SIZE (default 10000), N_PER_FAMILY (150).
import { neon } from '@neondatabase/serverless'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
}
const sql = neon(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL)
const q = (t, p = []) => sql.query(t, p)

const EVAL = process.env.EVAL_DIR ?? 'data/eval/cshl-eval-2k'
const OUT = 'data/kb-slice'
const SLICE_SIZE = Number(process.env.SLICE_SIZE ?? 10000)
const N_PER_FAMILY = Number(process.env.N_PER_FAMILY ?? 150)

// ── 1. queries: first N of each family, frozen order ────────────────────────
const allQ = readFileSync(join(EVAL, 'queries.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
const qrels = new Map()
for (const l of readFileSync(join(EVAL, 'qrels.tsv'), 'utf8').split('\n').filter(Boolean)) {
  const [qid, key] = l.split('\t')
  if (!qrels.has(qid)) qrels.set(qid, new Set())
  qrels.get(qid).add(key)
}
const byFam = new Map()
const queries = []
for (const qq of allQ) {
  const n = byFam.get(qq.family) ?? 0
  if (n >= N_PER_FAMILY) continue
  if (!qrels.has(qq.qid)) continue
  byFam.set(qq.family, n + 1)
  queries.push(qq)
}
// Pinned: the qualitative test case in hand (Vink et al.) and the papers its
// answer cited. A slice that cannot hold the example we are testing against is
// not a test bed. These are added to the slice, never to the scored qrels.
const PINNED = (process.env.PIN_KEYS ?? '2021.05.04.442622,2021.08.20.457124,2022.05.30.494039,2024.04.09.587696,274670').split(',').filter(Boolean)
const gold = new Set(queries.flatMap((qq) => [...qrels.get(qq.qid)]))
console.log(`queries: ${queries.length} (${[...byFam].map(([f, n]) => `${f}=${n}`).join(' ')}), gold docs: ${gold.size}`)

// ── 2. slice: gold + deterministic fill ─────────────────────────────────────
const goldArr = [...gold]
const present = await q(`SELECT key_number FROM preprints WHERE key_number = ANY($1)`, [goldArr])
if (present.length !== goldArr.length) {
  console.log(`WARNING: ${goldArr.length - present.length} gold docs missing from corpus — dropping their queries`)
}
const have = new Set(present.map((r) => r.key_number))
const keptQueries = queries.filter((qq) => [...qrels.get(qq.qid)].every((k) => have.has(k)))
for (const k of PINNED) have.add(k)
console.log(`pinned ${PINNED.length} qualitative-test docs into the slice`)
const fillN = Math.max(0, SLICE_SIZE - have.size)
const fill = await q(
  `SELECT key_number FROM preprints WHERE key_number <> ALL($1) AND abstract IS NOT NULL
   ORDER BY md5(key_number) LIMIT $2`, [[...have], fillN])
const slice = [...have, ...fill.map((r) => r.key_number)]
console.log(`slice: ${slice.length} docs (${have.size} gold + ${fill.length} deterministic fill)`)

// ── 3. export: one .txt + one .metadata.json per document ───────────────────
rmSync(OUT, { recursive: true, force: true })
mkdirSync(join(OUT, 'docs'), { recursive: true })
let written = 0, chars = 0
for (let i = 0; i < slice.length; i += 2000) {
  const rows = await q(
    `SELECT key_number, title, abstract, server, pub_year, published_journal, categories, doi, authors
     FROM preprints WHERE key_number = ANY($1)`, [slice.slice(i, i + 2000)])
  for (const r of rows) {
    const body = `${r.title ?? ''}\n\n${r.abstract ?? ''}`.trim()
    if (!body) continue
    const safe = r.key_number.replace(/[^\w.-]/g, '_')
    writeFileSync(join(OUT, 'docs', `${safe}.txt`), body)
    writeFileSync(join(OUT, 'docs', `${safe}.txt.metadata.json`), JSON.stringify({
      metadataAttributes: {
        key_number: { value: { type: 'STRING', stringValue: r.key_number }, includeForEmbedding: false },
        server: { value: { type: 'STRING', stringValue: r.server ?? 'unknown' }, includeForEmbedding: false },
        pub_year: { value: { type: 'NUMBER', numberValue: r.pub_year ?? 0 }, includeForEmbedding: false },
        published: { value: { type: 'BOOLEAN', booleanValue: !!r.published_journal }, includeForEmbedding: false },
      },
    }))
    written++; chars += body.length
  }
  process.stdout.write(`\r  exported ${written}/${slice.length}`)
}
console.log(`\nwrote ${written} docs, ${(chars / 1e6).toFixed(1)}M chars (~${Math.round(chars / 4 / 1000)}k tokens to embed)`)
console.log(`titan-embed-v2 cost estimate: $${((chars / 4 / 1e6) * 0.02).toFixed(3)}`)

writeFileSync(join(OUT, 'queries.jsonl'), keptQueries.map((x) => JSON.stringify(x)).join('\n') + '\n')
writeFileSync(join(OUT, 'qrels.tsv'), keptQueries.flatMap((qq) => [...qrels.get(qq.qid)].map((k) => `${qq.qid}\t${k}`)).join('\n') + '\n')
writeFileSync(join(OUT, 'slice-keys.json'), JSON.stringify(slice))
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({
  built_from: EVAL, slice_size: slice.length, gold: have.size, fill: fill.length,
  queries: keptQueries.length, n_per_family: N_PER_FAMILY,
  doc_text: 'title\\n\\nabstract', fill_order: 'md5(key_number)',
}, null, 2))
console.log(`queries kept: ${keptQueries.length} -> ${OUT}/queries.jsonl`)
