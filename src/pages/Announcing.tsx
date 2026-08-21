import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Minus, X } from "lucide-react";

/* ------------------------------------------------------------------ *
 *  ANNOUNCING CSHL-CPT — the model launch page.
 *
 *  Every number on this page comes from docs/CSHL-CPT-REPORT.md or the
 *  lane logs it cites (docs/prompts/LANE-QPAIRS-RUN.md, LANE-RERANK.md,
 *  LANE-WIN.md). Nothing is rounded up and no loss is omitted: the arms
 *  we lose to are on the same charts as the arms we beat, and the fine
 *  print at the bottom carries the p-values, the caveats and the spend.
 *
 *  Chart colors live in src/index.css as --color-chart-* so the SVGs
 *  theme with the rest of the site (amber-on-black in dark, ink on
 *  white in light) instead of hardcoding hexes. The two categorical
 *  fills were checked with the dataviz validator: adjacent-pair CVD
 *  separation deltaE 18.9 (light) / 20.8 (dark), normal-vision 19.7 /
 *  21.8, both accents >= 3:1 against their surface. The neutral is a
 *  deliberate gray — "not one of ours" is a de-emphasis, not a hue.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Data — frozen benchmark cshl-eval-2k, 2,000 queries                */
/* ------------------------------------------------------------------ */

type Kind = "ours" | "fusion" | "base";

interface Row {
  label: string;
  sub: string;
  mesh: number;
  authorkw: number;
  kind: Kind;
  note: string;
}

/** Encoder-level retrieval: R@10 against the full 433,449-paper corpus. */
const RETRIEVAL: Row[] = [
  {
    label: "CSHL-CPT + MedCPT + full-text",
    sub: "fusion — best measured",
    mesh: 0.5197,
    authorkw: 0.83,
    kind: "fusion",
    note: "Reciprocal-rank fusion of our encoder, NLM's and Postgres full-text. The best arm anyone ran on this benchmark.",
  },
  {
    label: "ncbi/MedCPT",
    sub: "National Library of Medicine",
    mesh: 0.4569,
    authorkw: 0.8076,
    kind: "base",
    note: "Purpose-built biomedical retriever, trained on PubMed query-click logs. The bar this page is measured against.",
  },
  {
    label: "CSHL-CPT + full-text",
    sub: "fusion — ours only",
    mesh: 0.4512,
    authorkw: 0.7655,
    kind: "fusion",
    note: "Our encoder fused with Postgres full-text search. The best configuration built entirely from our own arms.",
  },
  {
    label: "CSHL-CPT",
    sub: "ours — live in production",
    mesh: 0.4319,
    authorkw: 0.7497,
    kind: "ours",
    note: "The query-pairs encoder, serving now. Statistically tied with MedCPT on MeSH (p = 0.071).",
  },
  {
    label: "allenai/specter2_base",
    sub: "scholarly encoder",
    mesh: 0.3513,
    authorkw: 0.726,
    kind: "base",
    note: "The base encoder without the proximity adapter — TEI cannot load adapters. Labelled honestly, not as full SPECTER2.",
  },
  {
    label: "CSHL-CITE",
    sub: "ours — earlier run",
    mesh: 0.332,
    authorkw: 0.6693,
    kind: "ours",
    note: "Our first encoder, trained on citation pairs. Still the better document-to-document model; worse at answering queries.",
  },
  {
    label: "BAAI/bge-m3",
    sub: "stock, untrained",
    mesh: 0.2861,
    authorkw: 0.6522,
    kind: "base",
    note: "The general multilingual model we fine-tuned from — and what this site's search ran on until today.",
  },
  {
    label: "Postgres full-text",
    sub: "keyword baseline",
    mesh: 0.0806,
    authorkw: 0.2398,
    kind: "base",
    note: "websearch_to_tsquery, AND semantics. Worst arm alone by a factor of five — and the largest single contributor in fusion.",
  },
];

/** System-level: an encoder's top-50 candidates, reordered by a cross-encoder. */
interface SysRow {
  label: string;
  sub: string;
  value: number;
  kind: Kind;
  note: string;
}

