// Enrich every DOI-bearing nsr row with Semantic Scholar metadata via the
// batch graph API: abstracts, TLDRs, citation counts, OA PDF urls, arXiv ids.
//
//   node --env-file=.env.local scripts/enrich-s2-batch.mjs [export|fetch|write|verify|all]
//
// Phases (default `all`, each resumable):
//   export — SELECT key_number, doi -> data/s2/dois.csv (~168.7k rows)
//   fetch  — POST /paper/batch, 500 DOIs a request, 1100 ms apart, raw
//            responses cached to data/s2/batch-NNN.json so a crash never
//            re-spends API calls (existing files are skipped on rerun)
//   write  — TEMP stage table + one UPDATE per <=25k-row chunk
//   verify — the corpus-wide counters
//
// Column ownership: this script UPDATEs existing rows only, never INSERTs, and
// writes only the s2_* / abstract / tldr / citation / venue / OA columns. The
// two SHARED columns `arxiv_id` and `pdf_url` are written first-writer-wins via
// coalesce(nsr.<col>, <new>) because two other enrichment lanes also fill them.
// Abstracts overwrite only when NULL or a truncated APS-feed teaser ('…').

import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";

const FIELDS = [
  "abstract", "tldr", "citationCount", "influentialCitationCount", "referenceCount",
  "externalIds", "isOpenAccess", "openAccessPdf", "venue", "authors", "fieldsOfStudy",
].join(",");
const ENDPOINT = `https://api.semanticscholar.org/graph/v1/paper/batch?fields=${FIELDS}`;
const BATCH = 500;          // ids per request (API max)
const PACE_MS = 1100;       // 44b's proven pace
const MAX_RETRY = 5;
// S2 throttles this endpoint at ~1 req/s and answers 429 on roughly a third of
// requests even at the pace above. A flat 10 s sleep is far more than the
// limiter needs and doubles the sweep's wall time; back off gradually instead.
const BACKOFF_MS = [2000, 5000, 10_000, 15_000, 20_000];
const CHUNK_ROWS = 25_000;  // rows per psql invocation
const DIR = "data/s2";

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

async function psqlRetry(sql, label) {
  for (let a = 1; a <= 3; a++) {
    try { return await psql(sql); }
    catch (e) {
      console.error(`  ${label}: attempt ${a}/3 failed — ${e.message.slice(0, 300)}`);
      if (a === 3) throw e;
      await sleep(5000);
    }
  }
}

