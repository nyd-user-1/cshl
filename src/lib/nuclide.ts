import { useQuery } from "@tanstack/react-query";
import { ELEMENTS, type LitPaper } from "@/lib/structure";

/** Shared nuclide-page plumbing (extracted from pages/structure/Nuclide.tsx so
 *  component files export only components — react-refresh rule). */

export interface Ds { dsid: string; dsref: string | null; pub?: string | null; revised: string | null; refs: number }
export interface ParentDs { nucid: string; dsid: string; revised: string | null; refs: number }
export interface NuclideData {
  nucid: string; a: number; symbol: string; ensdf: Ds[]; xundl: Ds[];
  parent: { ensdf: ParentDs[]; xundl: ParentDs[] };
  literature: { total: number; top: LitPaper[]; recent: LitPaper[] };
}

/** "148Gd" / "Gd-148" → { a, symbol, nucid:"148GD" }; null when it isn't a nuclide. */
export function parseNuclide(s: string | undefined): { a: number; symbol: string; nucid: string } | null {
  if (!s) return null;
  const m = /^(\d{1,3})([A-Za-z]{1,2})$/.exec(s) ?? /^([A-Za-z]{1,2})-?(\d{1,3})$/.exec(s);
  if (!m) return null;
  const numFirst = /^\d/.test(m[1]);
  const a = Number(numFirst ? m[1] : m[2]);
  const raw = numFirst ? m[2] : m[1];
  const symbol = raw[0].toUpperCase() + raw.slice(1).toLowerCase();
  if (!ELEMENTS.includes(symbol)) return null;
  return { a, symbol, nucid: `${a}${symbol.toUpperCase()}` };
}

export const useNuclide = (nucid: string | null) =>
  useQuery({
    queryKey: ["nuclide", nucid],
    queryFn: async (): Promise<NuclideData> => {
      const r = await fetch(`/api/nuclide?nucid=${nucid}`);
      if (!r.ok) throw new Error(`nuclide ${r.status}`);
      return r.json();
    },
    enabled: !!nucid,
    staleTime: 1000 * 60 * 30,
  });
