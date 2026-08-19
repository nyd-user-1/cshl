import { useMemo, useState } from "react";
import { useNavigate, useParams, useLocation, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ELEMENTS } from "@/lib/structure";
import { parseNuclide, useNuclide, type ParentDs } from "@/lib/nuclide";
import { useRowSelection } from "@/lib/rowSelection";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RetrieveButtons } from "@/components/RetrieveButtons";
import { SearchInput } from "@/components/SearchInput";
import { RowActions } from "@/components/RowActions";
import { TableCard, TH } from "@/components/TableCard";
import { PaperCard } from "@/pages/StructureMass";

/**
 * Datasets for one nuclide — the analog of NNDC's DatasetFetchServlet page.
 *   /ensdf/148Gd → "Datasets for ¹⁴⁸Gd": every ENSDF dataset (dsid, last revised,
 *                  references) + the count/link to its XUNDL sets
 *   /xundl/148Gd → the same for XUNDL
 * Data: /api/nuclide (ensdf_datasets / xundl_archive_datasets + refs tables).
 */

const nucLabel = (nucid: string) => {
  const m = /^(\d+)([A-Z]{1,2})$/.exec(nucid);
  return m ? `${m[1]}${m[2][0]}${m[2].slice(1).toLowerCase()}` : nucid;
};

export function Nuc({ a, symbol }: { a: number; symbol: string }) {
  return <span><sup>{a}</sup>{symbol}</span>;
}

