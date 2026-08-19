// Pre-render the /structure + /graph data layer to static JSON.
//
//   node --env-file=.env.local scripts/build-structure-data.mjs
//
// Emits public/data/structure/index.json (evaluation index + chart-of-nuclides
// grid) and public/data/structure/{A}.json per mass chain (evals, XUNDL
// datasets, top reactions, literature drawn from OUR enriched corpus). The app
// serves these as immutable CDN assets — the fastest backend is no backend.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUT = path.join(import.meta.dirname, "..", "public", "data", "structure");
mkdirSync(OUT, { recursive: true });

const url = new URL(process.env.DATABASE_URL_UNPOOLED ?? "");
const PG_ENV = {
  ...process.env,
  PGHOST: url.hostname, PGPORT: url.port || "5432",
  PGDATABASE: url.pathname.slice(1),
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGSSLMODE: "require",
};

function psqlJsonl(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", `COPY (${sql}) TO STDOUT`], { env: PG_ENV });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (c) => {
      if (c !== 0) return reject(new Error(err.slice(0, 1500)));
      resolve(out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l.replace(/\\\\/g, "\\"))));
    });
  });
}

const shortAuthors = (s) => {
  if (!s) return null;
  const parts = s.split("; ");
  return parts.length > 6 ? parts.slice(0, 6).join("; ") + " et al." : s;
};

console.log("querying…");
const [index, papers, reactions, counts, dict, xundlPerNuclide, nucCounts, paperNucs] = await Promise.all([
  psqlJsonl(`SELECT row_to_json(t) FROM (SELECT row_type, a, element, citation, cutoff, xundl_sets FROM ensdf_index ORDER BY a, row_type DESC, element) t`),
  psqlJsonl(`SELECT row_to_json(t) FROM (
    SELECT * FROM (
      SELECT j.a, n.key_number, n.title, n.authors, n.pub_year, n.doi,
             n.citation_count, (n.pdf_url IS NOT NULL) AS has_pdf, n.is_nsr,
             left(n.abstract, 240) AS snippet,
             ROW_NUMBER() OVER (PARTITION BY j.a ORDER BY n.citation_count DESC NULLS LAST, n.pub_year DESC) AS r_top,
             ROW_NUMBER() OVER (PARTITION BY j.a ORDER BY n.pub_year DESC, n.key_number DESC) AS r_new
      FROM (SELECT DISTINCT a, key_number FROM nsr_nuclides WHERE a IS NOT NULL) j
      JOIN nsr n USING (key_number)
    ) x WHERE r_top <= 12 OR r_new <= 12
  ) t`),
  psqlJsonl(`SELECT row_to_json(t) FROM (
    SELECT na.a, r.reaction_code AS code, count(DISTINCT r.key_number) AS papers
    FROM (SELECT DISTINCT a, key_number FROM nsr_nuclides WHERE a IS NOT NULL) na
    JOIN nsr_reactions r USING (key_number)
    GROUP BY 1, 2
  ) t`),
  psqlJsonl(`SELECT row_to_json(t) FROM (
    SELECT a, count(DISTINCT key_number) AS papers FROM nsr_nuclides WHERE a IS NOT NULL GROUP BY a
  ) t`),
  // chart cells = nuclides that actually have an ENSDF or XUNDL dataset (NNDC's chart
  // shows exactly those); nuclide_dict alone paints ~10k known nuclides as grey noise.
  psqlJsonl(`SELECT row_to_json(t) FROM (
    SELECT nuclide_code, z, n, a FROM nuclide_dict
    WHERE z IS NOT NULL AND n IS NOT NULL
      AND (nuclide_code IN (SELECT DISTINCT nucid FROM ensdf_datasets)
        OR nuclide_code IN (SELECT DISTINCT nucid FROM xundl_archive_datasets))) t`),
  psqlJsonl(`SELECT row_to_json(t) FROM (SELECT nuclide, count(*) AS c FROM xundl_datasets GROUP BY 1) t`),
  // per-nuclide dataset census from the parsed archival distributions (sql/20, sql/28)
  psqlJsonl(`SELECT row_to_json(t) FROM (
    SELECT coalesce(e.nucid, x.nucid) AS nucid, coalesce(e.ensdf, 0) AS ensdf, coalesce(x.xundl, 0) AS xundl,
           greatest(e.revised, x.revised) AS revised
    FROM (SELECT nucid, count(*) AS ensdf, max(entry_date) AS revised FROM ensdf_datasets GROUP BY 1) e
    FULL JOIN (SELECT nucid, count(*) AS xundl, max(entry_date) AS revised FROM xundl_archive_datasets GROUP BY 1) x USING (nucid)
  ) t`),
  // which nuclides of A each paper carries (for the chips on the mass-chain literature cards)
  psqlJsonl(`SELECT row_to_json(t) FROM (
    SELECT key_number, a, string_agg(DISTINCT a::text || element_symbol, ',' ORDER BY a::text || element_symbol) AS nucs
    FROM nsr_nuclides WHERE a IS NOT NULL GROUP BY key_number, a
  ) t`),
]);
const nucCount = new Map(nucCounts.map((r) => [r.nucid, { ensdf: Number(r.ensdf), xundl: Number(r.xundl), revised: r.revised ? `${String(r.revised).slice(0, 4)}-${String(r.revised).slice(4, 6)}` : null }]));
const paperNucMap = new Map(paperNucs.map((r) => [`${r.a}|${r.key_number}`, r.nucs]));
console.log(`index ${index.length} · paper rows ${papers.length} · reaction rows ${reactions.length} · masses with papers ${counts.length} · nuclides ${dict.length}`);

