/**
 * LANE-RERANK's converter — LANE-TRIPLETS record shape -> the file
 * `44b/scripts/reranker/train.py` actually opens (`<dir>/train-groups.jsonl`).
 *
 *   node scripts/rerank-nsr/pairs-to-groups.mjs --in <file-or-dir> \
 *     --heldout data/eval/nsr-eval-v1/qrels.tsv --out <dir> [--apply]
 *
 * Derived from `44b/scripts/pairs-to-groups.mjs` (read per LANE-RERANK
 * non-negotiable #1); NOT that file edited in place — this is our own copy,
 * patched minimally for LANE-TRIPLETS' record shape (non-negotiable #2). The
 * diff from the 44b original:
 *
 *   1. `paper_slug`: LANE-TRIPLETS records carry no top-level `paper_slug` —
 *      derived as `r.positive.slug`.
 *   2. `src`: LANE-TRIPLETS uses `r.meta.family` (KW/EX), not `r.kind`.
 *   3. Held-out set: LANE-TRIPLETS' rehearsal slice (`rehearsal.jsonl`) is a
 *      single file, no val/test split to read (that split only exists for
 *      the real Phase-1 train/val/test). The authoritative held-out
 *      universe is LANE-EVAL's frozen qrels (LANE-TRIPLETS' own Phase-3
 *      report independently re-derived its holdout key-set two ways and
 *      matched LANE-EVAL's formula byte-for-byte, sha256
 *      51310096b8a4f69eee49c5e1e7463782c48a48094b49af092b98f5fed7424835 —
 *      Gate PASS), so `--heldout` reads that (qrels.tsv col 2 = key_number)
 *      instead of `${IN}/val.jsonl` + `${IN}/test.jsonl`. If `--in` is a
 *      directory that DOES contain val.jsonl/test.jsonl (the real Phase-1
 *      shape), their paper_slugs are unioned in too — never a narrower
 *      guard than either source.
 *
 * Shapes:
 *   in   {query, positive:{slug,title,abstract}, negatives:[{slug,title,abstract,source}], meta:{family,segment}}
 *   out  {q, pos, negs[], src}                       — plain text, one group per line
 *
 * The held-out rule is ours to enforce here, same as the 44b original: a
 * held-out paper must never reach the GPU, not as a positive and not as
 * some other query's negative. Without this guard the model trains on (part
 * of) its own eval and every downstream number is a lie that looks like a
 * result.
 */
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

const args = process.argv.slice(2)
const val = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d)
const IN = val('--in', '')
const OUT = val('--out', '')
const HELDOUT = val('--heldout', '')
if (!IN || !OUT) {
  console.error('usage: pairs-to-groups.mjs --in <file-or-dir> --out <dir> [--heldout <qrels.tsv>] [--apply]')
  process.exit(1)
}
// Match what train.py's own miner would have written (train.py --query-chars
// / --doc-chars defaults), so reusing groups and mining them differ in
// provenance only (train.py:157-159 / pairs-to-groups.mjs's own comment).
const QUERY_CHARS = Number(val('--query-chars', 600))
const DOC_CHARS = Number(val('--doc-chars', 900))

const readJsonl = async (path, fn) => {
  if (!existsSync(path)) return 0
  let n = 0
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of rl) { if (line.trim()) { fn(JSON.parse(line)); n++ } }
  return n
}

/** train.py builds its pool text as `${title}. ${abstract}` — match it exactly. */
const docText = (d) => `${d.title ?? ''}. ${d.abstract ?? ''}`.trim().slice(0, DOC_CHARS)

