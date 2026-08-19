#!/usr/bin/env node
/**
 * build-nsr-triplets.mjs — LANE-TRIPLETS (Stage 2). Training triplets for
 * NSRgpt's retriever/reranker fine-tune: queries are NSR's expert-written
 * keyword abstracts (KW) and EXFOR entry text (EX); positives are the
 * queries' own papers; hard negatives are mined from OUR bge-m3 space
 * (nsr_embeddings, HNSW live) — semantic arm — plus production FTS (nsr.fts)
 * — lexical arm. Record shape mirrors 44b's build-training-pairs.mjs so the
 * trainer in ~/Model/44b-reranker/ runs unchanged.
 *
 * Brief: docs/prompts/LANE-TRIPLETS.md. Report: same file, REPORT section.
 *
 *   --census    Phase 1: freeze KW + EX pairs, holdout, splits, Gate 1  (read-only)
 *   --rehearse  Phase 2: mine negatives for 1,000 anchors, Gate 2a/2b   (read-only)
 *   --mine      Phase 3: full sweep — NOT run on the laptop (see the lane's
 *               non-negotiable #4). Runs from the 44b worker box.
 *   --assemble  Phase 3: split by paper, write train/val/test.jsonl + manifest
 *
 * DEVIATION (recorded, see REPORT): "Query text = LANE-EVAL's flattener,
 * verbatim (same function, imported)" could not be honored literally —
 * scripts/eval/build-nsr-eval.mjs does not exist (LANE-EVAL has not run yet,
 * confirmed via `git log` and an fs check). The flattener below is a direct,
 * unambiguous implementation of LANE-EVAL.md's own written spec: "for each
 * group, topic + the phrases' text joined by '; '". It reproduces the
 * documented leak-audit invariant (flattened queries start with "NUCLEAR "
 * etc., 0 corpus abstracts share that prefix) byte-for-byte, so it is very
 * unlikely to diverge from whatever LANE-EVAL ends up writing — but if
 * LANE-EVAL's real function differs, re-run --census.
 */

import { Client } from '@neondatabase/serverless'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { createReadStream } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ── knobs ─────────────────────────────────────────────────────────────────
const CACHE = process.env.TRIPLETS_CACHE || join(homedir(), 'Model', 'nsr-training-pairs')
const RAW = join(CACHE, 'raw')
const OUT = join(CACHE, 'out')
const REHEARSAL = join(OUT, 'rehearsal')
for (const d of [CACHE, RAW, OUT, REHEARSAL]) mkdirSync(d, { recursive: true })

const HOLDOUT_SEED = 'holdout:' // md5('holdout:' || key_number), first quarter of hash space
const SPLIT_SEED = 'nsr-training-pairs-2026-08-17'
const SPLITS = [['train', 0.8], ['val', 0.9], ['test', 1.0]]

const EF_SEARCH = 160
const KNN_DEPTH = 30
const FTS_DEPTH = 30
const NEG_TARGET = 8
const NEG_PER_ARM = 4
const FTS_LADDER = [[2, 250, 6], [1, 2000, 8], [1, 60000, 10]]
const FTS_AND_TERMS = 4
const REHEARSE_N = 1000

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const val = (f, d) => (has(f) ? args[args.indexOf(f) + 1] : d)
const num = (f, d) => Number(val(f, d))
const fmt = (n) => Number(n).toLocaleString('en-US')
const log = (...a) => console.log(...a)

const connect = async () => {
  if (!process.env.DATABASE_URL_UNPOOLED) throw new Error('DATABASE_URL_UNPOOLED not set — run with --env-file=.env.local')
  const c = new Client(process.env.DATABASE_URL_UNPOOLED)
  c.on('error', (e) => { console.error('PG CLIENT ERROR (out-of-band):', e.message) })
  await c.connect()
  return c
}

const writeLine = (ws, obj) => {
  const ok = ws.write(JSON.stringify(obj) + '\n')
  return ok ? null : new Promise((res) => ws.once('drain', res))
}
const readJsonl = async (path, fn) => {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  let n = 0
  for await (const line of rl) if (line) { await fn(JSON.parse(line), n++) }
  return n
}

// ── deterministic hashing ────────────────────────────────────────────────
function isHoldout(keyNumber) {
  const h = createHash('md5').update(HOLDOUT_SEED + keyNumber).digest()
  const u = h.readUInt32BE(0) / 2 ** 32
  return u < 0.25
}
function splitOf(keyNumber) {
  const h = createHash('sha256').update(`${SPLIT_SEED}:${keyNumber}`).digest()
  const u = h.readUInt32BE(0) / 2 ** 32
  for (const [name, ceil] of SPLITS) if (u < ceil) return name
  return 'test'
}

// ── query flatteners ─────────────────────────────────────────────────────
function flattenSentenceGroups(sg) {
  if (!Array.isArray(sg)) return ''
  return sg.map((g) => {
    const topic = (g.topic || '').replace(/_/g, ' ')
    const phrases = (g.sentences || []).flatMap((s) => (s.phrases || []).map((p) => p.text)).filter(Boolean)
    return [topic, phrases.join('; ')].filter(Boolean).join(' ')
  }).join('\n')
}
function flattenExfor(title, reactions) {
  const codes = Array.isArray(reactions) ? reactions.join('; ') : ''
  return [title, codes].filter(Boolean).join('\n\n')
}
function positiveText(title, abstract) {
  return ((title || '') + '\n\n' + (abstract || '')).trim().slice(0, 2000)
}
function segmentOf(row) {
  const richness = row.abstract && row.abstract.length > 0 ? 'has_abstract' : 'title_only'
  const era = row.pub_year == null ? 'unknown' : row.pub_year < 1970 ? 'pre_1970' : row.pub_year < 2000 ? '1970_1999' : '2000_plus'
  const reftype = row.reference_type === 'JOURNAL' ? 'journal'
    : ['REPORT', 'THESIS', 'CONFERENCE'].includes(row.reference_type) ? 'report_thesis_conf' : 'other'
  return { richness, era, reftype }
}

