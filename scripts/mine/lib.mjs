// scripts/mine/lib.mjs — shared plumbing for the supervision-mining lane.
//
// Owned by LANE-MINE. Read-only against the DB; every write goes to data/mine/
// as jsonl. No DDL, no DB writes, no HF pushes from anything in this directory.
//
// The house rules this file encodes:
//   · DB fence — the endpoint host must be ep-orange-water-aut2eymf or we refuse
//     to open a connection at all. /Code/nsr must never be reachable from here.
//   · Every external call is paced by a token bucket and identified by a UA that
//     names the project and a contact address. Politeness is not optional.
//   · Every harvester is resumable: output jsonl is append-only and keyed, and a
//     restart reads back the keys already on disk instead of re-spending.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";

export const UA =
  "cshl-rxivgpt-mine/0.1 (+https://cshl.nysgpt.com; brendan@nysgpt.com)";

export const MAILTO = process.env.OPENALEX_MAILTO || "brendan@nysgpt.com";

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
export const has = (f) => argv.includes(f);
export function numArg(flag, dflt) {
  const i = argv.indexOf(flag);
  if (i < 0) return dflt;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : dflt;
}
export function strArg(flag, dflt) {
  const i = argv.indexOf(flag);
  return i < 0 ? dflt : (argv[i + 1] ?? dflt);
}

// ── logging ──────────────────────────────────────────────────────────────────
const T0 = Date.now();
export const elapsed = () => (Date.now() - T0) / 1000;
export function log(...a) {
  const t = elapsed().toFixed(0).padStart(5);
  console.log(`[${t}s]`, ...a);
}

// ── DB fence + read-only psql ────────────────────────────────────────────────
const EXPECT_HOST = "ep-orange-water-aut2eymf";

function pgEnv() {
  const raw = process.env.DATABASE_URL_UNPOOLED;
  if (!raw) throw new Error("DATABASE_URL_UNPOOLED not set (run with --env-file=.env.local)");
  const url = new URL(raw);
  if (!url.hostname.startsWith(EXPECT_HOST + ".")) {
    throw new Error(`FENCE FAIL: endpoint is '${url.hostname}', expected '${EXPECT_HOST}.*' — refusing.`);
  }
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: url.pathname.slice(1),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: "require",
  };
}

// Read-only by construction: the session is opened with default_transaction_read_only
// so a stray INSERT in this lane fails loudly instead of writing.
export function psql(sql) {
  const env = pgEnv();
  const wrapped = `SET default_transaction_read_only = on;\n${sql}`;
  return new Promise((resolve, reject) => {
    const child = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-F", "\t"], { env });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error(`psql exit ${c}: ${err.slice(0, 1500)}`))));
    child.stdin.end(wrapped);
  });
}

export async function psqlRows(sql) {
  const out = await psql(sql);
  return out.split("\n").filter(Boolean).map((l) => l.split("\t"));
}

export async function rowCounts() {
  const [r] = await psqlRows(
    `SELECT (SELECT count(*) FROM preprints),
            (SELECT count(*) FROM preprints WHERE published_doi IS NOT NULL),
            (SELECT count(*) FROM preprint_versions);`
  );
  return { preprints: +r[0], published: +r[1], versions: +r[2] };
}

// ── pacing ───────────────────────────────────────────────────────────────────
// Token bucket: `rps` sustained, `conc` in flight. Both ceilings, never targets.
export class Pacer {
  constructor(rps, conc) {
    this.interval = 1000 / rps;
    this.conc = conc;
    this.next = Date.now();
    this.inFlight = 0;
    this.queue = [];
  }
  setRps(rps) { this.interval = 1000 / rps; }
  async slot() {
    while (this.inFlight >= this.conc) await new Promise((r) => this.queue.push(r));
    this.inFlight++;
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.interval;
    if (at > now) await sleep(at - now);
  }
  release() {
    this.inFlight--;
    const r = this.queue.shift();
    if (r) r();
  }
  // Back off the sustained pace after a 429; recovers only on restart.
  penalise(factor = 1.5) { this.interval *= factor; }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fetch with retry ─────────────────────────────────────────────────────────
// Retries 429/5xx/network with exponential backoff + jitter, honouring
// Retry-After. Returns { ok, status, json, text, headers, attempts }.
export async function fetchRetry(url, { pacer, method = "GET", body, headers = {}, tries = 5, timeoutMs = 90_000, json = true } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (pacer) await pacer.slot();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        body,
        signal: ac.signal,
        headers: { "User-Agent": UA, ...headers },
      });
      const status = res.status;
      if (status === 429 || status >= 500) {
        const ra = Number(res.headers.get("retry-after"));
        res.body?.cancel?.();
        if (status === 429 && pacer) pacer.penalise();
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 400;
        lastErr = new Error(`HTTP ${status}`);
        if (attempt < tries) { await sleep(wait); continue; }
        return { ok: false, status, json: null, text: "", headers: res.headers, attempts: attempt };
      }
      const text = await res.text();
      let parsed = null;
      if (json && text) { try { parsed = JSON.parse(text); } catch { /* caller inspects text */ } }
      return { ok: res.ok, status, json: parsed, text, headers: res.headers, attempts: attempt };
    } catch (e) {
      lastErr = e;
      if (attempt < tries) { await sleep(Math.min(20_000, 600 * 2 ** attempt) + Math.random() * 400); continue; }
      return { ok: false, status: 0, json: null, text: String(e), headers: new Headers(), attempts: attempt, error: e };
    } finally {
      clearTimeout(timer);
      if (pacer) pacer.release();
    }
  }
  throw lastErr;
}

