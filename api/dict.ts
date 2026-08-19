// /api/dict — dictionaries for pickers and the "+" menu, from Neon.
//   ?type=nuclides|reactions|authors [&q=prefix] [&limit=N]
// Returns [{ value, record_count }] in the exact form the corpus arrays use
// ("137Cs", "(N,G)", "J.H.Gillette"), replacing the Supabase distinct_* views.
// Whole-corpus aggregates → cached at the edge for a day.
import { neon } from "@neondatabase/serverless";

export const config = { maxDuration: 30 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const sql = neon(process.env.DATABASE_URL!);
  const type = String(req.query?.type ?? "");
  const q = String(req.query?.q ?? "").trim();
  const limit = Math.min(20000, Math.max(1, Number(req.query?.limit ?? 5000) || 5000));
  try {
    let rows: Record<string, unknown>[];
    if (type === "nuclides" || type === "reactions") {
      const col = type === "nuclides" ? "nuclides" : "reactions";
      rows = await sql.query(
        `SELECT v AS value, count(*)::int AS record_count
         FROM nsr, unnest(${col}) AS v
         ${q ? "WHERE v ILIKE $2" : ""}
         GROUP BY v ORDER BY record_count DESC, v LIMIT $1`,
        q ? [limit, q.replace(/[%_]/g, "") + "%"] : [limit],
      );
    } else if (type === "authors") {
      rows = await sql.query(
        `SELECT (coalesce(a.initial1,'') || CASE WHEN a.initial2 IS NOT NULL AND a.initial2 <> '' THEN '.' || a.initial2 ELSE '' END || '.' || initcap(lower(a.last_name))) AS value,
                count(na.key_number)::int AS record_count
         FROM authors a JOIN nsr_authors na ON na.author_key = a.author_key
         ${q ? "WHERE a.last_name ILIKE $2" : ""}
         GROUP BY a.author_key, a.initial1, a.initial2, a.last_name
         ORDER BY record_count DESC, value LIMIT $1`,
        q ? [limit, q.replace(/[%_]/g, "") + "%"] : [limit],
      );
    } else {
      return res.status(400).json({ error: "type must be nuclides | reactions | authors" });
    }
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    return res.status(200).json(rows);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
}
