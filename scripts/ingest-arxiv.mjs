// Ingest arXiv's two nuclear sets (physics:nucl-ex, physics:nucl-th) into the
// nsr corpus. Three phases, run separately:
//
//   node --env-file=.env.local scripts/ingest-arxiv.mjs harvest
//   node --env-file=.env.local scripts/ingest-arxiv.mjs pdfs   [--limit N] [--concurrency N]
//   node --env-file=.env.local scripts/ingest-arxiv.mjs insert [--apply]
//
// harvest — OAI-PMH ListRecords over both sets → data/arxiv/nucl-ex.jsonl and
//   data/arxiv/nucl-th.jsonl (one record per line, full abstract). Resumable:
//   the resumptionToken is checkpointed after every page, so a kill costs at
//   most one page (which may then repeat — `insert` dedupes by arXiv id).
//
// pdfs — for every corpus row that has an arXiv id but no stored PDF, fetch the
//   highest-version PDF from the PUBLIC GCS mirror (gs://arxiv-dataset, readable
//   anonymously over plain HTTPS — no gsutil, no credentials) into
//   data/pdfs/arxiv/<id>.pdf, then write pdf_stored / pdf_url back in 1k batches.
//   Misses fall back to export.arxiv.org at the 3.1 s floor.
//
// insert — arXiv records the corpus does not have (by arXiv id, by published
//   DOI, and by the 10.48550 arXiv DOI) become new is_nsr=false PREPRINT rows.
//
// COLUMN OWNERSHIP (multi-lane run): this script writes `pdf_stored`, and
// `arxiv_id` / `pdf_url` by coalesce only. It is the only lane that INSERTs.
//
// arXiv politeness is absolute: ONE request in flight to any arxiv.org endpoint,
// a 3.1 s floor between them, and every 429 permanently widens that floor for
// the rest of the run (no resetting after a success). The GCS mirror is a
// different service with no such limit, so its fetches bypass the queue.

import { spawn } from "node:child_process";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync,
  readdirSync, statSync, writeFileSync,
} from "node:fs";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { dirname } from "node:path";

// ── psql plumbing (verbatim from ingest-aps-feeds.mjs) ────────────────────────
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
  let s = String(v).replace(/\u0000/g, "").replace(/[\r\n]+/g, " ");
  if (s === "") return '""';
  if (/[",]/.test(s)) s = `"${s.replaceAll('"', '""')}"`;
  return s;
}
const csvRow = (f) => f.map(csvField).join(",");

// A long run outlives a flaky moment; three tries before we call it fatal.
async function psqlRetry(text, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await psql(text); } catch (e) {
      last = e;
      console.log(`  ⚠ psql failed (${e.message.slice(0, 200)}) — retry ${i + 1}/${tries - 1}`);
      await sleep(5000 * (i + 1));
    }
  }
  throw last;
}

// ── flags ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const CMD = argv[0];
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const num = (n, d) => { const v = flag(n); return v == null ? d : (Number(v) || d); };
const has = (n) => argv.includes(n);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DATA = "data/arxiv";
const PDF_DIR = "data/pdfs/arxiv";
const UA = "nsr-corpus/1.0 (mailto:brendan@nysgpt.com)";

// ── arXiv politeness: one in flight, 3.1 s floor, 429 widens the floor ────────
// The floor NEVER narrows again — arXiv's limiter trips on sustained volume, so
// backing away permanently is the only thing that keeps a long run alive.
const ARXIV_FLOOR_MS = 3100;
const RATE_BUMP_MS = 2000;
const MAX_EXTRA_MS = 60_000;
let extraDelayMs = 0;
let rateLimitHits = 0;
let lastArxivAt = 0;
let arxivQueue = Promise.resolve();   // serializes: exactly one request in flight

