import type { ReactNode } from "react";

/**
 * The app's tooltip surface — the recipe the chart tooltips already use, in
 * theme tokens rather than hex, so it is correct in light and dark with no
 * per-theme special case. One definition; `Search.tsx`'s chart tooltips import
 * it too.
 */
export const TOOLTIP_SURFACE =
  "rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground shadow";

/**
 * Hover/focus label for an icon button. CSS-only (`group/tip` + opacity), so it
 * adds no dependency and leaves the trigger's own `group/*` classes alone.
 * Give the trigger an `aria-label`; the bubble is `aria-hidden` so a screen
 * reader hears the label once.
 */
export function Tooltip({
  label,
  children,
  side = "top",
}: {
  label: string;
  children: ReactNode;
  side?: "top" | "bottom";
}) {
  const place = side === "bottom" ? "top-full mt-1.5" : "bottom-full mb-1.5";
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span
        aria-hidden
        className={`pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 ${place} whitespace-nowrap ${TOOLTIP_SURFACE} opacity-0 transition-opacity duration-150 group-hover/tip:opacity-100 group-focus-within/tip:opacity-100`}
      >
        {label}
      </span>
    </span>
  );
}
