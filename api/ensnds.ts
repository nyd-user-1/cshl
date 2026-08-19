// /api/ensnds — serves OUR mirrored copies of NNDC's typeset capture-dataset
// PDFs (s3://nsr-pdfs/ensnds/, populated by scripts/mirror-ensnds.mjs) via a
// 302 to a short-lived presigned GET. The bucket is private; this is the door.
//   GET ?f=140/La/ng_E_th.pdf → 302 → presigned S3 URL (15 min)
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const config = { maxDuration: 10 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const f = String(req.query?.f ?? "");
  if (!/^\d{1,3}\/[A-Za-z]{1,2}\/[\w'()=.-]+\.pdf$/.test(f)) {
    return res.status(400).json({ error: "f=<A>/<El>/<slug>.pdf required" });
  }
  try {
    // nsr-pdfs lives in us-east-1; BEDROCK_REGION is us-east-2 and must not leak here
    const s3 = new S3Client({ region: "us-east-1" });
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: "nsr-pdfs", Key: `ensnds/${f}` }), { expiresIn: 900 });
    res.setHeader("Cache-Control", "private, no-store");
    res.writeHead(302, { Location: url });
    return res.end();
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
}
