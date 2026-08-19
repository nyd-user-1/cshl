import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A frame that sits in its slot and, on demand, grows to fill the app-shell
 * panel (header row included — the page becomes a drawing surface). Same trick
 * as 44b's /graph: the children never change parents, so canvases keep their
 * state; only the frame's rectangle animates. Esc collapses.
 *
 * Renders a placeholder <div> (the slot, sized by `className`) and a
 * position:fixed frame glued to it. Scroll/resize keep the two aligned.
 */
const MS = 380;
const EASE = "cubic-bezier(0.25, 0.4, 0.25, 1)";

export function ExpandFrame({
  expanded,
  onToggle,
  className,
  children,
}: {
  expanded: boolean;
  onToggle: () => void;
  /** slot sizing (e.g. "aspect-[3/2] w-full") */
  className?: string;
  children: (expanded: boolean) => ReactNode;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const animating = useRef(false);
  // The frame is portaled into the app-shell panel (overflow-hidden, relative) so a
  // collapsed frame scrolling under the header is clipped like ordinary content.
  const [host] = useState<HTMLElement | null>(() => (typeof document === "undefined" ? null : document.getElementById("app-shell-panel")));

  const rects = () => {
    const panel = host?.getBoundingClientRect();
    const slot = slotRef.current?.getBoundingClientRect();
    if (!slot) return null;
    const ox = panel?.left ?? 0, oy = panel?.top ?? 0;
    return {
      collapsed: { top: slot.top - oy, left: slot.left - ox, width: slot.width, height: slot.height },
      expanded: panel ? { top: 0, left: 0, width: panel.width, height: panel.height } : { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight },
    };
  };
  const apply = (el: HTMLElement, r: { top: number; left: number; width: number; height: number }) => {
    el.style.top = `${r.top}px`; el.style.left = `${r.left}px`;
    el.style.width = `${r.width}px`; el.style.height = `${r.height}px`;
  };

  // Animate between the rectangles when `expanded` flips. This effect is
  // declared BEFORE the glue effect on purpose: on the flip render it must run
  // first and raise `animating`, otherwise the glue's sync() snaps the frame
  // straight to the target rect and the transition has nothing left to animate.
  const prev = useRef(expanded);
  useLayoutEffect(() => {
    if (prev.current === expanded) return;
    prev.current = expanded;
    const el = frameRef.current;
    const r = rects();
    if (!el || !r) return;
    animating.current = true;
    el.style.zIndex = "60";
    // pin the start rect with no transition, force a frame, then ease to the target
    el.style.transition = "";
    apply(el, expanded ? r.collapsed : r.expanded);
    void el.offsetWidth;
    el.style.transition = `top ${MS}ms ${EASE}, left ${MS}ms ${EASE}, width ${MS}ms ${EASE}, height ${MS}ms ${EASE}, border-radius ${MS}ms ${EASE}`;
    apply(el, expanded ? r.expanded : r.collapsed);
    const t = window.setTimeout(() => { el.style.transition = ""; el.style.zIndex = expanded ? "60" : "0"; animating.current = false; }, MS + 20);
    return () => window.clearTimeout(t);
  }, [expanded]);

  // Glue the frame to whichever rectangle is current; written straight to the DOM.
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const sync = () => {
      if (animating.current) return;
      const r = rects();
      if (r) apply(el, expanded ? r.expanded : r.collapsed);
    };
    sync();
    const scroller = document.getElementById("app-main");
    scroller?.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync);
    const ro = new ResizeObserver(sync);
    if (slotRef.current) ro.observe(slotRef.current);
    const panel = document.getElementById("app-shell-panel");
    if (panel) ro.observe(panel);
    return () => { scroller?.removeEventListener("scroll", sync); window.removeEventListener("resize", sync); ro.disconnect(); };
  }, [expanded, host]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onToggle(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded, onToggle]);

  const frame = (
    <div
      ref={frameRef}
      className={`${host ? "absolute" : "fixed"} overflow-hidden bg-background`}
      style={{ zIndex: expanded ? 60 : 0, borderRadius: expanded ? 0 : 6, overflowAnchor: "none" }}
    >
      {children(expanded)}
    </div>
  );
  return (
    <>
      <div ref={slotRef} className={className} />
      {host ? createPortal(frame, host) : frame}
    </>
  );
}
