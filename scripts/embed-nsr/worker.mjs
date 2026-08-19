// embed-nsr worker — runs ON a GPU box beside a local TEI (bge-m3) server.
// Adapted from 44b scripts/embed-v2/worker.mjs (single table, sidecar upsert).
// Env: DATABASE_URL (direct/unpooled), PART (0..PARTS-1), PARTS, BOUNDS_NSR,
// LANES, PAGE, TEI url.
// Resume-safe by construction: claims come from nsr LEFT JOIN nsr_embeddings
// WHERE e.key_number IS NULL — done rows never re-claim.
import pg from 'pg'
import { createHash } from 'crypto'

const PART = Number(process.env.PART ?? 0)
const PARTS = Number(process.env.PARTS ?? 1)
const TEI = process.env.TEI ?? 'http://127.0.0.1:8080'
const PAGE = Number(process.env.PAGE ?? 1024)
const CHUNK = 128 // texts per TEI call
const CAP = 2000  // chars per input
const CONC = 4    // parallel TEI calls in flight

const B = (env) => (process.env[env] || '').split(',').filter(Boolean)

// Sessions only ever want index probes on key_number — the 44b fleet measured
// what happens when a big unnest write flips the planner: turn seq scans off.
async function mkClient() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  // Background socket errors must not crash the process (Neon law: an
  // unhandled 'error' once killed a box silently); the lane's next query
  // fails loudly and reconnects.
  c.on('error', (e) => console.error(`pg client error (background): ${e.message}`))
  await c.connect()
  await c.query('SET enable_seqscan = off')
  return c
}

// Input recipe (deterministic, matches sql/23-embeddings.sql):
// trim(title \n\n abstract), capped at 2000 chars. Exclusion in SQL, not
// JS-skip: under 20 usable (non-whitespace) chars never claims.
const JOB = {
  table: 'nsr',
  id: 'key_number',
  bounds: B('BOUNDS_NSR'),
  page: `SELECT n.key_number AS id,
                left(trim(coalesce(n.title,'') || E'\n\n' || coalesce(n.abstract,'')), ${CAP}) AS text
           FROM nsr n LEFT JOIN nsr_embeddings e ON e.key_number = n.key_number
          WHERE e.key_number IS NULL AND n.key_number > $1 AND ($3::text IS NULL OR n.key_number <= $3)
            AND length(regexp_replace(coalesce(n.title,'') || coalesce(n.abstract,''), '\\s+', '', 'g')) >= 20
          ORDER BY n.key_number LIMIT $2`,
  upd: `INSERT INTO nsr_embeddings (key_number, embedding, text_hash)
        SELECT unnest($1::text[]), unnest($2::text[])::vector(1024), unnest($3::text[])
            ON CONFLICT (key_number) DO UPDATE
           SET embedding = EXCLUDED.embedding, text_hash = EXCLUDED.text_hash, embedded_at = now()`,
}

// ── embed one chunk via TEI, with one retry then per-item fallback ───────────
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
const md5 = (s) => createHash('md5').update(s).digest('hex')

