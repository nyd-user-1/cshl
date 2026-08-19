// embed worker (CSHL / RxivGPT) — runs ON a GPU box beside a local TEI
// (bge-m3) server. Ported from the NSR worker at 8c1b05b (itself adapted from
// 44b scripts/embed-v2/worker.mjs).
//
// CHANGED vs the NSR original:
//   - TABLE / EMB_TABLE / KEY / CAP / EMB_MODEL are env knobs (CSHL defaults:
//     preprints, preprint_embeddings, key_number, 4000, bge-m3). The SQL is
//     built from them once at startup instead of being hardcoded to nsr.
//   - the upsert writes `model` explicitly (the sidecar has a model column and
//     a fine-tuned run must not silently masquerade as stock bge-m3).
//   - BOUNDS_NSR -> BOUNDS_KEYS; DIM knob (768-d baseline arms reuse this rig);
//     NORMALIZE knob (MedCPT wants raw CLS + dot product, not cosine).
//   - CHUNK defaults to 64, not 128: rxiv inputs are ~4x longer than NSR's
//     (measured mean 1,754 chars at cap 2000 / 2,034 at cap 4000 vs NSR's
//     mostly title-only rows), so 128 long texts per TEI call would push a
//     single request past --max-batch-tokens.
//
// Env: DATABASE_URL (direct/unpooled), PART (0..PARTS-1), PARTS, BOUNDS_KEYS,
// LANES, PAGE, CHUNK, TEI url.
// Resume-safe by construction: claims come from preprints LEFT JOIN
// preprint_embeddings WHERE e.key_number IS NULL — done rows never re-claim.
import { createHash } from 'crypto'
// `pg` is installed by user-data on the GPU box, not in this repo — so import it
// lazily. That keeps DRY_SQL=1 (below) runnable from the laptop, which is the
// only way to read this worker's SQL without paying for a boot.

const PART = Number(process.env.PART ?? 0)
const PARTS = Number(process.env.PARTS ?? 1)
const TEI = process.env.TEI ?? 'http://127.0.0.1:8080'
const PAGE = Number(process.env.PAGE ?? 1024)
const CHUNK = Number(process.env.CHUNK ?? 64) // texts per TEI call
const CAP = Number(process.env.CAP ?? 4000)   // chars per input
const CONC = Number(process.env.CONC ?? 4)    // parallel TEI calls in flight

const TABLE = process.env.TABLE ?? 'preprints'
const EMB_TABLE = process.env.EMB_TABLE ?? 'preprint_embeddings'
const KEY = process.env.KEY ?? 'key_number'
const EMB_MODEL = process.env.EMB_MODEL ?? 'bge-m3'
// NORMALIZE=0 stores RAW encoder output. This is not a style preference: bge-m3
// is trained for cosine and TEI normalizes it anyway, but MedCPT ranks by DOT
// PRODUCT over unnormalized [CLS] vectors (its own model card and paper), and
// normalizing before a dot product changes the ranking whenever |d| varies.
// A baseline measured with the wrong similarity function is a bad number, and
// this benchmark exists to be the number other people compare against.
// Pair with the arm's `metric` in scripts/eval/score.mjs: normalized -> <=> ,
// raw -> <#> (and the HNSW opclass must match).
const NORMALIZE = (process.env.NORMALIZE ?? '1') !== '0'
// Baseline arms are not all 1024-d: MedCPT / SPECTER2 / SciNCL are 768. The same
// rig embeds the corpus for every eval arm, so the dimension is a knob.
// RECLAIM_STALE=1 also claims rows whose stored text_hash no longer matches the
// current recipe. The sidecar's ON DELETE CASCADE handles a paper being REMOVED;
// nothing handles a paper being REVISED — a v2 that rewrites the abstract keeps
// its v1 vector, and text_hash is the only thing that can see it. Run this after
// any version refresh, or after a CAP change.
const RECLAIM_STALE = !!process.env.RECLAIM_STALE
const STALE_PRED = RECLAIM_STALE
  ? ` OR e.text_hash <> md5(left(trim(coalesce(p.title,'') || E'\\n\\n' || coalesce(p.abstract,'')), ${CAP}))`
  : ''
