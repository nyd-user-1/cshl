import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Maximize2, Minimize2, Search, X } from "lucide-react";
import { RowActions } from "@/components/RowActions";
import { Button } from "@/components/ui/button";
import { ExpandFrame } from "@/components/ExpandFrame";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { ChartOfNuclides, type ChartMode } from "@/components/ChartOfNuclides";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AGE_COLORS,
  XUNDL_COLORS,
  XUNDL_LABELS,
  XUNDL_NONE_COLOR,
  parseMassQuery,
  ELEMENTS,
  ageLabel,
  useStructureIndex,
  STRUCTURE_DATA_V,
} from "@/lib/structure";

/**
 * Black or white for a label sitting on a data-ramp segment. Picked from the
 * segment's own luminance — the ramp is theme-independent, so the theme can't
 * answer this.
 */
function inkOn(hex: string) {
  const v = hex.replace("#", "");
  const ch = (i: number) => {
    const c = parseInt(v.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4) > 0.35 ? "#000" : "#fff";
}

const AGE_SEGMENTS = AGE_COLORS.slice(0, 12).map((color, i) => ({
  color,
  label: i === 0 ? "≤1" : i === 11 ? "≥11" : String(i + 1),
}));
const XUNDL_SEGMENTS = XUNDL_COLORS.map((color, i) => ({ color, label: XUNDL_LABELS[i] }));

/** NNDC-style stacked legend bar: equal segments, label inside each. */
function LegendBar({ mode }: { mode: ChartMode }) {
  const segments = mode === "age" ? AGE_SEGMENTS : XUNDL_SEGMENTS;
  return (
    <div className="w-full sm:w-[300px] md:w-[400px]">
      <p className="mb-1 text-[10px] text-muted-foreground">
        {mode === "age" ? "Years since cutoff" : "XUNDL sets since cutoff"}
      </p>
      <div className="flex items-center gap-1.5">
        <div className="flex flex-1 overflow-hidden rounded-sm">
          {segments.map((s) => (
            <span
              key={s.color + s.label}
              className="flex-1 py-0.5 text-center text-[9px] font-bold leading-none"
              style={{ background: s.color, color: inkOn(s.color) }}
            >
              {s.label}
            </span>
          ))}
        </div>
        {mode === "xundl" && (
          <span
            className="shrink-0 rounded-sm px-1 py-0.5 text-[9px] font-bold leading-none"
            style={{ background: XUNDL_NONE_COLOR, color: inkOn(XUNDL_NONE_COLOR) }}
          >
            none
          </span>
        )}
      </div>
    </div>
  );
}

/** One option in a chart combobox. `search` is the lowercase haystack the typed text filters against. */
interface ComboOpt { value: string; search: string; label: React.ReactNode; meta?: React.ReactNode }

/**
 * The chart's labeled combobox (the shadcn Combobox pattern, kit-styled):
 * click it for the full list, type into it and the list filters reductively,
 * pick an item to apply it. `live` binds the text straight to the applied
 * value (the Nuclide box — typing drives the zoom); otherwise the box drafts
 * locally and only applies on pick, showing the applied value when it belongs
 * to this box's kind (Mass shows "148", Symbol shows "Gd").
 */
function ChartCombobox({
  placeholder, className, options, applied, appliedMatches, onApply, live = false, onEnter, clearable = false,
}: {
  placeholder: string;
  className?: string;
  options: ComboOpt[];
  applied: string;
  appliedMatches?: (v: string) => boolean;
  onApply: (v: string) => void;
  live?: boolean;
  onEnter?: (text: string) => void;
  clearable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState("");
  const text = live ? applied : focused ? draft : appliedMatches?.(applied.trim()) ? applied.trim() : "";
  const needle = text.trim().toLowerCase().replace(/[-\s]/g, "");
  const filtered = needle ? options.filter((o) => o.search.includes(needle)) : options;
  const pick = (v: string) => { onApply(v); setDraft(""); setOpen(false); };
  return (
    <div className={`relative ${className ?? ""}`}>
      <Input
        value={text}
        onChange={(e) => { if (live) onApply(e.target.value); else setDraft(e.target.value); setOpen(true); }}
        onFocus={() => { setFocused(true); setDraft(""); setOpen(true); }}
        onBlur={() => { setFocused(false); setDraft(""); setOpen(false); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            setOpen(false);
            if (onEnter) onEnter(text);
            else if (filtered.length === 1) pick(filtered[0].value);
            else { const exact = filtered.find((o) => o.search === needle); if (exact) pick(exact.value); }
          }
          if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); }
        }}
        placeholder={placeholder}
        className="h-8 bg-card/90 pl-3 pr-7 text-xs shadow-sm backdrop-blur"
      />
      {clearable && text ? (
        <button
          type="button"
          title="Clear"
          // mousedown so the input keeps focus and the blur doesn't race the clear
          onMouseDown={(e) => { e.preventDefault(); onApply(""); setDraft(""); }}
          className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : (
        <button
          type="button"
          tabIndex={-1}
          title="Open list"
          onMouseDown={(e) => { e.preventDefault(); setOpen((o) => !o); (e.currentTarget.previousElementSibling as HTMLElement | null)?.focus?.(); }}
          className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground"
        >
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      )}
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-md border bg-card p-1 shadow-md">
          {filtered.length === 0 && <p className="px-2.5 py-2 text-xs text-muted-foreground">No matches</p>}
          {filtered.map((o) => (
            <button
              key={o.value}
              type="button"
              // mousedown, not click: selection must land before the input's blur closes the list
              onMouseDown={(e) => { e.preventDefault(); pick(o.value); }}
              className={`flex w-full items-center justify-between rounded-sm px-2.5 py-1 text-left font-mono text-xs transition-colors hover:bg-muted ${applied.trim().toLowerCase() === o.value.toLowerCase() ? "bg-muted font-semibold" : ""}`}
              style={{ contentVisibility: "auto", containIntrinsicSize: "0 26px" } as React.CSSProperties}
            >
              <span>{o.label}</span>
              {o.meta && <span className="text-[10px] text-muted-foreground">{o.meta}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One template, two landings — mirrors NNDC's own pair:
 *   /ensdf  → nndc.bnl.gov/ensdf/       chart by evaluation cutoff age (ENSDF)
 *   /xundl  → nndc.bnl.gov/ensdf/xundl/ chart by XUNDL sets since cutoff
 */
/** "148Gd" / "Pb-208" → {a,z} · "148" → {a} · "Gd" → {z} · anything else → null. */
function parseTarget(t: string): { a?: number; z?: number } | null {
  if (!t) return null;
  const nm = /^(\d{1,3})\s*-?\s*([A-Za-z]{1,2})$/.exec(t) ?? /^([A-Za-z]{1,2})\s*-?\s*(\d{1,3})$/.exec(t);
  if (nm) {
    const numFirst = /^\d/.test(nm[1]);
    const a = Number(numFirst ? nm[1] : nm[2]);
    const raw = numFirst ? nm[2] : nm[1];
    const sym = raw[0].toUpperCase() + raw.slice(1).toLowerCase();
    const z = ELEMENTS.indexOf(sym);
    return z > 0 ? { a, z } : null;
  }
  if (/^[A-Za-z]{1,2}$/.test(t)) {
    const sym = t[0].toUpperCase() + t.slice(1).toLowerCase();
    const z = ELEMENTS.indexOf(sym);
    return z > 0 ? { z } : null;
  }
  if (/^\d{1,3}$/.test(t)) return { a: Number(t) };
  return null;
}

export default function Structure({ variant = "ensdf" }: { variant?: "ensdf" | "xundl" }) {
  const navigate = useNavigate();
  const { data, isLoading } = useStructureIndex();
  const [q, setQ] = useState("");
  const mode: ChartMode = variant === "xundl" ? "xundl" : "age";
  const base = variant === "xundl" ? "/xundl" : "/ensdf";

  const allMasses = useMemo(() => data?.masses ?? [], [data]);
  const allNuclides = useMemo(() => data?.nuclides ?? [], [data]);
  type NSortKey = "code" | "z" | "n" | "a" | "ensdf" | "xundl" | "xundlSince" | "revised" | "age";
  const [nsort, setNsort] = useState<{ key: NSortKey; dir: 1 | -1 }>({ key: "a", dir: 1 });
  const toggleNsort = (key: NSortKey) => setNsort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "ensdf" || key === "xundl" || key === "xundlSince" || key === "revised" ? -1 : 1 }));
  const nuclides = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/[-\s]/g, "");
    let rows = allNuclides;
    if (needle) {
      rows = allNuclides.filter((r) => {
        const code = r.code.toLowerCase();
        return code === needle || code.startsWith(needle) || r.el.toLowerCase() === needle ||
          `${r.el}${r.a}`.toLowerCase() === needle || String(r.a) === needle;
      });
    }
    const dir = nsort.dir;
    return [...rows].sort((x, y) => {
      const kx = x[nsort.key] ?? "", ky = y[nsort.key] ?? "";
      if (typeof kx === "number" && typeof ky === "number") return (kx - ky) * dir || x.a - y.a || x.z - y.z;
      return String(kx).localeCompare(String(ky)) * dir || x.a - y.a || x.z - y.z;
    });
  }, [allNuclides, q, nsort]);
  type SortKey = "a" | "citation" | "cutoff" | "xundl_sets" | "papers";
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "a", dir: 1 });
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "a" || key === "citation" || key === "cutoff" ? 1 : -1 }));
  // Live filter (A number, element symbol, citation text) + sort — all client-side, instant.
  const masses = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const a = parseMassQuery(q);
    let rows = allMasses;
    if (needle) {
      rows = allMasses.filter((m) =>
        String(m.a) === needle || String(m.a).startsWith(needle) || (a !== null && m.a === a) ||
        (m.citation ?? "").toLowerCase().includes(needle) ||
        (m.nuclideEvals ?? []).some((n) => `${m.a}${n.el}`.toLowerCase().includes(needle) || (n.el ?? "").toLowerCase() === needle),
      );
    }
    const dir = sort.dir;
    return [...rows].sort((x, y) => {
      const kx = x[sort.key] ?? "", ky = y[sort.key] ?? "";
      if (typeof kx === "number" && typeof ky === "number") return (kx - ky) * dir;
      return String(kx).localeCompare(String(ky)) * dir;
    });
  }, [allMasses, q, sort]);
  // Enter jumps like NNDC's quick search: "148Gd"/"Pb-208" → nuclide, "148" → mass chain, "Gd" → element.
  const goTo = (text: string) => {
    const t = text.trim();
    if (!t) return;
    const f = parseTarget(t);
    if (f?.a != null && f.z != null) { navigate(`${base}/${f.a}${ELEMENTS[f.z]}`); return; }
    if (f?.z != null) { navigate(`${base}/${ELEMENTS[f.z]}`); return; }
    if (f?.a != null) { navigate(`${base}/${f.a}`); return; }
    const a = parseMassQuery(t);
    if (a) navigate(`${base}/${a}`);
  };
  const go = () => goTo(q);
  // Chart quick-search: the parsed target drives the zoom as you type.
  const [cq, setCq] = useState("");
  const [expanded, setExpanded] = useState(false);
  const toggleExpand = useCallback(() => setExpanded((e) => !e), []);
  const focus = useMemo(() => parseTarget(cq.trim()), [cq]);
  const other = variant === "xundl" ? "/ensdf" : "/xundl";
  const otherName = variant === "xundl" ? "ENSDF" : "XUNDL";
  // Pick lists for the chart's mass / element dropdowns (from the charted nuclides).
  const massList = useMemo(() => [...new Set(allNuclides.map((r) => r.a))].sort((x, y) => x - y), [allNuclides]);
  const elementList = useMemo(() => {
    const seen = new Map<number, string>();
    for (const r of allNuclides) if (!seen.has(r.z)) seen.set(r.z, r.el);
    return [...seen.entries()].sort((a, b) => a[0] - b[0]);
  }, [allNuclides]);
  // Combobox option lists: every charted nuclide (A asc, then symbol a–z), every mass, every element.
  const nuclideCombo = useMemo(
    () => [...allNuclides]
      .sort((x, y) => x.a - y.a || x.el.localeCompare(y.el))
      .map((r): ComboOpt => ({
        value: r.code,
        search: `${r.code} ${r.el}${r.a}`.toLowerCase(),
        label: <span><sup>{r.a}</sup>{r.el}</span>,
      })),
    [allNuclides],
  );
  const massCombo = useMemo(
    () => massList.map((a): ComboOpt => ({ value: String(a), search: String(a), label: String(a) })),
    [massList],
  );
  const symbolCombo = useMemo(
    () => elementList.map(([z, el]): ComboOpt => ({ value: el, search: `${el} ${z}`.toLowerCase(), label: el, })),
    [elementList],
  );
  // Row selection, one set per tab (kept while filtering; header box toggles the visible rows).
  const [nsel, setNsel] = useState<Set<string>>(new Set());
  const [msel, setMsel] = useState<Set<number>>(new Set());
  const nVisible = useMemo(() => nuclides.slice(0, 600), [nuclides]);
  const nAllChecked = nVisible.length > 0 && nVisible.every((r) => nsel.has(r.code));
  const mAllChecked = masses.length > 0 && masses.every((m) => msel.has(m.a));
  const toggleNRow = (code: string) => setNsel((prev) => { const next = new Set(prev); if (next.has(code)) next.delete(code); else next.add(code); return next; });
  const toggleMRow = (a: number) => setMsel((prev) => { const next = new Set(prev); if (next.has(a)) next.delete(a); else next.add(a); return next; });
  const toggleNAll = () => setNsel((prev) => { const next = new Set(prev); if (nAllChecked) nVisible.forEach((r) => next.delete(r.code)); else nVisible.forEach((r) => next.add(r.code)); return next; });
  const toggleMAll = () => setMsel((prev) => { const next = new Set(prev); if (mAllChecked) masses.forEach((m) => next.delete(m.a)); else masses.forEach((m) => next.add(m.a)); return next; });

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-primary">{variant === "xundl" ? "XUNDL" : "ENSDF"}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {variant === "xundl" ? "Experimental Unevaluated Nuclear Data List" : "Evaluated Nuclear Structure Data File"}
        </p>
      </div>

      {/* One chart per page (ENSDF: cutoff age · XUNDL: sets since cutoff) — no mode picker,
          no card around the canvas; quick-search top-left, zoom controls top-right, legend bottom-right.
          Full content-column width (~1090px) so the chart lines up with the table below. */}
      <div className="mb-6 w-full">
        {isLoading || !data ? (
          <Skeleton className="aspect-[3/2] w-full" />
        ) : (
          <ExpandFrame expanded={expanded} onToggle={toggleExpand} className="aspect-[3/2] w-full">
            {(full) => (
              <div className="relative h-full w-full">
                <ChartOfNuclides grid={data.grid} mode={mode} focus={focus} onSelect={(a, z) => navigate(`${base}/${a}${ELEMENTS[z] ?? ""}`)} />
                {/* Top-left: expand toggle, then the quick search (typing zooms; Enter opens). */}
                <div className="absolute left-3 top-3 z-10 flex items-center gap-2">
                  <Button variant="outline" size="icon" className="h-8 w-8 bg-card/90 shadow-sm backdrop-blur"
                    title={full ? "Collapse (Esc)" : "Expand to fill the page"} onClick={toggleExpand}>
                    {full ? <Minimize2 className="h-4 w-4 -scale-x-100" /> : <Maximize2 className="h-4 w-4 -scale-x-100" />}
                  </Button>
                  {/* Three comboboxes, one applied value (cq): Nuclide is live (typing zooms),
                      Mass and Symbol draft locally and apply on pick. */}
                  <ChartCombobox
                    placeholder="Nuclide, Mass, or Symbol"
                    className="w-[200px]"
                    options={nuclideCombo}
                    applied={cq}
                    onApply={setCq}
                    live
                    clearable
                    onEnter={(t) => goTo(t)}
                  />
                  <ChartCombobox
                    placeholder="Mass"
                    className="w-[100px]"
                    options={massCombo}
                    applied={cq}
                    appliedMatches={(v) => /^\d{1,3}$/.test(v)}
                    onApply={setCq}
                  />
                  <ChartCombobox
                    placeholder="Symbol"
                    className="w-[100px]"
                    options={symbolCombo}
                    applied={cq}
                    appliedMatches={(v) => /^[A-Za-z]{1,2}$/.test(v)}
                    onApply={setCq}
                  />
                </div>
                <div className="pointer-events-none absolute bottom-3 right-3">
                  <LegendBar mode={mode} />
                </div>
              </div>
            )}
          </ExpandFrame>
        )}
      </div>

      {/* One card holds the whole table surface (the leuk /providers pattern):
          search + tabs as the card's top row, sticky column headers beneath it,
          rows scrolling INSIDE the card (~730px), count footer at the bottom. */}
      <Tabs defaultValue="nuclides">
        <div className="overflow-hidden rounded-lg border">
          <div className="flex flex-wrap items-center gap-3 border-b px-3 py-2.5">
            <div className="relative w-full max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && go()}
                placeholder="Nuclide, mass, or symbol — 148Gd, 148, Gd, Pb-208 · Enter to open"
                className="pl-9"
              />
            </div>
            <TabsList className="ml-auto">
              <TabsTrigger value="nuclides">Nuclides <span className="ml-1 text-xs text-muted-foreground">{allNuclides.length.toLocaleString()}</span></TabsTrigger>
              <TabsTrigger value="chains">Mass chains <span className="ml-1 text-xs text-muted-foreground">{allMasses.length}</span></TabsTrigger>
            </TabsList>
          </div>

          {/* ── Nuclides: one row per charted nuclide → its dataset page ── */}
          <TabsContent value="nuclides" className="m-0">
            {isLoading ? (
              <div className="space-y-2 p-3">{[...Array(8)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : (
              <>
                <div className="max-h-[min(730px,72dvh)] overflow-y-auto">
                  <table className="w-full table-fixed text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="sticky top-0 z-10 w-10 border-b bg-card px-3 py-2">
                          <input
                            type="checkbox"
                            title="Select all shown"
                            className="h-4 w-4 cursor-pointer align-middle accent-foreground"
                            checked={nAllChecked}
                            onChange={toggleNAll}
                          />
                        </th>
                        {([
                          ["code", "Nuclide", ""], ["z", "Z", "hidden sm:table-cell"], ["n", "N", "hidden sm:table-cell"], ["a", "A", "hidden md:table-cell"],
                          ["ensdf", "ENSDF datasets", "text-right"], ["xundl", "XUNDL sets", "text-right"], ["xundlSince", "since cutoff", "hidden text-right md:table-cell"],
                          ["revised", "Revised", "hidden sm:table-cell"], ["age", "Cutoff age", "hidden lg:table-cell"],
                        ] as const).map(([key, label, cls]) => (
                          <th key={key} className={`sticky top-0 z-10 border-b bg-card px-3 py-2 font-medium ${cls}`}>
                            <button type="button" onClick={() => toggleNsort(key)} className={`inline-flex items-center gap-1 hover:text-foreground ${nsort.key === key ? "text-foreground" : ""}`} title={`Sort by ${label}`}>
                              {label}<span className="text-[10px]">{nsort.key === key ? (nsort.dir === 1 ? "▲" : "▼") : "↕"}</span>
                            </button>
                          </th>
                        ))}
                        <th className="sticky top-0 z-10 w-12 border-b bg-card px-1 py-2" />
                      </tr>
                    </thead>
                    <tbody style={{ contentVisibility: "auto" } as React.CSSProperties}>
                      {nuclides.length === 0 && (
                        <tr><td colSpan={11} className="px-3 py-6 text-center text-xs text-muted-foreground">No nuclide matches “{q}”</td></tr>
                      )}
                      {nVisible.map((r) => (
                        <tr
                          key={r.code}
                          onClick={() => navigate(`${base}/${r.code}`)}
                          className="cursor-pointer border-b last:border-0 transition-colors hover:bg-muted/50"
                        >
                          <td className="w-10 px-3 py-2" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              className="h-4 w-4 cursor-pointer align-middle accent-foreground"
                              checked={nsel.has(r.code)}
                              onChange={() => toggleNRow(r.code)}
                            />
                          </td>
                          <td className="px-3 py-2 font-mono font-semibold text-nuclear"><sup>{r.a}</sup>{r.el}</td>
                          <td className="hidden px-3 py-2 font-mono text-muted-foreground sm:table-cell">{r.z}</td>
                          <td className="hidden px-3 py-2 font-mono text-muted-foreground sm:table-cell">{r.n}</td>
                          <td className="hidden px-3 py-2 font-mono text-muted-foreground md:table-cell">{r.a}</td>
                          <td className="px-3 py-2 text-right font-mono">{r.ensdf}</td>
                          <td className="px-3 py-2 text-right font-mono">{r.xundl}</td>
                          <td className="hidden px-3 py-2 text-right font-mono text-muted-foreground md:table-cell">{r.xundlSince}</td>
                          <td className="hidden px-3 py-2 text-muted-foreground sm:table-cell">{r.revised ?? "—"}</td>
                          <td className="hidden px-3 py-2 lg:table-cell">
                            <span className="mr-1.5 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: AGE_COLORS[Math.min(r.age, 12)] }} />
                            <span className="text-muted-foreground">{ageLabel(r.age)}</span>
                          </td>
                          <td className="w-12 px-1 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                            <RowActions
                              items={[
                                { label: "Open datasets", onSelect: () => navigate(`${base}/${r.code}`) },
                                { label: `Open in ${otherName}`, onSelect: () => navigate(`${other}/${r.code}`) },
                                { label: "Copy nuclide", onSelect: () => { navigator.clipboard?.writeText(`${r.a}${r.el}`).catch(() => {}); } },
                              ]}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
                  <span>
                    {nuclides.length > 600
                      ? `Showing 600 of ${nuclides.length.toLocaleString()} nuclides — type to narrow`
                      : `${nuclides.length.toLocaleString()} nuclides`}
                    {nsel.size > 0 && ` · ${nsel.size.toLocaleString()} selected`}
                  </span>
                  <span>Source: NNDC</span>
                </div>
              </>
            )}
          </TabsContent>

          {/* ── Mass chains: the evaluation index (NDS citation, cutoff, XUNDL since cutoff, papers) ── */}
          <TabsContent value="chains" className="m-0">
            {isLoading ? (
              <div className="space-y-2 p-3">{[...Array(8)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : (
              <>
                <div className="max-h-[min(730px,72dvh)] overflow-y-auto">
                  <table className="w-full table-fixed text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="sticky top-0 z-10 w-10 border-b bg-card px-3 py-2">
                          <input
                            type="checkbox"
                            title="Select all shown"
                            className="h-4 w-4 cursor-pointer align-middle accent-foreground"
                            checked={mAllChecked}
                            onChange={toggleMAll}
                          />
                        </th>
                        {([
                          ["a", "A", ""], ["citation", "Citation", ""], ["cutoff", "Cutoff", "hidden sm:table-cell"],
                          ["xundl_sets", "XUNDL", "text-right"], ["papers", "Papers", "text-right"],
                        ] as const).map(([key, label, cls]) => (
                          <th key={key} className={`sticky top-0 z-10 border-b bg-card px-3 py-2 font-medium ${cls}`}>
                            <button
                              type="button"
                              onClick={() => toggleSort(key)}
                              className={`inline-flex items-center gap-1 hover:text-foreground ${sort.key === key ? "text-foreground" : ""}`}
                              title={`Sort by ${label}`}
                            >
                              {label}
                              <span className="text-[10px]">{sort.key === key ? (sort.dir === 1 ? "▲" : "▼") : "↕"}</span>
                            </button>
                          </th>
                        ))}
                        <th className="sticky top-0 z-10 w-12 border-b bg-card px-1 py-2" />
                      </tr>
                    </thead>
                    <tbody style={{ contentVisibility: "auto" } as React.CSSProperties}>
                      {masses.length === 0 && (
                        <tr><td colSpan={7} className="px-3 py-6 text-center text-xs text-muted-foreground">No mass chain matches “{q}”</td></tr>
                      )}
                      {masses.map((m) => {
                        const b = m.cutoff ? Math.max(0, Math.min(11, Math.floor((Date.parse(data!.generated) - Date.parse(m.cutoff)) / 3.156e10))) : 12;
                        return (
                          <tr
                            key={m.a}
                            onClick={() => navigate(`${base}/${m.a}`)}
                            onMouseEnter={() => { fetch(`/data/structure/${m.a}.json?v=${STRUCTURE_DATA_V}`).catch(() => {}); }}
                            className="cursor-pointer border-b last:border-0 transition-colors hover:bg-muted/50"
                          >
                            <td className="w-10 px-3 py-2" onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                className="h-4 w-4 cursor-pointer align-middle accent-foreground"
                                checked={msel.has(m.a)}
                                onChange={() => toggleMRow(m.a)}
                              />
                            </td>
                            <td className="px-3 py-2 font-mono font-semibold text-nuclear">{m.a}</td>
                            <td className="px-3 py-2 text-muted-foreground">{m.citation ?? "—"}</td>
                            <td className="hidden px-3 py-2 sm:table-cell">
                              <span className="mr-1.5 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: AGE_COLORS[b] }} />
                              <span className="text-muted-foreground">{m.cutoff ?? "—"}</span>
                            </td>
                            <td className="px-3 py-2 text-right font-mono">{m.xundl_sets}</td>
                            <td className="px-3 py-2 text-right font-mono">{m.papers.toLocaleString()}</td>
                            <td className="w-12 px-1 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                              <RowActions
                                items={[
                                  { label: "Open mass chain", onSelect: () => navigate(`${base}/${m.a}`) },
                                  { label: `Open in ${otherName}`, onSelect: () => navigate(`${other}/${m.a}`) },
                                  { label: "Copy A", onSelect: () => { navigator.clipboard?.writeText(String(m.a)).catch(() => {}); } },
                                ]}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
                  <span>
                    {masses.length} mass chains
                    {msel.size > 0 && ` · ${msel.size} selected`}
                  </span>
                  <span>Source: NNDC</span>
                </div>
              </>
            )}
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
