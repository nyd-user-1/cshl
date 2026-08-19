import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * NNDC's ββ-decay tables in our skin, read straight out of our copy of their
 * JSON. Every half-life is printed as the file states it — nothing is rescaled,
 * recombined, or re-rounded here.
 */

interface Nuclide {
  element: string;
  symbol: string;
  z: number;
  n: number;
  a: number;
}

/** The scaled*Error strings are already expressed in units of the value's
 *  leading power of ten, so they pair with the mantissa without arithmetic. */
interface HalfLifeValue {
  modifier?: string;
  value: number;
  scaledError?: string;
  scaledUpperError?: string;
  scaledLowerError?: string;
}

interface Article {
  title?: string;
  journal?: string;
}

interface Author {
  firstInitial?: string;
  middleInitial?: string;
  lastName: string;
}

interface AdoptedRecord {
  decayProcess: string;
  transition: string;
  evaluationYear: number;
  nuclide: Nuclide;
  twoNeutrinoHalfLife?: HalfLifeValue;
  halfLifeSum?: HalfLifeValue;
}

interface ExperimentalRecord {
  decayProcess: string;
  transition: string;
  nsrKeyNumber: string;
  publicationYear?: number;
  article?: Article;
  authors?: Author[];
  nuclide: Nuclide;
  neutrinoLessHalfLife?: HalfLifeValue;
  neutrinoLessConfidence?: number;
  twoNeutrinoHalfLife?: HalfLifeValue;
  twoNeutrinoConfidence?: number;
  halfLifeSum?: HalfLifeValue;
  halfLifeSumConfidence?: number;
}

interface BBDecayFile {
  adopted: AdoptedRecord[];
  experimental: ExperimentalRecord[];
}

const ROW_CAP = 300;

const SUPERSCRIPT: Record<string, string> = {
  "+": "⁺", "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
};
const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";

const sup = (s: string) => s.replace(/./g, (c) => SUPERSCRIPT[c] ?? c);
const sub = (s: string) => s.replace(/\d/g, (c) => SUBSCRIPT[Number(c)]);

const nuclideLabel = (x: Nuclide) => (
  <span className="whitespace-nowrap font-mono">
    <sup>{x.a}</sup>
    {x.symbol}
  </span>
);

/** NNDC writes the process in ASCII and, in one record, in HTML entities:
 *  2B-, b-b-, eb+, 2e, b-b-X0, &beta;-&beta;-M, Res. KL1. The "Res." prefix is
 *  held back so its lowercase e survives the ε substitution. */
function processLabel(raw: string) {
  return raw
    .split(",")
    .map((token) => {
      const t = token.trim();
      const resonant = t.startsWith("Res.");
      const body = (resonant ? t.slice(4).trim() : t)
        .replace(/&beta;/g, "b")
        .replace(/([bB])([+-])/g, (_, __, sign: string) => `β${SUPERSCRIPT[sign]}`)
        .replace(/X0/g, "X⁰")
        .replace(/e/g, "ε");
      return resonant ? `Res. ${body}` : body;
    })
    .join(", ");
}

/** "0+->2+1" is a pair of spin-parities, each with an optional level index. */
function transitionLabel(raw: string) {
  return raw
    .split("->")
    .map((side) => {
      const m = /^(.*?)([+-])(\d*)$/.exec(side.trim());
      return m ? `${m[1]}${SUPERSCRIPT[m[2]]}${sub(m[3])}` : side.trim();
    })
    .join("→");
}

const MODIFIERS: Record<string, string> = { ">=": "≥", "<=": "≤" };

function HalfLife({ q, confidence }: { q?: HalfLifeValue; confidence?: number }) {
  if (!q) return <span className="text-muted-foreground">—</span>;
  const [mantissa, exponent] = q.value.toExponential().split("e");
  const exp = Number(exponent);
  return (
    <span className="font-mono text-foreground">
      <span className="whitespace-nowrap">
        {q.modifier && `${MODIFIERS[q.modifier] ?? q.modifier} `}
        {mantissa}
        {q.scaledError && <span className="text-muted-foreground"> ±{q.scaledError}</span>}
        {q.scaledUpperError && (
          <span className="text-muted-foreground">
            {` +${q.scaledUpperError} −${q.scaledLowerError}`}
          </span>
        )}
        {exp !== 0 && <span className="text-muted-foreground">{` ×10${sup(String(exp))}`}</span>}
      </span>
      {confidence !== undefined && (
        <span className="block text-[10px] text-muted-foreground">{confidence}% C.L.</span>
      )}
    </span>
  );
}

function authorLabel(authors?: Author[]) {
  const first = authors?.[0];
  if (!first) return "—";
  const initials = [first.firstInitial, first.middleInitial]
    .filter(Boolean)
    .map((i) => `${i}.`)
    .join("");
  const name = `${initials}${first.lastName}`;
  return authors && authors.length > 1 ? `${name} et al.` : name;
}

const matches = (n: Nuclide, needle: string) =>
  !needle ||
  `${n.a}${n.symbol}`.toLowerCase().includes(needle) ||
  n.symbol.toLowerCase().includes(needle);

function CapNote({ total }: { total: number }) {
  if (total <= ROW_CAP) return null;
  return (
    <p className="mt-2 text-xs text-muted-foreground">
      showing {ROW_CAP} of {total} rows — filter to narrow
    </p>
  );
}

/* ------------------------------------------------------------------ */

