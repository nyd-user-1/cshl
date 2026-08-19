import { useQuery } from "@tanstack/react-query";
import type { EndfReport } from "@/types/endf";

export type EndfSortField = "seq_number" | "report_date_parsed" | "authors";

interface Filters {
  query?: string;
  year?: number;
  page?: number;
  pageSize?: number;
  sortBy?: EndfSortField;
  sortAsc?: boolean;
}

interface PaginatedResult {
  records: EndfReport[];
  totalCount: number;
}

type Row = EndfReport & { report_date_parsed?: string | null; cross_reference?: string | null };

// 316 rows total: the whole table ships as one static CDN JSON and every
// filter/sort/page happens client-side, instantly. No backend round trips.
async function fetchAll(): Promise<Row[]> {
  const res = await fetch("/data/endf.json");
  if (!res.ok) throw new Error(`endf.json: ${res.status}`);
  return res.json();
}

function applyFilters(rows: Row[], filters: Filters): PaginatedResult {
  let out = rows;

  if (filters.query) {
    const q = filters.query.toLowerCase();
    out = out.filter(
      (r) =>
        r.title?.toLowerCase().includes(q) ||
        r.authors?.toLowerCase().includes(q) ||
        r.report_number?.toLowerCase().includes(q),
    );
  }
  if (filters.year) {
    out = out.filter((r) => r.report_date_parsed?.startsWith(String(filters.year)));
  }

  const sortBy = filters.sortBy ?? "seq_number";
  const sortAsc = filters.sortAsc ?? false;
  const dir = sortAsc ? 1 : -1;
  out = [...out].sort((a, b) => {
    const av = a[sortBy] ?? null;
    const bv = b[sortBy] ?? null;
    if (av === null) return 1; // nulls last regardless of direction
    if (bv === null) return -1;
    return av < bv ? -dir : av > bv ? dir : 0;
  });

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 99;
  const from = (page - 1) * pageSize;
  return { records: out.slice(from, from + pageSize), totalCount: out.length };
}

export function useEndfReports(filters: Filters = {}) {
  return useQuery({
    queryKey: [
      "endf-reports",
      filters.query ?? "",
      filters.year ?? "all",
      filters.page ?? 1,
      filters.pageSize ?? 99,
      filters.sortBy ?? "seq_number",
      filters.sortAsc ?? false,
    ],
    queryFn: async () => applyFilters(await fetchAll(), filters),
    staleTime: 1000 * 60 * 30,
    placeholderData: (prev) => prev,
  });
}
