// Enrich public/data/ensdf-archivals.json with what the archive lane learned:
// per-file sizes from the S3 mirror ledger (ensdf_archive_files) and content
// stats from the parsed distribution (ensdf_datasets). The original shape —
// distributions[].files as string[] — is preserved; the ingest script keys off
// it. Sizes ride alongside as a name→bytes map, stats at the top level.
//
//   node --env-file=.env.local scripts/enrich-ensdf-archivals.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const PATH = "public/data/ensdf-archivals.json";

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
    child.on("close", (c) => (c === 0
      ? resolve(out.trim().split("\n").filter(Boolean).map(JSON.parse))
      : reject(new Error(err.slice(0, 1000)))));
  });
}

const doc = JSON.parse(readFileSync(PATH, "utf8"));

const [files, [stats]] = await Promise.all([
  psqlJsonl(`SELECT row_to_json(t) FROM (SELECT year, file, bytes FROM ensdf_archive_files) t`),
  psqlJsonl(`SELECT row_to_json(t) FROM (
    SELECT count(*) AS datasets,
           count(DISTINCT nucid) AS nuclides,
           count(*) FILTER (WHERE dsid ILIKE 'adopted%') AS adopted,
           count(*) FILTER (WHERE dsid ILIKE '%decay%') AS decays,
           count(*) FILTER (WHERE dsid LIKE '%(%' AND dsid NOT ILIKE '%decay%') AS reactions,
           count(DISTINCT a) AS mass_chains
    FROM ensdf_datasets) t`),
]);

const bytesFor = new Map(files.map((f) => [`${f.year}|${f.file}`, Number(f.bytes)]));
let matched = 0;
for (const d of [...doc.distributions, doc.latest]) {
  d.bytes = {};
  for (const f of d.files) {
    const b = bytesFor.get(`${d.year}|${f}`);
    if (b) { d.bytes[f] = b; matched++; }
  }
}
doc.stats = {
  datasets: Number(stats.datasets),
  nuclides: Number(stats.nuclides),
  adopted: Number(stats.adopted),
  decays: Number(stats.decays),
  reactions: Number(stats.reactions),
  massChains: Number(stats.mass_chains),
  archivedFiles: files.length,
  archivedBytes: files.reduce((s, f) => s + Number(f.bytes), 0),
};

writeFileSync(PATH, JSON.stringify(doc));
console.log(`sizes matched ${matched} file entries; stats:`, doc.stats);
