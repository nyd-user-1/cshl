// /api/search — the /search page's backend, on Neon.
//
//   ?q=…&mode=semantic   fusion (default): RRF of dense kNN + weighted FTS —
//                        the eval's "serve now" arm (nsr-eval-v1: best-or-tied
//                        on every segment; KW R@1 .21 vs .16 FTS / .08 dense).
//                        &arm=dense|fts forces a single arm.
//                        Dense = kNN over nsr_embeddings (stock bge-m3) or
//                        nsr_embeddings_nsr (our encoder) per SEARCH_ENCODER;
//                        query encoded in the matching model (api/_lib/embed).
//                        &rerank=1 (or SEARCH_RERANK=on) re-scores the top-50
//                        with nsr-reranker-gte-modernbert.
//   ?q=…&mode=keyword    weighted FTS (sql/19) + typed nuclide hits, newest first.
//   ?q=#2010SC08         key_number prefix, either mode.
//   &limit=              1..200 (default 100)
//
// Replaces the retired Supabase edge function (`semantic-search-nsr`, OpenAI
// 256-d over 46k rows) and the Supabase REST keyword path. Returns rows in the
// NsrRecord shape the page already renders; `similarity` is 1 − cosine distance
// (dense), a 0–1 rank (keyword), a normalised RRF score (fusion), or the
// reranker score mapped to 0–1 when reranked.

import { neon } from "@neondatabase/serverless";
import { activeEncoder, embedQueryCached, rerank, rerankEnabled, rrf, toVectorLiteral, vectorTable, type EncoderName } from "./_lib/embed.js";

export const config = { maxDuration: 30 };

type Row = Record<string, unknown>;

const SELECT = `n.id, n.key_number, n.pub_year, n.reference, n.authors, n.title, n.doi,
  n.exfor_keys, n.keywords, n.nuclides, n.reactions, n.citation_count, n.abstract, n.is_nsr,
  n.subjects, n.topics, n.reference_type`;

