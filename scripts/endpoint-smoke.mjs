// Exercise every api/ endpoint against a deployment (LANE-MEDRXIV-ROOMS §5.3:
// tsc does not typecheck api/, so only a deploy catches those errors).
//
//   node scripts/endpoint-smoke.mjs <base-url> [bypass-header-value]
//
// Uses plain fetch; for a protected preview, run it through `vercel curl`
// instead. Prints status + latency per endpoint and exits non-zero if any
// endpoint 5xx's — a 4xx on a deliberately-bad request is a pass.
const base = process.argv[2];
if (!base) { console.error("usage: node scripts/endpoint-smoke.mjs <base-url>"); process.exit(1); }

const CASES = [
  ["dict categories (medrxiv rooms)", "/api/dict?type=categories&server=medrxiv"],
  ["dict categories (all)", "/api/dict?type=categories&limit=5"],
  ["dict journals", "/api/dict?type=journals&limit=5"],
  ["records (medrxiv page 1)", "/api/records?server=medrxiv&pageSize=3"],
  ["records (category filter)", "/api/records?server=medrxiv&category=neurology&pageSize=3"],
  ["record by key", "/api/record?key=2021.05.04.442622"],
  ["search hybrid (corpus)", "/api/search?q=stroke+rehabilitation&mode=hybrid&limit=5"],
  ["search hybrid (in room)", "/api/search?q=stroke+rehabilitation&mode=hybrid&server=medrxiv&category=neurology&limit=5"],
  ["search keyword", "/api/search?q=covid+vaccine&mode=keyword&limit=5"],
  ["similar (cshl-CITE)", "/api/similar?key=2021.05.04.442622&limit=4"],
  ["paper lookup", "/api/paper?doi=10.1101/2021.05.04.442622"],
  ["pdf resolve", "/api/pdf?key=2021.05.04.442622"],
  ["feed", "/api/feed?limit=3"],
  ["community", "/api/community?limit=3"],
  ["chat-sessions list", "/api/chat-sessions"],
];

let bad = 0;
for (const [name, path] of CASES) {
  const t0 = Date.now();
  try {
    const r = await fetch(base + path, { signal: AbortSignal.timeout(30000) });
    const ms = Date.now() - t0;
    const body = (await r.text()).slice(0, 90).replace(/\s+/g, " ");
    const fail = r.status >= 500;
    if (fail) bad++;
    console.log(`${fail ? "FAIL" : "ok  "} ${String(r.status)} ${String(ms).padStart(5)}ms  ${name.padEnd(30)} ${body}`);
  } catch (e) {
    bad++;
    console.log(`FAIL ERR  ${String(Date.now() - t0).padStart(5)}ms  ${name.padEnd(30)} ${e.message}`);
  }
}
console.log(bad ? `\n${bad} endpoint(s) failing` : "\nall endpoints healthy");
process.exit(bad ? 1 : 0);
