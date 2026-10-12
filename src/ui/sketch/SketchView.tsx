import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch } from 'react';
import {
  MousePointer2, Hand, Slash, Spline, Square, Circle as CircleIcon, RotateCcw, MoveUpRight, Ruler, Type, PenLine,
  Link2, Anchor, Shapes, Maximize, Magnet, Trash2, Play, Pause, Check,
} from 'lucide-react';
import type { SketchRegion } from '../../model/types';
import {
  newShapeId, defaultSectionParams, shapePoints, translateShape, setField, isBound, SYMBOLS,
  type Shape, type Pt, type SketchView as View,
} from '../../model/sketch';
import { TEMPLATES, type SectionTemplate } from '../../engine/geometry';
import type { SketchResult } from '../../engine/sketchEval';
import type { RegionResult } from '../../engine/evaluator';
import type { EvalRequest, EvalResponse } from '../../engine/worker';
import type { Action } from '../store';
import { useSketchUI, type Tool } from './context';
import { ShapeSvg, PropsOverlay, SketchDefs, Grid, resolveShapes, toScreen, toWorld, fmtLen, type Viewport } from './render';

interface Props {
  region: SketchRegion;
  result?: RegionResult;
  editing: boolean;
  dispatch: Dispatch<Action>;
  onDone: (moveBelow?: boolean) => void;
  /** Region is selected on the page (shows the resize handle). */
  selected: boolean;
}

const TOOLS: { tool: Tool; icon: typeof Slash; label: string; key: string }[] = [
  { tool: 'select', icon: MousePointer2, label: 'Select / move (V)', key: 'v' },
  { tool: 'pan', icon: Hand, label: 'Pan (H, or middle mouse)', key: 'h' },
  { tool: 'line', icon: Slash, label: 'Line (L)', key: 'l' },
  { tool: 'poly', icon: Spline, label: 'Polyline / polygon (P) — click points, Enter to finish, click the first point to close', key: 'p' },
  { tool: 'rect', icon: Square, label: 'Rectangle (R)', key: 'r' },
  { tool: 'circle', icon: CircleIcon, label: 'Circle (C)', key: 'c' },
  { tool: 'arc', icon: RotateCcw, label: 'Arc (A) — centre, start, end', key: 'a' },
  { tool: 'arrow', icon: MoveUpRight, label: 'Arrow (W)', key: 'w' },
  { tool: 'dim', icon: Ruler, label: 'Dimension (D)', key: 'd' },
  { tool: 'text', icon: Type, label: 'Text (T)', key: 't' },
  { tool: 'path', icon: PenLine, label: 'Freehand (F)', key: 'f' },
  { tool: 'link', icon: Link2, label: 'Kinematic link (K)', key: 'k' },
  { tool: 'symbol', icon: Anchor, label: 'Support / joint / load symbol (S)', key: 's' },
  { tool: 'section', icon: Shapes, label: 'Cross-section (X)', key: 'x' },
];

type Draft = { tool: Tool; pts: Pt[]; cur: Pt; dragging: boolean; moved: boolean };
type Drag =
  | { mode: 'move'; ids: string[]; start: Pt; orig: Shape[] }
  | { mode: 'point'; id: string; path: string; orig: Shape }
  | { mode: 'pan'; sx: number; sy: number; view: View }
  | { mode: 'band'; start: Pt; cur: Pt };

const SNAP_PX = 9;

