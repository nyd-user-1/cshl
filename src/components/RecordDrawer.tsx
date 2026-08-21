import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  ExternalLink,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  X,
  Check,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import type { CorpusRecord } from "@/types/record";
import { useS2Enrichment } from "@/hooks/useS2Enrichment";
import { useQueryClient } from "@tanstack/react-query";

interface RecordDrawerProps {
  records: CorpusRecord[];
  currentIndex: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (index: number) => void;
}

/* ------------------------------------------------------------------ *
 *  Related preprints — powered by cshl-CITE (see api/similar.ts).
 *
 *  Deliberately a different model from the one behind the search box:
 *  this asks "what else is like this paper?", which is a document->document
 *  question, and the citation-trained encoder is the one measured best at
 *  it (R@10 0.212 vs MedCPT 0.179, p = 0.0001). Costs no inference — the
 *  paper's vector is already stored, so this is one indexed kNN.
 * ------------------------------------------------------------------ */
function RelatedPreprints({ recordKey, onOpen }: { recordKey: string; onOpen?: (key: string) => void }) {
  const [rows, setRows] = useState<Array<Record<string, unknown>> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setRows(null); setFailed(false);
    if (!recordKey) return;
    fetch(`/api/similar?key=${encodeURIComponent(recordKey)}&limit=6`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (alive) setRows(d.records ?? []); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [recordKey]);

  if (failed || (rows && rows.length === 0)) return null;

  return (
    <div className="pt-5">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Related preprints
      </h4>
      {!rows ? (
        <p className="mt-2 text-xs text-muted-foreground">Finding related work…</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {rows.map((r) => (
            <li key={String(r.key_number)} className="group">
              <button
                type="button"
                onClick={() => onOpen?.(String(r.key_number))}
                className="w-full text-left text-xs leading-snug text-foreground/85 group-hover:text-foreground"
              >
                <span className="link-wipe">{String(r.title)}</span>
              </button>
              <span className="text-[10px] text-muted-foreground">
                {String(r.server ?? "")}{r.pub_year ? ` · ${r.pub_year}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RecordDrawer({
  records,
  currentIndex,
  open,
  onOpenChange,
  onNavigate,
}: RecordDrawerProps) {
  const record = records[currentIndex];
  if (!record) return null;

  // Seeded from the record we already hold → the body renders instantly; the
  // Neon fetch only fills the S2-only fields (venue, OA pdf, s2 authors …).
  const { data: s2, isPlaceholderData } = useS2Enrichment(open ? record.id : null, {
    citation_count: record.citation_count ?? null,
    abstract: record.abstract ?? null,
    s2_lookup_status: record.s2_lookup_status ?? null,
  });
  const s2Loading = !s2 && !isPlaceholderData;
  const queryClient = useQueryClient();
  const [abstractDraft, setAbstractDraft] = useState("");
  const [abstractOpen, setAbstractOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSaveAbstract = async () => {
    if (!abstractDraft.trim()) return;
    setSaving(true);
    await fetch(`/api/record?id=${record.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ abstract: abstractDraft.trim() }) });
    setSaving(false);
    setSaved(true);
    setAbstractDraft("");
    queryClient.invalidateQueries({ queryKey: ["s2-enrichment", record.id] });
    setTimeout(() => setSaved(false), 2000);
  };

  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < records.length - 1;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "TEXTAREA") return;
      if (e.key === "ArrowLeft" && hasPrev) onNavigate(currentIndex - 1);
      if (e.key === "ArrowRight" && hasNext) onNavigate(currentIndex + 1);
    },
    [hasPrev, hasNext, currentIndex, onNavigate]
  );

  useEffect(() => {
    if (!open) return;
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, handleKeyDown]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" showCloseButton={false} className="flex flex-col">
        <SheetHeader className="pb-0 shrink-0 pr-4">
          {/* Navigation row */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => hasPrev && onNavigate(currentIndex - 1)}
              disabled={!hasPrev}
              className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-muted disabled:opacity-30 transition-colors"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => hasNext && onNavigate(currentIndex + 1)}
              disabled={!hasNext}
              className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-muted disabled:opacity-30 transition-colors"
            >
              <ChevronRight className="h-4 w-4" />
            </button>

            <button
              onClick={() => onOpenChange(false)}
              className="ml-auto inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-muted opacity-70 hover:opacity-100 transition-all"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* The paper's title IS the header. */}
          <SheetTitle className="text-base leading-snug">{record.title}</SheetTitle>
          <SheetDescription className="sr-only">{record.key_number}</SheetDescription>
        </SheetHeader>

        <div className="overflow-y-auto px-4 pb-6 pt-2 flex-1 min-h-0 select-text">
          {/* Loading state */}
          {s2Loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {!s2Loading && (
            <>
                {/* DOI */}
                {record.doi && (
                  <div className="py-3 border-b border-border/80">
                    <a
                      href={`https://doi.org/${record.doi}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs text-brand hover:underline"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      DOI: {record.doi}
                    </a>
                  </div>
                )}

                {/* Abstract — ten lines, then the row expands it. */}
                {s2?.abstract ? (
                  <div className="py-3">
                    <button
                      type="button"
                      onClick={() => setAbstractOpen((v) => !v)}
                      className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-muted"
                      aria-expanded={abstractOpen}
                    >
                      <span className="text-xs text-muted-foreground">Abstract</span>
                      <ChevronDown
                        className={`ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform ${abstractOpen ? "rotate-180" : ""}`}
                      />
                    </button>
                    <p
                      className={`mt-1 text-sm font-medium leading-relaxed text-foreground/80 ${abstractOpen ? "" : "line-clamp-[10]"}`}
                    >
                      {s2.abstract}
                    </p>
                  </div>
                ) : !s2Loading && (
                  <div className="py-3">
                    <span className="text-xs text-muted-foreground block mb-1">Abstract</span>
                    <textarea
                      value={abstractDraft}
                      onChange={(e) => setAbstractDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && abstractDraft.trim()) {
                          e.preventDefault();
                          handleSaveAbstract();
                        }
                      }}
                      placeholder="Paste abstract here..."
                      className="w-full rounded-md border border-border/80 bg-muted/30 px-3 py-2 text-sm text-foreground leading-relaxed placeholder:text-muted-foreground/40 outline-none focus:ring-1 focus:ring-foreground/20 resize-none min-h-[80px]"
                      rows={3}
                    />
                    {abstractDraft.trim() && (
                      <button
                        onClick={handleSaveAbstract}
                        disabled={saving}
                        className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-3 py-1 text-xs font-medium hover:bg-foreground/90 transition-colors disabled:opacity-50"
                      >
                        {saving ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : saved ? (
                          <Check className="h-3 w-3" />
                        ) : null}
                        {saving ? "Saving..." : saved ? "Saved" : "Save Abstract"}
                      </button>
                    )}
                  </div>
                )}

                {record.authors && (
                  <div className="py-3">
                    <span className="text-xs text-muted-foreground">Authors</span>
                    <p className="text-sm font-medium">{record.authors}</p>
                  </div>
                )}

                {/* Year */}
                <div className="py-3">
                  <span className="text-xs text-muted-foreground">Year</span>
                  <p className="text-sm font-medium">{record.pub_year}</p>
                </div>

            </>
          )}

          {record?.key_number && (
            <RelatedPreprints recordKey={String(record.key_number)} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
