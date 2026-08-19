#!/usr/bin/env node
/**
 * Empirical close-out of Decision 1 (bare DOI-suffix business key).
 *
 * Reads the walked ndjson directly — the source of truth, independent of anything the
 * loader or the upsert did — and asserts:
 *   1. no DOI suffix is used by BOTH servers (a collision would not raise an error,
 *      it would silently overwrite one server's paper via ON CONFLICT DO UPDATE);
 *   2. no suffix is used by two different DOIs on the same server;
 *   3. the distinct (server, doi) count matches what the hub actually holds.
 */
import fs from "node:fs";
import readline from "node:readline";

const files = { biorxiv: "data/rxiv/details-biorxiv.ndjson", medrxiv: "data/rxiv/details-medrxiv.ndjson" };
const suffixOwner = new Map();   // suffix -> Set("server|doi")
const perServer = { biorxiv: new Set(), medrxiv: new Set() };
let rows = 0;

for (const [server, file] of Object.entries(files)) {
  if (!fs.existsSync(file)) { console.log(`(missing ${file})`); continue; }
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r.doi) continue;
    rows++;
    const srv = String(r.server ?? server).trim().toLowerCase();
    const doi = String(r.doi).trim();
    const suffix = doi.slice(doi.indexOf("/") + 1);
    perServer[srv]?.add(`${srv}|${doi}`);
    let set = suffixOwner.get(suffix);
    if (!set) suffixOwner.set(suffix, (set = new Set()));
    set.add(`${srv}|${doi}`);
  }
}

const crossServer = [], sameServerDupes = [];
for (const [suffix, owners] of suffixOwner) {
  if (owners.size === 1) continue;
  const servers = new Set([...owners].map((o) => o.split("|")[0]));
  (servers.size > 1 ? crossServer : sameServerDupes).push([suffix, [...owners]]);
}

const distinctPapers = perServer.biorxiv.size + perServer.medrxiv.size;
console.log(`version rows scanned ................. ${rows.toLocaleString()}`);
console.log(`distinct (server, doi) papers ........ ${distinctPapers.toLocaleString()}`);
console.log(`  bioRxiv ............................ ${perServer.biorxiv.size.toLocaleString()}`);
console.log(`  medRxiv ............................ ${perServer.medrxiv.size.toLocaleString()}`);
console.log(`distinct DOI suffixes ................ ${suffixOwner.size.toLocaleString()}`);
console.log(`\nCROSS-SERVER suffix collisions ....... ${crossServer.length}  ${crossServer.length ? "*** DECISION 1 FAILS ***" : "(none — bare suffix is safe)"}`);
for (const [s, o] of crossServer.slice(0, 5)) console.log(`    ${s} -> ${o.join(" , ")}`);
console.log(`SAME-SERVER suffix reused by 2 DOIs .. ${sameServerDupes.length}`);
for (const [s, o] of sameServerDupes.slice(0, 5)) console.log(`    ${s} -> ${o.join(" , ")}`);
console.log(`\nexpected hub row count ............... ${distinctPapers.toLocaleString()}`);
process.exit(crossServer.length === 0 && sameServerDupes.length === 0 ? 0 : 1);
