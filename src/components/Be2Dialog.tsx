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
 * NNDC's B(E2; 0⁺ → 2⁺) tables in our skin, read out of our copy of their JSON.
 * Numbers come from each quantity's ndsText pair, so what shows here is the
 * rounding NNDC published rather than anything we round ourselves.
 */

interface Nuclide {
  element: string;
  symbol: string;
  z: number;
  n: number;
  a: number;
}

/** ndsText is [value], [value, error], or [value, +error, −error] — the error
 *  entries are NDS shorthand for the trailing digits of the value. */
interface Quantity {
  ndsText: string[];
  isUpperLimit?: boolean;
}

interface AdoptedEntry {
  adoptedEntryType: string;
  reference: string;
  nuclide: Nuclide;
  transitionEnergy?: Quantity;
  deformationParameter?: Quantity;
  be2?: Quantity;
  be2Weisskopf?: Quantity;
  averageHalfLife?: Quantity;
}

interface ArticleReference {
  nsrKeyNumber: string;
  publicationYear: number;
  title?: string;
  authorNames: string[];
  journalCitation: string;
}

interface ExperimentalEntry {
  nuclide: Nuclide;
  method?: string;
  articleReference?: ArticleReference;
  transitionEnergy?: Quantity;
  be2?: Quantity;
  be2Weisskopf?: Quantity;
}

interface PredictedEntry {
  nuclide: Nuclide;
  transitionEnergy?: Quantity;
  globalBestFit?: Quantity;
  be2?: Quantity;
  be2Weisskopf?: Quantity;
}

const ROW_CAP = 300;

/** The file calls this field averageHalfLife, but it is the mean lifetime: it
 *  runs a flat 1/ln2 above the adopted T½ of the 2⁺ state across the table. */
const TAU_TITLE = "mean lifetime of the 2⁺ state";

const nuclideLabel = (x: Nuclide) => (
  <span className="whitespace-nowrap font-mono">
    <sup>{x.a}</sup>
    {x.symbol}
  </span>
);

