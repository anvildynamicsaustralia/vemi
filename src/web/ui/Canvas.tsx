import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { CanvasPosition } from "@vemi/shared";
import { leftShare } from "../counts.js";
import type { LevelWords } from "../levelWords.js";
import {
  autoLayout, dragged, fitZoom, gesture, groundSize, positionOf, resolve, SIZE, stepZoom, wires, ZOOM_RESET,
  type Box, type LayoutFlow, type Point,
} from "../map/canvasLayout.js";
import { paths, saveCanvas } from "../api.js";
import type { Plate, PlateProject } from "../plates.js";
import { navigate, projectPage, venture } from "../router.js";
import { useResource } from "../state/resources.js";
import { useApp } from "./appContext.js";
import { Monogram } from "./Chrome.js";
import { Ring } from "./Rings.js";

/** How long a move waits for the next one before it is saved. */
const SAVE_AFTER_MS = 600;

interface Held {
  readonly key: string;
  readonly from: Point;
  readonly sx: number;
  readonly sy: number;
  dragging: boolean;
}

/**
 * The canvas: spaces as boxes, projects as dashed boxes, dashed wires from each to the one
 * it hangs from, on a dotted ground. A box can be dragged (a mouse, a pen or a finger) and
 * stays where it was put, for this account on every device. Tidy asks for the auto layout
 * again and saves that. A press that does not travel is a click, and opens the box.
 */
