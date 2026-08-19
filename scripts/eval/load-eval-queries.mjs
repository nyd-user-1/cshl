#!/usr/bin/env node
// load-eval-queries.mjs — load data/eval/nsr-eval-v1/queries.jsonl into
// nsr_eval_queries (idempotent upsert, no embedding touched). Read+write,
// but writes only qid/family/text — the frozen query set itself.
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

async function main() {
  if (!process.env.DATABASE_URL_UNPOOLED) throw new Error('DATABASE_URL_UNPOOLED not set')
  const sql = neon(process.env.DATABASE_URL_UNPOOLED)
  const lines = readFileSync(join(process.cwd(), 'data/eval/nsr-eval-v1/queries.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))
  console.log(`Loading ${lines.length} frozen queries...`)
  const BATCH = 1000
  let loaded = 0
  for (let i = 0; i < lines.length; i += BATCH) {
    const batch = lines.slice(i, i + BATCH)
    await sql.query(
      `INSERT INTO nsr_eval_queries (qid, family, text)
       SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::text[])
       ON CONFLICT (qid) DO UPDATE SET family = EXCLUDED.family, text = EXCLUDED.text`,
      [batch.map((r) => r.qid), batch.map((r) => r.family), batch.map((r) => r.text)]
    )
    loaded += batch.length
    console.log(`  ${loaded}/${lines.length}`)
  }
  const [{ n }] = await sql.query(`SELECT count(*)::int AS n FROM nsr_eval_queries`)
  console.log(`nsr_eval_queries row count: ${n}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
