import { useQuery } from "@tanstack/react-query";

/**
 * Q-value calculator — a trace of NNDC's QCalc, not a reimplementation of the
 * idea. Every quantity is built from AME2020 mass excesses (public/data/ame2020.json,
 * built by scripts/build-ame2020.mjs) using the same definitions their
 * SummaryServlet uses, and scripts/verify-qcalc.mjs diffs our output against
 * theirs nuclide by nuclide.
 *
 * Sign convention throughout: Q > 0 means the process is energetically allowed.
 */

/** [value, uncertainty, systematic?] as printed in AME's rct1/rct2 files. */
export type Rct = [number, number, number];

export interface Nuclide {
  z: number;
  n: number;
  a: number;
  el: string;
  /** mass excess, keV */
  d: number;
  /** uncertainty on the mass excess, keV */
  dd: number;
  /** 1 when AME extrapolated the value from systematics rather than measuring it */
  est?: 1;
  /** atomic mass, u, with AME's own uncertainty */
  m?: number;
  me?: number;
  /** binding energy per nucleon, keV, with AME's own uncertainty */
  be?: number;
  bee?: number;
  bes?: 1;
  /** Q(β⁻), keV, with AME's own uncertainty */
  qbm?: number;
  qbme?: number;
  qbms?: 1;
  /** separation and reaction energies straight out of rct1/rct2 */
  r?: Record<string, Rct>;
}

interface Ame {
  source: string;
  url: string;
  u_keV: number;
  nuclides: Nuclide[];
}

/** Electron rest energy, CODATA 2018 (keV). */
const M_E = 510.99895;

export interface Quantity {
  /** full-precision value, keV (or u for the two mass rows) */
  value: number;
  /** propagated uncertainty, same unit */
  error: number;
  /** true when any input mass excess is an AME systematic rather than a measurement */
  systematic: boolean;
}

/** Key order is display order — it mirrors QCalc's own VALUE_TYPES map exactly. */
export const QUANTITY_LABELS: Record<string, string> = {
  MASS_EXCESS: "Mass excess",
  BINDING_ENERGY: "Binding energy per nucleon",
  ATOMIC_MASS: "Atomic mass",
  AMN: "Atomic mass (neutron-mass units)",
  QBM: "Q(β⁻)",
  QEC: "Q(ε)",
  QBP: "Q(β⁺)",
  SN: "S(n)",
  SP: "S(p)",
  S2N: "S(2n)",
  S2P: "S(2p)",
  QA: "Q(α)",
  Q2BM: "Q(2β⁻)",
  QBMN: "Q(β⁻n)",
  QECP: "Q(εp)",
  Q2EC: "Q(2ε)",
  Q2BP: "Q(2β⁺)",
  QBM2N: "Q(β⁻2n)",
  QECA: "Q(εα)",
  QBMA: "Q(β⁻α)",
};

/** Units per quantity — the two mass rows are in u, everything else keV. */
export const QUANTITY_UNITS: Record<string, string> = {
  ATOMIC_MASS: "u",
  AMN: "",
};

/* ------------------------------------------------------------------ */
/*  Table                                                              */
/* ------------------------------------------------------------------ */

export class MassTable {
  private byZA = new Map<number, Nuclide>();
  readonly uKeV: number;
  readonly source: string;
  /** ¹n, ¹H and ⁴He — the reference masses every Q-value is written against. */
  readonly neutron: Nuclide;
  readonly hydrogen: Nuclide;
  readonly alpha: Nuclide;

  constructor(ame: Ame) {
    this.uKeV = ame.u_keV;
    this.source = ame.source;
    for (const x of ame.nuclides) this.byZA.set(x.z * 1000 + x.a, x);
    const need = (z: number, a: number, what: string) => {
      const x = this.get(z, a);
      if (!x) throw new Error(`AME2020 is missing ${what}`);
      return x;
    };
    this.neutron = need(0, 1, "the neutron");
    this.hydrogen = need(1, 1, "¹H");
    this.alpha = need(2, 4, "⁴He");
  }

  get(z: number, a: number): Nuclide | undefined {
    return this.byZA.get(z * 1000 + a);
  }

  /** Every nuclide in the evaluation, in the mass file's own order. */
  all(): Nuclide[] {
    return [...this.byZA.values()];
  }