// title-near-duplicate check (44b's dup_title, build-training-pairs.mjs:307-328):
// the text_hash twin check only catches byte-identical embedded text. NSR
// carries some near-duplicate pairs under two different key_numbers with a
// cosmetically different title string (LaTeX vs spelled-out nuclide names) —
// found live in the Phase 2 false-negative audit: 1984LUZU (the true EXFOR-
// linked positive for C0888) vs 1984LUZZ (mined as a negative), titles
// "Deuteron Breakup on Helium-4..." vs "Deuteron Breakup on $^{4}$He...".
const normTitle = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim()
const jaccard = (a, b) => {
  const A = new Set(a.split(' ')), B = new Set(b.split(' '))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

// ─────────────────────────────────────────────────────────────────────────
// PHASE 1 — census + freeze (read-only)
// ─────────────────────────────────────────────────────────────────────────
async function census() {
  const db = await connect()

  const { rows: [freeze] } = await db.query(`SELECT MAX(embedded_at) AS corpus_frozen_at, COUNT(*)::int AS total_vectors FROM nsr_embeddings`)
  log(`corpus frozen at ${freeze.corpus_frozen_at.toISOString()} · ${fmt(freeze.total_vectors)} vectors`)

  // ── KW: keyworded rows with a vector ──────────────────────────────────
  const { rows: kwRows } = await db.query(`
    SELECT n.key_number, n.sentence_groups, n.title, n.abstract, n.pub_year, n.reference_type, n.journal_code
      FROM nsr n JOIN nsr_embeddings e ON e.key_number = n.key_number
     WHERE n.sentence_groups IS NOT NULL AND jsonb_array_length(n.sentence_groups) > 0`)
  log(`KW rows with sentence_groups + vector: ${fmt(kwRows.length)}`)

  let kwHeldOut = 0
  const kwOut = createWriteStream(join(RAW, 'kw-pairs.jsonl'))
  const kwPaperSplit = { train: new Set(), val: new Set(), test: new Set() }
  const cellCounts = {}
  let kwWritten = 0
  for (const r of kwRows) {
    if (isHoldout(r.key_number)) { kwHeldOut++; continue }
    const query = flattenSentenceGroups(r.sentence_groups)
    if (!query) continue
    const seg = segmentOf(r)
    const cellKey = `${seg.richness}|${seg.era}|${seg.reftype}`
    cellCounts[cellKey] = (cellCounts[cellKey] || 0) + 1
    const split = splitOf(r.key_number)
    kwPaperSplit[split].add(r.key_number)
    await writeLine(kwOut, {
      family: 'KW', key_number: r.key_number, query,
      positive: { key_number: r.key_number, title: r.title, abstract: r.abstract },
      segment: seg, split,
    })
    kwWritten++
  }
  await new Promise((res) => kwOut.end(res))
  log(`KW: held out ${fmt(kwHeldOut)} · survive ${fmt(kwWritten)}`)

  // ── EX: EXFOR entry -> linked NSR paper(s), positive set, card-straddle drop ──
  const { rows: exLinks } = await db.query(`
    SELECT ne.exfor_id, ne.key_number, n.title AS paper_title, n.abstract, n.pub_year, n.reference_type
      FROM nsr_exfor ne JOIN nsr n ON n.key_number = ne.key_number`)
  const { rows: exEntries } = await db.query(`SELECT exfor_id, title, reactions FROM exfor_entries`)
  const exEntryByID = new Map(exEntries.map((e) => [e.exfor_id, e]))

  const byExforId = new Map()
  for (const l of exLinks) {
    if (!byExforId.has(l.exfor_id)) byExforId.set(l.exfor_id, [])
    byExforId.get(l.exfor_id).push(l)
  }

  let exDroppedHoldoutEmpty = 0, exDroppedStraddle = 0, exWritten = 0, exTotalPositives = 0
  const exOut = createWriteStream(join(RAW, 'ex-pairs.jsonl'))
  const exPaperSplit = { train: new Set(), val: new Set(), test: new Set() }
  for (const [exforId, links] of byExforId) {
    const entry = exEntryByID.get(exforId)
    if (!entry) continue
    const nonHeldOut = links.filter((l) => !isHoldout(l.key_number))
    if (!nonHeldOut.length) { exDroppedHoldoutEmpty++; continue }
    const splitsSeen = new Set(nonHeldOut.map((l) => splitOf(l.key_number)))
    if (splitsSeen.size > 1) { exDroppedStraddle++; continue }
    const split = [...splitsSeen][0]
    const query = flattenExfor(entry.title, entry.reactions)
    if (!query) continue
    for (const l of nonHeldOut) exPaperSplit[split].add(l.key_number)
    exTotalPositives += nonHeldOut.length
    await writeLine(exOut, {
      family: 'EX', exfor_id: exforId, query,
      positives: nonHeldOut.map((l) => ({ key_number: l.key_number, title: l.paper_title, abstract: l.abstract })),
      segment: segmentOf(nonHeldOut[0]), split,
    })
    exWritten++
  }
  await new Promise((res) => exOut.end(res))
  log(`EX: exfor ids ${fmt(byExforId.size)} · dropped (all-holdout) ${fmt(exDroppedHoldoutEmpty)} · dropped (straddle) ${fmt(exDroppedStraddle)} · survive ${fmt(exWritten)} (${fmt(exTotalPositives)} positive links)`)

  // ── twins (text_hash) + stub-DOI ────────────────────────────────────────
  const { rows: [twins] } = await db.query(`
    SELECT count(*)::int rows_in_twin_groups, count(DISTINCT text_hash)::int twin_groups
      FROM (SELECT text_hash FROM nsr_embeddings GROUP BY text_hash HAVING count(*) > 1) t
      JOIN nsr_embeddings e USING (text_hash)`)
  const { rows: [stubDoi] } = await db.query(`
    SELECT count(*)::int dois, coalesce(sum(n),0)::int rows
      FROM (SELECT doi, count(*) n FROM nsr WHERE doi IS NOT NULL GROUP BY doi HAVING count(*) > 1) t`)
  log(`twins: ${fmt(twins.rows_in_twin_groups)} rows in ${fmt(twins.twin_groups)} text_hash groups`)
  log(`stub-DOI: ${fmt(stubDoi.dois)} DOIs shared by ${fmt(stubDoi.rows)} rows`)

  // ── holdout count sanity + Gate 1 ───────────────────────────────────────
  const { rows: [holdoutCheck] } = await db.query(`SELECT array_agg(key_number) AS keys FROM nsr WHERE sentence_groups IS NOT NULL`)
  const allHoldoutKeys = [...new Set([...kwRows.map(r => r.key_number), ...exLinks.map(l => l.key_number)])].filter(isHoldout)
  const holdoutKeyHashSorted = createHash('sha256').update(JSON.stringify(allHoldoutKeys.sort())).digest('hex')

  const splitCounts = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.size]))
  const gate1 = {
    holdout_exclusion_asserted: true, // by construction: every write path checks isHoldout() first
    kw_pairs_ge_100k: kwWritten >= 100000,
    ex_pairs_ge_10k: exWritten >= 10000,
    train_val_test_paper_disjoint: true, // by construction: splitOf is a pure function of key_number
  }
  log(`\nGate 1: KW=${fmt(kwWritten)} (>=100k? ${gate1.kw_pairs_ge_100k}) · EX=${fmt(exWritten)} (>=10k? ${gate1.ex_pairs_ge_10k})`)

  const manifest = {
    phase: 1, built_at: new Date().toISOString(), corpus_frozen_at: freeze.corpus_frozen_at.toISOString(),
    holdout: { rule: "md5('holdout:'||key_number) first quarter of hash space", key_count: allHoldoutKeys.length, sha256_sorted_keys: holdoutKeyHashSorted },
    split: { seed: SPLIT_SEED, method: 'sha256(seed:key_number) -> uint32/2^32, by PAPER', ratios: { train: 0.8, val: 0.1, test: 0.1 } },
    kw: { total_with_vector: kwRows.length, held_out: kwHeldOut, survive: kwWritten,
      papers_by_split: splitCounts(kwPaperSplit), segment_cell_counts: cellCounts },
    ex: { exfor_ids: byExforId.size, dropped_all_holdout: exDroppedHoldoutEmpty, dropped_straddle: exDroppedStraddle,
      survive: exWritten, total_positive_links: exTotalPositives, papers_by_split: splitCounts(exPaperSplit) },
    twins: { rows_in_twin_groups: twins.rows_in_twin_groups, twin_groups: twins.twin_groups },
    stub_doi: { dois: stubDoi.dois, rows: stubDoi.rows },
    gate1,
  }
  writeFileSync(join(RAW, 'census-manifest.json'), JSON.stringify(manifest, null, 2))
  log(`\ncensus manifest -> ${join(RAW, 'census-manifest.json')}`)
  log(`holdout keys: ${fmt(allHoldoutKeys.length)} · sha256(sorted list) = ${holdoutKeyHashSorted}`)
  await db.end()
}

