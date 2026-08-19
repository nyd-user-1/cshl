import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Download } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * XUNDL archivals — the monthly full dumps NNDC publishes at
 * nndc.bnl.gov/xundlarchivals. Same layout as /ensdf/archive; data from
 * scripts/build-xundl-archivals.mjs.
 */

interface Distribution {
  year: string;
  files: string[];
  /** name → bytes, from the S3 mirror (scripts/enrich-ensdf-archivals.mjs). */
  bytes?: Record<string, number>;
}
interface Archivals {
  distributions: Distribution[];
  latest: Distribution;
  loadedSnapshot?: string;
  stats?: {
    datasets: number; nuclides: number; decays: number; reactions: number; publications: number; mass_chains: number;
    archivedFiles: number; archivedBytes: number;
  };
}

/** dist{YY} — NNDC files each year's snapshots under the two-digit year. */
const fileUrl = (year: string, file: string) =>
  `https://www.nndc.bnl.gov/xundlarchivals/distributions/dist${year.slice(-2)}/${file}`;

const fmtBytes = (b?: number) => {
  if (!b) return "—";
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  return `${Math.round(b / 1e3)} kB`;
};

function FileTable({ dist }: { dist: Distribution }) {
  return (
    <table className="w-full text-sm">
      <tbody>
        {dist.files.map((f) => (
          <tr key={f} className="border-b last:border-0">
            <td className="px-3 py-1.5">
              <a
                href={fileUrl(dist.year, f)}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-xs text-nuclear hover:underline"
              >
                {f}
              </a>
            </td>
            <td className="px-3 py-1.5 text-right font-mono text-xs text-muted-foreground">
              {fmtBytes(dist.bytes?.[f])}
            </td>
            <td className="w-10 px-3 py-1.5 text-right">
              <a
                href={fileUrl(dist.year, f)}
                target="_blank"
                rel="noopener noreferrer"
                title={`Download ${f}`}
                className="inline-flex text-muted-foreground transition-colors hover:text-foreground"
              >
                <Download className="h-3.5 w-3.5" />
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function YearSection({ dist }: { dist: Distribution }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b last:border-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-sm transition-colors hover:bg-muted/50"
      >
        <span className="flex items-center gap-3">
          <span className="font-mono font-semibold text-foreground">{dist.year}</span>
          <span className="text-xs text-muted-foreground">
            {dist.files.length} file{dist.files.length === 1 ? "" : "s"}
          </span>
        </span>
        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && <div className="border-t bg-muted/20"><FileTable dist={dist} /></div>}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">{value}</span>
    </div>
  );
}

export default function XundlArchive() {
  const { data, isLoading } = useQuery({
    queryKey: ["xundl-archivals"],
    queryFn: async (): Promise<Archivals> => {
      const res = await fetch("/data/xundl-archivals.json");
      if (!res.ok) throw new Error(`xundl-archivals.json: ${res.status}`);
      return res.json();
    },
    staleTime: Infinity,
  });

  const sorted = useMemo(
    () => [...(data?.distributions ?? [])].sort((a, b) => Number(b.year) - Number(a.year)),
    [data],
  );
  const s = data?.stats;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold text-primary">XUNDL archivals</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every archived XUNDL distribution NNDC publishes, back to 2009.
        </p>
      </div>

      <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
        The <span className="font-medium text-foreground">Experimental Unevaluated Nuclear Data List</span>{" "}
        (XUNDL) holds compiled — not yet evaluated — experimental nuclear structure data, mostly from
        recent publications: level schemes, gamma-ray properties and decay data as reported by the
        authors, entered in ENSDF format so evaluators and users can see new results before the next
        full mass-chain evaluation. Compilation is led by the McMaster/TRIUMF group with NNDC; XUNDL
        datasets are the "new datasets" that later feed ENSDF.
      </p>
      <p className="mb-5 text-sm leading-relaxed text-muted-foreground">
        Our copy is the latest distribution, <span className="font-mono text-xs text-foreground">{data?.loadedSnapshot ?? "xundl_260101.zip"}</span>,
        parsed into the database dataset by dataset and linked to the NSR corpus through the key numbers each
        dataset cites. The figures below are counted from that file. Download links point to NNDC's originals.
      </p>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {([
          ["Datasets", s?.datasets],
          ["Nuclides", s?.nuclides],
          ["Decays", s?.decays],
          ["Reactions", s?.reactions],
          ["Publications", s?.publications],
        ] as const).map(([label, v]) => (
          <Card key={label}><CardContent className="p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-0.5 font-mono text-sm font-semibold text-foreground">
              {typeof v === "number" ? v.toLocaleString() : (v ?? "—")}
            </p>
          </CardContent></Card>
        ))}
      </div>

      <div className="mb-5 grid gap-3 sm:grid-cols-2">
        <Card><CardContent className="p-4">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Deposition</h2>
          <Fact label="Depositor" value="Elizabeth Ricard-McCutchan" />
          <Fact label="Contact" value={<a className="text-nuclear hover:underline" href="mailto:mccutchan@bnl.gov">mccutchan@bnl.gov</a>} />
          <Fact label="Last modified" value="2026-01-01" />
          <Fact
            label="DOI"
            value={
              <a className="font-mono text-xs text-nuclear hover:underline" href="https://doi.org/10.18139/nndc.xundl/1860326" target="_blank" rel="noopener noreferrer">
                10.18139/nndc.xundl/1860326
              </a>
            }
          />
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Coverage</h2>
          <Fact label="Loaded snapshot" value={<span className="font-mono text-xs">{data?.loadedSnapshot ?? "—"}</span>} />
          <Fact label="Mass chains" value={s ? s.mass_chains.toLocaleString() : "—"} />
          <Fact label="Archive" value={s ? `${s.archivedFiles} files · ${fmtBytes(s.archivedBytes)}` : "—"} />
          <Fact
            label="Source"
            value={
              <a className="text-nuclear hover:underline" href="https://www.nndc.bnl.gov/xundlarchivals/" target="_blank" rel="noopener noreferrer">
                nndc.bnl.gov/xundlarchivals
              </a>
            }
          />
        </CardContent></Card>
      </div>

      {isLoading || !data ? (
        <div className="space-y-2">{[...Array(8)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
      ) : (
        <>
          <h2 className="mb-2 text-sm font-semibold text-foreground">
            Latest distributions{" "}
            <span className="ml-1 font-mono text-nuclear">{data.latest.year}</span>
          </h2>
          <div className="mb-5 overflow-hidden rounded-lg border">
            <FileTable dist={data.latest} />
          </div>

          <h2 className="mb-2 text-sm font-semibold text-foreground">Archived distributions</h2>
          <div className="overflow-hidden rounded-lg border">
            {sorted.filter((d) => d.year !== data.latest.year).map((d) => <YearSection key={d.year} dist={d} />)}
          </div>
        </>
      )}
    </div>
  );
}
