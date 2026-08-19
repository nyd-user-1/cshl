// /api/graph — entity search + neighborhood expansion for the workspace canvas.
//
// The canvas expands arbitrary entities on demand (author → papers → nuclides
// → …), which static per-mass JSON cannot serve. Every edge returned here is a
// record from the join tables — nothing inferred.
//
//   ?op=search&q=…                          → typed entity matches
//   ?op=node&type=paper&id=2024BA01        → node detail + neighbor counts + provenance
//   ?op=expand&type=author&id=123&rel=papers&offset=0 → one page of neighbors
//   ?op=similar&id=2024BA01                → 6 nearest papers in bge-m3 space (inference)
//
// Entity ids: paper=key_number · author=author_key · nuclide=nuclide_code
// ('137CS') · reaction=reaction_code ('(N,G)') · exfor=exfor_id.

import { neon } from "@neondatabase/serverless";
import { activeEncoder, vectorTable } from "./_lib/embed.js";

export const config = { maxDuration: 30 };

const LIMIT = 8;

type Row = Record<string, unknown>;

const paperNode = (r: Row) => ({
  type: "paper",
  id: r.key_number,
  label: r.key_number,
  title: r.title,
  sub: `${r.pub_year}${r.citation_count ? ` · ${Number(r.citation_count).toLocaleString()} cites` : ""}`,
  meta: { doi: r.doi, year: r.pub_year, cites: r.citation_count, pdf: !!r.pdf_url, nsr: r.is_nsr },
});

