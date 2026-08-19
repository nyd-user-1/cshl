#!/usr/bin/env node
// score-docdoc.mjs — score the frozen doc->doc benchmark.
//
// The query IS a document already in the corpus, so no encoder is needed on
// either side: we look up the query paper's STORED vector and kNN against the
// same table. That makes this benchmark free to run for every arm.
//
// The query paper is excluded from its own results. Without that every arm
// scores a perfect 1.0 by retrieving itself, which looks like a triumph.
import { neon } from '@neondatabase/serverless'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { REGISTRY, OPS } from './score.mjs'

for (const l of readFileSync('.env.local','utf8').split('\n')) { const m=l.match(/^([A-Z0-9_]+)=(.*)$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'') }
const SRC = process.env.SRC ?? 'data/mine/eval/cshl-eval-v1.docdoc.jsonl'
const N = Number(process.env.N ?? 2000)
const TOPK = Number(process.env.TOPK ?? 50)
const CONC = Number(process.env.CONC ?? 8)
const OUT = join(process.cwd(), 'data/eval/cshl-eval-docdoc/results')
mkdirSync(OUT, { recursive: true })
const sql = neon(process.env.DATABASE_URL_UNPOOLED)

// Deterministic subsample, same shape of rule the retrieval subsample uses.
const h32 = (s) => parseInt(createHash('md5').update(s).digest('hex').slice(0,8),16)/0xffffffff
let rows = readFileSync(SRC,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l))
  .map(r=>({q:r.query?.slug, pos:r.positive?.slug, fam:r.meta?.family??'DOCDOC'}))
  .filter(r=>r.q&&r.pos)
rows.sort((a,b)=>h32('docdocsample:'+a.q+':'+a.pos)-h32('docdocsample:'+b.q+':'+b.pos))
rows = rows.slice(0, N)
console.log(`doc->doc benchmark: ${rows.length} pairs (deterministic subsample of ${SRC})`)

async function pool(items, conc, fn){const out=new Array(items.length);let i=0
  await Promise.all(Array.from({length:conc},async()=>{for(;;){const k=i++;if(k>=items.length)return;out[k]=await fn(items[k])}}));return out}

const ARMS = (process.env.ARMS ?? 'bge-m3,medcpt,specter2,cshl').split(',').map(s=>s.trim()).filter(Boolean)
const ranked = {}
for (const arm of ARMS) {
  const spec = REGISTRY[arm]; if (!spec?.table) { console.log(`  skip ${arm}`); continue }
  const OP = OPS[spec.metric ?? 'cosine']
  const t0 = Date.now()
  let missing = 0
  const res = await pool(rows, CONC, async (r) => {
    let hits
    try {
      hits = await sql.query(
        `SELECT key_number FROM ${spec.table}
          WHERE key_number <> $1
          ORDER BY embedding ${OP} (SELECT embedding FROM ${spec.table} WHERE key_number = $1)
          LIMIT ${TOPK}`, [r.q])
    } catch (e) { if (missing === 0) console.log(`    first error: ${e.message}`); missing++; return null }
    if (!hits?.length) { missing++; return null }
    return { pos: r.pos, list: hits.map(h=>h.key_number) }
  })
  const ok = res.filter(Boolean)
  const at = (k)=> ok.filter(x=>x.list.slice(0,k).includes(x.pos)).length / ok.length
  const mrr = ok.reduce((s,x)=>{const i=x.list.indexOf(x.pos);return s+(i<0?0:1/(i+1))},0)/ok.length
  ranked[arm] = ok
  // per-query hit vector, so arms can be compared PAIRED rather than by
  // eyeballing two aggregate numbers with overlapping error bars.
  writeFileSync(join(OUT, `${arm}.perquery.json`),
    JSON.stringify({ arm, hits10: ok.map(x => (x.list.slice(0,10).includes(x.pos) ? 1 : 0)),
                     keys: ok.map(x => x.pos) }))
  const out = { arm, benchmark:'cshl-eval-v1.docdoc', n:ok.length, unresolved:missing,
                metric:spec.metric, table:spec.table,
                r1:+at(1).toFixed(4), r5:+at(5).toFixed(4), r10:+at(10).toFixed(4), r50:+at(50).toFixed(4),
                mrr:+mrr.toFixed(4), seconds:+((Date.now()-t0)/1000).toFixed(1) }
  writeFileSync(join(OUT, `${arm}.json`), JSON.stringify(out,null,2))
  console.log(`  ${arm.padEnd(10)} R@1 ${out.r1.toFixed(4)}  R@10 ${out.r10.toFixed(4)}  R@50 ${out.r50.toFixed(4)}  MRR ${out.mrr.toFixed(4)}  (${out.seconds}s, ${missing} unresolved)`)
}
