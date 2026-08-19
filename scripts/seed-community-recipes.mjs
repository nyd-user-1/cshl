// Seed six runnable starter RECIPES: canvases with real entities wired into
// pre-written prompt steps. Entities come from live queries; a user opens the
// recipe and hits Run.
//
//   node --env-file=.env.local scripts/seed-community-recipes.mjs

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

async function topPapers(where, limit = 3) {
  return (await psqlJson(`SELECT json_agg(t) FROM (
    SELECT key_number, title, pub_year, citation_count FROM nsr
    WHERE ${where} ORDER BY citation_count DESC NULLS LAST, pub_year DESC LIMIT ${limit}) t`)) ?? [];
}
const forNuclide = async (code, limit = 3) => {
  const d = (await psqlJson(`SELECT json_agg(t) FROM (SELECT z, a FROM nuclide_dict WHERE nuclide_code = '${esc(code)}') t`))[0];
  return topPapers(`key_number IN (SELECT key_number FROM nsr_nuclides WHERE z = ${d.z} AND a = ${d.a})`, limit);
};
const forReaction = (code, limit = 3) =>
  topPapers(`key_number IN (SELECT key_number FROM nsr_reactions WHERE reaction_code = '${esc(code)}')`, limit);

const paperNode = (p, i, x = 0) => ({
  type: "paper", id: p.key_number, label: p.key_number, title: p.title,
  sub: `${p.pub_year}${p.citation_count ? ` · ${Number(p.citation_count).toLocaleString()} cites` : ""}`,
  x, y: i * 100,
});
const promptNode = (id, prompt, x, y = 60) => ({ type: "prompt", id, label: "Prompt step", prompt, x, y });
const wire = (sources, target) => sources.map((s) => ({ s: `${s.type}:${s.id}`, t: `prompt:${target}` }));

const recipes = [];

// 1. 235U fission cross-section comparison
{
  const papers = await forNuclide("235U");
  const p1 = promptNode("u235cmp", "Compare what these papers contribute to our knowledge of 235U fission. Note the measured quantities, energy ranges, and any discrepancies between them.", 480);
  const p2 = promptNode("u235open", "From that comparison, list the open questions a new measurement campaign on 235U(n,f) should target, as concise bullets.", 920);
  recipes.push({
    name: "Recipe: ²³⁵U fission — compare & find gaps",
    description: "Three top-cited ²³⁵U papers wired into a comparison step, chained into an open-questions step. Hit Run.",
    state: { nodes: [...papers.map((p, i) => paperNode(p, i)), p1, p2],
      edges: [...wire(papers.map((p) => ({ type: "paper", id: p.key_number })), "u235cmp"), { s: "prompt:u235cmp", t: "prompt:u235open" }] },
  });
}

// 2. Neutron lifetime
{
  const papers = await forNuclide("1NN");
  const p1 = promptNode("nlife", "Using these papers and the wider corpus, explain the beam-versus-bottle neutron lifetime discrepancy: the two methods, their current values, and why they disagree.", 480);
  const p2 = promptNode("nlifeq", "Now write a 5-question quiz (with answers) testing understanding of the neutron lifetime problem.", 920);
  recipes.push({
    name: "Recipe: the neutron lifetime problem",
    description: "Beam vs bottle, explained from the literature, then turned into a quiz. Two chained steps.",
    state: { nodes: [...papers.map((p, i) => paperNode(p, i)), p1, p2],
      edges: [...wire(papers.map((p) => ({ type: "paper", id: p.key_number })), "nlife"), { s: "prompt:nlife", t: "prompt:nlifeq" }] },
  });
}

// 3. A=137 chain status review
{
  const nuc = { type: "nuclide", id: "137CS", label: "137Cs", sub: "Z=55 N=82", x: 0, y: 60 };
  const p1 = promptNode("cs137rev", "Draft a two-paragraph status review of nuclear-structure knowledge around 137Cs and the A=137 chain. The ENSDF mass-chain evaluation cutoff is 2006-10-01 — weigh what has likely changed since.", 480);
  recipes.push({
    name: "Recipe: A=137 status review",
    description: "One wired nuclide, one prompt: a defensible mini-review of a chain whose evaluation is 19 years old.",
    state: { nodes: [nuc, p1], edges: wire([nuc], "cs137rev") },
  });
}

// 4. (n,γ) and the s-process
{
  const papers = await forReaction("(N,G)");
  const p1 = promptNode("ngastro", "Explain how radiative neutron capture (n,γ) drives s-process nucleosynthesis, grounding the explanation in these measurements where possible.", 480);
  recipes.push({
    name: "Recipe: (n,γ) → the s-process",
    description: "Top capture measurements wired into an astrophysics explainer.",
    state: { nodes: [...papers.map((p, i) => paperNode(p, i)), { type: "reaction", id: "(N,G)", label: "(N,G)", sub: "reaction", x: 0, y: 300 }, p1],
      edges: [...wire(papers.map((p) => ({ type: "paper", id: p.key_number })), "ngastro"), ...wire([{ type: "reaction", id: "(N,G)" }], "ngastro")] },
  });
}

// 5. 208Pb doubly-magic explainer → exam questions
{
  const papers = await forNuclide("208PB");
  const p1 = promptNode("pbmagic", "Write a teaching-level explanation of why 208Pb is doubly magic and what experimental evidence (including from these papers) establishes its shell closures.", 480);
  const p2 = promptNode("pbexam", "Turn that explanation into 5 exam questions of increasing difficulty, with model answers.", 920);
  recipes.push({
    name: "Recipe: ²⁰⁸Pb shell closures — teach it",
    description: "Explainer chained into exam questions, grounded in the most-cited ²⁰⁸Pb literature.",
    state: { nodes: [...papers.map((p, i) => paperNode(p, i)), p1, p2],
      edges: [...wire(papers.map((p) => ({ type: "paper", id: p.key_number })), "pbmagic"), { s: "prompt:pbmagic", t: "prompt:pbexam" }] },
  });
}

// 6. Detector evolution (from the 137Cs calibration literature)
{
  const papers = await psqlJson(`SELECT json_agg(t) FROM (
    SELECT key_number, title, pub_year, citation_count FROM nsr
    WHERE key_number IN ('1965RO09','1992RI12','1994MO46') ) t`);
  const p1 = promptNode("detev", "These three papers span Ge(Li), CdTe, and YAG:Ce detector technologies. Trace the evolution of gamma-ray detection they represent: resolution, use cases, and what each generation enabled.", 480);
  recipes.push({
    name: "Recipe: three generations of γ-ray detectors",
    description: "Ge(Li) 1965 → CdTe 1992 → YAG:Ce 1994, wired into one lineage question.",
    state: { nodes: [...(papers ?? []).map((p, i) => paperNode(p, i)), p1],
      edges: wire((papers ?? []).map((p) => ({ type: "paper", id: p.key_number })), "detev") },
  });
}

for (const r of recipes) {
  const sql = `INSERT INTO workspace_views (name, description, saved_by, state)
    VALUES ('${esc(r.name)}', '${esc(r.description)}', 'NSRgpt', '${esc(JSON.stringify(r.state))}'::jsonb)`;
  const child = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql], { env: PG_ENV });
  await new Promise((resolve, reject) => child.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`insert failed: ${r.name}`)))));
  console.log("seeded:", r.name);
}
console.log("done:", recipes.length, "recipes");
