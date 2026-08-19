#!/usr/bin/env node
// smoke-cloudflare.mjs — LANE-RIG-PORT Task 5. Proves the entire embed pipe
// minus the GPU: input recipe -> bge-m3 (Cloudflare Workers AI, FREE tier,
// no rig, no spend) -> the worker's exact unnest/ON CONFLICT upsert ->
// pgvector -> verification -> cleanup.
//
// It writes into a SCRATCH table (default preprint_embeddings_smoke) because
// the real sidecar `preprint_embeddings` does not exist yet — sql/ belongs to
// the build lane, and inventing their DDL under them is worse than reporting
// the gap. The scratch table's schema is byte-for-byte the DDL proposed in
// LANE-RIG-PORT.md REPORT §5, so a green run here is a green run there.
//
// Env: DATABASE_URL_UNPOOLED, CF_ACCOUNT_ID, CF_AI_TOKEN (all from .env.local).
//   N=100 KEEP=1 node scripts/embed-nsr/smoke-cloudflare.mjs
// KEEP=1 skips the DROP (for inspection); default drops the scratch table.
import { neon } from '@neondatabase/serverless'
import { createHash } from 'crypto'
import { readFileSync } from 'node:fs'
import { recipeSql, CAP as CANON_CAP } from '../eval/recipe.mjs'

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
}

const EXPECT_HOST = 'ep-orange-water-aut2eymf'
const N = Number(process.env.N ?? 100)
const CAP = Number(process.env.CAP ?? CANON_CAP)
const SCRATCH = process.env.SCRATCH ?? 'preprint_embeddings_smoke'
const MODEL = 'bge-m3'
const CF_MODEL = '@cf/baai/bge-m3'

const url = process.env.DATABASE_URL_UNPOOLED
if (!url) throw new Error('DATABASE_URL_UNPOOLED not set')
const host = url.replace(/^[^@]+@/, '').replace(/[/?].*$/, '')
if (!host.startsWith(EXPECT_HOST + '.')) throw new Error(`FENCE FAIL: endpoint ${host}, expected ${EXPECT_HOST}.*`)
console.log(`db endpoint: ${host} (fence ok)`)
if (N > 100) throw new Error(`N=${N} exceeds the 100-row cap for this smoke test`)

const md5 = (s) => createHash('md5').update(s).digest('hex')
const lit = (v) => '[' + v.map((x) => x.toFixed(6)).join(',') + ']'

async function cloudflare(texts) {
  const { CF_ACCOUNT_ID, CF_AI_TOKEN } = process.env
  if (!CF_ACCOUNT_ID || !CF_AI_TOKEN) throw new Error('CF_ACCOUNT_ID / CF_AI_TOKEN not set')
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${CF_MODEL}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_AI_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: texts }),
  })
  const j = await r.json()
  if (!r.ok || !j.success || !j.result?.data) throw new Error(`cloudflare embed failed: ${r.status} ${JSON.stringify(j.errors ?? '').slice(0, 300)}`)
  return j.result.data
}

// House driver (api/search.ts, scripts/eval/score.mjs): neon() HTTP against the
// unpooled string. `pg` is only present on the GPU box, not in this repo.
const sql = neon(url)
const c = { query: async (text, params = []) => ({ rows: await sql.query(text, params) }) }

