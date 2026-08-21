#!/usr/bin/env node
// from-mine.mjs — lane-mine's mined records -> FlagEmbedding train.jsonl.
//
// TWO record shapes, both from lane-mine, and they differ on the query side:
//
//   cshl-triplets      (CITE, doc->doc):
//     {"query":{"slug":…},"positive":{"slug":…},"negatives":[{"slug":…}],"meta":{"family":"CITE"}}
//   cshl-query-pairs   (MESH / AUTHORKW / EXTRACT, query->doc):
//     {"query":"Muscular Contraction; Myosin","positive":{"slug":…},"negatives":[…],"meta":{"family":…}}
//
// The query-pairs `query` is a LITERAL QUERY STRING, not a slug into the corpus
// — that is the entire point of the set, and it is why it is the right shape to
// train against a query->doc benchmark.
//
// This originally read `r.query.slug` unconditionally. Against query-pairs that
// is `undefined` on all 424,753 rows, so every row would have been counted as
// `dropped` and the converter would have written an EMPTY slice and printed a
// success line. Handled explicitly below, because a silent zero is this
// program's dominant failure mode.
//
// Document text comes from data/mine/corpus-text.jsonl's `embed_text`, which
// their assemble.mjs generates with MY recipeSql() — imported, not copied.
// Consuming that field rather than re-deriving locally is the whole point of the
// shared recipe: it is provably the string the encoder saw, because
// md5(embed_text) == preprint_embeddings.text_hash is asserted by their --verify.
//
// SUBSAMPLE=N takes a deterministic stratified slice by family. Sizing is a
// time decision, not a quality one — NSR's winning encoder trained on ~39.6k.
import { readFileSync, writeFileSync, mkdirSync, createReadStream, createWriteStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'

// IN accepts a COMMA-SEPARATED LIST of mine files (LANE-QP3). The families are
// mined into separate files by separate lanes — cshl-query-pairs.train.jsonl
// carries MESH/AUTHORKW/EXTRACT, cshl-oakw-pairs.train.jsonl carries OAKW —
// and FAMILY_TAKE is defined over families, not over files. Concatenating on
// disk would mean a 650 MB temp file whose only property is being a copy;
// reading the list in order is the same stream with nothing to go stale.
const IN = (process.env.IN ?? 'data/mine/cshl-triplets.train.jsonl').split(',').map((x) => x.trim()).filter(Boolean)
const TEXTS = process.env.TEXTS ?? 'data/mine/corpus-text.jsonl'
const NAME = process.env.NAME ?? 'parity'
const OUT = process.env.OUT ?? `data/train/${NAME}/train.jsonl`
const NEGS = Number(process.env.NEGS ?? 8)
const SUBSAMPLE = Number(process.env.SUBSAMPLE ?? 0)
// FAMILY_TAKE="MESH:55000,AUTHORKW:40000,EXTRACT:5000" — an EXACT per-family
// take, overriding SUBSAMPLE's proportional stratification.
//
// Why this exists: SUBSAMPLE takes each family in proportion to its size in the
// mined set, which for cshl-query-pairs is EXTRACT 61% / MESH 24% / AUTHORKW
// 15%. The benchmark is 62% MESH / 38% AUTHORKW and contains no EXTRACT at all,
// so the proportional take spends most of the training budget on the one family
// nobody is scored on. Last night's 40k slice carried only 5,854 AUTHORKW pairs
// and AUTHORKW is where we lose to MedCPT by the widest margin. Proportional is
// the right default for "a representative sample"; it is the wrong shape for
// "supervision aimed at a known benchmark", and that is a spec the caller has
// to be able to state, not a constant to be edited.
//
// Contract, deliberately unforgiving:
//   - every family named must exist and must have at least the requested count;
//   - families NOT named are dropped entirely (the spec is exact, not a floor);
//   - the emitted per-family counts are re-counted from the emitted set and
//     asserted against the spec, so "families_emitted matches the spec" is a
//     check rather than a claim. Any mismatch aborts non-zero.
// Order within a family is the same deterministic md5 sort SUBSAMPLE uses, so a
// FAMILY_TAKE of N is a prefix of a FAMILY_TAKE of N+1 — reruns are stable and
// two sizes are nested rather than disjoint.
const FAMILY_TAKE = (() => {
  const raw = (process.env.FAMILY_TAKE ?? '').trim()
  if (!raw) return null
  const spec = new Map()
  for (const part of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^([A-Za-z0-9_-]+):(\d+)$/)
    if (!m) { console.error(`ABORT: FAMILY_TAKE segment '${part}' is not <FAMILY>:<count>`); process.exit(1) }
    if (spec.has(m[1])) { console.error(`ABORT: FAMILY_TAKE names '${m[1]}' twice`); process.exit(1) }
    const n = Number(m[2])
    if (!(n > 0)) { console.error(`ABORT: FAMILY_TAKE '${part}' must request a positive count`); process.exit(1) }
    spec.set(m[1], n)
  }
  if (!spec.size) { console.error('ABORT: FAMILY_TAKE is set but parses to nothing'); process.exit(1) }
  return spec
})()
const EVAL_DIR = process.env.EVAL_DIR ?? 'data/eval/cshl-eval-v1'
const h32 = (s) => parseInt(createHash('md5').update(s).digest('hex').slice(0, 8), 16) / 0xffffffff