// ── the held-out set ──────────────────────────────────────────────────────
const heldout = new Set()
let heldoutSources = []
if (HELDOUT) {
  const n = await new Promise((resolve, reject) => {
    if (!existsSync(HELDOUT)) return resolve(0)
    let n = 0
    const rl = createInterface({ input: createReadStream(HELDOUT), crlfDelay: Infinity })
    rl.on('line', (line) => {
      const t = line.trim()
      if (!t) return
      // qrels.tsv: qid \t key_number (may repeat a key_number across qids)
      const col2 = t.split('\t')[1]
      if (col2) { heldout.add(col2); n++ }
    })
    rl.on('close', () => resolve(n))
    rl.on('error', reject)
  })
  heldoutSources.push(`${HELDOUT} (${n} rows -> ${heldout.size} distinct papers)`)
}
const inIsDir = existsSync(IN) && statSync(IN).isDirectory()
const heldCounts = {}
if (inIsDir) {
  for (const split of ['val', 'test']) {
    const before = heldout.size
    heldCounts[split] = await readJsonl(join(IN, `${split}.jsonl`), (r) => heldout.add(r.paper_slug ?? r.positive?.slug))
    if (heldCounts[split]) heldoutSources.push(`${join(IN, `${split}.jsonl`)} (${heldCounts[split]} pairs, +${heldout.size - before} new papers)`)
  }
}
if (!heldout.size) {
  console.error(`STOP — no held-out papers found (checked --heldout=${HELDOUT || '(none)'} and ${IN}/{val,test}.jsonl).`)
  console.error(`Refusing to write a training set with no held-out guard; that silently trains on the eval.`)
  process.exit(2)
}
console.log(`held-out sources: ${heldoutSources.join('; ')}`)
console.log(`held-out papers (union): ${heldout.size.toLocaleString()}`)

// ── convert ─────────────────────────────────────────────────────────────────
const inFile = inIsDir ? join(IN, 'train.jsonl') : IN
const groups = []
let leaked = 0, emptied = 0, positiveHeldOut = 0, trainPapers = new Set(), negTotal = 0
const nTrain = await readJsonl(inFile, (r) => {
  const paperSlug = r.paper_slug ?? r.positive?.slug
  if (heldout.has(paperSlug)) { positiveHeldOut++; return } // must never happen; drop + count, don't silently train on it
  trainPapers.add(paperSlug)
  const negs = []
  for (const n of r.negatives ?? []) {
    if (heldout.has(n.slug ?? n.key_number)) { leaked++; continue } // the guard train.py's own miner would have applied
    negs.push(docText(n))
  }
  if (!negs.length) { emptied++; return } // a group with no negatives teaches nothing
  negTotal += negs.length
  groups.push({
    q: String(r.query ?? '').slice(0, QUERY_CHARS),
    pos: docText(r.positive),
    negs,
    src: r.kind ?? r.meta?.family ?? 'unknown',
  })
})

// ── prove the split, do not assert it ───────────────────────────────────────
const bleed = [...trainPapers].filter((p) => heldout.has(p))

console.log(`in : ${inFile}`)
console.log(`  input records ${nTrain.toLocaleString()} over ${(trainPapers.size + positiveHeldOut).toLocaleString()} distinct positive papers`)
console.log(`\nheld-out guard`)
console.log(`  positives that were themselves held out (dropped whole group) : ${positiveHeldOut.toLocaleString()}`)
console.log(`  negatives dropped for landing on a held-out paper             : ${leaked.toLocaleString()}`)
console.log(`  groups dropped for having no negatives left                  : ${emptied.toLocaleString()}`)
console.log(`  train papers also in the held-out set (must be 0)            : ${bleed.length}`)
if (bleed.length) {
  console.error(`\nFAIL — ${bleed.length} papers are in train AND held out, e.g. ${bleed.slice(0, 3).join(', ')}`)
  process.exit(3)
}

const avg = groups.length ? (negTotal / groups.length).toFixed(2) : '0'
console.log(`\nout: ${groups.length.toLocaleString()} groups . ${avg} negatives each`)

if (!args.includes('--apply')) {
  console.log(`\nDry run — nothing written. Add --apply to write ${join(OUT, 'train-groups.jsonl')}`)
  process.exit(0)
}
mkdirSync(OUT, { recursive: true })
const dest = join(OUT, 'train-groups.jsonl')
writeFileSync(dest, groups.map((g) => JSON.stringify(g)).join('\n') + '\n')
console.log(`\nwrote ${dest}`)
console.log(`train.py will REUSE these groups rather than mine its own (train.py:68).`)
