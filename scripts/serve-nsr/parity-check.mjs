// parity-check.mjs — is the serve box serving the model we think it is?
//
//   ENC_URL=http://<ip>:8080/embed \
//   ENC_KEY=$(aws ssm get-parameter --region us-east-1 --name /cshl/serve/api-key \
//              --with-decryption --query Parameter.Value --output text) \
//   node scripts/serve-nsr/parity-check.mjs
//
// Run it after EVERY reweight of the box, before believing anything else.
//
// The method the report names: embed a document's EXACT indexed text through the
// LIVE endpoint and take cosine against that document's stored corpus vector.
// It must be ~1.0 against the table we intend to serve, and CLEARLY LOWER against
// the tables we do not — because a check that only confirms agreement with the
// expected table proves less than one that also shows disagreement with the wrong
// one. A wrong-model endpoint returns HTTP 200, a correctly-shaped vector and
// plausible neighbours; nothing else in the stack notices.
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'
import { recipeSql } from '../eval/recipe.mjs'

for (const l of readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
}
const sql = neon(process.env.DATABASE_URL)
const URL_ = process.env.ENC_URL, KEY = process.env.ENC_KEY
const TABLES = ['preprint_embeddings_cshl_qp', 'preprint_embeddings_cshl', 'preprint_embeddings']

const cos = (a, b) => {
  let d = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return d / (Math.sqrt(na) * Math.sqrt(nb))
}

// Deterministic sample: three papers spread across the key space, taken by the
// SAME recipe expression the corpus side used, re-derived from the DB right now
// rather than from anything cached.
const rows = await sql.query(
  `SELECT p.key_number, p.title, ${recipeSql('p')} AS text
     FROM preprints p
    WHERE p.key_number IN (
      SELECT key_number FROM preprints ORDER BY md5('parity:'||key_number) LIMIT 3)`)

console.log(`endpoint: ${URL_}`)
for (const r of rows) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: r.text, normalize: true, truncate: true }),
  })
  if (!res.ok) throw new Error(`embed ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()
  const live = Array.isArray(j[0]) ? j[0] : j
  if (live.length !== 1024) throw new Error(`dim ${live.length}, want 1024`)
  const norm = Math.sqrt(live.reduce((s, x) => s + x * x, 0))

  console.log(`\n${r.key_number}  "${String(r.title).slice(0, 66)}"`)
  console.log(`  live vector: dim ${live.length}, L2 norm ${norm.toFixed(6)}, recipe ${r.text.length} chars`)
  for (const t of TABLES) {
    const [s] = await sql.query(`SELECT embedding::text v FROM ${t} WHERE key_number = $1`, [r.key_number])
    if (!s) { console.log(`  ${t.padEnd(28)} NO ROW`); continue }
    console.log(`  ${t.padEnd(28)} cos ${cos(live, JSON.parse(s.v)).toFixed(6)}`)
  }
}
