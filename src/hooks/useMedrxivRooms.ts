import { useQuery } from "@tanstack/react-query";

/** One room: a medRxiv category and its real paper count (from /api/dict with
 *  the server filter — counts computed per server, never the cross-server ones). */
export interface MedrxivRoom {
  value: string;
  record_count: number;
}

export function useMedrxivRooms() {
  return useQuery<MedrxivRoom[]>({
    queryKey: ["medrxiv-rooms"],
    queryFn: async () => {
      const r = await fetch("/api/dict?type=categories&server=medrxiv");
      if (!r.ok) throw new Error(`dict ${r.status}`);
      return r.json();
    },
    // 51 rows that change when the corpus reloads, i.e. rarely. The endpoint
    // is edge-cached for a day; match that client-side.
    staleTime: 24 * 3600 * 1000,
    gcTime: 24 * 3600 * 1000,
  });
}

/** Exact medRxiv corpus size (from /api/records' count path, edge-cached). */
export function useMedrxivCount() {
  return useQuery<number>({
    queryKey: ["medrxiv-count"],
    queryFn: async () => {
      const r = await fetch("/api/records?server=medrxiv&pageSize=1");
      if (!r.ok) throw new Error(`records ${r.status}`);
      return (await r.json()).totalCount as number;
    },
    staleTime: 24 * 3600 * 1000,
    gcTime: 24 * 3600 * 1000,
  });
}
