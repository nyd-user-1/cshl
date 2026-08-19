// /api/logft — thin proxy to NNDC's LogFT calculator.
//
// LogFT is a genuine calculation (Fermi integrals over the Gove–Martin
// tables), not a table we can trace — so unlike Q-Calc we do not recompute
// it. We forward the exact JSON their own page POSTs to LogFTDataServlet and
// return their response untouched: same numbers, same NDS strings, same
// ENSDF input deck. The proxy exists only because their servlet sends no
// CORS headers.
//
//   POST { nuclide, decay_mode, parent_energy_value, parent_energy_error,
//          parent_half_life_value, parent_half_life_unit, parent_half_life_error,
//          parent_q_value, parent_q_error, daughter_energy_value,
//          daughter_energy_error, transition_intensity_value,
//          transition_intensity_error, uniqueness }

export const config = { maxDuration: 30 };

const ENDPOINT = "https://www.nndc.bnl.gov/logft/LogFTDataServlet";

/** The exact field list their form sends — anything else is dropped. */
const FIELDS = [
  "nuclide", "decay_mode",
  "parent_energy_value", "parent_energy_error",
  "parent_half_life_value", "parent_half_life_unit", "parent_half_life_error",
  "parent_q_value", "parent_q_error",
  "daughter_energy_value", "daughter_energy_error",
  "transition_intensity_value", "transition_intensity_error",
  "uniqueness",
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const b = req.body ?? {};
  const payload: Record<string, string | null> = {};
  for (const f of FIELDS) {
    const v = b[f];
    // Their servlet distinguishes null (absent) from "" (unparseable) — keep that.
    payload[f] = v === undefined || v === null || v === "" ? null : String(v).slice(0, 40);
  }

  try {
    const upstream = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    if (!upstream.ok) {
      return res.status(502).json({ error: `NNDC LogFT: HTTP ${upstream.status}` });
    }
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=86400");
    return res.status(200).json(await upstream.json());
  } catch {
    return res.status(502).json({ error: "NNDC LogFT is unreachable" });
  }
}
