// Build public/data/nsr-archivals.json for /nsr/datasets from NNDC's
// nsrarchivals distributions index (+ HEAD each file for its size) and the
// live corpus census in Neon. Mirrors scripts/enrich-ensdf-archivals.mjs.
//   node --env-file=.env.local scripts/build-nsr-archivals.mjs
import { writeFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const BASE = "https://www.nndc.bnl.gov/nsrarchivals/distributions";
const OUT = "public/data/nsr-archivals.json";

const idx = await (await fetch(`${BASE}/files.json`)).json();
const distributions = [];
for (const d of idx.distributions) {
  const bytes = {};
  for (const f of d.files) {
    try {
      const r = await fetch(`${BASE}/dist${String(d.year).slice(-2)}/${f}`, { method: "HEAD" });
      const n = Number(r.headers.get("content-length"));
      if (r.ok && n) bytes[f] = n;
    } catch { /* leave unknown */ }
  }
  distributions.push({ year: String(d.year), files: d.files, bytes });
}
distributions.sort((a, b) => Number(a.year) - Number(b.year));
const latest = distributions[distributions.length - 1];

const sql = neon(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL);
const [c] = await sql.query(`SELECT
  count(*) FILTER (WHERE is_nsr)::int AS entries,
  count(*) FILTER (WHERE is_nsr AND is_primary)::int AS primary_refs,
  count(*) FILTER (WHERE is_nsr AND sentence_groups IS NOT NULL AND jsonb_array_length(sentence_groups) > 0)::int AS keyword_abstracts,
  count(*) FILTER (WHERE is_nsr AND doi IS NOT NULL)::int AS with_doi,
  min(pub_year) FILTER (WHERE is_nsr)::int AS first_year,
  max(pub_year) FILTER (WHERE is_nsr)::int AS last_year,
  count(*) FILTER (WHERE is_nsr AND reference_type = 'JOURNAL')::int AS journal_articles
FROM nsr`);
const [j] = await sql.query(`SELECT count(DISTINCT author_key)::int AS n FROM nsr_authors na JOIN nsr x USING (key_number) WHERE x.is_nsr`);
const [n] = await sql.query(`SELECT count(DISTINCT v)::int AS n FROM nsr, unnest(nuclides) v WHERE is_nsr`);
const [r] = await sql.query(`SELECT count(DISTINCT v)::int AS n FROM nsr, unnest(reactions) v WHERE is_nsr`);

const archivedFiles = distributions.reduce((s, d) => s + d.files.length, 0);
const archivedBytes = distributions.reduce((s, d) => s + Object.values(d.bytes).reduce((a, b) => a + b, 0), 0);
const doc = {
  distributions, latest,
  loadedSnapshot: "nsr-json_20260630.zip",
  stats: { ...c, authors: j.n, nuclides: n.n, reactions: r.n, archivedFiles, archivedBytes },
  builtAt: new Date().toISOString(),
};
writeFileSync(OUT, JSON.stringify(doc));
console.log(`wrote ${OUT}: ${archivedFiles} files, ${(archivedBytes / 1e9).toFixed(2)} GB, entries ${c.entries}`);
