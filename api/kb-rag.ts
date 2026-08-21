// /api/kb-rag — managed RAG as a service, behind the composer's lightning toggle.
//
// One call runs the whole AWS pipeline: Bedrock Knowledge Base MMXHXLS4BN
// (Titan v2 embeddings, managed chunking, Cohere Rerank 3.5) retrieves, and the
// same generator the KB is configured with (Claude Haiku 4.5) answers inside
// RetrieveAndGenerate. Our own encoder is never consulted. The KB holds the
// 10,000-document slice built by scripts/kb/build-slice.mjs — a subset of the
// 433k corpus, so a miss here is not proof the paper doesn't exist.
//
// This replaced the /kb side-by-side compare page; the bake-off itself is done
// and written up in docs/BEDROCK-KB-BAKEOFF.md, with scoring in scripts/kb/.
//
// Classic (req, res) Vercel signature; local imports need the .js extension.
import { neon } from "@neondatabase/serverless";
import { BedrockAgentRuntimeClient, RetrieveAndGenerateCommand } from "@aws-sdk/client-bedrock-agent-runtime";

export const config = { maxDuration: 60 };

const KB_ID = process.env.KB_ID ?? "MMXHXLS4BN";
// ONE REGION. The KB, its S3 Vectors index, Neon and nsr-pdfs are all us-east-1.
// BEDROCK_REGION was us-east-2 once — inherited from the NSR clone — and calling
// the KB there produced an authorization error for a resource that was never
// there. This constant does not read that env var on purpose.
const KB_REGION = process.env.KB_REGION ?? "us-east-1";
const GEN_MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const RERANK_ARN = `arn:aws:bedrock:us-east-1::foundation-model/cohere.rerank-v3-5:0`;

const RULES = `Ground every claim in the retrieved preprints. Do not describe a finding you were not shown.
These are preprints; most are not peer reviewed. State publication status ONLY if a record shows it — never assert that a paper has not been published.
Cite papers by their bioRxiv/medRxiv key number. Never fabricate key numbers, DOIs, journals or author names.`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method === "OPTIONS") return res.status(200).send("ok");
  const question = String(req.query?.q ?? "").trim();
  const n = Math.min(20, Math.max(1, Number(req.query?.n ?? 10) || 10));
  // Rerank defaults ON: this endpoint exists to show the managed stack at its
  // best, and the bake-off showed the reranker is where that stack earns it.
  const rerank = String(req.query?.rerank ?? "1") !== "0";
  if (question.length < 3) return res.status(400).json({ error: "q is required" });

  if (!process.env.AWS_BEARER_TOKEN_BEDROCK && process.env.BEDROCK_API_KEY)
    process.env.AWS_BEARER_TOKEN_BEDROCK = process.env.BEDROCK_API_KEY;

  const t0 = Date.now();
  try {
    const client = new BedrockAgentRuntimeClient({ region: KB_REGION });
    const vsc: Record<string, unknown> = { numberOfResults: n };
    if (rerank) vsc.rerankingConfiguration = {
      type: "BEDROCK_RERANKING_MODEL",
      bedrockRerankingConfiguration: { numberOfRerankedResults: n, modelConfiguration: { modelArn: RERANK_ARN } },
    };
    const out = await client.send(new RetrieveAndGenerateCommand({
      input: { text: question },
      retrieveAndGenerateConfiguration: {
        type: "KNOWLEDGE_BASE",
        knowledgeBaseConfiguration: {
          knowledgeBaseId: KB_ID,
          modelArn: `arn:aws:bedrock:${KB_REGION}:638175140432:inference-profile/${GEN_MODEL}`,
          retrievalConfiguration: { vectorSearchConfiguration: vsc as never },
          generationConfiguration: {
            promptTemplate: { textPromptTemplate: `You are a research assistant over bioRxiv and medRxiv preprints.\n\n$search_results$\n\n${RULES}\n\n$output_format_instructions$` },
          },
        },
      },
    }));

    const seen = new Set<string>();
    for (const c of out.citations ?? [])
      for (const r of c.retrievedReferences ?? []) {
        const k = String((r.metadata as Record<string, unknown> | undefined)?.key_number ?? "");
        if (k) seen.add(k);
      }

    // The KB's citation metadata carries only key_numbers; the source chips in
    // the chat footer want titles and DOI links, so look those up in Neon.
    let sources: { key_number: string; title: string | null; doi: string | null }[] = [];
    if (seen.size) {
      const sql = neon(process.env.DATABASE_URL!);
      sources = (await sql.query(
        `SELECT key_number, title, doi FROM preprints WHERE key_number = ANY($1)`,
        [[...seen]],
      )) as typeof sources;
      // Preserve citation order, and keep keys Neon doesn't know about.
      const byKey = new Map(sources.map((s) => [s.key_number, s]));
      sources = [...seen].map((k) => byKey.get(k) ?? { key_number: k, title: null, doi: null });
    }

    return res.status(200).json({
      answer: out.output?.text ?? "",
      sources,
      rerank,
      ms: Date.now() - t0,
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message, ms: Date.now() - t0 });
  }
}
