import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { RowActions } from "@/components/RowActions";
import { TableCard, TH } from "@/components/TableCard";
import { AGE_COLORS, ageLabel, parseMassQuery, useStructureIndex } from "@/lib/structure";

/**
 * Our evaluation index — the modern twin of NNDC's evaluation-index.html.
 * One row per mass chain, with the nuclide-level evaluations that supersede
 * the chain evaluation nested beneath it. Citations that resolve to a unique
 * NSR paper link into the graph. Table follows the /ensdf card standard.
 */

/** Years elapsed between an evaluation cutoff and the data build, bucketed 0–11; 12 = unknown. */
const bucket = (cutoff: string | null, generated: string) =>
  cutoff ? Math.max(0, Math.min(11, Math.floor((Date.parse(generated) - Date.parse(cutoff)) / 3.156e10))) : 12;

const el = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

function CutoffCell({ cutoff, b }: { cutoff: string | null; b: number }) {
  return (
    <td className="hidden px-3 py-2 sm:table-cell">
      <span className="mr-1.5 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: AGE_COLORS[b] }} />
      <span className="text-muted-foreground">{cutoff ?? "—"}</span>
      <span className="ml-1.5 text-xs text-muted-foreground">({ageLabel(b)})</span>
    </td>
  );
}

function Citation({ citation, cite, className }: { citation: string | null; cite?: string | null; className: string }) {
  if (!citation) return <td className={className}>—</td>;
  return (
    <td className={className}>
      {cite ? (
        <Link to={`/graph?center=paper:${cite}`} className="text-nuclear hover:underline" title={`Open ${cite} in the graph`}>
          {citation}
        </Link>
      ) : (
        citation
      )}
    </td>
  );
}

