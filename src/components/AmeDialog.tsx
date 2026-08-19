import { useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ndsFormat, useMassTable, type Nuclide } from "@/lib/qcalc";

/**
 * The AME2020 mass table as a browsable dialog — the same public/data/ame2020.json
 * copy Q-Calc computes from, shown as the evaluation's own columns rather than
 * derived quantities. Values render in NDS notation, verbatim from the file.
 */

const ROW_CAP = 200;

function Nds({ value, error, unit }: { value?: number; error?: number; unit?: string }) {
  if (value === undefined) return <span className="text-muted-foreground">—</span>;
  const nds = ndsFormat(value, error ?? 0);
  return (
    <span className="font-mono text-foreground">
      {nds.value}
      {nds.error && <span className="text-muted-foreground"> {nds.error}</span>}
      {unit ? <span className="text-muted-foreground"> {unit}</span> : null}
    </span>
  );
}

export function AmeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data: table, isLoading } = useMassTable();
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    if (!table) return [];
    const all = table.all().sort((x, y) => x.z - y.z || x.a - y.a);
    const q = query.trim().toLowerCase();
    if (!q) return all;
    // A symbol lists the element's isotopes; a bare number lists the isobars;
    // anything else goes through the same resolver Q-Calc uses ("235U", "U-235").
    const bySymbol = all.filter((x) => x.el.toLowerCase() === q);
    if (bySymbol.length) return bySymbol;
    if (/^\d+$/.test(q)) return all.filter((x) => x.a === Number(q));
    const exact = table.find(q);
    if (exact) return [exact];
    return all.filter((x) => x.el.toLowerCase().startsWith(q));
  }, [table, query]);

  const shown = matches.slice(0, ROW_CAP);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>2020 Atomic Mass Evaluation</DialogTitle>
          <DialogDescription>
            AME2020's evaluated masses, browsed from our own copy of the mass table.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Nuclide</span>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="235U, Sn, 132…"
                className="h-9 w-40"
              />
            </label>
            {table && (
              <span className="text-xs text-muted-foreground">
                {matches.length.toLocaleString()} of {table.all().length.toLocaleString()} nuclides
              </span>
            )}
          </div>

          {isLoading || !table ? (
            <div className="space-y-2">
              {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}
            </div>
          ) : matches.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing in AME2020 matches. Try a nuclide (<span className="font-mono">235U</span>),
              an element (<span className="font-mono">Sn</span>), or a mass number (
              <span className="font-mono">132</span>).
            </p>
          ) : (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium">Nuclide</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Z</th>
                    <th className="py-1.5 pr-3 text-right font-medium">N</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Mass excess (keV)</th>
                    <th className="py-1.5 pr-3 text-right font-medium">BE/A (keV)</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Atomic mass (u)</th>
                    <th className="py-1.5 text-right font-medium">Q(β⁻) (keV)</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((x: Nuclide) => (
                    <tr key={x.z * 1000 + x.a} className="border-b last:border-0">
                      <td className="py-1.5 pr-3">
                        <span className="font-mono">
                          <sup>{x.a}</sup>
                          {x.el}
                        </span>
                        {x.est ? (
                          <span
                            className="ml-1.5 text-[10px] text-muted-foreground"
                            title="extrapolated from systematics"
                          >
                            sys
                          </span>
                        ) : null}
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono text-muted-foreground">{x.z}</td>
                      <td className="py-1.5 pr-3 text-right font-mono text-muted-foreground">{x.n}</td>
                      <td className="py-1.5 pr-3 text-right"><Nds value={x.d} error={x.dd} /></td>
                      <td className="py-1.5 pr-3 text-right"><Nds value={x.be} error={x.bee} /></td>
                      <td className="py-1.5 pr-3 text-right"><Nds value={x.m} error={x.me} /></td>
                      <td className="py-1.5 text-right"><Nds value={x.qbm} error={x.qbme} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {matches.length > ROW_CAP && (
                <p className="mt-2 text-xs text-muted-foreground">
                  showing {ROW_CAP} of {matches.length.toLocaleString()} — filter to narrow
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t p-4 text-xs text-muted-foreground">
          <span>
            AME2020 — Wang et al., Chin. Phys. C 45, 030003 (2021). NDS notation;{" "}
            <span className="font-mono">sys</span> marks systematics.
          </span>
          <a
            href="https://www-nds.iaea.org/amdc/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-nuclear hover:underline"
          >
            Atomic Mass Data Center <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
