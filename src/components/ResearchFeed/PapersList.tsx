import { useState } from "react";
import { RecordRow } from "@/components/RecordRow";
import { RecordPanel } from "@/components/RecordPanel";
import { PanelChat } from "@/components/PanelChat";
import { SHELL_CLS, WidgetHeader } from "@/components/WidgetCard";
import { useAppPanel } from "@/hooks/useAppPanel";
import { useRecentPapers } from "@/hooks/useRecentPapers";
import { paperEntity, setDragEntity } from "@/lib/drag-entity";
import type { CorpusRecord } from "@/types/record";

/** `10.64898/2026.08.18.745514` → the registrant prefix and the key, separately:
 *  the header reads as the DOI, split the way the widget header wants it. */
function doiParts(r: CorpusRecord): { prefix: string; suffix: string } {
  const doi = r.doi ?? "";
  const slash = doi.indexOf("/");
  return slash > 0
    ? { prefix: doi.slice(0, slash), suffix: doi.slice(slash + 1) }
    : { prefix: "DOI", suffix: r.key_number };
}

const Note = ({ children }: { children: React.ReactNode }) => (
  <p className="px-4 py-8 text-center text-xs text-muted-foreground">{children}</p>
);

/**
 * The newest preprints, each in the card the /search widgets use — the same
 * `SHELL_CLS` box and `WidgetHeader` strip as Journal and Status, stacked with
 * a gutter either side and a gap between them.
 *
 * A card is the drag unit: it carries its whole record in the payload
 * (`paperEntity`), so dropping one on the chat input attaches it as context
 * without a second fetch. The grip in the header says so; the ✕ dismisses.
 */
export function PapersList() {
  const { data: records, isError } = useRecentPapers();
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const { openPanel } = useAppPanel();

  if (isError) return <Note>Could not load recent papers.</Note>;
  if (!records) return <Note>Loading…</Note>;

  const shown = records.filter((r) => !dismissed.has(r.id));
  if (!shown.length) return <Note>No papers on record.</Note>;

  const detail = (record: CorpusRecord) => () =>
    openPanel({ title: record.key_number, content: <RecordPanel record={record} /> });

  return (
    <div className="flex flex-col gap-3 px-3 pb-3">
      {shown.map((record) => {
        const { prefix, suffix } = doiParts(record);
        return (
          <div
            key={record.id}
            className={SHELL_CLS}
            draggable
            onDragStart={(e) => setDragEntity(e.dataTransfer, paperEntity(record))}
          >
            <WidgetHeader
              title={prefix}
              sub={suffix}
              onClose={() => setDismissed((d) => new Set(d).add(record.id))}
            />
            <RecordRow
              variant="card"
              record={record}
              first={false}
              onClick={detail(record)}
              onDetail={detail(record)}
              onChat={() =>
                openPanel({
                  title: (
                    <span className="inline-flex items-center gap-2">
                      Chat
                      <span className="inline-flex items-center rounded border bg-muted/40 px-1 font-mono text-[0.85em] font-semibold text-foreground">
                        {record.key_number}
                      </span>
                    </span>
                  ),
                  content: <PanelChat key={record.key_number} record={record} />,
                })
              }
            />
          </div>
        );
      })}
    </div>
  );
}