const DIM = Number(process.env.DIM ?? 1024)
if (!Number.isInteger(DIM) || DIM < 1 || DIM > 16000) throw new Error(`DIM=${process.env.DIM} is not a plausible vector dimension`)

// Identifiers come from the launcher, not from user input, but they are still
// interpolated into SQL — so validate their shape rather than trusting them.
for (const [n, v] of Object.entries({ TABLE, EMB_TABLE, KEY })) {
  if (!/^[a-z_][a-z0-9_]*$/.test(v)) throw new Error(`${n}=${v} is not a plain identifier`)
}

const B = (env) => (process.env[env] || '').split(',').filter(Boolean)

// Sessions only ever want index probes on the business key — the 44b fleet
// measured what happens when a big unnest write flips the planner: turn seq
// scans off.
async function mkClient() {
  const pg = (await import('pg')).default
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  // Background socket errors must not crash the process (Neon law: an
  // unhandled 'error' once killed a box silently); the lane's next query
  // fails loudly and reconnects.
  c.on('error', (e) => console.error(`pg client error (background): ${e.message}`))
  await c.connect()
  await c.query('SET enable_seqscan = off')
  return c
}

// Input recipe (deterministic): trim(title \n\n abstract), capped at CAP chars.
// Exclusion in SQL, not JS-skip: under 20 usable (non-whitespace) chars never
// claims. text_hash is md5 of the EXACT string sent to TEI, so a cap change
// makes stale rows visibly stale.
const JOB = {
  table: TABLE,
  id: KEY,
  bounds: B('BOUNDS_KEYS'),
  page: `SELECT p.${KEY} AS id,
                left(trim(coalesce(p.title,'') || E'\n\n' || coalesce(p.abstract,'')), ${CAP}) AS text
           FROM ${TABLE} p LEFT JOIN ${EMB_TABLE} e ON e.${KEY} = p.${KEY}
          WHERE (e.${KEY} IS NULL${STALE_PRED}) AND p.${KEY} > $1 AND ($3::text IS NULL OR p.${KEY} <= $3)
            AND length(regexp_replace(coalesce(p.title,'') || coalesce(p.abstract,''), '\\s+', '', 'g')) >= 20
          ORDER BY p.${KEY} LIMIT $2`,
  upd: `INSERT INTO ${EMB_TABLE} (${KEY}, embedding, model, text_hash)
        SELECT unnest($1::text[]), unnest($2::text[])::vector(${DIM}), $4::text, unnest($3::text[])
            ON CONFLICT (${KEY}) DO UPDATE
           SET embedding = EXCLUDED.embedding, model = EXCLUDED.model,
               text_hash = EXCLUDED.text_hash, embedded_at = now()`,
}

// DRY_SQL=1 prints the two statements this worker will run and exits. The rig
// only ever runs on a box you have to SSM into, so being able to see its SQL
// from the laptop is the difference between a 30-second check and a $1 boot.
if (process.env.DRY_SQL) {
  console.log('--- page ---\n' + JOB.page + '\n--- upsert ---\n' + JOB.upd)
  process.exit(0)
}

// ── embed one chunk via TEI, with one retry then per-item fallback ───────────
async function tei(texts) {
  const r = await fetch(`${TEI}/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputs: texts, truncate: true, normalize: NORMALIZE }),
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
// its own connection — IO parallelism against Neon. BOUNDS_KEYS carries
// PARTS*LANES upper-boundary keys (last entry = global cap for a rehearsal;
// beyond the array = unbounded).
const LANES = Number(process.env.LANES ?? 1)
let grand = 0
const t0 = Date.now()

// LO_CAP floors lane 0 — without it a bounded rehearsal silently claims the
// entire corpus below its first boundary key (learned the hard way on NSR,
// 2026-08-16: the "3,000-row" rehearsal swept 232,802 rows because lane 0
// started at ''). rxiv makes it easier to get wrong, not harder: keys come in
// two shapes (dotted '2024.01.02.123456' and bare legacy '229468'/'001891')
// which INTERLEAVE under lexical ordering, so a key prefix does not carve out
// a clean date slice and an unfloored lane 0 sweeps everything below it.
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
            await conn.query(job.upd, [sl.map((d) => d.id), sl.map((d) => d.emb), sl.map((d) => d.hash), EMB_MODEL])
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
