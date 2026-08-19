import { useMemo, useState } from "react";
import { useNavigate, useParams, useLocation, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { RetrieveButtons } from "@/components/RetrieveButtons";
import { RowActions } from "@/components/RowActions";
import { TableCard, TH } from "@/components/TableCard";
import { ELEMENTS } from "@/lib/structure";

type Row = { nucid: string; dsid: string; revised: string | null; refs: number };

/** /ensdf/Gd — NNDC "Datasets for Gd": every ENSDF dataset filed under any isotope of the element, by A. */
export default function ElementPage() {
  const { a: param } = useParams();
  const navigate = useNavigate();
  const base = useLocation().pathname.startsWith("/xundl") ? "/xundl" : "/ensdf";
  const raw = (param ?? "").replace(/[^A-Za-z]/g, "");
  const symbol = raw ? raw[0].toUpperCase() + raw.slice(1).toLowerCase() : "";
  const z = ELEMENTS.indexOf(symbol);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const { data, isLoading, isError } = useQuery({
    queryKey: ["element-datasets", symbol],
    enabled: z > 0,
    staleTime: 60 * 60 * 1000,
    queryFn: async () => {
      const r = await fetch(`/api/nuclide?el=${symbol.toUpperCase()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as { el: string; datasets: Row[] };
    },
  });
  const rows = useMemo(() => {
    const all = data?.datasets ?? [];
    const needle = q.trim().toLowerCase().replace(/[-\s]/g, "");
    if (!needle) return all;
    return all.filter((d) => d.nucid.toLowerCase().includes(needle) || d.dsid.toLowerCase().includes(q.trim().toLowerCase()));
  }, [data, q]);
  const keys = useMemo(() => rows.map((d) => `${d.nucid}|${d.dsid}`), [rows]);
  const allChecked = keys.length > 0 && keys.every((k) => sel.has(k));
  const toggleRow = (k: string) => setSel((prev) => { const next = new Set(prev); if (next.has(k)) next.delete(k); else next.add(k); return next; });
  const toggleAll = () => setSel((prev) => { const next = new Set(prev); if (allChecked) keys.forEach((k) => next.delete(k)); else keys.forEach((k) => next.add(k)); return next; });

  if (z <= 0) return <div className="mx-auto max-w-6xl px-4 py-6 md:px-8 text-sm text-muted-foreground">Unknown element “{param}”.</div>;
  const nucLabel = (nucid: string) => nucid.replace(/^(\d+)([A-Z])([A-Z]?)$/, (_m, a, b, c) => `${a}${b}${c.toLowerCase()}`);
  const isotopes = new Set(rows.map((d) => d.nucid)).size;
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(`${base}/chart`)} title="Back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-semibold text-primary">Datasets for {symbol}</h1>
        <span className="text-sm text-muted-foreground">Z={z}{data ? ` · ${new Set(data.datasets.map((d) => d.nucid)).size} isotopes · ${data.datasets.length.toLocaleString()} datasets` : ""}</span>
      </div>
      <h2 className="mb-2 text-sm font-semibold text-foreground">Matching datasets in ENSDF</h2>
      {isLoading ? <Skeleton className="h-64 w-full" /> : isError || !data ? (
        <p className="text-sm text-muted-foreground">Could not load datasets.</p>
      ) : (
        <TableCard
          toolbar={
            <>
              <div className="relative w-full max-w-sm">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter — an isotope (148${symbol}) or a dataset (ADOPTED LEVELS)…`} className="pl-9" />
              </div>
              <div className="ml-auto">
                <RetrieveButtons pairs={keys.filter((k) => sel.has(k))} />
              </div>
            </>
          }
          footer={
            <>
              <span>
                {rows.length === 0 ? `No dataset matches “${q}”` : `${rows.length.toLocaleString()} datasets · ${isotopes} isotopes`}
                {sel.size > 0 && ` · ${sel.size} selected`}
              </span>
              <span>Source: NNDC</span>
            </>
          }
        >
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className={`${TH} w-10`}>
                  <input type="checkbox" title="Select all shown" className="h-4 w-4 cursor-pointer align-middle accent-foreground" checked={allChecked} onChange={toggleAll} />
                </th>
                <th className={TH}>Nuclide</th>
                <th className={TH}>Dataset</th>
                <th className={`${TH} hidden sm:table-cell`}>Last revised</th>
                <th className={`${TH} text-right`}>References</th>
                <th className={`${TH} w-12 px-1`} />
              </tr>
            </thead>
            <tbody style={{ contentVisibility: "auto" } as React.CSSProperties}>
              {rows.map((d, i) => {
                const first = i === 0 || rows[i - 1].nucid !== d.nucid;
                const a = d.nucid.replace(/[A-Z]+$/, "");
                const label = nucLabel(d.nucid);
                const k = `${d.nucid}|${d.dsid}`;
                return (
                  <tr key={k} className={`border-b last:border-0 ${first ? "border-t-2 border-t-border" : ""}`}>
                    <td className="w-10 px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" className="h-4 w-4 cursor-pointer align-middle accent-foreground" checked={sel.has(k)} onChange={() => toggleRow(k)} />
                    </td>
                    <td className="px-3 py-1.5 font-mono font-semibold text-nuclear">
                      {first && <Link to={`${base}/${label}`} className="hover:underline"><sup>{a}</sup>{symbol}</Link>}
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
                          { label: "Open nuclide", onSelect: () => navigate(`${base}/${label}`) },
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
      )}
    </div>
  );
}
