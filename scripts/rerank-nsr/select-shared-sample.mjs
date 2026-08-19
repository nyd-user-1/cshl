/**
 * scripts/rerank-nsr/select-shared-sample.mjs — builds the shared ~39,600-pair
 * training sample LANE-RERANK non-negotiable #1 says to reuse from LANE-TRAIN
 * ("read the exact ids from LANE-TRAIN's REPORT/manifest so both models train
 * on the identical set"). As of this run LANE-TRAIN's own Phase 2 had not
 * produced a concrete id list yet (its REPORT: "Phase 2/3: still blocked",
 * written before LANE-TRIPLETS' data landed) — so this script derives the
 * sample using the EXACT methodology LANE-TRAIN's own REPORT specifies
 * ("all EX pairs (~15k) fit comfortably, KW gets sampled down to fill the
 * remainder", budget ~39,600, LANE-TRAIN Gate 1 arithmetic) and publishes the
 * selected id list + a sha256 so LANE-TRAIN can reuse this exact file for
 * byte-identical supervision instead of re-deriving a possibly-divergent one.
 *
 * Held-out guard: same union as pairs-to-groups.mjs (qrels.tsv sample ∪
 * LANE-TRIPLETS' own val.jsonl/test.jsonl paper_slugs).
 *
 * KW stratification: floor 100/cell (or the whole cell if smaller — same
 * floor-then-proportional policy LANE-EVAL used for its own eval sample),
 * remainder distributed proportionally to each cell's remaining share of the
 * clean KW pool. Selection within a cell is deterministic (sort by
 * positive.slug, take first N) so re-running this script reproduces the same
 * sample byte-for-byte.
 *
 *   node scripts/rerank-nsr/select-shared-sample.mjs --train <train.jsonl> \
 *     --val <val.jsonl> --test <test.jsonl> --heldout <qrels.tsv> \
 *     --budget 39600 --out <dir> [--apply]
 */
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const args = process.argv.slice(2)
const val = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d)
const TRAIN = val('--train', '')
const VAL = val('--val', '')
const TEST = val('--test', '')
const HELDOUT = val('--heldout', '')
const OUT = val('--out', '')
const BUDGET = Number(val('--budget', 39600))
const QUERY_CHARS = Number(val('--query-chars', 600))
const DOC_CHARS = Number(val('--doc-chars', 900))
const FLOOR = Number(val('--floor', 100))
if (!TRAIN || !OUT) {
  console.error('usage: select-shared-sample.mjs --train <train.jsonl> --heldout <qrels.tsv> --out <dir> [--val v.jsonl --test t.jsonl] [--budget 39600] [--apply]')
  process.exit(1)
}

const readJsonl = async (path, fn) => {
  if (!path || !existsSync(path)) return 0
  let n = 0
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of rl) { if (line.trim()) { fn(JSON.parse(line)); n++ } }
  return n
}

// ── held-out union ──────────────────────────────────────────────────────────
const heldout = new Set()
if (HELDOUT) {
  await new Promise((resolve) => {
    if (!existsSync(HELDOUT)) return resolve()
    const rl = createInterface({ input: createReadStream(HELDOUT), crlfDelay: Infinity })
    rl.on('line', (line) => { const c2 = line.trim().split('\t')[1]; if (c2) heldout.add(c2) })
    rl.on('close', resolve)
  })
}
await readJsonl(VAL, (r) => heldout.add(r.positive?.slug))
await readJsonl(TEST, (r) => heldout.add(r.positive?.slug))
console.log(`held-out union: ${heldout.size.toLocaleString()} papers`)

const docText = (d) => `${d.title ?? ''}. ${d.abstract ?? ''}`.trim().slice(0, DOC_CHARS)

// ── read + clean train.jsonl ────────────────────────────────────────────────
let total = 0, positiveHeldOut = 0, emptied = 0
const exClean = []
const kwByCell = new Map()
await readJsonl(TRAIN, (r) => {
  total++
  const paperSlug = r.positive?.slug
  if (heldout.has(paperSlug)) { positiveHeldOut++; return }
  const negs = (r.negatives ?? []).filter((n) => !heldout.has(n.slug))
  if (!negs.length) { emptied++; return }
  const clean = { q: String(r.query ?? '').slice(0, QUERY_CHARS), pos: docText(r.positive), negs: negs.map(docText), src: r.meta?.family ?? 'unknown', slug: paperSlug }
  if (clean.src === 'EX') {
    exClean.push(clean)
  } else if (clean.src === 'KW') {
    const seg = r.meta?.segment ?? {}
    const cell = `${seg.era}|${seg.richness}|${seg.reftype}`
    if (!kwByCell.has(cell)) kwByCell.set(cell, [])
    kwByCell.get(cell).push(clean)
  }
})
console.log(`train.jsonl: ${total.toLocaleString()} records, ${positiveHeldOut.toLocaleString()} held-out positives dropped, ${emptied.toLocaleString()} emptied of negatives`)
console.log(`clean EX: ${exClean.length.toLocaleString()}, clean KW: ${[...kwByCell.values()].reduce((s, a) => s + a.length, 0).toLocaleString()} across ${kwByCell.size} cells`)

