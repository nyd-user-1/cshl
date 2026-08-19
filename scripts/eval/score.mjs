#!/usr/bin/env node
// score.mjs — LANE-EVAL Phase 3. Scores frozen KW/EX queries against the
// 277,068-vector universe: Arm A (production FTS, sql/19 weighted path),
// Arm B (bge-m3 dense, HNSW), RRF fusion (free extra ordering), and Arm C
// (Cohere embed-v4 via Bedrock, run only if both sides are embedded).
// One JSON result file per arm in data/eval/nsr-eval-v1/results/, written as
// each arm finishes — a death costs one arm, not the run.
import { neon } from '@neondatabase/serverless'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(process.cwd(), 'data/eval/nsr-eval-v1')
const RESULTS = join(ROOT, 'results')
mkdirSync(RESULTS, { recursive: true })
const ARMS = (process.env.ARMS || 'A,B,RRF').split(',').map((s) => s.trim())
const TOPK = 50
const CONC = 15

function mkClient() {
  return neon(process.env.DATABASE_URL_UNPOOLED)
}

// ── small concurrency pool ──────────────────────────────────────────────
async function pool(items, conc, fn) {
  const out = new Array(items.length)
  let i = 0
  async function worker() {
    for (;;) {
      const idx = i++
      if (idx >= items.length) return
      out[idx] = await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: conc }, worker))
  return out
}
async function withRetry(fn, tries = 4) {
  for (let a = 1; ; a++) {
    try { return await fn() } catch (e) {
      if (a >= tries) throw e
      await new Promise((r) => setTimeout(r, 300 * a))
    }
  }
}

