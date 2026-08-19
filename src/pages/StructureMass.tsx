import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useLocation, Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, Share2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TexText } from "@/components/TexText";
import { RetrieveButtons } from "@/components/RetrieveButtons";
import { SearchInput } from "@/components/SearchInput";
import { RowActions } from "@/components/RowActions";
import { TableCard, TH } from "@/components/TableCard";
import { useMassChain, type LitPaper } from "@/lib/structure";
import { useRowSelection } from "@/lib/rowSelection";

type ChainDataset = { nucid: string; dsid: string; revised: string | null; refs: number };
const useChainDatasets = (a: number | null) =>
  useQuery({
    queryKey: ["chain-datasets", a],
    enabled: a != null,
    staleTime: 60 * 60 * 1000,
    queryFn: async () => {
      const r = await fetch(`/api/nuclide?a=${a}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as { a: number; datasets: ChainDataset[] };
    },
  });
const nucLabel = (nucid: string) => nucid.replace(/^(\d+)([A-Z])([A-Z]?)$/, (_m, a, b, c) => `${a}${b}${c.toLowerCase()}`);

/** NNDC's "Datasets for 148" table — every ENSDF dataset in the chain, grouped by nuclide. */
function ChainDatasetsTable({ a, base }: { a: number; base: string }) {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useChainDatasets(a);
  const [filter, setFilter] = useState("");
  const allRows = data?.datasets ?? [];
  const f = filter.trim().toUpperCase();
  const rows = f ? allRows.filter((d) => d.nucid.includes(f) || d.dsid.toUpperCase().includes(f)) : allRows;
  const { sel, allChecked, toggleRow, toggleAll } = useRowSelection(rows.map((d) => `${d.nucid}|${d.dsid}`));
  if (isLoading) return <Skeleton className="mb-6 h-40 w-full" />;
  if (isError || !data) return <p className="mb-6 text-sm text-muted-foreground">Could not load the chain's datasets.</p>;
  const selPairs = rows.map((d) => `${d.nucid}|${d.dsid}`).filter((k) => sel.has(k));
  return (
    <div className="mb-12">
      <TableCard
        toolbar={
          <>
            <div className="w-full max-w-sm">
              <SearchInput value={filter} onChange={setFilter} placeholder="Filter datasets — 180Er, ADOPTED LEVELS, B- DECAY…" />
            </div>
            <div className="ml-auto"><RetrieveButtons pairs={selPairs} /></div>
          </>
        }
        footer={
          <>
            <span>{rows.length.toLocaleString()} datasets{sel.size > 0 && ` · ${sel.size} selected`}</span>
            <span>Source: NNDC</span>
          </>
        }
      >
        <table className="w-full table-fixed text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className={`${TH} w-10`}>
                <input type="checkbox" title="Select all" className="h-4 w-4 cursor-pointer align-middle accent-foreground" checked={allChecked} onChange={toggleAll} />
              </th>
              <th className={TH}>Nuclide</th>
              <th className={TH}>Dataset</th>
              <th className={`${TH} hidden sm:table-cell`}>Last Revised</th>
              <th className={`${TH} text-right`}>References</th>
              <th className={`${TH} w-12 px-1`} />
            </tr>
          </thead>
          <tbody>
            {rows.map((d, i) => {
              const first = i === 0 || rows[i - 1].nucid !== d.nucid;
              const sym = d.nucid.replace(/^\d+/, "");
              const label = sym ? nucLabel(d.nucid) : String(a);
              const k = `${d.nucid}|${d.dsid}`;
              return (
                <tr key={k} className={`border-b last:border-0 ${first ? "border-t-2 border-t-border" : ""}`}>
                  <td className="w-10 px-3 py-1.5">
                    <input type="checkbox" className="h-4 w-4 cursor-pointer align-middle accent-foreground" checked={sel.has(k)} onChange={() => toggleRow(k)} />
                  </td>
                  <td className="px-3 py-1.5 font-mono font-semibold text-nuclear">
                    {first ? (
                      sym ? <Link to={`${base}/${label}`} className="hover:underline"><sup>{a}</sup>{sym.charAt(0) + sym.slice(1).toLowerCase()}</Link> : <span>{a}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs">{d.dsid}</td>
                  <td className="hidden px-3 py-1.5 font-mono text-xs text-muted-foreground sm:table-cell">{d.revised ?? "—"}</td>
                  <td className="px-3 py-1.5 text-right text-xs">
                    {d.refs > 0 ? (
                      <Link to={`${base}/${label}/refs?dsid=${encodeURIComponent(d.dsid)}`} className="text-nuclear hover:underline">
                        {d.refs.toLocaleString()} {d.refs === 1 ? "reference" : "references"}
                      </Link>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="w-12 px-1 py-1.5 text-right">
                    <RowActions
                      items={[
                        ...(sym ? [{ label: "Open nuclide", onSelect: () => navigate(`${base}/${label}`) }] : []),
                        ...(d.refs > 0 ? [{ label: "Open references", onSelect: () => navigate(`${base}/${label}/refs?dsid=${encodeURIComponent(d.dsid)}`) }] : []),
                        { label: "Copy dataset id", onSelect: () => { navigator.clipboard?.writeText(d.dsid).catch(() => {}); } },
                      ]}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableCard>
    </div>
  );
}

export function PaperCard({ p }: { p: LitPaper }) {
  const href = p.doi ? `https://doi.org/${p.doi}` : undefined;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`flex h-full flex-col rounded-lg border bg-card p-3 transition-colors ${href ? "hover:bg-muted/50" : "cursor-default"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-xs font-semibold text-nuclear">{p.key}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {p.pdf && <Badge variant="secondary" className="text-[10px]">PDF</Badge>}
          {!p.nsr && <Badge variant="outline" className="text-[10px]">preprint</Badge>}
          {p.cites != null && p.cites > 0 && (
            <span className="text-[10px] text-muted-foreground">{p.cites.toLocaleString()} cites</span>
          )}
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-sm font-medium leading-snug text-foreground">
        {p.title ? <TexText text={p.title} /> : <span className="italic text-muted-foreground">Untitled — {p.key}</span>}
      </p>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">
        {p.authors ?? "—"} · {p.year}
      </p>
      {p.nucs && p.nucs.length > 0 && (
        <div className="mt-auto flex flex-wrap gap-1 pt-2">
          {p.nucs.slice(0, 8).map((n) => (
            <span key={n} className="rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-foreground">{n}</span>
          ))}
          {p.nucs.length > 8 && <span className="text-[10px] text-muted-foreground">+{p.nucs.length - 8}</span>}
        </div>
      )}
    </a>
  );
}

export default function StructureMass() {
  const { a } = useParams();
  const mass = Number(a);
  const navigate = useNavigate();
  const base = useLocation().pathname.startsWith("/xundl") ? "/xundl" : "/ensdf";
  const { data, isLoading } = useMassChain(Number.isFinite(mass) ? mass : null);
  const xSel = useRowSelection((data?.datasets ?? []).map((d) => String(d.recid)));

  if (isLoading || !data) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-6 md:px-8">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(`${base}/chart`)} title="All mass chains">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-2xl font-semibold text-primary">Matching Datasets for {data.a}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate(`/graph?center=${encodeURIComponent(`nuclide:${data.a}${(data.nuclides[0]?.el ?? "").toUpperCase()}`)}`)}>
            <Share2 className="mr-1.5 h-3.5 w-3.5" /> Graph
          </Button>
          <Button variant="ghost" size="icon" onClick={() => navigate(`${base}/${data.a - 1}`)} disabled={data.a <= 1} title={`A=${data.a - 1}`}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => navigate(`${base}/${data.a + 1}`)} title={`A=${data.a + 1}`}>
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* NNDC parity: the chain's dataset table is the page's primary table (their /ensdf/180). */}
      <ChainDatasetsTable a={data.a} base={base} />

      <div className="mt-12">
        <h2 className="mb-2 text-sm font-semibold text-foreground">XUNDL datasets which came in after the cutoff date of the last ENSDF evaluation</h2>
        {data.datasets.length === 0 ? (
          <p className="text-sm text-muted-foreground">No XUNDL datasets since the evaluation cutoff.</p>
        ) : (
          <TableCard
            toolbar={
              <div className="ml-auto">
                <RetrieveButtons
                  src="xundl"
                  pairs={data.datasets.filter((d) => xSel.sel.has(String(d.recid))).map((d) => `${d.nuclide}|${d.dataset}`)}
                />
              </div>
            }
            footer={
              <>
                <span>{data.datasets.length.toLocaleString()} XUNDL datasets{xSel.sel.size > 0 && ` · ${xSel.sel.size} selected`}</span>
                <span>Source: NNDC</span>
              </>
            }
          >
            <table className="w-full table-fixed text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className={`${TH} w-10`}>
                    <input type="checkbox" title="Select all" className="h-4 w-4 cursor-pointer align-middle accent-foreground" checked={xSel.allChecked} onChange={xSel.toggleAll} />
                  </th>
                  <th className={`${TH} w-1/6`}>Nuclide</th>
                  <th className={TH}>Dataset</th>
                  <th className={`${TH} w-1/5`}>Last Revised</th>
                  <th className={`${TH} w-1/5 text-right`}>References</th>
                  <th className={`${TH} w-12 px-1`} />
                </tr>
              </thead>
              <tbody>
                {data.datasets.map((d) => {
                  const nuc = d.nuclide.replace(/^(\d+)([A-Z])([A-Z]?)$/, (_m, a, e1, e2) => `${a}${e1}${(e2 || "").toLowerCase()}`);
                  const refsPath = `/xundl/${nuc}/refs?dsid=${encodeURIComponent(d.dataset)}`;
                  return (
                    <tr key={`${d.recid}`} className="border-b last:border-0">
                      <td className="w-10 px-3 py-2">
                        <input type="checkbox" className="h-4 w-4 cursor-pointer align-middle accent-foreground" checked={xSel.sel.has(String(d.recid))} onChange={() => xSel.toggleRow(String(d.recid))} />
                      </td>
                      <td className="px-3 py-2">
                        <Link to={`/xundl/${nuc}`} className="font-mono font-semibold text-nuclear hover:underline">
                          <sup>{data.a}</sup>{nuc.replace(/^\d+/, "")}
                        </Link>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{d.dataset}</td>
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{d.revised ?? "—"}</td>
                      <td className="px-3 py-2 text-right text-xs">
                        <Link to={refsPath} className="text-nuclear hover:underline">All references</Link>
                      </td>
                      <td className="w-12 px-1 py-2 text-right">
                        <RowActions
                          items={[
                            { label: "Open nuclide", onSelect: () => navigate(`/xundl/${nuc}`) },
                            { label: "Open references", onSelect: () => navigate(refsPath) },
                            { label: "Copy dataset id", onSelect: () => { navigator.clipboard?.writeText(d.dataset).catch(() => {}); } },
                          ]}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableCard>
        )}
      </div>

      <Tabs defaultValue="top" className="mt-12">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground">NSR Papers</h2>
          <TabsList>
            <TabsTrigger value="top">Most cited</TabsTrigger>
            <TabsTrigger value="recent">Recent</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="top" className="mt-0 grid gap-3 md:grid-cols-2">
          {data.literature.top.map((p) => <PaperCard key={p.key} p={p} />)}
        </TabsContent>
        <TabsContent value="recent" className="mt-0 grid gap-3 md:grid-cols-2">
          {data.literature.recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">The most-cited papers are also the most recent for this chain.</p>
          ) : (
            data.literature.recent.map((p) => <PaperCard key={p.key} p={p} />)
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
