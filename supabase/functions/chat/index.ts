import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from "npm:@aws-sdk/client-bedrock-runtime@3.1092.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT_BASE = `You are NSRgpt, an AI research assistant from the National Nuclear Data Center (NNDC) at Brookhaven National Laboratory.

INSTRUCTIONS:
- Always use the retrieved NSR records and Semantic Scholar papers below to inform your answer. Even when no record is an exact match, discuss what the retrieved records reveal about the topic — related isotopes, nearby nuclides, the same element, or similar reactions are all highly relevant.
- Cite NSR records by key number (e.g., 2024SM01). Reference specific findings from the records.
- Cite Semantic Scholar papers by title/author with their URL.
- Only say "no relevant records" if the retrieved list is truly empty or entirely unrelated to the question.
- Combine retrieved evidence with your general nuclear physics knowledge to give a thorough answer.
- Never fabricate key numbers, DOIs, or author names.`;

interface ChatRequest {
  messages: Array<{ role: string; content: string }>;
  /** Bedrock inference-profile id from the picker (src/lib/models.ts). */
  modelId?: string;
  userMessage: string;
  systemContext?: string;
}

interface NsrResult {
  key_number: string;
  title: string;
  authors: string | null;
  pub_year: number;
  doi: string | null;
  keywords: string | null;
  nuclides: string[] | null;
  reactions: string[] | null;
  similarity: number;
}

interface S2Paper {
  title: string;
  authors?: Array<{ name: string }>;
  year?: number;
  abstract?: string;
  citationCount?: number;
  url?: string;
  externalIds?: Record<string, string>;
}

function formatNsrContext(records: NsrResult[]): string {
  if (records.length === 0) return "\n## Retrieved NSR Records\nNo relevant records found.";

  const lines = records.map((r, i) => {
    const parts = [
      `[${i + 1}] ${r.key_number} — "${r.title}"`,
      `    Authors: ${r.authors ?? "N/A"} | Year: ${r.pub_year}${r.doi ? ` | DOI: ${r.doi}` : ""}`,
    ];
    if (r.nuclides && r.nuclides.length > 0) {
      parts.push(`    Nuclides: ${r.nuclides.join(", ")}`);
    }
    if (r.reactions && r.reactions.length > 0) {
      parts.push(`    Reactions: ${r.reactions.join(", ")}`);
    }
    if (r.keywords) {
      parts.push(`    Keywords: ${r.keywords.slice(0, 200)}`);
    }
    return parts.join("\n");
  });

  return `\n## Retrieved NSR Records\n${lines.join("\n\n")}`;
}

function formatS2Context(papers: S2Paper[]): string {
  if (papers.length === 0) return "";

  const lines = papers.map((p, i) => {
    const authorStr = p.authors?.map((a) => a.name).join(", ") ?? "Unknown";
    const parts = [
      `[S${i + 1}] "${p.title}" — ${authorStr} (${p.year ?? "N/A"}) | ${p.citationCount ?? 0} citations`,
    ];
    if (p.abstract) {
      parts.push(`     Abstract: ${p.abstract.slice(0, 200)}...`);
    }
    if (p.url) {
      parts.push(`     ${p.url}`);
    }
    return parts.join("\n");
  });

  return `\n\n## Related Papers (Semantic Scholar)\n${lines.join("\n\n")}`;
}

/** Extract nuclide mentions like "100Br", "208Pb", "6He" from text */
function extractNuclides(text: string): string[] {
  const patterns = [
    /\b(\d{1,3})([A-Z][a-z]?)\b/g,           // 100Br, 208Pb, 6He
    /\b([A-Z][a-z]?)-?(\d{1,3})\b/g,          // Br-100, Pb208
  ];
  const found = new Set<string>();
  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(text)) !== null) {
      // Normalize to "100Br" form
      const isNumFirst = /^\d/.test(m[1]);
      const mass = isNumFirst ? m[1] : m[2];
      const sym = isNumFirst ? m[2] : m[1];
      found.add(`${mass}${sym[0].toUpperCase()}${sym.slice(1).toLowerCase()}`);
    }
  }
  return [...found];
}