function csvField(v) {
  if (v === null || v === undefined) return "";
  let s = String(v).replace(/\u0000/g, "").replace(/[\r\n]+/g, " ");
  if (s === "") return '""';
  if (/[",]/.test(s)) s = `"${s.replaceAll('"', '""')}"`;
  return s;
}
const csvRow = (f) => f.map(csvField).join(",");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(3, "0");
const nz = (s) => (s === null || s === undefined || s === "" ? null : s);
// Postgres array literal for a text[] COPY field; csvField quotes it after us.
const pgArray = (a) =>
  Array.isArray(a) && a.length
    ? `{${a.map((s) => `"${String(s).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`
    : null;

// ---------------------------------------------------------------- export ----
async function phaseExport() {
  mkdirSync(DIR, { recursive: true });
  const t0 = Date.now();
  const out = await psqlRetry(
    `\\copy (SELECT key_number, doi FROM nsr WHERE doi IS NOT NULL) TO STDOUT WITH (FORMAT csv)`,
    "export",
  );
  writeFileSync(`${DIR}/dois.csv`, out);
  const n = out.split("\n").filter(Boolean).length;
  console.log(`export: ${n} rows -> ${DIR}/dois.csv (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// Unique, well-formed DOIs (lowercased) from the export; the write-back joins
// back on lower(nsr.doi) so duplicate-DOI rows all get the same enrichment.
function loadDois() {
  const seen = new Set();
  let malformed = 0, rows = 0;
  for (const line of readFileSync(`${DIR}/dois.csv`, "utf8").split("\n")) {
    if (!line) continue;
    rows++;
    // key_number is a bare token; the DOI is everything after the first comma
    let doi = line.slice(line.indexOf(",") + 1).trim();
    if (doi.startsWith('"') && doi.endsWith('"')) doi = doi.slice(1, -1).replaceAll('""', '"');
    doi = doi.toLowerCase();
    if (!/^10\.\d{4,9}\/\S+$/.test(doi)) { malformed++; continue; }
    seen.add(doi);
  }
  const dois = [...seen];
  console.log(`dois: ${rows} rows -> ${dois.length} unique (${malformed} malformed/skipped)`);
  return dois;
}

// ----------------------------------------------------------------- fetch ----
let rateLimited = 0;

// The response array is positional, so a length mismatch means we cannot trust
// ANY of it; likewise a non-rate-limit 4xx usually means one poisoned id (or an
// oversize response) rather than a bad batch. Both are recovered the same way:
// halve the batch and recurse until the culprit is alone, then record just that
// id as a miss. Everything around it is still mapped correctly.
async function splitAndConquer(ids, why) {
  if (ids.length === 1) {
    console.error(`    unmappable id, recording as miss: ${ids[0]} (${why})`);
    return [null];
  }
  console.error(`    splitting ${ids.length} ids (${why})`);
  const mid = Math.ceil(ids.length / 2);
  const a = await postBatch(ids.slice(0, mid));
  await sleep(PACE_MS);
  const b = await postBatch(ids.slice(mid));
  return a && b ? [...a, ...b] : null;
}

async function postBatch(ids) {
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "x-api-key": process.env.SEMANTIC_SCHOLAR_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
    } catch (e) {
      console.error(`    network: ${e.message} (attempt ${attempt}/${MAX_RETRY})`);
      await sleep(BACKOFF_MS[attempt - 1]);
      continue;
    }
    if (res.ok) {
      const j = await res.json();
      if (Array.isArray(j) && j.length === ids.length) return j;
      const len = Array.isArray(j) ? j.length : "n/a";
      // one retry in case it is transient, then isolate the offending id
      if (attempt === 1) {
        console.error(`    bad response shape (len ${len} vs ${ids.length}) — retrying once`);
        await sleep(BACKOFF_MS[0]);
        continue;
      }
      return splitAndConquer(ids, `len ${len} vs ${ids.length}`);
    }
    const body = (await res.text()).slice(0, 200);
    if (res.status === 429 || res.status >= 500) {
      if (res.status !== 429) console.error(`    HTTP ${res.status} (attempt ${attempt}/${MAX_RETRY}) ${body}`);
      rateLimited++;
      await sleep(BACKOFF_MS[attempt - 1]);
      continue;
    }
    return splitAndConquer(ids, `HTTP ${res.status} ${body}`);
  }
  return null;
}

async function phaseFetch() {
  mkdirSync(DIR, { recursive: true });
  const dois = loadDois();
  const total = Math.ceil(dois.length / BATCH);
  const failed = [];
  let hits = 0, misses = 0, made = 0, cached = 0;
  const t0 = Date.now();

  for (let i = 0; i < total; i++) {
    const file = `${DIR}/batch-${pad(i)}.json`;
    const ids = dois.slice(i * BATCH, (i + 1) * BATCH).map((d) => `DOI:${d}`);
    if (existsSync(file)) {
      try {
        const c = JSON.parse(readFileSync(file, "utf8"));
        if (Array.isArray(c.results) && c.results.length === c.ids.length) {
          cached++;
          hits += c.results.filter(Boolean).length;
          misses += c.results.filter((r) => !r).length;
          continue;
        }
      } catch { /* corrupt cache -> refetch */ }
    }
    const results = await postBatch(ids);
    made++;
    if (!results) {
      failed.push(i);
      console.error(`  batch ${i}/${total}: FAILED`);
    } else {
      writeFileSync(file, JSON.stringify({ ids, results }));
      hits += results.filter(Boolean).length;
      misses += results.filter((r) => !r).length;
    }
    if (i % 20 === 0 || i === total - 1) {
      const el = (Date.now() - t0) / 1000;
      console.log(`  batch ${i + 1}/${total} — hits ${hits} misses ${misses} — ${rateLimited} 429s — ${el.toFixed(0)}s elapsed`);
    }
    await sleep(PACE_MS);
  }
  writeFileSync(`${DIR}/fetch-summary.json`, JSON.stringify({ total, made, cached, failed, hits, misses, rateLimited }, null, 1));
  console.log(`fetch: ${total} batches (${made} requested, ${cached} cached), ${failed.length} failed, hits ${hits}, misses ${misses}, ${rateLimited} 429s, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (failed.length) console.log(`  failed batches: ${failed.join(",")}`);
}

// ----------------------------------------------------------------- write ----
const STAGE_COLS = `doi text, s2_paper_id text, abstract text, tldr text,
  citation_count int, influential_citation_count int, reference_count int,
  venue text, is_open_access boolean, open_access_pdf_url text,
  s2_authors jsonb, fields_of_study text[], status text, arxiv_id text`;

function stageRow(doi, p) {
  if (!p) return csvRow([doi, null, null, null, null, null, null, null, null, null, null, null, "not_found", null]);
  const pdf = nz(p.openAccessPdf?.url);
  return csvRow([
    doi,
    nz(p.paperId),
    nz(p.abstract),
    nz(p.tldr?.text),
    Number.isInteger(p.citationCount) ? p.citationCount : null,
    Number.isInteger(p.influentialCitationCount) ? p.influentialCitationCount : null,
    Number.isInteger(p.referenceCount) ? p.referenceCount : null,
    nz(p.venue),
    typeof p.isOpenAccess === "boolean" ? p.isOpenAccess : null,
    pdf,
    p.authors?.length ? JSON.stringify(p.authors) : null,
    pgArray(p.fieldsOfStudy),
    "ok",
    nz(p.externalIds?.ArXiv),
  ]);
}

async function phaseWrite() {
  const files = readdirSync(DIR).filter((f) => /^batch-\d+\.json$/.test(f)).sort();
  console.log(`write: ${files.length} batch files`);
  const rows = [];
  for (const f of files) {
    const { ids, results } = JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));
    for (let i = 0; i < ids.length; i++) rows.push(stageRow(ids[i].slice(4), results[i]));
  }
  console.log(`write: ${rows.length} stage rows`);

  const t0 = Date.now();
  for (let off = 0; off < rows.length; off += CHUNK_ROWS) {
    const chunk = rows.slice(off, off + CHUNK_ROWS);
    const out = await psqlRetry(`BEGIN;
CREATE TEMP TABLE stage_s2 (${STAGE_COLS}) ON COMMIT DROP;
COPY stage_s2 FROM STDIN WITH (FORMAT csv);
${chunk.join("\n")}
\\.
CREATE INDEX ON stage_s2 (doi);
ANALYZE stage_s2;

WITH upd AS (
  UPDATE nsr SET
    -- owned columns: fresh S2 value wins, but a null answer never wipes what is there
    s2_paper_id                = coalesce(s.s2_paper_id, nsr.s2_paper_id),
    abstract                   = CASE WHEN s.abstract IS NOT NULL
                                        AND (nsr.abstract IS NULL OR nsr.abstract LIKE '%…')
                                      THEN s.abstract ELSE nsr.abstract END,
    tldr                       = coalesce(s.tldr, nsr.tldr),
    citation_count             = coalesce(s.citation_count, nsr.citation_count),
    influential_citation_count = coalesce(s.influential_citation_count, nsr.influential_citation_count),
    reference_count            = coalesce(s.reference_count, nsr.reference_count),
    venue                      = coalesce(s.venue, nsr.venue),
    is_open_access             = coalesce(s.is_open_access, nsr.is_open_access),
    open_access_pdf_url        = coalesce(s.open_access_pdf_url, nsr.open_access_pdf_url),
    s2_authors                 = coalesce(s.s2_authors, nsr.s2_authors),
    fields_of_study            = coalesce(s.fields_of_study, nsr.fields_of_study),
    s2_lookup_status           = s.status,
    s2_looked_up_at            = now(),
    -- SHARED columns: first writer wins (two other lanes also fill these)
    arxiv_id                   = coalesce(nsr.arxiv_id, s.arxiv_id),
    pdf_url                    = coalesce(nsr.pdf_url, s.open_access_pdf_url)
  FROM stage_s2 s
  WHERE lower(nsr.doi) = s.doi
  RETURNING nsr.key_number
) SELECT 'rows_updated: ' || count(*) FROM upd;
COMMIT;`, `chunk@${off}`);
    console.log(`  chunk ${off}-${off + chunk.length}: ${out.trim()} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
}

// ---------------------------------------------------------------- verify ----
async function phaseVerify() {
  const out = await psqlRetry(`SELECT count(*) FILTER (WHERE s2_lookup_status='ok') AS s2_ok,
       count(*) FILTER (WHERE s2_lookup_status='not_found') AS s2_miss,
       count(abstract) AS abstracts, count(tldr) AS tldrs,
       count(arxiv_id) AS arxiv_ids, count(pdf_url) AS pdf_urls
FROM nsr;`, "verify");
  console.log(out.trim());
}

// ------------------------------------------------------------------ main ----
const phase = process.argv[2] ?? "all";
if (phase === "export" || phase === "all") await phaseExport();
if (phase === "fetch" || phase === "all") await phaseFetch();
if (phase === "write" || phase === "all") await phaseWrite();
if (phase === "verify" || phase === "all") await phaseVerify();
console.log("done");
