#!/usr/bin/env node
// score.mjs — score the frozen rxiv benchmark. Ported from the NSR scorer at
// 8c1b05b (LANE-EVAL Phase 3).
//
// CHANGED vs the NSR original:
//   - NSR hardcoded five arms as five near-identical functions (runArmA..D,
//     each with its own query-embedding loader and its own table name). That
//     is exactly the shape that makes "add MedCPT" a code change. Replaced
//     with an ARM REGISTRY: every dense baseline is a table name + a dimension
//     + a query-embedding file, and `ARMS=fts,bge-m3,medcpt,specter2,scincl`
//     is the whole interface. Adding an arm is one registry entry.
//   - RRF and rerank are now COMPOSITE arms parsed from the flag
//     (`rrf:fts+bge-m3`, `rerank:bge-m3@http://ip:8081`), not bespoke code.
//   - per-arm vector dimension: MedCPT / SPECTER2 / SciNCL are 768-d, bge-m3
//     is 1024-d. NSR could assume one dimension; we cannot.
//   - query embeddings live in data/eval/<v>/qemb/<arm>.jsonl instead of
//     columns on an eval table — sql/ is not this lane's, and a per-arm column
//     for every baseline is the wrong shape anyway.
//   - segments are rxiv's (server / era / published / abstract length).
//
// Env: DATABASE_URL_UNPOOLED, ARMS, EVAL_VERSION, LIMIT, TOPK.
import { neon } from '@neondatabase/serverless'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
}

const VERSION = process.env.EVAL_VERSION ?? 'cshl-eval-v1'
const ROOT = join(process.cwd(), 'data/eval', VERSION)
const RESULTS = join(ROOT, 'results')
const QEMB = join(ROOT, 'qemb')
mkdirSync(RESULTS, { recursive: true })
const TOPK = Number(process.env.TOPK ?? 50)
const CONC = Number(process.env.CONC ?? 12)

// ── the arm registry. Adding a baseline is one line here. ────────────────────
// `metric` is not decoration. Each model is scored with the similarity function
// its authors trained and published it for: bge-m3 and its descendants are
// cosine models (and TEI normalizes them), while MedCPT / SPECTER2 / SciNCL are
// dot-product models over raw [CLS] vectors. Normalizing before a dot product
// changes the ranking whenever document norms vary, so scoring MedCPT with
// cosine would quietly report a number that is not MedCPT's.
//   cosine -> pgvector <=> , HNSW vector_cosine_ops , worker NORMALIZE=1
//   ip     -> pgvector <#> , HNSW vector_ip_ops     , worker NORMALIZE=0
export const OPS = { cosine: '<=>', ip: '<#>' }
export const REGISTRY = {
  fts:        { kind: 'fts' },
  'bge-m3':   { kind: 'dense', table: 'preprint_embeddings',           dim: 1024, metric: 'cosine', doc: 'BAAI/bge-m3',                 query: 'BAAI/bge-m3' },
  cshl:       { kind: 'dense', table: 'preprint_embeddings_cshl',      dim: 1024, metric: 'cosine', doc: 'NYSgpt/cshl-encoder-bge-m3',  query: 'NYSgpt/cshl-encoder-bge-m3' },
  cshl_qp:    { kind: 'dense', table: 'preprint_embeddings_cshl_qp',   dim: 1024, metric: 'cosine', doc: 'cshl-encoder-bge-m3 (qpairs run)', query: 'cshl-encoder-bge-m3 (qpairs run)' },
  medcpt:     { kind: 'dense', table: 'preprint_embeddings_medcpt',    dim: 768,  metric: 'ip',     doc: 'ncbi/MedCPT-Article-Encoder', query: 'ncbi/MedCPT-Query-Encoder' },
  specter2:   { kind: 'dense', table: 'preprint_embeddings_specter2',  dim: 768,  metric: 'ip',     doc: 'allenai/specter2_base',       query: 'allenai/specter2_base' },
  scincl:     { kind: 'dense', table: 'preprint_embeddings_scincl',    dim: 768,  metric: 'ip',     doc: 'malteos/scincl',              query: 'malteos/scincl' },
}

const sql = neon(process.env.DATABASE_URL_UNPOOLED)
const q = (t, p = []) => sql.query(t, p)

async function pool(items, conc, fn) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: conc }, async () => {
    for (;;) { const idx = i++; if (idx >= items.length) return; out[idx] = await fn(items[idx], idx) }
  }))
  return out
}
async function withRetry(fn, tries = 4) {
  for (let a = 1; ; a++) {
    try { return await fn() } catch (e) { if (a >= tries) throw e; await new Promise((r) => setTimeout(r, 300 * a)) }
  }
}

