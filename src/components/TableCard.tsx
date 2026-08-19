import type { ReactNode } from "react";

/**
 * The table standard set by /ensdf: one bordered card; controls (search,
 * tabs…) in the card's top row; sticky column headers directly beneath; rows
 * scrolling INSIDE the card (~730px cap) instead of the page; a count footer.
 * The <table> passed as children should use `w-full table-fixed text-sm` and
 * give its <th>s the exported TH class so they stick.
 */
export function TableCard({
  toolbar,
  footer,
  children,
}: {
  toolbar?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-sm border">
      {toolbar && <div className="flex flex-wrap items-center gap-3 border-b px-3 py-2.5">{toolbar}</div>}
      <div className="max-h-[min(730px,72dvh)] overflow-y-auto">{children}</div>
      {footer && (
        <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
          {footer}
        </div>
      )}
    </div>
  );
}

/** Sticky header-cell base class (opaque so rows scroll under it). */
export const TH = "sticky top-0 z-10 border-b bg-card px-3 py-2 font-medium";
