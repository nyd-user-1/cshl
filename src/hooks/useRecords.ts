import { useQuery } from "@tanstack/react-query";
import type { CorpusRecord } from "@/types/record";

interface Filters {
  year?: number;
  publishedOnly?: boolean;
  page?: number;
  pageSize?: number;
}

interface PaginatedResult {
  records: CorpusRecord[];
  totalCount: number;
}

/** Browse the corpus — Neon via /api/records. */
async function fetchRecords(filters: Filters): Promise<PaginatedResult> {
  const params = new URLSearchParams({ page: String(filters.page ?? 1), pageSize: String(filters.pageSize ?? 99) });
  if (filters.year) params.set("year", String(filters.year));
  if (filters.publishedOnly) params.set("published", "1");
  const res = await fetch(`/api/records?${params}`);
  if (!res.ok) throw new Error(`records ${res.status}`);
  const data = (await res.json()) as { records: CorpusRecord[]; totalCount: number };
  return { records: data.records ?? [], totalCount: data.totalCount ?? 0 };
}

export function useRecords(filters: Filters = {}) {
  return useQuery({
    queryKey: ["preprints", filters.year ?? "all", filters.publishedOnly ?? false, filters.page ?? 1, filters.pageSize ?? 99],
    queryFn: () => fetchRecords(filters),
    staleTime: 1000 * 60 * 10,
    placeholderData: (prev) => prev,
  });
}