// Every arxiv.org request in this script goes through here.
function arxivFetch(u, { timeoutMs = 300_000, tries = 6 } = {}) {
  const run = async () => {
    let lastErr = null;
    for (let attempt = 0; attempt < tries; attempt++) {
      const wait = lastArxivAt + ARXIV_FLOOR_MS + extraDelayMs - Date.now();
      if (wait > 0) await sleep(wait);
      let res;
      try {
        lastArxivAt = Date.now();
        res = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        lastErr = e;
        await sleep(Math.min(5000 * 2 ** attempt, 300_000));
        continue;
      }
      if (res.ok) return res;
      if (res.status === 404 || res.status === 403) return res;   // a real miss, not a wait
      // 503 is OAI-PMH flow control (Retry-After); 429 is the Fastly limiter;
      // 5xx is arXiv under load. All three mean "wait and try again".
      const retryAfter = Number(res.headers.get("retry-after")) * 1000;
      let backoff = Math.min(30_000 * 2 ** attempt, 900_000);
      if (res.status === 429) {
        rateLimitHits++;
        extraDelayMs = Math.min(extraDelayMs + RATE_BUMP_MS, MAX_EXTRA_MS);
        console.log(`  ⚠ arXiv 429 (hit #${rateLimitHits}) — floor pace now ` +
          `${((ARXIV_FLOOR_MS + extraDelayMs) / 1000).toFixed(1)}s/req`);
      }
      if (res.status === 503 || res.status === 429 || res.status >= 500) {
        const w = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.max(retryAfter, 1000) : backoff;
        console.log(`  ⚠ arXiv ${res.status} — waiting ${Math.round(w / 1000)}s`);
        lastErr = new Error(`arXiv ${res.status}`);
        await sleep(w);
        continue;
      }
      throw new Error(`arXiv ${res.status} for ${u}`);
    }
    throw new Error(`arXiv failed after ${tries} tries${lastErr ? ` (${lastErr.message})` : ""}: ${u}`);
  };
  const next = arxivQueue.then(run, run);
  arxivQueue = next.then(() => {}, () => {});   // keep the chain alive past a failure
  return next;
}

// ── XML helpers (the OAI arXiv schema is small and regular) ───────────────────
const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
function decodeXml(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(lt|gt|quot|apos);/g, (m) => ENT[m])
    .replace(/&amp;/g, "&");        // last, so "&amp;lt;" survives as "&lt;"
}
// Postgres text/jsonb reject NUL and the C0/C1 control range. Written as escape
// sequences on purpose: a literal NUL byte in this file makes git see binary.
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const clean = (s) => decodeXml(s).replace(CONTROL_RE, "").replace(/\s+/g, " ").trim();
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? clean(m[1]) : null;
};

