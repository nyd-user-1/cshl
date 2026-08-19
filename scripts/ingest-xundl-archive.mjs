// XUNDL twin of ingest-xundl-archive.mjs: parse the latest xundlarchivals
// distribution (ENSDF-format card decks) into Neon — one row per XUNDL
// dataset — plus the NSR key-number references. Same parser, own tables
// (xundl_archive_datasets, xundl_refs; sql/28).
//
//   node --env-file=.env.local scripts/ingest-xundl-archive.mjs --ddl
//   node --env-file=.env.local scripts/ingest-xundl-archive.mjs --mirror
//   node --env-file=.env.local scripts/ingest-xundl-archive.mjs --load [--zip=/path/to.zip]
//   node --env-file=.env.local scripts/ingest-xundl-archive.mjs --verify
//
// Tables owned here (created by sql/28-xundl-datasets.sql, applied with --ddl):
//   xundl_archive_files, xundl_archive_datasets, xundl_refs.  `nsr` is read-only.
//
// Device rule: nothing lands on local disk except one working zip at a time.
// The mirror streams curl -> `aws s3 cp -`; the parser reads zip members
// through `unzip -p` and flushes to psql in chunks, never holding the
// whole 265 MB distribution in memory.

import { spawn, execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ARCHIVALS = "public/data/xundl-archivals.json";
const BASE = "https://www.nndc.bnl.gov/xundlarchivals/distributions";
const BUCKET = "nsr-pdfs";
const PREFIX = "archivals/xundl";
const POLITE_MS = 1000;          // NNDC: serial downloads, >= 1 s apart
const CHUNK_ROWS = 2000;         // datasets per psql COPY (raw is bulky)
const CHUNK_BYTES = 24 << 20;

// ---------------------------------------------------------------- psql (verbatim from ingest-aps-feeds.mjs)
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

async function psqlRetry(sql, label, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await psql(sql); }
    catch (e) {
      if (i >= tries) throw e;
      console.error(`  ${label}: attempt ${i} failed (${e.message.slice(0, 200)}) — retrying`);
      await sleep(2000 * i);
    }
  }
}

// COPY ... FROM STDIN in TEXT format: one physical line per row even when a
// field (raw) is a 300-line card deck. NULs are stripped — text/jsonb reject them.
const NUL = "\u0000";
function tf(v) {
  if (v === null || v === undefined) return "\\N";
  return String(v)
    .replaceAll("\\", "\\\\")
    .replaceAll(NUL, "")
    .replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
}
const trow = (f) => f.map(tf).join("\t");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => execFileSync("bash", ["-o", "pipefail", "-c", cmd], { maxBuffer: 1 << 28 }).toString();

// ---------------------------------------------------------------- P0: DDL
async function ddl() {
  await psql(readFileSync("sql/28-xundl-datasets.sql", "utf8"));
  console.log("DDL applied: xundl_archive_files, xundl_archive_datasets, xundl_refs");
}

// ---------------------------------------------------------------- P1: mirror
function s3Inventory() {
  const map = new Map();
  let out = "";
  try { out = sh(`aws s3 ls s3://${BUCKET}/${PREFIX}/ --recursive`); }
  catch { return map; }                        // empty prefix -> non-zero exit
  for (const line of out.split("\n")) {
    const m = line.match(/^\S+\s+\S+\s+(\d+)\s+(.+)$/);
    if (m) map.set(m[2], Number(m[1]));
  }
  return map;
}

async function mirror() {
  const dists = JSON.parse(readFileSync(ARCHIVALS, "utf8")).distributions;
  const jobs = dists.flatMap((d) => d.files.map((f) => ({ year: d.year, file: f })));
  console.log(`mirror: ${jobs.length} files across ${dists.length} distributions`);

  const have = s3Inventory();
  const rows = [], missing = [], failed = [];
  let done = 0, skipped = 0, bytesTotal = 0;

  for (const j of jobs) {
    const key = `${PREFIX}/${j.year}/${j.file}`;
    const uri = `s3://${BUCKET}/${key}`;
    const src = `${BASE}/dist${j.year.slice(2)}/${j.file}`;

    if ((have.get(key) ?? 0) > 0) {
      const bytes = have.get(key);
      rows.push({ ...j, key, bytes });
      bytesTotal += bytes; skipped++;
      continue;
    }
    try {
      sh(`curl -sSfL --retry 2 --retry-delay 3 --max-time 1800 ${JSON.stringify(src)} | aws s3 cp - ${JSON.stringify(uri)} --only-show-errors`);
      const bytes = Number(JSON.parse(sh(`aws s3api head-object --bucket ${BUCKET} --key ${JSON.stringify(key)}`)).ContentLength);
      if (!bytes) throw new Error("uploaded 0 bytes");
      rows.push({ ...j, key, bytes });
      bytesTotal += bytes; done++;
      console.log(`  [${done + skipped}/${jobs.length}] ${j.year}/${j.file} ${(bytes / 1e6).toFixed(1)} MB`);
    } catch (e) {
      const msg = e.message.slice(0, 300);
      (/\b(404|22)\b/.test(msg) ? missing : failed).push(`${j.year}/${j.file}: ${msg.replace(/\s+/g, " ")}`);
      console.error(`  MISS ${j.year}/${j.file}: ${msg.replace(/\s+/g, " ").slice(0, 160)}`);
      try { sh(`aws s3 rm ${JSON.stringify(uri)} --only-show-errors`); } catch { /* nothing to clean */ }
    }
    await sleep(POLITE_MS);
  }

  await psqlRetry(`BEGIN;
DELETE FROM xundl_archive_files;
COPY xundl_archive_files (year, file, s3_key, bytes) FROM STDIN;
${rows.map((r) => trow([r.year, r.file, r.key, r.bytes])).join("\n")}
\\.
COMMIT;`, "archive_files");

  console.log(`mirror done: ${rows.length} files (${done} new, ${skipped} already in S3), ` +
    `${(bytesTotal / 1e9).toFixed(2)} GB, ${missing.length} missing, ${failed.length} failed`);
  if (missing.length) console.log("missing:\n" + missing.join("\n"));
  if (failed.length) console.log("failed:\n" + failed.join("\n"));
}

