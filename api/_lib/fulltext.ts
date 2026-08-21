// On-demand full text for the records that reach the chat prompt (Task 1b).
//
// The generator has only ever read a ~1,670-char abstract; every fact the five
// failed test answers missed lives in the body. This module fetches the body
// for the top few retrieved records, per row trying:
//
//   1. preprint_fulltext cache (Neon) — the second ask is free
//   2. jatsxml_url                    — structured JATS, cleanest to parse
//   3. the article HTML full-text page (derived from doi + server + version)
//   4. Europe PMC fullTextXML         — different origin, different rate limits
//   5. Wayback Machine (id_ mode)     — an archive whose crawler the origin does
//                                       not block (the same reasoning as
//                                       /api/pdf's Google-viewer route); bioRxiv
//                                       is heavily archived
//   6. r.jina.ai reader               — works from residential IPs (local dev);
//                                       Vercel's egress gets 403'd, so in
//                                       production it is a long shot, kept last
//
// bioRxiv/medRxiv sit behind Cloudflare rate limiting that answers a busy
// client with 429 (measured 2026-08-21: EVERY biorxiv.org fetch from Vercel's
// egress 429s; medrxiv.org intermittently allows), so a miss on rungs 2–3 is
// expected background noise, not an error. Rung 4 covers ~6% of preprints plus
// published versions; rung 5 measured ~5 s / 359 KB for a paper rungs 2–4 all
// missed.
//
// TIMING CONTRACT. The caller gives a prompt budget (~3 s). Each fetch races
// that budget for *inclusion in the prompt*, but keeps running afterwards (up
// to a hard cap) so a slow success still lands in the cache — the turn is
// never hung, and the next ask hits rung 1. Cache writes are fire-and-forget.
//
// The stored text is section-trimmed (abstract + results + discussion when
// the source is structured), never the raw 60k-char body.

interface SqlClient {
  query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
}

export interface FulltextRow {
  key_number: string;
  doi: string | null;
  server: string | null;
  version: number | null;
  jatsxml_url: string | null;
}

export interface FulltextResult {
  key_number: string;
  source: string; // 'cache:jats' | 'jats' | 'html' | 'epmc'
  text: string;
}

// Enough for abstract + results + discussion on a normal paper. Measured on
// the CRISPR PAM test paper: at 12k the cap landed mid-Results and Discussion
// never made it. The prompt-side budget (FULLTEXT_PROMPT_BUDGET in chat.ts)
// still governs how much of this reaches any one turn.
const PER_PAPER_CHARS = 18_000;
const HARD_FETCH_MS = 20_000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 RxivGPT/1.0";

