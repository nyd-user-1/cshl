#!/usr/bin/env node
// build-nsr-eval.mjs — LANE-EVAL Phase 1: census + freeze the KW/EX retrieval
// benchmark. Read-only against Neon; writes data/eval/nsr-eval-v1/. Modeled on
// 44b/scripts/reranker-pairs.mjs + build-training-pairs.mjs (freeze -> holdout
// by hash -> manifest). No model inference here — DB-only, laptop-safe.
//
// Env: DATABASE_URL_UNPOOLED (unpooled Neon connection string).

import { neon } from '@neondatabase/serverless'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = join(process.cwd(), 'data/eval/nsr-eval-v1')
mkdirSync(OUT, { recursive: true })

const HOLDOUT = 0.25
const KW_CAP = 5000
const EX_CAP = 5000

export const h32 = (s) => parseInt(createHash('md5').update(s).digest('hex').slice(0, 8), 16) / 0xffffffff
export const isHeldOut = (keyNumber) => h32(`holdout:${keyNumber}`) < HOLDOUT

// House pattern (api/search.ts, api/chat.ts): neon() HTTP driver against the
// unpooled connection string; .query(text, params) for plain SELECTs.
function mkClient() {
  const sql = neon(process.env.DATABASE_URL_UNPOOLED)
  return { query: (text, params = []) => sql.query(text, params) }
}

// The HTTP driver caps each response at 64MB — a single SELECT over 207k
// rows with jsonb/abstract payloads blows that. Page by key_number, ordered,
// keyset-style (resume-safe, matches the embed worker's claim pattern).
async function pageByKey(client, baseSql, pageSize = 10000) {
  const out = []
  let last = ''
  for (;;) {
    const rows = await client.query(`${baseSql} AND n.key_number > $1 ORDER BY n.key_number LIMIT $2`, [last, pageSize])
    if (rows.length === 0) break
    out.push(...rows)
    last = rows[rows.length - 1].key_number
    if (rows.length < pageSize) break
  }
  return out
}

export function era(pubYear) {
  if (pubYear == null) return 'unknown'
  if (pubYear < 1970) return 'pre1970'
  if (pubYear < 2000) return '1970-1999'
  return '2000+'
}
export function richness(abstract) {
  return abstract && abstract.trim().length > 0 ? 'has-abstract' : 'title-only'
}
export function reftype(referenceType) {
  return referenceType === 'JOURNAL' ? 'journal' : 'other'
}

// Flatten one sentence_groups element: topic + every phrase text in it,
// joined by '; '. Raw text kept exactly as stored (LaTeX included).
// Exported for LANE-TRAIN's rehearsal-record assembly — same function, not
// re-implemented (scripts/train-nsr/build-rehearsal-records.mjs).
export function flattenGroup(group) {
  const parts = [group.topic]
  for (const sentence of group.sentences || []) {
    for (const phrase of sentence.phrases || []) {
      if (phrase.text) parts.push(phrase.text)
    }
  }
  return parts.filter(Boolean).join('; ')
}

// Stratified cap: proportional allocation over (era, richness) cells, floor
// min(cellSize, 100) per nonempty cell, remainder distributed proportionally,
// deterministic selection within each cell by md5(qid) order.
function stratifiedSample(rows, cap, cellFn) {
  const cells = new Map()
  for (const r of rows) {
    const key = cellFn(r)
    if (!cells.has(key)) cells.set(key, [])
    cells.get(key).push(r)
  }
  const total = rows.length
  if (total <= cap) return { sample: rows, cellCounts: Object.fromEntries([...cells].map(([k, v]) => [k, v.length])) }

  const floors = new Map()
  let floorSum = 0
  for (const [key, arr] of cells) {
    const f = Math.min(arr.length, 100)
    floors.set(key, f)
    floorSum += f
  }
  let remaining = Math.max(0, cap - floorSum)
  const quotas = new Map(floors)
  const remainderCapacity = [...cells].reduce((s, [k, v]) => s + (v.length - floors.get(k)), 0)
  if (remainderCapacity > 0) {
    for (const [key, arr] of cells) {
      const cap2 = arr.length - floors.get(key)
      const share = Math.floor((remaining * cap2) / remainderCapacity)
      quotas.set(key, floors.get(key) + Math.min(cap2, share))
    }
  }
  const sample = []
  const cellCounts = {}
  for (const [key, arr] of cells) {
    const sorted = [...arr].sort((a, b) => (a.__ord < b.__ord ? -1 : a.__ord > b.__ord ? 1 : 0))
    const take = sorted.slice(0, quotas.get(key))
    cellCounts[key] = take.length
    sample.push(...take)
  }
  return { sample, cellCounts }
}

