import { useQuery } from "@tanstack/react-query";
import type { NsrRecord } from "@/types/nsr";

interface Filters {
  year?: number;
  exforOnly?: boolean;
  page?: number;
  pageSize?: number;
}

interface PaginatedResult {
  records: NsrRecord[];
  totalCount: number;
}

/** Browse the corpus — Neon via /api/records (was Supabase REST with count:exact). */
async function fetchRecords(filters: Filters): Promise<PaginatedResult> {
  const params = new URLSearchParams({ page: String(filters.page ?? 1), pageSize: String(filters.pageSize ?? 99) });
  if (filters.year) params.set("year", String(filters.year));
  if (filters.exforOnly) params.set("exfor", "1");
  const res = await fetch(`/api/records?${params}`);
  if (!res.ok) throw new Error(`records ${res.status}`);
  const data = (await res.json()) as { records: NsrRecord[]; totalCount: number };
  return { records: data.records ?? [], totalCount: data.totalCount ?? 0 };
}

export function useNsrRecords(filters: Filters = {}) {
  return useQuery({
    queryKey: ["nsr-records", filters.year ?? "all", filters.exforOnly ?? false, filters.page ?? 1, filters.pageSize ?? 99],
    queryFn: () => fetchRecords(filters),
    staleTime: 1000 * 60 * 10,
    placeholderData: (prev) => prev,
  });
}