/** Extract reaction mentions like "(p,n)", "(d,p)" from text */
function extractReactions(text: string): string[] {
  const pat = /\(([a-zA-Z0-9',]+)\)/g;
  const found = new Set<string>();
  let m;
  while ((m = pat.exec(text)) !== null) {
    // Only keep if it looks like a nuclear reaction (has a comma)
    if (m[1].includes(",")) {
      found.add(`(${m[1]})`);
    }
  }
  return [...found];
}

/** Extract author name from queries like "papers by A Gilman" or "what did Smith publish" */
function extractAuthorQuery(text: string): string | null {
  const patterns = [
    /(?:papers?|publications?|work|research|articles?)\s+(?:by|from|of)\s+(.+?)(?:\?|$|\.|\bin\b|\bfrom\b|\babout\b)/i,
    /(?:by|from)\s+(?:author\s+)?(.+?)(?:\s+(?:are|is|in|on|about|from)\b|\?|$|\.)/i,
    /(?:what\s+(?:did|has|have))\s+(.+?)\s+(?:publish|write|author|research|study|contribute)/i,
    /(?:authored?\s+by|written\s+by)\s+(.+?)(?:\?|$|\.)/i,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m && m[1]) {
      const name = m[1].trim().replace(/[?.!,]+$/, "").trim();
      // Ignore if it looks like a nuclide or is too short
      if (name.length >= 3 && !/^\d+[A-Z][a-z]?$/.test(name)) {
        return name;
      }
    }
  }
  return null;
}

/** Fetch NSR records by author name via ilike */
async function fetchAuthorRecords(
  authorName: string | null,
  supabaseUrl: string,
  supabaseKey: string,
): Promise<NsrResult[]> {
  if (!authorName) return [];
  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data, error } = await supabase
    .from("nsr")
    .select("key_number, title, authors, pub_year, doi, keywords, nuclides, reactions")
    .ilike("authors", `%${authorName}%`)
    .order("pub_year", { ascending: false })
    .limit(8);

  if (error) {
    console.error("fetchAuthorRecords error:", error);
    return [];
  }
  return (data ?? []).map((r: any) => ({ ...r, similarity: 1.0 }));
}

/** Fetch NSR records matching nuclides and/or reactions via the search_nsr_structured RPC */
async function fetchStructuredRecords(
  nuclides: string[],
  reactions: string[],
  supabaseUrl: string,
  supabaseKey: string,
): Promise<NsrResult[]> {
  if (nuclides.length === 0 && reactions.length === 0) return [];
  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data, error } = await supabase.rpc("search_nsr_structured", {
    p_nuclides: nuclides.length > 0 ? nuclides : null,
    p_reactions: reactions.length > 0 ? reactions : null,
    p_limit: 10,
  });

  if (error) {
    console.error("search_nsr_structured error:", error);
    return [];
  }
  return (data ?? []).map((r: any) => ({ ...r, similarity: 1.0 }));
}

/** Merge structured + semantic results, deduplicating by key_number */
function mergeNsrResults(structured: NsrResult[], semantic: NsrResult[]): NsrResult[] {
  const seen = new Set<string>();
  const merged: NsrResult[] = [];
  // Structured matches first (exact nuclide hits)
  for (const r of structured) {
    if (!seen.has(r.key_number)) {
      seen.add(r.key_number);
      merged.push(r);
    }
  }
  // Then semantic matches
  for (const r of semantic) {
    if (!seen.has(r.key_number)) {
      seen.add(r.key_number);
      merged.push(r);
    }
  }
  return merged.slice(0, 12);
}