export default function Evaluation() {
  const navigate = useNavigate();
  const { data, isLoading } = useStructureIndex();
  const masses = useMemo(() => data?.masses ?? [], [data]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return masses;
    const a = parseMassQuery(s);
    return masses.filter((m) => {
      if (a !== null) return m.a === a;
      return (
        (m.citation ?? "").toLowerCase().includes(s) ||
        m.nuclideEvals.some(
          (n) => n.el.toLowerCase() === s || `${m.a}${n.el}`.toLowerCase().includes(s) || (n.citation ?? "").toLowerCase().includes(s),
        )
      );
    });
  }, [masses, q]);

  // Every selectable row key in view: the chain ("148") and its nested nuclides ("148Gd").
  const visibleKeys = useMemo(
    () => filtered.flatMap((m) => [String(m.a), ...m.nuclideEvals.map((n) => `${m.a}${n.el}`)]),
    [filtered],
  );
  const allChecked = visibleKeys.length > 0 && visibleKeys.every((k) => sel.has(k));
  const toggleRow = (k: string) => setSel((prev) => { const next = new Set(prev); if (next.has(k)) next.delete(k); else next.add(k); return next; });
  const toggleAll = () => setSel((prev) => { const next = new Set(prev); if (allChecked) visibleKeys.forEach((k) => next.delete(k)); else visibleKeys.forEach((k) => next.add(k)); return next; });

  const nuclideCount = useMemo(() => filtered.reduce((s, m) => s + m.nuclideEvals.length, 0), [filtered]);
  const checkbox = (k: string) => (
    <td className="w-10 px-3 py-2" onClick={(e) => e.stopPropagation()}>
      <input type="checkbox" className="h-4 w-4 cursor-pointer align-middle accent-foreground" checked={sel.has(k)} onChange={() => toggleRow(k)} />
    </td>
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold text-primary">ENSDF evaluation index</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every mass chain, its published evaluation, and how stale it is.
        </p>
      </div>

      <p className="mb-5 text-sm leading-relaxed text-muted-foreground">
        For each mass chain the index gives the publication reference for the evaluation and its
        literature <span className="font-medium text-foreground">cut-off date</span> — the date up
        to which the literature was surveyed. Measurements published after that date are not part of
        the evaluation; they appear instead as XUNDL compilations, counted in the last column. The
        dot color runs from{" "}
        <span className="inline-block h-2 w-2 rounded-sm align-middle" style={{ background: AGE_COLORS[0] }} />{" "}
        under a year to{" "}
        <span className="inline-block h-2 w-2 rounded-sm align-middle" style={{ background: AGE_COLORS[11] }} />{" "}
        eleven years or more since cutoff. Individual nuclides re-evaluated since their chain
        evaluation are listed underneath it. Citations we hold in the corpus link to the paper.
      </p>

      {isLoading || !data ? (
        <div className="space-y-2">{[...Array(10)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
      ) : (
        <TableCard
          toolbar={
            <div className="relative w-full max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter — a mass (137), a nuclide (137Cs), or a citation (NDS 106)…"
                className="pl-9"
              />
            </div>
          }
          footer={
            <>
              <span>
                {filtered.length === 0
                  ? "No chains match."
                  : `${filtered.length} mass chains · ${nuclideCount} nuclide re-evaluations`}
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
                <th className={TH}>Mass / Nuclide</th>
                <th className={TH}>Citation</th>
                <th className={`${TH} hidden sm:table-cell`}>Cutoff</th>
                <th className={`${TH} text-right`}>XUNDL sets</th>
                <th className={`${TH} w-12 px-1`} />
              </tr>
            </thead>
            <tbody style={{ contentVisibility: "auto" } as React.CSSProperties}>
              {filtered.flatMap((m) => [
                <tr key={`m-${m.a}`} className="border-b last:border-0">
                  {checkbox(String(m.a))}
                  <td className="px-3 py-2">
                    <button
                      onClick={() => navigate(`/ensdf/${m.a}`)}
                      className="font-mono font-semibold text-nuclear hover:underline"
                    >
                      A = {m.a}
                    </button>
                  </td>
                  <Citation citation={m.citation} cite={m.key} className="px-3 py-2 font-medium text-foreground" />
                  <CutoffCell cutoff={m.cutoff} b={bucket(m.cutoff, data.generated)} />
                  <td className="px-3 py-2 text-right font-mono">{m.xundl_sets}</td>
                  <td className="w-12 px-1 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                    <RowActions
                      items={[
                        { label: "Open mass chain", onSelect: () => navigate(`/ensdf/${m.a}`) },
                        ...(m.key ? [{ label: "Open citation in graph", onSelect: () => navigate(`/graph?center=paper:${m.key}`) }] : []),
                        ...(m.citation ? [{ label: "Copy citation", onSelect: () => { navigator.clipboard?.writeText(m.citation!).catch(() => {}); } }] : []),
                      ]}
                    />
                  </td>
                </tr>,
                ...m.nuclideEvals.map((n) => (
                  <tr key={`n-${m.a}-${n.el}`} className="border-b bg-muted/20 last:border-0">
                    {checkbox(`${m.a}${n.el}`)}
                    <td className="py-1.5 pl-8 pr-3">
                      <Link to={`/ensdf/${m.a}${el(n.el)}`} className="font-mono text-xs text-foreground hover:underline">
                        <sup>{m.a}</sup>{el(n.el)}
                      </Link>
                    </td>
                    <Citation citation={n.citation} cite={n.key} className="px-3 py-1.5 text-xs text-muted-foreground" />
                    <CutoffCell cutoff={n.cutoff} b={bucket(n.cutoff, data.generated)} />
                    <td className="px-3 py-1.5 text-right font-mono text-xs">{n.xundl_sets}</td>
                    <td className="w-12 px-1 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                      <RowActions
                        items={[
                          { label: "Open nuclide", onSelect: () => navigate(`/ensdf/${m.a}${el(n.el)}`) },
                          ...(n.key ? [{ label: "Open citation in graph", onSelect: () => navigate(`/graph?center=paper:${n.key}`) }] : []),
                          ...(n.citation ? [{ label: "Copy citation", onSelect: () => { navigator.clipboard?.writeText(n.citation!).catch(() => {}); } }] : []),
                        ]}
                      />
                    </td>
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </TableCard>
      )}
    </div>
  );
}