// One <record> → the normalized shape we persist as JSONL.
function parseRecord(block) {
  const identifier = tag(block, "identifier");
  if (/<header[^>]*status=["']deleted["']/.test(block)) {
    return { id: identifier?.replace(/^oai:arXiv\.org:/, "") ?? null, deleted: true };
  }
  const id = tag(block, "id");
  if (!id) return null;

  const authors = [];
  for (const a of block.matchAll(/<author>([\s\S]*?)<\/author>/g)) {
    const keyname = tag(a[1], "keyname");
    const forenames = tag(a[1], "forenames");
    const suffix = tag(a[1], "suffix");
    const name = [forenames, keyname, suffix].filter(Boolean).join(" ").trim();
    if (name) authors.push(name);
  }
  const sets = [...block.matchAll(/<setSpec>([^<]+)<\/setSpec>/g)].map((m) => m[1]);
  const categories = (tag(block, "categories") ?? "").split(/\s+/).filter(Boolean);

  return {
    id,
    datestamp: tag(block, "datestamp"),
    created: tag(block, "created"),
    updated: tag(block, "updated"),
    title: tag(block, "title"),
    abstract: tag(block, "abstract"),
    authors,
    categories,
    sets,
    doi: tag(block, "doi"),
    journal_ref: tag(block, "journal-ref"),
    comments: tag(block, "comments"),
    report_no: tag(block, "report-no"),
    license: tag(block, "license"),
  };
}

// ═══ P1 — metadata harvest ════════════════════════════════════════════════════
// export.arxiv.org/oai2 301-redirects here; using the final host directly keeps
// the resumption requests on one origin.
const OAI = "https://oaipmh.arxiv.org/oai";

async function harvestSet(setSpec, name) {
  mkdirSync(DATA, { recursive: true });
  const out = `${DATA}/${name}.jsonl`;
  const stateFile = `${DATA}/${name}.state.json`;

  let state = null;
  if (existsSync(stateFile)) {
    try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch { state = null; }
  }
  if (state?.done) { console.log(`${name}: already complete — ${state.records} records`); return state; }
  if (!state) {
    state = { set: setSpec, token: null, records: 0, deleted: 0, pages: 0, done: false, startedAt: new Date().toISOString() };
    writeFileSync(out, "");    // fresh start truncates
  } else {
    console.log(`${name}: resuming at page ${state.pages + 1} (${state.records} records so far)`);
  }
  const save = () => {
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(state, null, 2));
    renameSync(`${stateFile}.tmp`, stateFile);
  };

  const t0 = Date.now();
  for (;;) {
    const u = state.token
      ? `${OAI}?verb=ListRecords&resumptionToken=${encodeURIComponent(state.token)}`
      : `${OAI}?verb=ListRecords&metadataPrefix=arXiv&set=${encodeURIComponent(setSpec)}`;
    const res = await arxivFetch(u);
    const xml = await res.text();

    const err = xml.match(/<error code="([^"]+)"[^>]*>([^<]*)</);
    if (err) {
      if (err[1] === "noRecordsMatch") { state.done = true; save(); break; }
      throw new Error(`OAI error ${err[1]}: ${err[2]}`);
    }

    const lines = [];
    let deleted = 0;
    for (const m of xml.matchAll(/<record>([\s\S]*?)<\/record>/g)) {
      const r = parseRecord(m[1]);
      if (!r) continue;
      if (r.deleted) { deleted++; continue; }
      lines.push(JSON.stringify(r));
    }
    if (lines.length) appendFileSync(out, lines.join("\n") + "\n");
    state.records += lines.length;
    state.deleted += deleted;
    state.pages++;

    const tok = xml.match(/<resumptionToken[^>]*>([^<]*)<\/resumptionToken>/);
    state.token = tok && tok[1].trim() ? tok[1].trim() : null;
    if (!state.token) state.done = true;
    save();

    const mins = (Date.now() - t0) / 60_000;
    console.log(`  ${name} page ${state.pages}: +${lines.length} (${state.records} total` +
      `${state.deleted ? `, ${state.deleted} deleted` : ""})  ${mins.toFixed(1)}m`);
    if (state.done) break;
  }
  console.log(`${name}: DONE — ${state.records} records in ${state.pages} pages, ` +
    `${((Date.now() - t0) / 60_000).toFixed(1)} min`);
  return state;
}

async function phaseHarvest() {
  const only = flag("--set");
  const sets = [["physics:nucl-ex", "nucl-ex"], ["physics:nucl-th", "nucl-th"]]
    .filter(([, n]) => !only || n === only);
  const t0 = Date.now();
  const results = [];
  for (const [spec, name] of sets) results.push([name, await harvestSet(spec, name)]);
  console.log(`\nP1 COMPLETE in ${((Date.now() - t0) / 60_000).toFixed(1)} min`);
  for (const [name, s] of results) {
    console.log(`  ${name}: ${s.records} records, ${s.deleted} deleted, ${s.pages} pages`);
  }
  console.log(`  arXiv 429s: ${rateLimitHits}, final floor ${((ARXIV_FLOOR_MS + extraDelayMs) / 1000).toFixed(1)}s`);
}

// ═══ P2 — corpus PDFs from the public GCS mirror ══════════════════════════════
const GCS_API = "https://storage.googleapis.com/storage/v1/b/arxiv-dataset/o";
const GCS_OBJ = "https://storage.googleapis.com/arxiv-dataset";

// arXiv ids come off S2/OpenAlex in several dresses: "arXiv:2101.00001v2",
// "2101.00001", "nucl-ex/0103001". Normalize to the bare, versionless id.
function normalizeArxivId(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/^arxiv:/i, "").replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, "");
  s = s.replace(/\.pdf$/i, "").replace(/v\d+$/i, "");
  if (/^\d{4}\.\d{4,5}$/.test(s)) return s;
  if (/^[a-z-]+(\.[A-Za-z-]{2,})?\/\d{7}$/i.test(s)) return s.toLowerCase();
  return null;
}

