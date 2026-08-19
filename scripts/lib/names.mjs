/**
 * Author-name normalization for the rxiv corpus.
 *
 * The source serves TWO formats, and they vary BY VERSION inside a single paper:
 *   v1  (raw submission)  "Daniel Costa; Nuria Bonet; Jose Manuel Gonzalez de Aledo-Castillo"
 *   v2+ (normalized)      "Costa, D.; Bonet, N.; Gonzalez de Aledo-Castillo, J. M."
 * 94.7% of rows are the second form. Left alone, the same person becomes two entries
 * in the authors dictionary, so everything is parsed to (last, initial1, initial2).
 */

// Surname particles: once one appears, it and everything after it is the surname.
const PARTICLES = new Set([
  "de","del","della","dell","der","den","des","di","da","das","dos","du","la","le","lo",
  "van","von","vander","ter","ten","af","al","bin","ibn","st","st.","mac","mc","y","e",
]);

/** "Gonzalez de Aledo-Castillo" out of "Jose Manuel Gonzalez de Aledo-Castillo" */
function splitGivenFamily(full) {
  const toks = full.trim().split(/\s+/).filter(Boolean);
  if (toks.length === 0) return { given: [], family: "" };
  if (toks.length === 1) return { given: [], family: toks[0] };
  const at = toks.findIndex((t, i) => i > 0 && i < toks.length - 1 && PARTICLES.has(t.toLowerCase()));
  if (at > 0) {
    // Where the surname starts is genuinely ambiguous around a particle:
    //   "Jan van Dijk"                          -> given Jan,          family "van Dijk"
    //   "Jose Manuel Gonzalez de Aledo-Castillo" -> given Jose Manuel,  family "Gonzalez de Aledo-Castillo"
    // Three or more tokens ahead of the particle means the one just before it is
    // almost always the first half of a compound surname, so start one earlier.
    const start = at >= 3 ? at - 1 : at;
    return { given: toks.slice(0, start), family: toks.slice(start).join(" ") };
  }
  return { given: toks.slice(0, -1), family: toks[toks.length - 1] };
}

const initialOf = (t) => (t ? t.replace(/[^\p{L}]/gu, "").charAt(0).toUpperCase() : "");

/** One author token -> {last_name, initial1, initial2, display} */
export function parseAuthor(raw) {
  const s = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  let family, givenToks;
  const comma = s.indexOf(",");
  if (comma > -1) {
    family = s.slice(0, comma).trim();
    givenToks = s.slice(comma + 1).trim().split(/[\s.]+/).filter(Boolean);
  } else {
    const sp = splitGivenFamily(s);
    family = sp.family;
    givenToks = sp.given;
  }
  if (!family) return null;
  const i1 = initialOf(givenToks[0]);
  const i2 = initialOf(givenToks[1]);
  const display = i1 ? `${family}, ${i1}.${i2 ? ` ${i2}.` : ""}` : family;
  return { last_name: family, initial1: i1 || null, initial2: i2 || null, display };
}

/** Whole "; "-joined string -> {display, list} both normalized to "Last, I." */
export function normalizeAuthors(raw) {
  const parts = (raw ?? "").split(";").map((x) => x.trim()).filter(Boolean);
  const list = parts.map(parseAuthor).filter(Boolean);
  return { display: list.map((a) => a.display).join("; "), list };
}
