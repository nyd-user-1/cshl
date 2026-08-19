#!/usr/bin/env node
// LANE-TRIPLETS record -> FlagEmbedding finetune jsonl {"query","pos":[],"neg":[]}
// {"query":str,"positive":{"slug","title","abstract"},"negatives":[{...}],"meta":{...}}
// Pure jsonl-to-jsonl text reshape: no DB, no S3, no model inference — safe on
// the laptop (LANE-TRAIN non-negotiable #3 is about model-side work).
// Usage: node to-flag.mjs <in.jsonl> <out.jsonl> [--limit N]
import { createReadStream, createWriteStream } from 'node:fs'
import { createInterface } from 'node:readline'

const [inPath, outPath, ...rest] = process.argv.slice(2)
if (!inPath || !outPath) {
  console.error('usage: to-flag.mjs <in.jsonl> <out.jsonl> [--limit N]')
  process.exit(1)
}
const li = rest.indexOf('--limit')
const limit = li >= 0 ? Number(rest[li + 1]) : Infinity

// Matches the embedded recipe exactly (scripts/embed-nsr/worker.mjs):
// trim(title + '\n\n' + abstract), capped at 2000 chars.
const CAP = 2000
const text = (d) => ((d.title || '').trim() + '\n\n' + (d.abstract || '').trim()).slice(0, CAP)

const out = createWriteStream(outPath)
const rl = createInterface({ input: createReadStream(inPath), crlfDelay: Infinity })
let read = 0, kept = 0, dropped = 0

for await (const line of rl) {
  if (!line.trim() || kept >= limit) break
  read++
  const rec = JSON.parse(line)
  const negs = rec.negatives || []
  if (negs.length < 4) { dropped++; continue }
  out.write(JSON.stringify({
    query: rec.query,
    pos: [text(rec.positive)],
    neg: negs.map(text),
  }) + '\n')
  kept++
}
out.end()
console.log(`to-flag: read ${read}, kept ${kept} (>=4 negatives), dropped ${dropped} (<4 negatives)`)