const SYSTEMS: SysRow[] = [
  {
    label: "MedCPT + MedCPT-Cross-Encoder",
    sub: "NLM's full stack",
    value: 0.651,
    kind: "base",
    note: "Their retriever and their reranker, each at the configuration its model card specifies. This is the system that beats ours.",
  },
  {
    label: "MedCPT + CSHL-RR",
    sub: "their candidates, our reranker",
    value: 0.65,
    kind: "fusion",
    note: "Same candidate pool, rerankers swapped: a statistical dead heat (-0.0010, p = 0.93). On MeSH queries alone ours wins outright.",
  },
  {
    label: "CSHL-CPT + CSHL-RR",
    sub: "ours end to end",
    value: 0.616,
    kind: "ours",
    note: "Our encoder and our reranker. Loses the blended comparison by 0.0350 (p = 0.0002) — and the gap is the encoder, not the reranker.",
  },
  {
    label: "ncbi/MedCPT",
    sub: "encoder only",
    value: 0.59,
    kind: "base",
    note: "One vector lookup, no reranking. Their reranker adds +0.0610 on top of this.",
  },
  {
    label: "CSHL-CPT",
    sub: "encoder only",
    value: 0.5525,
    kind: "ours",
    note: "One vector lookup, no reranking. Our reranker adds +0.0635 on top of this (p = 6.4e-17).",
  },
];

/* ------------------------------------------------------------------ */
/*  Chart primitives — inline SVG, measured width, no chart library     */
/* ------------------------------------------------------------------ */

/** Element width, live. Charts need real pixels: a viewBox that scales
 *  would shrink the axis text to nothing on a phone. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setW(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const fillOf = (kind: Kind) =>
  kind === "base" ? "var(--color-chart-base)" : "var(--color-chart-ours)";

/** A bar with a 4px rounded data-end and a square baseline. */
function barPath(x0: number, y: number, len: number, h: number) {
  const r = Math.min(4, Math.max(0, len));
  const x1 = x0 + Math.max(len, 0.5);
  return `M${x0},${y} H${x1 - r} A${r},${r} 0 0 1 ${x1},${y + r} V${y + h - r} A${r},${r} 0 0 1 ${x1 - r},${y + h} H${x0} Z`;
}

interface BarDatum {
  label: string;
  sub: string;
  value: number;
  kind: Kind;
  note: string;
}

