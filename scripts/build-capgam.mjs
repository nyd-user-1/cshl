#!/usr/bin/env node
/**
 * Ingest CapGam — thermal-neutron-capture γ-rays — into public/data/capgam/.
 *
 * Source: https://www.nndc.bnl.gov/capgam/ — the page's own JSON API,
 *   api/periodic-table/dsids-by-z     (dataset ids, keyed by target Z)
 *   api/json/?dsid=…                  (one dataset: target, σ(n,γ), γ records)
 *
 * Datasets are kept verbatim, one file per target dataset under ds/, plus an
 * index.json the picker searches. ~290 datasets, fetched politely in series.
 *
 * Usage: node scripts/build-capgam.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const BASE = "https://www.nndc.bnl.gov/capgam";
const OUT_DIR = path.join(process.cwd(), "public/data/capgam");
const CACHE_DIR = path.join(process.cwd(), "data/capgam");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

const byZ = await fetchJson(`${BASE}/api/periodic-table/dsids-by-z`);
const dsids = Object.values(byZ).flat();
console.log(`${dsids.length} datasets across ${Object.keys(byZ).length} elements`);

mkdirSync(path.join(OUT_DIR, "ds"), { recursive: true });
mkdirSync(CACHE_DIR, { recursive: true });

const index = [];
let fetched = 0;

for (const dsid of dsids) {
  // Their fileName is already a filesystem-safe slug (e.g. 2H_1H-N-G-E-THERMAL);
  // cache under a sanitized dsid until we know it.
  const cacheName = dsid.replace(/[^A-Za-z0-9]+/g, "_") + ".json";
  const cache = path.join(CACHE_DIR, cacheName);
  let ds;
  if (existsSync(cache)) {
    ds = JSON.parse(readFileSync(cache, "utf8"));
  } else {
    ds = await fetchJson(`${BASE}/api/json/?dsid=${encodeURIComponent(dsid)}`);
    writeFileSync(cache, JSON.stringify(ds));
    fetched++;
    await sleep(150); // be polite — this is their production API
  }

  /* ---- self-check: shape, not physics ------------------------------------ */
  if (!ds.fileName || !ds.target || !Array.isArray(ds.gammaRecords))
    throw new Error(`${dsid}: unexpected shape ${JSON.stringify(Object.keys(ds))}`);

  writeFileSync(path.join(OUT_DIR, "ds", `${ds.fileName}.json`), JSON.stringify(ds));
  index.push({
    dsid: ds.dsid,
    file: ds.fileName,
    target: ds.target,
    product: ds.product,
    nGammas: ds.gammaRecords.length,
    crossSection: ds.crossSection ?? null,
    modificationDate: ds.modificationDate ?? null,
  });
}

index.sort((a, b) => a.target.z - b.target.z || a.target.a - b.target.a);
writeFileSync(path.join(OUT_DIR, "index.json"), JSON.stringify({
  source: "NNDC CapGam — thermal-neutron-capture γ-rays",
  url: `${BASE}/`,
  fetched: new Date().toISOString().slice(0, 10),
  datasets: index,
}));

const gammas = index.reduce((s, d) => s + d.nGammas, 0);
console.log(
  `wrote ${index.length} datasets (${fetched} newly fetched) — ${gammas} γ records — to ${OUT_DIR}`,
);
