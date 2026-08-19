// Build public/data/xundl-archivals.json for /xundl/archive from NNDC's
// xundlarchivals distributions index (+ HEAD each file for its size) and the
// live XUNDL census in Neon. Mirrors scripts/build-nsr-archivals.mjs.
//   node --env-file=.env.local scripts/build-xundl-archivals.mjs
import { writeFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const BASE = "https://www.nndc.bnl.gov/xundlarchivals/distributions";
const OUT = "public/data/xundl-archivals.json";
const idx = await (await fetch(`${BASE}/files.json`)).json();
const distributions = [];
for (const d of idx.distributions) {
  const bytes = {};
  await Promise.all(d.files.map(async (f) => {
    try {
      const r = await fetch(`${BASE}/dist${String(d.year).slice(-2)}/${f}`, { method: "HEAD" });
      const n = Number(r.headers.get("content-length"));
      if (r.ok && n) bytes[f] = n;
    } catch { /* unknown */ }
  }));
  distributions.push({ year: String(d.year), files: d.files, bytes });
}
distributions.sort((a, b) => Number(a.year) - Number(b.year));
const latest = distributions[distributions.length - 1];
const sql = neon(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL);
// Census of the loaded distribution (xundl_archive_datasets, sql/28 — the parse of the latest zip)
const [c] = await sql.query(`SELECT count(*)::int AS datasets, count(DISTINCT nucid)::int AS nuclides,
  count(*) FILTER (WHERE dsid ILIKE '%DECAY%')::int AS decays,
  count(*) FILTER (WHERE dsid LIKE '%(%' AND dsid NOT ILIKE '%DECAY%')::int AS reactions,
  count(DISTINCT a)::int AS mass_chains FROM xundl_archive_datasets`);
const [pubs] = await sql.query(`SELECT count(DISTINCT key_number)::int AS publications FROM xundl_refs`);
const archivedFiles = distributions.reduce((s, d) => s + d.files.length, 0);
const archivedBytes = distributions.reduce((s, d) => s + Object.values(d.bytes).reduce((a, b) => a + b, 0), 0);
writeFileSync(OUT, JSON.stringify({ distributions, latest, loadedSnapshot: latest.files[0], stats: { ...c, publications: pubs.publications, archivedFiles, archivedBytes }, builtAt: new Date().toISOString() }));
console.log(`wrote ${OUT}: ${archivedFiles} files, ${(archivedBytes / 1e9).toFixed(2)} GB, datasets ${c.datasets}`);
