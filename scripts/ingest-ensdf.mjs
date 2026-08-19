// Ingest NNDC's ENSDF evaluation index + per-mass XUNDL dataset listings into Neon.
//
//   node --env-file=.env.local scripts/ingest-ensdf.mjs
//
// Sources (both public, discovered from NNDC's own frontend JS):
//   https://www.nndc.bnl.gov/ensdf/EvaluationIndexServlet          (JSON, 739 rows)
//   https://www.nndc.bnl.gov/ensdf/IndexedXundlServlet?task=singleset&nuc={A}&nucmass=isMass&date={DD-MON-YYYY}
//
// One request per mass chain (~295), 500 ms apart — NNDC gets the same courtesy
// as always. Results land in ensdf_index / xundl_datasets (sql/18).

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

function psql(stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1"], { env: PG_ENV });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error(`psql exit ${c}: ${err.slice(0, 1500)}`))));
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

function csvField(v) {
  if (v === null || v === undefined) return "";
  let s = String(v).replace(/\u0000/g, "").replace(/[\r\n]+/g, " ").trim();
  if (s === "") return '""';
  if (/[",]/.test(s)) s = `"${s.replaceAll('"', '""')}"`;
  return s;
}
const csvRow = (f) => f.map(csvField).join(",");

const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
function servletDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}-${MONTHS[Number(m) - 1]}-${y}`;
}

// 1. Evaluation index
const idx = await (await fetch("https://www.nndc.bnl.gov/ensdf/EvaluationIndexServlet")).json();
console.log(`evaluation index: ${idx.length} rows`);

const idxRows = idx.map((r) =>
  csvRow([r.type, r.a, r.element ?? null, r.citation ?? null, r.cutoff || null, r.xundl_sets ?? 0]),
);
await psql(`BEGIN;\nTRUNCATE ensdf_index;\nCOPY ensdf_index (row_type, a, element, citation, cutoff, xundl_sets) FROM STDIN WITH (FORMAT csv);\n${idxRows.join("\n")}\n\\.\nCOMMIT;`);
console.log("ensdf_index loaded");

// 2. XUNDL sweep — one request per MASS row that has any sets
const masses = idx.filter((r) => r.type === "MASS" && r.xundl_sets > 0 && r.cutoff);
console.log(`sweeping ${masses.length} mass chains for XUNDL datasets`);

const dsRows = [];
let fetched = 0;
for (const m of masses) {
  const u = `https://www.nndc.bnl.gov/ensdf/IndexedXundlServlet?task=singleset&nuc=${m.a}&nucmass=isMass&date=${servletDate(m.cutoff)}`;
  try {
    const html = await (await fetch(u)).text();
    for (const row of html.match(/<tr.*?<\/tr>/gs) ?? []) {
      const cb = row.match(/name="datasetcheck" value="(\d+),([^"]+)">([^<]+)</);
      if (!cb) continue;
      const revised = row.match(/<td>(\d{4}-\d{2})<\/td>/)?.[1] ?? null;
      dsRows.push(csvRow([m.a, cb[2].trim(), cb[3].trim(), revised, cb[1]]));
    }
  } catch (e) {
    console.error(`  A=${m.a}: ${e.message}`);
  }
  fetched++;
  if (fetched % 25 === 0) console.log(`  ${fetched}/${masses.length} chains, ${dsRows.length} datasets so far`);
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`datasets parsed: ${dsRows.length}`);

await psql(`BEGIN;\nTRUNCATE xundl_datasets;\nCOPY xundl_datasets (a, nuclide, dataset, last_revised, recid) FROM STDIN WITH (FORMAT csv);\n${dsRows.join("\n")}\n\\.\nCREATE INDEX IF NOT EXISTS idx_xundl_a ON xundl_datasets (a);\nCREATE INDEX IF NOT EXISTS idx_ensdf_a ON ensdf_index (a);\nANALYZE ensdf_index, xundl_datasets;\nCOMMIT;`);
const check = await psql(`\\pset format unaligned\nSELECT (SELECT count(*) FROM ensdf_index) || ' index rows, ' || (SELECT count(*) FROM xundl_datasets) || ' datasets';`);
console.log("done:", check.trim());
