#!/usr/bin/env node
// score-ours.mjs — score OUR arms on the closed-world slice, so the AWS number
// has something honest to sit beside.
//
// The restriction is the whole point. Every kNN here is
//   ... FROM <arm table> WHERE key_number = ANY($slice) ORDER BY embedding <=> $q
// so our arms may only retrieve documents the managed KB can also retrieve. The
// key filter also makes the scan EXACT (10k rows, no HNSW), which if anything
// tilts slightly in our favour — S3 Vectors is approximate. Noted, not hidden.
//
// Query vectors are the FROZEN precomputed ones from data/eval/cshl-eval-2k/qemb/,
// so nothing here depends on the serve box being up or loaded with any particular
// checkpoint — and nothing here can disturb a lane that is using it.
//
// Env: ARMS (default fts,bge-m3,cshl_qp,cshl_qp2,medcpt), TOPK (50), CONC (4).
import { neon } from '@neondatabase/serverless'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
}
const sql = neon(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL)
const q = (t, p = []) => sql.query(t, p)

const SLICE = JSON.parse(readFileSync('data/kb-slice/slice-keys.json', 'utf8'))
const QUERIES = readFileSync('data/kb-slice/queries.jsonl', 'utf8').split('\n').filter(Boolean).map(JSON.parse)
const QRELS = new Map()
for (const l of readFileSync('data/kb-slice/qrels.tsv', 'utf8').split('\n').filter(Boolean)) {
  const [qid, k] = l.split('\t')
  if (!QRELS.has(qid)) QRELS.set(qid, new Set())
  QRELS.get(qid).add(k)
}
const TOPK = Number(process.env.TOPK ?? 50)
const CONC = Number(process.env.CONC ?? 4)

// same registry semantics as scripts/eval/score.mjs — cosine models use <=>,
// dot-product models (MedCPT/SPECTER2) use <#>, because scoring a dot-product
// model with cosine reports a number that is not that model's.
const ARMS = {
  fts:      { kind: 'fts' },
  'bge-m3': { table: 'preprint_embeddings',          op: '<=>', qemb: 'bge-m3' },
  cshl:     { table: 'preprint_embeddings_cshl',     op: '<=>', qemb: 'cshl' },
  cshl_qp:  { table: 'preprint_embeddings_cshl_qp',  op: '<=>', qemb: 'cshl_qp' },
  cshl_qp2: { table: 'preprint_embeddings_cshl_qp2', op: '<=>', qemb: 'cshl_qp2' },
  medcpt:   { table: 'preprint_embeddings_medcpt',   op: '<#>', qemb: 'medcpt' },
  specter2: { table: 'preprint_embeddings_specter2', op: '<#>', qemb: 'specter2' },
}

function loadQemb(name) {
  const m = new Map()
  for (const l of readFileSync(`data/eval/cshl-eval-2k/qemb/${name}.jsonl`, 'utf8').split('\n')) {
    if (!l) continue
    const d = JSON.parse(l)
    m.set(d.qid, d.v)
  }
  return m
}

async function pool(items, conc, fn) {
  const out = new Array(items.length); let i = 0
  await Promise.all(Array.from({ length: conc }, async () => {
    for (;;) { const idx = i++; if (idx >= items.length) return; out[idx] = await fn(items[idx], idx) }
  }))
  return out
}

function metrics(ranked, pos) {
  let first = Infinity
  for (let i = 0; i < ranked.length; i++) if (pos.has(ranked[i])) { first = i + 1; break }
  const rAt = (k) => (ranked.slice(0, k).some((id) => pos.has(id)) ? 1 : 0)
  const ideal = Math.min(pos.size, 10)
  const idcg = Array.from({ length: ideal }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0)
  const dcg = ranked.slice(0, 10).reduce((s, id, i) => s + (pos.has(id) ? 1 / Math.log2(i + 2) : 0), 0)
  return { r1: rAt(1), r5: rAt(5), r10: rAt(10), r50: rAt(50), mrr: Number.isFinite(first) ? 1 / first : 0, ndcg10: idcg ? dcg / idcg : 0 }
}

const requested = (process.env.ARMS ?? 'fts,bge-m3,cshl_qp,cshl_qp2,medcpt').split(',').map((s) => s.trim()).filter(Boolean)
mkdirSync('data/kb-slice/results', { recursive: true })
const summary = {}

for (const arm of requested) {
  const spec = ARMS[arm]
  if (!spec) { console.log(`skip unknown arm ${arm}`); continue }
  const t0 = Date.now()
  let perQuery
  if (spec.kind === 'fts') {
    perQuery = await pool(QUERIES, CONC, async (qq) => {
      const rows = await q(
        `SELECT key_number FROM preprints
         WHERE key_number = ANY($1) AND fts @@ websearch_to_tsquery('english', $2)
         ORDER BY ts_rank_cd(fts, websearch_to_tsquery('english', $2)) DESC LIMIT $3`,
        [SLICE, qq.text, TOPK])
      return [qq.qid, rows.map((r) => r.key_number)]
    })
  } else {
    const qemb = loadQemb(spec.qemb)
    perQuery = await pool(QUERIES, CONC, async (qq) => {
      const v = qemb.get(qq.qid)
      if (!v) return [qq.qid, []]
      const rows = await q(
        `SELECT key_number FROM ${spec.table}
         WHERE key_number = ANY($1) ORDER BY embedding ${spec.op} $2::vector LIMIT $3`,
        [SLICE, `[${v.join(',')}]`, TOPK])
      return [qq.qid, rows.map((r) => r.key_number)]
    })
  }
  const ranked = new Map(perQuery)
  const acc = {}
  for (const qq of QUERIES) {
    const m = metrics(ranked.get(qq.qid) ?? [], QRELS.get(qq.qid))
    for (const seg of ['blended', qq.family]) {
      acc[seg] ??= { n: 0, r1: 0, r5: 0, r10: 0, r50: 0, mrr: 0, ndcg10: 0 }
      acc[seg].n++
      for (const k of ['r1', 'r5', 'r10', 'r50', 'mrr', 'ndcg10']) acc[seg][k] += m[k]
    }
  }
  for (const seg of Object.keys(acc)) for (const k of ['r1', 'r5', 'r10', 'r50', 'mrr', 'ndcg10'])
    acc[seg][k] = Number((acc[seg][k] / acc[seg].n).toFixed(4))
  summary[arm] = acc
  writeFileSync(`data/kb-slice/results/${arm}.json`, JSON.stringify({ arm, segments: acc, perQuery: Object.fromEntries(ranked) }, null, 1))
  console.log(`${arm.padEnd(9)} MESH R@10 ${String(acc.MESH?.r10 ?? '-').padEnd(6)} AUTHORKW R@10 ${String(acc.AUTHORKW?.r10 ?? '-').padEnd(6)} blended ${acc.blended.r10}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
}
writeFileSync('data/kb-slice/results/ours-summary.json', JSON.stringify(summary, null, 2))