// 1. text sidecar -> Map(slug -> embed_text)
const text = new Map()
{
  const rl = createInterface({ input: createReadStream(TEXTS), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line) continue
    const o = JSON.parse(line)
    if (o.embed_text) text.set(o.key, o.embed_text)
  }
}
console.log(`text sidecar: ${text.size.toLocaleString()} slugs`)

// 2. the frozen benchmark's gold papers — nothing here may appear in training
const evalKeys = new Set()
try {
  for (const l of readFileSync(join(EVAL_DIR, 'qrels.tsv'), 'utf8').split('\n')) {
    const k = l.split('\t')[1]; if (k) evalKeys.add(k)
  }
} catch {}
console.log(`frozen benchmark gold papers: ${evalKeys.size.toLocaleString()}`)

// 2b. the frozen benchmark's QUERY STRINGS. Not a leak gate: the benchmark is
//     split by PAPER, deliberately, so a training pair may legitimately reuse a
//     query string as long as it points at a paper that is not held out (and
//     the gate above enforces that). Counted and disclosed rather than dropped,
//     because "how much query-string overlap is there" is a question a reader
//     of the results will ask, and it should not need re-deriving.
const evalQueryTexts = new Set()
try {
  for (const l of readFileSync(join(EVAL_DIR, 'queries.jsonl'), 'utf8').split('\n')) {
    if (!l) continue
    const t = JSON.parse(l).text
    if (t) evalQueryTexts.add(t.trim().toLowerCase())
  }
} catch {}
console.log(`frozen benchmark distinct query strings: ${evalQueryTexts.size.toLocaleString()}`)

// 3. convert. Streamed: cshl-query-pairs.train.jsonl is 290 MB, and
//    readFileSync().split() holds the whole file plus every substring at once.
let dropped = 0, leaked = 0, rows = 0, textQueries = 0, slugQueries = 0, queryTextCollisions = 0
const byFamily = new Map()
const unnamed = new Map()   // families excluded by FAMILY_TAKE: counted, not retained
for (const inFile of IN) {
  const before = rows
  const rl = createInterface({ input: createReadStream(inFile), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line) continue
    rows++
    const r = JSON.parse(line)
    // The two shapes, named. An unrecognised shape is a drop, never a silent pass.
    const qIsText = typeof r.query === 'string' && r.query.trim().length > 0
    const qs = qIsText ? null : r.query?.slug
    const ps = r.positive?.slug
    if ((!qIsText && !qs) || !ps) { dropped++; continue }
    // Cross-check against the FROZEN benchmark, not just their split assertion.
    // Two independent checks of the same property is the point. A text query has
    // no paper identity, so only the document side can be checked — which is
    // also the only side the paper-level holdout is defined over.
    if ((qs && evalKeys.has(qs)) || evalKeys.has(ps)) { leaked++; continue }
    const negs = (r.negatives ?? []).map((n) => n.slug).filter((s) => s && !evalKeys.has(s) && text.has(s)).slice(0, NEGS)
    const query = qIsText ? r.query.trim() : text.get(qs)
    const pos = text.get(ps)
    if (!query || !pos || negs.length < 2) { dropped++; continue }
    if (qIsText) { textQueries++; if (evalQueryTexts.has(query.toLowerCase())) queryTextCollisions++ } else slugQueries++
    const fam = r.meta?.family ?? 'MIXED'
    // A family FAMILY_TAKE does not name contributes nothing to the output — it
    // is reported as "-> 0" and dropped. Counting it without RETAINING it keeps
    // the log identical and the heap bounded: with OAKW's file in the input list
    // this skips 244,487 OATOPIC rows that would otherwise be materialised in
    // full and then thrown away, on a laptop where that margin is the run.
    if (FAMILY_TAKE && !FAMILY_TAKE.has(fam)) { unnamed.set(fam, (unnamed.get(fam) ?? 0) + 1); continue }
    if (!byFamily.has(fam)) byFamily.set(fam, [])
    // k: the deterministic stratification key. A text query has no slug, so key
    // on the query text + its positive — stable across runs, which is what
    // "deterministic subsample" has to mean.
    byFamily.get(fam).push({ k: qs ?? `${query}|${ps}`, s: [ps, ...negs], ps, negs, o: { query, pos: [pos], neg: negs.map((s) => text.get(s)) } })
  }
  console.log(`  ${inFile}: ${(rows - before).toLocaleString()} records read`)
}
const total = [...byFamily.values()].reduce((a, v) => a + v.length, 0)
console.log(`read ${rows.toLocaleString()} · convertible ${total.toLocaleString()} · dropped ${dropped.toLocaleString()} · rejected for touching the frozen benchmark ${leaked.toLocaleString()}`)
console.log(`query side: ${textQueries.toLocaleString()} literal-text · ${slugQueries.toLocaleString()} slug-into-corpus`)
if (total === 0) { console.error('ABORT: 0 convertible records — refusing to write an empty slice.'); process.exit(1) }