const loadQueries = () => readFileSync(join(ROOT, 'queries.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
function loadQrels() {
  const map = new Map()
  for (const line of readFileSync(join(ROOT, 'qrels.tsv'), 'utf8').split('\n').filter(Boolean)) {
    const [qid, key] = line.split('\t')
    if (!map.has(qid)) map.set(qid, new Set())
    map.get(qid).add(key)
  }
  return map
}

// ── metrics ──────────────────────────────────────────────────────────────────
function metricsFor(ranked, positives) {
  let firstRank = Infinity
  for (let i = 0; i < ranked.length; i++) if (positives.has(ranked[i])) { firstRank = i + 1; break }
  const recallAt = (k) => (ranked.slice(0, k).some((id) => positives.has(id)) ? 1 : 0)
  const idealRel = Math.min(positives.size, 10)
  const idcg = Array.from({ length: idealRel }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0)
  const dcg = ranked.slice(0, 10).reduce((s, id, i) => s + (positives.has(id) ? 1 / Math.log2(i + 2) : 0), 0)
  return {
    r1: recallAt(1), r5: recallAt(5), r10: recallAt(10), r50: recallAt(50),
    mrr: Number.isFinite(firstRank) ? 1 / firstRank : 0,
    ndcg10: idcg > 0 ? dcg / idcg : 0,
  }
}
export const era = (y) => (y == null ? 'unknown' : y < 2020 ? 'pre2020' : y < 2023 ? '2020-2022' : '2023+')
export const lenBand = (n) => (n < 1000 ? 'short' : n < 2500 ? 'medium' : 'long')
const segmentsFor = (q) => ['blended', `server:${q.server}`, `era:${era(q.pub_year)}`, `published:${q.published ? 'yes' : 'no'}`, `abstract:${lenBand(q.abs_len)}`]

function aggregate(perQuery, queries) {
  const byFamily = {}
  const M = ['r1', 'r5', 'r10', 'r50', 'mrr', 'ndcg10']
  for (const qq of queries) {
    const m = perQuery.get(qq.qid)
    if (!m) continue
    byFamily[qq.family] ??= {}
    for (const seg of segmentsFor(qq)) {
      byFamily[qq.family][seg] ??= Object.fromEntries([['n', 0], ...M.map((k) => [k, 0])])
      const acc = byFamily[qq.family][seg]
      acc.n++
      for (const k of M) acc[k] += m[k]
    }
  }
  for (const f of Object.keys(byFamily)) for (const s of Object.keys(byFamily[f])) {
    const acc = byFamily[f][s]
    for (const k of M) acc[k] = +(acc[k] / acc.n).toFixed(4)
  }
  return byFamily
}
const percentile = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null }

// ── arm runners ──────────────────────────────────────────────────────────────
// FTS: the production weighted path (preprints.fts), restricted to the arm
// universe only if a dense table is named — otherwise the whole corpus.
async function runFts(queries) {
  let fallbacks = 0
  const latencies = []
  const perQuery = new Map()
  await pool(queries, CONC, async (qq) => {
    const t0 = Date.now()
    let rows = await withRetry(() => q(
      `SELECT key_number FROM preprints
        WHERE fts @@ websearch_to_tsquery('english', $1)
        ORDER BY ts_rank_cd(fts, websearch_to_tsquery('english', $1)) DESC LIMIT ${TOPK}`, [qq.text]))
    if (!rows.length) {
      const [{ is_empty }] = await withRetry(() => q(`SELECT (websearch_to_tsquery('english', $1) = ''::tsquery) AS is_empty`, [qq.text]))
      if (is_empty) {
        fallbacks++
        const words = qq.text.split(/\s+/).filter((w) => w.length > 2).slice(0, 24).join(' ')
        rows = await withRetry(() => q(
          `SELECT key_number FROM preprints WHERE fts @@ plainto_tsquery('english', $1)
            ORDER BY ts_rank_cd(fts, plainto_tsquery('english', $1)) DESC LIMIT ${TOPK}`, [words]))
      }
    }
    latencies.push(Date.now() - t0)
    perQuery.set(qq.qid, rows.map((r) => r.key_number))
  })
  console.log(`  fts: websearch-empty fallback used ${fallbacks}/${queries.length}`)
  return { perQuery, latencies, extra: { fallbacks_used: fallbacks } }
}

function loadQueryEmbeddings(arm) {
  const f = join(QEMB, `${arm}.jsonl`)
  if (!existsSync(f)) throw new Error(`no query embeddings for arm '${arm}' — run scripts/eval/embed-queries.mjs ARM=${arm} first (${f})`)
  const map = new Map()
  for (const l of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    const o = JSON.parse(l)
    map.set(o.qid, `[${o.v.join(',')}]`)
  }
  return map
}

async function runDense(arm, queries) {
  const spec = REGISTRY[arm]
  const OP = OPS[spec.metric ?? 'cosine']
  const emb = loadQueryEmbeddings(arm)
  const [{ n: corpusN }] = await q(`SELECT count(*)::int AS n FROM ${spec.table}`)
  console.log(`  ${arm}: corpus ${corpusN} vectors (dim ${spec.dim}, metric ${spec.metric ?? 'cosine'} ${OP}), ${emb.size} query vectors`)

  const probe = queries.find((qq) => emb.has(qq.qid))
  if (probe) {
    const plan = await q(`EXPLAIN SELECT key_number FROM ${spec.table} ORDER BY embedding ${OP} $1::vector LIMIT ${TOPK}`, [emb.get(probe.qid)])
    // Truncate hard: EXPLAIN echoes the bound parameter, which is a 768- or
    // 1024-dimension vector. Printing it in full buries the one word that
    // matters (whether the planner used the index) under 40 KB of floats.
    const text = plan.map((r) => Object.values(r)[0]).join(' | ').replace(/'\[[^\]]*\]'::vector/g, "'<vec>'::vector")
    const ok = text.includes('Index Scan')
    console.log(`  ${arm} plan: ${ok ? 'Index Scan CONFIRMED' : 'WARNING no Index Scan — ' + text.slice(0, 200)}`)
  }
  const latencies = []
  const perQuery = new Map()
  await pool(queries, CONC, async (qq) => {
    const v = emb.get(qq.qid)
    if (!v) return
    const t0 = Date.now()
    const res = await withRetry(() => sql.transaction([
      sql.query(`SET LOCAL hnsw.ef_search = ${process.env.EF_SEARCH ?? 100}`),
      sql.query(`SELECT key_number FROM ${spec.table} ORDER BY embedding ${OP} $1::vector LIMIT ${TOPK}`, [v]),
    ]))
    latencies.push(Date.now() - t0)
    perQuery.set(qq.qid, res[1].map((r) => r.key_number))
  })
  return { perQuery, latencies, extra: { corpus_vectors: corpusN, dim: spec.dim, metric: spec.metric ?? 'cosine', doc_model: spec.doc, query_model: spec.query } }
}

const rrf = (lists, k = 60) => {
  const s = new Map()
  for (const list of lists) list?.forEach((id, i) => s.set(id, (s.get(id) ?? 0) + 1 / (k + i + 1)))
  return [...s.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOPK).map(([id]) => id)
}

// rerank:<base>@<tei-base-url> — cross-encoder over the base arm's top-K.
async function runRerank(baseRanked, queries, url, key, poolSize) {
  const perQuery = new Map()
  const latencies = []
  const docs = new Map()
  const need = [...new Set([...baseRanked.values()].flatMap((r) => r.slice(0, poolSize)))]
  for (let i = 0; i < need.length; i += 5000) {
    const rows = await q(`SELECT key_number, left(trim(coalesce(title,'') || E'\n\n' || coalesce(abstract,'')), 900) AS t FROM preprints WHERE key_number = ANY($1)`, [need.slice(i, i + 5000)])
    for (const r of rows) docs.set(r.key_number, r.t)
  }
  await pool(queries, 4, async (qq) => {
    const base = baseRanked.get(qq.qid)
    if (!base?.length) return
    const cand = base.slice(0, poolSize)
    const t0 = Date.now()
    const r = await fetch(`${url.replace(/\/$/, '')}/rerank`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ query: qq.text.slice(0, 600), texts: cand.map((k2) => docs.get(k2) ?? ''), truncate: true }),
    })
    if (!r.ok) throw new Error(`rerank ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const scored = await r.json()
    const order = scored.sort((a, b) => b.score - a.score).map((s) => cand[s.index])
    latencies.push(Date.now() - t0)
    perQuery.set(qq.qid, [...order, ...base.slice(poolSize)].slice(0, TOPK))
  })
  return { perQuery, latencies, extra: { pool: poolSize, endpoint: url.replace(/\/\/.*@/, '//') } }
}

// ── main ─────────────────────────────────────────────────────────────────────
// Guarded: this file is also the arm registry, imported by embed-queries.mjs and
// coverage-gate.mjs. Without this, importing REGISTRY runs a full scoring job —
// which is how a coverage assertion ends up failing on a missing benchmark file
// instead of telling you about your corpus.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let queries = loadQueries()
  if (process.env.LIMIT) {
    const n = Number(process.env.LIMIT)
    const byFam = new Map()
    queries = queries.filter((qq) => { const c = byFam.get(qq.family) ?? 0; if (c >= n) return false; byFam.set(qq.family, c + 1); return true })
  }
  const qrels = loadQrels()
  console.log(`${VERSION}: ${queries.length} queries, ${qrels.size} qrels groups`)

  const requested = (process.env.ARMS ?? 'fts').split(',').map((s) => s.trim()).filter(Boolean)
  const ranked = new Map() // arm -> Map(qid -> ranked keys)

  for (const arm of requested) {
    console.log(`=== ${arm} ===`)
    let res
    try {
      if (arm.startsWith('rrf:')) {
        const parts = arm.slice(4).split('+')
        const missing = parts.filter((p) => !ranked.has(p))
        if (missing.length) { console.log(`  skipped — needs ${missing.join(', ')} scored first (put them earlier in ARMS)`); continue }
        const perQuery = new Map()
        for (const qq of queries) perQuery.set(qq.qid, rrf(parts.map((p) => ranked.get(p).get(qq.qid))))
        res = { perQuery, latencies: [], extra: { fused: parts, k: 60 } }
      } else if (arm.startsWith('rerank:')) {
        const [base, url] = arm.slice(7).split('@')
        if (!ranked.has(base)) { console.log(`  skipped — needs ${base} scored first`); continue }
        res = await runRerank(ranked.get(base), queries, url, process.env.NSR_SERVE_KEY ?? process.env.HF_TOKEN ?? '', Number(process.env.RERANK_POOL ?? 20))
      } else if (REGISTRY[arm]?.kind === 'fts') {
        res = await runFts(queries)
      } else if (REGISTRY[arm]?.kind === 'dense') {
        res = await runDense(arm, queries)
      } else {
        console.log(`  unknown arm '${arm}' — registry has: ${Object.keys(REGISTRY).join(', ')} (+ rrf:A+B, rerank:A@url)`); continue
      }
    } catch (e) {
      console.log(`  ${arm} FAILED: ${e.message}`)   // a dead arm costs one arm, not the run
      continue
    }
    ranked.set(arm, res.perQuery)
    const perQ = new Map([...res.perQuery].map(([qid, r]) => [qid, metricsFor(r, qrels.get(qid) ?? new Set())]))
    const out = {
      arm, version: VERSION, scored_at: new Date().toISOString(),
      n_queries: res.perQuery.size, topk: TOPK,
      end_to_end_latency_ms: { p50: percentile(res.latencies, 50), p95: percentile(res.latencies, 95) },
      ...res.extra,
      metrics: aggregate(perQ, queries),
    }
    writeFileSync(join(RESULTS, `${arm.replace(/[^a-zA-Z0-9._+-]/g, '_')}.json`), JSON.stringify(out, null, 2))
    // Per-query hit vectors, so two arms can be compared PAIRED rather than by
    // eyeballing two aggregate numbers. score-docdoc.mjs has always written
    // these; the query->doc side did not, which is why the report's headline
    // comparison had no significance test attached to it. Keyed by qid and
    // ordered by the benchmark, so scripts/eval/paired-test.mjs can assert the
    // pairing instead of assuming it.
    const ordered = queries.filter((qq) => res.perQuery.has(qq.qid))
    writeFileSync(join(RESULTS, `${arm.replace(/[^a-zA-Z0-9._+-]/g, '_')}.perquery.json`),
      JSON.stringify({ arm, version: VERSION,
        keys: ordered.map((qq) => qq.qid),
        family: ordered.map((qq) => qq.family),
        hits10: ordered.map((qq) => perQ.get(qq.qid).r10) }))
    for (const [fam, segs] of Object.entries(out.metrics)) {
      console.log(`  ${fam} blended: R@1 ${segs.blended.r1} R@10 ${segs.blended.r10} nDCG@10 ${segs.blended.ndcg10} (n=${segs.blended.n})`)
    }
    console.log(`  wrote results/${arm}.json`)
  }
  console.log('=== scoring complete ===')

}
