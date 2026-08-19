// /api/chat — the RAG chat route, on the real stack.
//
// Replaces the Supabase edge function (which died with "Not implemented:
// Http2Session.settings" — the AWS SDK no longer runs in that runtime).
// Vercel Node function: retrieval hits NEON (the full 303k corpus with
// tonight's abstracts), generation streams from AWS Bedrock, and the SSE
// shape is byte-compatible with what the client already parses.
//
// Retrieval lanes (parallel):
//   1. structured  — typed nuclide/reaction arrays (from NSR selectors)
//   2. author      — ILIKE on the flattened author string
//   3. full-text   — weighted tsvector over title/keywords/abstract (sql/19);
//                    replaces the dead 46k-row OpenAI-embedding lane with an
//                    indexed search over the ENTIRE corpus
//   4. Semantic Scholar API (best-effort)
//
// Env: DATABASE_URL, BEDROCK_API_KEY (bearer), BEDROCK_REGION,
//      SEMANTIC_SCHOLAR_API_KEY (optional).

import { neon } from "@neondatabase/serverless";
import { activeEncoder, embedQueryCached, hasEmbeddings, toVectorLiteral, vectorTable } from "./_lib/embed.js";
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";

export const config = { maxDuration: 120 };

const SYSTEM_PROMPT_BASE = `You are RxivGPT, an AI research assistant grounded in the complete bioRxiv and medRxiv preprint corpora operated by Cold Spring Harbor Laboratory.

INSTRUCTIONS:
- Always use the retrieved preprints below to inform your answer. Even when no record is an exact match, discuss what the retrieved preprints reveal about the topic — the same subject category, adjacent clinical or biological questions, and later versions of the same work are all highly relevant.
- These are PREPRINTS: most have not been peer reviewed. Say so when it matters. When a record shows a publishing journal it has since appeared in the peer-reviewed literature; when its status says withdrawn, never present its findings as standing.
- Cite NSR records by key number (e.g., 2024SM01). Cite arXiv/OA additions by their identifier. Reference specific findings, and use the abstracts provided.
- Cite Semantic Scholar papers by title/author with their URL.
- Only say "no relevant records" if the retrieved list is truly empty or entirely unrelated.
- Combine retrieved evidence with your general nuclear physics knowledge to give a thorough answer.
- Never fabricate key numbers, DOIs, or author names.`;

const DEFAULT_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

/* ── entity extraction (ported from the edge function) ─────────────────── */

// canonical NSR reaction codes are uppercase with G/A for γ/α
function extractAuthorQuery(text: string): string | null {
  const patterns = [
    /(?:papers?|publications?|work|research|articles?)\s+(?:by|from|of)\s+(.+?)(?:\?|$|\.|\bin\b|\bfrom\b|\babout\b)/i,
    /(?:what\s+(?:did|has|have))\s+(.+?)\s+(?:publish|write|author|research|study|contribute)/i,
    /(?:authored?\s+by|written\s+by)\s+(.+?)(?:\?|$|\.)/i,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m && m[1]) {
      const name = m[1].trim().replace(/[?.!,]+$/, "").trim();
      if (name.length >= 3 && !/^\d+[A-Z][a-z]?$/.test(name)) return name;
    }
  }
  return null;
}

/** Which subject categories does this question mention? Matched against the live
 *  `categories` dictionary (76 values across both servers) rather than a regex, so
 *  the vocabulary can never drift from what the corpus actually holds. */
let CATEGORY_CACHE: string[] | null = null;
async function extractCategories(sql: { query: (t: string, p: unknown[]) => Promise<{ category: string }[]> }, text: string): Promise<string[]> {
  try {
    if (!CATEGORY_CACHE) CATEGORY_CACHE = (await sql.query("SELECT category FROM categories", [])).map((r) => r.category);
    const t = text.toLowerCase();
    return CATEGORY_CACHE.filter((c) => c.length > 4 && t.includes(c)).slice(0, 3);
  } catch { return []; }
}

