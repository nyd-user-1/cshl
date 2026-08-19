// Does the scorer's per-arm metric actually change the ranking? Build a case
// where cosine and inner product MUST disagree, then assert each picks its own
// winner. A test where they agree proves the plumbing, not the choice.
import { neon } from '@neondatabase/serverless'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
for (const l of readFileSync('.env.local','utf8').split('\n')) { const m=l.match(/^([A-Z0-9_]+)=(.*)$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'') }
const sql = neon(process.env.DATABASE_URL_UNPOOLED)
const keys = (await sql.query(`SELECT key_number FROM preprints ORDER BY key_number LIMIT 2`)).map(r=>r.key_number)
const D = 768
const unit = (i) => Array.from({length:D},(_,j)=> j===i?1:0)
// query points exactly along axis 0.
const q = unit(0)
// A: perfectly aligned, norm 1        -> cosine 1.00, ip 1.0
// B: 45 deg off, norm 5               -> cosine 0.707, ip 3.54
const A = unit(0)
const B = Array.from({length:D},(_,j)=> j===0?5*Math.SQRT1_2 : (j===1?5*Math.SQRT1_2:0))
const lit = v => '[' + v.map(x=>x.toFixed(6)).join(',') + ']'
await sql.query(`INSERT INTO preprint_embeddings_medcpt (key_number, embedding, model, text_hash)
  SELECT unnest($1::text[]), unnest($2::text[])::vector(768), 'selftest', 'selftest'
  ON CONFLICT (key_number) DO UPDATE SET embedding=EXCLUDED.embedding, model='selftest'`,
  [[keys[0],keys[1]], [lit(A), lit(B)]])
console.log(`A=${keys[0]} (aligned, |A|=1)   B=${keys[1]} (45deg, |B|=5)`)
const r = await sql.query(`SELECT key_number,
    round((embedding <=> $1::vector)::numeric,4) cos_dist,
    round((embedding <#> $1::vector)::numeric,4) ip_neg
  FROM preprint_embeddings_medcpt WHERE model='selftest' ORDER BY key_number`, [lit(q)])
console.table(r)
const byCos = [...r].sort((a,b)=>a.cos_dist-b.cos_dist)[0].key_number
const byIp  = [...r].sort((a,b)=>a.ip_neg-b.ip_neg)[0].key_number
console.log(`cosine winner: ${byCos}${byCos===keys[0]?'  (A, correct)':'  (B)'}`)
console.log(`ip     winner: ${byIp}${byIp===keys[1]?'  (B, correct)':'  (A)'}`)
console.log(byCos !== byIp ? 'DISCRIMINATES: the operator changes the answer.' : 'FAIL: operators agree — test is not discriminating')
await sql.query(`DELETE FROM preprint_embeddings_medcpt WHERE model='selftest'`)
console.log('cleaned up')
