// Build the workspace catalog (public/data/catalog.json): live counts per
// asset type plus the top entities of each — the /graph rail reads this as a
// static CDN asset, so the "Discovery" surface costs zero API calls.
//
//   node --env-file=.env.local scripts/build-catalog.mjs

import { writeFileSync } from "node:fs";
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
    child.on("close", (c) => (c === 0 ? resolve(out.trim() ? JSON.parse(out.trim()) : null) : reject(new Error(err.slice(0, 800)))));
  });
}

const [counts, papers, authors, nuclides, reactions, exfor] = await Promise.all([
  psqlJson(`SELECT json_build_object(
    'papers',   (SELECT count(*) FROM nsr),
    'authors',  (SELECT count(*) FROM authors),
    'nuclides', (SELECT count(*) FROM nuclide_dict),
    'reactions',(SELECT count(*) FROM reaction_dict),
    'exfor',    (SELECT count(*) FROM exfor_entries),
    'ensdf',    (SELECT count(*) FROM ensdf_datasets),
    'xundl',    (SELECT count(*) FROM xundl_datasets),
    'recipes',  (SELECT count(*) FROM workspace_views)
  )`),
  psqlJson(`SELECT json_agg(t) FROM (
    SELECT key_number AS id, key_number AS label, title, pub_year, citation_count
    FROM nsr WHERE citation_count IS NOT NULL
      AND EXISTS (SELECT 1 FROM nsr_nuclides nn WHERE nn.key_number = nsr.key_number)
    ORDER BY citation_count DESC LIMIT 50) t`),
  psqlJson(`SELECT json_agg(t) FROM (
    SELECT a.author_key::text AS id,
           concat_ws('', a.initial1, '.', CASE WHEN coalesce(a.initial2,'') <> '' THEN a.initial2 || '.' END, a.last_name) AS label,
           count(*) AS papers
    FROM authors a JOIN nsr_authors na USING (author_key)
    GROUP BY 1, 2 ORDER BY papers DESC LIMIT 50) t`),
  psqlJson(`SELECT json_agg(t) FROM (
    SELECT d.nuclide_code AS id,
           (d.a::text || initcap(lower(replace(d.nuclide_code, d.a::text, '')))) AS label,
           d.z, d.n, count(*) AS papers
    FROM nsr_nuclides nn JOIN nuclide_dict d ON d.z = nn.z AND d.a = nn.a
    GROUP BY 1, 2, 3, 4 ORDER BY papers DESC LIMIT 50) t`),
  psqlJson(`SELECT json_agg(t) FROM (
    SELECT reaction_code AS id, reaction_code AS label, count(*) AS papers
    FROM nsr_reactions WHERE reaction_code IS NOT NULL
    GROUP BY 1 ORDER BY papers DESC LIMIT 50) t`),
  psqlJson(`SELECT json_agg(t) FROM (
    SELECT e.exfor_id AS id, e.exfor_id AS label, count(ne.key_number) AS papers
    FROM exfor_entries e LEFT JOIN nsr_exfor ne ON ne.exfor_id = e.exfor_id
    GROUP BY 1 ORDER BY papers DESC, e.exfor_id LIMIT 50) t`),
]);

writeFileSync("public/data/catalog.json", JSON.stringify({
  generated: counts ? undefined : undefined,
  counts,
  top: { papers, authors, nuclides, reactions, exfor },
}));
console.log("catalog.json:", JSON.stringify(counts));
