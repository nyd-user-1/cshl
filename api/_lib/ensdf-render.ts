// Renderers over the parsed ENSDF deck: Markdown, llms.txt, and a typeset
// print view (the browser's Save-as-PDF is the PDF version). All three are
// conversions — the lossless artifact is the ENSDF text format itself, and
// each output says so in its header.
import { parseDataset, tx, nucName, nucParts, commentParts, GENERAL_LABELS, type Dataset, type Level } from "./ensdf.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const revised = (d: string) => (/^\d{6}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}` : d);

/** "180YB B- DECAY" → "¹⁸⁰Yb β⁻ Decay"; reaction strings pass through. */
const prettyDsid = (dsid: string): string => {
  const toks = dsid.split(/\s+/);
  return toks
    .map((t, i) => {
      if (/^\d+[A-Z]{1,2}$/.test(t)) return nucName(t);
      if (t === "B-") return "β⁻";
      if (t === "B+") return "β⁺";
      if (t === "A" && /^DECAY/.test(toks[i + 1] ?? "")) return "α";
      if (/^[A-Z]+[,.]?$/.test(t)) return t.charAt(0) + t.slice(1).toLowerCase();
      return t;
    })
    .join(" ");
};

const feedLabel = { B: "β⁻", E: "ε/β⁺", A: "α" } as const;

/** Record comments arrive as "SYM$text" (T$…, E$…) or "$text" — label them cleanly. */
const cmtTx = (c: string, mode: "md" | "plain"): string => {
  const m = /^([^$]{0,24})\$(.*)$/.exec(c);
  if (!m) return tx(c, mode);
  const sym = tx(m[1].trim(), mode);
  const text = tx(m[2].trim(), mode);
  return sym ? (mode === "md" ? `**${sym}:** ${text}` : `${sym}: ${text}`) : text;
};

const levelNotes = (lv: Level, mode: "md" | "plain"): string => {
  const parts: string[] = [];
  if (lv.extra.length) parts.push(lv.extra.map((x) => tx(x, mode)).join("; "));
  for (const fd of lv.feeds) {
    const bits = [fd.ib && `I=${fd.ib}`, fd.logft && `log ft=${fd.logft}`, ...fd.extra.map((x) => tx(x, mode))].filter(Boolean);
    parts.push(`${feedLabel[fd.kind]} feeding${bits.length ? ` (${bits.join(", ")})` : ""}${fd.comments.length ? `: ${fd.comments.map((c) => cmtTx(c, mode)).join(" ")}` : ""}`);
  }
  parts.push(...lv.comments.map((c) => cmtTx(c, mode)));
  return parts.join(" · ");
};

const generalBlocks = (ds: Dataset, mode: "md" | "plain") =>
  ds.general.map((c) => {
    const { sym, text } = commentParts(c);
    const label = GENERAL_LABELS[sym] ?? (sym ? tx(sym, mode) : "");
    return { label, text: tx(text, mode) };
  });

const preamble = (kind: string, src: string) =>
  `${kind} conversion of ENSDF card data · source: NNDC ${src.toUpperCase()} archival distribution, served from nsr.nysgpt.com's parsed copy · ` +
  `notation Unicode-normalized (γ, β⁻, ⁺, ½…) · the lossless original is the "ENSDF text format" export`;

/* ── Markdown ──────────────────────────────────────────────────────────── */

