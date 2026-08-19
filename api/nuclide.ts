// /api/nuclide — one nuclide's ENSDF + XUNDL datasets, and a dataset's references.
//   ?nucid=148GD                       → { nucid, a, symbol, ensdf:[{dsid, revised, refs}], xundl:[…] }
//   ?nucid=148GD&source=ensdf&dsid=…   → { …, refs:[ NSR records cited by that dataset ] }
// Backed by ensdf_datasets / ensdf_refs (sql/20) and xundl_archive_datasets /
// xundl_refs (sql/28) — the parsed archival distributions — joined to nsr.
import { neon } from "@neondatabase/serverless";

export const config = { maxDuration: 15 };

const REF_COLS = `n.id, n.key_number, n.pub_year, n.reference, n.authors, n.title, n.doi, n.keywords, n.abstract,
  n.nuclides, n.reactions, n.citation_count, n.is_nsr, n.reference_type`;
const revised = (d: unknown) => {
  const s = String(d ?? "");
  return /^\d{6}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}` : s || null;
};

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const sql = neon(process.env.DATABASE_URL!);

  // Index mode: ?list=ensdf|xundl&q=&page=1 → paginated dataset cards for the
  // /ensdf and /xundl index pages. q matches the nuclide (prefix) or dsid (substring).
  if (req.query?.list) {
    const srcList = req.query.list === "xundl" ? "xundl" : "ensdf";
    const table = srcList === "xundl" ? "xundl_archive_datasets" : "ensdf_datasets";
    const refsTable = srcList === "xundl" ? "xundl_refs" : "ensdf_refs";
    const per = 99;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const q = String(req.query.q ?? "").trim().toUpperCase().replace(/[%_]/g, "");
    // Filters + sort, mirroring the /endf index bar: ?year=2015 (revised year),
    // ?el=GD (element), ?sort=nuclide|dataset|revised&dir=asc|desc.
    const year = /^\d{4}$/.test(String(req.query.year ?? "")) ? String(req.query.year) : "";
    const el = String(req.query.el ?? "").trim().toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
    const dir = req.query.dir === "desc" ? "DESC" : "ASC";
    const orderBy =
      req.query.sort === "dataset" ? `d.dsid ${dir}, d.a NULLS LAST, d.nucid`
      : req.query.sort === "revised" ? `d.entry_date ${dir} NULLS LAST, d.a NULLS LAST, d.nucid, d.dsid`
      : `d.a ${dir} NULLS LAST, d.nucid ${dir}, d.dsid`;
    try {
      const params: unknown[] = [per, (page - 1) * per];
      const conds: string[] = [];
      if (q) { params.push(`${q}%`, `%${q}%`); conds.push(`(d.nucid LIKE $${params.length - 1} OR d.dsid LIKE $${params.length})`); }
      if (year) { params.push(`${year}%`); conds.push(`d.entry_date::text LIKE $${params.length}`); }
      if (el) { params.push(`^[0-9]+${el}$`); conds.push(`d.nucid ~ $${params.length}`); }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      const rows = await sql.query(
        `SELECT d.nucid, d.a, d.dsid, d.entry_date,
                (SELECT count(*)::int FROM ${refsTable} r WHERE r.nucid = d.nucid AND r.dsid = d.dsid) AS refs,
                count(*) OVER()::int AS total
         FROM ${table} d ${where}
         ORDER BY ${orderBy}
         LIMIT $1 OFFSET $2`,
        params,
      );
      res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
      return res.status(200).json({
        total: rows[0]?.total ?? 0,
        datasets: rows.map((d) => ({ nucid: d.nucid, a: d.a, dsid: d.dsid, revised: revised(d.entry_date), refs: d.refs })),
      });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  }

  // Retrieval mode — NNDC's "Retrieve selected ENSDF datasets" from our own copy:
  //   ?text=1&ds=180|COMMENTS&ds=180ER|ADOPTED LEVELS   → the raw 80-column card decks, request order
  //   &src=xundl                                        → same from the XUNDL distribution
  //   &print=1                                          → printable page that opens the print dialog
  //                                                       (the browser's Save-as-PDF is the PDF version)
  if (req.query?.text) {
    const dsParam = req.query.ds;
    const pairs = (Array.isArray(dsParam) ? dsParam : dsParam ? [dsParam] : [])
      .map((s: unknown) => { const t = String(s); const i = t.indexOf("|"); return i > 0 ? [t.slice(0, i), t.slice(i + 1)] : null; })
      .filter((p: string[] | null): p is [string, string] => !!p && !!p[0] && !!p[1])
      .slice(0, 60);
    if (!pairs.length) return res.status(400).json({ error: "ds=<nucid>|<dsid> required (repeatable)" });
    const table = req.query.src === "xundl" ? "xundl_archive_datasets" : "ensdf_datasets";
    try {
      const rows = await sql.query(
        `SELECT nucid, dsid, raw FROM ${table} WHERE (nucid, dsid) IN (${pairs.map((_: unknown, i: number) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(", ")})`,
        pairs.flat(),
      );
      const byKey = new Map(rows.map((r) => [`${r.nucid}|${r.dsid}`, String(r.raw).replace(/\s+$/, "")]));
      const decks = pairs.map((p: [string, string]) => byKey.get(`${p[0]}|${p[1]}`)).filter(Boolean) as string[];
      const text = decks.join("\n\n") + "\n";
      const src = req.query.src === "xundl" ? "xundl" : "ensdf";
      res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
      // PDF Version: parse the decks and typeset them (NDS-style serif layout);
      // the page opens the print dialog so Save-as-PDF is one click.
      if (req.query.print) {
        const { toTypesetHtml } = await import("./_lib/ensdf-render.js");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.status(200).send(toTypesetHtml(decks, src));
      }
      if (req.query.fmt === "md") {
        const { toMarkdown } = await import("./_lib/ensdf-render.js");
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        res.setHeader("Content-Disposition", "inline");
        return res.status(200).send(toMarkdown(decks, src));
      }
      if (req.query.fmt === "llms") {
        const { toLlms } = await import("./_lib/ensdf-render.js");
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        return res.status(200).send(toLlms(decks, src));
      }
      // 12px browser view of the raw cards (NNDC's own text size); bare text/plain stays for machines.
      if (req.query.fmt === "view") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.status(200).send(
          `<!doctype html><title>ENSDF text</title><style>body{margin:24px;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre}</style><body>${escapeHtml(text)}`,
        );
      }
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(200).send(text);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  }

  // Chain mode: ?a=148 → every ENSDF dataset filed under any A=148 nuclide (NNDC "Datasets for 148"),
  // grouped by nuclide, plus the chain-level COMMENTS entry (nucid "148").
  if (req.query?.a && !req.query?.nucid) {
    const a = Number(req.query.a);
    if (!Number.isInteger(a) || a < 1 || a > 300) return res.status(400).json({ error: "a must be 1..300" });
    try {
      const rows = await sql.query(
        `SELECT d.nucid, d.dsid, d.entry_date,
                (SELECT count(*)::int FROM ensdf_refs r WHERE r.nucid = d.nucid AND r.dsid = d.dsid) AS refs
         FROM ensdf_datasets d WHERE d.nucid ~ $1
         ORDER BY d.nucid, (d.dsid ILIKE 'COMMENTS%') DESC, (d.dsid ILIKE 'REFERENCES%') DESC, (d.dsid ILIKE 'ADOPTED%') DESC, d.dsid`,
        [`^${a}[A-Z]{0,2}$`],
      );
      // NNDC's order is by Z, not alphabetical symbol — resolve Z from nuclide_dict when possible.
      const zRows = await sql.query(`SELECT DISTINCT regexp_replace(nuclide_code, '^[0-9]+', '') AS sym, z FROM nuclide_dict WHERE a = $1`, [a]).catch(() => [] as Record<string, unknown>[]);
      const zOf = new Map<string, number>(zRows.map((r) => [String(r.sym), Number(r.z)]));
      const sym = (nucid: string) => nucid.replace(/^\d+/, "");
      const sorted = [...rows].sort((x, y) => {
        const sx = sym(String(x.nucid)), sy = sym(String(y.nucid));
        if (sx === "" && sy !== "") return -1; if (sy === "" && sx !== "") return 1;
        const zx = zOf.get(sx) ?? 999, zy = zOf.get(sy) ?? 999;
        return zx - zy || sx.localeCompare(sy);
      });
      res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
      return res.status(200).json({
        a,
        datasets: sorted.map((d) => ({ nucid: d.nucid, dsid: d.dsid, revised: revised(d.entry_date), refs: d.refs })),
      });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  }
  // Element mode: ?el=GD → every ENSDF dataset filed under any Gd isotope (NNDC "Datasets for Gd"), by A.
  if (req.query?.el && !req.query?.nucid) {
    const el = String(req.query.el).toUpperCase().replace(/[^A-Z]/g, "");
    if (!/^[A-Z]{1,2}$/.test(el)) return res.status(400).json({ error: "el like GD required" });
    try {
      const rows = await sql.query(
        `SELECT d.nucid, d.dsid, d.entry_date,
                (SELECT count(*)::int FROM ensdf_refs r WHERE r.nucid = d.nucid AND r.dsid = d.dsid) AS refs
         FROM ensdf_datasets d WHERE d.nucid ~ $1
         ORDER BY substring(d.nucid from '^[0-9]+')::int, (d.dsid ILIKE 'ADOPTED%') DESC, d.dsid`,
        [`^[0-9]+${el}$`],
      );
      res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
      return res.status(200).json({
        el: el[0] + el.slice(1).toLowerCase(),
        datasets: rows.map((d) => ({ nucid: d.nucid, dsid: d.dsid, revised: revised(d.entry_date), refs: d.refs })),
      });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  }
  const nucid = String(req.query?.nucid ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  // A bare mass number ("148") is the chain-level record (COMMENTS dataset) — valid for refs lookups only.
  const m = /^(\d{1,3})([A-Z]{0,2})$/.exec(nucid);
  if (!m) return res.status(400).json({ error: "nucid like 148GD required" });
  const a = Number(m[1]);
  const symbol = m[2] ? m[2][0] + m[2].slice(1).toLowerCase() : "";
  const source = req.query?.source === "xundl" ? "xundl" : req.query?.source === "ensdf" ? "ensdf" : null;
  const dsid = req.query?.dsid ? String(req.query.dsid) : null;
  try {
    if (source && dsid) {
      const refsTable = source === "xundl" ? "xundl_refs" : "ensdf_refs";
      const dsTable = source === "xundl" ? "xundl_archive_datasets" : "ensdf_datasets";
      const [ds, refs] = await Promise.all([
        sql.query(`SELECT dsid, dsref, pub, entry_date FROM ${dsTable} WHERE nucid = $1 AND dsid = $2`, [nucid, dsid]),
        sql.query(
          `SELECT ${REF_COLS} FROM ${refsTable} r JOIN nsr n USING (key_number)
           WHERE r.nucid = $1 AND r.dsid = $2 ORDER BY n.pub_year DESC NULLS LAST, n.key_number`,
          [nucid, dsid],
        ),
        // key numbers cited but not in our corpus still get listed
      ]);
      const missing = await sql.query(
        `SELECT r.key_number FROM ${refsTable} r LEFT JOIN nsr n USING (key_number) WHERE r.nucid = $1 AND r.dsid = $2 AND n.key_number IS NULL`,
        [nucid, dsid],
      );
      res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
      return res.status(200).json({
        nucid, a, symbol, source, dsid,
        dataset: ds[0] ? { ...ds[0], revised: revised(ds[0].entry_date) } : null,
        refs, missing: missing.map((r) => r.key_number),
      });
    }
    if (!symbol) return res.status(400).json({ error: "nucid like 148GD required" });
    // Datasets filed under OTHER nuclides whose ID names this nuclide as the decay parent
    // (NNDC: "These … decay datasets have your selected isotope as a parent") — dsid
    // begins with "<nucid> " and contains DECAY, e.g. 148GD's daughters carry "148TB EC DECAY".
    const parentPat = `${nucid} %DECAY%`;
    const [ensdf, xundl, ensdfParent, xundlParent, lit] = await Promise.all([
      sql.query(
        `SELECT d.dsid, d.dsref, d.pub, d.entry_date, d.num_cards,
                (SELECT count(*)::int FROM ensdf_refs r WHERE r.nucid = d.nucid AND r.dsid = d.dsid) AS refs
         FROM ensdf_datasets d WHERE d.nucid = $1 ORDER BY (d.dsid ILIKE 'ADOPTED%') DESC, d.dsid`,
        [nucid],
      ),
      sql.query(
        `SELECT d.dsid, d.dsref, d.entry_date,
                (SELECT count(*)::int FROM xundl_refs r WHERE r.nucid = d.nucid AND r.dsid = d.dsid) AS refs
         FROM xundl_archive_datasets d WHERE d.nucid = $1 ORDER BY d.entry_date DESC, d.dsid`,
        [nucid],
      ),
      sql.query(
        `SELECT d.nucid, d.dsid, d.entry_date, (SELECT count(*)::int FROM ensdf_refs r WHERE r.nucid = d.nucid AND r.dsid = d.dsid) AS refs
         FROM ensdf_datasets d WHERE d.nucid <> $1 AND d.dsid LIKE $2 ORDER BY d.nucid, d.dsid`,
        [nucid, parentPat],
      ),
      sql.query(
        `SELECT d.nucid, d.dsid, d.entry_date, (SELECT count(*)::int FROM xundl_refs r WHERE r.nucid = d.nucid AND r.dsid = d.dsid) AS refs
         FROM xundl_archive_datasets d WHERE d.nucid <> $1 AND d.dsid LIKE $2 ORDER BY d.nucid, d.dsid`,
        [nucid, parentPat],
      ),
      // literature on exactly this nuclide (NSR nuclide selectors), most cited + most recent
      sql.query(
        `SELECT * FROM (
           SELECT n.key_number, n.title, n.authors, n.pub_year, n.doi, n.citation_count, (n.pdf_url IS NOT NULL) AS has_pdf, left(n.abstract, 240) AS snippet,
                  ROW_NUMBER() OVER (ORDER BY n.citation_count DESC NULLS LAST, n.pub_year DESC) AS r_top,
                  ROW_NUMBER() OVER (ORDER BY n.pub_year DESC, n.key_number DESC) AS r_new,
                  count(*) OVER () AS total
           FROM (SELECT DISTINCT key_number FROM nsr_nuclides WHERE a = $1 AND upper(element_symbol) = $2) j JOIN nsr n USING (key_number)
         ) x WHERE r_top <= 12 OR r_new <= 12`,
        [a, m[2]],
      ),
    ]);
    const paper = (r: Record<string, unknown>) => ({
      key: r.key_number, title: r.title, authors: r.authors, year: r.pub_year, doi: r.doi,
      cites: r.citation_count, pdf: r.has_pdf, snippet: r.snippet,
    });
    const top = lit.filter((r) => Number(r.r_top) <= 12).sort((x, y) => Number(x.r_top) - Number(y.r_top)).map(paper);
    const seenKeys = new Set(top.map((p) => p.key));
    const recent = lit.filter((r) => Number(r.r_new) <= 12 && !seenKeys.has(r.key_number)).sort((x, y) => Number(x.r_new) - Number(y.r_new)).map(paper);
    const parentRow = (d: Record<string, unknown>) => ({ nucid: d.nucid, dsid: d.dsid, revised: revised(d.entry_date), refs: d.refs });
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json({
      nucid, a, symbol,
      ensdf: ensdf.map((d) => ({ dsid: d.dsid, dsref: d.dsref, pub: d.pub, revised: revised(d.entry_date), cards: d.num_cards, refs: d.refs })),
      xundl: xundl.map((d) => ({ dsid: d.dsid, dsref: d.dsref, revised: revised(d.entry_date), refs: d.refs })),
      parent: { ensdf: ensdfParent.map(parentRow), xundl: xundlParent.map(parentRow) },
      literature: { total: Number(lit[0]?.total ?? 0), top, recent },
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
}
