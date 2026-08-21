import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'
for (const l of readFileSync('.env.local','utf8').split('\n')) { const m=l.match(/^([A-Z0-9_]+)=(.*)$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'') }
const sql = neon(process.env.DATABASE_URL_UNPOOLED)
const [r] = await sql`SELECT count(*)::int n, count(DISTINCT model)::int models, min(embedded_at) lo, max(embedded_at) hi FROM preprint_embeddings_cshl_qp3`
console.log(`${r.n}`)
