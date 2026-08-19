// /api/bricc — thin proxy to BrIcc, ANU's internal-conversion calculator.
//
// BrIcc interpolates the Band–Raman tables server-side at ANU; the database
// is a binary blob and the interpolation is theirs, so — as with LogFT — we
// relay rather than re-derive. We POST the same form their page submits and
// return the result table verbatim: header lines, column names, cell rows.
// The client renders exactly what ANU printed.
//
//   POST { atomic, energy, eerror?, multipole?, delta?, derror? }
//   → { meta: string[], columns: string[], rows: string[][] } | { error }

export const config = { maxDuration: 30 };

const ENDPOINT = "https://bricc.anu.edu.au/";

const strip = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&gamma;/g, "γ")
    .replace(/&delta;/g, "δ")
    .replace(/&alpha;/g, "α")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const b = req.body ?? {};
  const form = new URLSearchParams({
    atomic: String(b.atomic ?? "").slice(0, 20),
    energy: String(b.energy ?? "").slice(0, 20),
    eerror: String(b.eerror ?? "").slice(0, 20),
    multipole: String(b.multipole ?? "").slice(0, 10),
    delta: String(b.delta ?? "").slice(0, 20),
    derror: String(b.derror ?? "").slice(0, 20),
    calculate: "Calculate",
  });

  let html: string;
  try {
    const upstream = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(20_000),
    });
    if (!upstream.ok) {
      return res.status(502).json({ error: `BrIcc: HTTP ${upstream.status}` });
    }
    html = await upstream.text();
  } catch {
    return res.status(502).json({ error: "BrIcc (bricc.anu.edu.au) is unreachable" });
  }

  // The one <table> in their response is the result. Rows before the column
  // header ("Shell", …) are metadata lines; everything after is data.
  const table = html.match(/<table[^>]*>([\s\S]*?)<\/table>/)?.[1];
  if (!table) {
    // Their error messages come back as a styled paragraph instead of a table.
    const err = html.match(/<p[^>]*class="[^"]*error[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    return res.status(200).json({
      error: err ? strip(err[1]) : "BrIcc returned no result for these inputs",
    });
  }

  const meta: string[] = [];
  let columns: string[] = [];
  const rows: string[][] = [];
  for (const tr of table.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []) {
    const cells = (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g) ?? []).map(strip);
    if (!cells.some(Boolean)) continue; // their table pads with empty spacer rows
    if (!columns.length) {
      if (cells[0].toLowerCase() === "shell") columns = cells;
      else meta.push(cells.filter(Boolean).join(" "));
    } else {
      rows.push(cells);
    }
  }

  if (!columns.length || !rows.length) {
    return res.status(200).json({ error: "BrIcc returned no result for these inputs" });
  }
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=86400");
  return res.status(200).json({ meta, columns, rows });
}
