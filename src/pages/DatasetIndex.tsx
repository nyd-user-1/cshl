import { useState, useDeferredValue, useRef } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import { MobileFilterDrawer } from "@/components/MobileFilterDrawer";
import { FilterDropdown } from "@/components/FilterDropdown";
import { SearchInput } from "@/components/SearchInput";
import { DatasetCard, type DatasetRow } from "@/components/DatasetCard";
import { Skeleton } from "@/components/ui/skeleton";
import { ELEMENTS } from "@/lib/structure";

/**
 * /ensdf and /xundl index pages — a structural clone of /endf (Endf.tsx):
 * search portaled into the header, sticky filter bar (sort toggles · Year ·
 * Element · pagination), and the card grid over every
 * dataset in the loaded distribution (no Semantic/Keyword toggle — datasets are
 * not embedded; keyword is what runs). The chart of nuclides lives at
 * /ensdf/chart · /xundl/chart.
 */

const CARDS_PER_PAGE = 99;

type SortField = "nuclide" | "dataset" | "revised";

// ENSDF revisions run 1980s → today; XUNDL since 1997.
const THIS_YEAR = new Date().getUTCFullYear();
const YEAR_OPTIONS = Array.from({ length: THIS_YEAR - 1980 + 1 }, (_, i) => String(THIS_YEAR - i));
const ELEMENT_OPTIONS = ELEMENTS.slice(1); // drop the bare neutron

interface ListResponse { total: number; datasets: DatasetRow[] }