export function Canvas({ plates, words }: { readonly plates: readonly Plate[]; readonly words: LevelWords }) {
  const app = useApp();
  const saved = useResource<{ readonly positions: readonly CanvasPosition[] }>(paths.canvas);
  const [moved, setMoved] = useState<ReadonlyMap<string, Point>>(new Map());
  const [zoom, setZoom] = useState(ZOOM_RESET);
  const [liftedKey, setLifted] = useState<string | null>(null);
  const held = useRef<Held | null>(null);
  const pending = useRef(new Map<string, CanvasPosition>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const wrap = useRef<HTMLDivElement>(null);
  // A phone lays spaces down one column; a desk, side by side.
  const flow: LayoutFlow = app.phone ? "stacked" : "columns";
  const fitted = useRef(false);

  const ready = saved.data !== null;
  const boxes = useMemo<Box[]>(
    // A phone draws the stacked layout as it is: positions were set on a desk's wide ground and
    // would scatter the column. Nothing is dragged on a phone, so nothing it shows is saved.
    () => resolve(plates, flow === "stacked" ? [] : saved.data?.positions ?? [], flow).map((b) => {
      const at = moved.get(b.key);
      return at === undefined ? b : { ...b, ...at };
    }),
    [plates, saved.data, moved, flow],
  );
  const byKey = useMemo(() => new Map(boxes.map((b) => [b.key, b])), [boxes]);
  const names = useMemo(() => {
    const spaces = new Map<string, Plate>();
    const projects = new Map<string, PlateProject>();
    const walk = (p: Plate): void => {
      spaces.set(p.id, p);
      for (const r of p.projects) projects.set(r.id, r);
      p.inner.forEach(walk);
    };
    plates.forEach(walk);
    return { spaces, projects };
  }, [plates]);

  const { refetch } = saved;
  const flush = useCallback((): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const batch = [...pending.current.values()];
    pending.current.clear();
    if (batch.length === 0) return;
    void app.act(() => saveCanvas(batch)).then((ok) => { if (ok === "sent") refetch(); });
  }, [app, refetch]);

  const queue = useCallback((boxesToSave: readonly Box[]): void => {
    for (const b of boxesToSave) pending.current.set(b.key, positionOf(b));
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_AFTER_MS);
  }, [flush]);

  // Leaving the screen sends what is still waiting.
  useEffect(() => flush, [flush]);

  const press = (e: PointerEvent<HTMLElement>, box: Box): void => {
    if (e.button !== 0) return;
    // On a phone a box is pressed to open it; a swipe that starts on one scrolls the canvas.
    if (flow === "stacked") { held.current = { key: box.key, from: { x: box.x, y: box.y }, sx: e.clientX, sy: e.clientY, dragging: false }; return; }
    held.current = { key: box.key, from: { x: box.x, y: box.y }, sx: e.clientX, sy: e.clientY, dragging: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* a pointer that is already gone */ }
  };

  const move = (e: PointerEvent<HTMLElement>): void => {
    const h = held.current;
    if (h === null) return;
    const dx = e.clientX - h.sx;
    const dy = e.clientY - h.sy;
    if (!h.dragging) {
      if (gesture(dx, dy) === "click") return;
      // A phone's press that travels was a scroll, not a drag: it opens nothing either.
      if (flow === "stacked") { held.current = null; return; }
      h.dragging = true;
      setLifted(h.key);
    }
    const to = dragged(h.from, dx, dy, zoomRef.current);
    setMoved((m) => new Map(m).set(h.key, to));
  };

  const release = (e: PointerEvent<HTMLElement>, box: Box): void => {
    const h = held.current;
    held.current = null;
    if (h === null) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (h.dragging) {
      setLifted(null);
      const at = dragged(h.from, e.clientX - h.sx, e.clientY - h.sy, zoomRef.current);
      queue([{ ...box, ...at }]);
    } else open(box);
  };

  const open = (box: Box): void => {
    navigate(box.kind === "project" ? projectPage(box.ventureId, box.id) : venture(box.id));
  };

  const key = (e: KeyboardEvent<HTMLElement>, box: Box): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open(box);
    }
  };

  const tidy = (): void => {
    const fresh = autoLayout(plates, flow);
    setMoved(new Map(fresh.map((b) => [b.key, { x: b.x, y: b.y }])));
    queue(fresh);
    flush();
  };

  const ground = groundSize(boxes, flow);
  const lines = wires(boxes);

  // On a phone the canvas opens fitted to the screen's width, once, the first time the boxes
  // are known; after that the zoom is the person's.
  useEffect(() => {
    if (fitted.current || !ready || !app.phone || wrap.current === null) return;
    fitted.current = true;
    setZoom(fitZoom(ground.w, wrap.current.clientWidth));
  }, [ready, app.phone, ground.w]);
  // Fit shows every box: the zoom that takes what is drawn into the view both ways.
  const fit = (): void => {
    const el = wrap.current;
    if (el === null) return;
    const right = Math.max(0, ...boxes.map((b) => b.x + SIZE[b.kind].w)) + 40;
    const bottom = Math.max(0, ...boxes.map((b) => b.y + SIZE[b.kind].h)) + 40;
    setZoom(Math.min(fitZoom(right, el.clientWidth), fitZoom(bottom, el.clientHeight - 56)));
    el.scrollTo({ left: 0, top: 0 });
  };
  const tasks = words.tasks.toLowerCase();

  return (
    <div className="canvas-wrap" aria-busy={!ready} ref={wrap}>
      <div className="canvas-tools" role="group" aria-label="canvas">
        <button type="button" aria-label="Zoom out" onClick={() => setZoom((z) => stepZoom(z, -1))}>-</button>
        <button type="button" aria-label="Reset zoom" onClick={() => setZoom(ZOOM_RESET)}>{Math.round(zoom * 100)}%</button>
        <button type="button" aria-label="Zoom in" onClick={() => setZoom((z) => stepZoom(z, 1))}>+</button>
        <button type="button" onClick={fit}>Fit</button>
        {/* Tidy sets the account's layout, which is arranged on a desk. */}
        {flow === "columns" && <button type="button" onClick={tidy}>Tidy</button>}
      </div>
      <div className="canvas-scroll" style={{ width: ground.w * zoom, height: ground.h * zoom }}>
        <div className="canvas-ground" style={{ width: ground.w, height: ground.h, transform: `scale(${zoom})` }}>
          <svg className="canvas-wires" width={ground.w} height={ground.h} aria-hidden="true">
            {lines.map((w) => <path key={w.key} d={w.d} />)}
          </svg>
          {boxes.map((b) => {
            const props = {
              role: "button", tabIndex: 0,
              style: { left: b.x, top: b.y, width: SIZE[b.kind].w, height: SIZE[b.kind].h },
              onPointerDown: (e: PointerEvent<HTMLElement>) => press(e, byKey.get(b.key) ?? b),
              onPointerMove: move,
              onPointerUp: (e: PointerEvent<HTMLElement>) => release(e, byKey.get(b.key) ?? b),
              onPointerCancel: () => { held.current = null; setLifted(null); },
              onKeyDown: (e: KeyboardEvent<HTMLElement>) => key(e, b),
            } as const;
            const lifted = liftedKey === b.key ? " lifted" : "";
            if (b.kind === "venture") {
              const p = names.spaces.get(b.id);
              if (p === undefined) return null;
              return (
                <div key={b.key} {...props} className={`canvas-box space${lifted}`} aria-label={`${words.space} ${p.name}`}>
                  <Monogram letters={p.letters} icon={p.icon} />
                  <span className="canvas-name">
                    <b>{p.name}</b>
                    <small>{[p.stage, `${p.counts.left} left`].filter((s) => s !== null).join(" · ")}</small>
                  </span>
                </div>
              );
            }
            const r = names.projects.get(b.id);
            if (r === undefined) return null;
            return (
              <div key={b.key} {...props} className={`canvas-box project${lifted}`} aria-label={`${words.project} ${r.name}`}>
                {r.onToday && <i className="canvas-today-dot" role="img" aria-label="on today" />}
                <span className="canvas-project-name">{r.name}</span>
                <Ring size="card" value={r.left} share={leftShare(r)} label={`${r.left} ${tasks} left`} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
