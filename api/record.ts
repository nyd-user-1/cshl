// /api/record — one NSR record with its enrichment, from Neon.
//   ?id=<nsr.id>  or  ?key=<key_number>
// Replaces the Supabase REST read the record drawer used (legacy DB, cold =
// seconds). Cacheable: records change monthly.
import { neon } from "@neondatabase/serverless";

export const config = { maxDuration: 15 };

const COLS = `id, key_number, pub_year, reference, authors, title, doi, exfor_keys, keywords,
  nuclides, reactions, subjects, topics, reference_type, is_nsr,
  s2_paper_id, citation_count, influential_citation_count, reference_count, abstract, tldr, venue,
  publication_date, is_open_access, open_access_pdf_url, fields_of_study, s2_authors,
  s2_lookup_status, s2_looked_up_at, pdf_url, arxiv_id, openalex_id`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  const sql = neon(process.env.DATABASE_URL!);
  const id = req.query?.id ? Number(req.query.id) : null;
  const key = req.query?.key ? String(req.query.key).toUpperCase() : null;
  if (!id && !key) return res.status(400).json({ error: "id or key required" });
  if (req.method === "PATCH") {
    // community-edited abstract (the drawer's "save abstract"); no auth by ruling
    const abstract = String(req.body?.abstract ?? "").trim();
    if (!abstract) return res.status(400).json({ error: "abstract required" });
    await (id ? sql.query(`UPDATE nsr SET abstract = $2 WHERE id = $1`, [id, abstract]) : sql.query(`UPDATE nsr SET abstract = $2 WHERE key_number = $1`, [key, abstract]));
    return res.status(200).json({ ok: true });
  }
  if (req.method !== "GET") return res.status(405).json({ error: "GET or PATCH" });
  try {
    const rows = id
      ? await sql.query(`SELECT ${COLS} FROM nsr WHERE id = $1`, [id])
      : await sql.query(`SELECT ${COLS} FROM nsr WHERE key_number = $1`, [key]);
    if (!rows[0]) return res.status(404).json({ error: "not found" });
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json(rows[0]);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
}
