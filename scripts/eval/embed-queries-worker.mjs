// embed-queries-worker.mjs — LANE-EVAL Phase 2. Runs ON a GPU box beside a
// local TEI (bge-m3) server, adapted (surgically) from
// scripts/embed-nsr/worker.mjs for the small nsr_eval_queries table: a plain
// UPDATE instead of the corpus's sidecar INSERT, no lane/boundary splitting
// (~10k rows, one box, one pass). Resume-safe: claims WHERE embedding IS NULL.
import pg from 'pg'

const TEI = process.env.TEI ?? 'http://127.0.0.1:8080'
const PAGE = Number(process.env.PAGE ?? 1024)
const CHUNK = 128
const CONC = 4

async function mkClient() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  c.on('error', (e) => console.error(`pg client error (background): ${e.message}`))
  await c.connect()
  return c
}

async function tei(texts) {
  const r = await fetch(`${TEI}/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputs: texts, truncate: true }),
  })
  if (!r.ok) throw new Error(`TEI ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

const lit = (v) => '[' + v.map((x) => x.toFixed(6)).join(',') + ']'

async function embedOne(slice, out) {
  try {
    const vecs = await tei(slice.map((r) => r.text))
    slice.forEach((r, j) => out.push({ qid: r.qid, emb: lit(vecs[j]) }))
  } catch (e) {
    console.error(`chunk failed (${e.message}) — retrying per-item`)
    for (const r of slice) {
      try {
        const [v] = await tei([r.text])
        out.push({ qid: r.qid, emb: lit(v) })
      } catch (e2) {
        console.error(`  skip ${r.qid}: ${e2.message}`)
      }
    }
  }
}

async function embedBatch(rows) {
  const out = []
  const chunks = []
  for (let i = 0; i < rows.length; i += CHUNK) chunks.push(rows.slice(i, i + CHUNK))
  for (let i = 0; i < chunks.length; i += CONC) {
    await Promise.all(chunks.slice(i, i + CONC).map((c) => embedOne(c, out)))
  }
  return out
}

async function main() {
  let conn = await mkClient()
  let grand = 0
  const t0 = Date.now()
  for (;;) {
    let rows
    for (let a = 1; ; a++) {
      try {
        ;({ rows } = await conn.query(
          `SELECT qid, text FROM nsr_eval_queries WHERE embedding IS NULL ORDER BY qid LIMIT $1`,
          [PAGE]
        ))
        break
      } catch (e) {
        if (a >= 5) throw e
        console.error(`read error (${e.message}) — reconnecting (${a}/5)`)
        try { await conn.end() } catch {}
        await new Promise((r) => setTimeout(r, 2000 * a))
        conn = await mkClient()
      }
    }
    if (!rows.length) break
    const prepped = rows.map((r) => ({ qid: r.qid, text: (r.text || '').trim() })).filter((r) => r.text.length >= 3)
    const done = await embedBatch(prepped)
    for (let i = 0; i < done.length; i += 1024) {
      const sl = done.slice(i, i + 1024)
      for (let a = 1; ; a++) {
        try {
          await conn.query(
            `UPDATE nsr_eval_queries q SET embedding = d.emb::vector(1024), embedded_at = now()
             FROM (SELECT unnest($1::text[]) AS qid, unnest($2::text[]) AS emb) d
             WHERE q.qid = d.qid`,
            [sl.map((d) => d.qid), sl.map((d) => d.emb)]
          )
          break
        } catch (e) {
          if (a >= 5) throw e
          console.error(`write error (${e.message}) — reconnecting (${a}/5)`)
          try { await conn.end() } catch {}
          await new Promise((r) => setTimeout(r, 2000 * a))
          conn = await mkClient()
        }
      }
      grand += sl.length
    }
    console.log(`${grand} rows (${(grand / ((Date.now() - t0) / 1000)).toFixed(0)}/s)`)
  }
  console.log(`ALL DONE: ${grand} rows in ${((Date.now() - t0) / 60000).toFixed(1)} min`)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
