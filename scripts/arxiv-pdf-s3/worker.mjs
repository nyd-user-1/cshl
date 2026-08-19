/**
 * arxiv-pdf-s3/worker.mjs — streams arXiv PDFs from the public GCS mirror
 * straight into S3. Runs ON THE EC2 INSTANCE and stores NOTHING on local disk:
 * each body is held in memory only long enough to PUT it.
 *
 * It does no discovery: `ingest-arxiv.mjs resolve` already picked the highest
 * version of every paper and wrote the exact object path + byte size, so this
 * side is pure I/O and the byte total is known before the box is launched.
 *
 * Input  (worklist.csv, no header):  key_number,arxiv_id,gcs_path,size
 * Output (S3):  s3://$BUCKET/arxiv/<arxiv_id>.pdf
 *               s3://$BUCKET/logs/done-<PART>-<seq>.jsonl   ← {id,key_number,s3_key,bytes}
 *
 * The completion log is the ONLY channel back to the corpus: the laptop reads
 * it and does the Neon write-back, so no database credential ever lands here.
 *
 *   BUCKET=nsr-pdfs CONC=16 node worker.mjs worklist.csv
 */

import { readFileSync, appendFileSync } from "node:fs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const BUCKET = process.env.BUCKET ?? "nsr-pdfs";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const CONC = Number(process.env.CONC ?? 16);
const PART = Number(process.env.PART ?? 0);
const PARTS = Number(process.env.PARTS ?? 1);
const LOG_EVERY = Number(process.env.LOG_EVERY ?? 1000);
const WORKLIST = process.argv[2] ?? "worklist.csv";
const GCS = "https://storage.googleapis.com/arxiv-dataset";

const s3 = new S3Client({ region: REGION });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const parseCsvLine = (line) => {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
};

const rows = [];
for (const line of readFileSync(WORKLIST, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const [key_number, id, gcs_path, size] = parseCsvLine(line);
  if (!gcs_path) continue;
  rows.push({ key_number, id, gcs_path, size: Number(size) || 0 });
}
// Partitioned so N boxes can share one worklist without coordinating.
const mine = rows.filter((_, i) => i % PARTS === PART);
const totalBytes = mine.reduce((n, r) => n + r.size, 0);
console.log(`worklist ${rows.length} rows → part ${PART}/${PARTS} = ${mine.length} files, ` +
  `${(totalBytes / 1e9).toFixed(2)} GB expected`);

// ── completion log: appended locally, shipped to S3 every LOG_EVERY ──────────
// A killed box must not cost us the record of what it already stored.
const LOG = `/tmp/done-${PART}.jsonl`;
let logSeq = 0, sinceUpload = 0;
const pending = [];

async function uploadLog(final = false) {
  if (!pending.length) return;
  const body = pending.splice(0, pending.length).map((r) => JSON.stringify(r)).join("\n") + "\n";
  const key = `logs/done-${PART}-${String(logSeq++).padStart(4, "0")}.jsonl`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: "application/x-ndjson" }));
      console.log(`  ↑ ${key} (${body.split("\n").length - 1} records)${final ? " [final]" : ""}`);
      return;
    } catch (e) {
      if (attempt === 4) { console.log(`  ⚠ log upload failed permanently: ${e.message}`); return; }
      await sleep(2000 * 2 ** attempt);
    }
  }
}

let stored = 0, failed = 0, bytes = 0, reported = false;
const t0 = Date.now();

async function one(r) {
  const key = `arxiv/${r.id}.pdf`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${GCS}/${r.gcs_path}`, { signal: AbortSignal.timeout(180_000) });
      if (!res.ok) {
        if (res.status === 404) { failed++; return; }        // mirror lied; laptop fallback will catch it
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) { failed++; return; }           // not a real PDF
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key: key, Body: buf, ContentType: "application/pdf",
      }));
      stored++; bytes += buf.length;
      const rec = { id: r.id, key_number: r.key_number, s3_key: key, bytes: buf.length, bucket: BUCKET };
      appendFileSync(LOG, JSON.stringify(rec) + "\n");
      pending.push(rec);
      if (++sinceUpload >= LOG_EVERY) { sinceUpload = 0; await uploadLog(); }

      const mins = (Date.now() - t0) / 60_000;
      if (!reported && stored >= 1000) {
        reported = true;
        console.log(`\n📈 MEASURED after ${stored} files: ${(stored / mins).toFixed(0)} files/min, ` +
          `${(bytes / 1e6 / (mins * 60)).toFixed(1)} MB/s → projected ` +
          `${(mine.length / (stored / mins) / 60).toFixed(2)} h for ${mine.length} files ` +
          `(${(totalBytes / 1e9).toFixed(1)} GB)\n`);
      }
      if (stored % 500 === 0) {
        console.log(`  ${stored}/${mine.length}  ${(stored / mins).toFixed(0)}/min  ` +
          `${(bytes / 1e9).toFixed(2)} GB  ${(bytes / 1e6 / (mins * 60)).toFixed(1)} MB/s`);
      }
      return;
    } catch (e) {
      if (attempt === 3) { failed++; console.log(`  ⚠ ${r.id}: ${e.message.slice(0, 120)}`); return; }
      await sleep(2000 * 2 ** attempt);
    }
  }
}

// Fixed-size worker pool — CONC bodies in flight, nothing queued on disk.
let i = 0;
await Promise.all(Array.from({ length: Math.min(CONC, mine.length) }, async () => {
  while (i < mine.length) await one(mine[i++]);
}));
await uploadLog(true);

const mins = (Date.now() - t0) / 60_000;
console.log(`\nDONE part ${PART}: stored ${stored}, failed ${failed}, ` +
  `${(bytes / 1e9).toFixed(2)} GB in ${mins.toFixed(1)} min ` +
  `(${(stored / mins).toFixed(0)} files/min, ${(bytes / 1e6 / (mins * 60)).toFixed(1)} MB/s)`);
