// Seed the Community with starter graph views that are actually worth opening.
// Each view is BUILT FROM LIVE QUERIES (same SQL as /api/graph), so it opens
// with real top-cited literature already expanded — not hand-typed guesses.
//
//   node --env-file=.env.local scripts/seed-community-views.mjs

import { spawn } from "node:child_process";

const url = new URL(process.env.DATABASE_URL_UNPOOLED ?? "");
const PG_ENV = {
  ...process.env,
  PGHOST: url.hostname, PGPORT: url.port || "5432",
  PGDATABASE: url.pathname.slice(1),
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGSSLMODE: "require",
};

function psqlJson(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql], { env: PG_ENV });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (c) => (c === 0 ? resolve(out.trim() ? JSON.parse(out.trim()) : []) : reject(new Error(err.slice(0, 800)))));
  });
}

const esc = (s) => String(s).replaceAll("'", "''");
const PAPER_SQL = (where, params) => `
  SELECT json_agg(t) FROM (
    SELECT key_number, title, pub_year, citation_count FROM nsr
    WHERE ${where}
    ORDER BY citation_count DESC NULLS LAST, pub_year DESC LIMIT 8
  ) t`;

const paperNode = (p, i, x) => ({
  type: "paper", id: p.key_number, label: p.key_number, title: p.title,
  sub: `${p.pub_year}${p.citation_count ? ` · ${Number(p.citation_count).toLocaleString()} cites` : ""}`,
  x, y: i * 95,
});

async function topPapersForNuclide(code) {
  const d = (await psqlJson(`SELECT json_agg(t) FROM (SELECT z, a FROM nuclide_dict WHERE nuclide_code = '${esc(code)}') t`))[0];
  return psqlJson(PAPER_SQL(`key_number IN (SELECT key_number FROM nsr_nuclides WHERE z = ${d.z} AND a = ${d.a})`));
}
const topPapersForReaction = (code) =>
  psqlJson(PAPER_SQL(`key_number IN (SELECT key_number FROM nsr_reactions WHERE reaction_code = '${esc(code)}')`));
const topPapersForAuthor = (key) =>
  psqlJson(PAPER_SQL(`key_number IN (SELECT key_number FROM nsr_authors WHERE author_key = ${Number(key)})`));

function assemble(center, papers, extraNodes = []) {
  const nodes = [
    { ...center, x: 0, y: (Math.max(papers.length, 1) * 95) / 2 - 40 },
    ...papers.map((p, i) => paperNode(p, i, 480)),
    ...extraNodes.map((n, i) => ({ ...n, x: -360, y: i * 95 + 60 })),
  ];
  const ck = `${center.type}:${center.id}`;
  const edges = [
    ...papers.map((p) => ({ s: ck, t: `paper:${p.key_number}` })),
    ...extraNodes.map((n) => ({ s: `${n.type}:${n.id}`, t: ck })),
  ];
  return { nodes, edges };
}

const views = [];

// 1. 208Pb — the corpus's most-studied nuclide
views.push({
  name: "²⁰⁸Pb — the doubly-magic benchmark",
  description: "11,085 papers touch 208Pb, the heaviest doubly-magic nucleus and the benchmark for shell structure. Opens with its most-cited literature.",
  saved_by: "NSRgpt",
  state: assemble(
    { type: "nuclide", id: "208PB", label: "208Pb", sub: "Z=82 N=126 · 11,085 papers" },
    await topPapersForNuclide("208PB"),
  ),
});

// 2. 235U + (N,F)
views.push({
  name: "²³⁵U and induced fission",
  description: "The working fuel of nuclear energy: 4,371 papers on 235U, wired to the (N,F) reaction node (5,004 papers) for the fission literature.",
  saved_by: "NSRgpt",
  state: assemble(
    { type: "nuclide", id: "235U", label: "235U", sub: "Z=92 N=143 · 4,371 papers" },
    await topPapersForNuclide("235U"),
    [{ type: "reaction", id: "(N,F)", label: "(N,F)", sub: "5,004 papers" }],
  ),
});

// 3. the neutron
views.push({
  name: "The neutron itself",
  description: "4,078 papers on the free neutron — including the beam-vs-bottle lifetime discrepancy literature. Expand to follow the problem.",
  saved_by: "NSRgpt",
  state: assemble(
    { type: "nuclide", id: "1NN", label: "1n", sub: "Z=0 N=1 · 4,078 papers" },
    await topPapersForNuclide("1NN"),
  ),
});

// 4. (N,G) capture
views.push({
  name: "(n,γ) capture across the chart",
  description: "Radiative neutron capture — the reaction behind s-process nucleosynthesis and activation analysis — centered as a reaction with its most-cited measurements.",
  saved_by: "NSRgpt",
  state: assemble(
    { type: "reaction", id: "(N,G)", label: "(N,G)", sub: "reaction" },
    await topPapersForReaction("(N,G)"),
  ),
});

// 5. 252Cf
views.push({
  name: "²⁵²Cf — the spontaneous-fission standard",
  description: "The lab standard for fission studies and neutron sources: 2,053 papers.",
  saved_by: "NSRgpt",
  state: assemble(
    { type: "nuclide", id: "252CF", label: "252Cf", sub: "Z=98 N=154 · 2,053 papers" },
    await topPapersForNuclide("252CF"),
  ),
});

// 6. R.B. Firestone — author ego view (Table of Isotopes)
const firestone = (await psqlJson(`SELECT json_agg(t) FROM (
  SELECT a.author_key FROM authors a
  WHERE a.last_name = 'FIRESTONE' AND a.initial1 = 'R'
  ORDER BY (SELECT count(*) FROM nsr_authors na WHERE na.author_key = a.author_key) DESC LIMIT 1) t`))[0];
if (firestone) {
  views.push({
    name: "R.B. Firestone — an evaluator's shelf",
    description: "144 corpus papers from the Table of Isotopes author — a working example of the author dimension.",
    saved_by: "NSRgpt",
    state: assemble(
      { type: "author", id: String(firestone.author_key), label: "R.B.FIRESTONE", sub: "144 papers" },
      await topPapersForAuthor(firestone.author_key),
    ),
  });
}

// replace the placeholder starter
await psqlJson(`SELECT json_agg(t) FROM (SELECT 1 AS ok) t`); // connectivity sanity
const del = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", `DELETE FROM workspace_views WHERE name = '137Cs starter map'`], { env: PG_ENV });
await new Promise((r) => del.on("close", r));

for (const v of views) {
  const sql = `INSERT INTO workspace_views (name, description, saved_by, state)
    VALUES ('${esc(v.name)}', '${esc(v.description)}', '${esc(v.saved_by)}', '${esc(JSON.stringify(v.state))}'::jsonb)`;
  const child = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql], { env: PG_ENV });
  await new Promise((resolve, reject) => child.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`insert failed: ${v.name}`)))));
  console.log("seeded:", v.name);
}
console.log("done:", views.length, "views");
