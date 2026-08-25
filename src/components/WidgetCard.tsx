import { GripVertical, X } from "lucide-react";

/**
 * The card every widget on /search is drawn in — rounded, hairline border,
 * clipped corners. Lifted out of `pages/Search.tsx` so the Papers panel is
 * literally the same container rather than a second one that resembles it.
 */
export const SHELL_CLS = "rounded-lg border border-border overflow-hidden min-w-0 flex flex-col";

/**
 * Its header strip: an optional icon, the name, the drag grip, an optional
 * sub-label, and the ✕ that dismisses the card. `icon` is optional because a
 * paper card leads with its DOI rather than a glyph.
 */
export function WidgetHeader({ icon, title, sub, right, onClose }: {
  icon?: React.ReactNode; title: string; sub?: string; right?: React.ReactNode; onClose: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b border-border shrink-0 cursor-grab active:cursor-grabbing select-none">
      {icon}
      <span className="text-xs font-semibold text-foreground">{title}</span>
      <GripVertical className="h-3 w-3 text-muted-foreground/60" aria-label="drag to reorder" />
      {sub && <span className="text-[10px] text-muted-foreground truncate">{sub}</span>}
      <span className="flex-1" />
      {right}
      <button
        onClick={onClose}
        onMouseDown={(e) => e.stopPropagation()}
        className="h-5 w-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
