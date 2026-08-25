import { useEffect, useRef, useState } from "react";
import { RecordRow } from "@/components/RecordRow";
import { RecordPanel } from "@/components/RecordPanel";
import { PanelChat } from "@/components/PanelChat";
import { SHELL_CLS, WidgetHeader } from "@/components/WidgetCard";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppPanel } from "@/hooks/useAppPanel";
import { useRecentPapers } from "@/hooks/useRecentPapers";
import { paperEntity, setDragEntity } from "@/lib/drag-entity";
import type { CorpusRecord } from "@/types/record";

const Note = ({ children }: { children: React.ReactNode }) => (
  <p className="px-4 py-8 text-center text-xs text-muted-foreground">{children}</p>
);

/**
 * The newest preprints, each in the card the /search widgets use — the same
 * `SHELL_CLS` box and `WidgetHeader` strip as Journal and Status, stacked with a
 * gutter either side and a gap between them.
 *
 * The header carries the key number and nothing else: the DOI's registrant
 * prefix (`10.64898`) is identical on almost every row and named the publisher,
 * not the paper.
 *
 * The card is the drag unit and drags as itself. It carries its whole record in
 * the payload (`paperEntity`), so dropping one on the chat input attaches it as
 * context with no second fetch.
 */
export function PapersList() {
  const { data, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = useRecentPapers();
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const { openPanel } = useAppPanel();
  const sentinel = useRef<HTMLDivElement | null>(null);

  // Pull the next page as the bottom of the list comes into view. `rootMargin`
  // starts the fetch before the reader arrives, so the scroll never stalls.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) void fetchNextPage(); },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, fetchNextPage]);

  if (isError) return <Note>Could not load recent papers.</Note>;
  // Cards in outline while the first page lands. A cold Neon plus a cold
  // function measured 5.9s against production (265ms once the edge has it, and
  // a deploy purges that cache) — long enough that a bare "Loading…" reads as
  // broken. AppLayout's prefetch means an open normally never sees this.
  if (!data) {
    return (
      <div className="flex flex-col gap-3 px-3 pb-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className={SHELL_CLS}>
            <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
              <Skeleton className="h-3 w-3" />
              <Skeleton className="h-3 w-32" />
            </div>
            <div className="space-y-2 px-3 py-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  const shown = data.pages.flat().filter((r) => !dismissed.has(r.id));
  if (!shown.length) return <Note>No papers on record.</Note>;

  const detail = (record: CorpusRecord) => () =>
    openPanel({ title: record.key_number, content: <RecordPanel record={record} /> });

  return (
    <div className="flex flex-col gap-3 px-3 pb-3">
      {shown.map((record) => (
        <div
          key={record.id}
          className={SHELL_CLS}
          draggable
          onDragStart={(e) => {
            setDragEntity(e.dataTransfer, paperEntity(record));
            // Pin the drag image to this card. Left to itself Chrome does not
            // hand you the element — it composites its auto-generated snapshot
            // onto a padded backing plate with a drop shadow, which is the box
            // that appeared to be wrapped around the widget. Naming the element
            // makes the preview exactly the card's own bounds, and passing the
            // grab point keeps the card under the cursor where it was picked up
            // instead of snapping to a corner.
            const r = e.currentTarget.getBoundingClientRect();
            e.dataTransfer.setDragImage(e.currentTarget, e.clientX - r.left, e.clientY - r.top);
          }}
        >
          <WidgetHeader
            gripFirst
            title={record.key_number}
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
      ))}

      <div ref={sentinel} className="h-px" />
      {isFetchingNextPage && (
        <p className="pb-2 text-center text-[10px] uppercase tracking-widest text-muted-foreground">Loading…</p>
      )}
    </div>
  );
}