async function embedQuery(text: string, openaiKey: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text,
      dimensions: 256,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI embedding error: ${err}`);
  }

  const { data } = await res.json();
  return data[0].embedding;
}

async function fetchNsrRecords(
  queryEmbedding: number[],
  supabaseUrl: string,
  supabaseKey: string,
): Promise<NsrResult[]> {
  const supabase = createClient(supabaseUrl, supabaseKey);

  const { data, error } = await supabase.rpc("match_nsr_records", {
    query_embedding: queryEmbedding,
    match_threshold: 0.35,
    match_count: 8,
  });

  if (error) throw error;
  return (data ?? []) as NsrResult[];
}

async function fetchS2Papers(query: string, apiKey?: string): Promise<S2Paper[]> {
  try {
    const params = new URLSearchParams({
      query,
      limit: "5",
      fields: "title,authors,year,abstract,citationCount,url,externalIds",
    });

    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }

    const res = await fetch(
      `https://api.semanticscholar.org/graph/v1/paper/search?${params}`,
      { headers },
    );

    if (!res.ok) return [];

    const json = await res.json();
    return (json.data ?? []) as S2Paper[];
  } catch {
    // Semantic Scholar is best-effort; don't fail the whole request
    return [];
  }
}


/* ------------------------------------------------------------------------ */
/*  Bedrock                                                                   */
/* ------------------------------------------------------------------------ */
/*  Chat generation runs on AWS Bedrock. EMBEDDINGS DO NOT AND MUST NOT:
 *  embedQuery() above stays on OpenAI text-embedding-3-small, because the NSR
 *  corpus is stored as 256-dim vectors from that exact model. Vectors from a
 *  different model are a different coordinate space — swapping it would not
 *  error, it would silently return unrelated papers. Two separate calls, two
 *  separate providers, on purpose.
 *
 *  Auth is a BEARER TOKEN (an AWS console-issued Bedrock API key), not SigV4.
 *  That is what makes this viable inside a Deno edge function: no request
 *  signing, no IAM user, no credential chain. Same scheme Leuk uses.          */

const DEFAULT_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

function bedrockClient(): BedrockRuntimeClient {
  const apiKey = Deno.env.get("BEDROCK_API_KEY");
  const region = Deno.env.get("BEDROCK_REGION") ?? "us-east-1";
  if (!apiKey) throw new Error("BEDROCK_API_KEY not set");
  // The httpBearerAuth scheme is selected when a token identity is supplied.
  return new BedrockRuntimeClient({ region, token: { token: apiKey } });
}

/**
 * Bedrock's stream → OpenAI-shaped SSE.
 *
 * The browser already parses `data: {choices:[{delta:{content}}]}` and renders
 * markdown off it. Re-shaping here rather than in the client means the whole
 * provider swap is server-side and the UI never learns which vendor answered —
 * which is the point, given the picker now offers 27 models across 11 vendors.
 */
