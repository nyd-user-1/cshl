import { useQuery } from "@tanstack/react-query";
import type { CorpusRecord } from "@/types/record";

const PAGE_SIZE = 30;

/**
 * The newest preprints, prefetched.
 *
 * `/api/records` already returns exactly this — it orders by `pub_year DESC,
 * posted_date DESC, key_number DESC` and is edge-cached for an hour — so the
 * panel needs no endpoint of its own.
 *
 * AppLayout calls this on mount, which is the whole point: the fetch happens
 * while the reader is doing something else, so opening the Papers panel renders
 * from cache instead of showing a spinner. `staleTime` keeps it from refetching
 * every time the panel is toggled; the corpus gains rows once a day.
 */
export function useRecentPapers() {
  return useQuery({
    queryKey: ["recent-papers", PAGE_SIZE],
    queryFn: async (): Promise<CorpusRecord[]> => {
      const res = await fetch(`/api/records?page=1&pageSize=${PAGE_SIZE}`);
      if (!res.ok) throw new Error(`records ${res.status}`);
      const data = await res.json();
      return (data.records ?? []) as CorpusRecord[];
    },
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    refetchOnWindowFocus: false,
  });
}