function AdoptedTable({ rows }: { rows: AdoptedRecord[] }) {
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-1.5 pr-3 font-medium">Nuclide</th>
              <th className="py-1.5 pr-3 font-medium">Process</th>
              <th className="py-1.5 pr-3 font-medium">Transition</th>
              <th className="py-1.5 pr-3 font-medium">Eval</th>
              <th className="py-1.5 pr-3 text-right font-medium">T½(2ν) y</th>
              <th className="py-1.5 text-right font-medium">T½(0ν+2ν) y</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, ROW_CAP).map((r, i) => (
              <tr key={i} className="border-b last:border-0">
                <td className="py-1.5 pr-3">{nuclideLabel(r.nuclide)}</td>
                <td className="py-1.5 pr-3 whitespace-nowrap">{processLabel(r.decayProcess)}</td>
                <td className="py-1.5 pr-3 whitespace-nowrap">{transitionLabel(r.transition)}</td>
                <td className="py-1.5 pr-3 font-mono text-muted-foreground">{r.evaluationYear}</td>
                <td className="py-1.5 pr-3 text-right">
                  <HalfLife q={r.twoNeutrinoHalfLife} />
                </td>
                <td className="py-1.5 text-right">
                  <HalfLife q={r.halfLifeSum} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <CapNote total={rows.length} />
    </>
  );
}

function ExperimentalTable({ rows }: { rows: ExperimentalRecord[] }) {
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-1.5 pr-3 font-medium">Nuclide</th>
              <th className="py-1.5 pr-3 font-medium">Process</th>
              <th className="py-1.5 pr-3 font-medium">Transition</th>
              <th className="py-1.5 pr-3 text-right font-medium">T½(0ν) y</th>
              <th className="py-1.5 pr-3 text-right font-medium">T½(2ν) y</th>
              <th className="py-1.5 pr-3 text-right font-medium">T½(0ν+2ν) y</th>
              <th className="py-1.5 font-medium">Reference</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, ROW_CAP).map((r, i) => (
              <tr key={i} className="border-b last:border-0">
                <td className="py-1.5 pr-3 align-top">{nuclideLabel(r.nuclide)}</td>
                <td className="py-1.5 pr-3 align-top whitespace-nowrap">
                  {processLabel(r.decayProcess)}
                </td>
                <td className="py-1.5 pr-3 align-top whitespace-nowrap">
                  {transitionLabel(r.transition)}
                </td>
                <td className="py-1.5 pr-3 text-right align-top">
                  <HalfLife q={r.neutrinoLessHalfLife} confidence={r.neutrinoLessConfidence} />
                </td>
                <td className="py-1.5 pr-3 text-right align-top">
                  <HalfLife q={r.twoNeutrinoHalfLife} confidence={r.twoNeutrinoConfidence} />
                </td>
                <td className="py-1.5 pr-3 text-right align-top">
                  <HalfLife q={r.halfLifeSum} confidence={r.halfLifeSumConfidence} />
                </td>
                <td className="py-1.5 align-top">
                  <span className="block" title={r.article?.title}>
                    {authorLabel(r.authors)}
                    {r.publicationYear ? ` (${r.publicationYear})` : ""}
                  </span>
                  <span className="block font-mono text-[10px] text-muted-foreground">
                    {r.nsrKeyNumber}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <CapNote total={rows.length} />
    </>
  );
}

/* ------------------------------------------------------------------ */

export function BBDecayDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["bbdecay"],
    queryFn: async (): Promise<BBDecayFile> => {
      const res = await fetch("/data/bbdecay.json");
      if (!res.ok) throw new Error(`bbdecay.json: ${res.status}`);
      return res.json();
    },
    staleTime: Infinity,
  });

  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();

  const adopted = useMemo(
    () => (data?.adopted ?? []).filter((r) => matches(r.nuclide, needle)),
    [data, needle],
  );
  const experimental = useMemo(
    () => (data?.experimental ?? []).filter((r) => matches(r.nuclide, needle)),
    [data, needle],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Double beta (ββ) decay</DialogTitle>
          <DialogDescription>
            Evaluated 2νββ half-lives and experimental ββ results — served from our own copy of
            NNDC's compilation.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Nuclide</span>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="48Ca, Te…"
                className="h-9 w-40"
              />
            </label>
          </div>

          {isLoading || !data ? (
            <div className="space-y-2">
              {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}
            </div>
          ) : (
            <Tabs defaultValue="adopted">
              <TabsList>
                <TabsTrigger value="adopted">Adopted</TabsTrigger>
                <TabsTrigger value="experimental">Experimental</TabsTrigger>
              </TabsList>

              <TabsContent value="adopted" className="mt-4">
                <p className="mb-3 text-xs text-muted-foreground">
                  Adopted values are based on experimentally observed ββ transitions. The 2025
                  evaluation supersedes those of 2013 and 2006; all three are listed.
                </p>
                {adopted.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No adopted entries for that filter.</p>
                ) : (
                  <AdoptedTable rows={adopted} />
                )}
              </TabsContent>

              <TabsContent value="experimental" className="mt-4">
                <p className="mb-3 text-xs text-muted-foreground">
                  Recent experimental ββ results, sourced from the NSR database. Values carrying a
                  modifier are limits at the stated confidence level.
                </p>
                {experimental.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No experimental entries for that filter.
                  </p>
                ) : (
                  <ExperimentalTable rows={experimental} />
                )}
              </TabsContent>
            </Tabs>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t p-4 text-xs text-muted-foreground">
          <span>NNDC ββ-decay compilation — 2025 evaluation. Served from our own copy.</span>
          <a
            href="https://www.nndc.bnl.gov/bbdecay/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-nuclear hover:underline"
          >
            NNDC ββ-decay <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