/** "137Cs" / "Cs-137" → "137Cs" (the form stored in nsr.nuclides). Same as /api/chat. */
function extractNuclides(text: string): string[] {
  const patterns = [/\b(\d{1,3})([A-Z][a-z]?)\b/g, /\b([A-Z][a-z]?)-?(\d{1,3})\b/g];
  const found = new Set<string>();
  for (const pat of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pat.exec(text)) !== null) {
      const numFirst = /^\d/.test(m[1]);
      const mass = numFirst ? m[1] : m[2];
      const sym = numFirst ? m[2] : m[1];
      found.add(`${mass}${sym[0].toUpperCase()}${sym.slice(1).toLowerCase()}`);
    }
  }
  return [...found];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const sql = neon(process.env.DATABASE_URL!);
  const q = (text: string, params: unknown[] = []) =>
    (sql as unknown as { query: (t: string, p: unknown[]) => Promise<Row[]> }).query(text, params);

  /* ── structured: typed selectors, no free text (the /references chip search) ── */
  if (req.query?.mode === "structured") {
    const list = (v: unknown) => (Array.isArray(v) ? v : String(v ?? "").split(",")).map((x) => String(x).trim()).filter(Boolean);
    const nuclides = list(req.query?.nuclides), reactions = list(req.query?.reactions);
    const zMin = req.query?.zMin ? Number(req.query.zMin) : null, zMax = req.query?.zMax ? Number(req.query.zMax) : null;
    const lim = Math.min(200, Math.max(1, Number(req.query?.limit ?? 50) || 50));
    if (!nuclides.length && !reactions.length && zMin == null && zMax == null) return res.status(200).json({ records: [], count: 0, mode: "structured" });
    const conds: string[] = []; const params: unknown[] = [];
    if (nuclides.length) { params.push(nuclides); conds.push(`n.nuclides && $${params.length}::text[]`); }
    if (reactions.length) { params.push(reactions); conds.push(`n.reactions && $${params.length}::text[]`); }
    if (zMin != null || zMax != null) {
      params.push(zMin ?? 0, zMax ?? 200);
      conds.push(`EXISTS (SELECT 1 FROM unnest(n.z_values) z WHERE z BETWEEN $${params.length - 1} AND $${params.length})`);
    }
    params.push(lim);
    const rows = await q(`SELECT ${SELECT}, 1.0::float AS similarity FROM nsr n WHERE ${conds.join(" AND ")} ORDER BY n.pub_year DESC NULLS LAST, n.citation_count DESC NULLS LAST LIMIT $${params.length}`, params);
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json({ records: rows, count: rows.length, mode: "structured" });
  }

  const raw = String(req.query?.q ?? "").trim();
  const mode = req.query?.mode === "keyword" ? "keyword" : "semantic";
  const limit = Math.min(200, Math.max(1, Number(req.query?.limit ?? 100) || 100));
  if (raw.length < 2) return res.status(200).json({ records: [], count: 0, mode });

  const t0 = Date.now();
  try {
    /* ── #KEY: key_number prefix in either mode ─────────────────────────── */
    if (raw.startsWith("#")) {
      const key = raw.slice(1).trim().toUpperCase().replace(/[%_]/g, "");
      if (!key) return res.status(200).json({ records: [], count: 0, mode });
      const rows = await q(`SELECT ${SELECT} FROM nsr n WHERE n.key_number LIKE $1 ORDER BY n.key_number LIMIT $2`, [key + "%", limit]);
      return res.status(200).json({ records: rows, count: rows.length, mode: "key", timings: { total_ms: Date.now() - t0 } });
    }

    /* ── semantic: fusion (RRF of dense + FTS) by default; &arm= forces one ─ */
    if (mode === "semantic") {
      const arm = req.query?.arm === "dense" || req.query?.arm === "fts" ? String(req.query.arm) : "fusion";
      const wantRerank = req.query?.rerank === "1" || (req.query?.rerank !== "0" && rerankEnabled());
      // Reranking on the CPU serve box costs ~0.13 s/candidate (measured: 10 → 1.4 s,
      // 50 → 6.6 s), so the reranked pool is capped at 20; the eval's 50-deep numbers
      // are the GPU/HF-endpoint ceiling, not what this box serves.
      const pool = Math.min(200, Math.max(limit, wantRerank ? Math.min(20, Math.max(limit, 10)) : limit));
      let encoder: EncoderName = activeEncoder();
      let provider = "";
      let tEmbed = 0;

      const dense = async (): Promise<Row[]> => {
        let vec: number[];
        try {
          const e = await embedQueryCached(sql as never, raw, encoder);
          vec = e.vector; provider = e.provider;
        } catch (err) {
          if (encoder === "bge") throw err;
          // our endpoint is cold/down → serve the stock space instead of failing
          encoder = "bge";
          const e = await embedQueryCached(sql as never, raw, "bge");
          vec = e.vector; provider = `${e.provider} (nsr fallback)`;
        }
        tEmbed = Date.now() - t0;
        // hnsw.ef_search caps the candidate list (default 40) — session-local
        // SET inside the same transaction as the scan; vector as a bound param
        // (a join-sourced vector defeats the index).
        const [, rows] = (await sql.transaction([
          sql.query(`SET LOCAL hnsw.ef_search = ${Math.max(40, pool + 20)}`),
          sql.query(
            `SELECT ${SELECT}, (1 - (e.embedding <=> $1::vector))::float AS similarity
             FROM ${vectorTable(encoder)} e JOIN nsr n USING (key_number)
             ORDER BY e.embedding <=> $1::vector
             LIMIT $2`,
            [toVectorLiteral(vec), pool],
          ),
        ])) as [unknown, Row[]];
        return rows;
      };
      const fts = (): Promise<Row[]> =>
        q(
          `SELECT ${SELECT}, least(ts_rank_cd(n.fts, websearch_to_tsquery('english', $1)) / 4.0, 0.99)::float AS similarity
           FROM nsr n JOIN nsr_embeddings e USING (key_number)
           WHERE n.fts @@ websearch_to_tsquery('english', $1)
           ORDER BY ts_rank_cd(n.fts, websearch_to_tsquery('english', $1)) DESC LIMIT $2`,
          [raw, pool],
        ).catch(() => [] as Row[]);

      let records: Row[];
      if (arm === "dense") records = await dense();
      else if (arm === "fts") records = await fts();
      else {
        const [d, f] = await Promise.all([dense(), fts()]);
        const byKey = new Map<string, Row>();
        for (const r of [...d, ...f]) byKey.set(String(r.key_number), r);
        const fused = rrf([d.map((r) => String(r.key_number)), f.map((r) => String(r.key_number))]);
        const max = Math.max(...fused.values());
        records = [...fused.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, pool)
          .map(([k, sc]) => ({ ...byKey.get(k)!, similarity: sc / max }));
      }

      let reranked = false;
      if (wantRerank && records.length > 1) {
        try {
          const texts = records.map((r) => `${r.title ?? ""}

${r.abstract ?? ""}`.trim());
          const scores = await rerank(raw, texts);
          const lo = Math.min(...scores), hi = Math.max(...scores);
          records = records
            .map((r, i) => ({ ...r, similarity: hi > lo ? (scores[i] - lo) / (hi - lo) : 1, rerank_score: scores[i] }))
            .sort((a, b) => Number(b.rerank_score) - Number(a.rerank_score));
          reranked = true;
        } catch {
          /* reranker down → serve the retrieval order */
        }
      }
      records = records.slice(0, limit);
      // Deterministic per (q, mode, arm, limit) for a month; let Vercel's edge serve repeats.
      res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
      return res.status(200).json({
        records,
        count: records.length,
        mode,
        timings: { embed_ms: tEmbed, total_ms: Date.now() - t0, provider, encoder, arm, reranked },
      });
    }

    /* ── keyword: FTS + typed nuclides ──────────────────────────────────── */
    const nuclides = extractNuclides(raw);
    const [fts, structured] = await Promise.all([
      q(
        `SELECT ${SELECT}, least(ts_rank_cd(n.fts, websearch_to_tsquery('english', $1)) / 4.0, 0.99)::float AS similarity
         FROM nsr n WHERE n.fts @@ websearch_to_tsquery('english', $1)
         ORDER BY n.pub_year DESC NULLS LAST, n.citation_count DESC NULLS LAST LIMIT $2`,
        [raw, limit],
      ).catch(() => [] as Row[]),
      nuclides.length
        ? q(
            `SELECT ${SELECT}, 1.0::float AS similarity FROM nsr n WHERE n.nuclides && $1::text[]
             ORDER BY n.pub_year DESC NULLS LAST, n.citation_count DESC NULLS LAST LIMIT $2`,
            [nuclides, limit],
          )
        : Promise.resolve([] as Row[]),
    ]);
    const seen = new Set<string>();
    const records = [...structured, ...fts].filter((r) => {
      const k = String(r.key_number);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, limit);
    return res.status(200).json({ records, count: records.length, mode, timings: { total_ms: Date.now() - t0 } });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
}
