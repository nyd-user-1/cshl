// /api/search — the search backend for the preprint corpus, on Neon.
//
//   ?q=…&mode=keyword     weighted FTS (sql/02: title A, category+journal+institution B,
//                         abstract C), newest first on ties.
//   ?q=…&mode=semantic    ** DEGRADED — see below **
//   ?q=#2026.07.31        key_number prefix, either mode.
//   ?mode=structured      typed chip search: &categories=…&journals=…
//   &limit=               1..200 (default 100)
//
// GRACEFUL DEGRADATION (LANE-RXIV-MAP.md, scope guard): this corpus has no
// embeddings yet — no encoder, no reranker, no vector sidecar populated. Rather
// than 500 or return nothing, `semantic` and `hybrid` fall through to the same FTS
// path and say so in the payload (`degraded: true`, `requested_mode`). The UI's
// Hybrid/Semantic/Keyword toggle therefore keeps working and keeps returning
// results; the arms simply agree for now.
//
// Restoring dense retrieval is additive and needs no change here beyond a new arm:
// populate preprint_embeddings (bge-m3, 1024-d, keyed by key_number), add the HNSW
// index, then reinstate the RRF fusion that api/_lib/embed.ts still provides.

import { neon } from "@neondatabase/serverless";

export const config = { maxDuration: 30 };

type Row = Record<string, unknown>;

const SELECT = `p.id, p.key_number, p.pub_year, p.reference, p.authors, p.title, p.doi,
  p.abstract, p.categories, p.status_tags, p.server, p.version, p.type, p.license,
  p.posted_date, p.published_doi, p.published_journal, p.institution, p.pdf_url`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const sql = neon(process.env.DATABASE_URL!);
  const q = (text: string, params: unknown[] = []) =>
    (sql as unknown as { query: (t: string, p: unknown[]) => Promise<Row[]> }).query(text, params);

  const list = (v: unknown) =>
    (Array.isArray(v) ? v : String(v ?? "").split(",")).map((x) => String(x).trim().toLowerCase()).filter(Boolean);

  /* ── structured: typed chip search, no free text ─────────────────────────── */
  if (req.query?.mode === "structured") {
    // nuclides/reactions are the NSR-era parameter names, kept as aliases
    const categories = list(req.query?.categories ?? req.query?.nuclides);
    const journals = list(req.query?.journals ?? req.query?.reactions);
    const lim = Math.min(200, Math.max(1, Number(req.query?.limit ?? 50) || 50));
    if (!categories.length && !journals.length)
      return res.status(200).json({ records: [], count: 0, mode: "structured" });
    const conds: string[] = []; const params: unknown[] = [];
    if (categories.length) { params.push(categories); conds.push(`p.categories && $${params.length}::text[]`); }
    if (journals.length) { params.push(journals); conds.push(`lower(p.published_journal) = ANY($${params.length}::text[])`); }
    params.push(lim);
    const rows = await q(
      `SELECT ${SELECT}, 1.0::float AS similarity FROM preprints p
       WHERE ${conds.join(" AND ")}
       ORDER BY p.pub_year DESC NULLS LAST, p.posted_date DESC LIMIT $${params.length}`, params);
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json({ records: rows, count: rows.length, mode: "structured" });
  }

  const raw = String(req.query?.q ?? "").trim();
  const requested = String(req.query?.mode ?? "semantic");
  const limit = Math.min(200, Math.max(1, Number(req.query?.limit ?? 100) || 100));
  if (raw.length < 2) return res.status(200).json({ records: [], count: 0, mode: requested });

  const t0 = Date.now();
  try {
    /* ── #KEY: key_number prefix ──────────────────────────────────────────── */
    if (raw.startsWith("#")) {
      const key = raw.slice(1).trim().replace(/[%_]/g, "");
      if (!key) return res.status(200).json({ records: [], count: 0, mode: "key" });
      const rows = await q(
        `SELECT ${SELECT} FROM preprints p WHERE p.key_number LIKE $1 ORDER BY p.key_number LIMIT $2`,
        [key + "%", limit]);
      return res.status(200).json({ records: rows, count: rows.length, mode: "key", timings: { total_ms: Date.now() - t0 } });
    }

    const rows = await q(
      `SELECT ${SELECT},
              least(ts_rank_cd(p.fts, websearch_to_tsquery('english', $1)) / 4.0, 0.99)::float AS similarity
       FROM preprints p
       WHERE p.fts @@ websearch_to_tsquery('english', $1)
       ORDER BY ts_rank_cd(p.fts, websearch_to_tsquery('english', $1)) DESC,
                p.pub_year DESC NULLS LAST
       LIMIT $2`, [raw, limit]);

    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json({
      records: rows,
      count: rows.length,
      mode: "keyword",
      requested_mode: requested,
      degraded: requested !== "keyword",
      note: requested !== "keyword" ? "no embeddings yet — served by full-text search" : undefined,
      timings: { total_ms: Date.now() - t0 },
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
}
