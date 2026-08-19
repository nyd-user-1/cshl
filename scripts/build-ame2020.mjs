#!/usr/bin/env node
/**
 * Ingest the AME2020 atomic mass evaluation into public/data/ame2020.json.
 *
 * Source: https://www-nds.iaea.org/amdc/ame2020/mass_1.mas20.txt
 * (Wang, Audi, Kondev, Huang, Naimi, Xu — Chinese Physics C 45, 030003 (2021))
 *
 * This is the same table NNDC's QCalc reads, so Q-values computed from it must
 * agree with theirs digit for digit. The file is FORTRAN fixed-width:
 *
 *   a1,i3,i5,i5,i5,1x,a3,a4,1x,f14.6,f12.6,f13.5,1x,f10.5,1x,a2,f13.5,f11.5,
 *   1x,i3,1x,f13.6,f12.6
 *   cc NZ  N  Z  A   el  o    mass excess  unc  BE/A  unc  B  beta-decay E unc
 *      A  atomic mass (micro-u)  unc
 *
 * A trailing '#' on a value marks it as extrapolated from systematics rather
 * than measured; we keep the number and flag it, exactly as AME does.
 *
 * Usage: node scripts/build-ame2020.mjs [path/to/mass_1.mas20.txt]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const BASE = "https://www-nds.iaea.org/amdc/ame2020";
const SRC_URL = `${BASE}/mass_1.mas20.txt`;
const OUT = path.join(process.cwd(), "public/data/ame2020.json");
const CACHE = path.join(process.cwd(), "data/mass_1.mas20.txt");

/**
 * AME also publishes the reaction and separation energies with uncertainties
 * propagated across the *correlated* mass adjustment. Those correlations are
 * not recoverable from the mass file — for 235U, AME's σ(S(n)) is 0.23 keV
 * against 1.59 keV from naive quadrature — and NNDC's QCalc serves these rows
 * verbatim. So we read them rather than re-derive them.
 *
 * Both files are  a1,i3,1x,a3,i4,6(f13.4,f11.4).
 */
const RCT = {
  "rct1.mas20": ["S2N", "S2P", "QA", "Q2BM", "QECP", "QBMN"],
  "rct2_1.mas20": ["SN", "SP", "Q4BM", "QDA", "QPA", "QNA"],
};

/** CODATA 2018 atomic mass unit in keV — the value AME2020 itself adjusts on. */
const U_KEV = 931494.10242;

const cut = (line, from, to) => line.slice(from - 1, to);

/** AME writes "1234.5#" for extrapolated values and "*" for none. */
function num(raw) {
  const s = raw.trim();
  if (!s || s === "*") return { v: null, est: false };
  const est = s.endsWith("#");
  const v = Number(est ? s.slice(0, -1) : s);
  return { v: Number.isFinite(v) ? v : null, est };
}

