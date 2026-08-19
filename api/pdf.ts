// /api/pdf?key=<key_number> — streams a preprint PDF from bioRxiv/medRxiv through
// our own origin.
//
// Why a proxy rather than iframing the source directly: both servers send
// `x-frame-options: SAMEORIGIN` on their PDFs, so a cross-origin <iframe> is
// refused by the browser. NSR's ENDF viewer works because those PDFs are mirrored
// into our own S3 and served presigned; we have no such mirror for 433k preprints,
// and the licence mix (~72% restricting redistribution) makes bulk re-hosting a
// question we deliberately have not answered. Fetching one PDF per user click and
// streaming it is a reader, not a mirror.
//
// Upstream shape: https://www.{server}.org/content/{doi}v{version}.full.pdf
// Both DOI prefixes work (10.1101 legacy, 10.64898 from 2026).
import { neon } from "@neondatabase/serverless";

export const config = { maxDuration: 60 };

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const key = String(req.query?.key ?? "").trim();
  if (!key) return res.status(400).json({ error: "key required" });

  try {
    const sql = neon(process.env.DATABASE_URL!);
    const rows = (await sql`
      SELECT server, doi, version FROM preprints WHERE key_number = ${key} LIMIT 1
    `) as Array<{ server: string; doi: string; version: number | null }>;
    if (!rows.length) return res.status(404).json({ error: "unknown key" });

    const { server, doi } = rows[0];
    const version = rows[0].version ?? 1;
    const host = server === "medrxiv" ? "www.medrxiv.org" : "www.biorxiv.org";
    const upstream = `https://${host}/content/${doi}v${version}.full.pdf`;

    const r = await fetch(upstream, {
      headers: { "User-Agent": UA, Accept: "application/pdf,*/*" },
      redirect: "follow",
    });

    // The source rate-limits aggressively. Say so plainly rather than serving an
    // error page as a PDF — a viewer rendering an HTML 429 as a blank page is the
    // silent-failure shape this project spent a night learning to avoid.
    if (r.status === 429) {
      return res
        .status(429)
        .json({ error: "upstream rate limited", upstream, retry: true });
    }
    if (!r.ok) {
      return res.status(502).json({ error: `upstream ${r.status}`, upstream });
    }
    const ct = r.headers.get("content-type") ?? "";
    if (!ct.toLowerCase().includes("pdf")) {
      return res.status(502).json({ error: "upstream did not return a PDF", ct, upstream });
    }

    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", String(buf.length));
    // Cache hard: the same paper's PDF is immutable for a given version, and every
    // cache hit is one fewer request against a source that 429s.
    res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400, immutable");
    res.setHeader("Content-Disposition", `inline; filename="${key}.pdf"`);
    res.setHeader("X-Upstream", upstream);
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
