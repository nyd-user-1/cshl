// Enrich every DOI-bearing row in `nsr` with OpenAlex.
//
//   node --env-file=.env.local scripts/enrich-openalex-batch.mjs --budget
//   node --env-file=.env.local scripts/enrich-openalex-batch.mjs --probe
//   node --env-file=.env.local scripts/enrich-openalex-batch.mjs --fetch [--limit N]
//   node --env-file=.env.local scripts/enrich-openalex-batch.mjs --write
//   node --env-file=.env.local scripts/enrich-openalex-batch.mjs --sweep   (free, then --write again)
//   node --env-file=.env.local scripts/enrich-openalex-batch.mjs --verify
//   node --env-file=.env.local scripts/enrich-openalex-batch.mjs --recover [--sample 200]
//
// UPDATE-ONLY. This lane owns openalex_id, oa_status, oa_locations,
// openalex_topics, openalex_cited_by. It SHARES arxiv_id and pdf_url with two
// other lanes and therefore writes both only as coalesce(nsr.<col>, <new>).
// It INSERTs nothing.
//
// ── SPEND ────────────────────────────────────────────────────────────────────
// OpenAlex credits (per request): singleton-by-DOI 0 · list+filter 1 · search 10.
// 10,000 credits/day free with a key, resets midnight UTC, and the key is SHARED
// with the 44b project — so the pool is READ before a run, never assumed.
//
// ⚠ A 429's rate-limit headers LIE. A 429 thrown for exceeding the per-second
// pace reports `x-ratelimit-remaining: 0` and a midnight reset — byte-identical
// to a 429 for a genuinely exhausted pool (measured in 44b with 9,838 credits
// still in hand). Exhaustion is therefore judged ONLY from what the last
// SUCCESSFUL (2xx) response reported; a 429 merely widens the pace gap and
// retries.
//
// Crash safety: every fetched page lands in data/openalex/page-NNNN.json before
// the next request goes out, and --fetch skips any page already on disk. A crash
// costs zero re-spend.

import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";

// ── args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const numArg = (flag, dflt) => {
  const i = args.indexOf(flag);
  if (i < 0) return dflt;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : dflt;
};

const BATCH = Math.min(numArg("--batch", 50), 100);   // DOIs per pipe-joined filter
const RPS = Math.min(numArg("--rps", 8), 90);         // pace ceiling, aggregate
const CONC = Math.max(1, Math.min(numArg("--concurrency", 4), 16));
const LIMIT = numArg("--limit", 0);
const SAMPLE = numArg("--sample", 200);
const MAX_CREDITS = numArg("--max-credits", 7000);
const FLOOR = numArg("--floor", 300);                 // stop with this much left
const WRITE_CHUNK = Math.min(numArg("--write-chunk", 25000), 25000);

const API = "https://api.openalex.org";
const KEY = process.env.OPENALEX_API_KEY || "";
const MAILTO = process.env.OPENALEX_MAILTO || "";
const PAGES = "data/openalex";

// `select` takes TOP-LEVEL field names only (a dotted path is a 400).
const SELECT = ["id", "doi", "ids", "open_access", "best_oa_location", "locations", "topics", "cited_by_count"].join(",");

// ── psql plumbing (verbatim from scripts/ingest-aps-feeds.mjs) ───────────────
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

// ── helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const n = (v) => Number(v ?? 0).toLocaleString("en-US");
const pct = (a, b) => `${((100 * a) / Math.max(b, 1)).toFixed(2)}%`;
const money = (c) => `$${(c / 10000).toFixed(4)}`;
const shortId = (u) => (u ? String(u).replace(/^https?:\/\/openalex\.org\//, "") : null);

// Lowercase, strip any URL/`doi:` prefix, take the first DOI-shaped token — a
// stray comma or pipe inside a filter value would silently split the batch.
function normDoi(raw) {
  if (!raw) return null;
  let d = String(raw).trim().toLowerCase();
  d = d.replace(/^https?:\/\/(dx\.)?doi\.org\//, "").replace(/^doi:/, "");
  const m = d.match(/10\.\d{4,9}\/[^\s;]+/);
  if (!m) return null;
  d = m[0].replace(/[.,;]+$/, "");
  return d.length > 5 ? d : null;
}
const filterSafe = (d) => d && !d.includes(",") && !d.includes("|");

// ── the API layer ────────────────────────────────────────────────────────────
const usage = {
  calls: 0, credits: 0, limit: null, remaining: null, resetSeconds: null,
  free: 0, errors: 0, retries: 0, throttles: 0, notFound: 0,
  paceGap: 1000 / RPS, minGap: 1000 / RPS, okStreak: 0,
};
let aborted = null;

/** `remaining` is trusted ONLY off a 2xx — see the header note. */
function readUsage(res) {
  const g = (h) => { const v = res.headers.get(h); return v == null ? null : Number(v); };
  const used = g("x-ratelimit-credits-used");
  const rem = g("x-ratelimit-remaining");
  const lim = g("x-ratelimit-limit");
  const reset = g("x-ratelimit-reset");
  if (used != null && Number.isFinite(used)) { usage.credits += used; if (used === 0) usage.free++; }
  if (res.ok && rem != null && Number.isFinite(rem)) usage.remaining = rem;
  if (lim != null && Number.isFinite(lim)) usage.limit = lim;
  if (reset != null && Number.isFinite(reset)) usage.resetSeconds = reset;
  return { used, rem, lim, reset };
}

/** One request. The api_key never reaches a log line — `redact` is what prints. */
async function oa(path, { redact = path } = {}) {
  if (aborted) return null;
  if (usage.credits >= MAX_CREDITS) {
    aborted = `local ceiling: --max-credits ${MAX_CREDITS} reached`;
    return null;
  }
  const sep = path.includes("?") ? "&" : "?";
  const auth = [KEY ? `api_key=${encodeURIComponent(KEY)}` : "", MAILTO ? `mailto=${encodeURIComponent(MAILTO)}` : ""]
    .filter(Boolean).join("&");
  const full = `${API}${path}${auth ? sep + auth : ""}`;

  let delay = 1500;
  for (let attempt = 0; attempt < 6; attempt++) {
    let res;
    try {
      res = await fetch(full, { headers: { "User-Agent": "nsr-openalex-enrich/1.0 (+https://github.com/nsr)" } });
    } catch {
      usage.retries++;
      await sleep(delay); delay = Math.min(delay * 2, 20000);
      continue;
    }
    usage.calls++;
    const u = readUsage(res);

    if (res.ok) {
      if (u.rem != null && u.rem <= FLOOR) aborted = `budget floor: ${n(u.rem)} credits left (--floor ${FLOOR})`;
      if (++usage.okStreak >= 250) { usage.okStreak = 0; usage.paceGap = Math.max(usage.minGap, usage.paceGap * 0.9); }
      return { data: await res.json(), used: u.used };
    }
    if (res.status === 404) { usage.notFound++; return { data: null, used: u.used }; }
    if (res.status === 429) {
      // Exhaustion is decided by the last SUCCESSFUL reading, never by the 429.
      if (usage.remaining != null && usage.remaining <= FLOOR) {
        aborted = `daily allowance exhausted — last good reading ${n(usage.remaining)} credits, resets in ${u.reset ?? "?"}s. Stopped, not billed.`;
        return null;
      }
      usage.throttles++;
      usage.okStreak = 0;
      usage.paceGap = Math.min(usage.paceGap * 1.25, 1000);
      if (usage.throttles === 1 || usage.throttles % 25 === 0) {
        console.log(`  ~ throttled (429) — easing to ~${(1000 / usage.paceGap).toFixed(1)} req/s`);
      }
      usage.retries++;
      await sleep(delay); delay = Math.min(delay * 2, 30000);
      continue;
    }
    if (res.status >= 500) { usage.retries++; await sleep(delay); delay = Math.min(delay * 2, 30000); continue; }
    usage.errors++;
    if (usage.errors <= 5) {
      let body = "";
      try { body = (await res.text()).slice(0, 300); } catch {}
      console.log(`  ! HTTP ${res.status} on ${redact}${body ? ` — ${body}` : ""}`);
    }
    return null;
  }
  usage.errors++;
  return null;
}

// A shared pace cursor so CONC workers still sum to RPS overall.
let paceCursor = 0;
async function pace() {
  const gap = usage.paceGap;
  const now = Date.now();
  const slot = Math.max(now, paceCursor);
  paceCursor = slot + gap;
  if (slot > now) await sleep(slot - now);
}

/** FREE by-DOI singleton — the `doi:` prefix must stay literal to bill 0. */
async function fetchOneByDoi(doi) {
  const r = await oa(`/works/doi:${encodeURIComponent(doi)}?select=${SELECT}`, { redact: `/works/doi:${doi}` });
  return r?.data ?? null;
}

/**
 * One filter call resolves up to BATCH works for 1 credit. per-page is set
 * ABOVE the batch size deliberately: a DOI filter can return MORE works than
 * values given (OpenAlex holds merged/duplicate works sharing a DOI), and at
 * per-page == batch the overflow falls off page 1.
 */
async function fetchByDois(dois) {
  const q = `/works?filter=doi:${dois.map(encodeURIComponent).join("|")}&per-page=100&select=${SELECT}`;
  const r = await oa(q, { redact: `/works?filter=doi:[${dois.length} dois]` });
  const page1 = r?.data;
  if (!page1?.results) return null;
  const results = [...page1.results];
  const count = page1.meta?.count ?? results.length;
  if (count > results.length) {
    const r2 = await oa(`${q}&page=2`, { redact: `/works?filter=doi:[${dois.length} dois]&page=2` });
    results.push(...(r2?.data?.results ?? []));
  }
  return results;
}

// ── distilling one work ──────────────────────────────────────────────────────
const ARXIV_URL = /arxiv\.org\/(?:abs|pdf)\/([a-z-]+(?:\.[a-z]{2})?\/\d{7}|\d{4}\.\d{4,5})/i;
const ARXIV_DOI = /^10\.48550\/arxiv\.([a-z-]+(?:\.[a-z]{2})?\/\d{7}|\d{4}\.\d{4,5})/i;

function arxivIdOf(w) {
  const fromDoi = normDoi(w.doi)?.match(ARXIV_DOI);
  if (fromDoi) return fromDoi[1];
  for (const [k, v] of Object.entries(w.ids ?? {})) {
    if (k === "arxiv" && v) {
      const m = String(v).match(ARXIV_URL) ?? String(v).match(/(\d{4}\.\d{4,5})/);
      if (m) return m[1];
    }
    if (typeof v === "string") { const m = v.match(ARXIV_URL); if (m) return m[1]; }
  }
  for (const l of w.locations ?? []) {
    const src = `${l?.source?.id ?? ""} ${l?.source?.display_name ?? ""}`;
    const urls = `${l?.pdf_url ?? ""} ${l?.landing_page_url ?? ""}`;
    const m = urls.match(ARXIV_URL);
    if (m) return m[1];
    if (/arxiv/i.test(src)) {
      const m2 = urls.match(/(\d{4}\.\d{4,5})/);
      if (m2) return m2[1];
    }
  }
  return null;
}

const slimLocations = (w) => {
  const out = (w.locations ?? [])
    .filter((l) => l?.is_oa)
    .map((l) => ({
      source: l.source?.display_name ?? null,
      pdf_url: l.pdf_url ?? null,
      landing_page_url: l.landing_page_url ?? null,
      version: l.version ?? null,
    }));
  return out.length ? out : null;
};

const slimTopics = (w) => {
  const out = (w.topics ?? []).map((t) => ({
    display_name: t.display_name ?? null,
    score: t.score ?? null,
    field: t.field?.display_name ?? null,
  }));
  return out.length ? out : null;
};

const distill = (w) => ({
  openalex_id: shortId(w.id),
  oa_status: w.open_access?.oa_status ?? null,
  oa_locations: slimLocations(w),
  openalex_topics: slimTopics(w),
  openalex_cited_by: w.cited_by_count ?? null,
  pdf_url: w.best_oa_location?.pdf_url ?? null,
  arxiv_id: arxivIdOf(w),
});

// ── P1: export ───────────────────────────────────────────────────────────────
async function exportRows() {
  const t0 = Date.now();
  const out = await psql(`\\copy (SELECT key_number, doi FROM nsr WHERE doi IS NOT NULL ORDER BY key_number) TO STDOUT WITH (FORMAT text)`);
  const rows = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const t = line.indexOf("\t");
    if (t < 0) continue;
    rows.push({ key_number: line.slice(0, t), doi: line.slice(t + 1) });
  }
  console.log(`P1  exported ${n(rows.length)} DOI-bearing rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return rows;
}

/** key_number rows → { batches: [[doi,...]], byDoi: Map<doi, key_number[]>, unusable } */
function planBatches(rows) {
  const byDoi = new Map();
  let unusable = 0, unsafe = 0;
  for (const r of rows) {
    const d = normDoi(r.doi);
    if (!d) { unusable++; continue; }
    if (!byDoi.has(d)) byDoi.set(d, []);
    byDoi.get(d).push(r.key_number);
  }
  // A comma or pipe inside a filter value would silently split the batch, so
  // those DOIs skip the filter lane entirely and fall to the free singleton
  // sweep — they stay in byDoi so --write still counts them as unmatched.
  const dois = [...byDoi.keys()].filter((d) => { if (filterSafe(d)) return true; unsafe++; return false; });
  const batches = [];
  for (let i = 0; i < dois.length; i += BATCH) batches.push(dois.slice(i, i + BATCH));
  return { batches, byDoi, unusable, unsafe, uniqueDois: dois.length };
}

// ── P2: batch fetch ──────────────────────────────────────────────────────────
const pagePath = (i) => `${PAGES}/page-${String(i).padStart(4, "0")}.json`;

async function phaseFetch() {
  mkdirSync(PAGES, { recursive: true });
  const rows = await exportRows();
  const plan = planBatches(rows);
  let batches = plan.batches;
  if (LIMIT) batches = batches.slice(0, LIMIT);

  const todo = batches.map((b, i) => i).filter((i) => !existsSync(pagePath(i)));
  console.log(`P2  ${n(plan.uniqueDois)} unique DOIs → ${n(batches.length)} filter requests (${BATCH}/request)`);
  console.log(`    ${n(batches.length - todo.length)} pages already on disk, ${n(todo.length)} to fetch`);
  console.log(`    projected spend ~${n(todo.length)} credits (${money(todo.length)}) · pace ≤${RPS} req/s × ${CONC} workers`);
  if (plan.unusable || plan.unsafe) console.log(`    ${n(plan.unusable)} DOIs unparseable, ${n(plan.unsafe)} filter-unsafe (free singleton lane)`);
  if (!todo.length) { console.log("    nothing to fetch"); return; }

  const t0 = Date.now();
  let done = 0, works = 0;
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      if (aborted) return;
      const k = cursor++;
      if (k >= todo.length) return;
      const i = todo[k];
      await pace();
      const results = await fetchByDois(batches[i]);
      if (results == null) continue;               // error/abort: page stays absent, re-runnable
      writeFileSync(pagePath(i), JSON.stringify({ batch: i, dois: batches[i], results }));
      works += results.length;
      if (++done % 100 === 0 || done === todo.length) {
        const el = (Date.now() - t0) / 1000;
        const rate = done / Math.max(el, 0.001);
        console.log(`    ${n(done)}/${n(todo.length)} pages · ${n(works)} works · ${rate.toFixed(1)} req/s · ${n(usage.credits)} credits · eta ${((todo.length - done) / Math.max(rate, 0.01) / 60).toFixed(1)}m`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONC, todo.length) }, worker));

  console.log(`P2  ${n(done)} pages fetched in ${((Date.now() - t0) / 60000).toFixed(1)}m · ${n(works)} works`);
  reportUsage();
  if (aborted) console.log(`  ! aborted: ${aborted}`);
}

/**
 * Free singleton sweep over DOIs the filter lane never resolved. 0 credits.
 *
 * This is not belt-and-braces: OpenAlex's DOI *filter* index lags its entity
 * store, so a work can be retrievable at /works/doi:X while absent from
 * ?filter=doi:X. Measured in 44b on 2,000 rows: filter 98.0%, singleton 99.6%.
 * Reads data/openalex/unmatched-dois.json (written by --write) and lands in
 * sweep.json, which --write folds in on the next pass.
 */
async function phaseSweep() {
  const p = `${PAGES}/unmatched-dois.json`;
  if (!existsSync(p)) { console.log("no unmatched-dois.json — run --write first"); return; }
  const missing = JSON.parse(readFileSync(p, "utf8"));
  const found = await sweepMisses(missing);
  writeFileSync(`${PAGES}/sweep.json`, JSON.stringify({ results: [...found.values()] }));
  reportUsage();
}

async function sweepMisses(missing) {
  if (!missing.length) return new Map();
  console.log(`    free singleton sweep over ${n(missing.length)} unmatched DOIs (0 credits)`);
  const found = new Map();
  let cursor = 0, done = 0;
  const t0 = Date.now();
  const worker = async () => {
    for (;;) {
      if (aborted) return;
      const i = cursor++;
      if (i >= missing.length) return;
      await pace();
      const w = await fetchOneByDoi(missing[i]);
      if (w) found.set(missing[i], w);
      if (++done % 500 === 0) console.log(`      ${n(done)}/${n(missing.length)} · ${n(found.size)} recovered · ${(done / ((Date.now() - t0) / 1000)).toFixed(1)} req/s`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONC, missing.length) }, worker));
  console.log(`    sweep recovered ${n(found.size)}/${n(missing.length)}`);
  return found;
}

// ── P3: write back ───────────────────────────────────────────────────────────
async function phaseWrite() {
  const rows = await exportRows();
  const plan = planBatches(rows);

  // one payload per DOI, from whatever pages are on disk
  const t0 = Date.now();
  const byDoi = new Map();
  const files = readdirSync(PAGES).filter((f) => /^page-\d+\.json$/.test(f) || f === "sweep.json").sort();
  for (const f of files) {
    let page;
    try { page = JSON.parse(readFileSync(`${PAGES}/${f}`, "utf8")); } catch { console.log(`  ! unreadable ${f}, skipping`); continue; }
    for (const w of page.results ?? []) {
      const d = normDoi(w.doi);
      if (d && !byDoi.has(d)) byDoi.set(d, w);
    }
  }
  console.log(`P3  ${n(files.length)} pages → ${n(byDoi.size)} distinct works (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const matched = [];
  const missing = [];
  for (const [doi, keys] of plan.byDoi) {
    const w = byDoi.get(doi);
    if (!w) { missing.push(doi); continue; }
    const p = distill(w);
    for (const k of keys) matched.push([k, p]);
  }
  console.log(`    ${n(matched.length)} rows matched · ${n(missing.length)} DOIs unmatched (${pct(plan.byDoi.size - missing.length, plan.byDoi.size)} of DOIs resolved)`);

  const chunks = [];
  for (let i = 0; i < matched.length; i += WRITE_CHUNK) chunks.push(matched.slice(i, i + WRITE_CHUNK));
  let written = 0;
  for (const [ci, chunk] of chunks.entries()) {
    const csv = chunk.map(([k, p]) => csvRow([
      k, p.openalex_id, p.oa_status,
      p.oa_locations ? JSON.stringify(p.oa_locations) : null,
      p.openalex_topics ? JSON.stringify(p.openalex_topics) : null,
      p.openalex_cited_by, p.pdf_url, p.arxiv_id,
    ])).join("\n");

    const sql = `BEGIN;
CREATE TEMP TABLE stage_oa (
  key_number text, openalex_id text, oa_status text, oa_locations jsonb,
  openalex_topics jsonb, openalex_cited_by int, pdf_url text, arxiv_id text
) ON COMMIT DROP;
COPY stage_oa FROM STDIN WITH (FORMAT csv);
${csv}
\\.
WITH upd AS (
  UPDATE nsr SET
    openalex_id       = s.openalex_id,
    oa_status         = s.oa_status,
    oa_locations      = s.oa_locations,
    openalex_topics   = s.openalex_topics,
    openalex_cited_by = s.openalex_cited_by,
    -- SHARED columns: never clobber another lane's write
    pdf_url           = coalesce(nsr.pdf_url, s.pdf_url),
    arxiv_id          = coalesce(nsr.arxiv_id, s.arxiv_id)
  FROM stage_oa s
  WHERE nsr.key_number = s.key_number
  RETURNING 1
) SELECT 'updated: ' || count(*) FROM upd;
COMMIT;`;

    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        const out = await psql(sql);
        written += chunk.length;
        console.log(`    chunk ${ci + 1}/${chunks.length} — ${out.trim()}`);
        ok = true;
      } catch (e) {
        console.log(`    chunk ${ci + 1} attempt ${attempt} failed: ${e.message.slice(0, 300)}`);
        if (attempt === 3) throw e;
        await sleep(2000 * attempt);
      }
    }
  }
  console.log(`P3  staged+updated ${n(written)} rows in ${((Date.now() - t0) / 60000).toFixed(1)}m`);
  if (missing.length) writeFileSync(`${PAGES}/unmatched-dois.json`, JSON.stringify(missing));
}

// ── P4: verify ───────────────────────────────────────────────────────────────
async function phaseVerify() {
  const out = await psql(`SELECT count(openalex_id) AS oa_matched, count(oa_status) FILTER (WHERE oa_status <> 'closed') AS any_oa,
       count(pdf_url) AS pdf_urls, count(arxiv_id) AS arxiv_ids, count(openalex_topics) AS topics
FROM nsr;
SELECT oa_status, count(*) FROM nsr WHERE oa_status IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;
SELECT count(*) AS rows_with_doi, count(openalex_id) AS matched FROM nsr WHERE doi IS NOT NULL;`);
  console.log(out.trim());
}

// ── P5: DOI-recovery sample ──────────────────────────────────────────────────
const BUCKETS = [
  { name: "pre-1960", lo: 0, hi: 1959 },
  { name: "1960-79", lo: 1960, hi: 1979 },
  { name: "1980-99", lo: 1980, hi: 1999 },
  { name: "2000+", lo: 2000, hi: 2100 },
];

const normTitle = (s) => String(s ?? "").toLowerCase().replace(/\u0000/g, "").replace(/[^a-z0-9]+/g, " ").trim();

// token-level Jaccard — robust to the punctuation/markup drift between NSR
// titles and OpenAlex display names
function titleSim(a, b) {
  const A = new Set(normTitle(a).split(" ").filter(Boolean));
  const B = new Set(normTitle(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

async function phaseRecover() {
  const per = Math.max(1, Math.floor(SAMPLE / BUCKETS.length));
  // \copy is a psql meta-command: the whole query must stay on ONE line.
  const sel = BUCKETS.map((b) =>
    `(SELECT key_number, pub_year, title FROM nsr WHERE doi IS NULL AND title IS NOT NULL AND pub_year BETWEEN ${b.lo} AND ${b.hi} ORDER BY random() LIMIT ${per})`
  ).join(" UNION ALL ");
  const out = await psql(`\\copy (${sel}) TO STDOUT WITH (FORMAT text)`);
  const rows = out.split("\n").filter(Boolean).map((l) => {
    const [key_number, year, ...rest] = l.split("\t");
    return { key_number, year: Number(year), title: rest.join("\t") };
  }).filter((r) => r.title && r.title !== "\\N");

  console.log(`P5  ${n(rows.length)} sampled rows · search costs 10 credits/request → ~${n(rows.length * 10)} credits (${money(rows.length * 10)})`);
  const tally = new Map(BUCKETS.map((b) => [b.name, { n: 0, hits: 0, near: 0, examples: [] }]));
  const bucketOf = (y) => BUCKETS.find((b) => y >= b.lo && y <= b.hi)?.name ?? "2000+";

  let cursor = 0, done = 0;
  const t0 = Date.now();
  const worker = async () => {
    for (;;) {
      if (aborted) return;
      const i = cursor++;
      if (i >= rows.length) return;
      const r = rows[i];
      await pace();
      const q = `/works?search=${encodeURIComponent(r.title.slice(0, 300))}&filter=publication_year:${r.year}&per-page=1&select=id,doi,display_name,publication_year`;
      const res = await oa(q, { redact: `/works?search=[title]&filter=publication_year:${r.year}` });
      const top = res?.data?.results?.[0];
      const t = tally.get(bucketOf(r.year));
      t.n++;
      if (top) {
        const sim = titleSim(r.title, top.display_name);
        const yearOk = Math.abs((top.publication_year ?? -999) - r.year) <= 1;
        if (sim >= 0.9 && yearOk && top.doi) { t.hits++; if (t.examples.length < 2) t.examples.push(`${r.title.slice(0, 60)} → ${normDoi(top.doi)}`); }
        else if (sim >= 0.7 && yearOk) t.near++;
      }
      if (++done % 25 === 0) console.log(`    ${n(done)}/${n(rows.length)} · ${n(usage.credits)} credits · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONC, rows.length) }, worker));

  console.log("\n  decade      n    hit    hit-rate   near-miss");
  for (const b of BUCKETS) {
    const t = tally.get(b.name);
    console.log(`  ${b.name.padEnd(10)} ${String(t.n).padStart(3)}  ${String(t.hits).padStart(4)}   ${pct(t.hits, t.n).padStart(7)}   ${String(t.near).padStart(4)}`);
  }
  const all = [...tally.values()].reduce((a, t) => ({ n: a.n + t.n, hits: a.hits + t.hits, near: a.near + t.near }), { n: 0, hits: 0, near: 0 });
  console.log(`  ${"ALL".padEnd(10)} ${String(all.n).padStart(3)}  ${String(all.hits).padStart(4)}   ${pct(all.hits, all.n).padStart(7)}   ${String(all.near).padStart(4)}`);
  for (const b of BUCKETS) for (const ex of tally.get(b.name).examples) console.log(`    e.g. [${b.name}] ${ex}`);
  reportUsage();
}

// ── probe / budget ───────────────────────────────────────────────────────────
async function phaseProbe() {
  const i = args.indexOf("--dois");
  let dois;
  if (i >= 0 && args[i + 1]) {
    dois = args[i + 1].split(",").map(normDoi).filter(Boolean);
  } else {
    const out = await psql(`\\copy (SELECT doi FROM nsr WHERE doi IS NOT NULL AND pub_year > 2015 ORDER BY key_number DESC LIMIT 3) TO STDOUT WITH (FORMAT text)`);
    dois = out.split("\n").filter(Boolean).map(normDoi).filter(Boolean);
  }
  console.log(`probe DOIs: ${dois.join(", ")}`);
  const results = await fetchByDois(dois);
  if (!results) { console.log("probe FAILED — no results"); reportUsage(); return; }
  console.log(`probe returned ${results.length} works`);
  for (const w of results) {
    console.log(`\n  ${normDoi(w.doi)}`);
    console.log(`  top-level keys: ${Object.keys(w).join(", ")}`);
    console.log(`  distilled: ${JSON.stringify(distill(w), null, 2).slice(0, 900)}`);
  }
  reportUsage();
}

async function phaseBudget() {
  // a free singleton: 0 credits, and its 2xx headers are the only honest reading
  await fetchOneByDoi("10.1103/physrevc.74.034003");
  reportUsage();
}

function reportUsage() {
  console.log(`  usage: ${n(usage.calls)} calls · ${n(usage.credits)} credits spent (${money(usage.credits)}) · ${n(usage.free)} free · remaining ${usage.remaining == null ? "?" : n(usage.remaining)}/${usage.limit == null ? "?" : n(usage.limit)}` +
    ` · ${n(usage.throttles)} throttles · ${n(usage.retries)} retries · ${n(usage.errors)} errors · ${n(usage.notFound)} 404s` +
    (usage.resetSeconds != null ? ` · resets in ${(usage.resetSeconds / 3600).toFixed(1)}h` : ""));
}

// ── main ─────────────────────────────────────────────────────────────────────
if (!KEY) console.log("! OPENALEX_API_KEY not set — running unauthenticated");
if (has("--budget")) await phaseBudget();
else if (has("--probe")) await phaseProbe();
else if (has("--fetch")) await phaseFetch();
else if (has("--write")) await phaseWrite();
else if (has("--sweep")) await phaseSweep();
else if (has("--verify")) await phaseVerify();
else if (has("--recover")) await phaseRecover();
else console.log("pick a phase: --budget | --probe | --fetch | --write | --verify | --recover");