/** value ± uncertainty in NDS notation, e.g. 1368.672 5 */
function Value({ q }: { q?: Quantity }) {
  if (!q) return <span className="text-muted-foreground">—</span>;
  const [value, upper, lower] = q.ndsText;
  return (
    <span className="whitespace-nowrap font-mono text-foreground">
      {q.isUpperLimit && "≤ "}
      {value}
      {upper && (
        <span className="text-muted-foreground">{lower ? ` +${upper} −${lower}` : ` ${upper}`}</span>
      )}
    </span>
  );
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

function Loading() {
  return (
    <div className="space-y-2">
      {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}
    </div>
  );
}

/** Each set is fetched only when its tab first mounts — the experimental file
 *  alone is 2.5 MB. */
function useBe2<T>(set: string) {
  return useQuery({
    queryKey: ["be2", set],
    queryFn: async (): Promise<{ entries: T[] }> => {
      const res = await fetch(`/data/be2/${set}.json`);
      if (!res.ok) throw new Error(`be2/${set}.json: ${res.status}`);
      return res.json();
    },
    staleTime: Infinity,
  });
}

function Intro({ children }: { children: React.ReactNode }) {
  return <p className="mb-3 text-xs text-muted-foreground">{children}</p>;
}

function Empty() {
  return <p className="text-sm text-muted-foreground">No entries for that filter.</p>;
}

/* ------------------------------------------------------------------ */

function AdoptedPanel({ needle }: { needle: string }) {
  const { data, isLoading } = useBe2<AdoptedEntry>("adopted");
  const rows = useMemo(
    () => (data?.entries ?? []).filter((e) => matches(e.nuclide, needle)),
    [data, needle],
  );

  if (isLoading || !data) return <Loading />;
  if (rows.length === 0) return <Empty />;

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-1.5 pr-3 font-medium">Nuclide</th>
              <th className="py-1.5 pr-3 text-right font-medium">E(2⁺) keV</th>
              <th className="py-1.5 pr-3 text-right font-medium">B(E2)↑ e²b²</th>
              <th className="py-1.5 pr-3 text-right font-medium">B(E2)↑ W.u.</th>
              <th className="py-1.5 pr-3 text-right font-medium">β₂</th>
              <th className="py-1.5 pr-3 text-right font-medium" title={TAU_TITLE}>τ ps</th>
              <th className="py-1.5 font-medium">Reference</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, ROW_CAP).map((e, i) => (
              <tr key={i} className="border-b last:border-0">
                <td className="py-1.5 pr-3 align-top">{nuclideLabel(e.nuclide)}</td>
                <td className="py-1.5 pr-3 text-right align-top"><Value q={e.transitionEnergy} /></td>
                <td className="py-1.5 pr-3 text-right align-top"><Value q={e.be2} /></td>
                <td className="py-1.5 pr-3 text-right align-top"><Value q={e.be2Weisskopf} /></td>
                <td className="py-1.5 pr-3 text-right align-top">
                  <Value q={e.deformationParameter} />
                </td>
                <td className="py-1.5 pr-3 text-right align-top"><Value q={e.averageHalfLife} /></td>
                <td className="py-1.5 align-top">
                  <span className="block font-mono text-xs">{e.reference}</span>
                  <span className="block text-[10px] text-muted-foreground">
                    {e.adoptedEntryType.toLowerCase().replace(/_/g, " ")}
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

function ExperimentalPanel({ needle }: { needle: string }) {
  const { data, isLoading } = useBe2<ExperimentalEntry>("experimental");
  const rows = useMemo(
    () => (data?.entries ?? []).filter((e) => matches(e.nuclide, needle)),
    [data, needle],
  );

  if (isLoading || !data) return <Loading />;
  if (rows.length === 0) return <Empty />;

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-1.5 pr-3 font-medium">Nuclide</th>
              <th className="py-1.5 pr-3 text-right font-medium">E(2⁺) keV</th>
              <th className="py-1.5 pr-3 text-right font-medium">B(E2)↑ e²b²</th>
              <th className="py-1.5 pr-3 text-right font-medium">B(E2)↑ W.u.</th>
              <th className="py-1.5 pr-3 font-medium">Method</th>
              <th className="py-1.5 font-medium">Reference</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, ROW_CAP).map((e, i) => (
              <tr key={i} className="border-b last:border-0">
                <td className="py-1.5 pr-3 align-top">{nuclideLabel(e.nuclide)}</td>
                <td className="py-1.5 pr-3 text-right align-top"><Value q={e.transitionEnergy} /></td>
                <td className="py-1.5 pr-3 text-right align-top"><Value q={e.be2} /></td>
                <td className="py-1.5 pr-3 text-right align-top"><Value q={e.be2Weisskopf} /></td>
                <td className="max-w-[10rem] py-1.5 pr-3 align-top text-muted-foreground">
                  <span className="block truncate" title={e.method}>{e.method ?? "—"}</span>
                </td>
                <td className="py-1.5 align-top">
                  {e.articleReference ? (
                    <>
                      <span className="block" title={e.articleReference.title}>
                        {e.articleReference.authorNames[0] ?? "—"}
                        {e.articleReference.authorNames.length > 1 ? " et al." : ""}
                        {` (${e.articleReference.publicationYear})`}
                      </span>
                      <span className="block font-mono text-[10px] text-muted-foreground">
                        {e.articleReference.nsrKeyNumber}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
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

function PredictedPanel({ needle }: { needle: string }) {
  const { data, isLoading } = useBe2<PredictedEntry>("predicted");
  const rows = useMemo(
    () => (data?.entries ?? []).filter((e) => matches(e.nuclide, needle)),
    [data, needle],
  );

  if (isLoading || !data) return <Loading />;
  if (rows.length === 0) return <Empty />;

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-1.5 pr-3 font-medium">Nuclide</th>
              <th className="py-1.5 pr-3 text-right font-medium">E(2⁺) keV</th>
              <th className="py-1.5 pr-3 text-right font-medium">Global best fit e²b²</th>
              <th className="py-1.5 pr-3 text-right font-medium">B(E2)↑ e²b²</th>
              <th className="py-1.5 text-right font-medium">B(E2)↑ W.u.</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, ROW_CAP).map((e, i) => (
              <tr key={i} className="border-b last:border-0">
                <td className="py-1.5 pr-3">{nuclideLabel(e.nuclide)}</td>
                <td className="py-1.5 pr-3 text-right"><Value q={e.transitionEnergy} /></td>
                <td className="py-1.5 pr-3 text-right"><Value q={e.globalBestFit} /></td>
                <td className="py-1.5 pr-3 text-right"><Value q={e.be2} /></td>
                <td className="py-1.5 text-right"><Value q={e.be2Weisskopf} /></td>
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

export function Be2Dialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>B(E2; 0⁺ → 2⁺) values</DialogTitle>
          <DialogDescription>
            Reduced electric quadrupole transition probabilities for even-even nuclei — served from
            our own copy of NNDC's compilation.
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

          <Tabs defaultValue="adopted">
            <TabsList>
              <TabsTrigger value="adopted">Adopted</TabsTrigger>
              <TabsTrigger value="experimental">Experimental</TabsTrigger>
              <TabsTrigger value="predicted">Predicted</TabsTrigger>
            </TabsList>

            <TabsContent value="adopted" className="mt-4">
              <Intro>
                Pritychenko, Birch, Singh, Horoi — At. Data Nucl. Data Tables 107, 1 (2016).
              </Intro>
              <AdoptedPanel needle={needle} />
            </TabsContent>

            <TabsContent value="experimental" className="mt-4">
              <Intro>Recent measurements, from the NSR database.</Intro>
              <ExperimentalPanel needle={needle} />
            </TabsContent>

            <TabsContent value="predicted" className="mt-4">
              <Intro>
                Global best fit — Pritychenko, Birch, Singh — Nucl. Phys. A 962, 73 (2017).
              </Intro>
              <PredictedPanel needle={needle} />
            </TabsContent>
          </Tabs>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t p-4 text-xs text-muted-foreground">
          <span>NNDC B(E2) compilation. Served from our own copy.</span>
          <a
            href="https://www.nndc.bnl.gov/be2/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-nuclear hover:underline"
          >
            NNDC B(E2) <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
