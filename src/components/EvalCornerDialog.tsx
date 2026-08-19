import { Link } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

/**
 * Evaluators' Corner — NNDC's portal for the ENSDF evaluation network, as a
 * curated link list. Where our own site already carries the surface (ENSDF
 * pages, NSR search) the link stays internal; everything else goes to the
 * canonical host. Content is fixed; the live page carries the announcements.
 */

const CORNER = "https://www.nndc.bnl.gov/ensdf/evalcorner";

interface CornerLink {
  label: string;
  note?: string;
  /** exactly one of the two */
  href?: string;
  to?: string;
}

const SECTIONS: { heading: string; links: CornerLink[] }[] = [
  {
    heading: "The evaluation network",
    links: [
      { label: "ENSDF", note: "the evaluated nuclear structure data file", to: "/ensdf/about" },
      { label: "Nuclear Science References", note: "the NSR bibliography — this site", to: "/search" },
      { label: "NSDD network (IAEA)", href: "https://www-nds.iaea.org/nsdd/" },
      { label: "NSDD data centers", href: "https://www-nds.iaea.org/nsdd/datacenters.html" },
      { label: "US Nuclear Data Program", href: "https://www.nndc.bnl.gov/usndp/" },
    ],
  },
  {
    heading: "Codes & calculators",
    links: [
      { label: "ENSDF analysis & utility codes", href: "https://www-nds.iaea.org/public/ensdf_pgm/" },
      { label: "BrIcc — internal conversion coefficients", href: "https://bricc.anu.edu.au/" },
      { label: "LogFT", href: "https://www.nndc.bnl.gov/logft/" },
      { label: "Q-value calculator", href: "https://www.nndc.bnl.gov/qcalc/" },
    ],
  },
  {
    heading: "Guidelines & policies",
    links: [
      { label: "ENSDF formats manual", href: "https://www.nndc.bnl.gov/ensdf/ensdf-manual.pdf" },
      { label: "ENSDF procedures", href: `${CORNER}/pdfs/ensdf-procedures.pdf` },
      { label: "Guidelines for evaluators (2021, rev. 2)", href: `${CORNER}/pdfs/Evaluators_Guidelines_2021_V2.pdf` },
      { label: "Pre-submission checklist", href: `${CORNER}/pdfs/checklist.pdf` },
      { label: "Review guidelines", href: `${CORNER}/pdfs/review_guidelines.pdf` },
      { label: "Nuclear Data Sheets general policies", href: "https://www.nndc.bnl.gov/nds/docs/NDSPolicies.pdf" },
    ],
  },
  {
    heading: "Reference tables & archives",
    links: [
      { label: "Archived ENSDF files", note: "browsable on this site", to: "/ensdf/archive" },
      { label: "Repository of horizontal evaluations", href: `${CORNER}/horizontal.html` },
      { label: "Table of rotational bands", href: "https://www.nndc.bnl.gov/publications/preprints/mag-dip-rot-bands.pdf" },
      { label: "Table of nuclear moments", href: "https://www.nndc.bnl.gov/publications/nuclear_moments_2014STZZ.pdf" },
      { label: "History of the elements", href: "https://www.nndc.bnl.gov/content/HistoryOfElements.html" },
    ],
  },
];

export function EvalCornerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Evaluators' Corner</DialogTitle>
          <DialogDescription>
            Working materials for the ENSDF evaluation network — codes, guidelines, and archives.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {SECTIONS.map((section) => (
            <div key={section.heading} className="mb-5 last:mb-0">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {section.heading}
              </h3>
              <ul className="space-y-1.5">
                {section.links.map((l) => (
                  <li key={l.label} className="text-sm">
                    {l.to ? (
                      <Link
                        to={l.to}
                        onClick={() => onOpenChange(false)}
                        className="text-nuclear hover:underline"
                      >
                        {l.label}
                      </Link>
                    ) : (
                      <a
                        href={l.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-nuclear hover:underline"
                      >
                        {l.label} <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                    {l.note && <span className="ml-1.5 text-xs text-muted-foreground">{l.note}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t p-4 text-xs text-muted-foreground">
          <span>Announcements and the high-priority list live on the NNDC page.</span>
          <a
            href={`${CORNER}/`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-nuclear hover:underline"
          >
            NNDC Evaluators' Corner <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
