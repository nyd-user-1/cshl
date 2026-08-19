// /api/record — one preprint with its version history, from Neon.
//   ?id=<preprints.id>  or  ?key=<key_number>
//
// key_number is the DOI suffix ('2026.07.31.741992', '001891'), which is digits and
// dots only — so the caller's .toUpperCase() is a no-op and stays harmless.
import { neon } from "@neondatabase/serverless";

export const config = { maxDuration: 15 };

const COLS = `id, key_number, pub_year, reference, authors, title, doi, abstract,
  categories, status_tags, server, version, type, license, posted_date,
  published_doi, published_journal, published_date, institution, author_corresponding,
  jatsxml_url, pdf_url`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  const sql = neon(process.env.DATABASE_URL!);
  const id = req.query?.id ? Number(req.query.id) : null;
  const key = req.query?.key ? String(req.query.key).trim() : null;
  if (!id && !key) return res.status(400).json({ error: "id or key required" });

  if (req.method === "PATCH") {
    // community-edited abstract (the drawer's "save abstract"); no auth by ruling
    const abstract = String(req.body?.abstract ?? "").trim();
    if (!abstract) return res.status(400).json({ error: "abstract required" });
    await (id
      ? sql.query(`UPDATE preprints SET abstract = $2 WHERE id = $1`, [id, abstract])
      : sql.query(`UPDATE preprints SET abstract = $2 WHERE key_number = $1`, [key, abstract]));
    return res.status(200).json({ ok: true });
  }
  if (req.method !== "GET") return res.status(405).json({ error: "GET or PATCH" });

  try {
    const rows = id
      ? await sql.query(`SELECT ${COLS} FROM preprints WHERE id = $1`, [id])
      : await sql.query(`SELECT ${COLS} FROM preprints WHERE key_number = $1`, [key]);
    const rec = rows[0];
    if (!rec) return res.status(404).json({ error: "not found" });
    // the version timeline: v1 carries the raw submitted author names, later versions
    // the normalized ones, and a withdrawal only ever exists as a later version
    const versions = await sql.query(
      `SELECT version, posted_date, type, title, license FROM preprint_versions
       WHERE key_number = $1 ORDER BY version`, [rec.key_number],
    );
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json({ ...rec, versions });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
}