let out = []
const emitted = new Map()
if (FAMILY_TAKE) {
  console.log(`FAMILY_TAKE: ${[...FAMILY_TAKE].map(([f, n]) => `${f}:${n.toLocaleString()}`).join(' ')}`)
  const missing = [...FAMILY_TAKE.keys()].filter((f) => !byFamily.has(f))
  if (missing.length) { console.error(`ABORT: FAMILY_TAKE names families absent from the input: ${missing.join(', ')} (input has: ${[...byFamily.keys()].join(', ')})`); process.exit(1) }
  const short = [...FAMILY_TAKE].filter(([f, n]) => byFamily.get(f).length < n)
  if (short.length) { console.error(`ABORT: FAMILY_TAKE asks for more than exists: ${short.map(([f, n]) => `${f} wants ${n}, has ${byFamily.get(f).length}`).join('; ')}`); process.exit(1) }
  for (const [fam, n] of FAMILY_TAKE) {
    const arr = byFamily.get(fam)
    arr.sort((a, b) => h32(a.k) - h32(b.k))                    // deterministic, same rule as SUBSAMPLE
    out.push(...arr.slice(0, n))
    console.log(`  ${fam}: ${arr.length.toLocaleString()} -> ${n.toLocaleString()}`)
  }
  for (const [fam, n] of unnamed) console.log(`  ${fam}: ${n.toLocaleString()} -> 0 (not named in FAMILY_TAKE, skipped at read)`)
} else if (SUBSAMPLE && SUBSAMPLE < total) {
  for (const [fam, arr] of byFamily) {
    arr.sort((a, b) => h32(a.k) - h32(b.k))                    // deterministic
    const take = Math.max(1, Math.round((arr.length / total) * SUBSAMPLE))
    out.push(...arr.slice(0, take))
    console.log(`  ${fam}: ${arr.length.toLocaleString()} -> ${take.toLocaleString()}`)
  }
} else {
  for (const arr of byFamily.values()) out.push(...arr)
}
// 3b. Count families in what was EMITTED, not in what was read, and assert
//     disjointness over the emitted set after the fact rather than trusting the
//     per-record checks above to have covered it. `pass` is computed here; it
//     used to be a literal `true`, which is a claim, not a check.
let emittedCollisions = 0, emittedLeaks = 0
for (const [fam, arr] of byFamily) for (const x of arr) x.fam = fam
for (const x of out) {
  emitted.set(x.fam, (emitted.get(x.fam) ?? 0) + 1)
  for (const s of x.s) if (evalKeys.has(s)) emittedLeaks++
  if (evalQueryTexts.has(x.o.query.trim().toLowerCase())) emittedCollisions++
}
console.log(`EMITTED families: ${JSON.stringify(Object.fromEntries(emitted))}`)
console.log(`EMITTED disjointness: ${emittedLeaks} references to frozen-benchmark gold papers (must be 0)`)
console.log(`EMITTED query-string overlap with benchmark: ${emittedCollisions.toLocaleString()} / ${out.length.toLocaleString()} (disclosed, not a leak — benchmark splits by paper)`)
if (emittedLeaks > 0) { console.error('ABORT: emitted set references frozen-benchmark gold papers.'); process.exit(1) }
// The FAMILY_TAKE contract, verified against the RE-COUNTED emitted set rather
// than against the slice() calls that produced it. A take that silently emitted
// a different mix than it was asked for is the same failure shape as an empty
// slice reporting success — the run would train on the wrong distribution and
// nothing downstream would ever say so.
if (FAMILY_TAKE) {
  const want = [...FAMILY_TAKE].sort(([a], [b]) => a.localeCompare(b))
  const got = [...emitted].sort(([a], [b]) => a.localeCompare(b))
  const mismatch = want.length !== got.length ||
    want.some(([f, n], i) => got[i][0] !== f || got[i][1] !== n)
  if (mismatch) {
    console.error(`ABORT: families_emitted does not match FAMILY_TAKE.\n  requested ${JSON.stringify(Object.fromEntries(want))}\n  emitted   ${JSON.stringify(Object.fromEntries(got))}`)
    process.exit(1)
  }
  console.log(`FAMILY_TAKE VERIFIED: families_emitted matches the spec exactly (${out.length.toLocaleString()} pairs)`)
}

