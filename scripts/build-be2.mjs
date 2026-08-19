#!/usr/bin/env node
/**
 * Ingest NNDC's B(E2; 0⁺ → 2⁺) compilation into public/data/be2/*.json.
 *
 * Source: https://www.nndc.bnl.gov/be2/ — the page's own data files,
 *   data/adopted-entries.json       (recommended values — Pritychenko, Birch,
 *                                    Singh, Horoi, ADNDT 107, 1 (2016))
 *   data/experimental-entries.json  (recent measurements, from NSR)
 *   data/predicted-entries.json     (global best fit — Pritychenko, Birch,
 *                                    Singh, Nucl. Phys. A 962, 73 (2017))
 *
 * Records are kept verbatim; each file gets an envelope and nothing more.
 * Three files rather than one so the dialog can lazy-load per tab — the
 * experimental set alone is ~2.5 MB.
 *
 * Usage: node scripts/build-be2.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const BASE = "https://www.nndc.bnl.gov/be2";
const OUT_DIR = path.join(process.cwd(), "public/data/be2");
const CACHE_DIR = path.join(process.cwd(), "data/be2");

const SETS = {
  adopted: { min: 500, cite: "Pritychenko, Birch, Singh, Horoi — ADNDT 107, 1 (2016)" },
  experimental: { min: 1000, cite: "Recent measurements, from the NSR database" },
  predicted: { min: 300, cite: "Pritychenko, Birch, Singh — Nucl. Phys. A 962, 73 (2017)" },
};

async function source(name) {
  const cache = path.join(CACHE_DIR, `${name}.json`);
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
  const url = `${BASE}/data/${name}-entries.json`;
  process.stderr.write(`fetching ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const json = await res.json();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cache, JSON.stringify(json));
  return json;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, { min, cite }] of Object.entries(SETS)) {
  const entries = await source(name);

  /* ---- self-check: shape, not physics ------------------------------------ */
  if (!Array.isArray(entries) || entries.length < min)
    throw new Error(`${name} looks wrong: ${entries.length} records (expected ≥ ${min})`);
  for (const r of entries) {
    const n = r.nuclide;
    if (!n || !Number.isFinite(n.z) || !Number.isFinite(n.a) || !n.symbol)
      throw new Error(`${name} record without a nuclide: ${JSON.stringify(r).slice(0, 120)}`);
  }

  const out = path.join(OUT_DIR, `${name}.json`);
  writeFileSync(out, JSON.stringify({
    source: `NNDC B(E2) compilation — ${cite}`,
    url: `${BASE}/`,
    fetched: new Date().toISOString().slice(0, 10),
    entries,
  }));
  console.log(`wrote ${out} — ${entries.length} records`);
}
