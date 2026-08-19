import { useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DECAY_MODES, PARTICLES, QUANTITY_LABELS, QUANTITY_UNITS,
  decay, ndsFormat, reactions, summary, useMassTable,
  type MassTable, type Nuclide,
} from "@/lib/qcalc";

/**
 * QCalc in a dialog — the Q-value calculator running against our own AME2020
 * copy instead of a round trip to nndc.bnl.gov. Values are traced against their
 * servlets by scripts/verify-qcalc.mjs; see the notes at the foot of the dialog
 * for the places we knowingly still differ.
 */

const SELECT_CLASS =
  "h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground " +
  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring focus-visible:ring-offset-2";

const nuclideLabel = (x: Nuclide) => (
  <span className="font-mono">
    <sup>{x.a}</sup>
    {x.el}
  </span>
);

/** value ± uncertainty in NDS notation, e.g. 7590.915 5 */
function Value({ value, error, unit }: { value: number; error: number; unit?: string }) {
  const nds = ndsFormat(value, error);
  return (
    <span className="font-mono text-foreground">
      {nds.value}
      {nds.error && <span className="text-muted-foreground"> {nds.error}</span>}
      {unit ? <span className="text-muted-foreground"> {unit}</span> : null}
    </span>
  );
}

/* ------------------------------------------------------------------ */

function SummaryPanel({ table, nuclide }: { table: MassTable; nuclide: Nuclide }) {
  const rows = useMemo(() => summary(table, nuclide), [table, nuclide]);
  const order = Object.keys(QUANTITY_LABELS).filter((k) => rows[k]);
  return (
    <table className="w-full text-sm">
      <tbody>
        {order.map((key) => {
          const q = rows[key];
          return (
            <tr key={key} className="border-b last:border-0">
              <td className="py-1.5 pr-3 text-muted-foreground">{QUANTITY_LABELS[key]}</td>
              <td className="py-1.5 text-right">
                <Value value={q.value} error={q.error} unit={QUANTITY_UNITS[key] ?? "keV"} />
                {q.systematic && (
                  <span className="ml-1.5 text-[10px] text-muted-foreground" title="extrapolated from systematics">
                    sys
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function DecayPanel({ table, nuclide }: { table: MassTable; nuclide: Nuclide }) {
  const [mode, setMode] = useState("b-");
  const result = useMemo(() => decay(table, nuclide, mode), [table, nuclide, mode]);
  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Decay mode</span>
        <select value={mode} onChange={(e) => setMode(e.target.value)} className={SELECT_CLASS}>
          {DECAY_MODES.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </label>

      {!result ? (
        <p className="text-sm text-muted-foreground">
          No daughter in AME2020 for this channel.
        </p>
      ) : (
        <div className="rounded-lg border p-4">
          <p className="text-sm">
            {nuclideLabel(nuclide)}
            <span className="text-muted-foreground"> → </span>
            {nuclideLabel(result.product)}
            {result.emits.map((id, i) => (
              <span key={i} className="text-muted-foreground"> + {PARTICLES[id]?.label ?? id}</span>
            ))}
          </p>
          <p className="mt-2 text-sm">
            <span className="text-muted-foreground">Q = </span>
            <Value value={result.energy.value} error={result.energy.error} unit="keV" />
          </p>
        </div>
      )}
    </div>
  );
}

function ReactionPanel({ table, target }: { table: MassTable; target: Nuclide }) {
  const [projectileId, setProjectileId] = useState("1NN");
  const [maxMeV, setMaxMeV] = useState("20");

  const channels = useMemo(() => {
    const p = PARTICLES[projectileId];
    const projectile = p && table.get(p.z, p.a);
    const max = Number(maxMeV);
    if (!projectile || !Number.isFinite(max) || max <= 0) return [];
    return reactions(table, target, projectile, max * 1000);
  }, [table, target, projectileId, maxMeV]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Projectile</span>
          <select
            value={projectileId}
            onChange={(e) => setProjectileId(e.target.value)}
            className={SELECT_CLASS}
          >
            {Object.entries(PARTICLES)
              .filter(([id]) => id !== "g")
              .map(([id, p]) => <option key={id} value={id}>{p.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Beam energy</span>
          <Input
            value={maxMeV}
            onChange={(e) => setMaxMeV(e.target.value)}
            className="h-9 w-20"
            inputMode="decimal"
          />
          <span className="text-muted-foreground">MeV</span>
        </label>
      </div>

      {channels.length === 0 ? (
        <p className="text-sm text-muted-foreground">No open channels at this beam energy.</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {channels.length} channel{channels.length === 1 ? "" : "s"} open
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">Products</th>
                <th className="py-1.5 pr-3 text-right font-medium">Q (keV)</th>
                <th className="py-1.5 text-right font-medium">Threshold (keV)</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((c, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="py-1.5 pr-3">
                    {nuclideLabel(c.residual)}
                    {(c.ejectiles.length ? c.ejectiles : ["g"]).map((id, j) => (
                      <span key={j} className="text-muted-foreground"> + {PARTICLES[id]?.label ?? id}</span>
                    ))}
                  </td>
                  <td className="py-1.5 pr-3 text-right">
                    <Value value={c.energy.value} error={c.energy.error} />
                  </td>
                  <td className="py-1.5 text-right font-mono text-muted-foreground">
                    {c.threshold === 0 ? "—" : c.threshold.toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function QCalcDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data: table, isLoading } = useMassTable();
  const [query, setQuery] = useState("");

  const nuclide = useMemo(() => table?.find(query), [table, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Q-value calculator</DialogTitle>
          <DialogDescription>
            Masses, Q-values, and reaction thresholds from AME2020 — computed here, in your browser.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Nuclide</span>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="235U, 40ca, Pb-208…"
                className="h-9 w-40"
              />
            </label>
            {table && !nuclide && query.trim() && (
              <span className="text-xs text-destructive">Not in AME2020</span>
            )}
          </div>

          {isLoading || !table ? (
            <div className="space-y-2">
              {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}
            </div>
          ) : !nuclide ? (
            <p className="text-sm text-muted-foreground">
              Enter a nuclide as mass + symbol, e.g. <span className="font-mono">235U</span> or{" "}
              <span className="font-mono">Pb-208</span>. <span className="font-mono">nn</span> is the
              neutron, following ENSDF convention.
            </p>
          ) : (
            <Tabs defaultValue="summary">
              <TabsList>
                <TabsTrigger value="summary">Summary</TabsTrigger>
                <TabsTrigger value="decay">Decay</TabsTrigger>
                <TabsTrigger value="reactions">Reactions</TabsTrigger>
              </TabsList>
              <TabsContent value="summary" className="mt-4">
                <SummaryPanel table={table} nuclide={nuclide} />
              </TabsContent>
              <TabsContent value="decay" className="mt-4">
                <DecayPanel table={table} nuclide={nuclide} />
              </TabsContent>
              <TabsContent value="reactions" className="mt-4">
                <ReactionPanel table={table} target={nuclide} />
              </TabsContent>
            </Tabs>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t p-4 text-xs text-muted-foreground">
          <span>
            AME2020 — Wang et al., Chin. Phys. C 45, 030003 (2021). Uncertainties in NDS notation.
          </span>
          <a
            href="https://www.nndc.bnl.gov/qcalc/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-nuclear hover:underline"
          >
            NNDC QCalc <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
