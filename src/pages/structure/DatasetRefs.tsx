import { useMemo } from "react";
import { useNavigate, useParams, useLocation, useSearchParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TexText } from "@/components/TexText";
import type { NsrRecord } from "@/types/nsr";
import { Nuc } from "./Nuclide";
import { parseNuclide } from "@/lib/nuclide";

/**
 * References quoted in one dataset — NNDC's getrefs.jsp, from our own tables:
 * every NSR key the dataset cites, rendered as full NSR records (reference,
 * authors, title, keyword abstract, DOI). Keys not in our corpus are listed too.
 */
export default function DatasetRefsPage() {
  const { a: param } = useParams();
  const [sp] = useSearchParams();
  const dsid = sp.get("dsid") ?? "";
  const navigate = useNavigate();
  const loc = useLocation();
  const source: "ensdf" | "xundl" = loc.pathname.startsWith("/xundl") ? "xundl" : "ensdf";
  const base = `/${source}`;
  // "/ensdf/148/refs?dsid=COMMENTS" — the chain-level record has no element symbol.
  const nuc = useMemo(() => (/^\d{1,3}$/.test(param ?? "") ? { a: Number(param), symbol: "", nucid: param! } : parseNuclide(param)), [param]);

  const { data, isLoading } = useQuery({
    queryKey: ["dataset-refs", source, nuc?.nucid, dsid],
    queryFn: async () => {
      const r = await fetch(`/api/nuclide?nucid=${nuc!.nucid}&source=${source}&dsid=${encodeURIComponent(dsid)}`);
      if (!r.ok) throw new Error(`refs ${r.status}`);
      return r.json() as Promise<{ dataset: { dsid: string; revised: string | null } | null; refs: NsrRecord[]; missing: string[] }>;
    },
    enabled: !!nuc && !!dsid,
    staleTime: 1000 * 60 * 30,
  });

  if (!nuc || !dsid) return <div className="mx-auto max-w-6xl px-4 py-6 md:px-8 text-sm text-muted-foreground">Nothing to show.</div>;
  const total = (data?.refs.length ?? 0) + (data?.missing.length ?? 0);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(`${base}/${nuc.a}${nuc.symbol}`)} title="Back to datasets">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-xl font-semibold text-primary">
            References quoted in the {source.toUpperCase()} dataset
          </h1>
          <p className="mt-0.5 font-mono text-sm text-foreground">
            {nuc.symbol ? <Nuc a={nuc.a} symbol={nuc.symbol} /> : <span>{nuc.a}</span>} · {dsid}
            {data?.dataset?.revised && <span className="ml-2 text-xs text-muted-foreground">revised {data.dataset.revised}</span>}
          </p>
        </div>
      </div>

      {isLoading || !data ? (
        <div className="space-y-2">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted-foreground">
            {total} reference{total === 1 ? "" : "s"} found. Click a key number to open the record.
          </p>
          <div className="divide-y rounded-lg border">
            {data.refs.map((r) => (
              <article key={r.key_number} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Link to={`/search?q=%23${r.key_number}`} className="font-mono text-sm font-semibold text-nuclear hover:underline">{r.key_number}</Link>
                  {r.reference && <span className="text-xs text-muted-foreground">{r.reference}</span>}
                  {/* the citation string usually ends in "(2019)" already — only add the year when it doesn't */}
                  {r.pub_year && !(r.reference ?? "").includes(String(r.pub_year)) && (
                    <span className="text-xs text-muted-foreground">({r.pub_year})</span>
                  )}
                </div>
                {r.authors && <p className="mt-0.5 break-words text-xs text-muted-foreground">{r.authors}</p>}
                {r.title && <p className="mt-1 text-sm italic text-foreground"><TexText text={r.title} /></p>}
                {/* selector chains ("153Ba/154Ba/…") have no spaces — break-words keeps them inside the card */}
                {r.keywords && <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground"><TexText text={r.keywords} /></p>}
                {r.doi && (
                  <a href={`https://doi.org/${r.doi}`} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-nuclear hover:underline">
                    <ExternalLink className="h-3 w-3" /> doi: {r.doi}
                  </a>
                )}
              </article>
            ))}
            {data.missing.map((k) => (
              <article key={k} className="px-4 py-3">
                <span className="font-mono text-sm font-semibold text-muted-foreground">{k}</span>
                <span className="ml-2 text-xs text-muted-foreground">cited by the dataset; not in our corpus</span>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