/* ── text extraction ─────────────────────────────────────────────────────── */

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#x2009;|&#8201;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(s: string): string {
  return decodeEntities(
    s
      .replace(/<xref[^>]*>[\s\S]*?<\/xref>/g, "") // citation markers add noise, no facts
      .replace(/<(table-wrap|fig|graphic|disp-formula)[\s\S]*?<\/\1>/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** JATS → "abstract + the sections a reader needs", capped. */
export function trimJats(xml: string): string | null {
  const bodyM = xml.match(/<body[\s>][\s\S]*?<\/body>/);
  if (!bodyM) return null;
  const abstractM = xml.match(/<abstract[\s>][\s\S]*?<\/abstract>/);

  // Top-level <sec> blocks with their titles.
  const secs: { title: string; text: string }[] = [];
  const secRe = /<sec[^>]*>([\s\S]*?)<\/sec>/g;
  let m: RegExpExecArray | null;
  while ((m = secRe.exec(bodyM[0]))) {
    const titleM = m[1].match(/<title[^>]*>([\s\S]*?)<\/title>/);
    secs.push({ title: titleM ? stripTags(titleM[1]) : "", text: stripTags(m[1]) });
  }

  const wanted = /result|discussion|conclusion|finding/i;
  let picked = secs.filter((s) => wanted.test(s.title));
  if (!picked.length) picked = secs; // unstructured body — take it in order
  let out = abstractM ? `Abstract: ${stripTags(abstractM[0])}\n\n` : "";
  for (const s of picked) {
    if (out.length >= PER_PAPER_CHARS) break;
    out += (s.title ? `${s.title}: ` : "") + s.text + "\n\n";
  }
  // Fallback when <sec> parsing found nothing at all
  if (out.trim().length < 400) out = stripTags(bodyM[0]);
  const text = out.slice(0, PER_PAPER_CHARS).trim();
  return text.length >= 400 ? text : null;
}

/** Reader-proxy markdown → abstract + the sections a reader needs, capped. */
export function trimReaderMarkdown(md: string): string | null {
  const body = md.replace(/^[\s\S]*?Markdown Content:\s*/, "");
  const secs = body.split(/\n(?=#{1,4} )/);
  const wanted = /abstract|result|discussion|conclusion|finding/i;
  let picked = secs.filter((s) => wanted.test(s.match(/^#{1,4} (.+)/)?.[1] ?? ""));
  if (!picked.length) picked = secs;
  const text = picked
    .join("\n\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")      // images carry no facts
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")    // keep link text, drop URLs
    .replace(/[ \t]+/g, " ")
    .slice(0, PER_PAPER_CHARS)
    .trim();
  return text.length >= 400 ? text : null;
}

/** bioRxiv/medRxiv .full HTML page → article text, capped.
 *
 *  Section-aware for the same reason as trimJats: taken in document order,
 *  abstract + introduction fill the cap before Results — where the quantities
 *  live — arrives. And LEVEL-aware, which is not a detail: on this template
 *  <h2>Results</h2> carries no paragraphs of its own, all of them hang off
 *  <h3> subheadings whose titles are findings ("43% of Type III repeat
 *  clusters contain a PAM"), so a flat title filter drops the entire results
 *  section while reporting success. Keeping an <h2> keeps everything under it
 *  until the next <h2>. */
export function trimArticleHtml(html: string): string | null {
  const clean = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
  // The article body lives in <div class="article fulltext-view">…
  const artM = clean.match(/<div[^>]*class="[^"]*fulltext-view[^"]*"[^>]*>([\s\S]*?)<div[^>]*class="[^"]*(?:ref-list|fn-group|license)/);
  const scope = artM ? artM[1] : clean;

  const wanted = /abstract|result|discussion|conclusion|finding/i;
  // Skip the apparatus: methods and everything after it are not what a reader
  // asking "what does this paper say" needs, and they are large.
  const stop = /method|acknowledg|reference|literature cited|author contribution|declaration|supplementary|footnote|data and material/i;

  const secs: { title: string; parts: string[] }[] = [];
  let keeping = true;              // content before the first heading = abstract-ish
  let total = 0;
  const re = /<(h[2-4]|p)[^>]*>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scope)) && total < PER_PAPER_CHARS * 6) {
    const t = stripTags(m[2]);
    if (t.length <= 2) continue;
    if (m[1] === "h2") {
      keeping = wanted.test(t) && !stop.test(t);
      if (keeping) secs.push({ title: t, parts: [] });
    } else if (m[1] === "p") {
      if (keeping && secs.length) { secs[secs.length - 1].parts.push(t); total += t.length; }
    } else if (keeping && secs.length) {
      // an h3/h4 inside a kept section — the title is itself a finding
      secs[secs.length - 1].parts.push(`\n${t}:`);
    }
  }

  const text = secs
    .filter((s) => s.parts.length)
    .map((s) => `${s.title}:\n${s.parts.join("\n")}`)
    .join("\n\n")
    .slice(0, PER_PAPER_CHARS)
    .trim();
  return text.length >= 800 ? text : null; // shorter than this ⇒ we parsed chrome, not the article
}

/* ── fetch rungs ─────────────────────────────────────────────────────────── */

async function fetchText(url: string, signal: AbortSignal): Promise<string | null> {
  const r = await fetch(url, { headers: { "user-agent": UA }, signal, redirect: "follow" });
  if (!r.ok) {
    console.log(`fulltext fetch ${r.status}: ${url}`);
    return null;
  }
  return r.text();
}

async function fetchJats(row: FulltextRow, signal: AbortSignal): Promise<string | null> {
  if (!row.jatsxml_url) return null;
  const xml = await fetchText(row.jatsxml_url, signal);
  return xml ? trimJats(xml) : null;
}

async function fetchHtml(row: FulltextRow, signal: AbortSignal): Promise<string | null> {
  if (!row.doi || !row.server) return null;
  const v = row.version ? `v${row.version}` : "";
  const html = await fetchText(`https://www.${row.server}.org/content/${row.doi}${v}.full`, signal);
  return html ? trimArticleHtml(html) : null;
}

async function fetchEpmc(row: FulltextRow, signal: AbortSignal): Promise<string | null> {
  if (!row.doi) return null;
  const s = await fetch(
    `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:%22${encodeURIComponent(row.doi)}%22&format=json&pageSize=3`,
    { signal },
  );
  if (!s.ok) return null;
  const hits = ((await s.json()) as { resultList?: { result?: { id: string; source: string }[] } })
    .resultList?.result ?? [];
  // Prefer a published (PMC) version over the preprint mirror — more likely to have text.
  const ordered = [...hits.filter((h) => h.source !== "PPR"), ...hits.filter((h) => h.source === "PPR")];
  for (const h of ordered) {
    const xml = await fetchText(
      `https://www.ebi.ac.uk/europepmc/webservices/rest/${h.source}/${h.id}/fullTextXML`,
      signal,
    );
    if (xml) {
      const t = trimJats(xml);
      if (t) return t;
    }
  }
  return null;
}

async function fetchWayback(row: FulltextRow, signal: AbortSignal): Promise<string | null> {
  if (!row.doi || !row.server) return null;
  const v = row.version ? `v${row.version}` : "";
  // "2" = latest snapshot, "id_" = the original bytes, no toolbar injection.
  const html = await fetchText(
    `https://web.archive.org/web/2id_/https://www.${row.server}.org/content/${row.doi}${v}.full`,
    signal,
  );
  return html ? trimArticleHtml(html) : null;
}

async function fetchReader(row: FulltextRow, signal: AbortSignal): Promise<string | null> {
  if (!row.doi || !row.server) return null;
  const v = row.version ? `v${row.version}` : "";
  const md = await fetchText(
    `https://r.jina.ai/https://www.${row.server}.org/content/${row.doi}${v}.full`,
    signal,
  );
  return md ? trimReaderMarkdown(md) : null;
}

/* ── the ladder, cache-aware ─────────────────────────────────────────────── */

async function fetchOne(row: FulltextRow, signal: AbortSignal): Promise<{ source: string; text: string } | null> {
  for (const [source, fn] of [
    ["jats", fetchJats],
    ["html", fetchHtml],
    ["epmc", fetchEpmc],
    ["wayback", fetchWayback],
    ["reader", fetchReader],
  ] as const) {
    if (signal.aborted) return null;
    try {
      const text = await fn(row, signal);
      if (text) return { source, text };
      console.log(`fulltext rung empty: ${source} ${row.key_number}`);
    } catch (e) {
      // rung failed — log and try the next
      console.log(`fulltext rung error: ${source} ${row.key_number} ${(e as Error).message.slice(0, 80)}`);
    }
  }
  return null;
}

/**
 * Full text for `rows`, cache-first. Resolves within ~`promptBudgetMs` with
 * whatever is ready by then; slower fetches keep running (≤ HARD_FETCH_MS) and
 * land in the cache for the next ask.
 */
export async function getFulltext(
  sql: SqlClient,
  rows: FulltextRow[],
  promptBudgetMs = 2800,
): Promise<FulltextResult[]> {
  if (!rows.length) return [];
  const results: FulltextResult[] = [];

  let cached = new Map<string, { source: string; text: string }>();
  try {
    const hit = await sql.query(
      `SELECT key_number, source, text FROM preprint_fulltext WHERE key_number = ANY($1)`,
      [rows.map((r) => r.key_number)],
    );
    cached = new Map(hit.map((r) => [String(r.key_number), { source: String(r.source), text: String(r.text) }]));
  } catch { /* cache unavailable — fetch anyway */ }

  const misses: FulltextRow[] = [];
  for (const row of rows) {
    const c = cached.get(row.key_number);
    if (c) results.push({ key_number: row.key_number, source: `cache:${c.source}`, text: c.text });
    else misses.push(row);
  }
  if (!misses.length) return results;

  const controller = new AbortController();
  const hardTimer = setTimeout(() => controller.abort(), HARD_FETCH_MS);

  const fetches = misses.map((row) =>
    fetchOne(row, controller.signal).then((got) => {
      if (!got) return null;
      // Fire-and-forget cache write — the turn never waits on it.
      sql
        .query(
          `INSERT INTO preprint_fulltext (key_number, source, text) VALUES ($1, $2, $3)
           ON CONFLICT (key_number) DO UPDATE SET source = $2, text = $3, fetched_at = now()`,
          [row.key_number, got.source, got.text],
        )
        .catch(() => {});
      return { key_number: row.key_number, ...got };
    }),
  );

  // Prompt inclusion races the budget; the fetches themselves keep going.
  const budget = new Promise<null>((resolve) => setTimeout(() => resolve(null), promptBudgetMs));
  const settled = await Promise.race([Promise.allSettled(fetches), budget.then(() => null)]);

  if (settled) {
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) results.push(s.value);
    }
    clearTimeout(hardTimer);
  } else {
    // Budget elapsed — take whatever individual fetches already resolved.
    const ready = await Promise.all(
      fetches.map((p) => Promise.race([p, Promise.resolve(null)])),
    );
    for (const r of ready) if (r) results.push(r);
    // Leave hardTimer armed: stragglers still get aborted at the cap, and their
    // successes still write the cache. allSettled above keeps the process alive
    // only as long as the response stream does — which is exactly the window
    // Bedrock generation holds open anyway.
    Promise.allSettled(fetches).finally(() => clearTimeout(hardTimer));
  }
  return results;
}
