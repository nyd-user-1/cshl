#!/usr/bin/env node
/**
 * walk-rxiv.mjs — the metadata walk for bioRxiv + medRxiv (LANE-RXIV-MAP.md §5).
 *
 *   node scripts/walk-rxiv.mjs details biorxiv
 *   node scripts/walk-rxiv.mjs details medrxiv
 *   node scripts/walk-rxiv.mjs pubs    biorxiv
 *
 * HOST RULING (Decision 3): every request goes to api.biorxiv.org, never
 * api.medrxiv.org. The med host paginates 100/page instead of 30 and would be ~3x
 * faster, but it OMITS the `funder` array from every record and 404s /pubs entirely.
 * One pass, one code path, funder included, for both servers.
 *
 * Walks MONTH BY MONTH rather than one giant interval: each month is an independent
 * cursor walk, so the job is resumable (completed months are journalled) and
 * parallelisable (N months in flight). Output is newline-delimited JSON.
 */
import fs from "node:fs";
import path from "node:path";

const UA = "cshl-rxivgpt/0.1 (+https://cshl.nysgpt.com; brendan@nysgpt.com)";
const HOST = "https://api.biorxiv.org";
const CONC = Number(process.env.CONC ?? 4);
const OUT_DIR = "data/rxiv";

const START = { biorxiv: "2013-11", medrxiv: "2019-06" };
const PAGE = { details: 30, pubs: 100 };

const mode = process.argv[2];
const server = process.argv[3];
if (!["details", "pubs"].includes(mode) || !["biorxiv", "medrxiv"].includes(server)) {
  console.error("usage: walk-rxiv.mjs <details|pubs> <biorxiv|medrxiv>");
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, `${mode}-${server}.ndjson`);
const donePath = path.join(OUT_DIR, `${mode}-${server}.done.json`);
const done = new Set(fs.existsSync(donePath) ? JSON.parse(fs.readFileSync(donePath, "utf8")) : []);
const out = fs.createWriteStream(outPath, { flags: "a" });

const months = [];
{
  const [sy, sm] = START[server].split("-").map(Number);
  const now = new Date();
  let y = sy, m = sm;
  while (y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m <= now.getUTCMonth() + 1)) {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    months.push({ key: `${y}-${String(m).padStart(2, "0")}`,
                  from: `${y}-${String(m).padStart(2, "0")}-01`,
                  to:   `${y}-${String(m).padStart(2, "0")}-${last}` });
    m++; if (m > 12) { m = 1; y++; }
  }
}
const todo = months.filter((x) => !done.has(x.key));
console.log(`[${mode}/${server}] ${months.length} months, ${done.size} already done, ${todo.length} to walk`);

let reqs = 0, rows = 0, monthsDone = done.size;
const t0 = Date.now();

async function getJSON(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(90_000) });
      reqs++;
      if (r.status === 429 || r.status >= 500) throw new Error(`http ${r.status}`);
      if (!r.ok) throw new Error(`http ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw new Error(`${url} :: ${e.message}`);
      await new Promise((s) => setTimeout(s, 1000 * 2 ** i));
    }
  }
}

async function walkMonth(mo) {
  const size = PAGE[mode];
  let cursor = 0, total = Infinity, got = 0;
  const lines = [];
  while (cursor < total) {
    const url = mode === "details"
      ? `${HOST}/details/${server}/${mo.from}/${mo.to}/${cursor}/json`
      : `${HOST}/pubs/${server}/${mo.from}/${mo.to}/${cursor}`;
    const j = await getJSON(url);
    const msg = Array.isArray(j.messages) ? j.messages[0] : j.messages;
    const coll = j.collection ?? [];
    if (!coll.length) break;
    if (total === Infinity) total = Number(msg?.total ?? coll.length);
    for (const rec of coll) lines.push(JSON.stringify(rec));
    got += coll.length;
    cursor += size;
    if (coll.length < size) break;
  }
  if (lines.length) out.write(lines.join("\n") + "\n");
  rows += got;
  done.add(mo.key);
  fs.writeFileSync(donePath, JSON.stringify([...done]));
  monthsDone++;
  const el = (Date.now() - t0) / 1000;
  const pct = (monthsDone / months.length) * 100;
  console.log(`[${mode}/${server}] ${mo.key} +${got} | ${monthsDone}/${months.length} (${pct.toFixed(1)}%) | rows=${rows} reqs=${reqs} | ${el.toFixed(0)}s | ${(reqs / el).toFixed(1)} req/s`);
}

const queue = [...todo];
await Promise.all(Array.from({ length: CONC }, async () => {
  while (queue.length) {
    const mo = queue.shift();
    try { await walkMonth(mo); }
    catch (e) { console.error(`[${mode}/${server}] FAILED ${mo.key}: ${e.message}`); }
  }
}));
out.end();
console.log(`[${mode}/${server}] DONE rows=${rows} reqs=${reqs} in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min -> ${outPath}`);
