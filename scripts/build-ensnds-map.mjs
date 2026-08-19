// Verify NNDC's /ensnds static PDF tree against our CapGam index and write the
// mapping public/data/ensnds-map.json: "<PRODUCT_NUCID>|<DSID>" → PDF URL.
// Discovery (Brendan, 2026-08-18): nndc.bnl.gov/ensnds/{A}/{Symbol}/{slug}.pdf
// serves the ORIGINAL typeset ENSDF dataset PDFs for CapGam's capture-gamma
// datasets, outside the servlets. Coverage is CapGam's set only (probed: decay
// and adopted-levels slugs 404) — so enumerate from our capgam index, never
// blind-crawl. Run: node scripts/build-ensnds-map.mjs
import { readFileSync, writeFileSync } from "node:fs";

const index = JSON.parse(readFileSync("public/data/capgam/index.json", "utf8"));

/** "139LA(N,G) E=TH: TWO G CASCADE" → "ng_E_th_two_g_cascade" (empirical NNDC rule).
 *  Returns candidate slugs, most likely first — the prober keeps the first that 200s. */
function slugs(dsid) {
  let s = dsid.replace(/^\d+[A-Z]+/, "");        // drop the target token
  s = s.replace(/\(N,G\)/i, "ng");
  s = s.replace(/\s*E=/, " E=");
  const variants = new Set();
  for (const apos of ["", "_", "s"]) {           // G'S → g_s / gs / g's?
    for (const paren of [" ", ""]) {
      let v = s.replace(/'/g, apos === "s" ? "'" : apos)
        .replace(/[:,]/g, " ")
        .replace(/[()]/g, paren)
        .trim().replace(/\s+/g, "_")
        .toLowerCase().replace(/_?e=/, "_E_");
      v = v.replace(/^_+/, "").replace(/_+/g, "_");
      variants.add(v);
    }
  }
  return [...variants];
}

const head = async (url) => {
  try {
    const r = await fetch(url, { method: "HEAD" });
    return r.status === 200;
  } catch {
    return false;
  }
};

const map = {};
let hits = 0, misses = [];
for (const d of index.datasets) {
  const el = d.product.symbol[0].toUpperCase() + d.product.symbol.slice(1).toLowerCase();
  let found = null;
  for (const sl of slugs(d.dsid)) {
    const url = `https://www.nndc.bnl.gov/ensnds/${d.product.a}/${el}/${encodeURI(sl)}.pdf`;
    if (await head(url)) { found = url; break; }
    await new Promise((r) => setTimeout(r, 100));  // be polite
  }
  if (found) { map[`${d.product.a}${d.product.symbol.toUpperCase()}|${d.dsid}`] = found; hits++; }
  else misses.push(d.dsid);
  process.stdout.write(`\r${hits} hits / ${misses.length} misses`);
}
console.log();
writeFileSync(
  "public/data/ensnds-map.json",
  JSON.stringify({ source: "https://www.nndc.bnl.gov/ensnds/", verified: hits, of: index.datasets.length, map }, null, 1),
);
if (misses.length) console.log("misses:\n" + misses.join("\n"));
