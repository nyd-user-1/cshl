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

const IN = process.env.IN ?? 'data/mine/cshl-triplets.train.jsonl'
const TEXTS = process.env.TEXTS ?? 'data/mine/corpus-text.jsonl'
const NAME = process.env.NAME ?? 'parity'
const OUT = process.env.OUT ?? `data/train/${NAME}/train.jsonl`
const NEGS = Number(process.env.NEGS ?? 8)
const SUBSAMPLE = Number(process.env.SUBSAMPLE ?? 0)
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
{
  const rl = createInterface({ input: createReadStream(IN), crlfDelay: Infinity })
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
    if (!byFamily.has(fam)) byFamily.set(fam, [])
    // k: the deterministic stratification key. A text query has no slug, so key
    // on the query text + its positive — stable across runs, which is what
    // "deterministic subsample" has to mean.
    byFamily.get(fam).push({ k: qs ?? `${query}|${ps}`, s: [ps, ...negs], o: { query, pos: [pos], neg: negs.map((s) => text.get(s)) } })
  }
}
const total = [...byFamily.values()].reduce((a, v) => a + v.length, 0)
console.log(`read ${rows.toLocaleString()} · convertible ${total.toLocaleString()} · dropped ${dropped.toLocaleString()} · rejected for touching the frozen benchmark ${leaked.toLocaleString()}`)
console.log(`query side: ${textQueries.toLocaleString()} literal-text · ${slugQueries.toLocaleString()} slug-into-corpus`)
if (total === 0) { console.error('ABORT: 0 convertible records — refusing to write an empty slice.'); process.exit(1) }

let out = []
const emitted = new Map()
if (SUBSAMPLE && SUBSAMPLE < total) {
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

mkdirSync(dirname(OUT), { recursive: true })
// Stream it: 40k pairs x 10 documents is ~800 MB, past V8's max string length.
// join() on that array throws RangeError after all the work is already done.
await new Promise((res, rej) => {
  const ws = createWriteStream(OUT)
  ws.on('error', rej); ws.on('finish', res)
  for (const x of out) if (!ws.write(JSON.stringify(x.o) + '\n')) { /* backpressure ok at this size */ }
  ws.end()
})
writeFileSync(join(dirname(OUT), 'manifest.json'), JSON.stringify({
  name: NAME, built_at: new Date().toISOString(), input: IN, text_source: TEXTS,
  pairs: out.length, negs_per_pair: NEGS, subsample: SUBSAMPLE || null,
  query_side: { literal_text: textQueries, slug_into_corpus: slugQueries },
  families_convertible: Object.fromEntries([...byFamily].map(([f, a]) => [f, a.length])),
  families_emitted: Object.fromEntries(emitted),
  benchmark_query_string_overlap_emitted: emittedCollisions,
  disjointness: { pass: emittedLeaks === 0, checked_against: join(EVAL_DIR, 'qrels.tsv'),
                  frozen_benchmark_papers: evalKeys.size, rejected_for_overlap: leaked,
                  emitted_references_to_gold_papers: emittedLeaks },
}, null, 2))
console.log(`wrote ${out.length.toLocaleString()} pairs -> ${OUT}`)
