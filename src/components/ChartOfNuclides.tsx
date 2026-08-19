import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AGE_COLORS,
  ELEMENTS,
  XUNDL_COLORS,
  XUNDL_NONE_COLOR,
  ageLabel,
  xundlBucket,
} from "@/lib/structure";

export type ChartMode = "age" | "xundl";

/** [z, n, a, ageBucket, xundlSetCount] */
type Cell = [number, number, number, number, number];

/** Canvas transform: logical → container pixels. */
interface View {
  k: number;
  tx: number;
  ty: number;
}

interface Props {
  grid: Cell[];
  mode: ChartMode;
  /** click on a cell → (A, Z); callers build the nuclide route from it */
  onSelect: (a: number, z: number) => void;
  /** Zoom the view onto a mass chain (a), an element (z), or one nuclide (both). null = leave alone. */
  focus?: { a?: number; z?: number } | null;
}

/** Logical size of one nuclide cell; the view transform does the rest. */
const CELL = 6;
/** Fraction of the container left as breathing room around the fitted data. */
const PAD = 0.03;
/** Pointer travel (px) above which a press is a pan, not a click. */
const CLICK_SLOP = 5;
/**
 * Physical ceiling for a nuclide: element 118 is the heaviest confirmed, and no
 * known nuclide reaches A=300. The prebuilt grid currently carries ~2k cells
 * past both (A up to 592, Z up to 186) from mis-parsed ENSDF dataset IDs; left
 * in, they blow the fitted bounds out by 5× and turn the chart into a sliver.
 */
const MAX_Z = 118;
const MAX_A = 300;

const cellColor = (c: Cell, mode: ChartMode) =>
  mode === "age"
    ? AGE_COLORS[Math.min(c[3], 12)]
    : c[4] === 0
      ? XUNDL_NONE_COLOR
      : XUNDL_COLORS[xundlBucket(c[4])];

/**
 * The chart of nuclides as a canvas heatmap — N along x, Z along y, one cell
 * per known nuclide, colored either by years since the ENSDF evaluation cutoff
 * or by XUNDL sets compiled since it. Canvas instead of 10k SVG rects: one draw
 * call's worth of DOM, instant paint. Zoom/pan live in a single {k, tx, ty}
 * transform so hit-testing is just its inverse.
 */
/** Rough luminance test so labels stay legible on both ends of the ramps. */
function darkBg(hex: string): boolean {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return true;
  const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i], 16));
  return 0.299 * r + 0.587 * g + 0.114 * b < 150;
}