mkdirSync(dirname(OUT), { recursive: true })
// Stream it: 40k pairs x 10 documents is ~800 MB, past V8's max string length.
// join() on that array throws RangeError after all the work is already done.
//
// AND HONOUR BACKPRESSURE (LANE-QP3). The line above used to be
//   `if (!ws.write(...)) { /* backpressure ok at this size */ }`
// — ignoring the false return and writing the next row anyway. At 40k pairs
// that was true. At 140k pairs (~2.2 GB) it is not: Node queues every unflushed
// chunk in memory and then hands the whole backlog to one writev(), which fails
// on macOS at exactly 2^32 bytes. Measured, not theorised — the first attempt
// produced a 4,294,967,296-byte train.jsonl containing 270,192 lines for 140,000
// rows, i.e. silently duplicated garbage, and the process died with
// `ERR_SYSTEM_ERROR: writev failed` AFTER every gate had already printed PASS.
// Both halves of that are the house failure mode: a corrupt artifact, and a run
// that reported success on the way to producing it.
const writeStream = async (path, lines) => {
  const ws = createWriteStream(path)
  const done = new Promise((res, rej) => { ws.on('error', rej); ws.on('finish', res) })
  for (const line of lines) {
    if (!ws.write(line)) await new Promise((r) => ws.once('drain', r))
  }
  ws.end()
  await done
}
await writeStream(OUT, (function* () { for (const x of out) yield JSON.stringify(x.o) + '\n' })())
// SLUG SIDECAR (LANE-QP3). train.jsonl is text-only — {query, pos:[text], neg:[text]} —
// which is the shape FlagEmbedding wants and a shape nothing can be joined on.
// The ANCE re-mine has to strike a query's OWN positive out of its retrieved
// negatives, and to do that it needs the positive's SLUG, not its prose. Without
// this file mine-ance.mjs's train-jsonl path builds `gold: new Set()` — an EMPTY
// gold set — so its own-positive gate silently rejects nothing and a query's
// correct answer can be emitted as its own hard negative. Row i here is row i
// there; the pairing is by position in the same file, written in the same pass.
const SIDECAR = join(dirname(OUT), 'slice-slugs.jsonl')
await writeStream(SIDECAR, (function* () {
  for (let i = 0; i < out.length; i++) {
    const x = out[i]
    yield JSON.stringify({ i, family: x.fam, query: x.o.query, pos: x.ps, neg: x.negs }) + '\n'
  }
})())
console.log(`wrote slug sidecar -> ${SIDECAR} (${out.length.toLocaleString()} rows, row i pairs with row i of ${OUT})`)
writeFileSync(join(dirname(OUT), 'manifest.json'), JSON.stringify({
  name: NAME, built_at: new Date().toISOString(), input: IN, text_source: TEXTS,
  pairs: out.length, negs_per_pair: NEGS, subsample: SUBSAMPLE || null,
  family_take: FAMILY_TAKE ? Object.fromEntries(FAMILY_TAKE) : null,
  family_take_verified: FAMILY_TAKE ? true : null,
  query_side: { literal_text: textQueries, slug_into_corpus: slugQueries },
  families_convertible: Object.fromEntries([...[...byFamily].map(([f, a]) => [f, a.length]), ...unnamed]),
  families_emitted: Object.fromEntries(emitted),
  benchmark_query_string_overlap_emitted: emittedCollisions,
  slug_sidecar: 'slice-slugs.jsonl',
  disjointness: { pass: emittedLeaks === 0, checked_against: join(EVAL_DIR, 'qrels.tsv'),
                  frozen_benchmark_papers: evalKeys.size, rejected_for_overlap: leaked,
                  emitted_references_to_gold_papers: emittedLeaks },
}, null, 2))
console.log(`wrote ${out.length.toLocaleString()} pairs -> ${OUT}`)
