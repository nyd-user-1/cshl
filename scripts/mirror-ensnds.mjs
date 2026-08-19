// Mirror NNDC's /ensnds typeset capture-dataset PDFs (the 271 verified by
// build-ensnds-map.mjs) to data/ensnds/ locally, then sync to
// s3://nsr-pdfs/ensnds/ — our permanent copy; the UI keeps linking NNDC's
// canonical URLs, S3 is the insurance. Run: node scripts/mirror-ensnds.mjs
import { readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

const { map } = JSON.parse(readFileSync("public/data/ensnds-map.json", "utf8"));
const urls = Object.values(map);
let done = 0, bytes = 0, skipped = 0, failed = [];
for (const url of urls) {
  const rel = url.replace("https://www.nndc.bnl.gov/ensnds/", "");
  const out = join("data/ensnds", decodeURI(rel));
  if (existsSync(out) && statSync(out).size > 0) { skipped++; continue; }
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, buf);
    bytes += buf.length;
    done++;
  } catch (e) {
    failed.push(`${url} — ${e.message}`);
  }
  await new Promise((res) => setTimeout(res, 150)); // be polite
  process.stdout.write(`\r${done} fetched · ${skipped} cached · ${failed.length} failed · ${(bytes / 1e6).toFixed(1)} MB`);
}
console.log();
if (failed.length) console.log("FAILED:\n" + failed.join("\n"));
console.log("syncing to S3…");
execSync("aws s3 sync data/ensnds s3://nsr-pdfs/ensnds/ --region us-east-1", { stdio: "inherit" });
console.log("done");