/* ── context building ──────────────────────────────────────────────────── */

interface Rec {
  key_number: string; title: string | null; authors: string | null;
  pub_year: number; doi: string | null; abstract: string | null;
  categories: string[] | null; status_tags: string[] | null;
  server: string | null; published_journal: string | null; similarity: number;
}

function formatNsrContext(records: Rec[]): string {
  if (records.length === 0) return "\n## Retrieved Records\nNo relevant records found.";
  const lines = records.map((r, i) => {
    const parts = [
      `[${i + 1}] ${r.key_number} (${r.server ?? "preprint"}) — "${r.title ?? "Untitled"}"`,
      `    Authors: ${r.authors ?? "N/A"} | Year: ${r.pub_year}${r.doi ? ` | DOI: ${r.doi}` : ""}${r.published_journal ? ` | published in ${r.published_journal}` : " | not yet published"}`,
    ];
    if (r.categories?.length) parts.push(`    Category: ${r.categories.join(", ")}`);
    if (r.status_tags?.length) parts.push(`    Status: ${r.status_tags.join(", ")}`);
    if (r.abstract) parts.push(`    Abstract: ${r.abstract.slice(0, 500)}`);
    return parts.join("\n");
  });
  return `\n## Retrieved Records\n${lines.join("\n\n")}`;
}

interface S2Paper {
  title: string; authors?: { name: string }[]; year?: number;
  abstract?: string; citationCount?: number; url?: string;
}

function formatS2Context(papers: S2Paper[]): string {
  if (papers.length === 0) return "";
  const lines = papers.map((p, i) => {
    const parts = [`[S${i + 1}] "${p.title}" — ${p.authors?.map((a) => a.name).join(", ") ?? "Unknown"} (${p.year ?? "N/A"}) | ${p.citationCount ?? 0} citations`];
    if (p.abstract) parts.push(`     Abstract: ${p.abstract.slice(0, 200)}...`);
    if (p.url) parts.push(`     ${p.url}`);
    return parts.join("\n");
  });
  return `\n\n## Related Papers (Semantic Scholar)\n${lines.join("\n\n")}`;
}

/* ── handler ───────────────────────────────────────────────────────────── */

const SELECT = `key_number, title, authors, pub_year, doi, abstract,
  categories, status_tags, server, published_journal`;