const PAPER_COLS = `key_number, title, pub_year, doi, citation_count, pdf_url, is_nsr`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const sql = neon(process.env.DATABASE_URL!);
  const q = (text: string, params: unknown[] = []) =>
    (sql as unknown as { query: (t: string, p: unknown[]) => Promise<Row[]> }).query(text, params);

  const { op, type, id, rel } = req.query ?? {};
  const offset = Math.max(0, Number(req.query?.offset ?? 0));

  try {
    /* ── search ──────────────────────────────────────────────────────────── */
    if (op === "search") {
      const term = String(req.query?.q ?? "").trim();
      if (term.length < 2) return res.status(200).json({ results: [] });
      const like = term.replace(/[%_]/g, "") + "%";
      const [nuclides, authors, papersByKey, papersByText, reactions] = await Promise.all([
        q(`SELECT nuclide_code, z, n, a, element FROM nuclide_dict WHERE nuclide_code ILIKE $1 ORDER BY a, z LIMIT 6`, [like]),
        q(`SELECT a.author_key, a.initial1, a.initial2, a.last_name, count(na.key_number) AS papers
           FROM authors a LEFT JOIN nsr_authors na ON na.author_key = a.author_key
           WHERE a.last_name ILIKE $1 GROUP BY 1,2,3,4 ORDER BY papers DESC LIMIT 6`, [like]),
        q(`SELECT ${PAPER_COLS} FROM nsr WHERE key_number LIKE $1 LIMIT 4`, [like.toUpperCase()]),
        // ts_rank_cd detoasts the tsvector of EVERY match — seconds on cold cache
        // for a broad term. Citation order reads none of that and ranks better here.
        q(`SELECT ${PAPER_COLS} FROM nsr WHERE fts @@ websearch_to_tsquery('english', $1)
           ORDER BY citation_count DESC NULLS LAST LIMIT 4`, [term]).catch(() => []),
        q(`SELECT reaction_code FROM reaction_dict WHERE reaction_code ILIKE $1 ORDER BY reaction_code LIMIT 6`, ["(" + like]),
      ]);
      const seen = new Set<string>();
      const papers = [...papersByKey, ...papersByText].filter((p) => {
        const k = String(p.key_number);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      return res.status(200).json({
        results: [
          ...nuclides.map((r) => ({ type: "nuclide", id: r.nuclide_code, label: `${r.a}${String(r.element ?? "").charAt(0)}${String(r.element ?? "").slice(1).toLowerCase()}`.replace(/^(\d+)(.)/, "$1$2"), sub: `Z=${r.z} N=${r.n}`, code: r.nuclide_code })),
          ...authors.map((r) => ({ type: "author", id: String(r.author_key), label: `${r.initial1 ?? ""}${r.initial2 ? "." + r.initial2 : ""}.${r.last_name}`, sub: `${r.papers} papers` })),
          ...papers.map(paperNode),
          ...reactions.map((r) => ({ type: "reaction", id: r.reaction_code, label: r.reaction_code, sub: "reaction" })),
        ],
      });
    }

    /* ── card rows: the inside of paper nodes, batched ───────────────────── */
    // One round trip returns each paper's first authors/nuclides/reactions
    // plus true totals, so canvas cards can show structure without expanding.
    if (op === "cards") {
      const ids = String(req.query?.ids ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 24);
      if (!ids.length) return res.status(200).json({ cards: {} });
      const [authors, nuclides, reactions] = await Promise.all([
        q(`SELECT * FROM (
             SELECT na.key_number, a.author_key::text AS id,
                    concat_ws('', a.initial1, '.', CASE WHEN coalesce(a.initial2,'') <> '' THEN a.initial2 || '.' END, a.last_name) AS label,
                    count(*) OVER (PARTITION BY na.key_number) AS total,
                    row_number() OVER (PARTITION BY na.key_number ORDER BY na.order_index NULLS LAST, a.author_key) AS rn
             FROM nsr_authors na JOIN authors a USING (author_key)
             WHERE na.key_number = ANY($1)) x WHERE rn <= 4`, [ids]),
        q(`SELECT * FROM (
             SELECT nn.key_number,
                    (nn.a::text || upper(coalesce(nn.element_symbol,''))) AS id,
                    (nn.a::text || initcap(lower(coalesce(nn.element_symbol,'')))) AS label,
                    count(*) OVER (PARTITION BY nn.key_number) AS total,
                    row_number() OVER (PARTITION BY nn.key_number ORDER BY min_sel NULLS LAST, nn.a) AS rn
             FROM (SELECT key_number, z, a, element_symbol, min(selector_index) AS min_sel
                   FROM nsr_nuclides WHERE key_number = ANY($1) AND a IS NOT NULL
                   GROUP BY 1,2,3,4) nn) x WHERE rn <= 4`, [ids]),
        q(`SELECT * FROM (
             SELECT nr.key_number, nr.reaction_code AS id, nr.reaction_code AS label,
                    count(*) OVER (PARTITION BY nr.key_number) AS total,
                    row_number() OVER (PARTITION BY nr.key_number ORDER BY min_sel NULLS LAST, nr.reaction_code) AS rn
             FROM (SELECT key_number, reaction_code, min(selector_index) AS min_sel
                   FROM nsr_reactions WHERE key_number = ANY($1) AND reaction_code IS NOT NULL
                   GROUP BY 1,2) nr) x WHERE rn <= 4`, [ids]),
      ]);
      const cards: Record<string, Record<string, { items: { id: unknown; label: unknown }[]; total: number }>> = {};
      const put = (rows: Row[], group: string) => {
        for (const r of rows) {
          const k = String(r.key_number);
          cards[k] ??= {};
          cards[k][group] ??= { items: [], total: Number(r.total) };
          cards[k][group].items.push({ id: r.id, label: r.label });
        }
      };
      put(authors, "authors"); put(nuclides, "nuclides"); put(reactions, "reactions");
      return res.status(200).json({ cards });
    }

    /* ── node detail + counts + provenance ───────────────────────────────── */
    if (op === "node") {
      if (type === "paper") {
        const [rows, counts] = await Promise.all([
          q(`SELECT key_number, title, authors, pub_year, doi, reference, abstract, citation_count,
                    pdf_url, pdf_stored, is_nsr, entry_date, s2_looked_up_at, s2_lookup_status,
                    openalex_id, arxiv_id, oa_status, created_at, raw->>'source' AS ingest_source
             FROM nsr WHERE key_number = $1`, [id]),
          q(`SELECT
               (SELECT count(*) FROM nsr_authors WHERE key_number = $1) AS authors,
               (SELECT count(*) FROM nsr_nuclides WHERE key_number = $1) AS nuclides,
               (SELECT count(*) FROM nsr_reactions WHERE key_number = $1) AS reactions,
               (SELECT count(*) FROM nsr_exfor WHERE key_number = $1) AS exfor`, [id]),
        ]);
        if (!rows[0]) return res.status(404).json({ error: "not found" });
        return res.status(200).json({ node: rows[0], counts: counts[0] });
      }
      if (type === "author") {
        const [a, c] = await Promise.all([
          q(`SELECT author_key, initial1, initial2, last_name FROM authors WHERE author_key = $1`, [id]),
          q(`SELECT count(*) AS papers FROM nsr_authors WHERE author_key = $1`, [id]),
        ]);
        if (!a[0]) return res.status(404).json({ error: "not found" });
        return res.status(200).json({ node: a[0], counts: { papers: c[0]?.papers ?? 0 } });
      }
      if (type === "nuclide") {
        const [d, c] = await Promise.all([
          q(`SELECT nuclide_code, z, n, a, element FROM nuclide_dict WHERE nuclide_code = $1`, [id]),
          q(`SELECT count(DISTINCT j.key_number) AS papers FROM nsr_nuclides j
             JOIN nuclide_dict d ON d.z = j.z AND d.a = j.a WHERE d.nuclide_code = $1`, [id]),
        ]);
        if (!d[0]) return res.status(404).json({ error: "not found" });
        return res.status(200).json({ node: d[0], counts: { papers: c[0]?.papers ?? 0 } });
      }
      if (type === "reaction") {
        const [d, c] = await Promise.all([
          q(`SELECT reaction_code, incident_particle, outgoing_particles, is_fission, delta_z, delta_n, delta_a
             FROM reaction_dict WHERE reaction_code = $1`, [id]),
          q(`SELECT count(DISTINCT key_number) AS papers FROM nsr_reactions WHERE reaction_code = $1`, [id]),
        ]);
        return res.status(200).json({ node: d[0] ?? { reaction_code: id }, counts: { papers: c[0]?.papers ?? 0 } });
      }
      if (type === "exfor") {
        const [d, c] = await Promise.all([
          q(`SELECT exfor_id, title, year, authors, reactions, num_subentries FROM exfor_entries WHERE exfor_id = $1`, [id]),
          q(`SELECT count(*) AS papers FROM nsr_exfor WHERE exfor_id = $1`, [id]),
        ]);
        if (!d[0]) return res.status(404).json({ error: "not found" });
        return res.status(200).json({ node: d[0], counts: { papers: c[0]?.papers ?? 0 } });
      }
      return res.status(400).json({ error: "unknown type" });
    }

    /* ── expand: one page of neighbors ───────────────────────────────────── */
    if (op === "expand") {
      let rows: Row[] = [];
      let total = 0;
      const key = `${type}:${rel}`;
      if (key === "author:papers") {
        [rows, total] = await Promise.all([
          q(`SELECT ${PAPER_COLS} FROM nsr n JOIN nsr_authors j USING (key_number)
             WHERE j.author_key = $1
             ORDER BY n.citation_count DESC NULLS LAST, n.pub_year DESC LIMIT ${LIMIT} OFFSET $2`, [id, offset]),
          q(`SELECT count(*) AS c FROM nsr_authors WHERE author_key = $1`, [id]),
        ]).then(([r, c]) => [r, Number(c[0]?.c ?? 0)] as [Row[], number]);
        return res.status(200).json({ total, nodes: rows.map(paperNode) });
      }
      if (key === "paper:authors") {
        rows = await q(
          `SELECT a.author_key, a.initial1, a.initial2, a.last_name, j.order_index
           FROM nsr_authors j JOIN authors a USING (author_key)
           WHERE j.key_number = $1 ORDER BY j.order_index LIMIT ${LIMIT} OFFSET $2`, [id, offset]);
        const c = await q(`SELECT count(*) AS c FROM nsr_authors WHERE key_number = $1`, [id]);
        return res.status(200).json({
          total: Number(c[0]?.c ?? 0),
          nodes: rows.map((r) => ({ type: "author", id: String(r.author_key), label: `${r.initial1 ?? ""}${r.initial2 ? "." + r.initial2 : ""}.${r.last_name}`, sub: "author" })),
        });
      }
      if (key === "paper:nuclides") {
        rows = await q(
          `SELECT DISTINCT j.z, j.a, j.element_symbol, j.sub_type FROM nsr_nuclides j
           WHERE j.key_number = $1 ORDER BY j.z, j.a LIMIT ${LIMIT} OFFSET $2`, [id, offset]);
        const c = await q(`SELECT count(DISTINCT (z, a)) AS c FROM nsr_nuclides WHERE key_number = $1`, [id]);
        return res.status(200).json({
          total: Number(c[0]?.c ?? 0),
          nodes: rows.map((r) => ({ type: "nuclide", id: `${r.a}${String(r.element_symbol ?? "").toUpperCase()}`, label: `${r.a}${r.element_symbol}`, sub: `Z=${r.z}${r.sub_type ? " · " + String(r.sub_type).toLowerCase() : ""}` })),
        });
      }
      if (key === "paper:reactions") {
        rows = await q(
          `SELECT DISTINCT reaction_code FROM nsr_reactions WHERE key_number = $1
           ORDER BY reaction_code LIMIT ${LIMIT} OFFSET $2`, [id, offset]);
        const c = await q(`SELECT count(DISTINCT reaction_code) AS c FROM nsr_reactions WHERE key_number = $1`, [id]);
        return res.status(200).json({
          total: Number(c[0]?.c ?? 0),
          nodes: rows.map((r) => ({ type: "reaction", id: r.reaction_code, label: r.reaction_code, sub: "reaction" })),
        });
      }
      if (key === "paper:exfor") {
        rows = await q(
          `SELECT e.exfor_id, e.title, e.year FROM nsr_exfor j JOIN exfor_entries e USING (exfor_id)
           WHERE j.key_number = $1 ORDER BY e.year DESC NULLS LAST LIMIT ${LIMIT} OFFSET $2`, [id, offset]);
        const c = await q(`SELECT count(*) AS c FROM nsr_exfor WHERE key_number = $1`, [id]);
        return res.status(200).json({
          total: Number(c[0]?.c ?? 0),
          nodes: rows.map((r) => ({ type: "exfor", id: r.exfor_id, label: String(r.exfor_id), sub: `EXFOR${r.year ? " · " + r.year : ""}`, title: r.title })),
        });
      }
      if (key === "nuclide:papers") {
        const d = await q(`SELECT z, a FROM nuclide_dict WHERE nuclide_code = $1`, [id]);
        if (!d[0]) return res.status(404).json({ error: "unknown nuclide" });
        rows = await q(
          `SELECT ${PAPER_COLS} FROM nsr n
           WHERE n.key_number IN (SELECT key_number FROM nsr_nuclides WHERE z = $1 AND a = $2)
           ORDER BY n.citation_count DESC NULLS LAST, n.pub_year DESC LIMIT ${LIMIT} OFFSET $3`,
          [d[0].z, d[0].a, offset]);
        const c = await q(`SELECT count(DISTINCT key_number) AS c FROM nsr_nuclides WHERE z = $1 AND a = $2`, [d[0].z, d[0].a]);
        return res.status(200).json({ total: Number(c[0]?.c ?? 0), nodes: rows.map(paperNode) });
      }
      if (key === "reaction:papers") {
        rows = await q(
          `SELECT ${PAPER_COLS} FROM nsr n
           WHERE n.key_number IN (SELECT key_number FROM nsr_reactions WHERE reaction_code = $1)
           ORDER BY n.citation_count DESC NULLS LAST, n.pub_year DESC LIMIT ${LIMIT} OFFSET $2`, [id, offset]);
        const c = await q(`SELECT count(DISTINCT key_number) AS c FROM nsr_reactions WHERE reaction_code = $1`, [id]);
        return res.status(200).json({ total: Number(c[0]?.c ?? 0), nodes: rows.map(paperNode) });
      }
      if (key === "exfor:papers") {
        rows = await q(
          `SELECT ${PAPER_COLS} FROM nsr n JOIN nsr_exfor j USING (key_number)
           WHERE j.exfor_id = $1 ORDER BY n.pub_year DESC LIMIT ${LIMIT} OFFSET $2`, [id, offset]);
        const c = await q(`SELECT count(*) AS c FROM nsr_exfor WHERE exfor_id = $1`, [id]);
        return res.status(200).json({ total: Number(c[0]?.c ?? 0), nodes: rows.map(paperNode) });
      }
      return res.status(400).json({ error: `unknown expansion ${key}` });
    }

    /* ── similar: kNN over the bge-m3 embedding space ─────────────────────── */
    // An INFERENCE, not a record — the client draws these dashed and says so.
    // Two steps on purpose: HNSW is only used when the query vector is a
    // constant, so fetch the anchor's vector first, then order by distance.
    // k ≤ 8 keeps us under hnsw.ef_search (default 40); going higher needs
    // SET LOCAL ef_search inside a transaction. Rows without a vector (the
    // <20-char exclusions) return an empty set, not an error.
    // Vector space follows SEARCH_ENCODER: stock bge-m3 (nsr_embeddings) or
    // our NSR-CPT encoder (nsr_embeddings_nsr) — same shape either way.
    if (op === "similar") {
      const k = Math.min(8, Math.max(1, Number(req.query?.k ?? 6) || 6));
      const table = vectorTable(activeEncoder());
      const model = table === "nsr_embeddings" ? "bge-m3" : "nsr-encoder-bge-m3";
      const anchor = await q(`SELECT embedding::text AS v FROM ${table} WHERE key_number = $1`, [id]);
      if (!anchor[0]) return res.status(200).json({ model, nodes: [], reason: "no embedding for this paper" });
      const rows = await q(
        `SELECT ${PAPER_COLS.split(", ").map((c) => "n." + c).join(", ")}, k.cos
         FROM (SELECT key_number, 1 - (embedding <=> $1::vector) AS cos
               FROM ${table} ORDER BY embedding <=> $1::vector LIMIT $3) k
         JOIN nsr n USING (key_number)
         WHERE k.key_number <> $2
         ORDER BY k.cos DESC LIMIT $4`, [anchor[0].v, id, k + 1, k]);
      return res.status(200).json({
        model,
        nodes: rows.map((r) => ({ ...paperNode(r), cos: Number(r.cos) })),
      });
    }

    return res.status(400).json({ error: "unknown op" });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
}
