import { useQuery } from "@tanstack/react-query";
import type { NsrRecord } from "@/types/nsr";

export interface StructuredSearchParams {
  categories?: string[];
  journals?: string[];
}

async function structuredSearch(
  params: StructuredSearchParams,
): Promise<NsrRecord[]> {
  const q = new URLSearchParams({ mode: "structured", limit: "50" });
  if (params.categories?.length) q.set("categories", params.categories.join(","));
  if (params.journals?.length) q.set("journals", params.journals.join(","));
  const res = await fetch(`/api/search?${q}`);
  if (!res.ok) throw new Error(`structured ${res.status}`);
  const data = (await res.json()) as { records: NsrRecord[] };
  return data.records ?? [];
}

export function useNsrStructuredSearch(params: StructuredSearchParams | null) {
  const hasFilters =
    params !== null &&
    ((params.categories?.length ?? 0) > 0 || (params.journals?.length ?? 0) > 0);

  return useQuery({
    queryKey: ["preprint-structured", params],
    queryFn: () => structuredSearch(params!),
    enabled: hasFilters,
    staleTime: 1000 * 60 * 5,
  });
}