export function ChartOfNuclides({ grid, mode, onSelect, focus }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  /** null = sitting at home; any other value is a user pan/zoom off it. */
  const [pan, setPan] = useState<View | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number; c: Cell } | null>(null);

  const cells = useMemo(() => grid.filter((c) => c[0] <= MAX_Z && c[2] <= MAX_A), [grid]);

  const bounds = useMemo(() => {
    let minN = Infinity, maxN = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const cellOf = new Map<string, Cell>();
    for (const c of cells) {
      if (c[1] < minN) minN = c[1];
      if (c[1] > maxN) maxN = c[1];
      if (c[0] < minZ) minZ = c[0];
      if (c[0] > maxZ) maxZ = c[0];
      cellOf.set(`${c[0]},${c[1]}`, c);
    }
    return { minN, maxN, minZ, maxZ, cellOf };
  }, [cells]);

  /** The "home" transform: occupied bounds centered in the container. */
  const fit = useMemo(() => {
    const { minN, maxN, minZ, maxZ } = bounds;
    if (!size.w || !size.h || maxN < minN) return null;
    const cw = (maxN - minN + 1) * CELL;
    const ch = (maxZ - minZ + 1) * CELL;
    const k = Math.min((size.w * (1 - 2 * PAD)) / cw, (size.h * (1 - 2 * PAD)) / ch);
    return { k, tx: (size.w - cw * k) / 2 - minN * CELL * k, ty: (size.h - ch * k) / 2 };
  }, [bounds, size]);

  // Measure the container; the canvas fills it.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // New data → drop back to fit-to-data (state adjusted during render, not in
  // an effect, so the stale transform never paints).
  const [prevCells, setPrevCells] = useState(cells);
  if (prevCells !== cells) {
    setPrevCells(cells);
    setPan(null);
  }

  const view = pan ?? fit;

  // Search-driven zoom: frame the cells matching the focus (A band, Z row, or one cell).
  // State adjusted during render (same pattern as the data reset above), not in an effect.
  const focusKey = focus ? `${focus.a ?? ""}|${focus.z ?? ""}` : "";
  const [prevFocusKey, setPrevFocusKey] = useState(focusKey);
  if (prevFocusKey !== focusKey) {
    setPrevFocusKey(focusKey);
    if (!focus || (focus.a == null && focus.z == null)) setPan(null);
    else if (fit && size.w && size.h) {
      let minN = Infinity, maxN = -Infinity, minZ = Infinity, maxZ = -Infinity, hit = 0;
      for (const c of cells) {
        if (focus.a != null && c[2] !== focus.a) continue;
        if (focus.z != null && c[0] !== focus.z) continue;
        hit++;
        if (c[1] < minN) minN = c[1]; if (c[1] > maxN) maxN = c[1];
        if (c[0] < minZ) minZ = c[0]; if (c[0] > maxZ) maxZ = c[0];
      }
      if (hit) {
        const x0 = minN * CELL, x1 = (maxN + 1) * CELL;
        const y0 = (bounds.maxZ - maxZ) * CELL, y1 = (bounds.maxZ - minZ + 1) * CELL;
        const bw = Math.max(x1 - x0, CELL * 6), bh = Math.max(y1 - y0, CELL * 6);
        const k = Math.min(Math.max(Math.min((size.w * 0.7) / bw, (size.h * 0.7) / bh), fit.k), fit.k * 40);
        setPan({ k, tx: size.w / 2 - k * (x0 + x1) / 2, ty: size.h / 2 - k * (y0 + y1) / 2 });
      }
    }
  }

  // The search focus dims everything it does NOT match (the honeycomb trick:
  // relative brightness does the delineating, no borders needed).
  const hasFocus = !!(focus && (focus.a != null || focus.z != null));
  const inFocus = useCallback(
    (c: Cell) => !hasFocus || ((focus!.a == null || c[2] === focus!.a) && (focus!.z == null || c[0] === focus!.z)),
    [hasFocus, focus],
  );
  const hoverCell = hover?.c ?? null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !view || !size.w || !size.h) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(size.w * dpr), h = Math.round(size.h * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { k, tx, ty } = view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
    // Hairline gutter only once cells are big enough to read as a grid.
    const gap = CELL * k > 4 ? 0.5 / k : 0;
    const { maxZ } = bounds;
    for (const c of cells) {
      ctx.globalAlpha = inFocus(c) ? 1 : 0.22;
      ctx.fillStyle = cellColor(c, mode);
      ctx.fillRect(c[1] * CELL, (maxZ - c[0]) * CELL, CELL - gap, CELL - gap);
    }
    ctx.globalAlpha = 1;
    // Labels once cells are big enough: element symbol from ~26 px, "148Gd" from ~44 px
    // (NNDC's chart does the same as you zoom in). Drawn in screen pixels for crispness.
    const px = CELL * k;
    if (px >= 26) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const full = px >= 44;
      ctx.font = `${full ? Math.min(13, px * 0.28) : Math.min(12, px * 0.4)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      // only cells inside the viewport
      const n0 = Math.floor(-tx / px) - 1, n1 = Math.ceil((w / dpr - tx) / px) + 1;
      const r0 = Math.floor(-ty / px) - 1, r1 = Math.ceil((h / dpr - ty) / px) + 1;
      for (const c of cells) {
        const col = c[1], row = maxZ - c[0];
        if (col < n0 || col > n1 || row < r0 || row > r1) continue;
        const cx = tx + (col + 0.5) * px, cy = ty + (row + 0.5) * px;
        const bg = cellColor(c, mode);
        ctx.globalAlpha = inFocus(c) ? 1 : 0.22;
        ctx.fillStyle = darkBg(bg) ? "#fff" : "#111";
        const sym = ELEMENTS[c[0]] ?? String(c[0]);
        ctx.fillText(full ? `${c[2]}${sym}` : sym, cx, cy);
      }
      ctx.globalAlpha = 1;
    }
    // Hovered cell pops: redrawn enlarged on top with its full "148Gd" label,
    // whatever the zoom level (the sports honeycomb treatment).
    if (hoverCell) {
      const c = hoverCell;
      const col = c[1], row = maxZ - c[0];
      const cx = tx + (col + 0.5) * px, cy = ty + (row + 0.5) * px;
      const side = Math.max(px * 2.2, 46);
      const half = side / 2;
      const bg = cellColor(c, mode);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.shadowBlur = 12;
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.roundRect(cx - half, cy - half, side, side, 5);
      ctx.fill();
      ctx.restore();
      const ink = darkBg(bg) ? "#fff" : "#111";
      // "148Gd" with the mass as a raised superscript, like the table renders it.
      const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";
      const fs = Math.max(13, side * 0.3);
      const massTxt = String(c[2]);
      const symTxt = ELEMENTS[c[0]] ?? String(c[0]);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.font = `600 ${fs * 0.62}px ${mono}`;
      const wMass = ctx.measureText(massTxt).width;
      ctx.font = `600 ${fs}px ${mono}`;
      const wSym = ctx.measureText(symTxt).width;
      const left = cx - (wMass + wSym + 1) / 2;
      const baseY = cy + fs * 0.35;
      ctx.fillStyle = ink;
      ctx.fillText(symTxt, left + wMass + 1, baseY);
      ctx.font = `600 ${fs * 0.62}px ${mono}`;
      ctx.fillText(massTxt, left, baseY - fs * 0.42);
    }
  }, [cells, view, size, mode, bounds, inFocus, hoverCell]);

  /** Zoom about a point in container coordinates, clamped to [0.5×, 40×] of fit. */
  const zoomAt = useCallback(
    (factor: number, cx: number, cy: number) =>
      setPan((p) => {
        const v = p ?? fit;
        if (!v || !fit) return p;
        const k = Math.min(Math.max(v.k * factor, fit.k * 0.5), fit.k * 40);
        const s = k / v.k;
        return { k, tx: cx - (cx - v.tx) * s, ty: cy - (cy - v.ty) * s };
      }),
    [fit],
  );

  // React's synthetic wheel handler is passive — preventDefault needs a native one.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.004), e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const drag = useRef<{ x: number; y: number; moved: number } | null>(null);

  const locate = (clientX: number, clientY: number): Cell | null => {
    const el = canvasRef.current;
    if (!el || !view) return null;
    const rect = el.getBoundingClientRect();
    const n = Math.floor((clientX - rect.left - view.tx) / view.k / CELL);
    const z = bounds.maxZ - Math.floor((clientY - rect.top - view.ty) / view.k / CELL);
    return bounds.cellOf.get(`${z},${n}`) ?? null;
  };

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden rounded-md border">
      <canvas
        ref={canvasRef}
        className={`block h-full w-full touch-none ${grabbing ? "cursor-grabbing" : "cursor-grab"}`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, moved: 0 };
          setGrabbing(true);
          setHover(null);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) {
            const dx = e.clientX - d.x, dy = e.clientY - d.y;
            d.x = e.clientX; d.y = e.clientY;
            d.moved += Math.abs(dx) + Math.abs(dy);
            setPan((p) => {
              const v = p ?? fit;
              return v ? { ...v, tx: v.tx + dx, ty: v.ty + dy } : p;
            });
            return;
          }
          const c = locate(e.clientX, e.clientY);
          if (!c) return setHover(null);
          const rect = e.currentTarget.getBoundingClientRect();
          setHover({ x: e.clientX - rect.left, y: e.clientY - rect.top, c });
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          setGrabbing(false);
          if (!d || d.moved >= CLICK_SLOP) return;
          const c = locate(e.clientX, e.clientY);
          if (c) onSelect(c[2], c[0]);
        }}
        onPointerLeave={() => { drag.current = null; setGrabbing(false); setHover(null); }}
      />

      {/* Zoom controls — inside the canvas frame, top-right */}
      <div className="absolute right-2 top-2 z-10 flex flex-col gap-1">
        <Button variant="outline" size="icon" className="h-7 w-7" title="Zoom in"
          onClick={() => zoomAt(1.4, size.w / 2, size.h / 2)}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <Button variant="outline" size="icon" className="h-7 w-7" title="Zoom out"
          onClick={() => zoomAt(1 / 1.4, size.w / 2, size.h / 2)}>
          <Minus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border bg-card px-2.5 py-1.5 text-xs shadow-md"
          style={{ left: Math.min(hover.x + 20, Math.max(0, size.w - 190)), top: Math.max(hover.y - 58, 0) }}
        >
          <span className="font-semibold text-foreground">
            <sup>{hover.c[2]}</sup>
            {ELEMENTS[hover.c[0]] ?? `Z=${hover.c[0]}`}
          </span>
          <span className="text-muted-foreground"> · Z={hover.c[0]} N={hover.c[1]}</span>
          <span className="ml-1.5 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: cellColor(hover.c, mode) }} />
          <span className="text-muted-foreground">
            {" "}
            {mode === "age" ? ageLabel(hover.c[3]) : `${hover.c[4]} XUNDL`}
          </span>
        </div>
      )}
    </div>
  );
}
