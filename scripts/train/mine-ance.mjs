#!/usr/bin/env node
// mine-ance.mjs — ANCE-style hard-negative re-mining. PRE-STAGED, NOT FIRED.
//
// STATUS: this is the last lever, drafted and smoke-tested under LANE-WIN on
// the lead's instruction. A full mine and any retrain built on its output are
// **Brendan's call only**. The script refuses to write into data/train/ unless
// ALLOW_TRAIN_WRITE=1 is set explicitly, so an accidental invocation cannot
// quietly produce something a launcher would pick up.
//
// WHAT IT DOES. The negatives in cshl-query-pairs were mined by lane-mine
// against a model that is not the model we now have. ANCE's observation is that
// the negatives worth training on are the ones the CURRENT model ranks highly
// and is wrong about — a negative the model already scores near zero
// contributes almost no gradient. So: retrieve top-K for each training query
// with the current encoder, strike out everything that is actually a positive,
// and keep what is left as the new negatives.
//
// WHAT MAKES IT DANGEROUS, stated up front because this is the failure mode
// that makes ANCE-style mining silently worse rather than loudly broken:
//
//   FALSE NEGATIVES. The corpus has 433,449 papers and each benchmark query has
//   ~1 known gold. The rank-2 result for "Myosin; Muscular Contraction" is very
//   often a genuinely relevant paper that simply was not labelled. Training on
//   it as a negative teaches the model that a correct answer is wrong. This is
//   not hypothetical — it is the standard reason naive ANCE rounds regress.
//   Mitigation here is SKIP_TOP (default 5): the top-N retrieved are DISCARDED
//   rather than used, on the assumption that the model's most confident
//   non-golds are the most likely to be unlabelled positives. SKIP_TOP=0
//   reproduces naive ANCE, and is available so the difference can be measured
//   rather than argued.
//
// GATES, all of them re-derived here rather than inherited:
//   - every retrieved key is checked against the query's own gold set AND
//     against the frozen benchmark's ENTIRE gold set. A mined negative that is
//     a held-out paper would put the benchmark into training.
//   - the positive itself can never be a negative.
//   - a query that ends up with fewer than MIN_NEGS usable negatives is
//     dropped, counted, and reported — never padded.
//   - SMOKE=1 forces LIMIT, forbids writing under data/train/, and prints the
//     distributions instead of claiming success.
//
// Usage — the smoke test that was actually run (read-only, no GPU, $0):
//   SMOKE=1 LIMIT=200 ARM=cshl_qp \
//     QVEC=data/eval/cshl-eval-2k/qemb/cshl_qp.jsonl \
//     QMETA=data/eval/cshl-eval-2k \
//     node scripts/train/mine-ance.mjs
//
// Usage — the real mine (NOT RUN; needs 100k training-query vectors from a TEI
// box serving the current checkpoint, which is a GPU box and therefore spend):
//   ARM=cshl_qp2 QVEC=<100k training-query vectors>.jsonl \
//     QMETA=data/train/qpairs2/train.jsonl OUT=data/train/qpairs3/train.jsonl \
//     ALLOW_TRAIN_WRITE=1 node scripts/train/mine-ance.mjs
import { neon } from '@neondatabase/serverless'
import { readFileSync, writeFileSync, mkdirSync, createReadStream, createWriteStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, dirname } from 'node:path'
import { REGISTRY, OPS } from '../eval/score.mjs'

for (const l of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
}
const url = process.env.DATABASE_URL_UNPOOLED
if (!url.replace(/^[^@]+@/, '').startsWith('ep-orange-water-aut2eymf.')) throw new Error('FENCE FAIL: not the CSHL endpoint')

const ARM      = process.env.ARM ?? 'cshl_qp'
const QVEC     = process.env.QVEC ?? (() => { throw new Error('set QVEC=<jsonl of {qid,v}>') })()
const QMETA    = process.env.QMETA ?? (() => { throw new Error('set QMETA=<benchmark dir | train.jsonl>') })()
const TOPK     = Number(process.env.TOPK ?? 100)
const NEGS     = Number(process.env.NEGS ?? 8)
const MIN_NEGS = Number(process.env.MIN_NEGS ?? 4)
const SKIP_TOP = Number(process.env.SKIP_TOP ?? 5)
const CONC     = Number(process.env.CONC ?? 8)
const SMOKE    = process.env.SMOKE === '1'
const LIMIT    = Number(process.env.LIMIT ?? (SMOKE ? 200 : 0))
const EVAL_DIR = process.env.EVAL_DIR ?? 'data/eval/cshl-eval-v1'
const TEXTS    = process.env.TEXTS ?? 'data/mine/corpus-text.jsonl'
const OUT      = process.env.OUT ?? (SMOKE ? 'data/tmp/ance-smoke/train.jsonl' : (() => { throw new Error('set OUT') })())

