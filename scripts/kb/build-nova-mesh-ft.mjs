#!/usr/bin/env node
// build-nova-mesh-ft.mjs — turn the librarian's labeled MeSH data into a Nova
// fine-tuning set (Bedrock's bedrock-conversation-2024 schema).
//
// WHY THIS TARGET. Doctrine (docs, and the fable session): own the stages that
// decide what the generative model reads — TAG, QP, RR, CITE — and rent the
// voice. So the frontier model we customize is pointed at the LIBRARIAN's job
// (assign MeSH subject headings to an abstract), not at answering. We already
// hold 102,725 labeled rows from the classifier lane, which makes this the one
// task where a fine-tune can be scored head-to-head against a model we own.
//
//   node scripts/kb/build-nova-mesh-ft.mjs 3000 300
import { createReadStream, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";

const N_TRAIN = Number(process.argv[2] ?? 3000);
const N_VAL = Number(process.argv[3] ?? 300);
const OUT = "data/nova-ft";

const labels = JSON.parse(readFileSync("data/classify/mesh.labels.json", "utf8"));
const nameOf = (i) => labels.descriptors[i];

const SYSTEM =
  "You are the librarian for a bioRxiv/medRxiv preprint corpus. Given a preprint's " +
  "title and abstract, list the MeSH subject headings that describe it. Reply with " +
  "the heading names only, comma-separated, most central first. No commentary.";

// Long tails make a noisy target and a fat prompt; the head labels are what the
// subject map actually routes on.
const MAX_LABELS = 12;
const MAX_CHARS = 2400;

async function take(file, n, skip = 0) {
  const out = [];
  let seen = 0;
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (seen++ < skip) continue;
    const r = JSON.parse(line);
    const ys = Array.isArray(r.y) ? r.y : JSON.parse(r.y);
    if (!ys?.length) continue;
    const names = ys.slice(0, MAX_LABELS).map(nameOf).filter(Boolean);
    if (!names.length) continue;
    out.push({
      schemaVersion: "bedrock-conversation-2024",
      system: [{ text: SYSTEM }],
      messages: [
        { role: "user", content: [{ text: String(r.text).slice(0, MAX_CHARS) }] },
        { role: "assistant", content: [{ text: names.join(", ") }] },
      ],
    });
    if (out.length >= n) break;
  }
  rl.close();
  return out;
}

const train = await take("data/classify/mesh.train.jsonl", N_TRAIN);
const val = await take("data/classify/mesh.val.jsonl", N_VAL);
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/mesh-train.jsonl`, train.map((r) => JSON.stringify(r)).join("\n") + "\n");
writeFileSync(`${OUT}/mesh-val.jsonl`, val.map((r) => JSON.stringify(r)).join("\n") + "\n");

// Rough token accounting, so the training bill is predicted before it is paid.
const chars = [...train, ...val].reduce(
  (a, r) => a + r.system[0].text.length + r.messages.reduce((b, m) => b + m.content[0].text.length, 0),
  0,
);
console.log(`train=${train.length} val=${val.length} ≈${Math.round(chars / 4 / 1000)}k tokens/epoch`);
console.log(`wrote ${OUT}/mesh-train.jsonl and ${OUT}/mesh-val.jsonl`);
