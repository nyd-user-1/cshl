import { ExternalLink } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

/**
 * About ENSDF — transcribed from NNDC's about page (data/ensdf-about.html).
 * Same shape as /ensdf/help: an "On this page" rail beside plain sections;
 * cards are reserved for the three stat chips.
 */

const STATS = [
  { label: "Fully evaluated per year", value: "~220" },
  { label: "Journal of record", value: "Nuclear Data Sheets" },
  { label: "Coordinated by", value: "NNDC, Brookhaven" },
];

const P = "text-sm leading-relaxed text-muted-foreground";

const SECTIONS: { id: string; title: string; body: React.ReactNode }[] = [
  {
    id: "contains",
    title: "What ENSDF contains",
    body: (
      <>
        <p className={P}>
          <span className="font-semibold text-foreground">ENSDF</span> contains recommended nuclear
          structure and decay data for all the known nuclides, obtained following a critical review of
          all available experimental data, supplemented with systematic trend studies and theoretical
          models. ENSDF data include (i) nuclear level properties, such as observation source, energy,
          half-life, decay modes, spin and parity; (ii) gamma ray energies, intensities,
          multipolarities, mixing ratios and conversion coefficients; (iii) nuclear radiation energy
          and intensity as well as radiation-specific data for different radiation types, such as
          gammas, alphas, betas and neutrons.
        </p>
        <p className={`mt-3 ${P}`}>
          Data for about 220 nuclides are fully evaluated each year; additionally, many datasets are
          partially updated each year.
        </p>
      </>
    ),
  },
  {
    id: "datasets",
    title: "Datasets and adopted values",
    body: (
      <>
        <p className={P}>
          For each nuclide, all known experimental data used to deduce nuclear structure information
          are included. Each type of experiment is presented as a separate dataset. In addition, there
          is a dataset of "adopted" level and gamma-ray transition properties, which represent the
          evaluator's determination of the best values for these properties, based on all available
          experimental data.
        </p>
      </>
    ),
  },
  {
    id: "evaluators",
    title: "Who evaluates, and where it is published",
    body: (
      <p className={P}>
        Nearly all the evaluation work is supported by the US Nuclear Data Program. The National
        Nuclear Data Center at Brookhaven National Laboratory is responsible for coordinating the
        evaluation effort as well as its web and journal dissemination. Most of the recently
        completed evaluations are published in{" "}
        <a href="https://www.nndc.bnl.gov/nds/" target="_blank" rel="noopener noreferrer" className="text-nuclear hover:underline">
          Nuclear Data Sheets
        </a>
        , a monthly journal published by Academic Press, a division of Elsevier Science.
      </p>
    ),
  },
];

export default function About() {
  const jump = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-primary">Evaluated Nuclear Structure Data File</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What ENSDF is, what it holds, and how often it changes.
        </p>
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        {STATS.map((s) => (
          <Card key={s.label}><CardContent className="p-3">
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p className="mt-0.5 text-sm font-medium text-foreground">{s.value}</p>
          </CardContent></Card>
        ))}
      </div>

      <div className="flex flex-col gap-6 md:flex-row">
        {/* Mini TOC — sticky alongside the content on md+ */}
        <nav className="md:sticky md:top-2 md:h-fit md:w-52 md:flex-shrink-0">
          <p className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">On this page</p>
          <div className="space-y-0.5">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => jump(s.id)}
                className="flex w-full items-center rounded-lg px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {s.title}
              </button>
            ))}
          </div>
        </nav>

        <div className="min-w-0 flex-1 space-y-8">
          {SECTIONS.map((s) => (
            <section key={s.id} id={s.id} className="scroll-mt-4">
              <h2 className="mb-2 text-sm font-bold text-foreground">{s.title}</h2>
              {s.body}
            </section>
          ))}
          <a
            href="https://www.nndc.bnl.gov/ensdf/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-nuclear hover:underline"
          >
            <ExternalLink className="h-3 w-3" /> nndc.bnl.gov/ensdf
          </a>
        </div>
      </div>
    </div>
  );
}