const spec = REGISTRY[ARM]
if (!spec?.table) throw new Error(`ARM '${ARM}' is not a dense arm in the registry`)
// The write fence. data/train/ is what upload-slice.sh reaches for.
if (OUT.replace(/\\/g, '/').includes('data/train/') && process.env.ALLOW_TRAIN_WRITE !== '1') {
  throw new Error(`REFUSING to write a training slice to ${OUT} without ALLOW_TRAIN_WRITE=1 — a full mine and any retrain on it are Brendan's call, not this script's`)
}
if (SMOKE && OUT.replace(/\\/g, '/').includes('data/train/')) throw new Error('SMOKE=1 may not write under data/train/')

const sql = neon(url)
const OP = OPS[spec.metric ?? 'cosine']

// ── the frozen benchmark's gold papers: the hard disjointness gate ───────────
const evalKeys = new Set()
for (const l of readFileSync(join(EVAL_DIR, 'qrels.tsv'), 'utf8').split('\n')) { const k = l.split('\t')[1]; if (k) evalKeys.add(k) }
if (evalKeys.size === 0) throw new Error(`ABORT: 0 gold papers loaded from ${EVAL_DIR}/qrels.tsv — a gate that loads nothing rejects nothing`)
console.log(`frozen benchmark gold papers (hard gate): ${evalKeys.size.toLocaleString()}`)

