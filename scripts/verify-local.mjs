#!/usr/bin/env node
/**
 * Local verification of the deployed surface, per the lead's ruling: prove the app
 * end to end against the real CSHL database WITHOUT minting a deployment
 * protection-bypass token (which would widen access to the preview).
 *
 * Serves the production build on 127.0.0.1 and routes /api/* to the real handlers,
 * then drives the exact requests the /nsr References browser makes and asserts the
 * card contract field by field.
 *
 * Honest limit, stated rather than glossed: this proves the built bundle serves and
 * that every field the card and drawer read is present and correctly shaped on real
 * rows. It does not rasterise the page — there is no browser on this box by
 * standing constraint. Pixel proof is Brendan's own logged-in click.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const ROOT = "/Users/brendanstanton/Code/cshl";
const PORT = Number(process.env.PORT ?? 3131);
const env = Object.fromEntries(fs.readFileSync(`${ROOT}/.env.local`, "utf8")
  .split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l))
  .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
process.env.DATABASE_URL = env.DATABASE_URL;

if (!new URL(env.DATABASE_URL).host.startsWith("ep-orange-water-aut2eymf")) {
  console.error("FENCE FAIL — not the CSHL database"); process.exit(1);
}

const handlers = {};
for (const route of ["records", "record", "dict", "search"]) {
  const out = `${ROOT}/.verify_${route}.mjs`;
  await build({ entryPoints: [`${ROOT}/api/${route}.ts`], outfile: out, bundle: true,
    platform: "node", format: "esm", external: ["@neondatabase/serverless"], logLevel: "silent" });
  handlers[route] = (await import(out + "?t=" + Date.now())).default;
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".avif": "image/avif" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname.startsWith("/api/")) {
    const route = url.pathname.slice(5);
    const h = handlers[route];
    if (!h) { res.writeHead(404).end("no route"); return; }
    const query = Object.fromEntries(url.searchParams);
    let status = 200, body;
    const shim = { setHeader() {}, status(c) { status = c; return shim; },
      json(b) { body = b; return shim; }, send(b) { body = b; return shim; } };
    try { await h({ method: req.method, query, body: {} }, shim); }
    catch (e) { status = 500; body = { error: String(e) }; }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }
  // static + SPA fallback, mirroring vercel.json's rewrite
  let f = path.join(ROOT, "dist", url.pathname === "/" ? "index.html" : url.pathname);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(ROOT, "dist", "index.html");
  res.writeHead(200, { "Content-Type": MIME[path.extname(f)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(f));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const base = `http://127.0.0.1:${PORT}`;
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, ct: r.headers.get("content-type"), body: await r.text() }; };
const json = async (p) => JSON.parse((await get(p)).body);

let fails = 0;
const ok = (cond, label, detail = "") => { console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  " + detail : ""}`); if (!cond) fails++; };

console.log("\n=== 1. the built SPA serves ===");
const idx = await get("/");
ok(idx.status === 200 && idx.body.includes('<div id="root">'), "GET / returns the app shell");
ok(idx.body.includes("cshl-logo.png"), "favicon is the CSH mark, not BNL");
const bundle = idx.body.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
const js = await get("/" + bundle);
ok(js.status === 200 && js.body.length > 100_000, "main bundle serves", `${bundle} ${(js.body.length / 1024 | 0)} kB`);
ok(js.body.includes("RxivGPT"), "wordmark in bundle is RxivGPT");
// the card lives in a code-split chunk, not the entry bundle — scan dist/assets
const chunks = fs.readdirSync(`${ROOT}/dist/assets`).filter((f) => f.endsWith(".js"));
const chunkHas = (needle) => chunks.filter((f) => fs.readFileSync(`${ROOT}/dist/assets/${f}`, "utf8").includes(needle));
const refChunk = chunkHas('children:"Category"');
ok(refChunk.length > 0, "card chip label 'Category' shipped", refChunk.slice(0, 2).join(", "));
ok(chunkHas('children:"Status"').length > 0, "card chip label 'Status' shipped");
const stale = chunkHas("Nuclides").filter((f) => /References|RecordDrawer|RecordDialog/.test(f));
ok(stale.length === 0, "no 'Nuclides' left in the References/drawer chunks", stale.join(", ") || "clean");
const spa = await get("/nsr/some/deep/route");
ok(spa.status === 200 && spa.body.includes('<div id="root">'), "SPA fallback serves index.html for deep routes");

console.log("\n=== 2. the exact call the References browser makes on load ===");
const page1 = await json("/api/records?page=1&pageSize=99");
ok(page1.records?.length === 99, "page 1 returns 99 cards", `totalCount=${page1.totalCount?.toLocaleString()}`);
const servers = new Set(page1.records.map((r) => r.server));
ok(servers.size >= 1, "cards carry a server", [...servers].join(" + "));

console.log("\n=== 3. the card contract, field by field, over all 99 rows ===");
const need = ["key_number", "pub_year", "title", "authors", "reference", "doi", "categories", "status_tags"];
for (const f of need) {
  const n = page1.records.filter((r) => r[f] !== null && r[f] !== undefined && (!Array.isArray(r[f]) || r[f].length)).length;
  ok(n === 99, `every card has ${f}`, `${n}/99`);
}
const auth = page1.records[0].authors;
ok(/^[^,]+, [A-Z]\./.test(auth), "authors normalized to 'Last, I.'", JSON.stringify(auth.slice(0, 48)));
ok(page1.records.every((r) => r.categories.every((c) => c === c.toLowerCase().trim())), "categories are normalized lower/trimmed");
ok(page1.records.every((r) => /^v\d+$/.test(r.status_tags[0])), "status chip 1 is the version");

console.log("\n=== 4. filters the toolbar drives ===");
for (const [q, label] of [["year=2024", "year"], ["published=1", "published-only (was EXFOR)"],
                          ["category=epidemiology", "category"], ["server=biorxiv", "server"]]) {
  const r = await json(`/api/records?pageSize=3&${q}`);
  ok(r.records?.length > 0 && r.totalCount > 0, `filter ${label}`, `${r.totalCount.toLocaleString()} rows`);
}

console.log("\n=== 5. the two comboboxes ===");
for (const t of ["categories", "journals"]) {
  const d = await json(`/api/dict?type=${t}&limit=20000`);
  ok(Array.isArray(d) && d.length > 0, `/api/dict?type=${t}`, `${d.length} values, top="${d[0]?.value}"`);
}

console.log("\n=== 6. search degrades to keyword, does not error ===");
const s = await json("/api/search?q=crispr%20screen&mode=semantic&limit=5");
ok(s.records?.length > 0, "semantic query returns rows", `mode=${s.mode} degraded=${s.degraded}`);
ok(s.degraded === true, "degradation is declared in the payload, not silent");

console.log("\n=== 7. the record drawer ===");
const key = page1.records[0].key_number;
const rec = await json(`/api/record?key=${encodeURIComponent(key)}`);
ok(rec.key_number === key, "drawer fetch by key_number", key);
ok(Array.isArray(rec.versions) && rec.versions.length >= 1, "version timeline present", `${rec.versions?.length} versions`);
ok(typeof rec.abstract === "string" && rec.abstract.length > 50, "abstract present for the drawer body");
ok(/^https:\/\/www\.(bio|med)rxiv\.org\/content\/.*\.full\.pdf$/.test(rec.pdf_url), "pdf_url derived");

server.close();
for (const route of Object.keys(handlers)) fs.rmSync(`${ROOT}/.verify_${route}.mjs`, { force: true });
console.log(fails === 0 ? "\nALL LOCAL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
