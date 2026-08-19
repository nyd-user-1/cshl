import { useState } from "react";
import { MoreVertical } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * Row-level ⋮ menu for data tables (Popover-based — the kit has no DropdownMenu
 * primitive). Part of the table standard set by /ensdf.
 */
export function RowActions({ items }: { items: { label: string; onSelect: () => void }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Actions"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <MoreVertical className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={2} className="w-44 p-1">
        {items.map((it) => (
          <button
            key={it.label}
            type="button"
            className="block w-full rounded-sm px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted"
            onClick={(e) => { e.stopPropagation(); setOpen(false); it.onSelect(); }}
          >
            {it.label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
