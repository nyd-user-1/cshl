// kNN-over-embeddings baseline for cshl-category.
//
// D10 required the classifier to be scored against TWO baselines: the
// majority-class floor (reported: 14.45%) and kNN over embeddings we already
// have. Only the first was run, and it is the trivial one — for a 76-way
// target, beating "always guess the biggest class" proves very little. The
// decision-relevant question is whether a fine-tuned classifier earns its keep
// over simply asking the nearest already-embedded neighbours what they are.
//
// Method: sample N papers from the held-out test split, kNN each against the
// embedding table EXCLUDING every test-split slug (no peeking at held-out
// labels), and take a distance-weighted vote of the neighbours' categories.
// Also reports top-3, which matters because the gold label is author
// self-assignment on papers that often belong to two categories at once.
//
//   node --env-file=.env.local scripts/eval/knn-category-baseline.mjs [N] [K] [table]
//
// Read-only. Neon sits at 0.25 min CU; this is sequential and gentle on purpose.
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const N = Number(process.argv[2] ?? 1000);
const K = Number(process.argv[3] ?? 15);
const TABLE = process.argv[4] ?? "preprint_embeddings_cshl_qp2";
const sql = neon(process.env.DATABASE_URL);

const rows = readFileSync(
  "/Users/brendanstanton/Code/cshl/data/mine/cshl-category-classify.test.jsonl",
  "utf8",
).trim().split("\n").map((l) => JSON.parse(l));

// Deterministic sample: every stride-th line, so a rerun scores the same papers.
const stride = Math.max(1, Math.floor(rows.length / N));
const sample = rows.filter((_, i) => i % stride === 0).slice(0, N);
const testSlugs = rows.map((r) => r.slug); // the full exclusion set, not just the sample

console.log(`test split ${rows.length} rows | sampling ${sample.length} | k=${K} | ${TABLE}`);

let top1 = 0, top3 = 0, scored = 0, missing = 0;
const confusion = new Map();

for (const r of sample) {
  const out = await sql.query(
    `WITH q AS (SELECT embedding FROM ${TABLE} WHERE key_number = $1)
     SELECT unnest(p.categories) AS cat, 1 - (e.embedding <=> (SELECT embedding FROM q)) AS sim
     FROM ${TABLE} e
     JOIN preprints p USING (key_number)
     WHERE e.key_number <> ALL($2) AND (SELECT count(*) FROM q) = 1
     ORDER BY e.embedding <=> (SELECT embedding FROM q)
     LIMIT $3`,
    [r.slug, testSlugs, K],
  );
  if (!out.length) { missing++; continue; }

  const votes = new Map();
  for (const row of out) {
    if (!row.cat) continue;
    votes.set(row.cat, (votes.get(row.cat) ?? 0) + Number(row.sim));
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  if (!ranked.length) { missing++; continue; }

  scored++;
  if (ranked[0] === r.label) top1++;
  else confusion.set(`${r.label} -> ${ranked[0]}`, (confusion.get(`${r.label} -> ${ranked[0]}`) ?? 0) + 1);
  if (ranked.slice(0, 3).includes(r.label)) top3++;

  if (scored % 100 === 0) {
    process.stdout.write(`  ${scored} scored | top1 ${(100 * top1 / scored).toFixed(2)}%\n`);
  }
}

console.log(`\nkNN-over-embeddings baseline (${TABLE}, k=${K})`);
console.log(`  scored:        ${scored}${missing ? ` (skipped ${missing} with no vector)` : ""}`);
console.log(`  top-1:         ${(100 * top1 / scored).toFixed(2)}%`);
console.log(`  top-3:         ${(100 * top3 / scored).toFixed(2)}%`);
console.log(`\n  cshl-category: 65.09%   majority floor: 14.45%`);
console.log("\ntop confusions:");
for (const [k, v] of [...confusion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${k}: ${v}`);
}