async function embedOne(slice, out) {
  try {
    const vecs = await tei(slice.map((r) => r.text))
    slice.forEach((r, j) => out.push({ id: r.id, emb: lit(vecs[j]), hash: md5(r.text) }))
  } catch (e) {
    console.error(`chunk failed (${e.message}) — retrying per-item`)
    for (const r of slice) {
      try {
        const [v] = await tei([r.text])
        out.push({ id: r.id, emb: lit(v), hash: md5(r.text) })
      } catch (e2) {
        console.error(`  skip ${r.id}: ${e2.message}`)
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

// ── main loop ────────────────────────────────────────────────────────────────
// LANES>1 splits this box's slice into LANES concurrent sub-ranges, each on
// its own connection — IO parallelism against Neon. BOUNDS_NSR carries
// PARTS*LANES upper-boundary keys (last entry = global cap for a rehearsal;
// beyond the array = unbounded).
const LANES = Number(process.env.LANES ?? 1)
let grand = 0
const t0 = Date.now()

// LO_CAP floors lane 0 — without it a bounded rehearsal silently claims the
// entire corpus below its first boundary key (learned the hard way, 2026-08-16:
// the "3,000-row" rehearsal swept 232,802 rows because lane 0 started at '').
const laneRange = (bounds, lane) => ({
  lo: lane === 0 ? (process.env.LO_CAP ?? '') : bounds[lane - 1],
  hi: lane >= bounds.length ? null : bounds[lane],
})

async function runRange(job, connOrMk, lo, hi, tag) {
  // A lane that dies on one transient error silently ends its whole box (the
  // Promise.all rejects, node exits, the box self-terminates "successfully").
  // So: reconnectable. `connOrMk` is either a live client or a factory; on any
  // error the lane rebuilds its connection and resumes from its own cursor —
  // the resume predicate makes the retry exact.
  const mk = typeof connOrMk === 'function' ? connOrMk : null
  let conn = mk ? await mk() : connOrMk
  let errs = 0
  let cursor = lo
  let n = 0
  const fetchPage = () => conn.query(job.page, [cursor, PAGE, hi])
  let pending = fetchPage()
  for (;;) {
    let rows
    try {
      ;({ rows } = await pending)
      errs = 0
    } catch (e) {
      if (!mk || ++errs > 5) throw e
      console.error(`${job.table} ${tag}: lane error (${e.message}) — reconnecting (${errs}/5)`)
      try { await conn.end() } catch {}
      await new Promise((r) => setTimeout(r, 2000 * errs))
      conn = await mk()
      pending = fetchPage()
      continue
    }
    if (!rows.length) break
    cursor = rows[rows.length - 1].id
    pending = fetchPage() // prefetch: DB leg overlaps the GPU leg
    const prepped = rows
      .map((r) => ({ id: r.id, text: (r.text || '').trim() }))
      .filter((r) => r.text.length >= 3)
    if (prepped.length) {
      const done = await embedBatch(prepped)
      for (let i = 0; i < done.length; i += 1024) {
        const sl = done.slice(i, i + 1024)
        // Writes get the same reconnect-and-retry as reads — an uncovered write
        // error here is exactly how the first 44b sweeper died with work left.
        for (let a = 1; ; a++) {
          try {
            await conn.query(job.upd, [sl.map((d) => d.id), sl.map((d) => d.emb), sl.map((d) => d.hash)])
            break
          } catch (e) {
            if (!mk || a >= 5) throw e
            console.error(`${job.table} ${tag}: write error (${e.message}) — reconnecting (${a}/5)`)
            try { await conn.end() } catch {}
            await new Promise((r) => setTimeout(r, 2000 * a))
            conn = await mk()
          }
        }
        n += sl.length
        grand += sl.length
      }
    }
    console.log(`${job.table} ${tag}: ${n} rows (${(grand / ((Date.now() - t0) / 1000)).toFixed(0)}/s box)`)
  }
  console.log(`DONE ${job.table} ${tag}: ${n} rows`)
}

if (LANES > 1) {
  const lanes = Array.from({ length: LANES }, (_, k) => PART * LANES + k)
  await Promise.all(
    lanes.map((lane) => {
      const { lo, hi } = laneRange(JOB.bounds, lane)
      return runRange(JOB, mkClient, lo, hi, `lane ${lane}`)
    }),
  )
} else {
  const { lo, hi } = JOB.bounds.length ? laneRange(JOB.bounds, PART) : { lo: '', hi: null }
  await runRange(JOB, mkClient, lo, hi, `part ${PART}`)
}
console.log(`ALL DONE part ${PART}: ${grand} rows in ${((Date.now() - t0) / 60000).toFixed(1)} min`)
process.exit(0)