// cutoff lookups
const massRows = index.filter((r) => r.row_type === "MASS");
const nuclideRows = index.filter((r) => r.row_type === "NUCLIDE");
const massCutoff = new Map(massRows.map((r) => [r.a, r.cutoff]));
const overrideCutoff = new Map(nuclideRows.map((r) => [`${r.a}|${r.element}`, r.cutoff]));
const paperCount = new Map(counts.map((r) => [r.a, Number(r.papers)]));

// Resolve evaluation citations ("NDS 106, 601 (2005)") to NSR key numbers.
// Link only where the reconstructed reference matches exactly one paper.
const JOURNALS = { NDS: "Nucl.Data Sheets", NP: "Nucl.Phys." };
const refOf = (c) => {
  const m = (c ?? "").trim().match(/^(NDS|NP)\s*(A?\d+)[,\s]+(\d+)\s*[(,]\s*(\d{4})\)?\.?$/);
  return m ? `${JOURNALS[m[1]]} ${m[2]}, ${m[3]} (${m[4]})` : null;
};
const wanted = [...new Set([...massRows, ...nuclideRows].map((r) => refOf(r.citation)).filter(Boolean))];
const escSql = (s) => s.replaceAll("'", "''");
const found = wanted.length ? await psqlJsonl(`SELECT row_to_json(t) FROM (
  SELECT n.reference AS ref, min(n.key_number) AS key
  FROM nsr n WHERE n.reference IN (${wanted.map((w) => `'${escSql(w)}'`).join(",")})
  GROUP BY n.reference HAVING count(*) = 1
) t`) : [];
const keyByRef = new Map(found.map((r) => [r.ref, r.key]));
const evalKey = (c) => keyByRef.get(refOf(c) ?? "") ?? null;
console.log(`citations resolved to NSR keys: ${found.length}/${wanted.length}`);

const NOW = Date.parse("2026-08-16");
const bucket = (cutoff) => {
  if (!cutoff) return 12; // unknown/never
  const years = (NOW - Date.parse(cutoff)) / 3.156e10;
  return Math.max(0, Math.min(11, Math.floor(years)));
};

// chart grid: one cell per nuclide — [z, n, a, ageBucket, xundlSetCount]
const sym = (code) => { const s = code.replace(/^\d+/, ""); return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s; };
const xundlCount = new Map(xundlPerNuclide.map((r) => [r.nuclide, Number(r.c)]));
const grid = dict.map((d) => {
  const s = sym(d.nuclide_code).toUpperCase();
  const cutoff = overrideCutoff.get(`${d.a}|${s}`) ?? massCutoff.get(d.a) ?? null;
  return [d.z, d.n, d.a, bucket(cutoff), xundlCount.get(d.nuclide_code) ?? 0];
});