// ---------------------------------------------------------------- P2/P3: parse + load the latest snapshot
// ENSDF card images: NUCID 1-5, DSID 10-39, DSREF 40-65, PUB 66-74, DATE 75-80.
// Datasets are separated by blank lines; the first card of a block is the ID record.
const col = (l, a, b) => l.slice(a - 1, b).trim();
const KEY_RE = /(?<![A-Za-z0-9])((?:19|20)\d{2}[A-Za-z]{2}\d{2})(-E\d{2})?(?![A-Za-z0-9])/g;
const KEY_ONE = /^(19|20)\d{2}[A-Za-z]{2}\d{2}(-E\d{2})?$/;
// NSR also mints keys whose last two characters are letters (e.g. 2002BAZN); those are
// outside this lane's spec regex, so we only count them, for the report.
const KEY_ALT = /^(19|20)\d{2}[A-Za-z]{2}(?![0-9]{2}$)[A-Za-z0-9]{2}$/;

function parseDataset(block) {
  const id = block[0];
  const nucid = col(id, 1, 5);
  const dsid = col(id, 10, 39);
  const dsref = col(id, 40, 65) || null;
  const m = nucid.match(/^(\d+)([A-Z]{1,2})?$/i);
  const deck = block.join("\n");

  const keys = new Set(), alt = new Set();
  for (const tok of (dsref ?? "").split(/[,\s]+/)) {
    if (!tok) continue;
    if (KEY_ONE.test(tok)) keys.add(tok.toUpperCase());
    else if (KEY_ALT.test(tok)) alt.add(tok.toUpperCase());
  }
  for (const hit of deck.matchAll(KEY_RE)) keys.add(hit[0].toUpperCase());

  return {
    nucid,
    a: m ? Number(m[1]) : null,
    element: m?.[2]?.toUpperCase() ?? null,
    dsid,
    dsref,
    pub: col(id, 66, 74) || null,
    entry_date: col(id, 75, 80) || null,
    num_cards: block.length,
    raw: deck,
    keys, alt,
  };
}

function* datasetsOf(zip, member) {
  const txt = execFileSync("unzip", ["-p", zip, member], { maxBuffer: 1 << 29 }).toString("latin1");
  let block = [];
  for (const raw of txt.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") { if (block.length) { yield block; block = []; } }
    else block.push(line);
  }
  if (block.length) yield block;
}