  /** Resolve "235U", "u235", "U-235", "40ca", "NN"/"nn" (neutron, per ENSDF). */
  find(query: string): Nuclide | undefined {
    const s = query.trim();
    if (!s) return undefined;
    if (/^n{1,2}$/.test(s) && s !== "N") return this.neutron;
    const m =
      s.match(/^(\d{1,3})\s*-?\s*([A-Za-z]{1,3})$/) ??
      s.match(/^([A-Za-z]{1,3})\s*-?\s*(\d{1,3})$/);
    if (!m) return undefined;
    const [a, el] = /^\d/.test(m[1]) ? [Number(m[1]), m[2]] : [Number(m[2]), m[1]];
    const sym = el.toLowerCase();
    for (const x of this.byZA.values()) {
      if (x.a === a && x.el.toLowerCase() === sym) return x;
    }
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/*  Quantities                                                         */
/* ------------------------------------------------------------------ */

/** One term in a mass-excess sum: a nuclide and how many of it, with its sign. */
type Term = [Nuclide | undefined, number];

/** Σ cᵢ·Δᵢ with uncertainties in quadrature; undefined if any nuclide is absent. */
function combine(terms: Term[]): Quantity | undefined {
  let value = 0;
  let variance = 0;
  let systematic = false;
  for (const [nuc, c] of terms) {
    if (!nuc) return undefined;
    value += c * nuc.d;
    variance += (c * nuc.dd) ** 2;
    if (nuc.est) systematic = true;
  }
  return { value, error: Math.sqrt(variance), systematic };
}

/**
 * Every quantity QCalc's Summary reports, for one nuclide. Keys and definitions
 * match their SummaryServlet response; absent daughters yield an absent entry
 * rather than a zero.
 */
export function summary(t: MassTable, x: Nuclide): Record<string, Quantity> {
  const { z, a } = x;
  const g = (dz: number, da: number) => t.get(z + dz, a + da);
  const n = t.neutron;
  const he = t.alpha;

  /** A row AME already published — read it, never re-derive it. */
  const rct = (nuc: Nuclide | undefined, key: string): Quantity | undefined => {
    const r = nuc?.r?.[key];
    return r && { value: r[0], error: r[1], systematic: !!r[2] };
  };
  /** Q(ε) is Q(β⁻) of the daughter read backwards, so it inherits AME's σ. */
  const negate = (q: Quantity | undefined): Quantity | undefined =>
    q && { ...q, value: -q.value };

  const qbm = (nuc: Nuclide | undefined): Quantity | undefined =>
    nuc?.qbm === undefined
      ? undefined
      : { value: nuc.qbm, error: nuc.qbme ?? 0, systematic: !!nuc.qbms };

  const out: Record<string, Quantity | undefined> = {
    MASS_EXCESS: { value: x.d, error: x.dd, systematic: !!x.est },
    BINDING_ENERGY:
      x.be === undefined
        ? undefined
        : { value: x.be, error: x.bee ?? 0, systematic: !!x.bes },

    // Straight out of AME's rct1/rct2 — these carry the correlated uncertainties.
    SN: rct(x, "SN"),
    S2N: rct(x, "S2N"),
    SP: rct(x, "SP"),
    S2P: rct(x, "S2P"),
    QA: rct(x, "QA"),
    Q2BM: rct(x, "Q2BM"),
    QECP: rct(x, "QECP"),
    QBMN: rct(x, "QBMN"),

    // Published as a column of the mass file.
    QBM: qbm(x),
    // ε against Z−1 is that nuclide's β⁻ decay run in reverse.
    QEC: negate(qbm(g(-1, 0))),
    Q2EC: negate(rct(g(-2, 0), "Q2BM")),

    // Not published by AME — derived, with uncertainties in quadrature.
    QBM2N: combine([[x, 1], [g(1, -2), -1], [n, -2]]),
    QBMA: combine([[x, 1], [g(-1, -4), -1], [he, -1]]),
    QECA: combine([[x, 1], [g(-3, -4), -1], [he, -1]]),
  };

  // β⁺ costs two electron masses relative to the ε Q-value.
  const shift = (q: Quantity | undefined, by: number) =>
    q && { ...q, value: q.value + by };
  out.QBP = shift(out.QEC, -2 * M_E);
  out.Q2BP = shift(out.Q2EC, -4 * M_E);

  // Masses — AME prints the atomic mass and its uncertainty directly.
  if (x.m !== undefined) {
    const massU = x.m;
    const massErrU = x.me ?? 0;
    out.ATOMIC_MASS = { value: massU, error: massErrU, systematic: !!x.est };
    // AMN is the atomic mass on the neutron-mass scale. QCalc leaves the
    // uncertainty unscaled — it reports the same σ as the atomic mass itself.
    const nMassU = n.m ?? 1 + n.d / t.uKeV;
    out.AMN = { value: massU / nMassU, error: massErrU, systematic: !!x.est };
  }

  const clean: Record<string, Quantity> = {};
  for (const [k, v] of Object.entries(out)) if (v) clean[k] = v;
  return clean;
}

/* ------------------------------------------------------------------ */
/*  Decay mode                                                         */
/* ------------------------------------------------------------------ */

/**
 * The twelve decay channels QCalc offers, as (ΔZ, ΔA) on the parent plus the
 * light particles emitted. Their DecayServlet serves the *same* published
 * quantity as Summary for each channel — note that "Proton" and "Neutron"
 * report the separation energy, i.e. the positive cost of removing the
 * nucleon, not the (negative) Q of emitting it.
 */
export const DECAY_MODES: {
  id: string; label: string; dz: number; da: number; emits: string[]; key: string;
}[] = [
  { id: "p", label: "Proton", dz: -1, da: -1, emits: ["1H"], key: "SP" },
  { id: "n", label: "Neutron", dz: 0, da: -1, emits: ["1NN"], key: "SN" },
  { id: "a", label: "α", dz: -2, da: -4, emits: ["4He"], key: "QA" },
  { id: "b-", label: "β⁻", dz: 1, da: 0, emits: [], key: "QBM" },
  { id: "2b-", label: "2β⁻", dz: 2, da: 0, emits: [], key: "Q2BM" },
  { id: "b-n", label: "β⁻n", dz: 1, da: -1, emits: ["1NN"], key: "QBMN" },
  { id: "b-2n", label: "β⁻2n", dz: 1, da: -2, emits: ["1NN", "1NN"], key: "QBM2N" },
  { id: "b-a", label: "β⁻α", dz: -1, da: -4, emits: ["4He"], key: "QBMA" },
  { id: "b+", label: "β⁺", dz: -1, da: 0, emits: [], key: "QBP" },
  { id: "ec", label: "ε", dz: -1, da: 0, emits: [], key: "QEC" },
  { id: "ecp", label: "εp", dz: -2, da: -1, emits: ["1H"], key: "QECP" },
  { id: "eca", label: "εα", dz: -3, da: -4, emits: ["4He"], key: "QECA" },
];

/** Light particles that can appear as ejectiles, keyed as QCalc keys them. */
export const PARTICLES: Record<string, { z: number; a: number; label: string }> = {
  g: { z: 0, a: 0, label: "γ" },
  "1NN": { z: 0, a: 1, label: "n" },
  "1H": { z: 1, a: 1, label: "p" },
  "2H": { z: 1, a: 2, label: "d" },
  "3H": { z: 1, a: 3, label: "t" },
  "3He": { z: 2, a: 3, label: "³He" },
  "4He": { z: 2, a: 4, label: "α" },
};

export interface DecayResult {
  energy: Quantity;
  product: Nuclide;
  emits: string[];
}

/** Q for one decay channel of `parent`; undefined when the daughter is unknown. */
export function decay(t: MassTable, parent: Nuclide, modeId: string): DecayResult | undefined {
  const mode = DECAY_MODES.find((m) => m.id === modeId);
  if (!mode) return undefined;
  const product = t.get(parent.z + mode.dz, parent.a + mode.da);
  if (!product) return undefined;
  const energy = summary(t, parent)[mode.key];
  return energy && { energy, product, emits: mode.emits };
}

/** Q for emitting an arbitrary light particle, the ejectile form of the search. */
export function decayByEjectile(
  t: MassTable,
  parent: Nuclide,
  ejectileId: string,
): DecayResult | undefined {
  const p = PARTICLES[ejectileId];
  if (!p) return undefined;
  const product = t.get(parent.z - p.z, parent.a - p.a);
  const particle = t.get(p.z, p.a);
  if (!product || !particle) return undefined;
  const q = combine([[parent, 1], [product, -1], [particle, -1]]);
  return q && { energy: q, product, emits: [ejectileId] };
}

/* ------------------------------------------------------------------ */
/*  Reaction mode                                                      */
/* ------------------------------------------------------------------ */

/** Ejectiles the channel search draws from, heaviest first (QCalc's order). */
const EJECTILES = ["4He", "3He", "3H", "2H", "1H", "1NN"];
/** QCalc enumerates up to six light products per channel. */
const MAX_EJECTILES = 6;

export interface Channel {
  energy: Quantity;
  /** kinematic threshold in the lab, keV; 0 for exoergic channels */
  threshold: number;
  residual: Nuclide;
  ejectiles: string[];
}

/**
 * Every exit channel of target(projectile, …) reachable with a beam energy up
 * to `maxEnergyKeV`, matching QCalc's Reaction search: all multisets of up to
 * six light ejectiles whose residual exists in AME. A bare γ stands for
 * radiative capture — γ carries no Z or A, so it is only meaningful alone.
 */
export function reactions(
  t: MassTable,
  target: Nuclide,
  projectile: Nuclide,
  maxEnergyKeV: number,
): Channel[] {
  const out: Channel[] = [];
  const totalZ = target.z + projectile.z;
  const totalA = target.a + projectile.a;
  // Lab threshold carries the recoil factor (M_target + M_projectile) / M_target.
  const massOf = (x: Nuclide) => x.m ?? x.a + x.d / t.uKeV;
  const recoil = (massOf(target) + massOf(projectile)) / massOf(target);

  const consider = (ejectiles: string[]) => {
    let z = totalZ, a = totalA;
    const terms: Term[] = [[target, 1], [projectile, 1]];
    for (const id of ejectiles) {
      const p = PARTICLES[id];
      z -= p.z;
      a -= p.a;
      const particle = t.get(p.z, p.a);
      if (!particle) return;
      terms.push([particle, -1]);
    }
    if (z < 0 || a < 1) return;
    const residual = t.get(z, a);
    if (!residual) return;
    terms.push([residual, -1]);
    const energy = combine(terms);
    if (!energy) return;
    const threshold = energy.value >= 0 ? 0 : -energy.value * recoil;
    if (threshold > maxEnergyKeV) return;
    out.push({ energy, threshold, residual, ejectiles });
  };

  // Radiative capture: no massive ejectile at all.
  consider([]);

  // Non-decreasing index walk enumerates each multiset exactly once.
  const walk = (start: number, chosen: string[]) => {
    if (chosen.length >= MAX_EJECTILES) return;
    for (let i = start; i < EJECTILES.length; i++) {
      const next = [...chosen, EJECTILES[i]];
      consider(next);
      walk(i, next);
    }
  };
  walk(0, []);

  return out.sort((x, y) => y.energy.value - x.energy.value);
}

/* ------------------------------------------------------------------ */
/*  NDS-style rounding                                                 */
/* ------------------------------------------------------------------ */

/**
 * Nuclear Data Sheets uncertainty notation: the uncertainty is quoted to one
 * significant digit, or two when its leading digit is 1 or 2, and the value is
 * rounded to that same decimal place. "7590.915 5" means 7590.915 ± 0.005.
 * Once the rounding place sits above the units digit the value is written in
 * scientific notation so the paired digits still line up.
 */
export function ndsFormat(value: number, error: number): { value: string; error: string } {
  if (!Number.isFinite(value)) return { value: "—", error: "" };
  if (!Number.isFinite(error) || error <= 0) return { value: String(value), error: "" };

  /* NDS keeps two significant digits when they come out at 25 or below, and one
   * otherwise — so 0.2377 is written "24" but 0.0354 collapses to "4". Round at
   * two digits first, then step back if the pair is too large. */
  const exp = Math.floor(Math.log10(error));
  let place = exp - 1;
  let digits = Math.round(error / 10 ** place);
  if (digits >= 100) { place += 1; digits = Math.round(error / 10 ** place); } // carry: 99.6 -> 100
  if (digits > 25) {
    place += 1;
    digits = Math.round(error / 10 ** place);
    if (digits >= 10) { place += 1; digits = Math.round(error / 10 ** place); }
  }
  const errDigits = String(digits);

  if (place <= 0) {
    return { value: value.toFixed(-place), error: errDigits };
  }

  // Rounding place is above the units digit — switch to scientific notation and
  // express the value with enough decimals that its last digit is the error's.
  const vExp = value === 0 ? place : Math.floor(Math.log10(Math.abs(value)));
  const dec = Math.max(0, vExp - place);
  const mantissa = (value / 10 ** vExp).toFixed(dec);
  const sign = vExp < 0 ? "-" : "+";
  return {
    value: `${mantissa}E${sign}${String(Math.abs(vExp)).padStart(1, "0")}`,
    error: errDigits,
  };
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export const useMassTable = () =>
  useQuery({
    queryKey: ["ame2020"],
    queryFn: async () => {
      const res = await fetch("/data/ame2020.json");
      if (!res.ok) throw new Error(`ame2020.json: ${res.status}`);
      return new MassTable(await res.json());
    },
    staleTime: Infinity,
  });