writeFileSync(path.join(OUT, "index.json"), JSON.stringify({
  generated: "2026-08-16",
  masses: massRows.map((r) => ({
    a: r.a, citation: r.citation, key: evalKey(r.citation), cutoff: r.cutoff, xundl_sets: r.xundl_sets,
    papers: paperCount.get(r.a) ?? 0,
    nuclideEvals: nuclideRows.filter((n) => n.a === r.a).map((n) => ({ el: n.element, citation: n.citation, key: evalKey(n.citation), cutoff: n.cutoff, xundl_sets: n.xundl_sets })),
  })),
  grid,
  // one row per charted nuclide — the landing pages' Nuclides table
  nuclides: dict.map((d) => {
    const c = nucCount.get(d.nuclide_code) ?? { ensdf: 0, xundl: 0, revised: null };
    const s = sym(d.nuclide_code).toUpperCase();
    const cutoff = overrideCutoff.get(`${d.a}|${s}`) ?? massCutoff.get(d.a) ?? null;
    return { code: `${d.a}${sym(d.nuclide_code)}`, z: d.z, n: d.n, a: d.a, el: sym(d.nuclide_code), ensdf: c.ensdf, xundl: c.xundl, xundlSince: xundlCount.get(d.nuclide_code) ?? 0, revised: c.revised, age: bucket(cutoff) };
  }),
}));

// per-mass payloads
const papersByA = new Map();
for (const p of papers) {
  if (!papersByA.has(p.a)) papersByA.set(p.a, []);
  papersByA.get(p.a).push(p);
}
const reactionsByA = new Map();
for (const r of reactions) {
  if (!reactionsByA.has(r.a)) reactionsByA.set(r.a, []);
  reactionsByA.get(r.a).push(r);
}
const xundl = await psqlJsonl(`SELECT row_to_json(t) FROM (SELECT a, nuclide, dataset, last_revised, recid FROM xundl_datasets ORDER BY a, last_revised DESC) t`);
const xundlByA = new Map();
for (const x of xundl) {
  if (!xundlByA.has(x.a)) xundlByA.set(x.a, []);
  xundlByA.get(x.a).push({ nuclide: x.nuclide, dataset: x.dataset, revised: x.last_revised, recid: x.recid });
}

const allA = new Set([...massCutoff.keys(), ...papersByA.keys()]);
let written = 0;
for (const a of allA) {
  const rows = papersByA.get(a) ?? [];
  const strip = (p) => ({
    key: p.key_number, title: p.title, authors: shortAuthors(p.authors),
    year: p.pub_year, doi: p.doi, cites: p.citation_count, pdf: p.has_pdf,
    nsr: p.is_nsr, snippet: p.snippet,
    nucs: (paperNucMap.get(`${a}|${p.key_number}`) ?? "").split(",").filter(Boolean),
  });
  const top = rows.filter((p) => p.r_top <= 12).sort((x, y) => x.r_top - y.r_top).map(strip);
  const seen = new Set(top.map((p) => p.key));
  const recent = rows.filter((p) => p.r_new <= 12 && !seen.has(p.key_number)).sort((x, y) => x.r_new - y.r_new).map(strip);
  writeFileSync(path.join(OUT, `${a}.json`), JSON.stringify({
    a,
    citation: massRows.find((m) => m.a === a)?.citation ?? null,
    key: evalKey(massRows.find((m) => m.a === a)?.citation),
    cutoff: massCutoff.get(a) ?? null,
    ageBucket: bucket(massCutoff.get(a) ?? null),
    nuclideEvals: nuclideRows.filter((n) => n.a === a).map((n) => ({ el: n.element, citation: n.citation, key: evalKey(n.citation), cutoff: n.cutoff, xundl_sets: n.xundl_sets })),
    datasets: xundlByA.get(a) ?? [],
    reactions: (reactionsByA.get(a) ?? []).sort((x, y) => y.papers - x.papers).slice(0, 15),
    totalPapers: paperCount.get(a) ?? 0,
    literature: { top, recent },
    nuclides: dict.filter((d) => d.a === a).map((d) => {
      const c = nucCount.get(d.nuclide_code) ?? { ensdf: 0, xundl: 0, revised: null };
      return { el: sym(d.nuclide_code), z: d.z, n: d.n, ensdf: c.ensdf, xundl: c.xundl, xundlSince: xundlCount.get(d.nuclide_code) ?? 0, revised: c.revised };
    }),
  }));
  written++;
}
console.log(`wrote index.json + ${written} mass files to public/data/structure/`);