async function load(zipArg) {
  const meta = JSON.parse(readFileSync(ARCHIVALS, "utf8"));
  const latest = meta.latest;
  const file = latest.files[0];
  const src = `${BASE}/dist${latest.year.slice(2)}/${file}`;
  const zip = zipArg ?? path.join(process.env.SCRATCH ?? tmpdir(), file);

  if (!existsSync(zip) || statSync(zip).size === 0) {
    console.log(`fetching ${src}`);
    sh(`curl -sSfL --retry 2 --retry-delay 3 -o ${JSON.stringify(zip)} ${JSON.stringify(src)}`);
  }
  console.log(`latest distribution: ${latest.year}/${file} (${(statSync(zip).size / 1e6).toFixed(1)} MB)`);

  const members = execFileSync("unzip", ["-Z1", zip], { maxBuffer: 1 << 26 }).toString().trim().split("\n");
  console.log(`  ${members.length} members`);

  await psqlRetry("BEGIN; DELETE FROM xundl_archive_datasets; DELETE FROM xundl_refs; COMMIT;", "truncate");

  const stats = { datasets: 0, refs: 0, altKeys: new Set(), noNucid: 0, badId: 0, dsidFull: 0, chunks: 0 };
  let dsLines = [], refLines = [], pending = 0, bytes = 0;

  const flush = async () => {
    if (!dsLines.length && !refLines.length) return;
    const sql = `BEGIN;
${dsLines.length ? `COPY xundl_archive_datasets (nucid, a, element, dsid, dsref, pub, entry_date, num_cards, raw) FROM STDIN;\n${dsLines.join("\n")}\n\\.\n` : ""}
${refLines.length ? `COPY xundl_refs (nucid, dsid, key_number) FROM STDIN;\n${refLines.join("\n")}\n\\.\n` : ""}
COMMIT;`;
    await psqlRetry(sql, `chunk ${++stats.chunks}`);
    console.log(`  chunk ${stats.chunks}: +${dsLines.length} datasets, +${refLines.length} refs ` +
      `(${stats.datasets} / ${stats.refs} total)`);
    dsLines = []; refLines = []; pending = 0; bytes = 0;
  };

  const t0 = Date.now();
  for (const member of members) {
    for (const block of datasetsOf(zip, member)) {
      const d = parseDataset(block);
      if (!d.nucid) { stats.noNucid++; continue; }
      if (!d.a) stats.badId++;
      if (block[0].slice(38, 39).trim() !== "") stats.dsidFull++;   // col 39 non-blank: DSID may be truncated
      dsLines.push(trow([d.nucid, d.a, d.element, d.dsid, d.dsref, d.pub, d.entry_date, d.num_cards, d.raw]));
      for (const k of d.keys) refLines.push(trow([d.nucid, d.dsid, k]));
      for (const k of d.alt) stats.altKeys.add(k);
      stats.datasets++; stats.refs += d.keys.size;
      pending++; bytes += d.raw.length + 64;
      if (pending >= CHUNK_ROWS || bytes >= CHUNK_BYTES) await flush();
    }
  }
  await flush();

  console.log(`load done in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${stats.datasets} datasets, ${stats.refs} ref links, ` +
    `${stats.chunks} chunks; skipped(no NUCID)=${stats.noNucid}, non-numeric NUCID=${stats.badId}, ` +
    `ID cards with col-39 filled=${stats.dsidFull}, alt-form NSR keys seen (not loaded)=${stats.altKeys.size}`);
}

// ---------------------------------------------------------------- P4: verify + index
async function verify() {
  const dupes = await psql(`SELECT nucid, dsid, count(*) FROM xundl_archive_datasets GROUP BY 1,2 HAVING count(*) > 1 ORDER BY 3 DESC LIMIT 10;`);
  const dupCount = (await psql(`SELECT count(*) FROM (SELECT 1 FROM xundl_archive_datasets GROUP BY nucid, dsid HAVING count(*) > 1) t;`))
    .split("\n")[2].trim();
  const unique = dupCount === "0";
  console.log(`(nucid, dsid) collisions: ${dupCount}`);
  if (!unique) console.log(dupes);

  await psqlRetry(`CREATE ${unique ? "UNIQUE " : ""}INDEX idx_xundl_ds ON xundl_archive_datasets (nucid, dsid);
CREATE INDEX idx_xundl_ds_a ON xundl_archive_datasets (a);
CREATE INDEX idx_xundl_refs_key ON xundl_refs (key_number);
CREATE INDEX idx_xundl_refs_ds ON xundl_refs (nucid, dsid);
ANALYZE xundl_archive_datasets, xundl_refs, xundl_archive_files;`, "indexes");

  console.log(await psql(`SELECT (SELECT count(*) FROM xundl_archive_datasets) AS datasets,
       (SELECT count(DISTINCT nucid) FROM xundl_archive_datasets) AS nuclides,
       (SELECT count(*) FROM xundl_refs) AS ref_links,
       (SELECT count(DISTINCT key_number) FROM xundl_refs) AS distinct_keys,
       (SELECT count(DISTINCT r.key_number) FROM xundl_refs r JOIN nsr n ON n.key_number = r.key_number) AS keys_in_corpus;`));
  console.log(await psql(`SELECT count(DISTINCT nucid) FILTER (WHERE element IS NOT NULL) AS real_nuclides,
       count(DISTINCT nucid) FILTER (WHERE element IS NULL) AS mass_chain_only,
       count(*) FILTER (WHERE dsref IS NOT NULL) AS with_dsref,
       sum(num_cards) AS cards, pg_size_pretty(pg_total_relation_size('xundl_archive_datasets')) AS ds_size
FROM xundl_archive_datasets;`));
  console.log(await psql(`SELECT count(*) AS files, sum(bytes) AS bytes, pg_size_pretty(sum(bytes)) AS pretty
FROM xundl_archive_files;`));
}

// ---------------------------------------------------------------- main
const args = process.argv.slice(2);
const has = (f) => args.includes(f) || args.includes("--all");
const zipArg = args.find((a) => a.startsWith("--zip="))?.slice(6);
if (!args.length) { console.error("usage: --ddl | --mirror | --load [--zip=PATH] | --verify | --all"); process.exit(1); }
if (has("--ddl")) await ddl();
if (has("--mirror")) await mirror();
if (has("--load")) await load(zipArg);
if (has("--verify")) await verify();