function BarChart({
  data,
  max,
  ticks,
  caption,
}: {
  data: BarDatum[];
  max: number;
  ticks: number[];
  caption: string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const stacked = w > 0 && w < 620;
  const rowH = stacked ? 58 : 44;
  const barH = stacked ? 16 : 18;
  const labelW = stacked ? 0 : 246;
  const valueW = stacked ? 0 : 58;
  const padTop = stacked ? 20 : 26;
  const height = padTop + data.length * rowH + 6;
  const x0 = labelW;
  const x1 = Math.max(x0 + 40, w - valueW);
  const innerW = x1 - x0;
  const scale = (v: number) => (v / max) * innerW;

  return (
    <figure className="m-0">
      <div ref={ref} className="relative w-full">
        {w > 0 && (
          <svg
            width={w}
            height={height}
            role="img"
            aria-label={caption}
            className="block overflow-visible"
            onMouseLeave={() => setHover(null)}
          >
            <defs>
              {/* Fusions contain one of our arms and one of theirs — hatched so
                  identity never rests on hue alone. */}
              <pattern id="fusionHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill="var(--color-chart-ours)" opacity="0.28" />
                <rect width="2.5" height="6" fill="var(--color-chart-ours)" />
              </pattern>
            </defs>

            {/* Gridlines + tick labels — hairline, one step off the surface */}
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={x0 + scale(t)}
                  x2={x0 + scale(t)}
                  y1={padTop - 8}
                  y2={height - 6}
                  stroke="var(--color-border)"
                  strokeWidth={1}
                />
                <text
                  x={x0 + scale(t)}
                  y={padTop - 14}
                  textAnchor={t === 0 ? "start" : t === ticks[ticks.length - 1] ? "end" : "middle"}
                  className="fill-muted-foreground"
                  style={{ fontSize: 10, fontVariantNumeric: "tabular-nums" }}
                >
                  {t.toFixed(1)}
                </text>
              </g>
            ))}

            {data.map((d, i) => {
              const top = padTop + i * rowH;
              const barY = stacked ? top + 30 : top + (rowH - barH) / 2;
              const len = scale(d.value);
              const active = hover === i;
              return (
                <g
                  key={d.label}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  tabIndex={0}
                  style={{ outline: "none" }}
                >
                  <title>{`${d.label} — ${d.value.toFixed(4)}`}</title>
                  {/* hit target: the whole row, always taller than the mark */}
                  <rect x={0} y={top} width={Math.max(w, 1)} height={rowH} fill="transparent" />

                  {stacked ? (
                    <>
                      <text x={0} y={top + 13} className="fill-foreground" style={{ fontSize: 12, fontWeight: 600 }}>
                        {d.label}
                      </text>
                      <text x={0} y={top + 25} className="fill-muted-foreground" style={{ fontSize: 10 }}>
                        {d.sub}
                      </text>
                      <text
                        x={w}
                        y={top + 13}
                        textAnchor="end"
                        className="fill-foreground"
                        style={{ fontSize: 12, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}
                      >
                        {d.value.toFixed(4)}
                      </text>
                    </>
                  ) : (
                    <>
                      <text
                        x={labelW - 14}
                        y={top + rowH / 2 - 1}
                        textAnchor="end"
                        className="fill-foreground"
                        style={{ fontSize: 12.5, fontWeight: d.kind === "base" ? 400 : 600 }}
                      >
                        {d.label}
                      </text>
                      <text
                        x={labelW - 14}
                        y={top + rowH / 2 + 12}
                        textAnchor="end"
                        className="fill-muted-foreground"
                        style={{ fontSize: 10 }}
                      >
                        {d.sub}
                      </text>
                      <text
                        x={x0 + len + 8}
                        y={top + rowH / 2 + 4}
                        className="fill-foreground"
                        style={{ fontSize: 12, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}
                      >
                        {d.value.toFixed(4)}
                      </text>
                    </>
                  )}

                  <path
                    d={barPath(x0, barY, len, barH)}
                    fill={d.kind === "fusion" ? "url(#fusionHatch)" : fillOf(d.kind)}
                    opacity={hover === null || active ? 1 : 0.55}
                    style={{ transition: "opacity 120ms ease" }}
                  />
                </g>
              );
            })}
          </svg>
        )}

        {hover !== null && (
          <div
            className="pointer-events-none absolute z-20 max-w-[300px] rounded-lg border bg-background px-3 py-2 text-xs leading-relaxed text-muted-foreground shadow-lg"
            style={{
              top: padTop + hover * rowH + rowH + 2,
              left: stacked ? 0 : Math.min(labelW, Math.max(0, w - 300)),
            }}
          >
            <span className="block font-semibold text-foreground">{data[hover].label}</span>
            {data[hover].note}
          </div>
        )}
      </div>

      <figcaption className="mt-3 text-xs leading-relaxed text-muted-foreground">{caption}</figcaption>
    </figure>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-2">
        <span className="h-2.5 w-6 rounded-[2px]" style={{ background: "var(--color-chart-ours)" }} />
        Ours
      </span>
      <span className="inline-flex items-center gap-2">
        <span
          className="h-2.5 w-6 rounded-[2px]"
          style={{
            backgroundImage:
              "repeating-linear-gradient(45deg, var(--color-chart-ours) 0 2.5px, color-mix(in oklab, var(--color-chart-ours) 28%, transparent) 2.5px 6px)",
          }}
        />
        Fusion — ours + a baseline
      </span>
      <span className="inline-flex items-center gap-2">
        <span className="h-2.5 w-6 rounded-[2px]" style={{ background: "var(--color-chart-base)" }} />
        Baselines
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page pieces                                                        */
/* ------------------------------------------------------------------ */

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="border-t pt-4">
      <div className="text-2xl font-bold tracking-tight tabular-nums md:text-3xl">{value}</div>
      <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{label}</div>
    </div>
  );
}