export function toMarkdown(decks: string[], src: string): string {
  const out: string[] = [`> ${preamble("Markdown", src)}`, ""];
  for (const raw of decks) {
    const ds = parseDataset(raw);
    const name = ds.sym ? nucName(ds.nucid) : `A=${ds.a}`;
    out.push(`# ${name} — ${prettyDsid(ds.dsid)}`);
    const meta: string[] = [];
    if (ds.history.TYP) meta.push(`**Type:** ${ds.history.TYP === "FUL" ? "Full Evaluation" : ds.history.TYP}`);
    if (ds.history.AUT) meta.push(`**Evaluator:** ${ds.history.AUT}`);
    if (ds.history.CIT) meta.push(`**Citation:** ${ds.history.CIT}`);
    if (ds.history.CUT) meta.push(`**Literature cutoff:** ${ds.history.CUT}`);
    if (ds.date) meta.push(`**Revised:** ${revised(ds.date)}`);
    if (ds.dsref) meta.push(`**Key refs:** ${ds.dsref}`);
    if (meta.length) out.push(meta.join(" · "), "");
    if (ds.q) {
      const q = [ds.q.qm && `**Q(β⁻)** = ${ds.q.qm}`, ds.q.sn && `**S(n)** = ${ds.q.sn}`, ds.q.sp && `**S(p)** = ${ds.q.sp}`, ds.q.qa && `**Q(α)** = ${ds.q.qa}`].filter(Boolean);
      out.push(`${q.join(" · ")}${ds.q.ref ? ` _(${ds.q.ref})_` : ""} — keV`, "");
    }
    for (const p of ds.parents) {
      out.push(`**Parent:** E=${p.e || "0"} keV · Jπ=${tx(p.jpi, "md") || "—"} · T½=${p.t12 || "—"}${p.qp ? ` · Q(gs)=${p.qp}` : ""}`, "");
    }
    for (const g of generalBlocks(ds, "md")) out.push(g.label ? `**${g.label}:** ${g.text}` : g.text, "");
    if (ds.levels.length) {
      const anyFeed = ds.levels.some((l) => l.feeds.length > 0);
      out.push(`## Levels (${ds.levels.length})`, "");
      out.push(`| E(level) [keV] | Jπ | T½ | ${anyFeed ? "Feeding & comments" : "Comments"} |`);
      out.push("|---|---|---|---|");
      for (const lv of ds.levels) {
        out.push(`| ${lv.e}${lv.de ? ` ${lv.de}` : ""} | ${tx(lv.jpi, "md") || "—"} | ${lv.t12 ? `${lv.t12}${lv.dt ? ` ${lv.dt}` : ""}` : "—"} | ${levelNotes(lv, "md").replace(/\|/g, "\\|") || "—"} |`);
      }
      out.push("");
    }
    const gammas = ds.levels.flatMap((lv) => lv.gammas.map((g) => ({ from: lv.e, g }))).concat(ds.unplacedGammas.map((g) => ({ from: "", g })));
    if (gammas.length) {
      out.push(`## γ rays (${gammas.length})`, "");
      out.push("| From level [keV] | Eγ [keV] | Iγ | Mult. | α | Comments |");
      out.push("|---|---|---|---|---|---|");
      for (const { from, g } of gammas) {
        const notes = [...g.extra.map((x) => tx(x, "md")), ...g.comments.map((c) => cmtTx(c, "md"))].join(" · ");
        out.push(`| ${from || "—"} | ${g.e}${g.de ? ` ${g.de}` : ""} | ${g.ri || "—"} | ${tx(g.mult, "md") || "—"} | ${g.cc || "—"} | ${notes.replace(/\|/g, "\\|") || "—"} |`);
      }
      out.push("");
    }
    if (ds.other.length) {
      out.push("<details><summary>Other records (normalization, cross-reference…)</summary>", "", "```", ...ds.other, "```", "", "</details>", "");
    }
    out.push("---", "");
  }
  return out.join("\n");
}

/* ── llms.txt ──────────────────────────────────────────────────────────── */