try {
  // 1. scratch sidecar, exactly the proposed DDL (name aside)
  await c.query(`
    CREATE TABLE IF NOT EXISTS ${SCRATCH} (
      key_number  text PRIMARY KEY REFERENCES preprints(key_number),
      embedding   vector(1024) NOT NULL,
      model       text NOT NULL DEFAULT 'bge-m3',
      text_hash   text NOT NULL,
      embedded_at timestamptz NOT NULL DEFAULT now()
    )`)
  console.log(`scratch table ${SCRATCH} ready`)

  // 2. claim rows with the worker's exact page query (resume predicate included)
  const { rows } = await c.query(
    `SELECT p.key_number AS id,
            ${recipeSql('p', CAP)} AS text
       FROM preprints p LEFT JOIN ${SCRATCH} e ON e.key_number = p.key_number
      WHERE e.key_number IS NULL AND p.key_number > $1 AND ($3::text IS NULL OR p.key_number <= $3)
        AND length(regexp_replace(coalesce(p.title,'') || coalesce(p.abstract,''), '\\s+', '', 'g')) >= 20
      ORDER BY p.key_number LIMIT $2`,
    ['', N, null],
  )
  console.log(`claimed ${rows.length} rows; input chars min/mean/max = ${Math.min(...rows.map(r=>r.text.length))}/${Math.round(rows.reduce((a,r)=>a+r.text.length,0)/rows.length)}/${Math.max(...rows.map(r=>r.text.length))}`)

  // 3. embed (Cloudflare batches of 10 — free tier, ~1 neuron-batch per call)
  const done = []
  const t0 = Date.now()
  for (let i = 0; i < rows.length; i += 10) {
    const slice = rows.slice(i, i + 10)
    const vecs = await cloudflare(slice.map((r) => r.text))
    slice.forEach((r, j) => done.push({ id: r.id, emb: lit(vecs[j]), hash: md5(r.text) }))
  }
  console.log(`embedded ${done.length} texts in ${((Date.now() - t0) / 1000).toFixed(1)}s (cloudflare free tier, $0)`)

  // 4. the worker's exact upsert, run twice — idempotency is part of the pipe
  const upd = `INSERT INTO ${SCRATCH} (key_number, embedding, model, text_hash)
               SELECT unnest($1::text[]), unnest($2::text[])::vector(1024), $4::text, unnest($3::text[])
                   ON CONFLICT (key_number) DO UPDATE
                  SET embedding = EXCLUDED.embedding, model = EXCLUDED.model,
                      text_hash = EXCLUDED.text_hash, embedded_at = now()`
  const args = [done.map((d) => d.id), done.map((d) => d.emb), done.map((d) => d.hash), MODEL]
  await c.query(upd, args)
  await c.query(upd, args) // second pass must not duplicate
  console.log('upsert ran twice (idempotency check)')

  // 5. verify
  const keys = done.map((d) => d.id)
  const [v] = (await c.query(`
    SELECT count(*)::int                                   AS n,
           count(DISTINCT key_number)::int                 AS distinct_keys,
           min(vector_dims(embedding))::int                AS min_dims,
           max(vector_dims(embedding))::int                AS max_dims,
           count(*) FILTER (WHERE model = '${MODEL}')::int  AS model_ok,
           count(*) FILTER (WHERE text_hash ~ '^[0-9a-f]{32}$')::int AS hash_shape_ok,
           count(*) FILTER (WHERE embedded_at IS NULL)::int AS null_embedded_at,
           round(min(vector_norm(embedding))::numeric, 5)      AS min_norm,
           round(max(vector_norm(embedding))::numeric, 5)      AS max_norm,
           count(*) FILTER (WHERE vector_norm(embedding) = 0)::int AS zero_vectors
      FROM ${SCRATCH} WHERE key_number = ANY($1)`, [keys])).rows
  console.log('verification:', JSON.stringify(v))

  // hash parity: the DB's text_hash must equal md5 of the DB's own recipe output
  const [{ hash_mismatches }] = (await c.query(`
    SELECT count(*)::int AS hash_mismatches
      FROM ${SCRATCH} e JOIN preprints p USING (key_number)
     WHERE e.key_number = ANY($1)
       AND e.text_hash <> md5(${recipeSql('p', CAP)})`, [keys])).rows
  console.log(`text_hash parity vs the SQL recipe: ${hash_mismatches} mismatches`)

  // resume predicate: these keys must no longer claim
  const [{ still_claimable }] = (await c.query(`
    SELECT count(*)::int AS still_claimable
      FROM preprints p JOIN ${SCRATCH} e ON e.key_number = p.key_number
      LEFT JOIN ${SCRATCH} x ON x.key_number = p.key_number
     WHERE x.key_number IS NULL`)).rows
  console.log(`resume predicate: ${still_claimable} embedded rows still claimable (want 0)`)

  // kNN sanity: a self-query must return itself first
  const [probe] = (await c.query(`SELECT key_number, embedding::text AS emb FROM ${SCRATCH} LIMIT 1`)).rows
  const knn = await c.query(`SELECT key_number, (embedding <=> $1::vector) AS d FROM ${SCRATCH} ORDER BY embedding <=> $1::vector LIMIT 3`, [probe.emb])
  console.log(`kNN self-probe: top1=${knn.rows[0].key_number} d=${Number(knn.rows[0].d).toFixed(6)} (self=${probe.key_number}) next_d=${Number(knn.rows[1].d).toFixed(4)}`)

  const pass = v.n === done.length && v.min_dims === 1024 && v.max_dims === 1024 &&
    v.model_ok === v.n && v.hash_shape_ok === v.n && v.zero_vectors === 0 &&
    Number(hash_mismatches) === 0 && Number(still_claimable) === 0 &&
    knn.rows[0].key_number === probe.key_number
  console.log(pass ? 'SMOKE PASS' : 'SMOKE FAIL')

  // 6. cleanup
  if (process.env.KEEP) {
    console.log(`KEEP=1 — leaving ${SCRATCH} in place`)
  } else {
    const before = (await c.query(`SELECT count(*)::int AS n FROM ${SCRATCH}`)).rows[0].n
    await c.query(`DROP TABLE ${SCRATCH}`)
    const [{ gone }] = (await c.query(`SELECT (to_regclass('${SCRATCH}') IS NULL) AS gone`)).rows
    console.log(`cleanup: deleted ${before} test rows, dropped ${SCRATCH} (gone=${gone})`)
  }
  process.exit(pass ? 0 : 1)
} catch (e) {
  console.error('SMOKE ERROR:', e.message)
  process.exit(1)
}