// ── EX: take all (matches LANE-TRAIN's "all EX pairs fit comfortably") ─────
const exSelected = exClean.sort((a, b) => a.slug.localeCompare(b.slug))
const kwBudget = Math.max(0, BUDGET - exSelected.length)
console.log(`EX selected (all): ${exSelected.length.toLocaleString()}; KW budget: ${kwBudget.toLocaleString()}`)

// ── KW: floor-then-proportional stratified sample, deterministic order ─────
const cells = [...kwByCell.entries()].map(([cell, recs]) => ({ cell, recs, size: recs.length }))
const totalKw = cells.reduce((s, c) => s + c.size, 0)
let floorTotal = 0
for (const c of cells) { c.floorTake = Math.min(c.size, FLOOR); floorTotal += c.floorTake }
const remainder = Math.max(0, kwBudget - floorTotal)
const remainderPool = cells.reduce((s, c) => s + (c.size - c.floorTake), 0)
for (const c of cells) {
  const extra = remainderPool > 0 ? Math.floor((remainder * (c.size - c.floorTake)) / remainderPool) : 0
  c.target = Math.min(c.size, c.floorTake + extra)
}
// rounding remainder: hand any leftover budget to the largest cells with room, in order
let assigned = cells.reduce((s, c) => s + c.target, 0)
let leftover = Math.min(kwBudget, floorTotal + remainder) - assigned
for (const c of cells.sort((a, b) => b.size - a.size)) {
  if (leftover <= 0) break
  const room = c.size - c.target
  const take = Math.min(room, leftover)
  c.target += take; leftover -= take
}

const kwSelected = []
for (const c of cells) {
  const chosen = c.recs.sort((a, b) => a.slug.localeCompare(b.slug)).slice(0, c.target)
  kwSelected.push(...chosen)
  console.log(`  cell ${c.cell}: ${c.size} available -> ${chosen.length} selected`)
}

const selected = [...exSelected, ...kwSelected]
const groups = selected.map(({ q, pos, negs, src }) => ({ q, pos, negs, src }))
const idList = selected.map((s) => s.slug).sort()
const sha256 = createHash('sha256').update(idList.join('\n')).digest('hex')

console.log(`\ntotal selected: ${groups.length.toLocaleString()} (target ${BUDGET.toLocaleString()})`)
console.log(`selected-id-list sha256: ${sha256}`)

if (!args.includes('--apply')) {
  console.log(`\nDry run — nothing written. Add --apply to write ${OUT}/train-groups.jsonl`)
  process.exit(0)
}
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'train-groups.jsonl'), groups.map((g) => JSON.stringify(g)).join('\n') + '\n')
writeFileSync(join(OUT, 'selected-ids.txt'), idList.join('\n') + '\n')
// Shared budget-id manifest — LANE-TRAIN reuses THIS list so both models
// train on the identical set (lead directive, 2026-08-17). Selection order
// preserved (all EX first, then KW by cell) for anyone re-deriving groups
// from it; consumers should treat it as an unordered id set otherwise.
const BUDGET_IDS_PATH = val('--budget-ids-out', '')
if (BUDGET_IDS_PATH) {
  writeFileSync(BUDGET_IDS_PATH, JSON.stringify(
    selected.map((s) => ({ family: s.src, id: s.slug })), null, 2) + '\n')
  console.log(`wrote ${BUDGET_IDS_PATH} (${selected.length.toLocaleString()} family+id pairs)`)
}
writeFileSync(join(OUT, 'sample-manifest.json'), JSON.stringify({
  method: 'all-EX + floor-then-proportional-stratified-KW, deterministic (sorted by positive.slug)',
  budget: BUDGET, floor: FLOOR,
  ex_selected: exSelected.length, kw_selected: kwSelected.length, total_selected: groups.length,
  heldout_union_size: heldout.size,
  cells: cells.map((c) => ({ cell: c.cell, available: c.size, selected: c.target })),
  selected_ids_sha256: sha256,
  source: { train: TRAIN, val: VAL, test: TEST, heldout: HELDOUT },
}, null, 2))
console.log(`\nwrote ${OUT}/train-groups.jsonl, selected-ids.txt, sample-manifest.json`)