export default function DatasetIndex({ variant }: { variant: "ensdf" | "xundl" }) {
  const name = variant.toUpperCase();
  const [query, setQueryRaw] = useState("");
  const [yearFilter, setYearFilterRaw] = useState<string | null>(null);
  const [elementFilter, setElementFilterRaw] = useState<string | null>(null);
  const [sortBy, setSortByRaw] = useState<SortField>("nuclide");
  const [sortAsc, setSortAscRaw] = useState(true);
  const [page, setPage] = useState(1);
  // Any query / filter / sort change lands on page 1.
  const setQuery = (v: string) => { setQueryRaw(v); setPage(1); };
  const setYearFilter = (v: string | null) => { setYearFilterRaw(v); setPage(1); };
  const setElementFilter = (v: string | null) => { setElementFilterRaw(v); setPage(1); };
  const setSortBy = (v: SortField) => { setSortByRaw(v); setPage(1); };
  const setSortAsc = (v: boolean) => { setSortAscRaw(v); setPage(1); };

  const deferredQuery = useDeferredValue(query);
  const isSearching = deferredQuery.trim().length >= 1;

  const { data, isLoading, error } = useQuery({
    queryKey: ["dataset-index", variant, deferredQuery, yearFilter, elementFilter, sortBy, sortAsc, page],
    queryFn: async () => {
      const params = new URLSearchParams({ list: variant, page: String(page), sort: sortBy, dir: sortAsc ? "asc" : "desc" });
      if (isSearching) params.set("q", deferredQuery.trim());
      if (yearFilter) params.set("year", yearFilter);
      if (elementFilter) params.set("el", elementFilter);
      const r = await fetch(`/api/nuclide?${params.toString()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as ListResponse;
    },
    placeholderData: keepPreviousData,
    staleTime: 60 * 60 * 1000,
  });

  const records = data?.datasets ?? null;
  const totalCount = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / CARDS_PER_PAGE));
  const currentPage = Math.min(page, totalPages);

  const scrollRef = useRef<HTMLDivElement>(null);

  const goToPage = (p: number) => {
    setPage(p);
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const defaultSort: SortField = "nuclide";

  // Nuclide asc is the resting order; each other field cycles asc → desc → back to rest.
  const toggleSort = (field: SortField) => {
    if (sortBy !== field) { setSortBy(field); setSortAsc(true); return; }
    if (field === defaultSort) { setSortAsc(!sortAsc); return; }
    if (sortAsc) setSortAsc(false);
    else { setSortBy(defaultSort); setSortAsc(true); }
  };

  const isSortActive = (field: SortField) =>
    sortBy === field && !(field === defaultSort && sortAsc);

  const sortButton = (field: SortField, label: string) => (
    <button
      onClick={() => toggleSort(field)}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${
        isSortActive(field)
          ? "bg-foreground text-background font-medium"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {label}
      <ArrowUpDown className="h-3.5 w-3.5" />
    </button>
  );

  const pagination = (
    <>
      <button
        onClick={() => goToPage(currentPage - 1)}
        disabled={currentPage <= 1}
        className="inline-flex items-center justify-center h-6 w-6 rounded border hover:bg-muted disabled:opacity-30 transition-colors"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <span>Page</span>
      <input
        type="text"
        value={currentPage}
        onChange={(e) => {
          const val = Number(e.target.value);
          if (val >= 1 && val <= totalPages) goToPage(val);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const val = Number((e.target as HTMLInputElement).value);
            if (val >= 1 && val <= totalPages) goToPage(val);
          }
        }}
        className="h-6 w-10 rounded border bg-transparent text-center text-xs text-foreground outline-none focus:ring-1 focus:ring-foreground/20"
      />
      <span>of {totalPages}</span>
      <button
        onClick={() => goToPage(currentPage + 1)}
        disabled={currentPage >= totalPages}
        className="inline-flex items-center justify-center h-6 w-6 rounded border hover:bg-muted disabled:opacity-30 transition-colors"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </>
  );

  return (
    <div className="h-full flex flex-col">
      {/* Portal search bar into header */}
      {document.getElementById("header-search") &&
        createPortal(
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={`Search ${name} datasets...`}
          />,
          document.getElementById("header-search")!
        )}

      {/* Desktop sticky filter bar — hidden on mobile */}
      <div className="hidden md:block sticky top-0 z-10 bg-background px-6 pt-3 pb-2">
        <div className="flex flex-wrap items-center gap-2">
          {sortButton("nuclide", "Nuclide")}
          {sortButton("dataset", "Dataset")}
          {sortButton("revised", "Revised")}

          <FilterDropdown label="Year" options={YEAR_OPTIONS} value={yearFilter} onChange={setYearFilter} />
          <FilterDropdown label="Element" options={ELEMENT_OPTIONS} value={elementFilter} onChange={setElementFilter} />

          <Link to={`/${variant}/chart`} className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            Chart of nuclides →
          </Link>

          {/* Pagination (far right) */}
          {totalPages > 0 && (
            <div className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              {pagination}
            </div>
          )}
        </div>
      </div>

      {/* Mobile toolbar — pagination (right) */}
      <div className="md:hidden sticky top-0 z-10 bg-background px-3 pt-3 pb-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {totalPages > 0 && (
            <div className="ml-auto inline-flex items-center gap-1.5">{pagination}</div>
          )}
        </div>
      </div>

      {/* FAB → Popover with filter controls (mobile only) */}
      <MobileFilterDrawer>
        {sortButton("nuclide", "Nuclide")}
        {sortButton("dataset", "Dataset")}
        {sortButton("revised", "Revised")}
        <FilterDropdown label="Year" options={YEAR_OPTIONS} value={yearFilter} onChange={setYearFilter} />
        <FilterDropdown label="Element" options={ELEMENT_OPTIONS} value={elementFilter} onChange={setElementFilter} />
      </MobileFilterDrawer>

      {/* Scrollable content area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 md:px-6 py-4">
        {/* Error state */}
        {error && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive mb-6">
            {(error as Error).message}
          </div>
        )}

        {/* Loading skeletons */}
        {isLoading && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="rounded-lg border bg-muted/40 p-6 min-h-[280px] space-y-4">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-6 w-6 rounded-full" />
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-12 ml-auto" />
                </div>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
                <div className="space-y-2 pt-2">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-3 w-48" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Results grid */}
        {records && records.length > 0 && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {records.map((d) => (
              <DatasetCard
                key={`${d.nucid}|${d.dsid}`}
                d={d}
                variant={variant}
                searchQuery={isSearching ? deferredQuery.trim() : undefined}
              />
            ))}
          </div>
        )}

        {/* Empty state */}
        {records && records.length === 0 && (isSearching || yearFilter || elementFilter) && (
          <p className="text-center text-muted-foreground py-12">
            No matching datasets found. Try a different search term.
          </p>
        )}
      </div>
    </div>
  );
}