export default function NuclidePage() {
  const { a: param } = useParams();
  const navigate = useNavigate();
  const loc = useLocation();
  const source: "ensdf" | "xundl" = loc.pathname.startsWith("/xundl") ? "xundl" : "ensdf";
  const base = `/${source}`;
  const nuc = useMemo(() => parseNuclide(param), [param]);
  const { data, isLoading } = useNuclide(nuc?.nucid ?? null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  // NNDC's /ensnds static tree: the ORIGINAL typeset PDFs for CapGam's capture
  // datasets (verified by scripts/build-ensnds-map.mjs). Keyed "<NUCID>|<DSID>".
  const { data: ensnds } = useQuery({
    queryKey: ["ensnds-map"],
    queryFn: async () => (await fetch("/data/ensnds-map.json")).json() as Promise<{ map: Record<string, string> }>,
    staleTime: Infinity,
  });
  // We open OUR mirrored copy (s3 via /api/ensnds); the map records NNDC's canonical URL.
  const nndcPdf = (dsid: string) => {
    const canonical = nuc ? ensnds?.map?.[`${nuc.nucid}|${dsid}`] : undefined;
    return canonical ? `/api/ensnds?f=${encodeURIComponent(decodeURI(canonical.replace("https://www.nndc.bnl.gov/ensnds/", "")))}` : undefined;
  };

  if (!nuc) return <div className="mx-auto max-w-6xl px-4 py-6 md:px-8 text-sm text-muted-foreground">Unknown nuclide “{param}”.</div>;

  const z = ELEMENTS.indexOf(nuc.symbol);
  const allRows = source === "xundl" ? data?.xundl : data?.ensdf;
  const f = filter.trim().toUpperCase();
  const rows = f ? allRows?.filter((d) => d.dsid.toUpperCase().includes(f)) : allRows;
  const other = source === "xundl" ? data?.ensdf : data?.xundl;
  const otherLabel = source === "xundl" ? "ENSDF (evaluated) datasets" : "XUNDL (unevaluated) sets";
  const otherBase = source === "xundl" ? "/ensdf" : "/xundl";
  const neighbor = (dz: number) => {
    const sym = ELEMENTS[z + dz];
    return sym ? `${base}/${nuc.a}${sym}` : null;
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(`${base}/${nuc.a}`)} title={`Mass chain A=${nuc.a}`}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-semibold text-primary">
          Matching Datasets {source === "xundl" ? "in XUNDL " : ""}for <Nuc a={nuc.a} symbol={nuc.symbol} />
        </h1>
        <span className="flex-1" />
        <Button variant="ghost" size="icon" onClick={() => { const p = neighbor(-1); if (p) navigate(p); }} title="Z − 1"><ArrowLeft className="h-4 w-4" /></Button>
        <Button variant="ghost" size="icon" onClick={() => { const p = neighbor(1); if (p) navigate(p); }} title="Z + 1"><ArrowRight className="h-4 w-4" /></Button>
      </div>

      {isLoading || !rows ? (
        <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
      ) : (allRows?.length ?? 0) === 0 ? (
        <p className="text-sm text-muted-foreground">No {source.toUpperCase()} datasets for this nuclide in the loaded distribution.</p>
      ) : (
        <TableCard
          toolbar={
            <>
              <div className="w-full max-w-sm">
                <SearchInput value={filter} onChange={setFilter} placeholder="Filter datasets — ADOPTED LEVELS, B- DECAY…" />
              </div>
              <div className="ml-auto">
                <RetrieveButtons pairs={rows.map((d) => `${nuc.nucid}|${d.dsid}`).filter((k) => sel.has(k))} src={source} />
              </div>
            </>
          }
          footer={
            <>
              <span>{rows.length} datasets{sel.size > 0 && ` · ${sel.size} selected`}</span>
              <span>Source: NNDC</span>
            </>
          }
        >
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className={`${TH} w-10`}>
                  <input
                    type="checkbox"
                    title="Select all"
                    className="h-4 w-4 cursor-pointer align-middle accent-foreground"
                    checked={rows.length > 0 && rows.every((d) => sel.has(`${nuc.nucid}|${d.dsid}`))}
                    onChange={() => setSel((prev) => {
                      const keys = rows.map((d) => `${nuc.nucid}|${d.dsid}`);
                      const all = keys.every((k) => prev.has(k));
                      const next = new Set(prev);
                      keys.forEach((k) => { if (all) next.delete(k); else next.add(k); });
                      return next;
                    })}
                  />
                </th>
                <th className={TH}>Dataset</th>
                <th className={`${TH} w-1/4`}>Last Revised</th>
                <th className={`${TH} w-1/4 text-right`}>References</th>
                <th className={`${TH} w-12 px-1`} />
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const k = `${nuc.nucid}|${d.dsid}`;
                const refsPath = `${base}/${nuc.a}${nuc.symbol}/refs?dsid=${encodeURIComponent(d.dsid)}`;
                return (
                  <tr key={d.dsid} className="border-b last:border-0 transition-colors hover:bg-muted/50">
                    <td className="w-10 px-3 py-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 cursor-pointer align-middle accent-foreground"
                        checked={sel.has(k)}
                        onChange={() => setSel((prev) => { const next = new Set(prev); if (next.has(k)) next.delete(k); else next.add(k); return next; })}
                      />
                    </td>
                    <td className="px-3 py-2 font-mono text-foreground">{d.dsid}</td>
                    <td className="w-1/4 px-3 py-2 text-muted-foreground">{d.revised ?? "—"}</td>
                    <td className="w-1/4 px-3 py-2 text-right">
                      {d.refs > 0 ? (
                        <Link to={refsPath} className="text-nuclear hover:underline">
                          {d.refs} reference{d.refs === 1 ? "" : "s"}
                        </Link>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="w-12 px-1 py-2 text-right">
                      <RowActions
                        items={[
                          ...(d.refs > 0 ? [{ label: "Open references", onSelect: () => navigate(refsPath) }] : []),
                          { label: "ENSDF text format", onSelect: () => window.open(`/api/nuclide?text=1&fmt=view${source === "xundl" ? "&src=xundl" : ""}&ds=${encodeURIComponent(k)}`, "_blank", "noopener") },
                          ...(source === "ensdf" && nndcPdf(d.dsid) ? [{ label: "Original NNDC PDF", onSelect: () => window.open(nndcPdf(d.dsid)!, "_blank", "noopener") }] : []),
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
      )}

      {other && (
        <p className="mt-3 text-sm">
          <Link to={`${otherBase}/${nuc.a}${nuc.symbol}`} className="text-nuclear hover:underline">
            {other.length === 0 ? `No corresponding ${otherLabel}` : `There ${other.length === 1 ? "is" : "are"} ${other.length} corresponding ${otherLabel}`}
          </Link>
        </p>
      )}

      {/* NNDC's second table: decay datasets filed under daughters that name this nuclide
          as parent — BOTH sources shown (their ENSDF page lists the XUNDL parents too),
          same-source first. Links stay within each dataset's own source. */}
      {data && (source === "xundl" ? (["xundl", "ensdf"] as const) : (["ensdf", "xundl"] as const))
        .map((src) => {
          const parents = data.parent[src];
          if (parents.length === 0) return null;
          return (
            <ParentTable key={src} src={src} same={src === source} parents={parents} a={nuc.a} symbol={nuc.symbol} />
          );
        })}

      {/* Literature on exactly this nuclide (NSR nuclide selectors) */}
      {data && data.literature.total > 0 && (
        <>
          <Tabs defaultValue="top" className="mt-12">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-foreground">NSR Papers</h2>
              <TabsList>
                <TabsTrigger value="top">Most cited</TabsTrigger>
                <TabsTrigger value="recent">Recent</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="top">
              <div className="grid gap-3 sm:grid-cols-2">{data.literature.top.map((p) => <PaperCard key={p.key} p={p} />)}</div>
            </TabsContent>
            <TabsContent value="recent">
              <div className="grid gap-3 sm:grid-cols-2">{data.literature.recent.map((p) => <PaperCard key={p.key} p={p} />)}</div>
            </TabsContent>
          </Tabs>
        </>
      )}

      <p className="mt-4 text-xs text-muted-foreground">
        Source: NNDC {source === "xundl" ? "XUNDL" : "ENSDF"} distribution parsed into our database ·{" "}
        <a
          href={source === "xundl"
            ? `https://www.nndc.bnl.gov/ensdf/XundlFetchServlet?datasource=xundl&nuc=${nuc.a}${nuc.symbol}`
            : `https://www.nndc.bnl.gov/ensdf/DatasetFetchServlet?nuc=${nuc.a}${nuc.symbol}`}
          target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-nuclear hover:underline"
        >
          <ExternalLink className="h-3 w-3" /> view at NNDC
        </a>
      </p>
    </div>
  );
}

/** NNDC's parent-decay table (per source): select column, retrieve buttons, ⋮ actions — the TableCard standard. */
function ParentTable({ src, same, parents, a, symbol }: { src: "ensdf" | "xundl"; same: boolean; parents: ParentDs[]; a: number; symbol: string }) {
  const navigate = useNavigate();
  const base = `/${src}`;
  const keys = parents.map((d) => `${d.nucid}|${d.dsid}`);
  const { sel, allChecked, toggleRow, toggleAll } = useRowSelection(keys);
  return (
    <div>
      <h2 className="mb-2 mt-12 text-sm font-semibold text-foreground">
        These {src.toUpperCase()} decay datasets have <Nuc a={a} symbol={symbol} /> as a parent
        {!same && <span className="ml-1.5 font-normal text-muted-foreground">and could also be useful</span>}
      </h2>
      <TableCard
        toolbar={<div className="ml-auto"><RetrieveButtons pairs={keys.filter((k) => sel.has(k))} src={src} /></div>}
        footer={
          <>
            <span>{parents.length} dataset{parents.length === 1 ? "" : "s"}{sel.size > 0 && ` · ${sel.size} selected`}</span>
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
              <th className={`${TH} w-1/6`}>Nuclide</th>
              <th className={TH}>Dataset</th>
              <th className={`${TH} w-1/4`}>Last Revised</th>
              <th className={`${TH} w-1/4 text-right`}>References</th>
              <th className={`${TH} w-12 px-1`} />
            </tr>
          </thead>
          <tbody>
            {parents.map((d) => {
              const k = `${d.nucid}|${d.dsid}`;
              const label = nucLabel(d.nucid);
              const refsPath = `${base}/${label}/refs?dsid=${encodeURIComponent(d.dsid)}`;
              return (
                <tr key={k} className="border-b last:border-0 transition-colors hover:bg-muted/50">
                  <td className="w-10 px-3 py-2">
                    <input type="checkbox" className="h-4 w-4 cursor-pointer align-middle accent-foreground" checked={sel.has(k)} onChange={() => toggleRow(k)} />
                  </td>
                  <td className="px-3 py-2">
                    <Link to={`${base}/${label}`} className="font-mono text-nuclear hover:underline">{label}</Link>
                  </td>
                  <td className="px-3 py-2 font-mono text-foreground">{d.dsid}</td>
                  <td className="px-3 py-2 text-muted-foreground">{d.revised ?? "—"}</td>
                  <td className="px-3 py-2 text-right">
                    {d.refs > 0 ? (
                      <Link to={refsPath} className="text-nuclear hover:underline">{d.refs} reference{d.refs === 1 ? "" : "s"}</Link>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="w-12 px-1 py-2 text-right">
                    <RowActions
                      items={[
                        { label: "Open nuclide", onSelect: () => navigate(`${base}/${label}`) },
                        ...(d.refs > 0 ? [{ label: "Open references", onSelect: () => navigate(refsPath) }] : []),
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
