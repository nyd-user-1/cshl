/* ------------------------------------------------------------------ *
 *  /models — the transformer inventory.
 *
 *  Every model this program has trained, and — the point of the page —
 *  which of them are actually wired into the live site. "Trained" and
 *  "serving" are different states and the difference is invisible from
 *  the outside, so it is stated here per model rather than implied.
 *
 *  Status is derived from the deployed configuration, not aspiration:
 *    live      — an env var points at it and requests hit it today
 *    trained   — weights exist and are published, nothing serves them
 *    planned   — data exists, no model trained yet
 *
 *  Numbers come from docs/CSHL-CPT-REPORT.md and the lane logs it cites.
 * ------------------------------------------------------------------ */

type Status = "live" | "trained" | "planned";

type Model = {
  name: string;
  kind: string;
  status: Status;
  what: string;
  measured?: string;
  where: string;
};

const MODELS: Model[] = [
  {
    name: "cshl-QP2",
    kind: "Encoder · 568M · bge-m3 fine-tune",
    status: "live",
    what:
      "Turns a query into a vector and finds the nearest of 433,449 preprints. Trained on 100,000 mined query→paper pairs. This is what every search on this site runs through.",
    measured:
      "MeSH R@10 0.524 · author-keyword 0.764 · beats ncbi/MedCPT head-to-head, p = 0.016",
    where: "/search and /chat, dense arm, fused with keyword search",
  },
  {
    name: "Postgres full-text search",
    kind: "Lexical · not a model",
    status: "live",
    what:
      "Classic keyword matching. Weak alone, but it finds exact strings a dense model misses, which is why the two are fused rather than chosen between.",
    measured: "MeSH R@10 0.081 alone · adds real recall in fusion",
    where: "/search and /chat, lexical arm of the hybrid",
  },
  {
    name: "cshl-RR",
    kind: "Reranker · 149M cross-encoder",
    status: "trained",
    what:
      "Reads the query and each candidate together and re-orders the top 50. Ties the National Library of Medicine's own cross-encoder overall and beats it on concept queries. Needs a serve box and one environment variable to go live.",
    measured:
      "Lifts MeSH R@10 0.524 → 0.549 on top of cshl-QP2 · 151 ms per query",
    where: "Not wired. Published private on Hugging Face.",
  },
  {
    name: "cshl-CITE",
    kind: "Encoder · 568M · bge-m3 fine-tune",
    status: "trained",
    what:
      "Trained on citation pairs, so it answers \"what else is like this paper?\" rather than \"what matches this query?\". Best document-similarity model of the four tested. The right engine for related-papers, reviewer matching and follow-up suggestions.",
    measured: "Document→document R@10 0.212 · beats MedCPT there, p = 0.0001",
    where: "Not wired. Vectors are populated and ready.",
  },
  {
    name: "cshl-QP",
    kind: "Encoder · 568M · bge-m3 fine-tune",
    status: "trained",
    what:
      "The 40,000-pair predecessor to cshl-QP2, kept because it is the measured 40k point on a scaling curve that turned out not to be monotonic.",
    measured: "MeSH R@10 0.432 — superseded by cshl-QP2",
    where: "Retired from serving.",
  },
  {
    name: "cshl-MESH-tagger",
    kind: "Classifier · multi-label",
    status: "planned",
    what:
      "Would assign expert medical concepts to the ~half of the corpus PubMed never indexed, completing the subject labels that scoped search depends on. Training data is built and unused.",
    where: "Not trained.",
  },
  {
    name: "cshl-category",
    kind: "Classifier · single-label, ~76 classes",
    status: "planned",
    what:
      "Would fill and split subject categories so every room in a scoped-search product is coherent and correctly sized. Training data is built and unused.",
    where: "Not trained.",
  },
  {
    name: "Claude (Bedrock)",
    kind: "Generation · rented",
    status: "live",
    what:
      "Writes the answer over the sources our retrieval selected. Deliberately not ours: generation is the one tier where renting beats building, and it is the tier we do not need to own.",
    where: "/chat",
  },
];

const BADGE: Record<Status, { label: string; cls: string }> = {
  live: {
    label: "Live",
    cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ring-1 ring-emerald-500/30",
  },
  trained: {
    label: "Trained, not wired",
    cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400 ring-1 ring-amber-500/30",
  },
  planned: {
    label: "Not built",
    cls: "bg-foreground/5 text-muted-foreground ring-1 ring-foreground/10",
  },
};

export default function Models() {
  const live = MODELS.filter((m) => m.status === "live").length;
  const trained = MODELS.filter((m) => m.status === "trained").length;

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-14">
      <h1 className="text-2xl font-semibold tracking-tight">Models</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        Every model behind RxivGPT, and which ones are actually running. Four are
        trained; {live} components are wired into the live site and {trained} are
        finished but not yet serving. A model that exists and a model that answers
        your query are different things, so the difference is written down.
      </p>

      <div className="mt-10 space-y-3">
        {MODELS.map((m) => (
          <div
            key={m.name}
            className="rounded-lg border border-foreground/10 p-5 transition-colors hover:border-foreground/20"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="font-medium">{m.name}</span>
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${BADGE[m.status].cls}`}
              >
                {BADGE[m.status].label}
              </span>
              <span className="ml-auto text-xs text-muted-foreground">{m.kind}</span>
            </div>

            <p className="mt-3 text-sm leading-relaxed text-foreground/80">{m.what}</p>

            {m.measured && (
              <p className="mt-2 text-xs tabular-nums text-muted-foreground">
                {m.measured}
              </p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">{m.where}</p>
          </div>
        ))}
      </div>

      <p className="mt-10 text-xs leading-relaxed text-muted-foreground">
        Measured on <span className="font-medium">cshl-eval-v1</span>, a frozen
        benchmark of 2,000 held-out queries retrieved against all 433,449 preprints,
        split by paper so a paper's queries cannot straddle the boundary. Every arm is
        scored with the same metric code and the similarity function its authors
        published it for. Full method, including where our models lose, is in the
        program report.
      </p>
    </div>
  );
}
