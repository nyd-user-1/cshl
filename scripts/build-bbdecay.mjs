#!/usr/bin/env node
/**
 * Ingest NNDC's double-beta-decay compilation into public/data/bbdecay.json.
 *
 * Source: https://www.nndc.bnl.gov/bbdecay/ — the page's own data files,
 *   data/adopted-entries.json       (evaluated 2νββ half-lives, 2025 evaluation)
 *   data/experimental-entries.json  (measured limits and values, from NSR)
 *
 * These are the exact JSON documents their front-end renders, kept verbatim —
 * we add an envelope (source, url, fetched) and change nothing inside a record.
 *
 * Usage: node scripts/build-bbdecay.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const BASE = "https://www.nndc.bnl.gov/bbdecay";
const OUT = path.join(process.cwd(), "public/data/bbdecay.json");
const CACHE_DIR = path.join(process.cwd(), "data/bbdecay");

async function source(name) {
  const cache = path.join(CACHE_DIR, `${name}.json`);
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
  const url = `${BASE}/data/${name}.json`;
  process.stderr.write(`fetching ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const json = await res.json();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cache, JSON.stringify(json));
  return json;
}

const adopted = await source("adopted-entries");
const experimental = await source("experimental-entries");

/* ---- self-check: shape, not physics -------------------------------------- */
if (!Array.isArray(adopted) || adopted.length < 20)
  throw new Error(`adopted looks wrong: ${adopted.length} records`);
if (!Array.isArray(experimental) || experimental.length < 500)
  throw new Error(`experimental looks wrong: ${experimental.length} records`);
for (const r of [...adopted, ...experimental]) {
  const n = r.nuclide;
  if (!n || !Number.isFinite(n.z) || !Number.isFinite(n.a) || !n.symbol)
    throw new Error(`record without a nuclide: ${JSON.stringify(r).slice(0, 120)}`);
}

writeFileSync(OUT, JSON.stringify({
  source: "NNDC ββ-decay compilation (2025 evaluation; experimental entries from NSR)",
  url: `${BASE}/`,
  fetched: new Date().toISOString().slice(0, 10),
  adopted,
  experimental,
}));
console.log(
  `wrote ${OUT} — ${adopted.length} adopted + ${experimental.length} experimental records`,
);
