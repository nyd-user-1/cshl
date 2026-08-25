import { ArrowRight, ExternalLink, GripVertical, Sparkles } from "lucide-react";
import { Tooltip as Hint } from "@/components/ui/tooltip";
import { paperEntity, setDragEntity } from "@/lib/drag-entity";
import type { CorpusRecord } from "@/types/record";

/**
 * One record, as the search results render it: title, abstract, meta, the DOI
 * link and the two row actions.
 *
 * Lifted out of `pages/Search.tsx` unchanged so the Papers panel shows the same
 * card the results do rather than a second one that drifts. `draggable` is the
 * only addition — the panel drags a row into the chat input as context, the
 * search page does not.
 */
export function RecordRow({
  record,
  first,
  onClick,
  onDetail,
  onChat,
  onHover,
  draggable,
}: {
  record: CorpusRecord;
  first: boolean;
  onClick: () => void;
  onDetail: () => void;
  onChat: () => void;
  onHover?: () => void;
  /** Drag the row out as a chat context — the Papers panel sets this. */
  draggable?: boolean;
}) {
  const meta: string[] = [];
  if (record.pub_year) meta.push(String(record.pub_year));
  if (record.authors) {
    const truncated =
      record.authors.length > 80
        ? record.authors.slice(0, 80) + "…"
        : record.authors;
    meta.push(truncated);
  }
  if (record.reference) meta.push(record.reference);

  const iconBtn = "h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-foreground/10 transition-colors";

  return (
    <div
      className={`group px-3 py-3 border-b border-border hover:bg-muted/60 transition-colors ${first ? "border-t" : ""} ${draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}`}
      onClick={onClick}
      onMouseEnter={onHover}
      draggable={draggable}
      onDragStart={draggable ? (e) => { e.stopPropagation(); setDragEntity(e.dataTransfer, paperEntity(record)); } : undefined}
    >
      <div className="flex items-start gap-2">
        {/* The title is the heading (2026-08-25). The key number led this row and
            told a reader nothing they could act on; it still travels with the row
            as the DOI below, so nothing is lost by promoting the title into its
            place. One line — the abstract underneath carries the rest. */}
        {draggable && (
          <GripVertical className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground/50" aria-hidden />
        )}
        <span className="text-sm font-medium text-foreground leading-snug hover:underline flex-1 min-w-0 truncate">
          {record.title}
        </span>
        {/* Match-percentage badge removed 2026-08-20. In hybrid the list interleaves two
            arms whose scores are not on one scale — a dense row carries a cosine (0.6-0.7)
            and a lexical row a ts_rank (0.05-0.3) — so rendering both as "Match X%" put a
            number next to a result that meant something different one row up. The ranking
            is the signal; a single incomparable number beside it is worse than none. Rows
            now carry `arm` ("dense" | "fts" | "both") if this is ever labelled instead. */}
      </div>
      {record.abstract && (
        <p className="text-sm text-muted-foreground mt-0.5 leading-snug line-clamp-2">
          {record.abstract}
        </p>
      )}
      {meta.length > 0 && (
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed truncate">
          {meta.join(" · ")}
        </p>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        {record.doi ? (
          <a
            href={`https://doi.org/${record.doi}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/70 hover:text-foreground transition-colors min-w-0"
          >
            {/* `truncate` moved onto the text span so the trailing icon cannot be
                clipped, and the underline is the house wipe (background-size
                transition) rather than text-decoration. */}
            <span className="link-wipe truncate">{record.doi}</span>
            <ExternalLink className="h-4 w-4 shrink-0" />
          </a>
        ) : <span />}
        {/* bottom-right actions: → (↗ on hover) opens the record; ✦ opens chat about it in the side panel */}
        <div className="flex items-center gap-0.5 shrink-0">
          <Hint label="Open Record">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDetail(); }}
              className={`${iconBtn} group/arrow`}
              aria-label="Open Record"
            >
              <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover/arrow:-rotate-45" />
            </button>
          </Hint>
          <Hint label="Ask Chat">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onChat(); }}
              className={`${iconBtn} group/spark hover:text-yellow-500`}
              aria-label="Ask Chat"
            >
              <Sparkles className="h-4 w-4 transition-transform duration-200 group-hover/spark:-rotate-12" />
            </button>
          </Hint>
        </div>
      </div>
    </div>
  );
}
