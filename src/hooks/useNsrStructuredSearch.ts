import { useQuery } from "@tanstack/react-query";
import type { NsrRecord } from "@/types/nsr";

export interface StructuredSearchParams {
  nuclides?: string[];
  reactions?: string[];
  zMin?: number;
  zMax?: number;
}

async function structuredSearch(
  params: StructuredSearchParams,
): Promise<NsrRecord[]> {
  const q = new URLSearchParams({ mode: "structured", limit: "50" });
  if (params.nuclides?.length) q.set("nuclides", params.nuclides.join(","));
  if (params.reactions?.length) q.set("reactions", params.reactions.join(","));
  if (params.zMin != null) q.set("zMin", String(params.zMin));
  if (params.zMax != null) q.set("zMax", String(params.zMax));
  const res = await fetch(`/api/search?${q}`);
  if (!res.ok) throw new Error(`structured ${res.status}`);
  const data = (await res.json()) as { records: NsrRecord[] };
  return data.records ?? [];
}

export function useNsrStructuredSearch(params: StructuredSearchParams | null) {
  const hasFilters =
    params !== null &&
    ((params.nuclides?.length ?? 0) > 0 ||
      (params.reactions?.length ?? 0) > 0 ||
      params.zMin != null ||
      params.zMax != null);

  return useQuery({
    queryKey: ["nsr-structured", params],
    queryFn: () => structuredSearch(params!),
    enabled: hasFilters,
    staleTime: 1000 * 60 * 5,
  });
}