function bbox(shapes: Shape[]): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: Pt, r = 0) => {
    x0 = Math.min(x0, p.x - r); x1 = Math.max(x1, p.x + r);
    y0 = Math.min(y0, p.y - r); y1 = Math.max(y1, p.y + r);
  };
  for (const s of shapes) {
    for (const { p } of shapePoints(s)) add(p);
    if (s.type === 'circle' || s.type === 'arc') add(s.c, Math.abs(s.r));
    if (s.type === 'section') {
      const ext = Math.max(...Object.values(s.params).map(Number).filter(Number.isFinite), 1) / 2;
      add(s.p, ext);
    }
    if (s.type === 'symbol') add(s.p, s.size * (s.symbol === 'load' || s.symbol === 'spring' || s.symbol === 'damper' ? 4 : 2.6));
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

export function SketchView({ region, result, editing, dispatch, onDone, selected: regionSelected }: Props) {
  const { ui, setUi, getWorksheet, showProperties, separate } = useSketchUI();
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [band, setBand] = useState<{ a: Pt; b: Pt } | null>(null);
  const [hover, setHover] = useState<{ p: Pt; snapped: boolean } | null>(null);
  const [frame, setFrame] = useState<SketchResult | null>(null);
  const [playing, setPlaying] = useState(false);
  const drag = useRef<Drag | null>(null);
  const uid = `sk${region.id}`;
  // the view changes continuously while zooming/panning: keep it local and
  // commit it to the document once the gesture ends (no undo step, no recalculation storm)
  const [liveView, setLiveView] = useState<View | null>(null);
  const view = liveView ?? region.view;
  const viewRef = useRef(view);
  viewRef.current = view;
  const commitTimer = useRef<number | undefined>(undefined);
  const pendingView = useRef<View | null>(null);
  const vp: Viewport = { view, width: region.width, height: region.height };
  const res = (playing && frame ? frame : result) as SketchResult | undefined;
  const mine = ui.regionId === region.id;
  const selected = useMemo(() => new Set(mine ? ui.selected : []), [mine, ui.selected]);
  const tool = editing ? ui.tool : 'select';
  const shapes = useMemo(() => resolveShapes(region.shapes, res?.resolved), [region.shapes, res?.resolved]);

  const commit = useCallback((next: Shape[], coalesce?: string) => {
    dispatch({ type: 'update', id: region.id, patch: { shapes: next }, coalesce });
  }, [dispatch, region.id]);
  const flushView = useCallback(() => {
    window.clearTimeout(commitTimer.current);
    const v = pendingView.current;
    pendingView.current = null;
    if (v) dispatch({ type: 'update', id: region.id, patch: { view: v }, history: false });
    setLiveView(null);
  }, [dispatch, region.id]);
  const setView = (v: View, immediate = false) => {
    viewRef.current = v;
    pendingView.current = v;
    setLiveView(v);
    window.clearTimeout(commitTimer.current);
    if (immediate) flushView();
    else commitTimer.current = window.setTimeout(flushView, 400);
  };
  useEffect(() => () => {
    // unmounting mid-gesture: keep the last view
    if (pendingView.current) {
      window.clearTimeout(commitTimer.current);
      dispatch({ type: 'update', id: region.id, patch: { view: pendingView.current }, history: false });
    }
  }, [dispatch, region.id]);
  const select = (ids: string[]) => setUi({ regionId: region.id, selected: ids });

  // leaving edit mode drops the drawing in progress
  useEffect(() => {
    if (!editing) {
      setDraft(null);
      setBand(null);
    } else wrapRef.current?.focus({ preventScroll: true });
  }, [editing]);

  // ------------------------------------------------------------ coordinates & snapping

  const screenOf = (e: { clientX: number; clientY: number }) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const k = rect.width / region.width;
    return { x: (e.clientX - rect.left) / k, y: (e.clientY - rect.top) / k };
  };

  const snap = (e: { clientX: number; clientY: number; shiftKey?: boolean; altKey?: boolean }, anchor?: Pt, exclude?: string): { p: Pt; snapped: boolean } => {
    const s = screenOf(e);
    let w = toWorld(vp, s.x, s.y);
    if (!e.altKey) {
      let best: Pt | null = null;
      let bestD = SNAP_PX;
      for (const sh of shapes) {
        if (sh.id === exclude) continue;
        const pts = shapePoints(sh).map((q) => q.p);
        if (sh.type === 'line' || sh.type === 'link' || sh.type === 'arrow') pts.push({ x: (sh.a.x + sh.b.x) / 2, y: (sh.a.y + sh.b.y) / 2 });
        for (const p of pts) {
          const sp = toScreen(vp, p);
          const d = Math.hypot(sp.x - s.x, sp.y - s.y);
          if (d < bestD) { bestD = d; best = p; }
        }
      }
      if (best) return { p: best, snapped: true };
    }
    if (anchor && e.shiftKey) {
      // constrain to 15° steps from the anchor
      const dx = w.x - anchor.x, dy = w.y - anchor.y;
      const len = Math.hypot(dx, dy);
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
      w = { x: anchor.x + len * Math.cos(ang), y: anchor.y + len * Math.sin(ang) };
    }
    if (region.snap && region.grid > 0 && !e.altKey) {
      const g = region.grid;
      if (anchor && e.shiftKey) {
        const len = Math.round(Math.hypot(w.x - anchor.x, w.y - anchor.y) / g) * g;
        const ang = Math.atan2(w.y - anchor.y, w.x - anchor.x);
        w = { x: anchor.x + len * Math.cos(ang), y: anchor.y + len * Math.sin(ang) };
      } else w = { x: Math.round(w.x / g) * g, y: Math.round(w.y / g) * g };
    }
    return { p: { x: +w.x.toFixed(9), y: +w.y.toFixed(9) }, snapped: false };
  };

  // ------------------------------------------------------------ creating shapes

  const add = (s: Shape, keepTool = true) => {
    commit([...region.shapes, s]);
    select([s.id]);
    if (!keepTool) setUi({ regionId: region.id, selected: [s.id], tool: 'select' });
  };

  const finishDraft = (d: Draft, closePoly = false) => {
    const [a] = d.pts;
    const b = d.cur;
    const id = newShapeId();
    const tiny = Math.hypot(b.x - a.x, b.y - a.y) * view.zoom < 3;
    switch (d.tool) {
      case 'line': if (!tiny) add({ id, type: 'line', a, b }); break;
      case 'arrow': if (!tiny) add({ id, type: 'arrow', a, b }); break;
      case 'link': if (!tiny) add({ id, type: 'link', a, b }); break;
      case 'dim': if (!tiny) add({ id, type: 'dim', a, b, offset: 18 / view.zoom }); break;
      case 'rect':
        if (!tiny) add({ id, type: 'rect', a: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, b: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) }, role: 'solid' });
        break;
      case 'circle': if (!tiny) add({ id, type: 'circle', c: a, r: +Math.hypot(b.x - a.x, b.y - a.y).toFixed(9), role: 'solid' }); break;
      case 'poly': {
        const pts = d.pts;
        if (pts.length >= 2) add({ id, type: 'poly', pts, closed: closePoly && pts.length >= 3, role: closePoly && pts.length >= 3 ? 'solid' : undefined });
        break;
      }
      case 'path': if (d.pts.length >= 2) add({ id, type: 'path', pts: d.pts }); break;
      case 'arc': {
        const [c, p1] = d.pts;
        const r = Math.hypot(p1.x - c.x, p1.y - c.y);
        const deg = (p: Pt) => +((Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI).toFixed(6);
        if (r > 0) add({ id, type: 'arc', c, r: +r.toFixed(9), a0: deg(p1), a1: deg(b) });
        break;
      }
    }
    setDraft(null);
  };

  // ------------------------------------------------------------ pointer handling

  // touch: a second finger cancels what the first started (no gestures inside the drawing)
  const pointers = useRef(new Set<number>());

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!editing) return;
    e.stopPropagation();
    e.preventDefault();
    pointers.current.add(e.pointerId);
    if (pointers.current.size > 1) {
      drag.current = null;
      setDraft(null);
      setBand(null);
      return;
    }
    wrapRef.current?.focus({ preventScroll: true });
    svgRef.current?.setPointerCapture(e.pointerId);
    const target = e.target as Element;
    const handle = target.closest('[data-handle]') as HTMLElement | null;
    const shapeEl = target.closest('[data-shape-id]') as HTMLElement | null;
    if (e.button === 1 || tool === 'pan') {
      const s = screenOf(e);
      drag.current = { mode: 'pan', sx: s.x, sy: s.y, view };
      return;
    }
    if (tool === 'select') {
      if (handle) {
        const [id, path] = handle.dataset.handle!.split('|');
        const orig = region.shapes.find((q) => q.id === id);
        if (orig) drag.current = { mode: 'point', id, path, orig };
        return;
      }
      const id = shapeEl?.dataset.shapeId;
      if (id) {
        let ids = ui.selected.includes(id) && mine ? ui.selected : [id];
        if (e.shiftKey) ids = mine && ui.selected.includes(id) ? ui.selected.filter((x) => x !== id) : [...(mine ? ui.selected : []), id];
        select(ids);
        drag.current = { mode: 'move', ids, start: snap(e, undefined, id).p, orig: region.shapes };
        return;
      }
      const w = toWorld(vp, screenOf(e).x, screenOf(e).y);
      if (!e.shiftKey) select([]);
      drag.current = { mode: 'band', start: w, cur: w };
      return;
    }
    const { p } = snap(e, draft?.pts[draft.pts.length - 1]);
    switch (tool) {
      case 'text': {
        add({ id: newShapeId(), type: 'text', p, text: 'Text', size: +(14 / view.zoom).toPrecision(3) }, false);
        showProperties();
        return;
      }
      case 'symbol': {
        add({ id: newShapeId(), type: 'symbol', p, symbol: ui.symbol, rot: 0, size: +(16 / view.zoom).toPrecision(3) });
        return;
      }
      case 'section': {
        const sec: Shape = { id: newShapeId(), type: 'section', p, template: ui.template, params: defaultSectionParams(ui.template), rot: 0, role: 'solid' };
        add(sec);
        // a 300 mm beam at 1 px/mm would overflow the sketch: zoom out to show it
        const b = bbox([sec]);
        const tl = toWorld(vp, 0, 0), br = toWorld(vp, region.width, region.height);
        if (b && (b.x0 < tl.x || b.x1 > br.x || b.y0 < br.y || b.y1 > tl.y)) fitTo([...shapes, sec]);
        showProperties();
        return;
      }
      case 'poly': {
        if (!draft) setDraft({ tool, pts: [p], cur: p, dragging: false, moved: false });
        else {
          const first = toScreen(vp, draft.pts[0]);
          const s = screenOf(e);
          if (draft.pts.length >= 3 && Math.hypot(first.x - s.x, first.y - s.y) < SNAP_PX) finishDraft(draft, true);
          else setDraft({ ...draft, pts: [...draft.pts, p], cur: p });
        }
        return;
      }
      case 'arc': {
        if (!draft) setDraft({ tool, pts: [p], cur: p, dragging: false, moved: false });
        else if (draft.pts.length === 1) setDraft({ ...draft, pts: [...draft.pts, p], cur: p });
        else finishDraft({ ...draft, cur: p });
        return;
      }
      case 'path':
        setDraft({ tool, pts: [p], cur: p, dragging: true, moved: false });
        return;
      default:
        if (draft) finishDraft({ ...draft, cur: p });
        else setDraft({ tool, pts: [p], cur: p, dragging: true, moved: false });
    }
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!editing) return;
    if (pointers.current.size > 1) return;
    const d = drag.current;
    if (d?.mode === 'pan') {
      const s = screenOf(e);
      setView({ ...d.view, cx: d.view.cx - (s.x - d.sx) / d.view.zoom, cy: d.view.cy + (s.y - d.sy) / d.view.zoom });
      return;
    }
    if (d?.mode === 'band') {
      const w = toWorld(vp, screenOf(e).x, screenOf(e).y);
      drag.current = { ...d, cur: w };
      setBand({ a: d.start, b: w });
      return;
    }
    if (d?.mode === 'move') {
      const { p } = snap(e, undefined, d.ids.length === 1 ? d.ids[0] : undefined);
      const dx = p.x - d.start.x, dy = p.y - d.start.y;
      commit(d.orig.map((s) => (d.ids.includes(s.id) ? translateShape(s, dx, dy) : s)), `move:${region.id}`);
      return;
    }
    if (d?.mode === 'point') {
      const { p } = snap(e, undefined, d.id);
      let s = setField(d.orig, d.path, p);
      if (d.path === 'r' && (s.type === 'circle' || s.type === 'arc')) {
        s = setField(d.orig, 'r', +Math.hypot(p.x - s.c.x, p.y - s.c.y).toFixed(9));
      }
      commit(region.shapes.map((q) => (q.id === d.id ? s : q)), `point:${region.id}`);
      return;
    }
    const anchor = draft ? draft.pts[draft.pts.length - 1] : undefined;
    const sn = snap(e, draft?.tool === 'circle' ? undefined : anchor);
    setHover(sn);
    if (draft) {
      if (draft.tool === 'path' && draft.dragging) {
        const last = toScreen(vp, draft.pts[draft.pts.length - 1]);
        const s = screenOf(e);
        if (Math.hypot(last.x - s.x, last.y - s.y) >= 3) {
          const w = toWorld(vp, s.x, s.y);
          setDraft({ ...draft, pts: [...draft.pts, w], cur: w, moved: true });
        }
        return;
      }
      setDraft({ ...draft, cur: sn.p, moved: draft.moved || Math.hypot(sn.p.x - draft.pts[0].x, sn.p.y - draft.pts[0].y) > 0 });
    }
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!editing) return;
    const multi = pointers.current.size > 1;
    pointers.current.delete(e.pointerId);
    if (multi) return;
    const d = drag.current;
    drag.current = null;
    if (d?.mode === 'band') {
      setBand(null);
      const [x0, x1] = [Math.min(d.start.x, d.cur.x), Math.max(d.start.x, d.cur.x)];
      const [y0, y1] = [Math.min(d.start.y, d.cur.y), Math.max(d.start.y, d.cur.y)];
      if ((x1 - x0) * view.zoom < 3 && (y1 - y0) * view.zoom < 3) return;
      const inside = shapes.filter((s) => {
        const b = bbox([s]);
        return b && b.x0 >= x0 && b.x1 <= x1 && b.y0 >= y0 && b.y1 <= y1;
      });
      select([...new Set([...(e.shiftKey && mine ? ui.selected : []), ...inside.map((s) => s.id)])]);
      return;
    }
    if (d) return;
    if (draft?.dragging) {
      if (draft.tool === 'path') finishDraft(draft);
      else if (draft.moved) finishDraft({ ...draft, cur: snap(e, draft.tool === 'circle' ? undefined : draft.pts[0]).p });
      else setDraft({ ...draft, dragging: false }); // click-click mode
    }
  };

  const onDoubleClick = () => {
    if (draft?.tool === 'poly') {
      // the double click's second press already added a duplicate point
      const pts = draft.pts.filter((p, i) => i === 0 || p.x !== draft.pts[i - 1].x || p.y !== draft.pts[i - 1].y);
      finishDraft({ ...draft, pts });
    } else if (tool === 'select' && mine && ui.selected.length === 1) showProperties();
  };

  const fitTo = (list: Shape[]) => {
    const b = bbox(list);
    if (!b) return setView({ cx: 0, cy: 0, zoom: 1 }, true);
    const w = Math.max(b.x1 - b.x0, 1e-9), h = Math.max(b.y1 - b.y0, 1e-9);
    const zoom = Math.min((region.width - 48) / w, (region.height - 48) / h);
    setView({ cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, zoom: +zoom.toPrecision(4) }, true);
  };
  const fit = () => fitTo(shapes);

  /**
   * Drag the corner to resize the whole sketch: frame and drawing scale
   * together (aspect kept, like a picture), so nothing ever needs zooming.
   */
  const startResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const sheet = (e.currentTarget as HTMLElement).closest('.sheet') as HTMLElement | null;
    const pageZoom = sheet ? sheet.getBoundingClientRect().width / sheet.offsetWidth : 1;
    const start = { x: e.clientX, y: e.clientY, w: region.width, h: region.height, view: region.view };
    const move = (ev: PointerEvent) => {
      const kx = (start.w + (ev.clientX - start.x) / pageZoom) / start.w;
      const ky = (start.h + (ev.clientY - start.y) / pageZoom) / start.h;
      const k = Math.max(160 / start.w, 100 / start.h, Math.max(kx, ky));
      dispatch({
        type: 'update', id: region.id, coalesce: `resize:${region.id}`,
        patch: { width: Math.round(start.w * k), height: Math.round(start.h * k), view: { ...start.view, zoom: start.view.zoom * k } },
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      separate(`resize:${region.id}`); // a grown sketch pushes covered regions down, in the same undo step
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const deleteSelected = () => {
    if (!mine || !ui.selected.length) return;
    commit(region.shapes.filter((s) => !ui.selected.includes(s.id)));
    select([]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!editing) return;
    if ((e.target as HTMLElement).tagName === 'SELECT' || (e.target as HTMLElement).tagName === 'INPUT') return;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      handled();
      if (draft) setDraft(null);
      else if (mine && ui.selected.length) select([]);
      else if (ui.tool !== 'select') setUi({ tool: 'select' });
      else onDone(false);
      return;
    }
    if (e.key === 'Enter' && draft?.tool === 'poly') { handled(); finishDraft(draft); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && mine && ui.selected.length) { handled(); deleteSelected(); return; }
    if (mod && e.key.toLowerCase() === 'a') { handled(); select(region.shapes.map((s) => s.id)); return; }
    if (mod && e.key.toLowerCase() === 'd' && mine && ui.selected.length) {
      handled();
      const g = region.grid || 10 / view.zoom;
      const copies = region.shapes.filter((s) => ui.selected.includes(s.id)).map((s) => ({ ...translateShape(s, g, -g), id: newShapeId() }));
      commit([...region.shapes, ...copies]);
      select(copies.map((s) => s.id));
      return;
    }
    if (e.key.startsWith('Arrow') && mine && ui.selected.length) {
      handled();
      const g = (region.grid || 1) * (e.shiftKey ? 5 : 1);
      const dx = e.key === 'ArrowLeft' ? -g : e.key === 'ArrowRight' ? g : 0;
      const dy = e.key === 'ArrowDown' ? -g : e.key === 'ArrowUp' ? g : 0;
      commit(region.shapes.map((s) => (ui.selected.includes(s.id) ? translateShape(s, dx, dy) : s)), `nudge:${region.id}`);
      return;
    }
    if (!mod && !e.altKey) {
      const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
      if (t) { handled(); setUi({ regionId: region.id, tool: t.tool }); setDraft(null); }
    }
  };

  // ------------------------------------------------------------ animation

  const playRef = useRef(false);
  useEffect(() => {
    playRef.current = playing;
    const anim = region.animation;
    if (!playing || !anim) return;
    const worker = new Worker(new URL('../../engine/worker.ts', import.meta.url), { type: 'module' });
    let id = 0;
    const t0 = performance.now();
    const request = () => {
      const s = (performance.now() - t0) / 1000 / Math.max(0.2, anim.seconds);
      const t = 1 - Math.abs((s % 2) - 1); // ping-pong 0 → 1 → 0
      const req: EvalRequest = {
        id: ++id,
        ws: getWorksheet(),
        overrides: { [anim.variable]: `(${anim.from}) + ${t.toFixed(5)} * ((${anim.to}) - (${anim.from}))` },
        only: [region.id],
      };
      worker.postMessage(req);
    };
    worker.onmessage = (ev: MessageEvent<EvalResponse>) => {
      const r = ev.data.results.find(([rid]) => rid === region.id)?.[1] as SketchResult | undefined;
      if (r) setFrame(r);
      if (playRef.current) requestAnimationFrame(request);
    };
    request();
    return () => {
      worker.terminate();
      setFrame(null);
    };
  }, [playing, region.animation, region.id, getWorksheet]);

  // ------------------------------------------------------------ render

  const handles = editing && tool === 'select' && mine
    ? shapes.filter((s) => ui.selected.includes(s.id)).flatMap((s) => {
      const pts = shapePoints(s).map(({ path, p }) => ({ id: s.id, path, p, bound: isBound(s, path) }));
      if (s.type === 'circle' || s.type === 'arc') pts.push({ id: s.id, path: 'r', p: { x: s.c.x + Math.abs(s.r), y: s.c.y }, bound: isBound(s, 'r') });
      return pts;
    })
    : [];

  const draftShape: Shape | null = draft
    ? (() => {
      const [a] = draft.pts;
      const b = draft.cur;
      switch (draft.tool) {
        case 'line': return { id: '_d', type: 'line', a, b };
        case 'arrow': return { id: '_d', type: 'arrow', a, b };
        case 'link': return { id: '_d', type: 'link', a, b };
        case 'dim': return { id: '_d', type: 'dim', a, b, offset: 18 / view.zoom };
        case 'rect': return { id: '_d', type: 'rect', a, b };
        case 'circle': return { id: '_d', type: 'circle', c: a, r: Math.hypot(b.x - a.x, b.y - a.y) };
        case 'poly': return { id: '_d', type: 'poly', pts: [...draft.pts, b], closed: false };
        case 'path': return { id: '_d', type: 'path', pts: draft.pts };
        case 'arc': {
          if (draft.pts.length === 1) return { id: '_d', type: 'line', a, b };
          const p1 = draft.pts[1];
          const deg = (p: Pt) => (Math.atan2(p.y - a.y, p.x - a.x) * 180) / Math.PI;
          return { id: '_d', type: 'arc', c: a, r: Math.hypot(p1.x - a.x, p1.y - a.y), a0: deg(p1), a1: deg(b) };
        }
        default: return null;
      }
    })()
    : null;

  const draftLen = draft && ['line', 'arrow', 'link', 'dim', 'poly'].includes(draft.tool)
    ? Math.hypot(draft.cur.x - draft.pts[draft.pts.length - 1].x, draft.cur.y - draft.pts[draft.pts.length - 1].y)
    : draft?.tool === 'circle' ? Math.hypot(draft.cur.x - draft.pts[0].x, draft.cur.y - draft.pts[0].y) : null;

  const errorList = res?.errors ? Object.values(res.errors) : [];
  const cursor = !editing ? undefined : tool === 'pan' ? 'grab' : tool === 'select' ? 'default' : 'crosshair';

  return (
    <div
      ref={wrapRef}
      className={`sketch-region${editing ? ' editing' : ''}`}
      style={{ width: region.width }}
      tabIndex={editing ? 0 : -1}
      onKeyDown={onKeyDown}
    >
      {editing && (
        <div className="sk-toolbar" role="toolbar" aria-label="Drawing tools" onPointerDown={(e) => e.stopPropagation()}>
          {TOOLS.map(({ tool: t, icon: Icon, label }) => (
            <button key={t} className={`icon-btn${ui.tool === t ? ' on' : ''}`} title={label} aria-label={label} aria-pressed={ui.tool === t}
              onClick={() => { setUi({ regionId: region.id, tool: t }); setDraft(null); wrapRef.current?.focus({ preventScroll: true }); }}>
              <Icon size={16} />
            </button>
          ))}
          {ui.tool === 'symbol' && (
            <select value={ui.symbol} onChange={(e) => setUi({ symbol: e.target.value as typeof ui.symbol })} aria-label="Symbol">
              {SYMBOLS.map((s) => <option key={s.kind} value={s.kind}>{s.label}</option>)}
            </select>
          )}
          {ui.tool === 'section' && (
            <select value={ui.template} onChange={(e) => setUi({ template: e.target.value as SectionTemplate })} aria-label="Section">
              {(Object.keys(TEMPLATES) as SectionTemplate[]).map((t) => <option key={t} value={t}>{TEMPLATES[t].label}</option>)}
            </select>
          )}
          <span className="sk-sep" />
          <button className={`icon-btn${region.snap ? ' on' : ''}`} title="Snap to grid (hold Alt to disable)" aria-label="Snap to grid"
            onClick={() => dispatch({ type: 'update', id: region.id, patch: { snap: !region.snap } })}><Magnet size={16} /></button>
          <button className="icon-btn" title="Fit the drawing into the frame" aria-label="Fit drawing into frame" onClick={fit}><Maximize size={16} /></button>
          <button className="icon-btn" title="Delete selected (Del)" aria-label="Delete selected shapes" disabled={!mine || !ui.selected.length} onClick={deleteSelected}><Trash2 size={16} /></button>
          <button className="icon-btn" title="Done (Esc)" aria-label="Done" onClick={() => onDone(false)}><Check size={16} /></button>
        </div>
      )}
      <svg
        ref={svgRef}
        width={region.width}
        height={region.height}
        className="sk-svg"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={onDoubleClick}
        role="img"
        aria-label={region.name ? `Sketch ${region.name}` : 'Sketch'}
      >
        <SketchDefs uid={uid} />
        {editing && <Grid vp={vp} step={region.grid} />}
        {/* solids first so holes and lines draw on top */}
        {[...shapes].sort((a, b) => Number(a.role === 'hole') - Number(b.role === 'hole')).map((s) => (
          <ShapeSvg key={s.id} s={s} vp={vp} opt={{ uid, selected: mine ? selected : undefined, errors: res?.errors }} />
        ))}
        {region.showProps && res?.props && <PropsOverlay props={res.props} vp={vp} unit={region.unit} />}
        {draftShape && <g className="sk-draft"><ShapeSvg s={draftShape} vp={vp} opt={{ uid }} /></g>}
        {draft && draft.tool === 'poly' && draft.pts.map((p, i) => {
          const q = toScreen(vp, p);
          return <circle key={i} cx={q.x} cy={q.y} r={i === 0 ? 5 : 2.5} className="sk-vertex" />;
        })}
        {handles.map((h) => {
          const q = toScreen(vp, h.p);
          return h.bound ? (
            <rect key={h.id + h.path} x={q.x - 4} y={q.y - 4} width={8} height={8} className="sk-handle bound"><title>Bound to an expression</title></rect>
          ) : (
            <circle key={h.id + h.path} data-handle={`${h.id}|${h.path}`} cx={q.x} cy={q.y} r={5} className="sk-handle" />
          );
        })}
        {editing && hover && (
          <circle cx={toScreen(vp, hover.p).x} cy={toScreen(vp, hover.p).y} r={hover.snapped ? 6 : 2.5} className={`sk-cursor${hover.snapped ? ' snapped' : ''}`} pointerEvents="none" />
        )}
        {band && (() => {
          const a = toScreen(vp, band.a), b = toScreen(vp, band.b);
          return <rect x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} className="sk-band" />;
        })()}
      </svg>
      {editing && (
        <div className="sk-status">
          {hover ? `${fmtLen(hover.p.x)}, ${fmtLen(hover.p.y)} ${region.unit}` : `grid ${region.grid} ${region.unit}`}
          {draftLen !== null && ` · length ${fmtLen(draftLen)} ${region.unit}`}
          {draft?.tool === 'poly' && ' · Enter to finish, click the first point to close'}
        </div>
      )}
      {(editing || regionSelected) && (
        <div className="resize-handle sk-resize" onPointerDown={startResize} title="Drag to resize the sketch (the drawing scales with it)" aria-label="Resize sketch" />
      )}
      {region.animation && (
        <button className="sk-play" onClick={(e) => { e.stopPropagation(); setPlaying((p) => !p); }} onPointerDown={(e) => e.stopPropagation()}
          title={playing ? 'Pause' : `Animate ${region.animation.variable}`} aria-label={playing ? 'Pause animation' : 'Play animation'}>
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
      )}
      {(res?.error || errorList.length > 0) && (
        <div className="region-error" role="alert">{res?.error ?? errorList[0]}</div>
      )}
    </div>
  );
}
