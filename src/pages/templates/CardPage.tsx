import { useState } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

/**
 * The card-page design, content-agnostic.
 *
 * This repo gets re-skinned per information domain (NSR → CSHL preprints →
 * whatever is next). The nuclear era had a family of pages — /ensdf/about,
 * /ensdf/archive, /nsr/archive, /xundl/about, /xundl/archive, /endf — that were
 * carbon copies of one design with different content. The copies are gone;
 * this file keeps the design as data-driven building blocks so the next domain
 * writes content, not markup.
 *
 * Two assembled shapes, matching the two families the copies fell into:
 *
 *   <AboutPage>    title + subtitle, stat chips, an "On this page" rail beside
 *                  plain prose sections. (was: ensdf/About, xundl/About)
 *   <ArchivePage>  title + subtitle, prose intro, stat chips, fact cards, then
 *                  caller-supplied body (tables, collapsible year sections…).
 *                  (was: nsr/Archive, ensdf/Archive, xundl/Archive)
 *
 * The smaller blocks (StatGrid, FactCard, Fact, CollapsibleRow) are exported
 * for pages that need a variation rather than the full assembly.
 */

export interface PageSection {
  id: string;
  title: string;
  body: React.ReactNode;
}

export function StatGrid({ stats, cols = 3 }: { stats: [string, React.ReactNode][]; cols?: number }) {
  const colClass =
    cols >= 6 ? "grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" : "gap-3 sm:grid-cols-3";
  return (
    <div className={`mb-6 grid ${colClass}`}>
      {stats.map(([label, value]) => (
        <Card key={label}>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-0.5 font-mono text-sm font-semibold text-foreground">{value ?? "—"}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">{value}</span>
    </div>
  );
}

export function FactCard({ heading, facts }: { heading: string; facts: [string, React.ReactNode][] }) {
  return (
    <Card>
      <CardContent className="p-4">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{heading}</h2>
        {facts.map(([label, value]) => (
          <Fact key={label} label={label} value={value} />
        ))}
      </CardContent>
    </Card>
  );
}

/** A collapsible row with a header line and expandable detail — the year-section pattern. */
export function CollapsibleRow({
  title,
  meta,
  children,
  defaultOpen = false,
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b last:border-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-sm transition-colors hover:bg-muted/50"
      >
        <span className="flex items-center gap-3">
          <span className="font-mono font-semibold text-foreground">{title}</span>
          {meta && <span className="text-xs text-muted-foreground">{meta}</span>}
        </span>
        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && <div className="border-t bg-muted/20">{children}</div>}
    </div>
  );
}

export function AboutPage({
  title,
  subtitle,
  stats,
  sections,
  sourceHref,
  sourceLabel,
}: {
  title: string;
  subtitle: string;
  stats?: [string, React.ReactNode][];
  sections: PageSection[];
  sourceHref?: string;
  sourceLabel?: string;
}) {
  const jump = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-primary">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
      </div>

      {stats && <StatGrid stats={stats} />}

      <div className="flex flex-col gap-6 md:flex-row">
        <nav className="md:sticky md:top-2 md:h-fit md:w-52 md:flex-shrink-0">
          <p className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">On this page</p>
          <div className="space-y-0.5">
            {sections.map((s) => (
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
          {sections.map((s) => (
            <section key={s.id} id={s.id} className="scroll-mt-4">
              <h2 className="mb-2 text-sm font-bold text-foreground">{s.title}</h2>
              {s.body}
            </section>
          ))}
          {sourceHref && (
            <a
              href={sourceHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
            >
              <ExternalLink className="h-3 w-3" /> {sourceLabel ?? sourceHref}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export function ArchivePage({
  title,
  subtitle,
  intro,
  stats,
  factCards,
  children,
}: {
  title: string;
  subtitle: string;
  intro?: React.ReactNode;
  stats?: [string, React.ReactNode][];
  factCards?: { heading: string; facts: [string, React.ReactNode][] }[];
  children?: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold text-primary">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
      </div>

      {intro}

      {stats && <StatGrid stats={stats} cols={6} />}

      {factCards && (
        <div className="mb-5 grid gap-3 sm:grid-cols-2">
          {factCards.map((c) => (
            <FactCard key={c.heading} heading={c.heading} facts={c.facts} />
          ))}
        </div>
      )}

      {children}
    </div>
  );
}
