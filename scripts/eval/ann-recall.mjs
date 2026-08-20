// Is hnsw.ef_search=100 costing us recall? Measure the ANN approximation
// directly instead of re-scoring: for a sample of queries, compare the top-10
// the scorer sees at ef=100 against the top-10 at ef=1000. If they agree, the
// index is not what separates us from MedCPT and the published numbers are not
// depressed by it. Done for OUR arm and MedCPT both, because a check applied to
// one arm only cannot tell you about a gap between two.
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REGISTRY, OPS } from './score.mjs'
const ROOT = '/Users/brendanstanton/Code/cshl'
for (const l of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '') }
const sql = neon(process.env.DATABASE_URL_UNPOOLED)
const N = Number(process.env.N ?? 150)
const HI = Number(process.env.HI ?? 1000)
const V = 'cshl-eval-2k'
const queries = readFileSync(join(ROOT, 'data/eval', V, 'queries.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).slice(0, N)
for (const arm of (process.env.ARMS ?? 'cshl_qp,medcpt').split(',')) {
  const spec = REGISTRY[arm], OP = OPS[spec.metric]
  const emb = new Map()
  for (const l of readFileSync(join(ROOT, 'data/eval', V, 'qemb', `${arm}.jsonl`), 'utf8').split('\n').filter(Boolean)) { const o = JSON.parse(l); emb.set(o.qid, `[${o.v.join(',')}]`) }
  let sameTop10 = 0, overlapSum = 0, rank1Same = 0, n = 0
  for (const q of queries) {
    const v = emb.get(q.qid); if (!v) continue
    const get = async (ef) => (await sql.transaction([
      sql.query(`SET LOCAL hnsw.ef_search = ${ef}`),
      sql.query(`SELECT key_number FROM ${spec.table} ORDER BY embedding ${OP} $1::vector LIMIT 10`, [v]),
    ]))[1].map(r => r.key_number)
    const lo = await get(100), hi = await get(HI)
    const ov = lo.filter(k => hi.includes(k)).length
    overlapSum += ov; if (ov === 10) sameTop10++; if (lo[0] === hi[0]) rank1Same++; n++
  }
  console.log(`${arm.padEnd(8)} n=${n}  top-10 identical ${sameTop10}/${n}  mean overlap ${(overlapSum/n/10*100).toFixed(1)}%  rank-1 identical ${rank1Same}/${n}   (ef 100 vs ${HI})`)
}
