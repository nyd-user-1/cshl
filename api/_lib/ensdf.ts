// ENSDF card-deck parser + shared text translation (used by the Markdown,
// llms.txt and typeset renderers in api/nuclide.ts).
// Input is the raw 80-column deck we store verbatim from NNDC's archival
// distributions (ensdf_datasets.raw / xundl_archive_datasets.raw). Card format
// per the ENSDF manual: cols 1-5 NUCID, col 6 continuation, col 7 comment flag
// (c/C/d/D/t/T), col 8 record type (L,G,B,E,A,P,N,Q,H), data cols 10-80.
// Comment cards follow the record they describe, so attachment is in-order.
// Unrendered record types land in `other` — nothing is silently dropped, and
// the lossless artifact remains the ENSDF text format itself.

export interface Gamma { e: string; de: string; ri: string; mult: string; mr: string; cc: string; ti: string; extra: string[]; comments: string[] }
export interface Feed { kind: "B" | "E" | "A"; e: string; ib: string; logft: string; extra: string[]; comments: string[] }
export interface Level { e: string; de: string; jpi: string; t12: string; dt: string; extra: string[]; comments: string[]; gammas: Gamma[]; feeds: Feed[] }
export interface Parent { e: string; jpi: string; t12: string; qp: string }
export interface Dataset {
  nucid: string; a: number; sym: string; z: number; dsid: string; dsref: string; pub: string; date: string;
  history: Record<string, string>;
  q: { qm: string; sn: string; sp: string; qa: string; ref: string } | null;
  parents: Parent[];
  general: string[];
  levels: Level[];
  unplacedGammas: Gamma[];
  other: string[];
}

/* ── ENSDF text markup → Unicode ───────────────────────────────────────── */

const GREEK: Record<string, string> = {
  a: "α", b: "β", g: "γ", d: "δ", e: "ε", z: "ζ", h: "η", q: "θ", i: "ι", k: "κ", l: "λ", m: "μ",
  n: "ν", x: "ξ", p: "π", r: "ρ", s: "σ", t: "τ", u: "υ", f: "φ", c: "χ", y: "ψ", w: "ω",
  A: "Α", B: "Β", G: "Γ", D: "Δ", E: "Ε", Z: "Ζ", H: "Η", Q: "Θ", I: "Ι", K: "Κ", L: "Λ", M: "Μ",
  N: "Ν", X: "Ξ", P: "Π", R: "Ρ", S: "Σ", T: "Τ", U: "Υ", F: "Φ", C: "Χ", Y: "Ψ", W: "Ω",
  "?": "≈", "@": "∞", "'": "°", ">": "≥", "<": "≤",
};
const SUP: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "(": "⁽", ")": "⁾" };
const SUB: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "(": "₍", ")": "₎" };

const mapChars = (s: string, table: Record<string, string>, fallback: (s: string) => string) =>
  s.length > 0 && [...s].every((ch) => table[ch]) ? [...s].map((ch) => table[ch]).join("") : fallback(s);