export function toLlms(decks: string[], src: string): string {
  const out: string[] = ["# ENSDF export · machine-readable", `# ${preamble("Line-oriented", src)}`, `# datasets: ${decks.length}`, ""];
  for (const raw of decks) {
    const ds = parseDataset(raw);
    const { z } = nucParts(ds.nucid);
    out.push(`dataset: ${ds.nucid} | ${ds.dsid}`);
    out.push(`nuclide: ${ds.sym ? nucName(ds.nucid) : `mass chain A=${ds.a}`}${z >= 0 && ds.sym ? ` (A=${ds.a} Z=${z} N=${ds.a - z})` : ""}`);
    if (ds.date) out.push(`revised: ${revised(ds.date)}`);
    if (Object.keys(ds.history).length) out.push(`history: ${Object.entries(ds.history).map(([k, v]) => `${k}=${v}`).join(" | ")}`);
    if (ds.dsref) out.push(`key-refs: ${ds.dsref}`);
    if (ds.q) out.push(`q-record: Q-=${ds.q.qm || "?"} | Sn=${ds.q.sn || "?"} | Sp=${ds.q.sp || "?"} | Qa=${ds.q.qa || "?"}${ds.q.ref ? ` | ref=${ds.q.ref}` : ""} (keV)`);
    for (const p of ds.parents) out.push(`parent: E=${p.e || "0"} | Jpi=${tx(p.jpi)} | T1/2=${p.t12}${p.qp ? ` | Qgs=${p.qp}` : ""}`);
    for (const g of generalBlocks(ds, "plain")) out.push(`comment${g.label ? `(${g.label})` : ""}: ${g.text}`);
    for (const lv of ds.levels) {
      out.push(`level: E=${lv.e}${lv.de ? `(${lv.de})` : ""} | Jpi=${tx(lv.jpi) || "?"}${lv.t12 ? ` | T1/2=${lv.t12}${lv.dt ? `(${lv.dt})` : ""}` : ""}`);
      for (const x of lv.extra) out.push(`  quantity: ${tx(x)}`);
      for (const fd of lv.feeds) out.push(`  feed(${feedLabel[fd.kind]}): I=${fd.ib || "?"}${fd.logft ? ` | logft=${fd.logft}` : ""}${fd.extra.length ? ` | ${fd.extra.map((x) => tx(x)).join(" | ")}` : ""}${fd.comments.length ? ` | ${fd.comments.map((c) => tx(c)).join(" ")}` : ""}`);
      for (const c of lv.comments) out.push(`  comment: ${cmtTx(c, "plain")}`);
      for (const g of lv.gammas) {
        out.push(`  gamma: E=${g.e}${g.de ? `(${g.de})` : ""}${g.ri ? ` | RI=${g.ri}` : ""}${g.mult ? ` | mult=${tx(g.mult)}` : ""}${g.mr ? ` | MR=${g.mr}` : ""}${g.cc ? ` | alpha=${g.cc}` : ""}${g.ti ? ` | TI=${g.ti}` : ""}`);
        for (const x of g.extra) out.push(`    quantity: ${tx(x)}`);
        for (const c of g.comments) out.push(`    comment: ${cmtTx(c, "plain")}`);
      }
    }
    for (const g of ds.unplacedGammas) out.push(`gamma(unplaced): E=${g.e}${g.ri ? ` | RI=${g.ri}` : ""}`);
    if (ds.other.length) { out.push("other-cards:"); for (const l of ds.other) out.push(`  ${l.replace(/\s+$/, "")}`); }
    out.push("");
  }
  return out.join("\n");
}

/* ── typeset print view (Save-as-PDF) ──────────────────────────────────── */

const nucHtml = (nucid: string): string => {
  const { a, sym, z } = nucParts(nucid);
  if (!a) return esc(nucid);
  if (!sym || z < 0) return `A=${a}`;
  return `<sup>${a}</sup><sub>${z}</sub>${esc(sym)}<sub>${a - z}</sub>`;
};

