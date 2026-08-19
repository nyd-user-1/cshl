// Query-side encoder + reranker clients for NSR retrieval.
//
// The corpus vectors are permanent (scripts/embed-nsr → nsr_embeddings, stock
// bge-m3; LANE-TRAIN → nsr_embeddings_nsr, our fine-tuned encoder). Every
// search still has to encode the user's text in the SAME model as the table it
// searches, so:
//
//   SEARCH_ENCODER=bge (default)  Cloudflare Workers AI @cf/baai/bge-m3 — free
//        tier 10k neurons/day (~450k queries/day), hard-fails rather than bills.
//        Parity vs stored TEI vectors cos ≥ 0.996, identical top-10 (2026-08-16).
//        Fallback: HF hf-inference BAAI/bge-m3 (cos 0.99999) when HF_TOKEN set.
//   SEARCH_ENCODER=nsr            NYSgpt/nsr-encoder-bge-m3 served by TEI —
//        either our nsr-serve box (scripts/serve-nsr) or a HF Inference
//        Endpoint: NSR_ENCODER_URL (the /embed URL) + NSR_SERVE_KEY (bearer;
//        falls back to HF_TOKEN). Searches nsr_embeddings_nsr. If the endpoint
//        errors, callers fall back to bge.
//
//   SEARCH_RERANK=on              NYSgpt/nsr-reranker-gte-modernbert by TEI:
//        NSR_RERANKER_URL (base URL; /rerank is appended) + NSR_SERVE_KEY.
//
// Kill-switch = flip the env var and redeploy; the bge path never goes away.

export type EncoderName = "bge" | "nsr";

const CF_MODEL = "@cf/baai/bge-m3";
const HF_BGE_URL = "https://router.huggingface.co/hf-inference/models/BAAI/bge-m3/pipeline/feature-extraction";

export function activeEncoder(): EncoderName {
  return process.env.SEARCH_ENCODER === "nsr" && process.env.NSR_ENCODER_URL ? "nsr" : "bge";
}
export const vectorTable = (enc: EncoderName) => (enc === "nsr" ? "nsr_embeddings_nsr" : "nsr_embeddings");
const serveKey = () => process.env.NSR_SERVE_KEY ?? process.env.HF_TOKEN ?? "";
export const rerankEnabled = () => process.env.SEARCH_RERANK === "on" && !!process.env.NSR_RERANKER_URL && !!serveKey();

async function cloudflare(text: string): Promise<number[]> {
  const { CF_ACCOUNT_ID, CF_AI_TOKEN } = process.env;
  if (!CF_ACCOUNT_ID || !CF_AI_TOKEN) throw new Error("CF_ACCOUNT_ID / CF_AI_TOKEN not set");
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${CF_MODEL}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CF_AI_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: [text] }),
  });
  const j = (await r.json()) as { success: boolean; errors?: unknown; result?: { data?: number[][] } };
  const v = j.result?.data?.[0];
  if (!r.ok || !j.success || !v) throw new Error(`cloudflare embed failed: ${r.status} ${JSON.stringify(j.errors ?? "")}`);
  return v;
}

/** TEI-style endpoint (nsr-serve, HF Inference Endpoints and hf-inference all accept {inputs}). */
async function tei(url: string, text: string, key: string): Promise<number[]> {
  if (!key) throw new Error("no bearer key for embed endpoint");
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: text, normalize: true, truncate: true }),
  });
  if (!r.ok) throw new Error(`embed endpoint failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as number[] | number[][];
  const v = Array.isArray(j[0]) ? (j as number[][])[0] : (j as number[]);
  if (!Array.isArray(v) || v.length !== 1024) throw new Error("embed endpoint: unexpected shape");
  return v;
}

/** 1024-d unit vector for a query, in the requested model's space. */
export async function embedQuery(
  text: string,
  encoder: EncoderName = activeEncoder(),
): Promise<{ vector: number[]; provider: string; encoder: EncoderName }> {
  const input = text.trim().slice(0, 2000);
  if (encoder === "nsr") {
    return { vector: await tei(process.env.NSR_ENCODER_URL!, input, serveKey()), provider: "nsr-serve", encoder: "nsr" };
  }
  try {
    return { vector: await cloudflare(input), provider: "cloudflare", encoder: "bge" };
  } catch (err) {
    if (!process.env.HF_TOKEN) throw err;
    return { vector: await tei(HF_BGE_URL, input, process.env.HF_TOKEN!), provider: "hf", encoder: "bge" };
  }
}

/** pgvector literal form — pass as a bound parameter, never interpolate. */
export const toVectorLiteral = (v: number[]) => `[${v.join(",")}]`;

/** Cross-encoder rerank via TEI /rerank. Returns scores aligned to `texts`. */
export async function rerank(query: string, texts: string[]): Promise<number[]> {
  const url = process.env.NSR_RERANKER_URL!.replace(/\/$/, "");
  const r = await fetch(`${url}/rerank`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serveKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: query.slice(0, 600), texts: texts.map((t) => t.slice(0, 900)), truncate: true }),
  });
  if (!r.ok) throw new Error(`rerank endpoint failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { index: number; score: number }[];
  const out = new Array<number>(texts.length).fill(-Infinity);
  for (const { index, score } of j) out[index] = score;
  return out;
}

/** Reciprocal-rank fusion (k=60) over ranked lists of keys. */
export function rrf(lists: string[][], k = 60): Map<string, number> {
  const s = new Map<string, number>();
  for (const list of lists) list.forEach((key, i) => s.set(key, (s.get(key) ?? 0) + 1 / (k + i + 1)));
  return s;
}

/**
 * Memoized query embedding: a Neon table keyed by md5(encoder:text) so a
 * repeated question costs one indexed lookup (~ms) instead of an encoder call
 * (~1 s on the CPU serve box). Falls through to embedQuery on any cache error.
 * Table: sql/27-query-vec-cache.sql.
 */
export async function embedQueryCached(
  sql: { query: (t: string, p?: unknown[]) => Promise<Record<string, unknown>[]> },
  text: string,
  encoder: EncoderName = activeEncoder(),
): Promise<{ vector: number[]; provider: string; encoder: EncoderName; cached: boolean }> {
  const norm = text.trim().slice(0, 2000);
  try {
    const hit = await sql.query(
      `UPDATE query_vec_cache SET hits = hits + 1, last_seen = now()
       WHERE text_hash = md5($1) AND model = $2 RETURNING embedding::text AS v`,
      [`${encoder}:${norm}`, encoder],
    );
    if (hit[0]?.v) return { vector: JSON.parse(String(hit[0].v)), provider: "cache", encoder, cached: true };
  } catch { /* cache table missing or unreachable — encode */ }
  const e = await embedQuery(norm, encoder);
  try {
    await sql.query(
      `INSERT INTO query_vec_cache (text_hash, model, embedding) VALUES (md5($1), $2, $3::vector)
       ON CONFLICT (text_hash, model) DO UPDATE SET hits = query_vec_cache.hits + 1, last_seen = now()`,
      [`${e.encoder}:${norm}`, e.encoder, toVectorLiteral(e.vector)],
    );
  } catch { /* best effort */ }
  return { ...e, cached: false };
}