// ── jsonl out ────────────────────────────────────────────────────────────────
// append:true (the default) is what makes the harvesters resumable. Derived
// files — anything fully regenerated from an input — pass append:false so a
// rerun replaces rather than doubles.
export function jsonlWriter(path, { append = true } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const stream = createWriteStream(path, { flags: append ? "a" : "w" });
  let pending = null;
  let lines = 0, bytes = 0;
  return {
    path,
    get lines() { return lines; },
    get bytes() { return bytes; },
    write(obj) {
      const s = JSON.stringify(obj) + "\n";
      lines++; bytes += Buffer.byteLength(s);
      if (!stream.write(s)) pending = new Promise((r) => stream.once("drain", r));
      return pending ?? Promise.resolve();
    },
    async drain() { if (pending) { await pending; pending = null; } },
    close() { return new Promise((r) => stream.end(r)); },
  };
}

// Read back the `field` of every record already on disk — the resume set.
export async function existingKeys(path, field = "key") {
  const seen = new Set();
  if (!existsSync(path)) return seen;
  const fh = await open(path, "r");
  try {
    let tail = "";
    for await (const chunk of fh.createReadStream({ encoding: "utf8", highWaterMark: 1 << 22 })) {
      const parts = (tail + chunk).split("\n");
      tail = parts.pop();
      for (const line of parts) {
        if (!line) continue;
        try { const o = JSON.parse(line); if (o[field] != null) seen.add(String(o[field])); } catch { /* torn line */ }
      }
    }
    if (tail) { try { const o = JSON.parse(tail); if (o[field] != null) seen.add(String(o[field])); } catch { /* torn tail */ } }
  } finally { await fh.close(); }
  return seen;
}

// Stream a jsonl file record-by-record without holding it in memory.
export async function* readJsonl(path) {
  if (!existsSync(path)) return;
  const fh = await open(path, "r");
  try {
    let tail = "";
    for await (const chunk of fh.createReadStream({ encoding: "utf8", highWaterMark: 1 << 22 })) {
      const parts = (tail + chunk).split("\n");
      tail = parts.pop();
      for (const line of parts) { if (line) { try { yield JSON.parse(line); } catch { /* torn */ } } }
    }
    if (tail) { try { yield JSON.parse(tail); } catch { /* torn */ } }
  } finally { await fh.close(); }
}

export const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

export const bytesOf = (p) => (existsSync(p) ? statSync(p).size : 0);
export const human = (n) => (n > 1e9 ? (n / 1e9).toFixed(2) + " GB" : n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : (n / 1e3).toFixed(0) + " KB");

// ── deterministic split (NSR's rule: split by paper hash, never by row) ───────
// Byte-identical to the house function in scripts/eval/build-nsr-eval.mjs and
// scripts/train/build-nsr-triplets.mjs: md5 of a seeded key, first 8 hex digits,
// scaled to [0,1). Frozen across runs, machines, and lanes — which is the whole
// point: the rig lane must be able to recompute any split without asking us.
export const h32 = (s) => parseInt(createHash("md5").update(s).digest("hex").slice(0, 8), 16) / 0xffffffff;

// The frozen benchmark reservation. A paper under the holdout line never appears
// as a training anchor, positive, or negative — it exists only in cshl-eval-v1.
export const HOLDOUT_SEED = "holdout:";
export const SPLIT_SEED = "cshl-training-pairs-2026-08-19";

export const DOI_SUFFIX = (doi) => String(doi || "").replace(/^https?:\/\/doi\.org\//i, "").replace(/^10\.\d{4,9}\//, "");
export const bareDoi = (doi) => String(doi || "").replace(/^https?:\/\/doi\.org\//i, "").toLowerCase();
export const bareW = (id) => String(id || "").replace("https://openalex.org/", "");

export function readJson(path, dflt = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return dflt; }
}