// Classic Vercel Node signature — the Web-handler form hung in production
// (the builder invoked (req, res) and ignored a returned Response).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method === "OPTIONS") return res.status(200).send("ok");
  if (req.method !== "POST") return res.status(405).send("POST only");

  try {
    const { messages = [], userMessage, systemContext, modelId } = req.body ?? {};
    if (!userMessage || typeof userMessage !== "string") {
      return res.status(400).json({ error: "userMessage is required" });
    }

    // Flush headers immediately: the client sees a live stream during
    // retrieval instead of 30s of dead air.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": retrieving\n\n");
    const t0 = Date.now();

    const sql = neon(process.env.DATABASE_URL!);
    const categories = await extractCategories(sql as never, userMessage);
    const authorQuery = extractAuthorQuery(userMessage);

    const q = (text: string, params: unknown[]) => (sql as unknown as { query: (t: string, p: unknown[]) => Promise<Rec[]> }).query(text, params);

    const structuredP: Promise<Rec[]> = categories.length
      ? q(
          `SELECT ${SELECT}, 1.0 AS similarity FROM preprints
           WHERE categories && $1::text[]
           ORDER BY pub_year DESC, posted_date DESC LIMIT 10`,
          [categories],
        )
      : Promise.resolve([]);
    const authorP: Promise<Rec[]> = authorQuery
      ? q(
          `SELECT ${SELECT}, 1.0 AS similarity FROM preprints
           WHERE authors ILIKE $1 ORDER BY pub_year DESC LIMIT 8`,
          ["%" + authorQuery + "%"],
        )
      : Promise.resolve([]);
    const ftsFor = (query: string) =>
      q(
        `SELECT ${SELECT},
                least(ts_rank_cd(fts, websearch_to_tsquery('english', $1)) / 4.0, 0.99)::float AS similarity
         FROM preprints
         WHERE fts @@ websearch_to_tsquery('english', $1)
         ORDER BY ts_rank_cd(fts, websearch_to_tsquery('english', $1)) DESC
         LIMIT 8`,
        [query],
      );
    // websearch ANDs every term, which is too strict for conversational
    // queries — when the strict pass finds nothing, retry with terms OR'ed.
    const ftsP: Promise<Rec[]> = ftsFor(userMessage)
      .then((rows) =>
        rows.length > 0
          ? rows
          : ftsFor(userMessage.split(/\s+/).filter((w) => w.length > 2).slice(0, 12).join(" or ")),
      )
      .catch(() => []);

    // Dense arm — kNN over preprint_embeddings (bge-m3, 1024-d, cosine).
    //
    // Self-enabling: hasEmbeddings() is a cheap probe cached 60 s per process, so this
    // arm switches on by itself as vectors land and switches off if the sidecar is
    // absent or empty — no deploy, no flag. Any failure degrades to FTS-only and never
    // errors, which is the same contract /api/search advertises.
    //
    // Two details that are not stylistic:
    //   1. The probe vector is a BOUND $1::vector parameter. A *correlated* reference
    //      (one that varies per row) defeats the HNSW index and turns this into an
    //      exact scan over 433k vectors.
    //   2. SET LOCAL hnsw.ef_search must share a transaction with the scan, or it is
    //      set on one pooled connection and the scan runs on another with the default.
    //
    // Query side must match the corpus side: stock bge-m3 via the free Cloudflare path
    // (SEARCH_ENCODER=bge), so /chat has no dependency on a serve box.
    const denseP: Promise<Rec[]> = (async () => {
      try {
        if (!(await hasEmbeddings(sql as never))) return [];
        // Encoder selection with a fallback that matters once SEARCH_ENCODER=nsr: the
        // fine-tuned arm depends on a single serve box, and if it is cold, throttled or
        // gone we fall back to stock bge-m3 (free Cloudflare, always up) rather than
        // dropping the dense arm entirely. Box down should cost retrieval QUALITY, not
        // the whole hybrid. The vector table follows the encoder that actually answered,
        // because querying one model's space with another model's vector returns
        // confident nonsense.
        let enc = activeEncoder();
        let vector: number[];
        try {
          ({ vector } = await embedQueryCached(sql as never, userMessage, enc));
        } catch (err) {
          if (enc === "bge") throw err;
          enc = "bge";
          ({ vector } = await embedQueryCached(sql as never, userMessage, "bge"));
        }
        const [, rows] = (await sql.transaction([
          sql.query(`SET LOCAL hnsw.ef_search = 60`),
          sql.query(
            `SELECT ${SELECT}, (1 - (e.embedding <=> $1::vector))::float AS similarity
             FROM ${vectorTable(enc)} e
             JOIN preprints USING (key_number)
             ORDER BY e.embedding <=> $1::vector
             LIMIT 8`,
            [toVectorLiteral(vector)],
          ),
        ])) as [unknown, Rec[]];
        return rows;
      } catch { return []; }
    })();

    const [structured, authorRecs, ftsRecs, denseRecs, s2Papers] = await Promise.all([
      structuredP,
      authorP,
      ftsP,
      denseP,
      (async (): Promise<S2Paper[]> => {
        try {
          const headers: Record<string, string> = {};
          if (process.env.SEMANTIC_SCHOLAR_API_KEY) headers["x-api-key"] = process.env.SEMANTIC_SCHOLAR_API_KEY;
          const res = await fetch(
            `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(userMessage)}&limit=5&fields=title,authors,year,abstract,citationCount,url`,
            { headers, signal: AbortSignal.timeout(3000) },
          );
          if (!res.ok) return [];
          return (await res.json()).data ?? [];
        } catch { return []; }
      })(),
    ]);

    // merge, structured first, dedupe by key_number
    const seen = new Set<string>();
    const records: Rec[] = [];
    // interleave dense and FTS by rank (never merge raw scores across arms)
    const interleaved: Rec[] = [];
    for (let i = 0; i < Math.max(denseRecs.length, ftsRecs.length); i++) {
      if (denseRecs[i]) interleaved.push(denseRecs[i]);
      if (ftsRecs[i]) interleaved.push(ftsRecs[i]);
    }
    for (const r of [...structured, ...authorRecs, ...interleaved]) {
      if (!seen.has(r.key_number)) { seen.add(r.key_number); records.push(r); }
      if (records.length >= 14) break;
    }

    const systemPrompt =
      `${SYSTEM_PROMPT_BASE}${systemContext ? `\n\n${systemContext}` : ""}\n` +
      formatNsrContext(records) + formatS2Context(s2Papers);

    const sources = {
      nsr: records.map((r) => ({ key_number: r.key_number, title: r.title, doi: r.doi, similarity: r.similarity })),
      s2: s2Papers.map((p) => ({
        title: p.title, url: p.url ?? "",
        authors: p.authors?.map((a) => a.name).join(", ") ?? "Unknown",
        citations: p.citationCount ?? 0,
      })),
    };

    // Bedrock turn shape: first turn must be user, roles alternate, no empties
    const history = (messages as { role: string; content: string }[])
      .slice(-10)
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content?.trim());
    const firstUser = history.findIndex((m) => m.role === "user");
    const turns: { role: "user" | "assistant"; content: { text: string }[] }[] = [];
    for (const m of [...(firstUser === -1 ? [] : history.slice(firstUser)), { role: "user", content: userMessage }]) {
      const role = m.role as "user" | "assistant";
      const prev = turns[turns.length - 1];
      if (prev && prev.role === role) prev.content.push({ text: m.content });
      else turns.push({ role, content: [{ text: m.content }] });
    }

    // Bedrock API keys authenticate via AWS_BEARER_TOKEN_BEDROCK — the
    // inline token config is silently ignored by the SDK's auth resolution.
    if (!process.env.AWS_BEARER_TOKEN_BEDROCK && process.env.BEDROCK_API_KEY) {
      process.env.AWS_BEARER_TOKEN_BEDROCK = process.env.BEDROCK_API_KEY;
    }
    const client = new BedrockRuntimeClient({
      region: process.env.BEDROCK_REGION ?? "us-east-1",
    });
    const chosenModel = typeof modelId === "string" && modelId.trim() ? modelId.trim() : DEFAULT_MODEL_ID;
    const bedrockRes = await client.send(
      new ConverseStreamCommand({
        modelId: chosenModel,
        system: [{ text: systemPrompt }],
        messages: turns,
        inferenceConfig: { maxTokens: 2048 },
      }),
    );
    if (!bedrockRes.stream) throw new Error(`Bedrock returned no stream for ${chosenModel}`);

    console.log(`chat retrieval+bedrock-start: ${Date.now() - t0}ms, records=${records.length}`);
    res.write(`data: ${JSON.stringify({ sources })}\n\n`);
    try {
      for await (const event of bedrockRes.stream as AsyncIterable<Record<string, unknown>>) {
        const delta = (event as { contentBlockDelta?: { delta?: { text?: string } } })
          .contentBlockDelta?.delta?.text;
        if (delta) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`);
        }
      }
      res.write("data: [DONE]\n\n");
    } catch (e) {
      res.write(`data: ${JSON.stringify({ error: e instanceof Error ? e.message : "stream failed" })}\n\n`);
    }
    res.end();
  } catch (err) {
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: (err as Error).message })}\n\n`);
      return res.end();
    }
    return res.status(500).json({ error: (err as Error).message });
  }
}
