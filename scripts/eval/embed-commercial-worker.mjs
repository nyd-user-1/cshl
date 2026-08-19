// embed-commercial-worker.mjs — LANE-EVAL Phase 3 Arm C. Runs on a small
// (non-GPU) EC2 box under the nsr-embed role: embeds the full corpus +
// eval queries via Cohere embed-v4 on Bedrock (us-east-1, in-region).
// input_type: search_document for corpus rows, search_query for queries —
// a mismatch here silently degrades the arm (LANE-EVAL brief, Phase 3 Arm C).
// Checkpointed by construction: each batch write commits immediately, so a
// death only costs the in-flight batch. Never run the corpus side from the
// laptop (brief, Phase 3 Arm C).
import pg from 'pg'
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'

const REGION = 'us-east-1'
const MODEL = 'cohere.embed-v4:0'
const PAGE = Number(process.env.PAGE ?? 480)
const BATCH = 96 // Cohere Bedrock max texts/call
const CAP = 2000 // chars per input, matches the corpus embed recipe
// Measured live (2026-08-17): CONC=5 hammered the account's tokens-per-minute
// quota into a synchronized "Too many tokens" retry storm. Serial calls with
// jittered backoff are the sustainable rate for this account.
const CONC = Number(process.env.CONC ?? 1)

const bedrock = new BedrockRuntimeClient({ region: REGION })

async function mkClient() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  c.on('error', (e) => console.error(`pg client error (background): ${e.message}`))
  await c.connect()
  return c
}

async function cohereEmbed(texts, inputType) {
  for (let a = 1; ; a++) {
    try {
      const res = await bedrock.send(new InvokeModelCommand({
        modelId: MODEL,
        body: JSON.stringify({ texts, input_type: inputType, embedding_types: ['float'] }),
      }))
      const body = JSON.parse(Buffer.from(res.body).toString('utf8'))
      const vecs = body.embeddings?.float
      if (!Array.isArray(vecs) || vecs.length !== texts.length) throw new Error('unexpected embed response shape')
      return vecs
    } catch (e) {
      if (a >= 8) throw e
      const wait = Math.min(30000, 3000 * 2 ** a) + Math.floor(Math.random() * 1000)
      console.error(`bedrock call failed (${e.message}) — retry ${a}/8 in ${wait}ms`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}

const lit = (v) => '[' + v.map((x) => x.toFixed(6)).join(',') + ']'

async function embedRows(rows, inputType) {
  const out = []
  const chunks = []
  for (let i = 0; i < rows.length; i += BATCH) chunks.push(rows.slice(i, i + BATCH))
  for (let i = 0; i < chunks.length; i += CONC) {
    const slice = chunks.slice(i, i + CONC)
    const results = await Promise.all(slice.map(async (c) => {
      try {
        const vecs = await cohereEmbed(c.map((r) => r.text), inputType)
        return c.map((r, j) => ({ id: r.id, emb: lit(vecs[j]) }))
      } catch (e) {
        console.error(`batch permanently failed (${e.message}) — retrying per-item`)
        const singles = []
        for (const r of c) {
          try {
            const [v] = await cohereEmbed([r.text], inputType)
            singles.push({ id: r.id, emb: lit(v) })
          } catch (e2) {
            console.error(`  skip ${r.id}: ${e2.message}`)
          }
        }
        return singles
      }
    }))
    out.push(...results.flat())
  }
  return out
}

async function runCorpus(conn) {
  console.log('=== corpus side: nsr -> nsr_embeddings_commercial ===')
  let grand = 0
  const t0 = Date.now()
  for (;;) {
    const { rows } = await conn.query(
      `SELECT n.key_number AS id,
              left(trim(coalesce(n.title,'') || E'\n\n' || coalesce(n.abstract,'')), ${CAP}) AS text
         FROM nsr n LEFT JOIN nsr_embeddings_commercial c ON c.key_number = n.key_number
        WHERE c.key_number IS NULL
          AND length(regexp_replace(coalesce(n.title,'') || coalesce(n.abstract,''), '\\s+', '', 'g')) >= 20
        ORDER BY n.key_number LIMIT $1`,
      [PAGE]
    )
    if (!rows.length) break
    const prepped = rows.map((r) => ({ id: r.id, text: (r.text || '').trim() })).filter((r) => r.text.length >= 3)
    const done = await embedRows(prepped, 'search_document')
    for (let i = 0; i < done.length; i += 500) {
      const sl = done.slice(i, i + 500)
      await conn.query(
        `INSERT INTO nsr_embeddings_commercial (key_number, embedding, embedded_at)
         SELECT unnest($1::text[]), unnest($2::text[])::vector(1536), now()
             ON CONFLICT (key_number) DO UPDATE SET embedding = EXCLUDED.embedding, embedded_at = now()`,
        [sl.map((d) => d.id), sl.map((d) => d.emb)]
      )
      grand += sl.length
    }
    console.log(`corpus: ${grand} rows (${(grand / ((Date.now() - t0) / 1000)).toFixed(1)}/s)`)
  }
  console.log(`corpus DONE: ${grand} rows in ${((Date.now() - t0) / 60000).toFixed(1)} min`)
}

async function runQueries(conn) {
  console.log('=== query side: nsr_eval_queries.embedding_commercial ===')
  let grand = 0
  const t0 = Date.now()
  for (;;) {
    const { rows } = await conn.query(
      `SELECT qid AS id, text FROM nsr_eval_queries WHERE embedding_commercial IS NULL ORDER BY qid LIMIT $1`,
      [PAGE]
    )
    if (!rows.length) break
    const prepped = rows.map((r) => ({ id: r.id, text: (r.text || '').trim() })).filter((r) => r.text.length >= 3)
    const done = await embedRows(prepped, 'search_query')
    for (let i = 0; i < done.length; i += 500) {
      const sl = done.slice(i, i + 500)
      await conn.query(
        `UPDATE nsr_eval_queries q SET embedding_commercial = d.emb::vector(1536), embedded_commercial_at = now()
         FROM (SELECT unnest($1::text[]) AS qid, unnest($2::text[]) AS emb) d
         WHERE q.qid = d.qid`,
        [sl.map((d) => d.id), sl.map((d) => d.emb)]
      )
      grand += sl.length
    }
    console.log(`queries: ${grand} rows (${(grand / ((Date.now() - t0) / 1000)).toFixed(1)}/s)`)
  }
  console.log(`queries DONE: ${grand} rows in ${((Date.now() - t0) / 60000).toFixed(1)} min`)
}

async function main() {
  const conn = await mkClient()
  await runCorpus(conn)
  await runQueries(conn)
  console.log('ALL DONE')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