// ── load frozen benchmark ───────────────────────────────────────────────
function loadQueries() {
  return readFileSync(join(ROOT, 'queries.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
function loadQrels() {
  const map = new Map()
  for (const line of readFileSync(join(ROOT, 'qrels.tsv'), 'utf8').split('\n').filter(Boolean)) {
    const [qid, key] = line.split('\t')
    if (!map.has(qid)) map.set(qid, new Set())
    map.get(qid).add(key)
  }
  return map
}

// ── metrics ──────────────────────────────────────────────────────────────
function metricsFor(ranked, positives) {
  const firstRank = (() => {
    for (let i = 0; i < ranked.length; i++) if (positives.has(ranked[i])) return i + 1
    return Infinity
  })()
  const recallAt = (k) => (ranked.slice(0, k).some((id) => positives.has(id)) ? 1 : 0)
  const mrr = Number.isFinite(firstRank) ? 1 / firstRank : 0
  const idealRel = Math.min(positives.size, 10)
  const idcg = Array.from({ length: idealRel }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0)
  const dcg = ranked.slice(0, 10).reduce((s, id, i) => s + (positives.has(id) ? 1 / Math.log2(i + 2) : 0), 0)
  const ndcg10 = idcg > 0 ? dcg / idcg : 0
  return { r1: recallAt(1), r5: recallAt(5), r10: recallAt(10), r50: recallAt(50), mrr, ndcg10 }
}

function segmentsFor(q) {
  return ['blended', `era:${q.era}`, `richness:${q.richness}`, `reftype:${q.reftype}`]
}

function aggregate(perQuery, queries) {
  // perQuery: qid -> metrics. Returns { family -> { segment -> {metric: mean, n} } }
  const byFamily = {}
  for (const q of queries) {
    const m = perQuery.get(q.qid)
    if (!m) continue
    for (const family of [q.family]) {
      byFamily[family] ??= {}
      for (const seg of segmentsFor(q)) {
        byFamily[family][seg] ??= { n: 0, r1: 0, r5: 0, r10: 0, r50: 0, mrr: 0, ndcg10: 0 }
        const acc = byFamily[family][seg]
        acc.n++
        acc.r1 += m.r1; acc.r5 += m.r5; acc.r10 += m.r10; acc.r50 += m.r50
        acc.mrr += m.mrr; acc.ndcg10 += m.ndcg10
      }
    }
  }
  for (const family of Object.keys(byFamily)) {
    for (const seg of Object.keys(byFamily[family])) {
      const acc = byFamily[family][seg]
      for (const k of ['r1', 'r5', 'r10', 'r50', 'mrr', 'ndcg10']) acc[k] = +(acc[k] / acc.n).toFixed(4)
    }
  }
  return byFamily
}

function percentile(arr, p) {
  const s = [...arr].sort((a, b) => a - b)
  if (!s.length) return null
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length))
  return s[idx]
}

// ── Arm A: production FTS (sql/19 weighted path), restricted to the
// 277,068-vector universe for cross-arm comparability. ─────────────────────
async function runArmA(sql, queries) {
  console.log('=== Arm A: FTS ===')
  let fallbacks = 0
  const latencies = []
  const perQuery = new Map()
  await pool(queries, CONC, async (q) => {
    const t0 = Date.now()
    let rows = await withRetry(() => sql.query(
      `SELECT n.key_number
         FROM nsr n JOIN nsr_embeddings e ON e.key_number = n.key_number
        WHERE n.fts @@ websearch_to_tsquery('english', $1)
        ORDER BY ts_rank_cd(n.fts, websearch_to_tsquery('english', $1)) DESC
        LIMIT ${TOPK}`,
      [q.text]
    ))
    if (rows.length === 0) {
      const [{ is_empty }] = await withRetry(() => sql.query(
        `SELECT (websearch_to_tsquery('english', $1) = ''::tsquery) AS is_empty`, [q.text]
      ))
      if (is_empty) {
        fallbacks++
        const words = q.text.split(/\s+/).filter((w) => w.length > 2).slice(0, 24).join(' ')
        rows = await withRetry(() => sql.query(
          `SELECT n.key_number
             FROM nsr n JOIN nsr_embeddings e ON e.key_number = n.key_number
            WHERE n.fts @@ plainto_tsquery('english', $1)
            ORDER BY ts_rank_cd(n.fts, plainto_tsquery('english', $1)) DESC
            LIMIT ${TOPK}`,
          [words]
        ))
      }
    }
    latencies.push(Date.now() - t0)
    perQuery.set(q.qid, { ranked: rows.map((r) => r.key_number) })
  })
  console.log(`Arm A: websearch-empty fallback used ${fallbacks}/${queries.length} times`)
  return { perQuery, fallbacks, latencies }
}

// ── Arm B: bge-m3 dense, HNSW. Query embedding as a bound $1::vector param
// (never join-sourced — that defeats the index). ───────────────────────────
async function loadQueryEmbeddings(sql, family) {
  const map = new Map()
  let last = ''
  for (;;) {
    const rows = await withRetry(() => sql.query(
      `SELECT qid, embedding::text AS emb FROM nsr_eval_queries
        WHERE family = $1 AND qid > $2 AND embedding IS NOT NULL
        ORDER BY qid LIMIT 2000`,
      [family, last]
    ))
    if (!rows.length) break
    for (const r of rows) map.set(r.qid, r.emb)
    last = rows[rows.length - 1].qid
    if (rows.length < 2000) break
  }
  return map
}

async function runArmB(sql, queries) {
  console.log('=== Arm B: bge-m3 dense (HNSW) ===')
  const kwEmb = await loadQueryEmbeddings(sql, 'KW')
  const exEmb = await loadQueryEmbeddings(sql, 'EX')
  const embFor = (q) => (q.family === 'KW' ? kwEmb : exEmb).get(q.qid)

  // Confirm the plan uses the index on the first query.
  const probe = queries.find((q) => embFor(q))
  if (probe) {
    const plan = await sql.query(
      `EXPLAIN SELECT key_number FROM nsr_embeddings ORDER BY embedding <=> $1::vector LIMIT ${TOPK}`,
      [embFor(probe)]
    )
    const planText = plan.map((r) => Object.values(r)[0]).join(' | ')
    console.log(`Arm B plan check: ${planText.includes('Index Scan') ? 'Index Scan CONFIRMED' : 'WARNING: no Index Scan — ' + planText}`)
  }

  const latencies = []
  const perQuery = new Map()
  await pool(queries, CONC, async (q) => {
    const vec = embFor(q)
    if (!vec) return // no embedding for this query (shouldn't happen post-Phase-2)
    const t0 = Date.now()
    const result = await withRetry(() => sql.transaction([
      sql.query(`SET LOCAL hnsw.ef_search = 100`),
      sql.query(`SELECT key_number FROM nsr_embeddings ORDER BY embedding <=> $1::vector LIMIT ${TOPK}`, [vec]),
    ]))
    const rows = result[1]
    latencies.push(Date.now() - t0)
    perQuery.set(q.qid, { ranked: rows.map((r) => r.key_number) })
  })
  return { perQuery, latencies }
}

// ── Arm D: nsr-encoder-bge-m3 (LANE-TRAIN's fine-tuned candidate), same
// query/corpus shape as Arm B but against nsr_embeddings_candidate /
// nsr_eval_queries_candidate. Added here (LANE-EVAL never knew about the
// candidate table) rather than a separate script, per LANE-TRAIN.md Phase 3
// ("Score with LANE-EVAL's scripts/eval/score.mjs, arm D"). No run_id filter
// in the query itself — nsr_embeddings_candidate's PK is key_number only
// (one row per paper, whichever run wrote it last), so the table's current
// contents already ARE "the" candidate run; run_id is carried in the result
// file for provenance, not as a query predicate (a non-indexed extra filter
// risks the planner skipping the HNSW scan, same trap Arm B guards against).
async function loadQueryEmbeddingsCandidate(sql) {
  const map = new Map()
  let last = ''
  for (;;) {
    const rows = await withRetry(() => sql.query(
      `SELECT qid, embedding::text AS emb FROM nsr_eval_queries_candidate
        WHERE qid > $1
        ORDER BY qid LIMIT 2000`,
      [last]
    ))
    if (!rows.length) break
    for (const r of rows) map.set(r.qid, r.emb)
    last = rows[rows.length - 1].qid
    if (rows.length < 2000) break
  }
  return map
}

async function runArmD(sql, queries) {
  console.log('=== Arm D: nsr-encoder-bge-m3 (candidate, HNSW) ===')
  const emb = await loadQueryEmbeddingsCandidate(sql)
  const embFor = (q) => emb.get(q.qid)

  const probe = queries.find((q) => embFor(q))
  if (probe) {
    const plan = await sql.query(
      `EXPLAIN SELECT key_number FROM nsr_embeddings_candidate ORDER BY embedding <=> $1::vector LIMIT ${TOPK}`,
      [embFor(probe)]
    )
    const planText = plan.map((r) => Object.values(r)[0]).join(' | ')
    console.log(`Arm D plan check: ${planText.includes('Index Scan') ? 'Index Scan CONFIRMED' : 'WARNING: no Index Scan — ' + planText}`)
  }

  const latencies = []
  const perQuery = new Map()
  await pool(queries, CONC, async (q) => {
    const vec = embFor(q)
    if (!vec) return
    const t0 = Date.now()
    const result = await withRetry(() => sql.transaction([
      sql.query(`SET LOCAL hnsw.ef_search = 100`),
      sql.query(`SELECT key_number FROM nsr_embeddings_candidate ORDER BY embedding <=> $1::vector LIMIT ${TOPK}`, [vec]),
    ]))
    const rows = result[1]
    latencies.push(Date.now() - t0)
    perQuery.set(q.qid, { ranked: rows.map((r) => r.key_number) })
  })
  return { perQuery, latencies }
}

// ── Arm C: Cohere embed-v4 via Bedrock, same-space corpus + queries. ──────
async function runArmC(sql, queries) {
  console.log('=== Arm C: Cohere embed-v4 (Bedrock) ===')
  const kwEmb = await loadQueryEmbeddingsCommercial(sql, 'KW')
  const exEmb = await loadQueryEmbeddingsCommercial(sql, 'EX')
  const embFor = (q) => (q.family === 'KW' ? kwEmb : exEmb).get(q.qid)
  const latencies = []
  const perQuery = new Map()
  await pool(queries, CONC, async (q) => {
    const vec = embFor(q)
    if (!vec) return
    const t0 = Date.now()
    const rows = await withRetry(() => sql.query(
      `SELECT key_number FROM nsr_embeddings_commercial ORDER BY embedding <=> $1::vector LIMIT ${TOPK}`,
      [vec]
    ))
    latencies.push(Date.now() - t0)
    perQuery.set(q.qid, { ranked: rows.map((r) => r.key_number) })
  })
  return { perQuery, latencies }
}
async function loadQueryEmbeddingsCommercial(sql, family) {
  const map = new Map()
  let last = ''
  for (;;) {
    const rows = await withRetry(() => sql.query(
      `SELECT qid, embedding_commercial::text AS emb FROM nsr_eval_queries
        WHERE family = $1 AND qid > $2 AND embedding_commercial IS NOT NULL
        ORDER BY qid LIMIT 2000`,
      [family, last]
    ))
    if (!rows.length) break
    for (const r of rows) map.set(r.qid, r.emb)
    last = rows[rows.length - 1].qid
    if (rows.length < 2000) break
  }
  return map
}

// ── RRF fusion (k=60), computed from A+B results already in hand. ─────────
function runRRF(armA, armB, k = 60) {
  const perQuery = new Map()
  for (const [qid, a] of armA.perQuery) {
    const b = armB.perQuery.get(qid)
    const scores = new Map()
    a.ranked.forEach((id, i) => scores.set(id, (scores.get(id) || 0) + 1 / (k + i + 1)))
    if (b) b.ranked.forEach((id, i) => scores.set(id, (scores.get(id) || 0) + 1 / (k + i + 1)))
    const ranked = [...scores.entries()].sort((x, y) => y[1] - x[1]).slice(0, TOPK).map(([id]) => id)
    perQuery.set(qid, { ranked })
  }
  return { perQuery }
}

// ── latency: EXPLAIN ANALYZE on 200 warm queries, server-side ms ──────────
async function serverLatency(sql, queries, arm, embMapKW, embMapEX) {
  const sample = queries.slice(0, 200)
  const times = []
  for (const q of sample) {
    let plan
    if (arm === 'A') {
      plan = await withRetry(() => sql.query(
        `EXPLAIN (ANALYZE, FORMAT JSON)
         SELECT n.key_number FROM nsr n JOIN nsr_embeddings e ON e.key_number = n.key_number
          WHERE n.fts @@ websearch_to_tsquery('english', $1)
          ORDER BY ts_rank_cd(n.fts, websearch_to_tsquery('english', $1)) DESC LIMIT ${TOPK}`,
        [q.text]
      ))
    } else {
      const vec = (q.family === 'KW' ? embMapKW : embMapEX).get(q.qid)
      if (!vec) continue
      plan = await withRetry(() => sql.query(
        `EXPLAIN (ANALYZE, FORMAT JSON)
         SELECT key_number FROM nsr_embeddings ORDER BY embedding <=> $1::vector LIMIT ${TOPK}`,
        [vec]
      ))
    }
    const j = plan[0]?.['QUERY PLAN']
    const execMs = Array.isArray(j) ? j[0]?.['Execution Time'] : undefined
    if (typeof execMs === 'number') times.push(execMs)
  }
  return { p50: percentile(times, 50), p95: percentile(times, 95), n: times.length }
}

async function main() {
  if (!process.env.DATABASE_URL_UNPOOLED) throw new Error('DATABASE_URL_UNPOOLED not set')
  const sql = mkClient()
  let queries = loadQueries()
  if (process.env.LIMIT) {
    const n = Number(process.env.LIMIT)
    // Keep both families represented in a smoke test.
    queries = [...queries.filter((q) => q.family === 'KW').slice(0, n), ...queries.filter((q) => q.family === 'EX').slice(0, n)]
  }
  const qrels = loadQrels()
  console.log(`Loaded ${queries.length} queries, ${qrels.size} qrels groups`)

  const write = (arm, data) => writeFileSync(join(RESULTS, `${arm}.json`), JSON.stringify(data, null, 2))

  let armAResult, armBResult
  if (ARMS.includes('A')) {
    armAResult = await runArmA(sql, queries)
    const perQ = new Map([...armAResult.perQuery].map(([qid, v]) => [qid, metricsFor(v.ranked, qrels.get(qid) || new Set())]))
    const latA = await serverLatency(sql, queries, 'A')
    write('A', {
      arm: 'A-fts', n_queries: armAResult.perQuery.size, fallbacks_used: armAResult.fallbacks,
      end_to_end_latency_ms: { p50: percentile(armAResult.latencies, 50), p95: percentile(armAResult.latencies, 95) },
      server_latency_ms_warm200: latA,
      metrics: aggregate(perQ, queries),
    })
    console.log('Wrote results/A.json')
  }

  if (ARMS.includes('B')) {
    armBResult = await runArmB(sql, queries)
    const perQ = new Map([...armBResult.perQuery].map(([qid, v]) => [qid, metricsFor(v.ranked, qrels.get(qid) || new Set())]))
    const kwEmb = await loadQueryEmbeddings(sql, 'KW')
    const exEmb = await loadQueryEmbeddings(sql, 'EX')
    const latB = await serverLatency(sql, queries, 'B', kwEmb, exEmb)
    write('B', {
      arm: 'B-dense-bge-m3', n_queries: armBResult.perQuery.size,
      end_to_end_latency_ms: { p50: percentile(armBResult.latencies, 50), p95: percentile(armBResult.latencies, 95) },
      server_latency_ms_warm200: latB,
      metrics: aggregate(perQ, queries),
    })
    console.log('Wrote results/B.json')
  }

  if (ARMS.includes('RRF') && armAResult && armBResult) {
    const rrf = runRRF(armAResult, armBResult)
    const perQ = new Map([...rrf.perQuery].map(([qid, v]) => [qid, metricsFor(v.ranked, qrels.get(qid) || new Set())]))
    write('RRF', { arm: 'RRF-k60-A+B', n_queries: rrf.perQuery.size, metrics: aggregate(perQ, queries) })
    console.log('Wrote results/RRF.json')
  }

  let armDResult
  if (ARMS.includes('D')) {
    const [{ corpus_n }] = await sql.query(`SELECT count(*)::int AS corpus_n FROM nsr_embeddings_candidate`)
    const [{ query_n }] = await sql.query(`SELECT count(*)::int AS query_n FROM nsr_eval_queries_candidate`)
    const [{ run_id }] = await sql.query(`SELECT run_id FROM nsr_embeddings_candidate LIMIT 1`)
    console.log(`Arm D readiness: run_id=${run_id} corpus=${corpus_n} queries=${query_n}`)
    armDResult = await runArmD(sql, queries)
    const perQ = new Map([...armDResult.perQuery].map(([qid, v]) => [qid, metricsFor(v.ranked, qrels.get(qid) || new Set())]))
    write('D', {
      arm: 'D-nsr-encoder-bge-m3', run_id, n_queries: armDResult.perQuery.size,
      end_to_end_latency_ms: { p50: percentile(armDResult.latencies, 50), p95: percentile(armDResult.latencies, 95) },
      metrics: aggregate(perQ, queries),
    })
    console.log('Wrote results/D.json')
  }

  if (ARMS.includes('RRF-D') && armAResult && armDResult) {
    const rrf = runRRF(armAResult, armDResult)
    const perQ = new Map([...rrf.perQuery].map(([qid, v]) => [qid, metricsFor(v.ranked, qrels.get(qid) || new Set())]))
    write('RRF-D', { arm: 'RRF-k60-A+D', n_queries: rrf.perQuery.size, metrics: aggregate(perQ, queries) })
    console.log('Wrote results/RRF-D.json')
  }

  if (ARMS.includes('C')) {
    const [{ corpus_n }] = await sql.query(`SELECT count(*)::int AS corpus_n FROM nsr_embeddings_commercial`)
    const [{ query_n }] = await sql.query(`SELECT count(*)::int AS query_n FROM nsr_eval_queries WHERE embedding_commercial IS NOT NULL`)
    console.log(`Arm C readiness: corpus=${corpus_n} queries=${query_n}`)
    if (corpus_n < 270000 || query_n < 9900) {
      console.log('Arm C not ready yet — skipping this run')
    } else {
      const armC = await runArmC(sql, queries)
      const perQ = new Map([...armC.perQuery].map(([qid, v]) => [qid, metricsFor(v.ranked, qrels.get(qid) || new Set())]))
      write('C', {
        arm: 'C-cohere-embed-v4', n_queries: armC.perQuery.size,
        end_to_end_latency_ms: { p50: percentile(armC.latencies, 50), p95: percentile(armC.latencies, 95) },
        metrics: aggregate(perQ, queries),
      })
      console.log('Wrote results/C.json')
    }
  }

  console.log('=== Phase 3 scoring complete for requested arms ===')
}

main().catch((e) => { console.error(e); process.exit(1) })