// ── queries: {qid -> {text, gold:Set, pos:key|null}} ────────────────────────
// Two shapes, both named, because guessing is how the last converter broke:
//   a benchmark DIRECTORY  -> queries.jsonl + qrels.tsv  (smoke-test source)
//   a train.jsonl FILE     -> {query, pos:[text], neg:[…]} (the real source)
const meta = new Map()
let metaShape
if (existsSync(join(QMETA, 'queries.jsonl'))) {
  metaShape = 'benchmark-dir'
  const gold = new Map()
  for (const l of readFileSync(join(QMETA, 'qrels.tsv'), 'utf8').split('\n').filter(Boolean)) {
    const [qid, key] = l.split('\t'); if (!gold.has(qid)) gold.set(qid, new Set()); gold.get(qid).add(key)
  }
  for (const l of readFileSync(join(QMETA, 'queries.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    const o = JSON.parse(l); meta.set(o.qid, { text: o.text, gold: gold.get(o.qid) ?? new Set(), family: o.family })
  }
} else if (QMETA.replace(/\\/g, '/').endsWith('slice-slugs.jsonl')) {
  // THE SHAPE THIS SCRIPT SHOULD ALWAYS HAVE BEEN GIVEN (LANE-QP3).
  //
  // The `train-jsonl` branch below builds `gold: new Set()` — an EMPTY gold set
  // — because a FlagEmbedding train.jsonl is text-only and carries no paper
  // identity. Every gate in this file that reads `m.gold` therefore rejects
  // NOTHING on that path: `stats.gold_struck` stays 0 and a query's OWN
  // POSITIVE, which the current encoder ranks at or near 1 by construction, is
  // eligible to be emitted as that query's hard negative. Training on that
  // teaches the model that the right answer is wrong — the exact failure this
  // file's header warns about, arriving through the door the header left open.
  // The smoke test never saw it: it ran the benchmark-dir branch, where gold is
  // populated, so the gate it demonstrated is not the gate the real mine used.
  //
  // from-mine.mjs now emits slice-slugs.jsonl beside every train.jsonl, row for
  // row, carrying the positive's slug and the original negatives. With it the
  // own-positive gate is real, and rows the mine cannot serve keep the
  // negatives they already had instead of vanishing from the slice.
  metaShape = 'slice-slugs'
  const rl = createInterface({ input: createReadStream(QMETA), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line) continue
    const o = JSON.parse(line)
    meta.set(`T-${o.i}`, { text: o.query, gold: new Set([o.pos]), family: o.family, posSlug: o.pos, origNeg: o.neg ?? [] })
  }
} else {
  metaShape = 'train-jsonl'
  let i = 0
  const rl = createInterface({ input: createReadStream(QMETA), crlfDelay: Infinity })
  for await (const line of rl) { if (!line) continue; const o = JSON.parse(line); meta.set(`T-${i++}`, { text: o.query, gold: new Set(), posText: o.pos?.[0] }) }
  console.warn('WARNING: train-jsonl shape — no paper identity, so the own-positive gate cannot fire. Prefer slice-slugs.jsonl.')
}
console.log(`query metadata: ${meta.size.toLocaleString()} (${metaShape})`)

// ── query vectors ───────────────────────────────────────────────────────────
const qvec = new Map()
{
  const rl = createInterface({ input: createReadStream(QVEC), crlfDelay: Infinity })
  for await (const line of rl) { if (!line) continue; const o = JSON.parse(line); qvec.set(o.qid, o.v) }
}
console.log(`query vectors: ${qvec.size.toLocaleString()} from ${QVEC}`)
let ids = [...qvec.keys()].filter((k) => meta.has(k))
if (ids.length === 0) throw new Error(`ABORT: no qid in ${QVEC} matches ${QMETA} — the qid-namespace trap (see LANE-QPAIRS-RUN 00:35Z). Nothing mined.`)
console.log(`joined on qid: ${ids.length.toLocaleString()} of ${qvec.size.toLocaleString()} vectors (${qvec.size - ids.length} unmatched)`)
ids.sort()                                  // deterministic
if (LIMIT) ids = ids.slice(0, LIMIT)
console.log(`mining ${ids.length.toLocaleString()} queries against ${spec.table} (${spec.metric} ${OP}), top ${TOPK}, skip_top ${SKIP_TOP}, want ${NEGS} negatives\n`)

async function pool(items, conc, fn) {
  const out = new Array(items.length); let i = 0
  await Promise.all(Array.from({ length: conc }, async () => { for (;;) { const k = i++; if (k >= items.length) return; out[k] = await fn(items[k]) } }))
  return out
}

// ── retrieve, strike, keep ──────────────────────────────────────────────────
const stats = { gold_struck: 0, eval_struck: 0, skipped_top: 0, kept: 0, short: 0, gold_rank_hist: {},
                ance_by_family: {}, fallback_by_family: {} }
// Progress, because a 140k mine is otherwise ~20 minutes of total silence on an
// unattended box, and silence is indistinguishable from a hang. Rate is also the
// Neon-load number D8 asks to be logged, measured rather than estimated.
let done = 0
const t0 = Date.now()
const tick = () => {
  if (++done % 5000 && done !== ids.length) return
  const s = (Date.now() - t0) / 1000
  console.log(`  [mine] ${done.toLocaleString()}/${ids.length.toLocaleString()} · ${(done / s).toFixed(0)} q/s · ${s.toFixed(0)}s elapsed · eta ${((ids.length - done) / (done / s) / 60).toFixed(1)} min`)
}
const mined = await pool(ids, CONC, async (qid) => {
  const m = meta.get(qid)
  const v = `[${qvec.get(qid).join(',')}]`
  const rows = await sql.transaction([
    sql.query(`SET LOCAL hnsw.ef_search = ${process.env.EF_SEARCH ?? 200}`),
    sql.query(`SELECT key_number FROM ${spec.table} ORDER BY embedding ${OP} $1::vector LIMIT ${TOPK}`, [v]),
  ])
  const ranked = rows[1].map((r) => r.key_number)
  for (let i = 0; i < ranked.length; i++) if (m.gold.has(ranked[i])) { const b = i < 10 ? `top${i + 1}` : i < 50 ? '11-50' : '51-100'; stats.gold_rank_hist[b] = (stats.gold_rank_hist[b] ?? 0) + 1; break }
  const neg = []
  for (let i = 0; i < ranked.length; i++) {
    const k = ranked[i]
    if (m.gold.has(k)) { stats.gold_struck++; continue }      // a labelled positive is never a negative
    if (evalKeys.has(k)) { stats.eval_struck++; continue }    // held-out paper: never into training
    if (i < SKIP_TOP) { stats.skipped_top++; continue }        // likely-unlabelled positive
    neg.push(k)
    if (neg.length >= NEGS) break
  }
  const base = { qid, text: m.text, family: m.family, posText: m.posText, posSlug: m.posSlug,
                 gold: [...m.gold], origNeg: m.origNeg ?? [] }
  const fam = m.family ?? 'MIXED'
  // D8: "ANCE negatives wherever mined; existing negatives elsewhere." A row the
  // mine cannot serve is NOT dropped — dropping it would silently shrink the
  // slice and break the FAMILY_TAKE mix that was verified when it was built.
  // It keeps the negatives from-mine.mjs already gated, and is counted as such.
  tick()
  if (neg.length < MIN_NEGS) {
    stats.short++
    if (base.origNeg.length) { stats.fallback_by_family[fam] = (stats.fallback_by_family[fam] ?? 0) + 1; return { ...base, neg: [], ance: false } }
    return null
  }
  stats.kept++
  stats.ance_by_family[fam] = (stats.ance_by_family[fam] ?? 0) + 1
  return { ...base, neg, ance: true }
})
const ok = mined.filter(Boolean)

console.log(`retrieved ${ids.length.toLocaleString()} x top-${TOPK}`)
console.log(`  struck: ${stats.gold_struck.toLocaleString()} own-gold · ${stats.eval_struck.toLocaleString()} frozen-benchmark gold · ${stats.skipped_top.toLocaleString()} discarded as likely-unlabelled (SKIP_TOP=${SKIP_TOP})`)
console.log(`  kept ${stats.kept.toLocaleString()} queries with >= ${MIN_NEGS} negatives · dropped ${stats.short.toLocaleString()} for too few`)
console.log(`  where the labelled gold landed: ${JSON.stringify(stats.gold_rank_hist)}`)
const negCounts = {}; for (const r of ok) if (r.ance) negCounts[r.neg.length] = (negCounts[r.neg.length] ?? 0) + 1
console.log(`  ANCE negatives/row: ${JSON.stringify(negCounts)}`)
console.log(`  rows on ANCE negatives:     ${JSON.stringify(stats.ance_by_family)}`)
console.log(`  rows on inherited negatives:${JSON.stringify(stats.fallback_by_family)}`)

// Independent re-check of the gate over the FINAL emitted set, not over the
// per-row decisions that produced it.
// Checked over EVERY slug that can reach the output — the mined negatives AND
// the inherited ones AND the positive — not only over the mined side.
const leaks = ok.reduce((n, r) => n + r.neg.filter((k) => evalKeys.has(k)).length
                                   + (r.ance ? 0 : r.origNeg.filter((k) => evalKeys.has(k)).length)
                                   + (r.posSlug && evalKeys.has(r.posSlug) ? 1 : 0), 0)
console.log(`  emitted negatives referencing frozen-benchmark gold papers: ${leaks} (must be 0)`)
if (leaks > 0) { console.error('ABORT: mined negatives touch the frozen benchmark.'); process.exit(1) }

if (SMOKE) {
  console.log(`\nSMOKE=1 — read-only. No training file written, no GPU used, no retrain implied.`)
  console.log(`Sample of what a real mine would emit (query -> first 3 mined negatives):`)
  for (const r of ok.slice(0, 3)) console.log(`  "${(r.text ?? '').slice(0, 70)}" -> ${r.neg.slice(0, 3).join(', ')}`)
  process.exit(0)
}

// ── real mine: resolve text and write the FlagEmbedding slice ───────────────
// EVERY slug that can reach the output, including the inherited negatives of
// rows that DID mine successfully — those are the fallback, and a fallback whose
// text was never loaded is not a fallback. The fixture smoke test showed this
// precisely: 35 rows whose ANCE negatives had no text fell through to
// `unwritable` with `fell back: 0`, because `need` had skipped their origNeg.
const need = new Set(ok.flatMap((r) => [...r.neg, ...r.origNeg, ...(r.posSlug ? [r.posSlug] : [])]))
const text = new Map()
{
  const rl = createInterface({ input: createReadStream(TEXTS), crlfDelay: Infinity })
  for await (const line of rl) { if (!line) continue; const o = JSON.parse(line); if (o.embed_text && need.has(o.key)) text.set(o.key, o.embed_text) }
}
mkdirSync(dirname(OUT), { recursive: true })
let written = 0, unresolved = 0, posAsNeg = 0, anceUnresolved = 0
const writtenBy = { ance: {}, inherited: {} }
// Backpressure honoured — same bug, same reason as from-mine.mjs's writer:
// 140k rows x ~10 documents is ~2.2 GB, and ignoring ws.write()'s false return
// buffers the lot until one writev() fails at 2^32 bytes, having already
// written duplicated garbage. Measured on this exact slice size tonight.
{
  const ws = createWriteStream(OUT)
  const done = new Promise((res, rej) => { ws.on('error', rej); ws.on('finish', res) })
  for (const r of ok) {
    // Resolve ANCE negatives to text, and FALL BACK to the inherited negatives
    // if too few of them resolve. Without this fallback a row whose mined
    // negatives are not in the text sidecar is dropped silently, and the slice
    // comes out smaller than the FAMILY_TAKE mix that was verified when it was
    // built — 140,000 requested, fewer trained on, nothing saying so. Caught by
    // the fixture smoke test, where a deliberately partial sidecar turned 210
    // rows into 1 and the script still exited 0.
    let neg = (r.ance ? r.neg : r.origNeg).map((k) => text.get(k)).filter(Boolean)
    let usedAnce = r.ance
    if (neg.length < MIN_NEGS && r.ance) {
      const fb = r.origNeg.map((k) => text.get(k)).filter(Boolean)
      if (fb.length >= MIN_NEGS) { neg = fb; usedAnce = false; anceUnresolved++ }
    }
    const posText = r.posText ?? (r.posSlug ? text.get(r.posSlug) : null)
    if (!posText || neg.length < MIN_NEGS) { unresolved++; continue }
    // REPAIR, don't discard. A negative whose TEXT equals the positive's is a
    // different paper carrying identical embed_text — 31 such pairs exist in the
    // 433,449-row corpus, measured. The slug-level gate cannot see it because the
    // slugs genuinely differ. Dropping that one negative fixes the row; dropping
    // the ROW costs a training pair and, worse, silently changes the FAMILY_TAKE
    // mix that was verified upstream. It happened once in 140,000 on the first
    // full run and aborted a 33-minute box at its last step.
    if (neg.some((t) => t === posText)) {
      posAsNeg++
      neg = neg.filter((t) => t !== posText)
      if (neg.length < MIN_NEGS) { unresolved++; continue }
    }
    if (!ws.write(JSON.stringify({ query: r.text, pos: [posText], neg }) + '\n')) await new Promise((d) => ws.once('drain', d))
    written++
    writtenBy[usedAnce ? 'ance' : 'inherited'][r.family ?? 'MIXED'] = (writtenBy[usedAnce ? 'ance' : 'inherited'][r.family ?? 'MIXED'] ?? 0) + 1
  }
  ws.end()
  await done
}
writeFileSync(join(dirname(OUT), 'manifest.json'), JSON.stringify({
  name: 'ance-remined', built_at: new Date().toISOString(), source_arm: ARM, source_table: spec.table,
  qvec: QVEC, qmeta: QMETA, topk: TOPK, skip_top: SKIP_TOP, negs_per_pair: NEGS, min_negs: MIN_NEGS,
  pairs: written, stats,
  negatives_source: writtenBy,
  rows_unwritable_for_missing_text: unresolved,
  rows_fell_back_because_ance_negatives_had_no_text: anceUnresolved,
  rows_repaired_positive_appeared_as_negative: posAsNeg,
  disjointness: { pass: leaks === 0, checked_against: join(EVAL_DIR, 'qrels.tsv'),
                  frozen_benchmark_papers: evalKeys.size, emitted_references_to_gold_papers: leaks },
}, null, 2))
console.log(`\nwrote ${written.toLocaleString()} pairs -> ${OUT}`)
console.log(`  by negatives source: ANCE ${JSON.stringify(writtenBy.ance)} · inherited ${JSON.stringify(writtenBy.inherited)}`)
console.log(`  fell back to inherited negatives because ANCE text was missing: ${anceUnresolved}`)
console.log(`  unwritable for missing text: ${unresolved} (must be 0) · rows repaired by dropping a negative whose text equals the positive: ${posAsNeg}`)
console.log(`  ACCOUNTING: written ${written.toLocaleString()} + unwritable ${unresolved} = ${(written + unresolved).toLocaleString()} of ${ok.length.toLocaleString()} mined rows`)
