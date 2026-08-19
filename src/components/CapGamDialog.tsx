import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * CapGam in a dialog — thermal-neutron-capture γ-rays served from our own copy of
 * NNDC's harvest. Every number is printed as `evaluatorInput`, which already
 * carries the evaluator's notation (NDS uncertainty, LT limits, AP approximations);
 * nothing here is recomputed or reformatted.
 */

const MAX_ROWS = 500;
const MAX_HITS = 30;

interface Nuclide {
  z: number;
  n: number;
  a: number;
  element: string;
  symbol: string;
}

/** A CapGam value: `value` is parsed, `evaluatorInput` is what was published. */
interface Quantity {
  value: number;
  uncertainty: { value?: number; type: string; limitType?: string; isInclusive?: boolean };
  evaluatorInput: string;
  unit?: string;
  comments?: string[];
}

interface IndexEntry {
  dsid: string;
  file: string;
  target: Nuclide;
  product: Nuclide;
  nGammas: number;
  crossSection: Quantity | null;
  modificationDate: string;
}

interface CapGamIndex {
  source: string;
  url: string;
  fetched: string;
  datasets: IndexEntry[];
}

interface GammaRecord {
  gammaID: string;
  energy: Quantity;
  isPrimaryGamma: boolean;
  originalIntensity: Quantity | null;
  absoluteIntensity: Quantity | null;
  intensityRatio: Quantity | null;
}

interface Dataset {
  target: Nuclide;
  product: Nuclide;
  dsid: string;
  fileName: string;
  modificationDate: string;
  ensdfLink: string;
  crossSection: Quantity | null;
  gammaRecords: GammaRecord[];
}

const useCapGamIndex = () =>
  useQuery({
    queryKey: ["capgam", "index"],
    queryFn: async () => {
      const res = await fetch("/data/capgam/index.json");
      if (!res.ok) throw new Error(`capgam index.json: ${res.status}`);
      return (await res.json()) as CapGamIndex;
    },
    staleTime: Infinity,
  });

const useCapGamDataset = (file: string | null) =>
  useQuery({
    queryKey: ["capgam", "ds", file],
    queryFn: async () => {
      const res = await fetch(`/data/capgam/ds/${file}.json`);
      if (!res.ok) throw new Error(`capgam ${file}: ${res.status}`);
      return (await res.json()) as Dataset;
    },
    enabled: file !== null,
    staleTime: Infinity,
  });

const nuclideLabel = (x: Nuclide) => (
  <span className="font-mono">
    <sup>{x.a}</sup>
    {x.symbol}
  </span>
);

/** Published value, verbatim. Null quantities are whole columns CapGam left empty. */
function Q({ q, unit }: { q: Quantity | null; unit?: string }) {
  if (!q) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="font-mono text-foreground">
      {q.evaluatorInput}
      {unit ? <span className="text-muted-foreground"> {unit}</span> : null}
    </span>
  );
}

/* ------------------------------------------------------------------ */

function TargetPicker({
  datasets,
  onSelect,
}: {
  datasets: IndexEntry[];
  onSelect: (entry: IndexEntry) => void;
}) {
  const [query, setQuery] = useState("");

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return datasets;
    return datasets.filter((d) => {
      const { a, symbol } = d.target;
      return (
        `${a}${symbol}`.toLowerCase().startsWith(q) ||
        symbol.toLowerCase().startsWith(q) ||
        d.dsid.toLowerCase().includes(q)
      );
    });
  }, [datasets, query]);

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Target</span>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="1H, 55Mn, Eu…"
          className="h-9 w-48"
        />
      </label>

      {hits.length === 0 ? (
        <p className="text-sm text-muted-foreground">No CapGam dataset for that target.</p>
      ) : (
        <>
          <div className="divide-y">
            {hits.slice(0, MAX_HITS).map((d) => (
              <button
                key={d.file}
                type="button"
                onClick={() => onSelect(d)}
                className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-left text-sm hover:bg-muted/50"
              >
                <span className="font-mono text-xs">{d.dsid}</span>
                <span>{nuclideLabel(d.target)}</span>
                <span className="text-xs text-muted-foreground">{d.nGammas} γ</span>
                {d.crossSection && (
                  <span className="font-mono text-xs text-muted-foreground">
                    σ {d.crossSection.evaluatorInput} b
                  </span>
                )}
              </button>
            ))}
          </div>
          {hits.length > MAX_HITS && (
            <p className="text-xs text-muted-foreground">
              {hits.length} datasets — type to narrow
            </p>
          )}
        </>
      )}
    </div>
  );
}

function DatasetView({ file, onBack }: { file: string; onBack: () => void }) {
  const { data, isLoading } = useCapGamDataset(file);

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="text-xs text-nuclear hover:underline"
      >
        ← all targets
      </button>

      {isLoading || !data ? (
        <div className="space-y-2">
          {[...Array(10)].map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            <p className="font-mono text-sm">{data.dsid}</p>
            <p className="text-sm">
              {nuclideLabel(data.target)}
              <span className="text-muted-foreground"> → </span>
              {nuclideLabel(data.product)}
            </p>
            <p className="text-xs text-muted-foreground">
              {data.crossSection && (
                <>
                  σ(n,γ) <span className="font-mono text-foreground">{data.crossSection.evaluatorInput} b</span>
                  {" · "}
                </>
              )}
              {data.gammaRecords.length} γ rays · modified {data.modificationDate}
            </p>
            <a
              href={data.ensdfLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-nuclear hover:underline"
            >
              ENSDF dataset <ExternalLink className="h-3 w-3" />
            </a>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-1.5 pr-3 text-right font-medium">E<sub>γ</sub> (keV)</th>
                <th className="py-1.5 pr-3 text-right font-medium">
                  I<sub>γ</sub> / I<sub>γ</sub>(max)
                </th>
                <th className="py-1.5 pr-3 text-right font-medium">I<sub>γ</sub> (per 100 n)</th>
                <th className="py-1.5 font-medium">Type</th>
              </tr>
            </thead>
            <tbody>
              {data.gammaRecords.slice(0, MAX_ROWS).map((g) => (
                <tr key={g.gammaID} className="border-b last:border-0">
                  <td className="py-1.5 pr-3 text-right"><Q q={g.energy} /></td>
                  <td className="py-1.5 pr-3 text-right"><Q q={g.intensityRatio} /></td>
                  <td className="py-1.5 pr-3 text-right"><Q q={g.absoluteIntensity} /></td>
                  <td className="py-1.5 text-xs text-muted-foreground">
                    {g.isPrimaryGamma ? "Primary" : "Secondary"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {data.gammaRecords.length > MAX_ROWS && (
            <p className="text-xs text-muted-foreground">
              showing {MAX_ROWS} of {data.gammaRecords.length} γ rays
            </p>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function CapGamDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data: index, isLoading } = useCapGamIndex();
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>CapGam</DialogTitle>
          <DialogDescription>
            Thermal-neutron-capture γ-rays by target nuclide — served from our own copy of NNDC's CapGam.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {isLoading || !index ? (
            <div className="space-y-2">
              {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}
            </div>
          ) : selected ? (
            <DatasetView file={selected} onBack={() => setSelected(null)} />
          ) : (
            <TargetPicker datasets={index.datasets} onSelect={(d) => setSelected(d.file)} />
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t p-4 text-xs text-muted-foreground">
          <span>
            CapGam — thermal-neutron-capture γ-rays. Served from our own copy of NNDC's dataset.
          </span>
          <a
            href="https://www.nndc.bnl.gov/capgam/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-nuclear hover:underline"
          >
            NNDC CapGam <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