/** ENSDF markup → readable Unicode. mode "md" keeps markdown emphasis; "plain" drops styling. */
export function tx(s: string, mode: "md" | "plain" = "plain"): string {
  let out = s;
  for (let i = 0; i < 4; i++) {
    const before = out;
    out = out.replace(/\{\+([^{}]*)\}/g, (_m, t) => mapChars(t, SUP, (x) => `^${x}`));
    out = out.replace(/\{-([^{}]*)\}/g, (_m, t) => mapChars(t, SUB, (x) => `_${x}`));
    out = out.replace(/\{I([^{}]*)\}/g, mode === "md" ? "*$1*" : "$1");
    out = out.replace(/\{B([^{}]*)\}/g, mode === "md" ? "**$1**" : "$1");
    out = out.replace(/\{[UA]([^{}]*)\}/g, "$1");
    if (out === before) break;
  }
  return out.replace(/\|([a-zA-Z?@'><])/g, (m, ch) => GREEK[ch] ?? m);
}

const ELEMENTS = ["Nn","H","He","Li","Be","B","C","N","O","F","Ne","Na","Mg","Al","Si","P","S","Cl","Ar","K","Ca","Sc","Ti","V","Cr","Mn","Fe","Co","Ni","Cu","Zn","Ga","Ge","As","Se","Br","Kr","Rb","Sr","Y","Zr","Nb","Mo","Tc","Ru","Rh","Pd","Ag","Cd","In","Sn","Sb","Te","I","Xe","Cs","Ba","La","Ce","Pr","Nd","Pm","Sm","Eu","Gd","Tb","Dy","Ho","Er","Tm","Yb","Lu","Hf","Ta","W","Re","Os","Ir","Pt","Au","Hg","Tl","Pb","Bi","Po","At","Rn","Fr","Ra","Ac","Th","Pa","U","Np","Pu","Am","Cm","Bk","Cf","Es","Fm","Md","No","Lr","Rf","Db","Sg","Bh","Hs","Mt","Ds","Rg","Cn","Nh","Fl","Mc","Lv","Ts","Og"];

export const nucParts = (nucid: string) => {
  const m = /^(\d+)([A-Z]{0,2})$/.exec(nucid.trim());
  if (!m) return { a: 0, sym: "", z: -1 };
  const symRaw = m[2] === "NN" ? "Nn" : m[2] ? m[2][0] + m[2].slice(1).toLowerCase() : "";
  return { a: Number(m[1]), sym: symRaw, z: symRaw ? ELEMENTS.indexOf(symRaw) : -1 };
};
/** "¹⁸⁰Er" as plain Unicode. */
export const nucName = (nucid: string) => {
  const { a, sym } = nucParts(nucid);
  return a ? `${mapChars(String(a), SUP, (x) => x)}${sym}` : nucid.trim();
};

const f = (line: string, a: number, b: number) => line.slice(a, b).trim();

/* ── parser ────────────────────────────────────────────────────────────── */

export function parseDataset(raw: string): Dataset {
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const ds: Dataset = {
    nucid: "", a: 0, sym: "", z: -1, dsid: "", dsref: "", pub: "", date: "",
    history: {}, q: null, parents: [], general: [], levels: [], unplacedGammas: [], other: [],
  };
  let histBuf = "";
  let lastLevel: Level | null = null;
  let lastGamma: Gamma | null = null;
  let lastFeed: Feed | null = null;
  let lastRecord: { extra: string[] } | null = null;
  /** the comment list the previous comment card went to, for continuations */
  let lastCommentList: string[] | null = null;

  for (const line of lines) {
    const cont = line[5] ?? " ";
    const flag = line[6] ?? " ";
    const type = (line[7] ?? " ").toUpperCase();
    const body = line.slice(9).replace(/\s+$/, "");

    if (!ds.nucid && cont === " " && flag === " " && line[7] === " ") {
      ds.nucid = f(line, 0, 5);
      const p = nucParts(ds.nucid);
      ds.a = p.a; ds.sym = p.sym; ds.z = p.z;
      ds.dsid = f(line, 9, 39);
      ds.dsref = f(line, 39, 65);
      ds.pub = f(line, 65, 74);
      ds.date = f(line, 74, 80);
      continue;
    }
    if (/[cdtCDT]/.test(flag)) {
      const text = body.replace(/^\s+/, "");
      if (cont !== " " && lastCommentList && lastCommentList.length > 0) {
        lastCommentList[lastCommentList.length - 1] += ` ${text}`;
        continue;
      }
      const list =
        type === "L" && lastLevel ? lastLevel.comments :
        type === "G" && lastGamma ? lastGamma.comments :
        (type === "B" || type === "E" || type === "A") && lastFeed ? lastFeed.comments :
        ds.general;
      list.push(text);
      lastCommentList = list;
      continue;
    }
    if (type === "H") { histBuf += (histBuf ? " " : "") + body; continue; }
    if (cont !== " ") {
      if (lastRecord) lastRecord.extra.push(...body.split("$").map((s) => s.trim()).filter(Boolean));
      else ds.other.push(line);
      continue;
    }
    switch (type) {
      case "Q":
        ds.q = { qm: f(line, 9, 21), sn: f(line, 21, 31), sp: f(line, 31, 41), qa: f(line, 41, 55), ref: f(line, 55, 80) };
        lastRecord = null;
        break;
      case "P":
        ds.parents.push({ e: f(line, 9, 21), jpi: f(line, 21, 39), t12: f(line, 39, 55), qp: f(line, 64, 80) });
        lastRecord = null;
        break;
      case "L": {
        const lv: Level = { e: f(line, 9, 19), de: f(line, 19, 21), jpi: f(line, 21, 39), t12: f(line, 39, 49), dt: f(line, 49, 55), extra: [], comments: [], gammas: [], feeds: [] };
        ds.levels.push(lv); lastLevel = lv; lastGamma = null; lastFeed = null; lastRecord = lv;
        break;
      }
      case "G": {
        const g: Gamma = { e: f(line, 9, 19), de: f(line, 19, 21), ri: f(line, 21, 29), mult: f(line, 31, 41), mr: f(line, 41, 49), cc: f(line, 55, 62), ti: f(line, 64, 74), extra: [], comments: [] };
        (lastLevel ? lastLevel.gammas : ds.unplacedGammas).push(g); lastGamma = g; lastRecord = g;
        break;
      }
      case "B": case "E": case "A": {
        const fd: Feed = { kind: type as Feed["kind"], e: f(line, 9, 19), ib: f(line, 21, 29), logft: f(line, 41, 49), extra: [], comments: [] };
        if (lastLevel) lastLevel.feeds.push(fd);
        lastFeed = fd; lastRecord = fd;
        break;
      }
      default:
        ds.other.push(line);
        lastRecord = null;
        break;
    }
  }
  for (const part of histBuf.split("$")) {
    const m = /^\s*([A-Z]{3,4})\s*=\s*(.*)$/.exec(part);
    if (m) ds.history[m[1]] = m[2].trim();
  }
  return ds;
}

/** Split a comment's leading "SYM$text" quantity label, if present. */
export const commentParts = (c: string): { sym: string; text: string } => {
  const m = /^([A-Za-z0-9 ,()+%|{}^./-]{1,24})\$(.*)$/.exec(c);
  return m ? { sym: m[1].trim(), text: m[2].trim() } : { sym: "", text: c };
};

/** The cover-page labels NNDC's PDF uses for the general-comment symbols. */
export const GENERAL_LABELS: Record<string, string> = {
  TITL: "Title", AUTH: "Author(s)", INST: "Institution", ABST: "Abstract",
  CUT: "Cutoff Date", ACKN: "Acknowledgements", FUND: "Funding", CIT: "Citations", COMM: "General Comments",
};