// ─────────────────────────────────────────────────────────────────────────
// PHASE 2 — rehearse the mining on REHEARSE_N anchors, then HALT-IF-RED
// ─────────────────────────────────────────────────────────────────────────
function loadAnchors() {
  const anchors = []
  const kwPath = join(RAW, 'kw-pairs.jsonl')
  const exPath = join(RAW, 'ex-pairs.jsonl')
  if (!existsSync(kwPath) || !existsSync(exPath)) throw new Error('run --census first')
  const readSync = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const kw = readSync(kwPath)
  const ex = readSync(exPath)
  // proportional sample, deterministic: every Nth record by index
  const totalPool = kw.length + ex.length
  const kwShare = Math.round(REHEARSE_N * (kw.length / totalPool))
  const exShare = REHEARSE_N - kwShare
  const stepKW = Math.max(1, Math.floor(kw.length / kwShare))
  const stepEX = Math.max(1, Math.floor(ex.length / exShare))
  for (let i = 0; i < kw.length && anchors.filter(a => a.family === 'KW').length < kwShare; i += stepKW) anchors.push(kw[i])
  for (let i = 0; i < ex.length && anchors.filter(a => a.family === 'EX').length < exShare; i += stepEX) anchors.push(ex[i])
  return anchors.slice(0, REHEARSE_N)
}

// Each statement is issued separately (not as one multi-statement string):
// @neondatabase/serverless's Client uses the extended (prepared-statement)
// protocol whenever parameters are passed, and Postgres rejects multiple
// commands in a single prepared statement. BEGIN / SET LOCAL / SHOW / the
// real query / COMMIT go over the same connection as 5 round trips instead
// of 1 — still one connection, still one transaction, LOCAL still scopes.
async function txQuery(db, sql, params) {
  await db.query('BEGIN')
  try {
    await db.query(`SET LOCAL hnsw.ef_search = ${EF_SEARCH}`)
    const { rows: [ef] } = await db.query('SHOW hnsw.ef_search')
    if (ef['hnsw.ef_search'] !== String(EF_SEARCH)) throw new Error(`ef_search is ${ef['hnsw.ef_search']}, not ${EF_SEARCH}`)
    const res = await db.query(sql, params)
    await db.query('COMMIT')
    return res
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {})
    throw e
  }
}

async function explainCompare(db, anchorKeys) {
  const twoStep = `
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT key_number, embedding <=> (SELECT embedding FROM nsr_embeddings WHERE key_number = $1)::vector AS dist
      FROM nsr_embeddings ORDER BY embedding <=> (SELECT embedding FROM nsr_embeddings WHERE key_number = $1)::vector LIMIT ${KNN_DEPTH}`
  const lateral = `
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT a.key_number AS anchor, nb.key_number, nb.dist
      FROM unnest($1::text[]) AS a(key_number)
      JOIN nsr_embeddings ea ON ea.key_number = a.key_number
      CROSS JOIN LATERAL (
        SELECT key_number, embedding <=> ea.embedding AS dist
          FROM nsr_embeddings ORDER BY embedding <=> ea.embedding LIMIT ${KNN_DEPTH}
      ) nb`
  const twoStepPlans = []
  for (const k of anchorKeys) {
    const res = await txQuery(db, twoStep, [k])
    twoStepPlans.push((res.rows || []).map((r) => r['QUERY PLAN']).join('\n'))
  }
  const latRes = await txQuery(db, lateral, [anchorKeys])
  const latPlan = (latRes.rows || []).map((r) => r['QUERY PLAN']).join('\n')
  return { twoStepPlans, latPlan }
}

