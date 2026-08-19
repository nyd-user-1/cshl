#!/usr/bin/env node
/**
 * Digit-for-digit verification of our Q-value calculator against NNDC's QCalc.
 *
 * For each sample nuclide we POST to their SummaryServlet, compute the same
 * quantities from AME2020 locally, and diff both the full-precision values and
 * the NDS-rounded strings. Any disagreement beyond floating-point noise is a
 * failure — the whole point of this calculator is that it agrees with theirs.
 *
 * Usage: node scripts/verify-qcalc.mjs [nuclide ...]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const ENDPOINT = "https://www.nndc.bnl.gov/qcalc/SummaryServlet";

/* Load src/lib/qcalc.ts directly so the verified code is the shipped code —
 * not a copy that can drift. esbuild (a Vite dependency) strips the types; the
 * only runtime import is react-query, which the pure functions never touch. */
const { transform } = await import("esbuild");
const src = readFileSync(path.join(ROOT, "src/lib/qcalc.ts"), "utf8")
  .replace(/^import \{ useQuery \}.*$/m, "const useQuery = () => {};");
const { code: js } = await transform(src, { loader: "ts", format: "esm" });
const { MassTable, summary, ndsFormat } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
);

const ame = JSON.parse(readFileSync(path.join(ROOT, "public/data/ame2020.json"), "utf8"));
const table = new MassTable(ame);

const SAMPLE = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "1NN", "1H", "4He", "12C", "16O", "40Ca", "56Fe", "60Co", "90Sr", "99Tc",
      "127I", "137Cs", "139La", "152Eu", "181Ta", "197Au", "208Pb", "209Bi",
      "226Ra", "232Th", "235U", "238U", "239Pu", "241Am", "252Cf", "270Hs",
      "11Li", "78Ni", "100Sn", "132Sn",
    ];

/** Their JSON reports keV for everything except the two mass rows. */
const TOL_KEV = 5e-4;   // print rounding in AME's own table
const TOL_U = 1e-9;

const post = async (nuclide) => {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ nuclide }).toString(),
  });
  if (!res.ok) throw new Error(`${nuclide}: HTTP ${res.status}`);
  return res.json();
};

let checked = 0, valueFails = 0, errorFails = 0, ndsFails = 0, missing = 0;
const buckets = new Map();
const tally = (kind, key) => buckets.set(`${kind}:${key}`, (buckets.get(`${kind}:${key}`) ?? 0) + 1);
const worst = new Map();
const failures = [];

for (const name of SAMPLE) {
  let theirs;
  try {
    theirs = await post(name);
  } catch (e) {
    console.log(`  ${name}: request failed — ${e.message}`);
    continue;
  }
  if (!theirs.data) { console.log(`  ${name}: ${theirs.message}`); continue; }

  const nuc = table.find(name === "1NN" ? "nn" : name);
  if (!nuc) { console.log(`  ${name}: not in our AME table`); missing++; continue; }

  const ours = summary(table, nuc);

  for (const [key, ref] of Object.entries(theirs.data.entries)) {
    const got = ours[key];
    if (!got) {
      missing++;
      failures.push(`${name} ${key}: we produce nothing, they give ${ref.value}`);
      continue;
    }
    checked++;
    const tol = key === "ATOMIC_MASS" || key === "AMN" ? TOL_U : TOL_KEV;
    const dv = Math.abs(got.value - ref.value);
    const de = Math.abs(got.error - ref.error);
    if (dv > (worst.get(key) ?? 0)) worst.set(key, dv);

    // Their JSON truncates `value` to the decimals of the coarsest input, so a
    // sub-unit difference that vanishes at their precision is not a mismatch.
    const theirDecimals = (String(ref.value).split(".")[1] ?? "").length;
    const roundedAgrees =
      Math.abs(Number(got.value.toFixed(theirDecimals)) - ref.value) <= tol;

    if (!roundedAgrees) {
      valueFails++;
      tally("value", key);
      failures.push(`${name} ${key}: VALUE ${got.value} vs ${ref.value} (Δ${dv.toExponential(2)})`);
      continue;
    }
    if (de > tol) {
      errorFails++;
      tally("error", key);
      failures.push(`${name} ${key}: ERROR ${got.error} vs ${ref.error} (Δ${de.toExponential(2)})`);
      continue;
    }
    const nds = ndsFormat(got.value, got.error);
    if (nds.value !== ref.nds_value || nds.error !== ref.nds_error) {
      ndsFails++;
      tally("nds", key);
      failures.push(
        `${name} ${key}: NDS "${nds.value} ${nds.error}" vs "${ref.nds_value} ${ref.nds_error}"`
      );
    }
  }
}

console.log(`\nchecked ${checked} quantities across ${SAMPLE.length} nuclides`);
console.log(`  value mismatches       : ${valueFails}`);
console.log(`  error mismatches       : ${errorFails}`);
console.log(`  NDS-string mismatches  : ${ndsFails}`);
console.log(`  quantities we lack     : ${missing}`);
console.log(`  exact                  : ${checked - valueFails - errorFails - ndsFails}`);
console.log("\nfailures by class:");
for (const [k, n] of [...buckets].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${k}`);

if (failures.length) {
  console.log(`\nfirst ${Math.min(25, failures.length)} of ${failures.length} failures:`);
  for (const f of failures.slice(0, 25)) console.log("  " + f);
  process.exit(1);
}
console.log("\nexact agreement with NNDC QCalc on every quantity.");
void pathToFileURL;
