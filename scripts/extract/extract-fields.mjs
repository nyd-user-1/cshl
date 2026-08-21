#!/usr/bin/env node
// extract-fields.mjs — turn an abstract into FIELDS.
//
// The point: our corpus knows a paper's title, authors, category and date, and
// nothing about what the study actually did. So no one can ask for
// "randomised trials over 500 participants in this subject" — the data to
// answer it does not exist. This makes it exist.
//
// No fine-tuning involved. Bedrock's Converse API can FORCE a tool call, and a
// tool's inputSchema is a JSON Schema — so the model must answer in exactly the
// shape we declare, or the call fails. That is structured output: same models
// we already pay for, a schema instead of a prompt-and-pray.
//
//   node scripts/extract/extract-fields.mjs 10 medrxiv "infectious diseases"
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

const SITE = process.env.SITE_URL ?? "https://cshl.nysgpt.com";
const MODEL = process.env.EXTRACT_MODEL ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const PRICE_IN = 1.0, PRICE_OUT = 5.0; // Haiku 4.5 on-demand, USD / 1M tokens

/** The contract. Every field is nullable on purpose: an abstract that does not
 *  state a sample size must yield null, never a plausible number. */
const SCHEMA = {
  type: "object",
  properties: {
    study_design: {
      type: "string",
      enum: ["rct", "cohort", "case-control", "cross-sectional", "modeling",
             "systematic-review", "diagnostic-accuracy", "lab-preclinical", "other"],
      description: "The design the abstract describes. 'other' if it does not say.",
    },
    sample_size: { type: ["integer", "null"], description: "Participants/samples analysed. null if not stated." },
    population: { type: ["string", "null"], description: "Who or what was studied, ≤12 words." },
    setting: { type: ["string", "null"], description: "Country or setting, if stated." },
    intervention: { type: ["string", "null"], description: "Intervention, exposure or assay under test." },
    comparator: { type: ["string", "null"], description: "What it was compared against, if anything." },
    primary_outcome: { type: ["string", "null"], description: "The main outcome measured, ≤12 words." },
    effect_direction: {
      type: "string",
      enum: ["benefit", "harm", "no-difference", "mixed", "not-applicable", "unclear"],
      description:
        "Direction of the headline result FOR THE PERSON EXPOSED OR TREATED. " +
        "'harm' when the intervention or exposure made the outcome worse or more likely " +
        "(e.g. a hazard ratio above 1 for an unwanted outcome such as death, disease or " +
        "hospitalisation). 'benefit' when it made an unwanted outcome less likely, or a " +
        "wanted outcome more likely. 'not-applicable' for studies with no exposure-outcome " +
        "contrast, such as method or assay development.",
    },
    effect_estimate: { type: ["string", "null"], description: "The headline number as written, e.g. 'OR 0.62 (95% CI 0.45-0.85)'. null if none." },
    stated_limitation: { type: ["string", "null"], description: "A limitation the authors themselves state, if any." },
  },
  required: ["study_design", "sample_size", "population", "setting", "intervention",
             "comparator", "primary_outcome", "effect_direction", "effect_estimate", "stated_limitation"],
};

const SYSTEM =
  "You extract study metadata from biomedical preprint abstracts. Report ONLY what the " +
  "abstract states. If the abstract does not state something, return null for it — never " +
  "infer, never estimate, never fill a field from background knowledge. A wrong sample size " +
  "is worse than a missing one, because a missing one is honest.";

const client = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION ?? "us-east-1" });

export async function extract(record) {
  const text = `Title: ${record.title}\n\nAbstract: ${record.abstract}`;
  const out = await client.send(
    new ConverseCommand({
      modelId: MODEL,
      system: [{ text: SYSTEM }],
      messages: [{ role: "user", content: [{ text }] }],
      inferenceConfig: { maxTokens: 900, temperature: 0 },
      toolConfig: {
        tools: [{ toolSpec: { name: "record_study", description: "Record the study's fields.", inputSchema: { json: SCHEMA } } }],
        // Not a suggestion: the model MUST call this tool, so the reply is the schema.
        toolChoice: { tool: { name: "record_study" } },
      },
    }),
  );
  const block = (out.output?.message?.content ?? []).find((c) => c.toolUse);
  return { fields: block?.toolUse?.input ?? null, usage: out.usage };
}

async function main() {
  const [, , nArg, server, ...catParts] = process.argv;
  const n = Number(nArg ?? 8);
  const category = catParts.join(" ");
  const u = new URL("/api/search", SITE);
  u.searchParams.set("q", category || "clinical study");
  u.searchParams.set("mode", "keyword");
  u.searchParams.set("limit", String(n));
  if (server) u.searchParams.set("server", server);
  if (server && category) u.searchParams.set("category", category);

  const { records } = await (await fetch(u)).json();
  const rows = records.filter((r) => r.abstract).slice(0, n);
  console.log(`extracting ${rows.length} abstracts (${server ?? "all"}${category ? " · " + category : ""})\n`);

  let inTok = 0, outTok = 0;
  const results = [];
  for (const r of rows) {
    const { fields, usage } = await extract(r);
    inTok += usage?.inputTokens ?? 0;
    outTok += usage?.outputTokens ?? 0;
    results.push({ key_number: r.key_number, title: r.title, ...fields });
    console.log(`${r.key_number}  ${String(fields?.study_design).padEnd(20)} n=${String(fields?.sample_size ?? "—").padEnd(8)} ${fields?.effect_direction}`);
    console.log(`   ${r.title.slice(0, 96)}`);
    if (fields?.primary_outcome) console.log(`   outcome: ${fields.primary_outcome}`);
    if (fields?.effect_estimate) console.log(`   effect:  ${fields.effect_estimate}`);
    console.log();
  }
  const cost = (inTok / 1e6) * PRICE_IN + (outTok / 1e6) * PRICE_OUT;
  console.log(`tokens in=${inTok} out=${outTok} cost=$${cost.toFixed(4)} → $${((cost / rows.length) * 433449).toFixed(0)} for the whole 433k corpus at this rate`);
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