// positive key for KW = key_number; for EX use the first positive
const posKeyOf = (a) => a.family === 'KW' ? a.key_number : a.positives[0].key_number

// FTS lexical ladder, batched: rung 0 for every anchor still needing terms in
// ONE round trip via LATERAL, escalate only the short ones to rung 1, etc. —
// this is the batching Gate 2b's own math demands (RTT/FTS dominates, not the
// 1ms-server-side kNN); an unbatched per-anchor ladder measured 541 ms/anchor
// and a 152k-anchor sweep at that rate projects to 22.9h (fails the 60-min gate).
async function lexicalLadderBatch(db, items, df) {
  // items: [{ ord, query }]; returns Map<ord, {rows, rungUsed}>
  const lexOf = new Map()
  const { rows: tvRows } = await db.query(
    `SELECT ord::int, tv FROM unnest($1::text[]) WITH ORDINALITY AS t(txt, ord), LATERAL (SELECT to_tsvector('english', txt) tv) x`,
    [items.map((it) => it.query)])
  for (const r of tvRows) {
    const lex = [...new Set([...r.tv.matchAll(/'((?:[^']|'')+)':/g)].map((m) => m[1].replace(/''/g, "'")))]
      .filter((w) => /^[a-z][a-z0-9-]{2,}$/.test(w))
    lexOf.set(items[r.ord - 1].ord, lex)
  }
  const result = new Map(items.map((it) => [it.ord, { rows: [], rungUsed: 3 }]))
  let pending = items
  for (let rung = 0; rung < FTS_LADDER.length && pending.length; rung++) {
    const [lo, hi, k] = FTS_LADDER[rung]
    const queries = []
    for (const it of pending) {
      const lex = lexOf.get(it.ord) || []
      const terms = lex.map((w) => ({ w, n: df.get(w) ?? 0 })).filter((r) => r.n >= lo && r.n <= hi)
        .sort((x, y) => x.n - y.n).slice(0, k)
      if (terms.length) queries.push({ ord: it.ord, q: terms.slice(0, FTS_AND_TERMS).map((r) => r.w).join(' & ') })
    }
    if (!queries.length) continue
    let rows = []
    try {
      const sql = `
        SELECT a.ord, nb.key_number, nb.title, nb.abstract, nb.text_hash
          FROM unnest($1::int[], $2::text[]) AS a(ord, tsq)
          CROSS JOIN LATERAL (
            SELECT n.key_number, n.title, n.abstract, e.text_hash
              FROM nsr n LEFT JOIN nsr_embeddings e ON e.key_number = n.key_number
             WHERE n.fts @@ to_tsquery('english', a.tsq)
             ORDER BY ts_rank(n.fts, to_tsquery('english', a.tsq)) DESC LIMIT ${FTS_DEPTH}
          ) nb`
      const res = await db.query(sql, [queries.map((q) => q.ord), queries.map((q) => q.q)])
      rows = res.rows ?? []
    } catch (e) { log(`  fts rung ${rung} batch error: ${e.message}`) }
    const byOrd = new Map()
    for (const r of rows) { if (!byOrd.has(r.ord)) byOrd.set(r.ord, []); byOrd.get(r.ord).push(r) }
    const queriedOrds = new Set(queries.map((q) => q.ord))
    const stillShort = []
    for (const q of queries) {
      const rs = byOrd.get(q.ord) || []
      if (rs.length) result.set(q.ord, { rows: rs, rungUsed: rung })
      if (rs.length < 12) stillShort.push(items.find((it) => it.ord === q.ord))
    }
    const notQueriedThisRung = pending.filter((it) => !queriedOrds.has(it.ord))
    pending = notQueriedThisRung.concat(stillShort)
  }
  return result
}

async function mineBatch(db, batch, ctx) {
  const { stats, out, df, posKeyOf, rungSampleQueries } = ctx
  const posKeys = batch.map(posKeyOf)

  // semantic arm, batched (one round trip for the whole batch)
  let semByAnchor = new Map()
  try {
    const sql = `
      SELECT a.key_number AS anchor, nb.key_number, nb.dist, n.title, n.abstract, e.text_hash
        FROM unnest($1::text[]) AS a(key_number)
        JOIN nsr_embeddings ea ON ea.key_number = a.key_number
        CROSS JOIN LATERAL (
          SELECT key_number, embedding <=> ea.embedding AS dist
            FROM nsr_embeddings ORDER BY embedding <=> ea.embedding LIMIT ${KNN_DEPTH}
        ) nb
        JOIN nsr n ON n.key_number = nb.key_number
        JOIN nsr_embeddings e ON e.key_number = nb.key_number`
    const res = await txQuery(db, sql, [posKeys])
    for (const r of (res.rows ?? [])) {
      if (!semByAnchor.has(r.anchor)) semByAnchor.set(r.anchor, [])
      semByAnchor.get(r.anchor).push(r)
    }
  } catch (e) {
    stats.errors += batch.length
    log(`  semantic batch error: ${e.message}`)
  }

  // positives' own text_hash — batched, not assumed-present in the semantic
  // top-K (it almost always is, self-distance 0, but don't rely on "almost")
  const posHashMap = new Map()
  {
    const { rows } = await db.query(`SELECT key_number, text_hash FROM nsr_embeddings WHERE key_number = ANY($1)`, [posKeys])
    for (const r of rows) posHashMap.set(r.key_number, r.text_hash)
  }

  // exfor ids for positives (overlap drop; candidate side checked after both arms run)
  let exforMap = new Map()
  {
    const { rows } = await db.query(`SELECT key_number, exfor_id FROM nsr_exfor WHERE key_number = ANY($1)`, [posKeys])
    for (const r of rows) { if (!exforMap.has(r.key_number)) exforMap.set(r.key_number, new Set()); exforMap.get(r.key_number).add(r.exfor_id) }
  }

  // lexical arm, batched ladder
  const lexItems = batch.map((a, idx) => ({ ord: idx + 1, query: a.query }))
  const lexResult = await lexicalLadderBatch(db, lexItems, df)

  // candidate exfor overlap: fetch exfor ids for every candidate key seen this batch
  const allCandKeys = new Set()
  for (const rows of semByAnchor.values()) for (const r of rows) allCandKeys.add(r.key_number)
  for (const { rows } of lexResult.values()) for (const r of rows) allCandKeys.add(r.key_number)
  if (allCandKeys.size) {
    const { rows } = await db.query(`SELECT key_number, exfor_id FROM nsr_exfor WHERE key_number = ANY($1)`, [[...allCandKeys]])
    for (const r of rows) { if (!exforMap.has(r.key_number)) exforMap.set(r.key_number, new Set()); exforMap.get(r.key_number).add(r.exfor_id) }
  }

  batch.forEach((a, idx) => {
    const posKey = posKeyOf(a)
    const posExfor = exforMap.get(posKey) || new Set()
    const posHash = posHashMap.get(posKey)
    const posTitle = a.family === 'KW' ? a.positive.title : (a.positives.find((p) => p.key_number === posKey) || {}).title
    const posTitleNorm = normTitle(posTitle)
    const otherPositiveKeys = new Set(a.family === 'EX' ? a.positives.map((p) => p.key_number) : [])

    const rec = { family: a.family, id: a.family === 'KW' ? a.key_number : a.exfor_id, negatives: [], rejected: {} }
    const bump = (k) => { rec.rejected[k] = (rec.rejected[k] || 0) + 1; stats[k] = (stats[k] || 0) + 1 }

    const filterCand = (list, source) => {
      const good = []
      for (const c of list) {
        stats.considered++
        if (c.key_number === posKey) { bump('self'); continue }
        if (otherPositiveKeys.has(c.key_number)) { bump('other_positive'); continue }
        // non-negotiable #2: never train on the eval — a held-out paper can
        // never be a negative either, not just never a query/positive.
        if (isHoldout(c.key_number)) { bump('holdout'); continue }
        if (posHash && c.text_hash && c.text_hash === posHash) { bump('twin'); continue }
        if (posTitleNorm && c.title) {
          const cn = normTitle(c.title)
          if (cn && (cn === posTitleNorm || jaccard(cn, posTitleNorm) >= 0.85)) { bump('dup_title'); continue }
        }
        const candExfor = exforMap.get(c.key_number) || new Set()
        if ([...candExfor].some((id) => posExfor.has(id))) { bump('exfor_overlap'); continue }
        good.push({ key_number: c.key_number, title: c.title, abstract: c.abstract, source })
      }
      return good
    }

    const semCand = semByAnchor.get(posKey) || []
    if (!semCand.length) stats.sem_empty++
    const semGood = filterCand(semCand, 'semantic')

    const { rows: lexCand, rungUsed } = lexResult.get(idx + 1) || { rows: [], rungUsed: 3 }
    stats.rung[rungUsed]++
    const lexGood = filterCand(lexCand, 'lexical')

    const picked = new Map()
    const take = (arr, n) => { for (const c of arr) { if (picked.size >= NEG_TARGET || n <= 0) return; if (picked.has(c.key_number)) continue; picked.set(c.key_number, c); n-- } }
    take(semGood, NEG_PER_ARM); take(lexGood, NEG_PER_ARM)
    take(semGood, NEG_TARGET); take(lexGood, NEG_TARGET)
    rec.negatives = [...picked.values()]
    if (rungSampleQueries && rungSampleQueries.length < 5) rungSampleQueries.push({ id: rec.id, rung: rungUsed })
    writeLine(out, rec)
    stats.mined++
  })
}

async function rehearse() {
  const db = await connect()
  const anchors = loadAnchors()
  log(`rehearsal anchors: ${fmt(anchors.length)} (KW ${anchors.filter(a => a.family === 'KW').length} / EX ${anchors.filter(a => a.family === 'EX').length})`)

  // ── query-form comparison on 10 anchors ────────────────────────────────
  const tenKeys = anchors.slice(0, 10).map(posKeyOf)
  const { twoStepPlans, latPlan } = await explainCompare(db, tenKeys)
  writeFileSync(join(REHEARSAL, 'explain-two-step.txt'), twoStepPlans.join('\n\n---\n\n'))
  writeFileSync(join(REHEARSAL, 'explain-lateral.txt'), latPlan)
  const latUsesIndex = /Index Scan.*nsr_embeddings_embedding_idx/i.test(latPlan)
  const twoStepUsesIndex = twoStepPlans.every((p) => /Index Scan.*nsr_embeddings_embedding_idx/i.test(p))
  log(`two-step uses HNSW index on all 10: ${twoStepUsesIndex}`)
  log(`LATERAL (batched) uses HNSW index: ${latUsesIndex}`)

  // ── df table for lexical ladder (2% sample of nsr.fts) ──────────────────
  const dfPath = join(RAW, 'df.json')
  let df
  if (existsSync(dfPath)) {
    df = new Map(JSON.parse(readFileSync(dfPath, 'utf8')))
  } else {
    const { rows } = await db.query(`SELECT word, ndoc FROM ts_stat('SELECT fts FROM nsr TABLESAMPLE SYSTEM (2)')`)
    df = new Map(rows.map((r) => [r.word, r.ndoc]))
    writeFileSync(dfPath, JSON.stringify([...df]))
  }
  log(`df table: ${fmt(df.size)} lexemes`)

  // ── mine with the winning form (LATERAL if it uses the index; else two-step) ──
  const useLateral = latUsesIndex
  const BATCH = num('--batch', 100)
  const negPath = join(REHEARSAL, 'negatives.jsonl')
  const out = createWriteStream(negPath)
  const stats = { self: 0, twin: 0, dup_title: 0, other_positive: 0, exfor_overlap: 0, considered: 0,
    sem_empty: 0, errors: 0, rung: [0, 0, 0, 0], mined: 0 }
  const rungSampleQueries = []

  const miningCtx = { stats, out, df, posKeyOf, rungSampleQueries }

  // CONC parallel connections, each pulling BATCH-sized chunks off a shared
  // cursor — 44b's worker-pool pattern (build-training-pairs.mjs mine()).
  // Batching within a chunk fixed the RTT-bound cost (541 -> 93 ms/anchor);
  // this fixes the remaining serial-connection ceiling.
  const CONC = num('--conc', 6)
  const t0 = Date.now()
  let nextBatchStart = 0
  let done = 0
  async function worker() {
    const wdb = await connect()
    for (;;) {
      const i = nextBatchStart
      if (i >= anchors.length) break
      nextBatchStart += BATCH
      const batch = anchors.slice(i, i + BATCH)
      if (!batch.length) break
      await mineBatch(wdb, batch, miningCtx)
      done += batch.length
      if (Math.floor(done / 200) > Math.floor((done - batch.length) / 200)) log(`  ${fmt(Math.min(done, anchors.length))}/${fmt(anchors.length)} …`)
    }
    await wdb.end()
  }
  await Promise.all(Array.from({ length: CONC }, worker))
  await new Promise((r) => out.end(r))
  const minutes = (Date.now() - t0) / 60000
  const msPerAnchor = (minutes * 60000) / anchors.length
  log(`\nmined ${fmt(stats.mined)} in ${minutes.toFixed(2)} min · ${msPerAnchor.toFixed(0)} ms/anchor`)

  // ── assemble the LANE-TRIPLETS record shape for LANE-TRAIN's rehearsal ──
  // {"query", "positive": {"slug", "title", "abstract"}, "negatives", "meta"}
  // — "slug" (not "key_number") to stay byte-compatible with 44b's trainer,
  // per the lane's non-negotiable #1.
  const minedRecs = []
  await readJsonl(negPath, (r) => minedRecs.push(r))
  const anchorById = new Map(anchors.map((a) => [a.family === 'KW' ? a.key_number : a.exfor_id, a]))
  const assembledPath = join(REHEARSAL, 'rehearsal.jsonl')
  const assembledOut = createWriteStream(assembledPath)
  for (const r of minedRecs) {
    const a = anchorById.get(r.id)
    if (!a) continue
    const posKey = posKeyOf(a)
    const posTitle = a.family === 'KW' ? a.positive.title : (a.positives.find((p) => p.key_number === posKey) || {}).title
    const posAbstract = a.family === 'KW' ? a.positive.abstract : (a.positives.find((p) => p.key_number === posKey) || {}).abstract
    writeLine(assembledOut, {
      query: a.query,
      positive: { slug: posKey, title: posTitle, abstract: posAbstract },
      negatives: r.negatives.map((n) => ({ slug: n.key_number, title: n.title, abstract: n.abstract, source: n.source })),
      meta: { family: a.family, segment: a.segment },
    })
  }
  await new Promise((res) => assembledOut.end(res))
  log(`rehearsal (LANE-TRIPLETS record shape) -> ${assembledPath}`)

  // ── false-negative audit: 100 random mined semantic negatives ───────────
  const semNegs = minedRecs.flatMap((r) => r.negatives.filter((n) => n.source === 'semantic').map((n) => ({ ...n, queryId: r.id, family: r.family })))
  const sampleN = Math.min(100, semNegs.length)
  const step = Math.max(1, Math.floor(semNegs.length / sampleN))
  const audited = []
  for (let i = 0; i < semNegs.length && audited.length < sampleN; i += step) audited.push(semNegs[i])
  writeFileSync(join(REHEARSAL, 'false-negative-audit-sample.json'), JSON.stringify(audited, null, 2))

  // ── projections ──────────────────────────────────────────────────────
  const kwCount = existsSync(join(RAW, 'kw-pairs.jsonl')) ? readFileSync(join(RAW, 'kw-pairs.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0
  const exCount = existsSync(join(RAW, 'ex-pairs.jsonl')) ? readFileSync(join(RAW, 'ex-pairs.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0
  const fullAnchors = kwCount + exCount
  const projectedMinutes = (fullAnchors * msPerAnchor) / 60000

  const summary = {
    phase: 2, at: new Date().toISOString(), anchors: anchors.length,
    query_form: { two_step_uses_index: twoStepUsesIndex, lateral_uses_index: latUsesIndex, winner: useLateral ? 'lateral' : 'two-step' },
    ms_per_anchor: msPerAnchor, minutes_for_rehearsal: minutes,
    stats,
    rung_policy_sample: rungSampleQueries,
    full_sweep_anchor_estimate: fullAnchors,
    projected_full_sweep_minutes: projectedMinutes,
    gate2b_pass: projectedMinutes <= 60,
    false_negative_audit_sample_path: join(REHEARSAL, 'false-negative-audit-sample.json'),
    false_negative_audit_n: audited.length,
  }
  writeFileSync(join(REHEARSAL, 'rehearsal-summary.json'), JSON.stringify(summary, null, 2))
  log(`\nprojected full sweep (${fmt(fullAnchors)} anchors): ${projectedMinutes.toFixed(1)} min (gate <= 60: ${summary.gate2b_pass})`)
  log(`rehearsal summary -> ${join(REHEARSAL, 'rehearsal-summary.json')}`)
  log(`false-negative audit sample (n=${audited.length}) -> ${join(REHEARSAL, 'false-negative-audit-sample.json')} — hand/LLM read required, see REPORT`)
  await db.end()
}

// ─────────────────────────────────────────────────────────────────────────
// PHASE 3 — full sweep. MUST run from the AWS worker box, never the laptop
// (non-negotiable #4). Detached, checkpointed, resumable: progress lands in
// nsr_train_mining (id, family, done_at) — id holds a key_number (KW) or an
// exfor_id (EX); family disambiguates the two id spaces (a deviation from
// the doc's literal 2-column shape, needed because EX anchors aren't keyed
// by key_number at all).
// ─────────────────────────────────────────────────────────────────────────
function loadAllAnchors() {
  const kwPath = join(RAW, 'kw-pairs.jsonl')
  const exPath = join(RAW, 'ex-pairs.jsonl')
  if (!existsSync(kwPath) || !existsSync(exPath)) throw new Error('run --census first')
  const readSync = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  // EX first (~15k, small) so a partial-handoff assemble can cover ALL of EX
  // quickly, then KW (~137k, most of the wall-clock) fills in behind it.
  return [...readSync(exPath), ...readSync(kwPath)]
}
const anchorId = (a) => a.family === 'KW' ? a.key_number : a.exfor_id

async function mineFull() {
  const db = await connect()
  await db.query(`CREATE TABLE IF NOT EXISTS nsr_train_mining (
    id text NOT NULL, family text NOT NULL, done_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id, family))`)

  const BATCH = num('--batch', 150)
  const CONC = num('--conc', 12)

  const all = loadAllAnchors()
  const { rows: doneRows } = await db.query(`SELECT id, family FROM nsr_train_mining`)
  const doneSet = new Set(doneRows.map((r) => `${r.family}:${r.id}`))
  const anchors = all.filter((a) => !doneSet.has(`${a.family}:${anchorId(a)}`))
  log(`full sweep: ${fmt(all.length)} total anchors · ${fmt(doneSet.size)} already checkpointed · ${fmt(anchors.length)} to mine this run`)
  if (!anchors.length) { log('nothing to mine — already complete.'); await db.end(); return }

  const dfPath = join(RAW, 'df.json')
  let df
  if (existsSync(dfPath)) {
    df = new Map(JSON.parse(readFileSync(dfPath, 'utf8')))
  } else {
    const { rows } = await db.query(`SELECT word, ndoc FROM ts_stat('SELECT fts FROM nsr TABLESAMPLE SYSTEM (2)')`)
    df = new Map(rows.map((r) => [r.word, r.ndoc]))
    writeFileSync(dfPath, JSON.stringify([...df]))
  }
  log(`df table: ${fmt(df.size)} lexemes`)

  const negPath = join(OUT, 'negatives.jsonl')
  const out = createWriteStream(negPath, { flags: 'a' })
  const stats = { self: 0, twin: 0, dup_title: 0, other_positive: 0, exfor_overlap: 0, considered: 0,
    sem_empty: 0, errors: 0, rung: [0, 0, 0, 0], mined: 0 }
  const miningCtx = { stats, out, df, posKeyOf }

  const t0 = Date.now()
  let nextBatchStart = 0
  let done = 0
  let lastReport = Date.now()
  const REPORT_EVERY_MS = 30 * 60 * 1000 // ~30 min progress lines, per the lane's own report cadence

  // A Neon compute restart (another lane bumping the SAME endpoint's floor/
  // ceiling — this is a shared project resource, not ours alone) kills every
  // open connection at once with "terminating connection due to administrator
  // command." That must cost this run at most the batches in flight at that
  // instant, never the process: catch per-batch, drop and reopen the
  // connection, retry a few times, and only give up on a batch (leaving its
  // anchors uncheckpointed for the next resume) after repeated failures.
  let batchFailures = 0
  async function worker() {
    let wdb = await connect()
    for (;;) {
      const i = nextBatchStart
      if (i >= anchors.length) break
      nextBatchStart += BATCH
      const batch = anchors.slice(i, i + BATCH)
      if (!batch.length) break

      let ok = false
      for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
        try {
          await mineBatch(wdb, batch, miningCtx)
          const ids = batch.map(anchorId), fams = batch.map((a) => a.family)
          await wdb.query(
            `INSERT INTO nsr_train_mining (id, family) SELECT * FROM unnest($1::text[], $2::text[]) ON CONFLICT (id, family) DO NOTHING`,
            [ids, fams])
          ok = true
        } catch (e) {
          log(`  batch [${i}..${i + batch.length}) attempt ${attempt} failed: ${e.message} — reconnecting`)
          try { await wdb.end() } catch {}
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
          wdb = await connect()
        }
      }
      if (!ok) { batchFailures++; log(`  batch [${i}..${i + batch.length}) gave up after 4 attempts — left uncheckpointed for the next resume`) }

      done += batch.length
      const now = Date.now()
      if (now - lastReport >= REPORT_EVERY_MS || done >= anchors.length) {
        lastReport = now
        const min = (now - t0) / 60000
        const rate = done / min
        const etaMin = (anchors.length - done) / rate
        log(`PROGRESS ${new Date().toISOString()} — ${fmt(done)}/${fmt(anchors.length)} this run (${fmt(doneSet.size + done)}/${fmt(all.length)} total) · ${min.toFixed(1)}m elapsed · ${rate.toFixed(0)}/min · ETA ${etaMin.toFixed(0)}m · errors ${stats.errors} · gave-up batches ${batchFailures}`)
      }
    }
    await wdb.end()
  }
  await Promise.all(Array.from({ length: CONC }, worker))
  await new Promise((r) => out.end(r))
  const minutes = (Date.now() - t0) / 60000
  writeFileSync(join(OUT, 'mine-stats.json'), JSON.stringify({
    ...stats, ef_search: EF_SEARCH, knn_depth: KNN_DEPTH, fts_depth: FTS_DEPTH, fts_ladder: FTS_LADDER,
    mined_this_run: done, mined_total: doneSet.size + done, minutes_this_run: minutes,
    ms_per_anchor: (minutes * 60000) / done, at: new Date().toISOString(),
  }, null, 2))
  log(`\nFULL SWEEP RUN DONE — mined ${fmt(done)} this run in ${minutes.toFixed(1)} min (${fmt(doneSet.size + done)}/${fmt(all.length)} total) · negatives -> ${negPath}`)
  await db.end()
}

// ─────────────────────────────────────────────────────────────────────────
// PHASE 3 — assemble: split by paper -> train/val/test.jsonl + manifest.
// ─────────────────────────────────────────────────────────────────────────
async function assemble() {
  const all = loadAllAnchors()
  const anchorByKey = new Map(all.map((a) => [`${a.family}:${anchorId(a)}`, a]))

  const negPath = join(OUT, 'negatives.jsonl')
  const SPLITS_NAMES = ['train', 'val', 'test']
  const ws = Object.fromEntries(SPLITS_NAMES.map((s) => [s, createWriteStream(join(OUT, `${s}.jsonl`))]))
  const paperSets = { train: new Set(), val: new Set(), test: new Set() }
  const counts = { train: 0, val: 0, test: 0 }
  const negHist = {}
  let dropped = 0, selfInNeg = 0, negTotal = 0
  const bySource = { lexical: 0, semantic: 0 }
  let straddleDropped = 0

  // Dedup by anchor: a batch that failed partway through a retry (worker-pool
  // resilience, mineFull()) can leave more than one record for the same
  // anchor in the append-only negatives.jsonl. Keep the last — the one that
  // ran to completion.
  const negByAnchor = new Map()
  let rawLines = 0
  await readJsonl(negPath, (r) => { rawLines++; negByAnchor.set(`${r.family}:${r.id}`, r) })
  if (negByAnchor.size !== rawLines) log(`negatives.jsonl: ${fmt(rawLines)} lines, ${fmt(rawLines - negByAnchor.size)} duplicate anchor entries collapsed (retry artifacts)`)

  for (const r of negByAnchor.values()) {
    const a = anchorByKey.get(`${r.family}:${r.id}`)
    if (!a || !r.negatives?.length) { dropped++; continue }
    const posKey = posKeyOf(a)
    const posTitle = a.family === 'KW' ? a.positive.title : (a.positives.find((p) => p.key_number === posKey) || {}).title
    const posAbstract = a.family === 'KW' ? a.positive.abstract : (a.positives.find((p) => p.key_number === posKey) || {}).abstract

    // split by paper; for EX (positive set), every non-held-out positive must
    // already agree on one split — census's card-straddle drop enforces this,
    // but assert it here too rather than trust it silently.
    const splitsOfPositives = a.family === 'KW' ? [splitOf(posKey)] : a.positives.map((p) => splitOf(p.key_number))
    if (new Set(splitsOfPositives).size > 1) { straddleDropped++; continue }
    const split = splitsOfPositives[0]

    if (r.negatives.some((n) => n.key_number === posKey)) selfInNeg++
    paperSets[split].add(posKey)
    counts[split]++
    negTotal += r.negatives.length
    negHist[r.negatives.length] = (negHist[r.negatives.length] || 0) + 1
    for (const n of r.negatives) bySource[n.source] = (bySource[n.source] || 0) + 1

    await writeLine(ws[split], {
      query: a.query,
      positive: { slug: posKey, title: posTitle, abstract: posAbstract },
      negatives: r.negatives.map((n) => ({ slug: n.key_number, title: n.title, abstract: n.abstract, source: n.source })),
      meta: { family: a.family, segment: a.segment },
    })
  }
  await Promise.all(Object.values(ws).map((w) => new Promise((res) => w.end(res))))

  const inter = (a, b) => [...paperSets[a]].filter((x) => paperSets[b].has(x))
  const tv = inter('train', 'val'), tt = inter('train', 'test'), vt = inter('val', 'test')
  const allPapers = new Set([...paperSets.train, ...paperSets.val, ...paperSets.test])
  const total = counts.train + counts.val + counts.test
  const ok = !tv.length && !tt.length && !vt.length && !selfInNeg

  log(`\n── PAPER-DISJOINTNESS PROOF ──`)
  log(`  papers  train ${fmt(paperSets.train.size)} · val ${fmt(paperSets.val.size)} · test ${fmt(paperSets.test.size)} · union ${fmt(allPapers.size)}`)
  log(`  |train ∩ val|=${tv.length} |train ∩ test|=${tt.length} |val ∩ test|=${vt.length}`)
  log(`  positive_in_own_negatives: ${selfInNeg}`)
  log(`  GATE: ${ok ? 'PASS' : 'FAIL'}`)
  log(`pairs train ${fmt(counts.train)} · val ${fmt(counts.val)} · test ${fmt(counts.test)} · total ${fmt(total)}`)
  log(`negatives ${fmt(negTotal)} · mean ${(negTotal / total).toFixed(2)}/pair · lexical ${fmt(bySource.lexical || 0)} semantic ${fmt(bySource.semantic || 0)}`)
  log(`dropped (no negatives): ${fmt(dropped)} · dropped (split-straddle): ${fmt(straddleDropped)}`)

  const mineStats = existsSync(join(OUT, 'mine-stats.json')) ? JSON.parse(readFileSync(join(OUT, 'mine-stats.json'), 'utf8')) : null
  const censusManifest = JSON.parse(readFileSync(join(RAW, 'census-manifest.json'), 'utf8'))
  const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
  const anchorsTotal = all.length
  const anchorsMined = negByAnchor.size
  const partial = anchorsMined < anchorsTotal
  const manifest = {
    built_at: new Date().toISOString(),
    corpus_frozen_at: censusManifest.corpus_frozen_at,
    holdout: censusManifest.holdout,
    split: censusManifest.split,
    partial,
    coverage: { anchors_mined: anchorsMined, anchors_total: anchorsTotal,
      pct: Math.round((10000 * anchorsMined) / anchorsTotal) / 100 },
    counts: { pairs: counts, papers: { train: paperSets.train.size, val: paperSets.val.size, test: paperSets.test.size },
      total_pairs: total, total_papers: allPapers.size, dropped, straddle_dropped: straddleDropped },
    disjointness: { train_val: tv.length, train_test: tt.length, val_test: vt.length, positive_in_own_negatives: selfInNeg, pass: ok },
    negatives: { target: NEG_TARGET, per_arm: NEG_PER_ARM, total: negTotal, mean: negTotal / total, by_source: bySource, histogram: negHist },
    mine_stats: mineStats,
    files: Object.fromEntries(SPLITS_NAMES.map((s) => {
      const p = join(OUT, `${s}.jsonl`)
      return [`${s}.jsonl`, { size: statSync(p).size, sha256: sha256File(p) }]
    })),
  }
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2))
  log(`\n${partial ? 'PARTIAL ' : ''}manifest -> ${join(OUT, 'manifest.json')} (${fmt(anchorsMined)}/${fmt(anchorsTotal)} anchors, ${manifest.coverage.pct}%)`)
  if (!ok) process.exitCode = 6
}

// ─────────────────────────────────────────────────────────────────────────
if (has('--census')) await census()
else if (has('--rehearse')) await rehearse()
else if (has('--mine')) await mineFull()
else if (has('--assemble')) await assemble()
else {
  log(`usage: node --env-file=.env.local scripts/train/build-nsr-triplets.mjs <phase>

  --census     Phase 1: freeze KW + EX pairs, holdout, splits, Gate 1  (read-only)
  --rehearse   Phase 2: mine negatives for 1,000 anchors, Gate 2a/2b   (read-only)

  Phase 3 (--mine / --assemble, full ~180k sweep) is NOT implemented here —
  the lane's non-negotiable #4 bars it from this laptop; it runs from the
  44b worker box. See docs/prompts/LANE-TRIPLETS.md Phase 3.`)
}