// Mirror layout: new-style ids live under arxiv/arxiv/pdf/YYMM/, old-style under
// their ARCHIVE name (subject class dropped): arxiv/<archive>/pdf/YYMM/<num>vN.pdf
function gcsLocation(id) {
  let m = id.match(/^(\d{2})(\d{2})\.(\d{4,5})$/);
  if (m) return { dir: `arxiv/arxiv/pdf/${m[1]}${m[2]}`, base: id };
  m = id.match(/^([a-z-]+)(?:\.[A-Za-z-]+)?\/((\d{4})\d{3})$/i);
  if (m) return { dir: `arxiv/${m[1].toLowerCase()}/pdf/${m[3]}`, base: m[2] };
  return null;
}

const localPdfPath = (id) => `${PDF_DIR}/${id}.pdf`;

async function gcsList(prefix) {
  const items = [];
  let pageToken = null;
  for (let page = 0; page < 200; page++) {
    const u = `${GCS_API}?prefix=${encodeURIComponent(prefix)}&maxResults=1000` +
      `&fields=items(name,size),nextPageToken${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    let json = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(120_000) });
        if (res.ok) { json = await res.json(); break; }
        if (res.status === 404) return items;
        await sleep(2000 * 2 ** attempt);
      } catch { await sleep(2000 * 2 ** attempt); }
    }
    if (!json) throw new Error(`GCS list failed: ${prefix}`);
    for (const it of json.items ?? []) items.push({ name: it.name, size: Number(it.size) });
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  return items;
}

// name → version, keeping only the highest version of each base id.
function indexVersions(items, into = new Map()) {
  for (const it of items) {
    const m = it.name.match(/\/([^/]+?)v(\d+)\.pdf$/);
    if (!m) continue;
    const [, base, v] = m;
    const ver = Number(v);
    const prev = into.get(base);
    if (!prev || ver > prev.ver) into.set(base, { ver, name: it.name, size: it.size });
  }
  return into;
}

const parseCsvLine = (line) => {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
};

// The P2 worklist: every corpus row with an arXiv id and no stored PDF.
// `--worklist <file>` reads a saved CSV instead (re-runs, rehearsals).
async function loadWorklist() {
  const file = flag("--worklist");
  const csv = file
    ? readFileSync(file, "utf8")
    : await psqlRetry("\\copy (SELECT key_number, arxiv_id FROM nsr WHERE arxiv_id IS NOT NULL AND pdf_stored IS NULL) TO STDOUT WITH (FORMAT csv)\n");
  const work = [];
  const unparsable = [];
  for (const line of csv.split("\n")) {
    if (!line) continue;
    const [key_number, raw] = parseCsvLine(line);
    const id = normalizeArxivId(raw);
    if (!id) { unparsable.push(raw); continue; }
    work.push({ key_number, id, raw });
  }
  console.log(`worklist: ${work.length} rows (${unparsable.length} unparsable arxiv_id)` +
    (file ? ` from ${file}` : ""));
  if (unparsable.length) console.log(`  e.g. ${unparsable.slice(0, 5).join(", ")}`);
  return work;
}

// Find the highest-version PDF object on the mirror for each id. Costs GCS
// requests only — no bytes, no arXiv rate limit. Dense directories are cheaper
// listed whole; sparse ones get a per-id prefix list.
async function resolveOnMirror(pending, { conc = 8, threshold = 10 } = {}) {
  const byDir = new Map();
  const noLocation = [];
  const located = [];
  for (const w of pending) {
    const loc = gcsLocation(w.id);
    if (!loc) { noLocation.push(w); continue; }
    w.base = loc.base;
    w.dir = loc.dir;                 // cached — the filters below must not re-derive
    located.push(w);
    if (!byDir.has(loc.dir)) byDir.set(loc.dir, []);
    byDir.get(loc.dir).push(w);
  }
  console.log(`  ${byDir.size} mirror directories, ${noLocation.length} ids with no derivable path`);

  const versions = new Map();   // `${dir}/${base}` -> {name,size,ver}
  let dirsDone = 0;
  const dirEntries = [...byDir.entries()];
  await pool(dirEntries, conc, async ([dir, ws]) => {
    if (ws.length >= threshold) {
      const idx = indexVersions(await gcsList(`${dir}/`));
      for (const w of ws) { const v = idx.get(w.base); if (v) versions.set(`${dir}/${w.base}`, v); }
    } else {
      for (const w of ws) {
        const idx = indexVersions(await gcsList(`${dir}/${w.base}v`));
        const v = idx.get(w.base);
        if (v) versions.set(`${dir}/${w.base}`, v);
      }
    }
    dirsDone++;
    if (dirsDone % 25 === 0) process.stdout.write(`  resolved ${dirsDone}/${dirEntries.length} dirs\r`);
  });
  const resolved = located.filter((w) => versions.has(`${w.dir}/${w.base}`));
  const missing = [...located.filter((w) => !versions.has(`${w.dir}/${w.base}`)), ...noLocation];
  const expectBytes = resolved.reduce((n, w) => n + (versions.get(`${w.dir}/${w.base}`).size || 0), 0);
  console.log(`\n  resolved ${resolved.length} on the mirror, ${missing.length} not found there` +
    ` — ${(expectBytes / 1e9).toFixed(1)} GB (avg ${(expectBytes / Math.max(1, resolved.length) / 1024).toFixed(0)} KB)`);
  return { versions, resolved, missing, expectBytes };
}

// ── `resolve` — build the EC2 worklist ────────────────────────────────────────
// Emits the exact GCS object path + byte size per paper, so the instance does
// pure I/O (no listing, no guessing) and the byte total is known before launch.
async function phaseResolve() {
  mkdirSync(DATA, { recursive: true });
  const work = await loadWorklist();
  if (!work.length) { console.log("nothing to resolve"); return; }
  const { versions, resolved, missing, expectBytes } = await resolveOnMirror(work, {
    conc: num("--concurrency", 8), threshold: num("--dir-threshold", 10),
  });

  const outCsv = flag("--out") ?? `${DATA}/worklist-resolved.csv`;
  const missCsv = `${DATA}/worklist-misses.csv`;
  writeFileSync(outCsv, resolved.map((w) => {
    const v = versions.get(`${w.dir}/${w.base}`);
    return csvRow([w.key_number, w.id, v.name, v.size]);
  }).join("\n") + "\n");
  writeFileSync(missCsv, missing.map((w) => csvRow([w.key_number, w.raw ?? w.id])).join("\n") + (missing.length ? "\n" : ""));

  console.log(`\nwrote ${outCsv}  (${resolved.length} files, ${(expectBytes / 1e9).toFixed(2)} GB)`);
  console.log(`wrote ${missCsv}  (${missing.length} for the export.arxiv.org fallback)`);
}

// ── `writeback` — DB update from the instance's completion logs ───────────────
// Reads {id, key_number, s3_key, bytes} JSONL (a directory of them), 1k per batch.
// Neon credentials never leave this laptop.
async function phaseWriteback() {
  const dir = flag("--logs") ?? "data/arxiv/s3-logs";
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => `${dir}/${f}`)
    : [];
  if (!files.length) { console.log(`no .jsonl logs in ${dir}`); return; }
  console.log(`${files.length} log file(s) in ${dir}`);

  const seen = new Set();
  const rows = [];
  for (const f of files) {
    await readJsonl(f, (r) => {
      if (!r.key_number || !r.s3_key || seen.has(r.key_number)) return;
      seen.add(r.key_number);
      rows.push(r);
    });
  }
  console.log(`${rows.length} unique stored PDFs to write back`);

  let written = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const slice = rows.slice(i, i + 1000);
    await psqlRetry(`BEGIN;
CREATE TEMP TABLE stage_pdf (key_number text, path text, url text) ON COMMIT DROP;
COPY stage_pdf FROM STDIN WITH (FORMAT csv);
${slice.map((r) => csvRow([r.key_number, `s3://${r.bucket ?? "nsr-pdfs"}/${r.s3_key}`, `https://arxiv.org/pdf/${r.id}`])).join("\n")}
\\.
UPDATE nsr SET pdf_stored = coalesce(nsr.pdf_stored, s.path), pdf_url = coalesce(nsr.pdf_url, s.url)
FROM stage_pdf s WHERE nsr.key_number = s.key_number;
COMMIT;`);
    written += slice.length;
    process.stdout.write(`  ${written}/${rows.length} written back\r`);
  }
  console.log(`\nwriteback: ${written} rows`);
  console.log((await psqlRetry("SELECT count(pdf_stored) AS pdf_stored, count(pdf_url) AS pdf_url FROM nsr;\n")).trim());
}

// ── `pdfs` — the laptop path: GCS → local disk (kept as the EC2-free fallback),
// and the export.arxiv.org fallback for ids the mirror does not have.
async function phasePdfs() {
  const LIMIT = num("--limit", Infinity);
  const CONC = num("--concurrency", 16);
  const FALLBACK_ONLY = has("--fallback-only");
  mkdirSync(PDF_DIR, { recursive: true });

  const work = await loadWorklist();
  if (!work.length) return;

  // Already on disk from an earlier run — still needs the DB write-back.
  const pending = [];
  const onDisk = [];
  for (const w of work.slice(0, LIMIT === Infinity ? work.length : LIMIT)) {
    const p = localPdfPath(w.id);
    if (existsSync(p) && statSync(p).size > 1000) onDisk.push({ ...w, path: p });
    else pending.push(w);
  }
  console.log(`  ${onDisk.length} already downloaded, ${pending.length} to fetch`);

  const { versions, resolved: allResolved, missing } = await resolveOnMirror(pending, {
    conc: Math.min(8, CONC), threshold: num("--dir-threshold", 10),
  });
  const resolved = FALLBACK_ONLY ? [] : allResolved;

  // ── download + write back in 1k batches ────────────────────────────────────
  let stored = 0, failed = 0, bytes = 0, written = 0;
  const t0 = Date.now();
  let reported500 = false;
  const batch = [];

  // Workers run concurrently, so the batch must be detached SYNCHRONOUSLY: a
  // `batch.length = 0` after the await would silently discard every row another
  // worker pushed while psql was running — files on disk, nothing in the DB.
  const flush = async () => {
    const slice = batch.splice(0, batch.length);
    if (!slice.length) return;
    const rows = slice.map((d) => csvRow([d.key_number, d.path, `https://arxiv.org/pdf/${d.id}`]));
    await psqlRetry(`BEGIN;
CREATE TEMP TABLE stage_pdf (key_number text, path text, url text) ON COMMIT DROP;
COPY stage_pdf FROM STDIN WITH (FORMAT csv);
${rows.join("\n")}
\\.
UPDATE nsr SET pdf_stored = s.path, pdf_url = coalesce(nsr.pdf_url, s.url)
FROM stage_pdf s WHERE nsr.key_number = s.key_number;
COMMIT;`);
    written += slice.length;
  };

  // Files a previous run downloaded but never got to write back.
  for (const d of onDisk) { batch.push(d); if (batch.length >= 1000) await flush(); }
  await flush();

  await pool(resolved, CONC, async (w) => {
    const v = versions.get(`${w.dir}/${w.base}`);
    const path = localPdfPath(w.id);
    mkdirSync(dirname(path), { recursive: true });
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(`${GCS_OBJ}/${v.name}`, {
          headers: { "User-Agent": UA }, signal: AbortSignal.timeout(180_000),
        });
        if (!res.ok) { if (res.status === 404) break; await sleep(2000 * 2 ** attempt); continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1000) break;                 // not a real PDF
        writeFileSync(path, buf);
        bytes += buf.length;
        stored++;
        batch.push({ ...w, path });
        if (batch.length >= 1000) await flush();
        if (!reported500 && stored >= 500) {
          reported500 = true;
          const mins = (Date.now() - t0) / 60_000;
          const rate = stored / mins;
          console.log(`\n📈 MEASURED after ${stored} files: ${rate.toFixed(0)} files/min, ` +
            `${(bytes / 1e6 / (mins * 60)).toFixed(1)} MB/s — projection for ${resolved.length} files: ` +
            `${(resolved.length / rate / 60).toFixed(2)} h, ${(expectBytes / 1e9).toFixed(1)} GB\n`);
        }
        if (stored % 250 === 0) {
          const mins = (Date.now() - t0) / 60_000;
          process.stdout.write(`  ${stored}/${resolved.length} stored  ${(stored / mins).toFixed(0)}/min  ` +
            `${(bytes / 1e9).toFixed(2)} GB\r`);
        }
        return;
      } catch { await sleep(2000 * 2 ** attempt); }
    }
    failed++;
  });
  await flush();

  // Fallback for mirror misses only — through the polite queue.
  const fallback = missing.slice(0, num("--max-fallback", 2000));
  if (fallback.length) {
    console.log(`\nfallback: ${fallback.length} ids via export.arxiv.org at ` +
      `${((ARXIV_FLOOR_MS + extraDelayMs) / 1000).toFixed(1)}s/req ` +
      `(~${(fallback.length * (ARXIV_FLOOR_MS + extraDelayMs) / 3_600_000).toFixed(1)} h)`);
    for (const w of fallback) {
      try {
        const res = await arxivFetch(`https://export.arxiv.org/pdf/${w.id}`, { tries: 3 });
        if (!res.ok) { failed++; continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1000) { failed++; continue; }
        const path = localPdfPath(w.id);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, buf);
        bytes += buf.length; stored++;
        batch.push({ ...w, path });
        if (batch.length >= 1000) await flush();
      } catch (e) { failed++; }
    }
    await flush();
  }

  const mins = (Date.now() - t0) / 60_000;
  console.log(`\nP2: stored ${stored} (+${onDisk.length} already on disk), written back ${written}, ` +
    `failed ${failed}, ${(bytes / 1e9).toFixed(2)} GB in ${mins.toFixed(1)} min (${(stored / mins).toFixed(0)}/min)`);
}