function bedrockToOpenAiSse(
  stream: AsyncIterable<Record<string, unknown>>,
  encoder: TextEncoder,
  controller: ReadableStreamDefaultController,
): Promise<void> {
  return (async () => {
    for await (const event of stream) {
      const delta = (event as {
        contentBlockDelta?: { delta?: { text?: string } };
      }).contentBlockDelta?.delta?.text;
      if (delta) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`,
          ),
        );
      }
    }
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
  })();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { messages, userMessage, systemContext, modelId } =
      (await req.json()) as ChatRequest;

    if (!userMessage || typeof userMessage !== "string") {
      return new Response(JSON.stringify({ error: "userMessage is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) throw new Error("OPENAI_API_KEY not set");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const s2Key = Deno.env.get("SEMANTIC_SCHOLAR_API_KEY");

    // 1. Extract structured entities from the query
    const nuclides = extractNuclides(userMessage);
    const reactions = extractReactions(userMessage);
    const authorQuery = extractAuthorQuery(userMessage);

    // 2. Embed the query, fetch S2 papers, and run the structured searches in
    //    parallel.
    //
    //    EMBEDDING IS ALLOWED TO FAIL. It is one retrieval signal among four,
    //    and it depends on a third-party account with a balance: when OpenAI
    //    credits ran out, a throw here 500'd the whole chat even though the
    //    nuclide, reaction and author searches — which are plain Postgres and
    //    always work — had already returned. Losing semantic recall degrades
    //    an answer; losing the answer entirely is a different failure. So it
    //    resolves to null and the request continues without it.
    const [queryEmbedding, s2Papers, structuredDbRecords, authorRecords] = await Promise.all([
      embedQuery(userMessage, openaiKey).catch((e) => {
        console.error("embedQuery failed; continuing without semantic recall:", e?.message ?? e);
        return null;
      }),
      fetchS2Papers(userMessage, s2Key),
      fetchStructuredRecords(nuclides, reactions, supabaseUrl, supabaseKey),
      fetchAuthorRecords(authorQuery, supabaseUrl, supabaseKey),
    ]);

    // 3. Semantic search + merge with structured results (author + nuclide/reaction first)
    const semanticRecords = queryEmbedding
      ? await fetchNsrRecords(queryEmbedding, supabaseUrl, supabaseKey).catch(() => [])
      : [];
    const structuredRecords = mergeNsrResults(authorRecords, structuredDbRecords);
    const nsrRecords = mergeNsrResults(structuredRecords, semanticRecords);

    // 4. Build grounded system prompt
    const groundingContext =
      formatNsrContext(nsrRecords) + formatS2Context(s2Papers);

    const degraded = queryEmbedding === null
      ? "\n\nNOTE: semantic retrieval is unavailable for this request, so the records below came from exact nuclide, reaction and author matching only. If they do not cover the question, say that the semantic index is temporarily unavailable rather than concluding the corpus has nothing."
      : "";

    const systemPrompt = systemContext
      ? `${SYSTEM_PROMPT_BASE}${degraded}\n\n${systemContext}\n${groundingContext}`
      : `${SYSTEM_PROMPT_BASE}${degraded}\n${groundingContext}`;

    // 5. Build the sources metadata
    const sources = {
      nsr: nsrRecords.map((r) => ({
        key_number: r.key_number,
        title: r.title,
        doi: r.doi,
        similarity: r.similarity,
      })),
      s2: s2Papers.map((p) => ({
        title: p.title,
        url: p.url ?? "",
        authors:
          p.authors?.map((a) => a.name).join(", ") ?? "Unknown",
        citations: p.citationCount ?? 0,
      })),
    };

    // 6. Build the Converse request.
    //
    // Bedrock separates the system prompt from the turns (its own `system`
    // field) rather than taking a system-role message, and every content is a
    // block array. It also rejects a leading assistant turn, so history is
    // trimmed from the first user message.
    // Bedrock is stricter than OpenAI about turn shape, in three ways that all
    // throw ValidationException rather than degrading: the first turn must be
    // `user`, roles must strictly alternate, and no content may be empty. A
    // history whose last send failed ends on a user turn, so appending the new
    // question would put two user turns back to back — hence the merge.
    const history = messages
      .slice(-10)
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content?.trim());
    const firstUser = history.findIndex((m) => m.role === "user");
    const turns: Array<{ role: "user" | "assistant"; content: Array<{ text: string }> }> = [];
    for (const m of [
      ...(firstUser === -1 ? [] : history.slice(firstUser)),
      { role: "user", content: userMessage },
    ]) {
      const role = m.role as "user" | "assistant";
      const prev = turns[turns.length - 1];
      if (prev && prev.role === role) prev.content.push({ text: m.content });
      else turns.push({ role, content: [{ text: m.content }] });
    }

    // 7. Call Bedrock with streaming.
    const chosenModel = typeof modelId === "string" && modelId.trim() ? modelId.trim() : DEFAULT_MODEL_ID;
    const bedrockRes = await bedrockClient().send(
      new ConverseStreamCommand({
        modelId: chosenModel,
        system: [{ text: systemPrompt }],
        messages: turns,
        inferenceConfig: { maxTokens: 2048 },
      }),
    );
    if (!bedrockRes.stream) throw new Error(`Bedrock returned no stream for ${chosenModel}`);

    // 8. Stream response back with sources prefix
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        // Emit sources event first
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ sources })}\n\n`),
        );

        // Bedrock's event stream → the OpenAI-shaped SSE the client parses.
        try {
          await bedrockToOpenAiSse(
            bedrockRes.stream as AsyncIterable<Record<string, unknown>>,
            encoder,
            controller,
          );
        } catch (e) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ error: e instanceof Error ? e.message : "stream failed" })}\n\n`,
            ),
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
