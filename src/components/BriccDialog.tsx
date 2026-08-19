import { useState, type FormEvent, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * BrIcc in a dialog. The Band–Raman database is a binary blob and the
 * interpolation runs at ANU, so /api/bricc relays their result table and we
 * print it verbatim — their header lines, their column names, their strings.
 * Nothing here reformats a number.
 */

const SELECT_CLASS =
  "h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground " +
  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring focus-visible:ring-offset-2";

const MULTIPOLES = ["E1", "M1", "E2", "M2", "E3", "M3", "E4", "M4", "E5", "M5"];

interface BriccForm {
  atomic: string;
  energy: string;
  eerror: string;
  multipole: string;
  delta: string;
  derror: string;
}

const EMPTY: BriccForm = {
  atomic: "",
  energy: "",
  eerror: "",
  multipole: "",
  delta: "",
  derror: "",
};

interface BriccTable {
  meta: string[];
  columns: string[];
  rows: string[][];
}

type BriccResponse = BriccTable | { error: string };

/**
 * A data row carries either one cell per column, or — when BrIcc has
 * uncertainties to report — a value and an uncertainty for every
 * multipolarity column, interleaved after Shell and E(ce).
 */
interface Cell {
  value: string;
  unc?: string;
}

function pairCells(row: string[], columnCount: number): Cell[] {
  if (row.length !== 2 + 2 * (columnCount - 2)) return row.map((value) => ({ value }));
  const cells: Cell[] = [{ value: row[0] }, { value: row[1] }];
  for (let i = 2; i < row.length; i += 2) cells.push({ value: row[i], unc: row[i + 1] });
  return cells;
}

/* ------------------------------------------------------------------ */

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="w-36 shrink-0 text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function ResultTable({ table }: { table: BriccTable }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            {table.columns.map((c, i) => (
              <th
                key={i}
                className={cn("py-1.5 font-medium", i === 0 ? "pr-3 text-left" : "pl-3 text-right")}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => {
            const cells = pairCells(row, table.columns.length);
            return (
              <tr
                key={i}
                className={cn("border-b last:border-0", cells[0]?.value === "Tot" && "font-semibold")}
              >
                {cells.map((cell, j) => (
                  <td
                    key={j}
                    className={cn(
                      "whitespace-nowrap py-1.5",
                      j === 0 ? "pr-3 text-left" : "pl-3 text-right font-mono",
                    )}
                  >
                    {cell.value}
                    {cell.unc && <span className="ml-1 text-muted-foreground">{cell.unc}</span>}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function BriccDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [form, setForm] = useState<BriccForm>(EMPTY);
  const [table, setTable] = useState<BriccTable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const set = (key: keyof BriccForm) => (v: string) => setForm((f) => ({ ...f, [key]: v }));
  const complete = form.atomic.trim() !== "" && form.energy.trim() !== "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (loading || !complete) return;
    setLoading(true);
    setError(null);
    setTable(null);

    const body = Object.fromEntries(
      Object.entries(form).map(([k, v]) => [k, v.trim()]),
    );

    try {
      const res = await fetch("/api/bricc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as BriccResponse;
      if ("error" in data) setError(data.error);
      else setTable(data);
    } catch {
      setError("Could not reach the BrIcc service.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>BrIcc — internal conversion coefficients</DialogTitle>
          <DialogDescription>
            Band-Raman internal conversion coefficients, interpolated by BrIcc at ANU and relayed here.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <form onSubmit={submit} className="space-y-3">
            <Row label="Element">
              <Input
                value={form.atomic}
                onChange={(e) => set("atomic")(e.target.value)}
                placeholder="79 or Au"
                className="h-9 w-28"
                aria-label="Element"
              />
            </Row>

            <Row label="γ energy (keV)">
              <Input
                value={form.energy}
                onChange={(e) => set("energy")(e.target.value)}
                className="h-9 w-28"
                aria-label="Gamma energy in keV"
                inputMode="decimal"
              />
              <span className="text-muted-foreground">±</span>
              <Input
                value={form.eerror}
                onChange={(e) => set("eerror")(e.target.value)}
                placeholder="x or +x-y"
                className="h-9 w-24"
                aria-label="Gamma energy uncertainty"
              />
            </Row>

            <Row label="Multipolarity">
              <select
                value={form.multipole}
                onChange={(e) => set("multipole")(e.target.value)}
                className={SELECT_CLASS}
                aria-label="Multipolarity"
              >
                <option value="">All (E1–M5)</option>
                {MULTIPOLES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </Row>

            <Row label="Mixing ratio δ">
              <Input
                value={form.delta}
                onChange={(e) => set("delta")(e.target.value)}
                className="h-9 w-28"
                aria-label="Mixing ratio delta"
                inputMode="decimal"
              />
              <span className="text-muted-foreground">±</span>
              <Input
                value={form.derror}
                onChange={(e) => set("derror")(e.target.value)}
                className="h-9 w-24"
                aria-label="Mixing ratio uncertainty"
              />
            </Row>

            <div className="pt-1">
              <Button type="submit" size="sm" disabled={loading || !complete}>
                {loading ? "Calculating…" : "Calculate"}
              </Button>
            </div>
          </form>

          {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

          {loading && (
            <div className="mt-5 space-y-2 border-t pt-5">
              {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}
            </div>
          )}

          {table && !loading && (
            <div className="mt-5 border-t pt-5">
              {table.meta.length > 0 && (
                <div className="mb-3 space-y-0.5 text-xs text-muted-foreground">
                  {table.meta.map((m, i) => <p key={i}>{m}</p>)}
                </div>
              )}
              <ResultTable table={table} />
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t p-4 text-xs text-muted-foreground">
          <span>
            BrIccS v2.3 — T. Kibédi et al., Nucl. Instrum. Methods A 589, 202 (2008). Calculated at
            ANU, relayed verbatim.
          </span>
          <a
            href="https://bricc.anu.edu.au/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-nuclear hover:underline"
          >
            BrIcc (ANU) <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
