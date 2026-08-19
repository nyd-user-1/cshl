import { useState, type FormEvent, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * LogFT in a dialog. Unlike Q-Calc, this one is a real calculation over the
 * Gove–Martin tables and not a file we can trace, so we relay NNDC's own
 * servlet through /api/logft and render exactly what it returns — their
 * numbers, their NDS strings, their ENSDF input deck.
 */

const SELECT_CLASS =
  "h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground " +
  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring focus-visible:ring-offset-2";

const HALF_LIFE_UNITS = ["ms", "s", "m", "h", "d", "y"];

const UNIQUENESS = [
  { value: "", label: "None" },
  { value: "1U", label: "1U" },
  { value: "2U", label: "2U" },
  { value: "3U", label: "3U" },
  { value: "4U", label: "4U" },
];

interface LogftForm {
  nuclide: string;
  decay_mode: string;
  parent_energy_value: string;
  parent_energy_error: string;
  parent_half_life_value: string;
  parent_half_life_unit: string;
  parent_half_life_error: string;
  parent_q_value: string;
  parent_q_error: string;
  daughter_energy_value: string;
  daughter_energy_error: string;
  transition_intensity_value: string;
  transition_intensity_error: string;
  uniqueness: string;
}

const EMPTY: LogftForm = {
  nuclide: "",
  decay_mode: "B-",
  parent_energy_value: "",
  parent_energy_error: "",
  parent_half_life_value: "",
  parent_half_life_unit: "s",
  parent_half_life_error: "",
  parent_q_value: "",
  parent_q_error: "",
  daughter_energy_value: "",
  daughter_energy_error: "",
  transition_intensity_value: "",
  transition_intensity_error: "",
  uniqueness: "",
};

const REQUIRED = [
  "nuclide",
  "decay_mode",
  "parent_energy_value",
  "parent_half_life_value",
  "parent_q_value",
  "daughter_energy_value",
  "transition_intensity_value",
] as const satisfies readonly (keyof LogftForm)[];

interface LogftValues {
  logft_value: number;
  logft_error: number;
  logft_value_nds: string;
  logft_error_nds: string;
  e_avg_value: number;
  e_avg_error: number;
  e_avg_value_nds: string;
  e_avg_error_nds: string;
}

interface LogftSuccess {
  success: true;
  input_lines?: string[];
  report_lines?: string[];
  values: LogftValues;
}

/** The servlet's own rejection, and the proxy's when NNDC is unreachable. */
type LogftResponse = LogftSuccess | { success: false; messages?: string[] } | { error: string };

/* ------------------------------------------------------------------ */

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="w-40 shrink-0 text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/**
 * A value with its uncertainty in NDS digit notation — "8" against 5.2711
 * means 0.0008, so the string is passed to the servlet untouched.
 */
function PairField({
  label, value, error, onValue, onError, width = "w-28", placeholder, unit,
}: {
  label: string;
  value: string;
  error: string;
  onValue: (v: string) => void;
  onError: (v: string) => void;
  width?: string;
  placeholder?: string;
  unit?: ReactNode;
}) {
  return (
    <Row label={label}>
      <Input
        value={value}
        onChange={(e) => onValue(e.target.value)}
        className={`h-9 ${width}`}
        placeholder={placeholder}
        aria-label={label}
        inputMode="decimal"
      />
      {unit}
      <span className="text-muted-foreground">±</span>
      <Input
        value={error}
        onChange={(e) => onError(e.target.value)}
        className="h-9 w-16"
        aria-label={`${label} uncertainty`}
      />
    </Row>
  );
}

function ResultRow({ label, value, error, unit }: {
  label: ReactNode;
  value: string;
  error?: string;
  unit?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="font-mono text-lg text-foreground">
        {value}
        {error && <span className="text-muted-foreground"> {error}</span>}
        {unit && <span className="text-muted-foreground"> {unit}</span>}
      </span>
    </div>
  );
}

function Deck({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">{title}</p>
      <pre className="overflow-x-auto rounded-md bg-muted/40 p-3 font-mono text-xs text-muted-foreground">
        {lines.join("\n")}
      </pre>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function LogftDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [form, setForm] = useState<LogftForm>(EMPTY);
  const [result, setResult] = useState<LogftSuccess | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const set = (key: keyof LogftForm) => (v: string) => setForm((f) => ({ ...f, [key]: v }));
  const complete = REQUIRED.every((k) => form[k].trim() !== "");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (loading || !complete) return;
    setLoading(true);
    setMessages([]);
    setResult(null);

    // The servlet reads null as "absent" and "" as "unparseable" — send null.
    const body = Object.fromEntries(
      Object.entries(form).map(([k, v]) => [k, v.trim() === "" ? null : v.trim()]),
    );

    try {
      const res = await fetch("/api/logft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as LogftResponse;
      if ("error" in data) setMessages([data.error]);
      else if (!data.success) setMessages(data.messages?.length ? data.messages : ["LOGFT rejected these inputs."]);
      else setResult(data);
    } catch {
      setMessages(["Could not reach the LogFT service."]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>LogFT</DialogTitle>
          <DialogDescription>
            β-decay log ft and mean β energy — computed by NNDC's LOGFT code, relayed here.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <form onSubmit={submit} className="space-y-3">
            <Row label="Parent nuclide">
              <Input
                value={form.nuclide}
                onChange={(e) => set("nuclide")(e.target.value)}
                placeholder="60Co"
                className="h-9 w-28"
                aria-label="Parent nuclide"
              />
            </Row>

            <Row label="Decay mode">
              <select
                value={form.decay_mode}
                onChange={(e) => set("decay_mode")(e.target.value)}
                className={SELECT_CLASS}
                aria-label="Decay mode"
              >
                <option value="B-">β⁻</option>
                <option value="B+">ε / β⁺</option>
              </select>
            </Row>

            <PairField
              label="Parent level energy (keV)"
              value={form.parent_energy_value}
              error={form.parent_energy_error}
              onValue={set("parent_energy_value")}
              onError={set("parent_energy_error")}
              placeholder="0"
            />

            <PairField
              label="Parent half-life"
              value={form.parent_half_life_value}
              error={form.parent_half_life_error}
              onValue={set("parent_half_life_value")}
              onError={set("parent_half_life_error")}
              width="w-24"
              unit={
                <select
                  value={form.parent_half_life_unit}
                  onChange={(e) => set("parent_half_life_unit")(e.target.value)}
                  className={SELECT_CLASS}
                  aria-label="Half-life unit"
                >
                  {HALF_LIFE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              }
            />

            <PairField
              label="Q value (keV)"
              value={form.parent_q_value}
              error={form.parent_q_error}
              onValue={set("parent_q_value")}
              onError={set("parent_q_error")}
            />

            <PairField
              label="Daughter level energy (keV)"
              value={form.daughter_energy_value}
              error={form.daughter_energy_error}
              onValue={set("daughter_energy_value")}
              onError={set("daughter_energy_error")}
            />

            <PairField
              label="Transition intensity (%)"
              value={form.transition_intensity_value}
              error={form.transition_intensity_error}
              onValue={set("transition_intensity_value")}
              onError={set("transition_intensity_error")}
            />

            <Row label="Uniqueness">
              <select
                value={form.uniqueness}
                onChange={(e) => set("uniqueness")(e.target.value)}
                className={SELECT_CLASS}
                aria-label="Uniqueness"
              >
                {UNIQUENESS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
              </select>
            </Row>

            <div className="pt-1">
              <Button type="submit" size="sm" disabled={loading || !complete}>
                {loading ? "Calculating…" : "Calculate"}
              </Button>
            </div>
          </form>

          {messages.length > 0 && (
            <div className="mt-4 space-y-1">
              {messages.map((m, i) => (
                <p key={i} className="text-sm text-destructive">{m}</p>
              ))}
            </div>
          )}

          {loading && (
            <div className="mt-5 space-y-2 border-t pt-5">
              {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}
            </div>
          )}

          {result && !loading && (
            <div className="mt-5 space-y-4 border-t pt-5">
              <div className="space-y-3 rounded-lg border p-4">
                <ResultRow
                  label="log ft"
                  value={result.values.logft_value_nds}
                  error={result.values.logft_error_nds}
                />
                <ResultRow
                  label="⟨E(β)⟩"
                  value={result.values.e_avg_value_nds}
                  error={result.values.e_avg_error_nds}
                  unit="keV"
                />
              </div>

              {result.input_lines?.length ? (
                <Deck title="ENSDF input" lines={result.input_lines} />
              ) : null}
              {result.report_lines?.length ? (
                <Deck title="LOGFT report" lines={result.report_lines} />
              ) : null}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t p-4 text-xs text-muted-foreground">
          <span>
            Computed by NNDC's LOGFT (f-values per Gove &amp; Martin, ADNDT 10, 205 (1971)) — relayed,
            not re-derived.
          </span>
          <a
            href="https://www.nndc.bnl.gov/logft/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-nuclear hover:underline"
          >
            NNDC LogFT <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