function Claim({
  kicker,
  title,
  stat,
  statLabel,
  children,
}: {
  kicker: string;
  title: string;
  stat: string;
  statLabel: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-6 border-t py-10 md:grid-cols-[1fr_230px] md:gap-12 md:py-14">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{kicker}</p>
        <h2 className="mt-3 text-2xl font-bold leading-tight tracking-tight md:text-3xl">{title}</h2>
        <div className="mt-4 space-y-3 text-[15px] leading-relaxed text-muted-foreground">{children}</div>
      </div>
      <div className="md:pt-9">
        <div className="rounded-lg border bg-card p-5">
          <div className="text-3xl font-bold tracking-tight tabular-nums text-brand">{stat}</div>
          <div className="mt-2 text-xs leading-relaxed text-muted-foreground">{statLabel}</div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function Announcing() {
  const [family, setFamily] = useState<"mesh" | "authorkw">("mesh");

  const retrieval: BarDatum[] = RETRIEVAL.map((r) => ({
    label: r.label,
    sub: r.sub,
    value: family === "mesh" ? r.mesh : r.authorkw,
    kind: r.kind,
    note: r.note,
  }));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1000px] px-5 py-10 md:px-8 md:py-16">
        {/* ---------------- Hero ---------------- */}
        <header>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand">
            Model release · 20 August 2026
          </p>
          <h1 className="mt-5 text-5xl font-bold leading-[0.95] tracking-tight md:text-7xl">CSHL-CPT</h1>
          <p className="mt-6 max-w-[640px] text-lg leading-relaxed text-muted-foreground md:text-xl">
            A retrieval model trained on 433,449 bioRxiv and medRxiv preprints — and, on expert-topic
            search, statistically tied with the National Library of Medicine's own biomedical model.
          </p>
          <p className="mt-5 flex flex-wrap items-center gap-2 text-sm">
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-brand" />
            <span className="font-medium">Live now on cshl.nysgpt.com</span>
            <span className="text-muted-foreground">— every question you ask RxivGPT retrieves through it.</span>
          </p>

          <div className="mt-10 grid grid-cols-2 gap-5 md:grid-cols-4 md:gap-8">
            <Stat value="433,449" label="preprints indexed, every one of them embedded and coverage-gated" />
            <Stat value="+51%" label="better at finding the right paper than the encoder it replaced" />
            <Stat value="55 min" label="of training on one rented GPU, one pass over the data" />
            <Stat value="$2.95" label="total cost to train it and re-index the entire corpus" />
          </div>
        </header>

        {/* ---------------- Chart 1 ---------------- */}
        <section className="mt-14 border-t pt-10 md:mt-20">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold tracking-tight md:text-3xl">Finding one paper in 433,449</h2>
              <p className="mt-2 max-w-[620px] text-sm leading-relaxed text-muted-foreground">
                How often the right paper lands in the top ten results, on 2,000 expert queries frozen
                before any model was trained. Higher is better.
              </p>
            </div>
            <div className="inline-flex rounded-lg border p-0.5 text-xs">
              {(
                [
                  ["mesh", "Topic terms"],
                  ["authorkw", "Author keywords"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setFamily(k)}
                  className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
                    family === k ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-6">
            <Legend />
          </div>
          <div className="mt-5">
            <BarChart
              data={retrieval}
              max={family === "mesh" ? 0.6 : 1.0}
              ticks={family === "mesh" ? [0, 0.2, 0.4, 0.6] : [0, 0.25, 0.5, 0.75, 1.0]}
              caption={
                family === "mesh"
                  ? "Recall@10 on 1,241 MeSH-descriptor queries — the topic terms a professional indexer assigns to a paper. Retrieved against all 433,449 papers, not a shortlist."
                  : "Recall@10 on 759 author-keyword queries — the terms the authors chose themselves. Retrieved against all 433,449 papers, not a shortlist."
              }
            />
          </div>
        </section>

        {/* ---------------- Chart 2 ---------------- */}
        <section className="mt-14 border-t pt-10">
          <h2 className="text-2xl font-bold tracking-tight md:text-3xl">And with a reranker on top</h2>
          <p className="mt-2 max-w-[620px] text-sm leading-relaxed text-muted-foreground">
            A second model can reread the top fifty candidates and reorder them. We trained one of
            those too. Measured across all 2,000 queries — and this is the comparison we lose.
          </p>
          <div className="mt-6">
            <Legend />
          </div>
          <div className="mt-5">
            <BarChart
              data={SYSTEMS}
              max={0.7}
              ticks={[0, 0.2, 0.4, 0.6]}
              caption="Recall@10, both families pooled. Our complete system trails NLM's by 0.0350 (p = 0.0002). Hand our reranker their candidates and the two rerankers tie (−0.0010, p = 0.93); on topic-term queries ours wins by 0.0193 (p = 0.013). The gap is our retriever, not our reranker. The reranker is measured, not deployed."
            />
          </div>
        </section>

        {/* ---------------- Claims ---------------- */}
        <Claim
          kicker="How it was made"
          title="Trained on the science itself"
          stat="$2.95"
          statLabel="one L40S GPU for 55 minutes, plus re-embedding all 433,449 papers. The whole model program — four training runs, five baselines, every mistake — came to $11.92."
        >
          <p>
            The model learned from the way scientists already describe their own work. Every paper in
            the corpus carries topic terms assigned by professional indexers and keywords written by
            the authors themselves, so each one is a real question with a known right answer. We mined
            424,753 of those pairs out of the corpus and trained on 39,999 of them.
          </p>
          <p>
            No synthetic data, no labelling budget, no annotators. One pass over the data, one night,
            one rented GPU. The earlier version of this model learned from citation structure instead —
            which paper cites which — and it is still the better model at finding papers similar to a
            paper. It is simply worse at answering a question, and a search box takes questions.
          </p>
        </Claim>

        <Claim
          kicker="What changed today"
          title="Search got better today"
          stat="+51%"
          statLabel="topic-term Recall@10, 0.2861 → 0.4319, against the off-the-shelf encoder this site's retrieval ran on until today."
        >
          <p>
            RxivGPT used to search with a general-purpose model that had never seen a preprint. It now
            searches with one trained on this corpus. On topic queries the right paper reaches the top
            ten half again as often as it did; on author keywords, 15% more often.
          </p>
          <p>
            Against our own first attempt the gain is +0.0999 with a paired test at p = 2.3e-16 — 180
            queries won against 56 lost, on the same 1,241 questions in the same order. The switch is
            one environment variable, and both older vector spaces are still populated and one variable
            away, so the rollback is real rather than theoretical.
          </p>
        </Claim>

        <Claim
          kicker="How it compares"
          title="Measured against the best there is"
          stat="p = 0.071"
          statLabel="our encoder against ncbi/MedCPT on topic queries: a 0.0250 difference whose 95% interval, [−0.0516, +0.0016], contains zero."
        >
          <p>
            The National Library of Medicine trained MedCPT on tens of millions of real PubMed searches
            and the clicks that followed them. It is the model to beat at biomedical search, and on
            topic-term queries we can no longer tell the two apart: the difference between us is inside
            the noise of the measurement.
          </p>
          <p>
            Our reranker goes one step further. Handed the same fifty candidates NIH's own reranker
            gets, ours picks the right papers better on topic questions — 0.5439 against 0.5246, p =
            0.013 — and that combination is the best result any configuration produced. On author
            keywords their models are still clearly better, and that is on the chart above rather than
            in a footnote.
          </p>
        </Claim>

        <Claim
          kicker="How we know"
          title="An honest scoreboard"
          stat="0.8076"
          statLabel="MedCPT on author-keyword queries, against our 0.7497. A loss, p = 0.0003, and the reason to believe the wins."
        >
          <p>
            No public benchmark existed for preprint search, so we built one and then measured
            ourselves on it alongside everyone else. 433,449 papers, 2,000 queries frozen before a
            single model was trained, a quarter of the corpus held out by paper so no model can be
            tested on something it studied. Every arm ran on the same corpus with the same code — and
            each model was scored with the similarity function its own authors published it for, which
            is the difference between a baseline and a strawman.
          </p>
          <p>
            Where the incumbent still wins: author-keyword queries, which read more like keyword lookup
            than like a topic, and the full system comparison. Plain Postgres full-text search — the
            worst arm on this page by a factor of five on its own — still contributes between one and a
            half and twice what our model does to the best fusion. Lexical and dense retrieval fail on
            different queries, and this corpus demonstrates it cleanly.
          </p>
          <p>
            A second team scored the baseline arms with a scorer written independently of ours,
            deliberately, so that agreement would be evidence rather than a shared bug. All four arms
            agreed to four decimal places.
          </p>
        </Claim>

        {/* ---------------- CTA ---------------- */}
        <section className="border-t py-12 text-center md:py-16">
          <h2 className="text-2xl font-bold tracking-tight md:text-4xl">Try it</h2>
          <p className="mx-auto mt-3 max-w-[520px] text-sm leading-relaxed text-muted-foreground">
            Ask a real question — a mechanism, a disease, a method. Every answer is retrieved from the
            433,449 preprints by the model above and cites the papers it used.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <a
              href="/"
              className="inline-flex items-center gap-2 rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-colors hover:bg-foreground/85"
            >
              Ask RxivGPT
              <ArrowRight className="h-4 w-4" />
            </a>
            <a
              href="/search"
              className="inline-flex items-center gap-2 rounded-lg border px-5 py-2.5 text-sm font-medium transition-colors hover:bg-muted"
            >
              Keyword search
            </a>
          </div>
        </section>

        {/* ---------------- Fine print ---------------- */}
        <FinePrint />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Fine print — the receipts                                          */
/* ------------------------------------------------------------------ */

function FootRow({ verdict, children }: { verdict: "win" | "tie" | "loss"; children: React.ReactNode }) {
  const Icon = verdict === "win" ? Check : verdict === "tie" ? Minus : X;
  return (
    <li className="flex items-start gap-2.5">
      <Icon className="mt-[3px] h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span>{children}</span>
    </li>
  );
}

function FinePrint() {
  return (
    <section className="border-t pt-10 text-xs leading-relaxed text-muted-foreground">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground">The fine print</h2>

      <div className="mt-6 grid gap-8 md:grid-cols-2">
        <div className="space-y-4">
          <div>
            <p className="font-semibold text-foreground">The benchmark</p>
            <p className="mt-1">
              <span className="font-mono">cshl-eval-2k</span>, a frozen 2,000-query subsample of{" "}
              <span className="font-mono">cshl-eval-v1</span> (frozen 2026-08-19 07:38Z, sha256{" "}
              <span className="break-all font-mono">32433e4d…83cf4594</span>): 1,241 MeSH-descriptor
              queries and 759 author-keyword queries, one gold paper each, retrieved against all
              433,449 papers rather than a per-query shortlist. Papers are split 25% held out by hash
              before training, so a paper's queries cannot straddle the boundary. A third built-in
              query family that uses a paper's own title is leaked by construction and is excluded from
              every number here.
            </p>
          </div>
          <div>
            <p className="font-semibold text-foreground">The metric</p>
            <p className="mt-1">
              R@10 — with one gold paper per query, the share of queries whose answer appears in the
              top ten. nDCG@10 moves the same way throughout and is in the report. Dense arms run at{" "}
              <span className="font-mono">hnsw.ef_search=100</span>, an approximate search: measured
              against exact retrieval it costs 3.1% of top-10 slots, and it costs our arm and MedCPT
              the same to three significant figures, so it is not a hidden handicap on either side.
            </p>
          </div>
          <div>
            <p className="font-semibold text-foreground">Significance</p>
            <p className="mt-1">
              Every comparison is an exact two-sided McNemar test on the same queries in the same
              order, with a seeded 5,000-resample bootstrap interval. Reported as ΔR@10, p, 95% CI.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <p className="font-semibold text-foreground">Every claim on this page, scored</p>
            <ul className="mt-2 space-y-2">
              <FootRow verdict="tie">
                Ours vs ncbi/MedCPT, MeSH: −0.0250, p = 0.071, CI [−0.0516, +0.0016] — the interval
                contains zero.
              </FootRow>
              <FootRow verdict="loss">
                Ours vs ncbi/MedCPT, author keywords: −0.0580, p = 0.0003, CI [−0.0883, −0.0277].
              </FootRow>
              <FootRow verdict="win">
                Ours vs our citation model, MeSH: +0.0999, p = 2.3e-16, CI [+0.0766, +0.1225]; author
                keywords +0.0804, p = 5.0e-9.
              </FootRow>
              <FootRow verdict="loss">
                Our full system vs MedCPT's full system: −0.0350, p = 0.0002, CI [−0.054, −0.016].
              </FootRow>
              <FootRow verdict="tie">
                Same candidates, our reranker vs theirs: −0.0010, p = 0.9312, CI [−0.013, +0.010].
              </FootRow>
              <FootRow verdict="win">
                Same candidates, MeSH only: +0.0193, p = 0.0127, CI [+0.005, +0.034].
              </FootRow>
              <FootRow verdict="loss">
                Document-to-document retrieval: this model is 0.0140 worse than our citation model (p =
                0.043) and indistinguishable from the stock encoder it was fine-tuned from (+0.0025,
                p = 0.78). Query training spent the entire document-similarity advantage citation
                training bought. Both vector spaces stay populated.
              </FootRow>
            </ul>
          </div>
        </div>
      </div>

      <div className="mt-8 space-y-4 border-t pt-6">
        <div>
          <p className="font-semibold text-foreground">Caveats that cut against us</p>
          <p className="mt-1">
            Our reranker was fine-tuned on this domain; MedCPT's cross-encoder has never seen a
            bioRxiv paper, so a tie flatters us. The SPECTER2 arm is{" "}
            <span className="font-mono">allenai/specter2_base</span> without its proximity adapter,
            which the serving stack cannot load, and is labelled that way. This run changed the
            training objective and the batch size together (4 → 8) because a larger GPU was available;
            it cannot fully separate the two, though document-to-document moved in the opposite
            direction at the same batch size, which is what an objective change looks like.
          </p>
        </div>
        <div>
          <p className="font-semibold text-foreground">Caveats that cut in their favour</p>
          <p className="mt-1">
            MedCPT was trained on PubMed, and many of these preprints were later published in
            PubMed-indexed journals, so part of its author-keyword advantage may be familiarity with
            these papers rather than better modelling. It also truncates documents at 512 tokens on a
            corpus we index at 4,000 characters.
          </p>
        </div>
        <div>
          <p className="font-semibold text-foreground">What is and is not deployed</p>
          <p className="mt-1">
            Live: the encoder, serving retrieval for RxivGPT chat, with an automatic fallback to the
            stock model if its box is unreachable — a box failure costs retrieval quality, not the
            hybrid. Not live: the reranker (measured at 150.8 ms p50 per query on a GPU; its CPU cost
            is unmeasured, so the serving tier is undecided) and the fusion arms on the first chart,
            which include models we do not serve. The keyword search page runs Postgres full-text only
            today. Neither model has been published to Hugging Face.
          </p>
        </div>
        <div>
          <p className="font-semibold text-foreground">Sources</p>
          <p className="mt-1">
            Every number above is from <span className="font-mono">docs/CSHL-CPT-REPORT.md</span> and
            the lane logs it cites. Corpus: bioRxiv 345,882 (2013–2026) + medRxiv 87,567 (2019–2026),
            harvested from the public bioRxiv and medRxiv APIs, 100% abstract coverage, coverage gate
            passed 2026-08-20 01:00Z with zero uncovered papers and zero text-hash mismatches.
          </p>
        </div>
        <p className="pt-2">
          RxivGPT is an independent project and is not affiliated with, endorsed by, or sponsored by
          Cold Spring Harbor Laboratory, bioRxiv, medRxiv, the National Library of Medicine or the NIH.
          Preprints are not peer reviewed.
        </p>
      </div>
    </section>
  );
}