export function toTypesetHtml(decks: string[], src: string): string {
  const sections = decks.map((raw) => {
    const ds = parseDataset(raw);
    const corner = nucHtml(ds.nucid);
    const h: string[] = [];
    h.push(`<div class="corners"><span>${corner}</span><span class="mid">From ${src === "xundl" ? "XUNDL" : "ENSDF"}</span><span>${corner}</span></div><hr class="rule"/>`);
    h.push(`<h2 class="dsid">${esc(prettyDsid(ds.dsid))}</h2>`);
    if (Object.keys(ds.history).length) {
      h.push(`<div class="hist"><div class="histhead">History</div><table class="histtab"><tr><th>Type</th><th>Author</th><th>Citation</th><th>Literature Cutoff Date</th></tr><tr><td>${esc(ds.history.TYP === "FUL" ? "Full Evaluation" : ds.history.TYP ?? "")}</td><td>${esc(ds.history.AUT ?? "")}</td><td>${esc(ds.history.CIT ?? "")}</td><td>${esc(ds.history.CUT ?? "")}</td></tr></table></div>`);
    }
    if (ds.q) {
      const q = [ds.q.qm && `Q(β⁻)=${ds.q.qm}`, ds.q.sn && `S(n)=${ds.q.sn}`, ds.q.sp && `S(p)=${ds.q.sp}`, ds.q.qa && `Q(α)=${ds.q.qa}`].filter(Boolean).join("; ");
      h.push(`<p class="q">${esc(q)}${ds.q.ref ? `&nbsp;&nbsp;<span class="ref">${esc(ds.q.ref)}</span>` : ""}</p>`);
    }
    for (const p of ds.parents) {
      h.push(`<p class="q">Parent: E=${esc(p.e || "0")} keV; Jπ=${esc(tx(p.jpi))}; T½=${esc(p.t12 || "—")}${p.qp ? `; Q(gs)=${esc(p.qp)}` : ""}</p>`);
    }
    for (const g of generalBlocks(ds, "plain")) {
      h.push(`<p class="cmt">${g.label ? `<b>${esc(g.label)}:</b> ` : ""}${esc(g.text)}</p>`);
    }
    if (ds.levels.length) {
      h.push(`<h3 class="mid2">${ds.sym ? `<sup>${ds.a}</sup>${esc(ds.sym)}` : `A=${ds.a}`} Levels</h3>`);
      h.push(`<table class="data"><tr><th>E(level)&nbsp;[keV]</th><th>Jπ</th><th>T½</th><th class="left">Comments</th></tr>`);
      for (const lv of ds.levels) {
        h.push(`<tr><td>${esc(lv.e)}${lv.de ? ` <i>${esc(lv.de)}</i>` : ""}</td><td>${esc(tx(lv.jpi)) || "&nbsp;"}</td><td>${esc(lv.t12 ? `${lv.t12}${lv.dt ? ` ${lv.dt}` : ""}` : "")}</td><td class="left">${esc(levelNotes(lv, "plain"))}</td></tr>`);
      }
      h.push(`</table>`);
    }
    const gammas = ds.levels.flatMap((lv) => lv.gammas.map((g) => ({ from: lv.e, g }))).concat(ds.unplacedGammas.map((g) => ({ from: "", g })));
    if (gammas.length) {
      h.push(`<h3 class="mid2">γ(<sup>${ds.a}</sup>${esc(ds.sym)})</h3>`);
      h.push(`<table class="data"><tr><th>From level</th><th>Eγ&nbsp;[keV]</th><th>Iγ</th><th>Mult.</th><th>α</th><th class="left">Comments</th></tr>`);
      for (const { from, g } of gammas) {
        const notes = [...g.extra.map((x) => tx(x)), ...g.comments.map((c) => cmtTx(c, "plain"))].join(" · ");
        h.push(`<tr><td>${esc(from) || "&nbsp;"}</td><td>${esc(g.e)}${g.de ? ` <i>${esc(g.de)}</i>` : ""}</td><td>${esc(g.ri)}</td><td>${esc(tx(g.mult))}</td><td>${esc(g.cc)}</td><td class="left">${esc(notes)}</td></tr>`);
      }
      h.push(`</table>`);
    }
    if (ds.other.length) h.push(`<div class="other"><div class="otherhead">Other records</div><pre>${esc(ds.other.join("\n"))}</pre></div>`);
    return `<section>${h.join("\n")}</section>`;
  });
  return `<!doctype html><html><head><meta charset="utf-8"/><title>ENSDF datasets</title><style>
  body{font:13px/1.5 Georgia,'Times New Roman',serif;color:#111;margin:40px auto;max-width:980px;padding:0 24px}
  section{margin-bottom:56px;page-break-after:always}
  .corners{display:flex;justify-content:space-between;align-items:baseline;font-size:14px}
  .corners .mid{font-size:13px}
  .rule{border:none;border-top:2px solid #111;margin:4px 0 18px}
  .dsid{text-align:center;font-size:15px;margin:10px 0 16px;text-decoration:underline}
  .hist{text-align:center;margin-bottom:14px}
  .histhead{font-size:13px;margin-bottom:2px}
  .histtab{margin:0 auto;border-collapse:collapse}
  .histtab th{font-weight:normal;text-decoration:underline;padding:0 16px;font-size:12.5px}
  .histtab td{text-align:center;padding:2px 16px;font-size:12.5px}
  .q{margin:6px 0}
  .ref{color:#144a9c}
  .cmt{margin:8px 0;text-align:justify}
  .mid2{text-align:center;font-size:14px;font-weight:normal;text-decoration:underline;margin:26px 0 10px}
  table.data{border-collapse:collapse;margin:0 auto;width:100%}
  table.data th{font-weight:normal;text-decoration:underline;padding:2px 10px;font-size:12.5px;text-align:center}
  table.data td{padding:2px 10px;vertical-align:top;font-size:12.5px;text-align:center}
  table.data .left{text-align:left}
  .other{margin-top:22px}
  .otherhead{font-size:12px;color:#555;margin-bottom:4px}
  .other pre{font:10.5px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre;overflow-x:auto;color:#333}
  @media print{body{margin:0;max-width:none}}
  </style></head><body>${sections.join("\n")}<script>window.print()</script></body></html>`;
}