async function main() {
  if (!process.env.DATABASE_URL_UNPOOLED) throw new Error('DATABASE_URL_UNPOOLED not set')
  const client = mkClient()
  console.log('=== Phase 1: census + freeze ===')

  // Leak audit (a): keyword-abstract sentinel must never appear in the
  // publisher `abstract` column.
  const leakA = await client.query(`SELECT count(*)::int AS n FROM nsr WHERE abstract IS NOT NULL AND abstract LIKE 'NUCLEAR %'`)
  console.log(`Leak audit (a) NUCLEAR-sentinel in abstract: ${leakA[0].n}`)

  // ── KW candidates ──────────────────────────────────────────────────────
  console.log('Fetching KW candidates (sentence_groups IS NOT NULL, has embedding)...')
  const kwRes = await pageByKey(client, `
    SELECT n.key_number, n.sentence_groups, n.title, n.abstract, n.pub_year, n.reference_type
    FROM nsr n
    JOIN nsr_embeddings e ON e.key_number = n.key_number
    WHERE n.sentence_groups IS NOT NULL
  `)
  console.log(`KW-eligible (keyworded + embedded): ${kwRes.length}`)

  const kwCandidates = []
  for (const row of kwRes) {
    if (!isHeldOut(row.key_number)) continue
    const groups = Array.isArray(row.sentence_groups) ? row.sentence_groups : []
    groups.forEach((g, gi) => {
      const text = flattenGroup(g)
      if (!text) return
      kwCandidates.push({
        qid: `KW-${row.key_number}-${gi}`,
        family: 'KW',
        key_number: row.key_number,
        text,
        title: row.title,
        abstract: row.abstract,
        era: era(row.pub_year),
        richness: richness(row.abstract),
        reftype: reftype(row.reference_type),
        __ord: createHash('md5').update(`KW-${row.key_number}-${gi}`).digest('hex'),
      })
    })
  }
  console.log(`KW candidates (held-out papers): ${kwCandidates.length}`)

  // Leak audit (b): query text must not be a substring of its own document
  // (title || abstract). Bulk check via unnest with three parallel arrays.
  console.log('Running leak audit (b) — query-in-document check on all KW candidates...')
  const BATCH = 5000
  const leakHits = new Set()
  for (let i = 0; i < kwCandidates.length; i += BATCH) {
    const batch = kwCandidates.slice(i, i + BATCH)
    const r = await client.query(
      `SELECT t.qid AS qid, (position(t.qtext in (coalesce(n.title,'') || coalesce(n.abstract,''))) > 0) AS hit
       FROM unnest($1::text[], $2::text[], $3::text[]) AS t(qid, qtext, key_number)
       JOIN nsr n ON n.key_number = t.key_number
       WHERE position(t.qtext in (coalesce(n.title,'') || coalesce(n.abstract,''))) > 0`,
      [batch.map((b) => b.qid), batch.map((b) => b.text), batch.map((b) => b.key_number)]
    )
    for (const row of r) leakHits.add(row.qid)
  }
  console.log(`Leak audit (b) hits (dropped): ${leakHits.size}`)
  const kwSurvivors = kwCandidates.filter((c) => !leakHits.has(c.qid))
  console.log(`KW candidates after leak-drop: ${kwSurvivors.length}`)

  // Stratified sample to 5,000 across (era, richness) cells.
  const { sample: kwSample, cellCounts: kwCellCounts } = stratifiedSample(
    kwSurvivors, KW_CAP, (r) => `${r.era}|${r.richness}`
  )
  console.log(`KW final sample: ${kwSample.length}`)

  // Twin audit (c): exact-duplicate documents by text_hash in nsr_embeddings,
  // over the final sample's positives (the benchmark's actual positives).
  console.log('Running twin audit (c) on KW positives (final sample)...')
  const kwSampleKeys = [...new Set(kwSample.map((c) => c.key_number))]
  const twinRows = await client.query(`
    SELECT key_number, text_hash FROM nsr_embeddings
    WHERE key_number = ANY($1::text[])
  `, [kwSampleKeys])
  const hashCounts = await client.query(`
    SELECT text_hash, count(*)::int AS n FROM nsr_embeddings
    WHERE text_hash = ANY($1::text[])
    GROUP BY text_hash
  `, [[...new Set(twinRows.map((r) => r.text_hash))]])
  const twinHashSet = new Set(hashCounts.filter((r) => r.n > 1).map((r) => r.text_hash))
  const keyToHash = new Map(twinRows.map((r) => [r.key_number, r.text_hash]))
  const kwPositivesWithTwins = new Set(kwSampleKeys.filter((k) => twinHashSet.has(keyToHash.get(k))))
  console.log(`KW positives with a twin document: ${kwPositivesWithTwins.size}`)

  // ── EX candidates ──────────────────────────────────────────────────────
  console.log('Fetching EX candidates (exfor -> held-out, embedded NSR paper)...')
  // Boolean has_abstract, not the raw text — EX rows don't need the leak
  // check (that's KW-only), and this keeps the payload well under the HTTP
  // driver's 64MB response cap for all 23.5k links in one round trip.
  const exLinkRes = await client.query(`
    SELECT ne.exfor_id, ne.key_number,
           (n.abstract IS NOT NULL AND length(trim(n.abstract)) > 0) AS has_abstract,
           n.pub_year, n.reference_type
    FROM nsr_exfor ne
    JOIN nsr_embeddings e ON e.key_number = ne.key_number
    JOIN nsr n ON n.key_number = ne.key_number
  `)
  const byExforId = new Map()
  for (const row of exLinkRes) {
    if (!byExforId.has(row.exfor_id)) byExforId.set(row.exfor_id, [])
    byExforId.get(row.exfor_id).push(row)
  }
  const exforIds = [...byExforId.keys()]
  console.log(`Distinct EXFOR ids with an embedded, linked NSR paper: ${exforIds.length}`)

  const exEntryByid = new Map()
  for (let i = 0; i < exforIds.length; i += 5000) {
    const chunk = exforIds.slice(i, i + 5000)
    const rows = await client.query(
      `SELECT exfor_id, title, reactions FROM exfor_entries WHERE exfor_id = ANY($1::text[])`,
      [chunk]
    )
    for (const r of rows) exEntryByid.set(r.exfor_id, r)
  }

  const exCandidates = []
  for (const [exforId, links] of byExforId) {
    const heldOutLinks = links.filter((l) => isHeldOut(l.key_number))
    if (heldOutLinks.length === 0) continue
    const entry = exEntryByid.get(exforId)
    if (!entry) continue
    const reactionCodes = Array.isArray(entry.reactions) ? entry.reactions : []
    const parts = [entry.title, ...reactionCodes].filter(Boolean)
    const text = parts.join('; ')
    if (!text) continue
    const positives = links.map((l) => l.key_number) // score any hit as correct (any linked paper)
    // Segment tags from the held-out link(s): richness if ANY held-out
    // positive has an abstract; era/reftype from the first held-out link.
    const anyAbstract = heldOutLinks.some((l) => l.has_abstract)
    exCandidates.push({
      qid: `EX-${exforId}`,
      family: 'EX',
      exfor_id: exforId,
      text,
      positives,
      era: era(heldOutLinks[0].pub_year),
      richness: anyAbstract ? 'has-abstract' : 'title-only',
      reftype: reftype(heldOutLinks[0].reference_type),
      __ord: createHash('md5').update(`EX-${exforId}`).digest('hex'),
    })
  }
  console.log(`EX candidates (>=1 held-out linked paper): ${exCandidates.length}`)

  const { sample: exSample, cellCounts: exCellCounts } = stratifiedSample(
    exCandidates, EX_CAP, (r) => `${r.era}|${r.richness}`
  )
  console.log(`EX final sample: ${exSample.length}`)

  // ── Reftype coverage (reported separately, not stratified on) ──────────
  const reftypeCounts = (rows) => {
    const c = { journal: 0, other: 0 }
    for (const r of rows) c[r.reftype]++
    return c
  }
  const kwReftype = reftypeCounts(kwSample)
  const exReftype = reftypeCounts(exSample)

  // ── Query length stats ──────────────────────────────────────────────────
  const lens = (rows) => rows.map((r) => r.text.length).sort((a, b) => a - b)
  const stat = (arr) => arr.length ? { min: arr[0], median: arr[Math.floor(arr.length / 2)], max: arr[arr.length - 1] } : { min: 0, median: 0, max: 0 }
  const kwLenStats = stat(lens(kwSample))
  const exLenStats = stat(lens(exSample))

  // ── Write queries.jsonl + qrels.tsv ─────────────────────────────────────
  const queriesPath = join(OUT, 'queries.jsonl')
  const qrelsPath = join(OUT, 'qrels.tsv')
  const qLines = []
  const rLines = []
  for (const r of kwSample) {
    qLines.push(JSON.stringify({ qid: r.qid, family: 'KW', text: r.text, era: r.era, richness: r.richness, reftype: r.reftype }))
    rLines.push(`${r.qid}\t${r.key_number}`)
  }
  for (const r of exSample) {
    qLines.push(JSON.stringify({ qid: r.qid, family: 'EX', text: r.text, era: r.era, richness: r.richness, reftype: r.reftype }))
    for (const pos of r.positives) rLines.push(`${r.qid}\t${pos}`)
  }
  writeFileSync(queriesPath, qLines.join('\n') + '\n')
  writeFileSync(qrelsPath, rLines.join('\n') + '\n')

  // ── Frozen-at + manifest ─────────────────────────────────────────────────
  const frozenAt = await client.query(`SELECT max(embedded_at) AS max_at FROM nsr_embeddings`)

  const manifest = {
    built_at_note: 'timestamps intentionally omitted (script runs in a no-Date.now environment on the DB side too); see REPORT for wall-clock',
    holdout_fraction: HOLDOUT,
    holdout_formula: "md5('holdout:' || key_number) in first quarter of hash space",
    corpus_frozen_at: frozenAt[0].max_at,
    corpus_universe_size: 277068,
    kw: {
      eligible_keyworded_embedded_papers: kwRes.length,
      candidates_held_out: kwCandidates.length,
      leak_drops: leakHits.size,
      survivors: kwSurvivors.length,
      positives_with_twin: kwPositivesWithTwins.size,
      final_sample: kwSample.length,
      cell_counts_era_richness: kwCellCounts,
      reftype_counts: kwReftype,
      query_length_chars: kwLenStats,
    },
    ex: {
      distinct_exfor_ids_embedded_linked: exforIds.length,
      candidates_with_heldout_positive: exCandidates.length,
      final_sample: exSample.length,
      cell_counts_era_richness: exCellCounts,
      reftype_counts: exReftype,
      query_length_chars: exLenStats,
    },
    leak_audit: {
      a_nuclear_sentinel_in_abstract: leakA[0].n,
      b_query_in_document_hits_dropped: leakHits.size,
      c_kw_positives_with_twin: kwPositivesWithTwins.size,
    },
  }
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2))

  console.log('=== Gate 1 check ===')
  const gate = {
    leak_a_zero: leakA[0].n === 0,
    leak_b_zero_after_drops: true, // by construction, survivors have zero hits
    kw_min_3000: kwSample.length >= 3000,
    ex_min_1000: exSample.length >= 1000,
  }
  console.log(JSON.stringify(gate, null, 2))
  console.log('Manifest written to', join(OUT, 'manifest.json'))

}

// Guarded: LANE-TRAIN imports flattenGroup/era/richness/reftype from this
// module (rehearsal-record assembly) — an unconditional main() would re-run
// this whole census/freeze pipeline as an import side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