async function source(name = "mass_1.mas20") {
  const cache = path.join(process.cwd(), "data", `${name}.txt`);
  if (existsSync(cache)) return readFileSync(cache, "utf8");
  const url = `${BASE}/${name}.txt`;
  process.stderr.write(`fetching ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const text = await res.text();
  writeFileSync(cache, text);
  return text;
}

const text = await source();
const lines = text.split("\n");

const nuclides = [];
let skipped = 0;

for (const line of lines) {
  if (line.length < 100) continue;
  const A = Number(cut(line, 15, 19));
  const Z = Number(cut(line, 10, 14));
  const N = Number(cut(line, 5, 9));
  if (!Number.isFinite(A) || !Number.isFinite(Z) || !Number.isFinite(N)) continue;
  if (A === 0 || N + Z !== A) continue;

  const el = cut(line, 21, 23).trim();
  if (!el) continue;

  const dm = num(cut(line, 29, 42));   // mass excess, keV
  const du = num(cut(line, 43, 54));   // its uncertainty, keV
  if (dm.v === null) { skipped++; continue; }

  // Atomic mass is split: integer part (micro-u / 1e6) then the fraction, and
  // AME prints its own uncertainty rather than one derived from Δ.
  const amInt = Number(cut(line, 107, 109));
  const amFrac = num(cut(line, 111, 123));
  const amUnc = num(cut(line, 124, 135));
  const massU = amFrac.v === null ? null : amInt + amFrac.v / 1e6;
  const massUncU = amUnc.v === null ? null : amUnc.v / 1e6;

  // Binding energy per nucleon and Q(β⁻) are printed here with AME's own
  // correlated uncertainties — QCalc serves both straight from these columns.
  const be = num(cut(line, 55, 67));
  const beU = num(cut(line, 69, 78));
  const qbm = num(cut(line, 82, 94));
  const qbmU = num(cut(line, 95, 105));

  nuclides.push({
    z: Z, n: N, a: A, el,
    d: dm.v,                              // mass excess (keV)
    dd: du.v ?? 0,                        // uncertainty (keV)
    ...(dm.est || du.est ? { est: 1 } : {}),
    ...(massU !== null ? { m: massU, me: massUncU ?? 0 } : {}),
    ...(be.v !== null ? { be: be.v, bee: beU.v ?? 0, ...(be.est ? { bes: 1 } : {}) } : {}),
    ...(qbm.v !== null ? { qbm: qbm.v, qbme: qbmU.v ?? 0, ...(qbm.est ? { qbms: 1 } : {}) } : {}),
  });
}

/* ---- AME's reaction/separation energies ---------------------------------- */
const byZA = new Map(nuclides.map((x) => [x.z * 1000 + x.a, x]));
let rctRows = 0;

for (const [file, keys] of Object.entries(RCT)) {
  const rct = await source(file);
  for (const line of rct.split("\n")) {
    if (line.length < 40) continue;
    const A = Number(cut(line, 2, 4));
    const Z = Number(cut(line, 9, 12));
    if (!Number.isFinite(A) || !Number.isFinite(Z) || A === 0) continue;
    const target = byZA.get(Z * 1000 + A);
    if (!target) continue;
    keys.forEach((key, i) => {
      const at = 13 + 22 * i;                 // 12-wide value, 10-wide error
      const v = num(cut(line, at, at + 11));
      const e = num(cut(line, at + 12, at + 21));
      if (v.v === null) return;
      target.r ??= {};
      target.r[key] = [v.v, e.v ?? 0, v.est || e.est ? 1 : 0];
      rctRows++;
    });
  }
}
console.log(`read ${rctRows} reaction-energy entries from ${Object.keys(RCT).join(", ")}`);

/* ---- self-check -----------------------------------------------------------
 * Δ and the atomic mass are two independent printings of the same quantity, so
 * |Δ − (M−A)u| should be pure print-rounding: ~1e-3 keV for measured rows, and
 * up to ~1 keV where AME prints extrapolated values to whole units. This is a
 * column-alignment check — a misread field lands orders of magnitude out, not
 * fractions of a keV. Δ itself is authoritative; it is what AME adjusts.
 */
const diffs = nuclides
  .filter((x) => x.m !== undefined)
  .map((x) => ({ x, d: Math.abs((x.m - x.a) * U_KEV - x.d) }))
  .sort((a, b) => a.d - b.d);
const median = diffs[Math.floor(diffs.length / 2)].d;
const worst = diffs[diffs.length - 1];

console.log(`parsed ${nuclides.length} nuclides (skipped ${skipped} without a mass excess)`);
console.log(`Z ${Math.min(...nuclides.map((x) => x.z))}–${Math.max(...nuclides.map((x) => x.z))} · ` +
            `A ${Math.min(...nuclides.map((x) => x.a))}–${Math.max(...nuclides.map((x) => x.a))} · ` +
            `${nuclides.filter((x) => x.est).length} extrapolated`);
console.log(`alignment check on ${diffs.length} rows: median ${median.toExponential(2)} keV, ` +
            `max ${worst.d.toExponential(2)} keV (${worst.x.a}${worst.x.el}${worst.x.est ? "#" : ""})`);
if (median > 0.01 || worst.d > 5) throw new Error("column alignment is off — Δ and atomic mass disagree");

const out = nuclides;
writeFileSync(OUT, JSON.stringify({
  source: "AME2020 (Wang et al., Chin. Phys. C 45, 030003 (2021))",
  url: SRC_URL,
  u_keV: U_KEV,
  nuclides: out,
}));
console.log(`wrote ${OUT} — ${(JSON.stringify(out).length / 1024).toFixed(0)} KB of nuclide rows`);
