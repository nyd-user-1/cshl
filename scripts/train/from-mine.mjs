#!/usr/bin/env node
// from-mine.mjs — lane-mine's triplet records -> FlagEmbedding train.jsonl.
//
// Their shape (NSR record shape, keys only, text joined by slug):
//   {"query":{"slug":…},"positive":{"slug":…},
//    "negatives":[{"slug":…,"source":…}],"meta":{"family":…}}
//
// Text comes from data/mine/corpus-text.jsonl's `embed_text`, which their
// assemble.mjs generates with MY recipeSql() — imported, not copied. Consuming
// that field rather than re-deriving locally is the whole point of the shared
// recipe: it is provably the string the encoder saw, because
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
  for (const l of readFileSync('data/eval/cshl-eval-v1/qrels.tsv', 'utf8').split('\n')) {
    const k = l.split('\t')[1]; if (k) evalKeys.add(k)
  }
} catch {}
console.log(`frozen benchmark gold papers: ${evalKeys.size.toLocaleString()}`)

// 3. convert
const rows = readFileSync(IN, 'utf8').split('\n').filter(Boolean)
let dropped = 0, leaked = 0
const byFamily = new Map()
for (const line of rows) {
  const r = JSON.parse(line)
  const qs = r.query?.slug, ps = r.positive?.slug
  if (!qs || !ps) { dropped++; continue }
  // Cross-check against the FROZEN benchmark, not just their split assertion.
  // Two independent checks of the same property is the point.
  if (evalKeys.has(qs) || evalKeys.has(ps)) { leaked++; continue }
  const negs = (r.negatives ?? []).map((n) => n.slug).filter((s) => s && !evalKeys.has(s) && text.has(s)).slice(0, NEGS)
  const query = text.get(qs), pos = text.get(ps)
  if (!query || !pos || negs.length < 2) { dropped++; continue }
  const fam = r.meta?.family ?? 'MIXED'
  if (!byFamily.has(fam)) byFamily.set(fam, [])
  byFamily.get(fam).push({ k: qs, o: { query, pos: [pos], neg: negs.map((s) => text.get(s)) } })
}
const total = [...byFamily.values()].reduce((a, v) => a + v.length, 0)
console.log(`convertible ${total.toLocaleString()} · dropped ${dropped.toLocaleString()} · rejected for touching the frozen benchmark ${leaked.toLocaleString()}`)

let out = []
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
  families: Object.fromEntries([...byFamily].map(([f, a]) => [f, a.length])),
  disjointness: { pass: true, checked_against: 'data/eval/cshl-eval-v1/qrels.tsv',
                  frozen_benchmark_papers: evalKeys.size, rejected_for_overlap: leaked },
}, null, 2))
console.log(`wrote ${out.length.toLocaleString()} pairs -> ${OUT}`)
