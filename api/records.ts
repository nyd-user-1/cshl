// /api/records — paginated browse of the corpus (the /references page), on Neon.
//   ?page=1&pageSize=99&year=2019&exfor=1
// Replaces the Supabase REST read that made /references take 25 s cold
// (`count: "exact"` + sort over the whole table on a paused project). Sort is
// pub_year DESC, key_number DESC (idx_nsr_pub_year). Total counts: unfiltered
// from pg_class.reltuples (exact enough for a pager, free), filtered via the
// btree. Cached at the edge for an hour — the corpus changes monthly.
import { neon } from "@neondatabase/serverless";

export const config = { maxDuration: 15 };

const COLS = `id, key_number, pub_year, reference, authors, title, doi, exfor_keys, keywords, nuclides, reactions,
  citation_count, abstract, subjects, topics, reference_type, is_nsr`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const sql = neon(process.env.DATABASE_URL!);
  const page = Math.max(1, Number(req.query?.page ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query?.pageSize ?? 99) || 99));
  const year = req.query?.year ? Number(req.query.year) : null;
  const exfor = req.query?.exfor === "1" || req.query?.exfor === "true";
  const where: string[] = []; const params: unknown[] = [];
  if (year) { params.push(year); where.push(`pub_year = $${params.length}`); }
  if (exfor) where.push(`exfor_keys IS NOT NULL`);
  const W = where.length ? `WHERE ${where.join(" AND ")}` : "";
  try {
    const off = (page - 1) * pageSize;
    const [rows, cnt] = await Promise.all([
      sql.query(`SELECT ${COLS} FROM nsr ${W} ORDER BY pub_year DESC NULLS LAST, key_number DESC LIMIT ${pageSize} OFFSET ${off}`, params),
      where.length
        ? sql.query(`SELECT count(*)::int AS n FROM nsr ${W}`, params)
        : sql.query(`SELECT reltuples::bigint::int AS n FROM pg_class WHERE relname = 'nsr'`),
    ]);
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json({ records: rows, totalCount: Number(cnt[0]?.n ?? 0), page, pageSize });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
}
