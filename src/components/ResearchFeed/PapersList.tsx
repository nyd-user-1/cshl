import { useEffect, useState } from "react";
import { RecordRow } from "@/components/RecordRow";
import { RecordPanel } from "@/components/RecordPanel";
import { PanelChat } from "@/components/PanelChat";
import { useAppPanel } from "@/hooks/useAppPanel";
import type { CorpusRecord } from "@/types/record";

const PAGE_SIZE = 30;

/**
 * The newest preprints, as the same card the search results render.
 *
 * `/api/records` already returns exactly this: it orders by `pub_year DESC,
 * posted_date DESC, key_number DESC` and is edge-cached for an hour, so the
 * panel needs no endpoint of its own and costs nothing to open twice.
 *
 * The rows are draggable — that is the point of the panel. A row carries its
 * whole record in the drag payload (`paperEntity`), so dropping one on the chat
 * input attaches it as context without a second fetch.
 */
export function PapersList() {
  const [records, setRecords] = useState<CorpusRecord[] | null>(null);
  const [failed, setFailed] = useState(false);
  const { openPanel } = useAppPanel();

  useEffect(() => {
    let alive = true;
    fetch(`/api/records?page=1&pageSize=${PAGE_SIZE}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (alive) setRecords((d.records ?? []) as CorpusRecord[]); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  if (failed) {
    return <p className="px-4 py-8 text-center text-xs text-muted-foreground">Could not load recent papers.</p>;
  }
  if (!records) {
    return <p className="px-4 py-8 text-center text-xs text-muted-foreground">Loading…</p>;
  }
  if (!records.length) {
    return <p className="px-4 py-8 text-center text-xs text-muted-foreground">No papers on record yet.</p>;
  }

  return (
    <>
      {records.map((record, i) => (
        <RecordRow
          key={record.id}
          record={record}
          first={i === 0}
          draggable
          onClick={() => openPanel({ title: record.key_number, content: <RecordPanel record={record} /> })}
          onDetail={() => openPanel({ title: record.key_number, content: <RecordPanel record={record} /> })}
          onChat={() => openPanel({
            title: (
              <span className="inline-flex items-center gap-2">
                Chat
                <span className="inline-flex items-center rounded border bg-muted/40 px-1 font-mono text-[0.85em] font-semibold text-foreground">{record.key_number}</span>
              </span>
            ),
            content: <PanelChat key={record.key_number} record={record} />,
          })}
        />
      ))}
    </>
  );
}
