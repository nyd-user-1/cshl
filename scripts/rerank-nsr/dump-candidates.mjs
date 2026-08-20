#!/usr/bin/env node
// dump-candidates.mjs — freeze an encoder arm's top-K lists + the candidate text,
// so the reranker can be scored on a GPU box that never touches the database.
//
// LANE-RERANK G5: `<arm>.perquery.json` carries {arm,version,keys,family,hits10}
// and NO candidate lists, so "rerank cshl-QP's top-50" has nothing to read. This
// regenerates them with the SAME query score.mjs:runDense uses — same operator
// from the registry's `metric`, same ef_search, same TOPK — because a reranker
// scored over a differently-retrieved pool is not measuring reranking.
//
// DOC_CHARS=900 matches the SERVING slice (api/_lib/embed.ts rerank()) and the
// training converter. Same text budget in training, scoring and serving, or the
// number does not transfer.
//
// Out: <out>/<arm>.lists.json      {arm, version, topk, metric, qids[], lists[][]}
//      <out>/docs-<DOC_CHARS>.jsonl  {key, text} — deduped across arms. The width is IN
//      the filename on purpose: two arms sharing a docs file at different truncations
//      would be an unfair comparison that nothing downstream could detect.
// Usage: ARM=cshl_qp EVAL_VERSION=cshl-eval-2k node scripts/rerank-nsr/dump-candidates.mjs
import { neon } from '@neondatabase/serverless'
import { readFileSync, writeFileSync, mkdirSync, existsSync, createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { REGISTRY, OPS } from '../eval/score.mjs'

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
}
const ARM = process.env.ARM ?? 'cshl_qp'
const VERSION = process.env.EVAL_VERSION ?? 'cshl-eval-2k'
const ROOT = join(process.cwd(), 'data/eval', VERSION)
const OUT = process.env.OUT ?? join(process.cwd(), 'data/reranker/eval', VERSION)
const TOPK = Number(process.env.TOPK ?? 50)
const CONC = Number(process.env.CONC ?? 12)
const DOC_CHARS = Number(process.env.DOC_CHARS ?? 900)
const DOCS = process.env.DOCS ?? `docs-${DOC_CHARS}.jsonl`
const SKIP_RETRIEVE = process.env.SKIP_RETRIEVE === '1'
const EF = Number(process.env.EF_SEARCH ?? 100)

const spec = REGISTRY[ARM]
if (!spec || spec.kind !== 'dense') throw new Error(`arm '${ARM}' is not a dense arm in score.mjs's registry`)
const OP = OPS[spec.metric ?? 'cosine']
const sql = neon(process.env.DATABASE_URL_UNPOOLED)