// A fixed-size worker pool: `n` tasks in flight, no batching barrier.
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await fn(items[idx], idx); } catch (e) { console.log(`  ⚠ ${e.message.slice(0, 160)}`); }
    }
  });
  await Promise.all(workers);
}

// ═══ P3 — new rows for arXiv papers the corpus lacks ══════════════════════════
async function readJsonl(path, onRec) {
  if (!existsSync(path)) { console.log(`  (${path} missing — skipped)`); return 0; }
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { onRec(JSON.parse(line)); n++; } catch { /* torn last line from a kill */ }
  }
  return n;
}

// arXiv id → publication year. Old style 9107xxx..9912xxx is the 1990s.
function yearFromRecord(r) {
  const d = r.created || r.datestamp;
  if (d && /^\d{4}-/.test(d)) return Number(d.slice(0, 4));
  let m = r.id.match(/^(\d{2})\d{2}\./);
  if (m) return 2000 + Number(m[1]);
  m = r.id.match(/\/(\d{2})\d{5}$/);
  if (m) { const yy = Number(m[1]); return yy >= 91 ? 1900 + yy : 2000 + yy; }
  return null;
}

async function phaseInsert() {
  // --dry-apply runs the REAL statement end to end and then ROLLBACKs: it proves
  // the CSV escaping, the jsonb payload and the column types all survive a
  // full-scale COPY before anything is committed to a 255k-row corpus.
  const DRY_APPLY = has("--dry-apply");
  const APPLY = has("--apply") || DRY_APPLY;
  const CHUNK = num("--chunk", 25_000);

  // 1. the harvest, deduped across the two sets (cross-listed papers appear in both)
  const recs = new Map();
  for (const name of ["nucl-ex", "nucl-th"]) {
    const before = recs.size;
    const n = await readJsonl(`${DATA}/${name}.jsonl`, (r) => {
      if (!r.id || r.deleted) return;
      const prev = recs.get(r.id);
      if (prev) { for (const s of r.sets ?? []) if (!prev.sets.includes(s)) prev.sets.push(s); return; }
      r.harvested_set = name;
      recs.set(r.id, r);
    });
    console.log(`  ${name}: ${n} lines → ${recs.size - before} new unique ids (${recs.size} total)`);
  }

  // 2. what the corpus already has
  console.log("loading corpus keys …");
  const haveArxiv = new Set();
  const haveDoi = new Set();
  const a = await psqlRetry("\\copy (SELECT arxiv_id FROM nsr WHERE arxiv_id IS NOT NULL) TO STDOUT\n");
  for (const l of a.split("\n")) {
    const s = l.trim();
    if (!s) continue;
    haveArxiv.add(s.toLowerCase());               // whatever shape the other lanes wrote
    const id = normalizeArxivId(s);
    if (id) haveArxiv.add(id);                    // …and its normalized form
  }
  const d = await psqlRetry("\\copy (SELECT lower(doi) FROM nsr WHERE doi IS NOT NULL) TO STDOUT\n");
  for (const l of d.split("\n")) { const s = l.trim(); if (s) haveDoi.add(s); }
  console.log(`  corpus: ${haveArxiv.size} arxiv ids, ${haveDoi.size} dois`);

  // 3. NEW = unknown arXiv id AND unknown published DOI AND unknown arXiv DOI
  const fresh = [];
  let skipArxiv = 0, skipDoi = 0, skipArxivDoi = 0, noYear = 0;
  for (const r of recs.values()) {
    const id = normalizeArxivId(r.id) ?? r.id.toLowerCase();
    if (haveArxiv.has(id)) { skipArxiv++; continue; }
    if (r.doi) {
      // arXiv's <doi> can carry several space-separated DOIs (multi-part papers).
      const dois = r.doi.split(/\s+/).filter(Boolean).map((x) => x.toLowerCase());
      if (dois.some((x) => haveDoi.has(x))) { skipDoi++; continue; }
    }
    if (haveDoi.has(`10.48550/arxiv.${id}`)) { skipArxivDoi++; continue; }
    const year = yearFromRecord(r);
    if (!year) { noYear++; continue; }
    fresh.push({ r, id, year });
  }
  console.log(`  candidates: ${recs.size} harvested → ${fresh.length} NEW ` +
    `(skipped: ${skipArxiv} known arxiv_id, ${skipDoi} known DOI, ${skipArxivDoi} known arXiv DOI, ${noYear} no year)`);
  if (!APPLY) { console.log("DRY RUN — re-run with --apply to insert."); return; }

  // 4. stage + insert in chunks
  let inserted = 0;
  for (let i = 0; i < fresh.length; i += CHUNK) {
    const slice = fresh.slice(i, i + CHUNK);
    const rows = slice.map(({ r, id, year }) => {
      const key = `10.48550/arXiv.${r.id}`;
      return csvRow([
        key, year, r.title, (r.authors ?? []).join("; "), key, r.abstract, r.id,
        JSON.stringify({
          source: "arxiv-oai", set: r.sets ?? [], harvested_set: r.harvested_set,
          categories: r.categories ?? [], journal_ref: r.journal_ref, published_doi: r.doi,
          comments: r.comments, report_no: r.report_no, license: r.license,
          created: r.created, updated: r.updated, datestamp: r.datestamp,
          harvested: new Date().toISOString().slice(0, 10),
        }),
      ]);
    });
    const out = await psqlRetry(`BEGIN;
CREATE TEMP TABLE stage_arxiv (
  key_number text, pub_year int, title text, authors text, doi text,
  abstract text, arxiv_id text, raw jsonb
) ON COMMIT DROP;
COPY stage_arxiv FROM STDIN WITH (FORMAT csv);
${rows.join("\n")}
\\.
WITH ins AS (
  INSERT INTO nsr (key_number, pub_year, title, authors, doi, abstract, arxiv_id,
                   reference_type, is_primary, is_nsr, raw)
  SELECT key_number, pub_year, title, authors, doi, abstract, arxiv_id,
         'PREPRINT', true, false, raw
  FROM stage_arxiv
  ON CONFLICT (key_number) DO NOTHING
  RETURNING key_number
) SELECT count(*) FROM ins;
${DRY_APPLY ? "ROLLBACK;" : "COMMIT;"}`);
    const n = Number(out.match(/(\d+)/)?.[1] ?? 0);
    inserted += n;
    console.log(`  chunk ${i / CHUNK + 1}: ${slice.length} staged → ${n} inserted (${inserted} total)`);
  }
  console.log(`P3: ${DRY_APPLY ? "WOULD HAVE inserted" : "inserted"} ${inserted}${DRY_APPLY ? " (rolled back)" : ""}`);
  console.log((await psqlRetry("SELECT is_nsr, count(*) FROM nsr GROUP BY 1 ORDER BY 1;\n")).trim());
}

// ── main ──────────────────────────────────────────────────────────────────────
const PHASES = {
  harvest: phaseHarvest, resolve: phaseResolve, pdfs: phasePdfs,
  writeback: phaseWriteback, insert: phaseInsert,
};
if (!PHASES[CMD]) {
  console.error(`usage: ingest-arxiv.mjs <${Object.keys(PHASES).join("|")}> [flags]`);
  process.exit(1);
}
await PHASES[CMD]().catch((e) => { console.error(e); process.exit(1); });
