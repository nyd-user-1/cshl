import { lazy, Suspense, useState, type ComponentType } from "react";
import { TexText } from "@/components/TexText";

/**
 * NNDC's tools & publications index, rebuilt in our skin. Fixed content —
 * these links change on the order of once a decade; no fetch, no data file.
 */

/** Every in-house calculator, lazy so the page itself stays light. */
const CALCULATORS = {
  qcalc: lazy(() => import("@/components/QCalcDialog").then((m) => ({ default: m.QCalcDialog }))),
  ame: lazy(() => import("@/components/AmeDialog").then((m) => ({ default: m.AmeDialog }))),
  bricc: lazy(() => import("@/components/BriccDialog").then((m) => ({ default: m.BriccDialog }))),
  bbdecay: lazy(() => import("@/components/BBDecayDialog").then((m) => ({ default: m.BBDecayDialog }))),
  be2: lazy(() => import("@/components/Be2Dialog").then((m) => ({ default: m.Be2Dialog }))),
  capgam: lazy(() => import("@/components/CapGamDialog").then((m) => ({ default: m.CapGamDialog }))),
  logft: lazy(() => import("@/components/LogftDialog").then((m) => ({ default: m.LogftDialog }))),
  evalcorner: lazy(() =>
    import("@/components/EvalCornerDialog").then((m) => ({ default: m.EvalCornerDialog })),
  ),
} satisfies Record<string, ComponentType<{ open: boolean; onOpenChange: (v: boolean) => void }>>;

type CalculatorId = keyof typeof CALCULATORS;

interface Tool {
  title: string;
  description: string;
  url: string;
  /** When set, the card opens our own calculator instead of leaving the site. */
  calculator?: CalculatorId;
}

const SECTIONS: { heading: string; tools: Tool[] }[] = [
  {
    heading: "Nuclear Structure and Decay Tools",
    tools: [
      {
        title: "2020 Atomic Mass Evaluation",
        description: "AME2020 — evaluated atomic masses, from the Atomic Mass Data Center.",
        url: "https://www-nds.iaea.org/amdc/",
        calculator: "ame",
      },
      {
        title: "BrIcc",
        description: "Band-Raman internal conversion coefficients, E0 electronic factors, and pair conversion.",
        url: "https://www.nndc.bnl.gov/bricc/",
        calculator: "bricc",
      },
      {
        title: "$\\beta\\beta$-decay data",
        description: "Evaluated double-beta-decay half-lives and transition data.",
        url: "https://www.nndc.bnl.gov/bbdecay/",
        calculator: "bbdecay",
      },
      {
        title: "$B(E2; 0^+ \\to 2^+)$ values",
        description: "Reduced electric quadrupole transition probabilities for even-even nuclei.",
        url: "https://www.nndc.bnl.gov/be2/",
        calculator: "be2",
      },
      {
        title: "CapGam",
        description: "Thermal-neutron-capture γ-rays, ordered by target nuclide and γ energy.",
        url: "https://www.nndc.bnl.gov/capgam/",
        calculator: "capgam",
      },
      {
        title: "Evaluators' Corner",
        description: "Working materials, codes, and policies for ENSDF evaluators.",
        url: "https://www.nndc.bnl.gov/ensdf/evalcorner/",
        calculator: "evalcorner",
      },
      {
        title: "LogFT",
        description: "β-decay log ft values, capture-to-positron ratios, and electron-capture fractions.",
        url: "https://www.nndc.bnl.gov/logft/",
        calculator: "logft",
      },
      {
        title: "Q-Calc",
        description: "Masses, Q-values, and reaction thresholds computed from the mass evaluation.",
        url: "https://www.nndc.bnl.gov/qcalc/",
        calculator: "qcalc",
      },
    ],
  },
  {
    heading: "Nuclear Reaction Tools",
    tools: [
      {
        title: "2020 Atomic Mass Evaluation",
        description: "AME2020 — evaluated atomic masses, from the Atomic Mass Data Center.",
        url: "https://www-nds.iaea.org/amdc/",
        calculator: "ame",
      },
      {
        title: "CapGam",
        description: "Thermal-neutron-capture γ-rays, ordered by target nuclide and γ energy.",
        url: "https://www.nndc.bnl.gov/capgam/",
        calculator: "capgam",
      },
      {
        title: "MACS & astrophysical reaction rates",
        description: "Maxwellian-averaged cross sections and stellar reaction rates.",
        url: "https://www.nndc.bnl.gov/astro/",
      },
      {
        title: "Q-Calc",
        description: "Masses, Q-values, and reaction thresholds computed from the mass evaluation.",
        url: "https://www.nndc.bnl.gov/qcalc/",
        calculator: "qcalc",
      },
      {
        title: "GEANT4",
        description: "Toolkit for the Monte Carlo simulation of the passage of particles through matter.",
        url: "https://geant4.web.cern.ch/",
      },
      {
        title: "MCNP",
        description: "General-purpose Monte Carlo N-Particle transport code.",
        url: "https://mcnp.lanl.gov/",
      },
    ],
  },
  {
    heading: "Major Publications",
    tools: [
      {
        title: "Atlas of Neutron Resonances",
        description: "Resonance parameters and thermal cross sections for all measured nuclides.",
        url: "https://www.nndc.bnl.gov/atlas/",
      },
      {
        title: "Nuclear Data Sheets",
        description: "The monthly journal in which completed ENSDF evaluations are published.",
        url: "https://www.nndc.bnl.gov/nds/",
      },
      {
        title: "Nuclear Wallet Cards",
        description: "Ground- and isomeric-state properties for all known nuclides, pocket-sized.",
        url: "https://www.nndc.bnl.gov/walletcards/",
      },
    ],
  },
  {
    heading: "Manuals",
    tools: [
      {
        title: "ENDF-102 formats manual",
        description: "Data formats and procedures for the evaluated nuclear data files ENDF-6.",
        url: "https://www.nndc.bnl.gov/endfdocs/ENDF-102-2012.pdf",
      },
      {
        title: "ENSDF manual",
        description: "The ENSDF format specification and evaluator's reference.",
        url: "https://www.nndc.bnl.gov/ensdf/ensdf-manual.pdf",
      },
      {
        title: "NSR coding manual",
        description: "Keyword abstract and indexing conventions for the NSR bibliography.",
        url: "https://www.nndc.bnl.gov/nsr/docs/nsr-coding-manual.pdf",
      },
    ],
  },
];