const queries = readFileSync(join(ROOT, 'queries.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const emb = new Map()
for (const l of readFileSync(join(ROOT, 'qemb', `${ARM}.jsonl`), 'utf8').split('\n').filter(Boolean)) {
  const o = JSON.parse(l); emb.set(o.qid, `[${o.v.join(',')}]`)
}
console.log(`${ARM}: ${queries.length} queries, ${emb.size} query vectors, table ${spec.table}, metric ${spec.metric} ${OP}`)

// Same index-scan proof score.mjs prints — a seq scan here would silently
// change the pool and every downstream delta with it.
const probe = queries.find((qq) => emb.has(qq.qid))
const plan = await sql.query(`EXPLAIN SELECT key_number FROM ${spec.table} ORDER BY embedding ${OP} $1::vector LIMIT ${TOPK}`, [emb.get(probe.qid)])
const ptext = plan.map((r) => Object.values(r)[0]).join(' | ').replace(/'\[[^\]]*\]'::vector/g, "'<vec>'::vector")
const indexScan = ptext.includes('Index Scan')
console.log(`  plan: ${indexScan ? 'Index Scan CONFIRMED' : 'NO Index Scan — ' + ptext.slice(0, 200)}`)
// REFUSE, don't warn. A sequential scan returns EXACT nearest neighbours, while
// every other arm's pool was built by HNSW at ef_search=100 and loses ~3% of its
// top-10 slots to the approximation (measured by the win lane). Mixing the two
// silently hands whichever arm skipped the index a better pool — a bug that
// would flatter a result and leave no trace in the output. Wait for the index.
if (!indexScan && process.env.ALLOW_SEQ_SCAN !== '1') {
  console.error(`REFUSING: ${spec.table} has no usable vector index yet, so this pool would be exact kNN while every other arm's is ANN at ef_search=${EF}. Build the index first (or set ALLOW_SEQ_SCAN=1 if you truly want an incomparable pool).`)
  process.exit(3)
}

async function pool(items, conc, fn) {
  const out = new Array(items.length); let i = 0
  await Promise.all(Array.from({ length: conc }, async () => {
    for (;;) { const idx = i++; if (idx >= items.length) return; out[idx] = await fn(items[idx], idx) }
  }))
  return out
}
const withRetry = async (fn, tries = 4) => {
  for (let a = 1; ; a++) { try { return await fn() } catch (e) { if (a >= tries) throw e; await new Promise((r) => setTimeout(r, 300 * a)) } }
}

const lists = new Map()
let done = 0
const listsPath = join(OUT, `${ARM}.lists.json`)
if (SKIP_RETRIEVE && existsSync(listsPath)) {
  const prev = JSON.parse(readFileSync(listsPath, 'utf8'))
  if (prev.topk !== TOPK || prev.metric !== spec.metric || prev.ef_search !== EF) {
    throw new Error(`SKIP_RETRIEVE=1 but ${listsPath} was built with different retrieval settings — refusing to reuse it`)
  }
  prev.qids.forEach((id, i) => lists.set(id, prev.lists[i]))
  console.log(`  SKIP_RETRIEVE=1 — reusing ${lists.size} lists from ${listsPath} (topk/metric/ef verified identical)`)
} else await pool(queries, CONC, async (qq) => {
  const v = emb.get(qq.qid); if (!v) return
  const res = await withRetry(() => sql.transaction([
    sql.query(`SET LOCAL hnsw.ef_search = ${EF}`),
    sql.query(`SELECT key_number FROM ${spec.table} ORDER BY embedding ${OP} $1::vector LIMIT ${TOPK}`, [v]),
  ]))
  lists.set(qq.qid, res[1].map((r) => r.key_number))
  if (++done % 250 === 0) console.log(`  retrieved ${done}/${queries.length}`)
})

const qids = queries.filter((qq) => lists.has(qq.qid)).map((qq) => qq.qid)
const short = qids.filter((id) => lists.get(id).length < TOPK).length
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, `${ARM}.lists.json`), JSON.stringify({
  arm: ARM, version: VERSION, topk: TOPK, metric: spec.metric, table: spec.table,
  ef_search: EF, doc_chars: DOC_CHARS, built_at: new Date().toISOString(),
  qids, family: qids.map((id) => queries.find((qq) => qq.qid === id).family),
  query_text: qids.map((id) => queries.find((qq) => qq.qid === id).text),
  lists: qids.map((id) => lists.get(id)),
}))
console.log(`wrote ${OUT}/${ARM}.lists.json — ${qids.length} queries, ${short} shorter than top-${TOPK}`)

// Candidate text, deduped across arms so a second arm's dump appends nothing new.
const seen = new Set()
if (existsSync(join(OUT, DOCS))) {
  for (const l of readFileSync(join(OUT, DOCS), 'utf8').split('\n')) { if (l) seen.add(JSON.parse(l).key) }
  console.log(`  `+DOCS+` already has ${seen.size} keys — appending only what is new`)
}
const need = [...new Set([...lists.values()].flat())].filter((k) => !seen.has(k))
console.log(`  ${need.length} new candidate documents to resolve`)
const ws = createWriteStream(join(OUT, DOCS), { flags: 'a' })
let wrote = 0
for (let i = 0; i < need.length; i += 5000) {
  const batch = need.slice(i, i + 5000)
  const got = await withRetry(() => sql.query(
    `SELECT key_number, left(trim(coalesce(title,'') || E'\n\n' || coalesce(abstract,'')), ${DOC_CHARS}) AS t FROM preprints WHERE key_number = ANY($1)`, [batch]))
  for (const g of got) { ws.write(JSON.stringify({ key: g.key_number, text: g.t }) + '\n'); wrote++ }
  console.log(`  resolved ${Math.min(i + 5000, need.length)}/${need.length}`)
}
ws.end()
console.log(`wrote ${wrote} documents -> ${OUT}/${DOCS} (${wrote}/${need.length} resolved)`)
