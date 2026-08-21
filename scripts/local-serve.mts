// Serve the built SPA and the real api/ handlers from one local port.
//
//   npm run build && npx tsx scripts/local-serve.mts [port]
//
// WHY THIS EXISTS. The browser spot-check the lane requires needs a real
// browser against real code, and neither obvious route works here: preview
// deployments sit behind Vercel auth (no automation bypass secret is
// configured), and `vercel dev` 58.x fails on this project ("Failed to detect
// a server running on port …" from the static-build dev server, plus it shells
// out to yarn). This serves dist/ with SPA fallback and dispatches /api/* to
// the SAME handler modules Vercel deploys, with .env.local loaded — so what
// the browser exercises is the shipped code, not a stand-in.
//
// It is a test harness, not part of the deploy: nothing in api/ or src/
// imports it.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const port = Number(process.argv[2] ?? 3999);

for (const line of readFileSync(join(root, ".env.local"), "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ico": "image/x-icon",
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);

  if (url.pathname.startsWith("/api/")) {
    const name = url.pathname.slice(5).replace(/[^a-z0-9-]/gi, "");
    const mod = join(root, "api", `${name}.ts`);
    if (!existsSync(mod)) { res.statusCode = 404; return res.end("no such function"); }

    // Shim the two Vercel-isms the handlers use: req.query and req.body.
    const anyReq = req as unknown as { query: Record<string, string>; body?: unknown };
    anyReq.query = Object.fromEntries(url.searchParams);
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      try { anyReq.body = raw ? JSON.parse(raw) : {}; } catch { anyReq.body = {}; }
    }
    const anyRes = res as unknown as {
      status: (n: number) => unknown; json: (v: unknown) => unknown; send: (v: unknown) => unknown;
    };
    anyRes.status = (n: number) => { res.statusCode = n; return anyRes; };
    anyRes.json = (v: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(v)); return anyRes; };
    anyRes.send = (v: unknown) => { res.end(String(v)); return anyRes; };

    try {
      const handler = (await import(`${mod}?t=${Date.now()}`)).default;
      await handler(req, res);
    } catch (e) {
      console.error(`api/${name}:`, e);
      if (!res.headersSent) { res.statusCode = 500; res.end(String(e)); } else res.end();
    }
    return;
  }

  // Static, with SPA fallback — the same shape vercel.json's rewrite gives.
  const rel = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
  const candidate = join(dist, rel);
  const isAsset = extname(candidate) !== "" && existsSync(candidate);
  const file = isAsset ? candidate : join(dist, "index.html");
  try {
    const buf = await readFile(file);
    res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
    res.end(buf);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
}).listen(port, () => console.log(`local-serve on http://localhost:${port}`));