const CARD =
  "group flex flex-col rounded-lg border border-border/40 bg-muted/40 p-4 text-left " +
  "transition-all hover:border-border hover:shadow-lg";

/** Warm the calculator's chunk + data on hover so the dialog opens instantly. */
const PREFETCH: Partial<Record<CalculatorId, () => void>> = {
  qcalc: () => { import("@/components/QCalcDialog"); fetch("/data/ame2020.json").catch(() => {}); },
  ame: () => { import("@/components/AmeDialog"); fetch("/data/ame2020.json").catch(() => {}); },
  bbdecay: () => { import("@/components/BBDecayDialog"); fetch("/data/bbdecay.json").catch(() => {}); },
  be2: () => { import("@/components/Be2Dialog"); fetch("/data/be2/adopted.json").catch(() => {}); },
  capgam: () => { import("@/components/CapGamDialog"); fetch("/data/capgam/index.json").catch(() => {}); },
  bricc: () => { import("@/components/BriccDialog"); },
  logft: () => { import("@/components/LogftDialog"); },
  evalcorner: () => { import("@/components/EvalCornerDialog"); },
};

function ToolCard({ tool, onOpen }: { tool: Tool; onOpen: (c: CalculatorId) => void }) {
  const body = (
    <>
      <span className="text-sm font-bold text-foreground">
        <TexText text={tool.title} />
      </span>
      <p className="mt-6 text-xs leading-relaxed text-muted-foreground">{tool.description}</p>
    </>
  );

  if (tool.calculator) {
    return (
      <button type="button" onClick={() => onOpen(tool.calculator!)} onMouseEnter={() => PREFETCH[tool.calculator!]?.()} className={`${CARD} w-full`}>
        {body}
      </button>
    );
  }
  return (
    <a href={tool.url} target="_blank" rel="noopener noreferrer" className={CARD}>
      {body}
    </a>
  );
}

export default function Tools() {
  const [openCalculator, setOpenCalculator] = useState<CalculatorId | null>(null);
  const OpenDialog = openCalculator && CALCULATORS[openCalculator];

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-primary">Tools & Publications</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Calculators, codes, and reference publications from the NNDC and its partners.
        </p>
      </div>

      {SECTIONS.map((section) => (
        <div key={section.heading} className="mb-6">
          <h2 className="mb-3 text-sm font-semibold text-foreground">{section.heading}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {section.tools.map((t) => (
              <ToolCard key={t.url + t.title} tool={t} onOpen={setOpenCalculator} />
            ))}
          </div>
        </div>
      ))}

      {OpenDialog && (
        <Suspense fallback={null}>
          <OpenDialog open onOpenChange={(v) => !v && setOpenCalculator(null)} />
        </Suspense>
      )}
    </div>
  );
}
