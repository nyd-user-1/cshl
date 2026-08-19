#!/usr/bin/env node
// Filter LANE-TRIPLETS' train.jsonl down to the ids in train-budget-ids.json
// (LANE-RERANK's file — shared budget, same ids both lanes train on).
// Match key is (family, positive.slug). Streams both files, laptop-safe.
// Usage: node filter-budget.mjs <budget.json> <train.jsonl> <out.jsonl>
import { createReadStream, createWriteStream, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [budgetPath, inPath, outPath] = process.argv.slice(2)
if (!budgetPath || !inPath || !outPath) {
  console.error('usage: filter-budget.mjs <budget.json> <train.jsonl> <out.jsonl>')
  process.exit(1)
}
const budget = JSON.parse(readFileSync(budgetPath, 'utf8'))
const wanted = new Set(budget.map((b) => `${b.family}:${b.id}`))
console.log(`budget: ${budget.length} ids (${new Set(budget.map((b) => b.family)).size} families)`)

const out = createWriteStream(outPath)
const rl = createInterface({ input: createReadStream(inPath), crlfDelay: Infinity })
let read = 0, kept = 0

for await (const line of rl) {
  if (!line.trim()) continue
  read++
  const rec = JSON.parse(line)
  const key = `${rec.meta.family}:${rec.positive.slug}`
  if (wanted.has(key)) {
    out.write(line + '\n')
    kept++
  }
}
out.end()
console.log(`filter-budget: read ${read}, kept ${kept} (budget had ${budget.length} — ${budget.length - kept} not found in train.jsonl)`)
