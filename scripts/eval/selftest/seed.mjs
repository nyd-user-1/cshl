import { neon } from '@neondatabase/serverless'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
for (const l of readFileSync('.env.local','utf8').split('\n')) { const m=l.match(/^([A-Z0-9_]+)=(.*)$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'') }
const sql = neon(process.env.DATABASE_URL_UNPOOLED)
const keys = await sql.query(`SELECT key_number, server, pub_year, (published_doi IS NOT NULL) published, length(coalesce(abstract,'')) abs_len, title FROM preprints ORDER BY key_number LIMIT 60`)
// Vectors with DELIBERATELY VARYING NORMS. That is the entire point: cosine and
// inner product rank identically when every |d| is equal, so a self-test on unit
// vectors would pass no matter which operator the scorer used.
let seed = 42
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5)
const vecs = keys.map((k, i) => {
  const v = Array.from({ length: 768 }, rnd)
  const scale = 1 + (i % 5)
  return { key: k.key_number, v: v.map((x) => x * scale) }
})
const lit = (v) => '[' + v.map((x) => x.toFixed(6)).join(',') + ']'
await sql.query(`INSERT INTO preprint_embeddings_medcpt (key_number, embedding, model, text_hash)
  SELECT unnest($1::text[]), unnest($2::text[])::vector(768), 'selftest', unnest($3::text[])
  ON CONFLICT (key_number) DO UPDATE SET embedding=EXCLUDED.embedding, model='selftest'`,
  [vecs.map((x) => x.key), vecs.map((x) => lit(x.v)), vecs.map(() => 'selftest')])
const V = 'selftest-ip', dir = `data/eval/${V}`
mkdirSync(`${dir}/qemb`, { recursive: true })
writeFileSync(`${dir}/queries.jsonl`, keys.slice(0,20).map((k,i)=>JSON.stringify({qid:`Q-${i}`,family:'SELFTEST',text:k.title??'x',server:k.server,pub_year:k.pub_year,published:k.published,abs_len:k.abs_len})).join('\n')+'\n')
writeFileSync(`${dir}/qrels.tsv`, keys.slice(0,20).map((k,i)=>`Q-${i}\t${k.key_number}`).join('\n')+'\n')
writeFileSync(`${dir}/qemb/medcpt.jsonl`, vecs.slice(0,20).map((x,i)=>JSON.stringify({qid:`Q-${i}`,v:x.v.map((y)=>+y.toFixed(6))})).join('\n')+'\n')
console.log(`seeded ${vecs.length} vectors (norms 1x-5x), 20 queries -> ${dir}`)
