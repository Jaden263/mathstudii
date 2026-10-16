// The 2-D sketch editor of a CAD part. On the page it draws a read-only preview; in the
// CAD window it is the full editor: zoom about the cursor, adaptive grid, snapping with
// markers and alignment guides, typed lengths while drawing, and every sketch tool.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type JSX } from 'react';
import type { CadRegion } from '../../model/types';
import type { CadResult } from '../../cad/evaluate';
import { cadId, entityPoints, isDimension, nextDimName, removeFromSketch, sketchSig, type CadConstraint, type CadEntity, type CadSketch, type CadView as View, type ConstraintType } from '../../cad/model';
import { solveSketch, measure } from '../../cad/solver';
import { findProfiles, segPolyline, type Vec2 } from '../../cad/profile';
import {
  applyConstraint as constrainSketch, dimensionFromSelection, entityRadius, hitTest, localValues, segsOf, solveLocal, withSolution, segDist,
  type Geo,
} from '../../cad/edit';
import { breakCurve, chamfer, connectedChain, ellipse, ellipticalArc, extend, offset, pattern, spline, text } from '../../cad/sketchTools';
import { controlSpline, interpolate } from '../../cad/curves';
import {
  addLine, centerArc, centerRectangle, circle, cloneSketch, fillet, mirror, pointFor, polygon, rectangle, slot, threePointArc, trim,
  type Ref, type ToolResult,
} from '../../cad/tools';
import type { Action } from '../store';
import { useSketchUI, type CadTool } from '../sketch/context';
import { ProfileFill, dimDrawing, entityPath, fmtNum, glyphs, toS, toW, type Vp } from './cadRender';

export interface CanvasStatus {
  cursor?: Vec2;
  hint: string;
  msg: string;
}

export interface CadCanvasHandle {
  fit(): void;
  applyConstraint(type: ConstraintType): void;
  /** A rectangular pattern of the selection (counts and spacings from the ribbon). */
  rectPattern(): void;
  deleteSelected(): void;
  toggleConstruction(): void;
  selectAll(): void;
  focus(): void;
}

interface Props {
  region: CadRegion;
  result?: CadResult;
  dispatch: (a: Action) => void;
  width: number;
  height: number;
  /** Editing allowed (the CAD window); otherwise a preview. */
  interactive: boolean;
  onStatus?: (s: CanvasStatus) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  /** Outlines of existing bodies in the sketch plane, drawn as reference (sketch coordinates). */
  reference?: Vec2[][];
}

const SNAP_PX = 9;

type SnapKind = 'point' | 'center' | 'mid' | 'on' | 'grid' | 'free';
interface Snap {
  ref: Ref;
  kind: SnapKind;
  guides: { x?: number; y?: number };
}

type Draft = { tool: CadTool; refs: Ref[]; cur: Snap };

type Drag =
  | { mode: 'points'; grab: Map<string, Vec2>; base: CadSketch; moved: boolean }
  | { mode: 'label'; cid: string; sx: number; sy: number; orig: { x: number; y: number }; moved: boolean }
  | { mode: 'pan'; sx: number; sy: number; view: View; button: number; moved: boolean }
  | { mode: 'band'; a: Vec2; b: Vec2 };

/** Typed values while drawing (length, width …). */
interface Typed {
  fields: string[];
  active: number;
}

const TYPED_FIELDS: Partial<Record<CadTool, string[]>> = {
  line: ['Length', 'Angle °'],
  rect: ['Width', 'Height'],
  crect: ['Width', 'Height'],
  circle: ['Diameter'],
};

const HINTS: Record<CadTool, string[]> = {
  select: ['Click to select, Shift adds · drag geometry (constraints hold) · drag right: window select, left: crossing select · double-click a dimension to edit it'],
  line: ['Line: click the start point', 'Click the next point · type a length (Tab: angle) · click the first point, right-click or Esc to finish'],
  rect: ['Rectangle: click a corner', 'Click the opposite corner · or type width (Tab: height)'],
  crect: ['Centre rectangle: click the centre', 'Click a corner · or type width (Tab: height)'],
  circle: ['Circle: click the centre', 'Click to set the radius · or type the diameter'],
  arc: ['Arc: click the centre', 'Click the start point', 'Click the end (counter-clockwise from the start)'],
  arc3: ['3-point arc: click the start', 'Click the end', 'Click a point on the arc'],
  polygon: ['Polygon: click the centre', 'Click a vertex (sides in the ribbon)'],
  slot: ['Slot: click the first centre', 'Click the second centre', 'Click to set the width'],
  point: ['Point: click to place'],
  dim: ['Dimension: pick a line, circle, arc, two points, a point and a line, or two lines — then click where it goes'],
  fillet: ['Fillet: click a corner where two lines meet (radius in the ribbon)'],
  trim: ['Trim: click the piece to remove (between crossings)'],
  mirror: ['Mirror: click the line to mirror the selection about'],
  measure: ['Measure: pick one or two items'],
  pan: ['Pan: drag (or use the middle mouse button anywhere)'],
  spline: ['Spline: click the first fit point', 'Click the next fit point · click the first point to close · Enter, double-click or right-click to finish'],
  cspline: ['Control-point spline: click the first pole', 'Click the next pole · click the first to close · Enter, double-click or right-click to finish'],
  ellipse: ['Ellipse: click the centre', 'Click the end of the major axis', 'Click to set the minor axis'],
  earc: ['Elliptical arc: click the centre', 'Click the end of the major axis', 'Click the start (it sets the minor axis)', 'Click the end (counter-clockwise from the start)'],
  text: ['Text: click where its baseline starts (the text and its size are in the ribbon)'],
  offset: ['Offset: click a curve (its whole chain, or the selected curves)', 'Click the side to offset to (distance in the ribbon) · Esc to pick again'],
  chamfer: ['Chamfer: click a corner where two lines meet (distance in the ribbon)'],
  extend: ['Extend: click a line or arc near the end to lengthen'],
  break: ['Break: click a curve where to split it'],
  cpattern: ['Circular pattern: select the geometry first, then click the centre point (count and angle in the ribbon)'],
};

function geoOf(sk: CadSketch): Geo {
  return {
    sk,
    P: new Map(sk.points.map((p) => [p.id, { x: p.x, y: p.y }])),
    R: new Map(sk.entities.filter((e) => e.type === 'circle').map((e) => [e.id, Math.abs((e as { r: number }).r)])),
  };
}

export function sketchBox(g: Geo): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: Vec2, r = 0) => {
    x0 = Math.min(x0, p.x - r); x1 = Math.max(x1, p.x + r);
    y0 = Math.min(y0, p.y - r); y1 = Math.max(y1, p.y + r);
  };
  for (const p of g.P.values()) add(p);
  for (const e of g.sk.entities) if (e.type === 'circle') add(g.P.get(e.c)!, entityRadius(g, e));
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

/** Grid step for a zoom: 1, 2 or 5 × 10ⁿ sketch units, at least `px` pixels apart. */
export function gridStep(zoom: number, px = 14): { minor: number; major: number } {
  const raw = px / zoom;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  const mant = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  const minor = mant * p;
  return { minor, major: minor * (mant === 2 ? 5 : 10) };
}

function CadGrid({ vp }: { vp: Vp }) {
  const { minor, major } = gridStep(vp.view.zoom);
  const tl = toW(vp, 0, 0), br = toW(vp, vp.width, vp.height);
  const lines = (step: number, skipMajor: boolean) => {
    let d = '';
    for (let x = Math.ceil(tl.x / step) * step; x <= br.x; x += step) {
      if (skipMajor && Math.abs(x / major - Math.round(x / major)) < 1e-9) continue;
      const s = toS(vp, { x, y: 0 }).x;
      d += `M${s.toFixed(1)} 0V${vp.height}`;
    }
    for (let y = Math.ceil(br.y / step) * step; y <= tl.y; y += step) {
      if (skipMajor && Math.abs(y / major - Math.round(y / major)) < 1e-9) continue;
      const s = toS(vp, { x: 0, y }).y;
      d += `M0 ${s.toFixed(1)}H${vp.width}`;
    }
    return d;
  };
  const o = toS(vp, { x: 0, y: 0 });
  return (
    <g pointerEvents="none">
      <path d={lines(minor, true)} className="cadw-grid-minor" />
      <path d={lines(major, false)} className="cadw-grid-major" />
      <line x1={0} y1={o.y} x2={vp.width} y2={o.y} className="cadw-axis-x" />
      <line x1={o.x} y1={0} x2={o.x} y2={vp.height} className="cadw-axis-y" />
    </g>
  );
}

function SnapMarker({ snap, vp }: { snap: Snap; vp: Vp }) {
  const s = toS(vp, snap.ref.p);
  const g = snap.guides;
  const guide = [
    g.x !== undefined ? <line key="gx" x1={toS(vp, { x: g.x, y: 0 }).x} y1={0} x2={toS(vp, { x: g.x, y: 0 }).x} y2={vp.height} className="cadw-guide" /> : null,
    g.y !== undefined ? <line key="gy" x1={0} y1={toS(vp, { x: 0, y: g.y }).y} x2={vp.width} y2={toS(vp, { x: 0, y: g.y }).y} className="cadw-guide" /> : null,
  ];
  let mark: JSX.Element | null = null;
  switch (snap.kind) {
    case 'point': mark = <rect x={s.x - 5} y={s.y - 5} width={10} height={10} className="cadw-snap" />; break;
    case 'center': mark = <circle cx={s.x} cy={s.y} r={6} className="cadw-snap" />; break;
    case 'mid': mark = <path d={`M${s.x} ${s.y - 6}L${s.x + 6} ${s.y + 4}H${s.x - 6}Z`} className="cadw-snap" />; break;
    case 'on': mark = <path d={`M${s.x - 5} ${s.y - 5}L${s.x + 5} ${s.y + 5}M${s.x + 5} ${s.y - 5}L${s.x - 5} ${s.y + 5}`} className="cadw-snap" />; break;
    case 'grid': mark = <path d={`M${s.x - 4} ${s.y}H${s.x + 4}M${s.x} ${s.y - 4}V${s.y + 4}`} className="cadw-snap" />; break;
    default: break;
  }
  return <g pointerEvents="none">{guide}{mark}</g>;
}

const fmtV = (v: number) => String(+v.toPrecision(6));

export const CadCanvas = forwardRef<CadCanvasHandle, Props>(function CadCanvas({ region, result, dispatch, width, height, interactive, onStatus, onUndo, onRedo, reference }, handle) {
  const { ui, setUi } = useSketchUI();
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [hoverSnap, setHoverSnap] = useState<Snap | null>(null);
  const [live, setLive] = useState<CadSketch | null>(null);
  const [liveView, setLiveView] = useState<View | null>(null);
  const [liveOffset, setLiveOffset] = useState<{ cid: string; offset: { x: number; y: number } } | null>(null);
  const [band, setBand] = useState<{ a: Vec2; b: Vec2 } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [picks, setPicks] = useState<string[]>([]);
  const [mirrorSet, setMirrorSet] = useState<string[]>([]);
  /** The chain an offset was picked on (its side is the next click). */
  const [offsetChain, setOffsetChain] = useState<string[] | null>(null);
  const [editDim, setEditDim] = useState<{ cid: string; text: string } | null>(null);
  const [typed, setTyped] = useState<Typed | null>(null);
  const [msg, setMsg] = useState('');
  const [space, setSpace] = useState(false);
  const drag = useRef<Drag | null>(null);
  const raf = useRef(0);
  const pendingDrag = useRef<Map<string, Vec2> | null>(null);
  const wheelTimer = useRef<number | undefined>(undefined);
  const cursorW = useRef<Vec2 | null>(null);

  const res = result;
  const sig = useMemo(() => sketchSig(region.sketch), [region.sketch]);
  const fresh = !!res && res.sig === sig;
  // the page preview always frames the part; the CAD window keeps its own zoom and pan
  const autoView = useMemo(() => (interactive ? null : framing(region, width, height)), [interactive, region, width, height]);
  const stored = interactive ? region.viewW ?? region.view : autoView ?? region.view;
  const view = liveView ?? stored;
  const vp: Vp = { view, width, height };
  const mine = ui.regionId === region.id;
  const sel = useMemo(() => new Set(mine && interactive ? ui.selected : []), [mine, interactive, ui.selected]);
  const tool: CadTool = interactive && mine ? ui.cadTool : 'select';
  const construction = ui.cadConstruction || undefined;

  const shown = useMemo(() => {
    if (live) return live;
    let sk = fresh && res ? withSolution(region.sketch, res.points, res.radii) : region.sketch;
    if (liveOffset) sk = { ...sk, constraints: sk.constraints.map((c) => (c.id === liveOffset.cid ? { ...c, offset: liveOffset.offset } : c)) };
    return sk;
  }, [live, fresh, res, region.sketch, liveOffset]);
  const geo = useMemo(() => geoOf(shown), [shown]);
  const profiles = useMemo(() => findProfiles(shown), [shown]);

  // the page preview keeps the stored geometry in step with what the worksheet solved
  useEffect(() => {
    if (interactive || !fresh || !res) return;
    const moved = region.sketch.points.some((p) => {
      const q = res.points[p.id];
      return q && Math.hypot(q[0] - p.x, q[1] - p.y) > 1e-9 * Math.max(1, Math.abs(p.x), Math.abs(p.y));
    }) || region.sketch.entities.some((e) => e.type === 'circle' && res.radii[e.id] !== undefined && Math.abs(res.radii[e.id] - e.r) > 1e-9 * Math.max(1, e.r));
    if (moved) dispatch({ type: 'update', id: region.id, patch: { sketch: withSolution(region.sketch, res.points, res.radii) }, history: false });
  }, [interactive, fresh, res, region.sketch, region.id, dispatch]);

  useEffect(() => {
    if (!msg) return;
    const t = window.setTimeout(() => setMsg(''), 5000);
    return () => window.clearTimeout(t);
  }, [msg]);

  // a new tool starts clean
  useEffect(() => {
    setDraft(null);
    setPicks([]);
    setTyped(null);
    if (ui.cadTool === 'mirror' || ui.cadTool === 'cpattern') setMirrorSet(mine ? ui.selected.filter((id) => shown.entities.some((e) => e.id === id)) : []);
    setOffsetChain(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.cadTool]);

  const stage = draft ? Math.min(draft.refs.length, HINTS[tool].length - 1) : 0;
  const hint = HINTS[tool][stage] ?? HINTS[tool][0];
  useEffect(() => {
    onStatus?.({ cursor: cursorW.current ?? undefined, hint, msg });
  }, [hint, msg, onStatus]);

  const select = (ids: string[]) => setUi({ regionId: region.id, selected: ids });

  const commit = useCallback((next: CadSketch, coalesce?: string) => {
    dispatch({ type: 'update', id: region.id, patch: { sketch: solveLocal(next, region.unit, res?.values) }, coalesce });
  }, [dispatch, region.id, region.unit, res?.values]);

  const applyTool = (r: ToolResult | string, keepSelection = false) => {
    if (typeof r === 'string') {
      setMsg(r);
      return false;
    }
    commit(r.sketch);
    if (!keepSelection) select(r.ids);
    if (r.notes.length) setMsg(r.notes.join(' · '));
    return true;
  };

  // ------------------------------------------------------------ view

  const setView = (v: View, immediate = false) => {
    setLiveView(v);
    window.clearTimeout(wheelTimer.current);
    const done = () => {
      setLiveView(null);
      dispatch({ type: 'update', id: region.id, patch: interactive ? { viewW: v } : { view: v }, history: false });
    };
    if (immediate) done();
    else wheelTimer.current = window.setTimeout(done, 250);
  };

  const fit = useCallback(() => {
    let b = sketchBox(geo);
    for (const loop of reference ?? []) for (const p of loop) {
      b ??= { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      b.x0 = Math.min(b.x0, p.x); b.x1 = Math.max(b.x1, p.x);
      b.y0 = Math.min(b.y0, p.y); b.y1 = Math.max(b.y1, p.y);
    }
    if (!b) {
      setView({ cx: 50, cy: 30, zoom: Math.min(width / 140, height / 90) }, true);
      return;
    }
    for (const c of shown.constraints) {
      if (!isDimension(c.type)) continue;
      const dd = dimDrawing(c, geo, vp, 0);
      if (!dd) continue;
      const w = toW(vp, dd.at.x, dd.at.y);
      b.x0 = Math.min(b.x0, w.x); b.x1 = Math.max(b.x1, w.x);
      b.y0 = Math.min(b.y0, w.y); b.y1 = Math.max(b.y1, w.y);
    }
    const w = Math.max(b.x1 - b.x0, 1e-6), h = Math.max(b.y1 - b.y0, 1e-6);
    const zoom = Math.min((width - 90) / w, (height - 90) / h);
    setView({ cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : view.zoom }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo, shown, width, height, view.zoom, reference]);

  // the CAD window frames the part when it opens
  const framed = useRef(false);
  useEffect(() => {
    if (!interactive || framed.current) return;
    framed.current = true;
    if (!region.viewW) fit();
  }, [interactive, region.viewW, fit]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el || !interactive) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const v = liveViewRef.current ?? storedRef.current;
      const k = Math.exp(-(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) * (e.ctrlKey ? 0.01 : 0.0015));
      const zoom = Math.min(1e5, Math.max(1e-4, v.zoom * k));
      const w = toW({ view: v, width, height }, sx, sy);
      setView({ zoom, cx: w.x - (sx - width / 2) / zoom, cy: w.y - (height / 2 - sy) / zoom });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive, width, height]);
  const liveViewRef = useRef(liveView);
  liveViewRef.current = liveView;
  const storedRef = useRef(stored);
  storedRef.current = stored;

  // ------------------------------------------------------------ snapping

  const screenOf = (e: { clientX: number; clientY: number }): Vec2 => {
    const rect = svgRef.current!.getBoundingClientRect();
    const k = rect.width / width;
    return { x: (e.clientX - rect.left) / k, y: (e.clientY - rect.top) / k };
  };

  const snapAt = (s: Vec2, opts: { alt?: boolean; from?: Vec2; skip?: Set<string> } = {}): Snap => {
    const w = toW(vp, s.x, s.y);
    const tol = SNAP_PX / view.zoom;
    if (opts.alt) return { ref: { p: w }, kind: 'free', guides: {} };
    const pick = hitTest(geo, w, tol, opts.skip);
    if (pick?.kind === 'point') {
      const isCentre = shown.entities.some((e) => (e.type === 'circle' || e.type === 'arc' || e.type === 'ellipse') && e.c === pick.id);
      return { ref: { id: pick.id, p: geo.P.get(pick.id)! }, kind: isCentre ? 'center' : 'point', guides: {} };
    }
    // midpoints of lines
    for (const e of shown.entities) {
      if (e.type !== 'line') continue;
      const a = geo.P.get(e.p1)!, b = geo.P.get(e.p2)!;
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (Math.hypot(m.x - w.x, m.y - w.y) < tol) return { ref: { mid: e.id, p: m }, kind: 'mid', guides: {} };
    }
    if (pick?.kind === 'entity') {
      const ent = shown.entities.find((x) => x.id === pick.id)!;
      if (ent.type === 'line') {
        const a = geo.P.get(ent.p1)!, b = geo.P.get(ent.p2)!;
        const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((w.x - a.x) * dx + (w.y - a.y) * dy) / L2));
        return { ref: { on: ent.id, p: { x: a.x + t * dx, y: a.y + t * dy } }, kind: 'on', guides: {} };
      }
      if (ent.type === 'circle' || ent.type === 'arc') {
        const c = geo.P.get(ent.c)!, r = entityRadius(geo, ent);
        const L = Math.hypot(w.x - c.x, w.y - c.y) || 1;
        return { ref: { on: ent.id, p: { x: c.x + ((w.x - c.x) * r) / L, y: c.y + ((w.y - c.y) * r) / L } }, kind: 'on', guides: {} };
      }
      if (ent.type === 'ellipse' || ent.type === 'spline') {
        // the nearest point of the curve (its polyline: the solver puts the point on the curve itself)
        let best = w, bd = Infinity;
        for (const sg of segsOf(geo, ent)) {
          const pts = segPolyline(sg, Math.PI / 360);
          for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1], dx = pts[i].x - a.x, dy = pts[i].y - a.y, L2 = dx * dx + dy * dy || 1;
            const t = Math.max(0, Math.min(1, ((w.x - a.x) * dx + (w.y - a.y) * dy) / L2));
            const q = { x: a.x + t * dx, y: a.y + t * dy }, dd = Math.hypot(q.x - w.x, q.y - w.y);
            if (dd < bd) [bd, best] = [dd, q];
          }
        }
        return { ref: { on: ent.id, p: best }, kind: 'on', guides: {} };
      }
    }
    // alignment with existing points (and the point being drawn from)
    let p = { ...w };
    const guides: Snap['guides'] = {};
    let bx = tol, by = tol;
    const cands = [...geo.P.values(), ...(opts.from ? [opts.from] : [])];
    for (const q of cands) {
      if (Math.abs(q.x - w.x) < bx) { bx = Math.abs(q.x - w.x); p.x = q.x; guides.x = q.x; }
      if (Math.abs(q.y - w.y) < by) { by = Math.abs(q.y - w.y); p.y = q.y; guides.y = q.y; }
    }
    if (ui.cadGridSnap) {
      const g = gridStep(view.zoom).minor;
      if (guides.x === undefined) p.x = Math.round(p.x / g) * g;
      if (guides.y === undefined) p.y = Math.round(p.y / g) * g;
      p = { x: +p.x.toFixed(10), y: +p.y.toFixed(10) };
      return { ref: { p }, kind: 'grid', guides };
    }
    return { ref: { p }, kind: 'free', guides };
  };

  // ------------------------------------------------------------ drawing

  const lastRef = (d: Draft) => d.refs[d.refs.length - 1];

  const finishWithDims = (r: ToolResult | string, dims: Omit<CadConstraint, 'id' | 'name'>[]) => {
    if (typeof r === 'string') {
      setMsg(r);
      return;
    }
    const sk = r.sketch;
    for (const d of dims) sk.constraints.push({ ...d, id: cadId('k'), name: nextDimName(sk) });
    commit(sk);
    select(r.ids);
  };

  /** A spline from the points clicked so far (closed: back to the first). */
  const finishSpline = (d: Draft, closed = false) => {
    setDraft(null);
    if (d.refs.length < 2) return;
    applyTool(spline(shown, closed ? [...d.refs, d.refs[0]] : d.refs, { mode: d.tool === 'cspline' ? 'control' : 'fit', closed, construction }));
  };

  const clickDraw = (snap: Snap) => {
    const ref = { ...snap.ref };
    if (!draft) {
      if (tool === 'point') {
        if (ref.id) return;
        const sk = cloneSketch(shown);
        const p = pointFor(sk, ref);
        sk.entities.push({ id: cadId('e'), type: 'point', p, construction });
        commit(sk);
        return;
      }
      if (tool === 'text') {
        applyTool(text(shown, ref, ui.cadText, ui.cadTextSize));
        return;
      }
      setDraft({ tool, refs: [ref], cur: snap });
      return;
    }
    const d = draft;
    const first = d.refs[0];
    const tiny = (a: Ref, b: Ref) => Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y) * view.zoom < 3;
    switch (d.tool) {
      case 'spline':
      case 'cspline': {
        // the first point again closes it
        if (ref.id && ref.id === first.id && d.refs.length >= 3) {
          finishSpline(d, true);
          return;
        }
        if (tiny(lastRef(d), ref)) return;
        setDraft({ ...d, refs: [...d.refs, ref], cur: snap });
        return;
      }
      case 'ellipse':
      case 'earc': {
        if (d.refs.length < (d.tool === 'ellipse' ? 2 : 3)) {
          if (tiny(lastRef(d), ref)) return;
          setDraft({ ...d, refs: [...d.refs, ref], cur: snap });
          return;
        }
        if (d.tool === 'ellipse') applyTool(ellipse(shown, first, d.refs[1], minorOf(first.p, d.refs[1].p, ref.p), { construction }));
        else applyTool(ellipticalArc(shown, first, d.refs[1], d.refs[2].p, ref.p, { construction }));
        break;
      }
      case 'line': {
        const last = lastRef(d);
        if (tiny(last, ref) && !(ref.id && ref.id !== last.id)) return;
        const sk = cloneSketch(shown);
        addLine(sk, last, ref, { construction });
        commit(sk);
        if (ref.id && ref.id === first.id && d.refs.length > 1) setDraft(null);
        else setDraft({ ...d, refs: [...d.refs.slice(0, -1), last, ref], cur: snap });
        setTyped(null);
        return;
      }
      case 'rect':
        if (tiny(first, ref)) return;
        applyTool(rectangle(shown, first, ref, { construction }));
        break;
      case 'crect':
        if (tiny(first, ref)) return;
        applyTool(centerRectangle(shown, first, ref.p, { construction }));
        break;
      case 'circle':
        if (tiny(first, ref)) return;
        applyTool(circle(shown, first, Math.hypot(ref.p.x - first.p.x, ref.p.y - first.p.y), ref.id ? ref : undefined, { construction }));
        break;
      case 'polygon':
        if (tiny(first, ref)) return;
        applyTool(polygon(shown, first, ref.p, ui.cadSides, { construction }));
        break;
      case 'arc':
        if (d.refs.length === 1) {
          if (tiny(first, ref)) return;
          setDraft({ ...d, refs: [first, ref], cur: snap });
          return;
        }
        applyTool(centerArc(shown, first, d.refs[1], ref, { construction }));
        break;
      case 'arc3':
        if (d.refs.length === 1) {
          if (tiny(first, ref)) return;
          setDraft({ ...d, refs: [first, ref], cur: snap });
          return;
        }
        applyTool(threePointArc(shown, first, d.refs[1], ref.p, { construction }));
        break;
      case 'slot': {
        if (d.refs.length === 1) {
          if (tiny(first, ref)) return;
          setDraft({ ...d, refs: [first, ref], cur: snap });
          return;
        }
        const b = d.refs[1].p;
        const ux = b.x - first.p.x, uy = b.y - first.p.y, L = Math.hypot(ux, uy) || 1;
        const half = Math.abs(((ref.p.x - first.p.x) * -uy + (ref.p.y - first.p.y) * ux) / L);
        applyTool(slot(shown, first, b, 2 * half, { construction }));
        break;
      }
      default:
        break;
    }
    setDraft(null);
    setTyped(null);
  };

  /** Enter in the typed-value box: exact sizes become driving dimensions. */
  const commitTyped = () => {
    if (!draft || !typed) return;
    const vals = typed.fields.map((f) => (f.trim() === '' ? NaN : Number(f)));
    const first = draft.refs[0];
    const cur = draft.cur.ref.p;
    if (draft.tool === 'line') {
      const last = lastRef(draft);
      const L = vals[0];
      if (!(L > 0)) return setMsg('Type a positive length');
      const ang = Number.isFinite(vals[1]) ? (vals[1] * Math.PI) / 180 : Math.atan2(cur.y - last.p.y, cur.x - last.p.x);
      const end: Ref = { p: { x: last.p.x + L * Math.cos(ang), y: last.p.y + L * Math.sin(ang) } };
      const sk = cloneSketch(shown);
      const id = addLine(sk, last, end, { construction });
      const dims: CadConstraint[] = [{ id: cadId('k'), type: 'length', refs: [id], value: fmtV(L), name: nextDimName(sk) }];
      const deg = Number.isFinite(vals[1]) ? ((vals[1] % 180) + 180) % 180 : NaN;
      if (Number.isFinite(deg) && deg !== 0 && deg !== 90) {
        sk.constraints.push(dims[0]);
        dims.push({ id: cadId('k'), type: 'angle', refs: [id], value: fmtV(deg), name: nextDimName(sk) });
        sk.constraints.push(dims[1]);
      } else sk.constraints.push(...dims);
      commit(sk);
      setDraft({ ...draft, refs: [...draft.refs, end], cur: draft.cur });
      setTyped(null);
      return;
    }
    if (draft.tool === 'rect' || draft.tool === 'crect') {
      const sx = Math.sign(cur.x - first.p.x) || 1, sy = Math.sign(cur.y - first.p.y) || 1;
      const W = Number.isFinite(vals[0]) ? vals[0] : Math.abs(cur.x - first.p.x) * (draft.tool === 'crect' ? 2 : 1);
      const H = Number.isFinite(vals[1]) ? vals[1] : Math.abs(cur.y - first.p.y) * (draft.tool === 'crect' ? 2 : 1);
      if (!(W > 0 && H > 0)) return setMsg('Type a positive width and height');
      const r = draft.tool === 'rect'
        ? rectangle(shown, first, { p: { x: first.p.x + sx * W, y: first.p.y + sy * H } }, { construction })
        : centerRectangle(shown, first, { x: first.p.x + W / 2, y: first.p.y + H / 2 }, { construction });
      if (typeof r !== 'string') {
        const dims: Omit<CadConstraint, 'id' | 'name'>[] = [];
        if (Number.isFinite(vals[0])) dims.push({ type: 'length', refs: [r.ids[0]], value: fmtV(W) });
        if (Number.isFinite(vals[1])) dims.push({ type: 'length', refs: [r.ids[1]], value: fmtV(H) });
        finishWithDims(r, dims);
      } else setMsg(r);
    } else if (draft.tool === 'circle') {
      const D = vals[0];
      if (!(D > 0)) return setMsg('Type a positive diameter');
      const r = circle(shown, first, D / 2, undefined, { construction });
      if (typeof r !== 'string') finishWithDims(r, [{ type: 'diameter', refs: [r.ids[0]], value: fmtV(D) }]);
    }
    setDraft(null);
    setTyped(null);
  };

  // ------------------------------------------------------------ constraints, dimensions, edits

  const applyConstraint = (type: ConstraintType) => {
    const out = constrainSketch(type, geo, mine ? ui.selected : []);
    if (typeof out === 'string') return setMsg(out);
    commit(out);
  };

  const rectPattern = () => {
    const ids = (mine ? ui.selected : []).filter((id) => shown.entities.some((e) => e.id === id));
    applyTool(pattern(shown, geo.P, ids, { kind: 'rect', count: ui.cadCount, spacing: ui.cadSpacing, count2: ui.cadCount2, spacing2: ui.cadSpacing2 }));
  };

  const createDimension = (ids: string[], at?: Vec2) => {
    const c = dimensionFromSelection(geo, ids, ui.cadDimKind);
    if (typeof c === 'string') return setMsg(c);
    if (at) {
      const dd = dimDrawing(c, geo, vp, 0);
      if (dd && c.type !== 'angle') c.offset = { x: (at.x - dd.at.x) / view.zoom, y: -(at.y - dd.at.y) / view.zoom };
    }
    commit({ ...shown, constraints: [...shown.constraints, c] });
    setPicks([]);
    select([c.id]);
    setEditDim({ cid: c.id, text: c.value ?? '' });
  };

  const commitDim = (cid: string, text: string) => {
    const t = text.trim();
    setEditDim(null);
    if (t) commit({ ...shown, constraints: shown.constraints.map((c) => (c.id === cid ? { ...c, value: t } : c)) });
    wrapRef.current?.focus({ preventScroll: true });
  };

  const deleteSelected = () => {
    if (!mine || !ui.selected.length) return;
    commit(removeFromSketch(shown, new Set(ui.selected)));
    select([]);
  };

  const toggleConstruction = () => {
    const ids = new Set(mine ? ui.selected : []);
    if (!shown.entities.some((e) => ids.has(e.id))) {
      setUi({ cadConstruction: !ui.cadConstruction });
      return;
    }
    commit({ ...shown, entities: shown.entities.map((e) => (ids.has(e.id) ? { ...e, construction: !e.construction || undefined } : e)) });
  };

  const measurePicks = (ids: string[]): string => {
    const ents = new Map(shown.entities.map((e) => [e.id, e]));
    const u = region.unit;
    const pts = ids.filter((id) => geo.P.has(id)).map((id) => geo.P.get(id)!);
    const es = ids.map((id) => ents.get(id)).filter(Boolean) as CadEntity[];
    if (pts.length === 2) {
      const [a, b] = pts;
      return `Distance ${fmtNum(Math.hypot(b.x - a.x, b.y - a.y))} ${u} · Δx ${fmtNum(b.x - a.x)} · Δy ${fmtNum(b.y - a.y)}`;
    }
    if (pts.length === 1 && es.length === 1 && es[0].type === 'line') {
      const l = es[0];
      return `Distance to line ${fmtNum(segDistInf(pts[0], geo.P.get(l.p1)!, geo.P.get(l.p2)!))} ${u}`;
    }
    if (es.length === 2 && es.every((e) => e.type === 'line')) {
      const [l1, l2] = es as Extract<CadEntity, { type: 'line' }>[];
      const d = (l: typeof l1) => { const a = geo.P.get(l.p1)!, b = geo.P.get(l.p2)!; return Math.atan2(b.y - a.y, b.x - a.x); };
      let ang = Math.abs(((d(l2) - d(l1)) * 180) / Math.PI) % 180;
      if (ang > 90) ang = 180 - ang;
      return `Angle ${fmtNum(ang)}° (and ${fmtNum(180 - ang)}°)`;
    }
    if (es.length === 1) {
      const e = es[0];
      if (e.type === 'line') {
        const a = geo.P.get(e.p1)!, b = geo.P.get(e.p2)!;
        return `Length ${fmtNum(Math.hypot(b.x - a.x, b.y - a.y))} ${u} · angle ${fmtNum((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI)}°`;
      }
      if (e.type === 'circle' || e.type === 'arc') {
        const r = entityRadius(geo, e);
        const c = geo.P.get(e.c)!;
        return `R ${fmtNum(r)} · Ø ${fmtNum(2 * r)} ${u} · centre (${fmtNum(c.x)}, ${fmtNum(c.y)})`;
      }
    }
    if (pts.length === 1) return `Point (${fmtNum(pts[0].x)}, ${fmtNum(pts[0].y)}) ${u}`;
    return 'Pick one or two items';
  };

  useImperativeHandle(handle, () => ({
    fit,
    applyConstraint,
    rectPattern,
    deleteSelected,
    toggleConstruction,
    selectAll: () => select(shown.entities.map((e) => e.id)),
    focus: () => wrapRef.current?.focus({ preventScroll: true }),
  }));

  // ------------------------------------------------------------ pointer

  const runDrag = () => {
    raf.current = 0;
    const d = drag.current;
    const target = pendingDrag.current;
    if (!d || d.mode !== 'points' || !target) return;
    try {
      const base = live ?? d.base;
      const sol = solveSketch(base, { values: localValues(base, region.unit, res?.values), drag: target, fast: true });
      setLive(withSolution(base, sol.points, sol.radii));
    } catch {
      /* keep the last good frame */
    }
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!interactive) return;
    e.stopPropagation();
    e.preventDefault();
    wrapRef.current?.focus({ preventScroll: true });
    const s = screenOf(e);
    if (e.button === 1 || e.button === 2 || tool === 'pan' || (space && e.button === 0)) {
      drag.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, view, button: e.button, moved: false };
      svgRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const w = toW(vp, s.x, s.y);
    const tol = SNAP_PX / view.zoom;
    switch (tool) {
      case 'select': {
        const pick = hitTest(geo, w, tol);
        if (!pick) {
          if (!e.shiftKey) select([]);
          drag.current = { mode: 'band', a: s, b: s };
          svgRef.current?.setPointerCapture(e.pointerId);
          return;
        }
        const ids = e.shiftKey ? (sel.has(pick.id) ? [...sel].filter((x) => x !== pick.id) : [...sel, pick.id]) : sel.has(pick.id) ? [...sel] : [pick.id];
        select(ids);
        let pts: string[] = [];
        if (pick.kind === 'point') pts = [pick.id];
        else {
          const ent = shown.entities.find((x) => x.id === pick.id);
          if (ent) pts = entityPoints(ent);
        }
        const grab = new Map(pts.map((id) => [id, { x: geo.P.get(id)!.x - w.x, y: geo.P.get(id)!.y - w.y }]));
        drag.current = { mode: 'points', grab, base: shown, moved: false };
        svgRef.current?.setPointerCapture(e.pointerId);
        return;
      }
      case 'dim': {
        const pick = hitTest(geo, w, tol);
        if (pick) {
          const next = picks.includes(pick.id) ? picks.filter((x) => x !== pick.id) : picks.length >= 2 ? [pick.id] : [...picks, pick.id];
          setPicks(next);
          const ent = shown.entities.find((x) => x.id === pick.id);
          if (next.length === 1 && (ent?.type === 'circle' || ent?.type === 'arc')) createDimension(next);
          return;
        }
        if (picks.length) createDimension(picks, s);
        return;
      }
      case 'measure': {
        const pick = hitTest(geo, w, tol);
        if (!pick) {
          setPicks([]);
          return;
        }
        const next = picks.length >= 2 ? [pick.id] : [...picks, pick.id];
        setPicks(next);
        setMsg(measurePicks(next));
        return;
      }
      case 'fillet': {
        const pick = hitTest(geo, w, tol * 1.5);
        if (pick?.kind !== 'point') return setMsg('Click the corner point');
        applyTool(fillet(shown, geo.P, pick.id, ui.cadFillet));
        return;
      }
      case 'trim': {
        const pick = hitTest(geo, w, tol, new Set(geo.P.keys()));
        if (pick?.kind !== 'entity') return;
        applyTool(trim(shown, geo.P, geo.R, pick.id, w), true);
        return;
      }
      case 'mirror': {
        const pick = hitTest(geo, w, tol, new Set(geo.P.keys()));
        if (pick?.kind !== 'entity') return;
        if (!mirrorSet.length) return setMsg('Select the geometry first (Select tool), then choose Mirror and click the mirror line');
        if (applyTool(mirror(shown, geo.P, mirrorSet, pick.id))) setUi({ cadTool: 'select' });
        return;
      }
      case 'offset': {
        if (!offsetChain) {
          const pick = hitTest(geo, w, tol, new Set(geo.P.keys()));
          if (pick?.kind !== 'entity') return;
          const selCurves = (mine ? ui.selected : []).filter((id) => shown.entities.some((x) => x.id === id && x.type !== 'point'));
          const chain = selCurves.includes(pick.id) ? selCurves : connectedChain(shown, pick.id);
          setOffsetChain(chain);
          setPicks(chain);
          return;
        }
        applyTool(offset(shown, geo.P, geo.R, offsetChain, ui.cadOffset, w));
        setOffsetChain(null);
        setPicks([]);
        return;
      }
      case 'chamfer': {
        const pick = hitTest(geo, w, tol * 1.5);
        if (pick?.kind !== 'point') return setMsg('Click the corner point');
        applyTool(chamfer(shown, geo.P, pick.id, ui.cadChamfer));
        return;
      }
      case 'extend':
      case 'break': {
        const pick = hitTest(geo, w, tol, new Set(geo.P.keys()));
        if (pick?.kind !== 'entity') return;
        applyTool(tool === 'extend' ? extend(shown, geo.P, geo.R, pick.id, w) : breakCurve(shown, geo.P, geo.R, pick.id, w, tol), true);
        return;
      }
      case 'cpattern': {
        const pick = hitTest(geo, w, tol * 1.5);
        if (pick?.kind !== 'point') return setMsg('Click the centre point of the pattern');
        if (!mirrorSet.length) return setMsg('Select the geometry first (Select tool), then choose Circular pattern and click its centre');
        if (applyTool(pattern(shown, geo.P, mirrorSet, { kind: 'circ', count: ui.cadCount, spacing: 0, about: pick.id, angle: ui.cadAngle }))) setUi({ cadTool: 'select' });
        return;
      }
      default:
        clickDraw(snapAt(s, { alt: e.altKey, from: draft ? lastRef(draft).p : undefined }));
    }
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const s = screenOf(e);
    const w = toW(vp, s.x, s.y);
    cursorW.current = w;
    onStatus?.({ cursor: w, hint, msg });
    if (!interactive) return;
    const d = drag.current;
    if (d?.mode === 'pan') {
      const k = svgRef.current!.getBoundingClientRect().width / width;
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true;
      setLiveView({ ...d.view, cx: d.view.cx - (e.clientX - d.sx) / k / view.zoom, cy: d.view.cy + (e.clientY - d.sy) / k / view.zoom });
      return;
    }
    if (d?.mode === 'band') {
      d.b = s;
      setBand({ a: d.a, b: s });
      return;
    }
    if (d?.mode === 'points') {
      d.moved = true;
      pendingDrag.current = new Map([...d.grab].map(([id, o]) => [id, { x: w.x + o.x, y: w.y + o.y }]));
      if (!raf.current) raf.current = requestAnimationFrame(runDrag);
      return;
    }
    if (d?.mode === 'label') {
      const c = shown.constraints.find((x) => x.id === d.cid);
      d.moved = true;
      const dx = (e.clientX - d.sx) / view.zoom, dy = -(e.clientY - d.sy) / view.zoom;
      setLiveOffset({ cid: d.cid, offset: c?.type === 'angle' ? { x: d.orig.x + (dx + dy) / 2, y: 0 } : { x: d.orig.x + dx, y: d.orig.y + dy } });
      return;
    }
    if (['select', 'dim', 'measure', 'trim', 'mirror', 'fillet', 'offset', 'chamfer', 'extend', 'break', 'cpattern'].includes(tool)) {
      const skip = ['trim', 'mirror', 'offset', 'extend', 'break'].includes(tool) ? new Set(geo.P.keys()) : undefined;
      setHover(hitTest(geo, w, SNAP_PX / view.zoom, skip)?.id ?? null);
      setHoverSnap(null);
      return;
    }
    const snap = snapAt(s, { alt: e.altKey, from: draft ? lastRef(draft).p : undefined });
    setHoverSnap(snap);
    setHover(snap.ref.id ?? snap.ref.on ?? null);
    if (draft) setDraft({ ...draft, cur: snap });
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.mode === 'pan') {
      if (d.moved) setView(liveView ?? view, true);
      else if (d.button === 2) {
        // a right click (no drag) ends the line chain or the spline, or cancels
        if (draft && (draft.tool === 'spline' || draft.tool === 'cspline')) finishSpline(draft);
        else setDraft(null);
        setTyped(null);
      }
      return;
    }
    if (d.mode === 'band') {
      setBand(null);
      if (Math.abs(d.a.x - d.b.x) < 3 && Math.abs(d.a.y - d.b.y) < 3) return;
      // left to right: inside the window; right to left: anything crossing it
      const crossing = d.b.x < d.a.x;
      const a = toW(vp, Math.min(d.a.x, d.b.x), Math.max(d.a.y, d.b.y)), b = toW(vp, Math.max(d.a.x, d.b.x), Math.min(d.a.y, d.b.y));
      const inside = (p: Vec2) => p.x >= a.x && p.x <= b.x && p.y >= a.y && p.y <= b.y;
      const box = [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }];
      const hits = (e2: CadEntity) => {
        const P = (id: string) => geo.P.get(id)!;
        if (e2.type === 'point') return inside(P(e2.p));
        if (e2.type === 'line') {
          const ends = [P(e2.p1), P(e2.p2)];
          if (!crossing) return ends.every(inside);
          if (ends.some(inside)) return true;
          return box.some((q, i) => segmentsCross(ends[0], ends[1], q, box[(i + 1) % 4]));
        }
        if (e2.type === 'circle' || e2.type === 'arc') {
          const c = P(e2.c), r = entityRadius(geo, e2);
          const full = inside({ x: c.x - r, y: c.y - r }) && inside({ x: c.x + r, y: c.y + r });
          if (!crossing) return full;
          const nx = Math.max(a.x, Math.min(c.x, b.x)), ny = Math.max(a.y, Math.min(c.y, b.y));
          return Math.hypot(nx - c.x, ny - c.y) <= r;
        }
        // splines, ellipses, text: by the points along their curve
        const pts = segsOf(geo, e2).flatMap((sg) => segPolyline(sg, Math.PI / 30));
        if (!crossing) return pts.length > 0 && pts.every(inside);
        return pts.some(inside) || pts.some((q, i) => i > 0 && box.some((r0, k) => segmentsCross(pts[i - 1], q, r0, box[(k + 1) % 4])));
      };
      const ents = shown.entities.filter(hits).map((x) => x.id);
      select([...new Set([...(e.shiftKey ? [...sel] : []), ...ents])]);
      return;
    }
    if (d.mode === 'points') {
      if (raf.current) {
        cancelAnimationFrame(raf.current);
        runDrag();
      }
      if (d.moved && live) commit(live, `cad-drag:${region.id}`);
      setLive(null);
      return;
    }
    if (d.mode === 'label') {
      if (d.moved && liveOffset) commit({ ...shown, constraints: shown.constraints.map((c) => (c.id === d.cid ? { ...c, offset: liveOffset.offset } : c)) }, `cad-label:${d.cid}`);
      setLiveOffset(null);
    }
  };

  const lastLabel = useRef<{ cid: string; t: number } | null>(null);
  const onLabelDown = (e: React.PointerEvent, c: CadConstraint) => {
    if (!interactive || e.button !== 0) return;
    e.stopPropagation();
    // a second press on the same label edits it (pointer capture would swallow the dblclick)
    const now = performance.now();
    if (lastLabel.current?.cid === c.id && now - lastLabel.current.t < 450) {
      lastLabel.current = null;
      e.preventDefault();
      setEditDim({ cid: c.id, text: c.value ?? '' });
      return;
    }
    lastLabel.current = { cid: c.id, t: now };
    select(e.shiftKey ? [...sel, c.id] : [c.id]);
    drag.current = { mode: 'label', cid: c.id, sx: e.clientX, sy: e.clientY, orig: c.offset ?? { x: 0, y: 0 }, moved: false };
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  // ------------------------------------------------------------ keyboard

  const TOOL_KEYS: Record<string, CadTool> = {
    s: 'select', l: 'line', r: 'rect', R: 'crect', c: 'circle', a: 'arc', A: 'arc3', g: 'polygon', o: 'slot', p: 'point',
    d: 'dim', i: 'fillet', t: 'trim', m: 'mirror', q: 'measure',
    n: 'spline', N: 'cspline', E: 'ellipse', O: 'offset', I: 'chamfer', T: 'extend', b: 'break', P: 'text',
  };
  const CONSTRAINT_KEYS: Record<string, ConstraintType> = { h: 'horizontal', v: 'vertical', e: 'equal', k: 'fix' };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!interactive) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { handled(); if (e.shiftKey) onRedo?.(); else onUndo?.(); return; }
    if (mod && e.key.toLowerCase() === 'y') { handled(); onRedo?.(); return; }
    if (mod && e.key.toLowerCase() === 'a') { handled(); select(shown.entities.map((x) => x.id)); return; }
    if (mod || e.altKey) return;
    if (e.key === ' ') { handled(); setSpace(true); return; }
    // typed values while drawing
    if (draft && TYPED_FIELDS[draft.tool]) {
      const fields = TYPED_FIELDS[draft.tool]!;
      if (/^[0-9.\-]$/.test(e.key) || (typed && (e.key === 'Backspace' || e.key === 'Tab' || e.key === 'Enter'))) {
        handled();
        const t = typed ?? { fields: fields.map(() => ''), active: 0 };
        if (e.key === 'Enter') return commitTyped();
        if (e.key === 'Tab') return setTyped({ ...t, active: (t.active + (e.shiftKey ? fields.length - 1 : 1)) % fields.length });
        const f = [...t.fields];
        f[t.active] = e.key === 'Backspace' ? f[t.active].slice(0, -1) : f[t.active] + e.key;
        setTyped({ ...t, fields: f });
        return;
      }
    }
    if (e.key === 'Escape') {
      handled();
      if (typed) setTyped(null);
      else if (draft) setDraft(null);
      else if (offsetChain) { setOffsetChain(null); setPicks([]); }
      else if (picks.length) setPicks([]);
      else if (mine && ui.selected.length) select([]);
      else if (ui.cadTool !== 'select') setUi({ cadTool: 'select' });
      return;
    }
    if (e.key === 'Enter' && draft?.tool === 'line') { handled(); setDraft(null); return; }
    if (e.key === 'Enter' && draft && (draft.tool === 'spline' || draft.tool === 'cspline')) { handled(); finishSpline(draft); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { handled(); deleteSelected(); return; }
    const hasSel = mine && ui.selected.length > 0;
    if (hasSel && tool === 'select' && CONSTRAINT_KEYS[e.key]) { handled(); applyConstraint(CONSTRAINT_KEYS[e.key]); return; }
    if (e.key === 'x' || e.key === 'X') { handled(); toggleConstruction(); return; }
    if (e.key === 'f' || e.key === 'F') { handled(); fit(); return; }
    const t = TOOL_KEYS[e.key];
    if (t) { handled(); setUi({ regionId: region.id, cadTool: t }); }
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === ' ') setSpace(false);
  };

  // ------------------------------------------------------------ render

  const z = view.zoom;
  const determined = new Set(fresh && res ? res.determined : []);
  const detR = new Set(fresh && res ? res.determinedRadii : []);
  const conflicting = new Set(res?.conflicting ?? []);
  const redundant = new Set(res?.redundant ?? []);
  const badEnts = new Set<string>();
  for (const c of shown.constraints) if (conflicting.has(c.id)) c.refs.forEach((r) => badEnts.add(r));
  const entDetermined = (e: CadEntity) => {
    switch (e.type) {
      case 'line': return determined.has(e.p1) && determined.has(e.p2);
      case 'circle': return determined.has(e.c) && detR.has(e.id);
      case 'arc': return determined.has(e.c) && determined.has(e.p1) && determined.has(e.p2);
      case 'point':
      case 'text': return determined.has(e.p);
      case 'ellipse': return entityPoints(e).every((p) => determined.has(p)) && detR.has(e.id);
      case 'spline': return entityPoints(e).every((p) => determined.has(p));
    }
  };
  const picked = new Set([...sel, ...picks, ...(tool === 'mirror' ? mirrorSet : [])]);
  const usedPoints = new Set(shown.entities.flatMap(entityPoints));
  const refPoints = new Set(shown.entities.filter((e) => e.ref).flatMap(entityPoints));

  const draftPath = (() => {
    if (!draft) return '';
    const [a] = draft.refs;
    const cur = draft.cur.ref.p;
    const S = (p: Vec2) => toS(vp, p);
    const circ = (c: Vec2, r: number) => `M${S(c).x - r * z} ${S(c).y}a${r * z} ${r * z} 0 1 0 ${2 * r * z} 0a${r * z} ${r * z} 0 1 0 ${-2 * r * z} 0`;
    const poly = (pts: Vec2[]) => (pts.length ? `M${pts.map((q) => `${S(q).x} ${S(q).y}`).join('L')}` : '');
    switch (draft.tool) {
      case 'line': {
        const p = S(lastRef(draft).p), q = S(cur);
        return `M${p.x} ${p.y}L${q.x} ${q.y}`;
      }
      case 'spline':
      case 'cspline': {
        // the curve through (or on) the points so far and the cursor
        const pts = [...draft.refs.map((r) => r.p), cur];
        const cv = draft.tool === 'spline' ? interpolate(pts)?.curve : controlSpline(pts);
        const curve = cv ? poly(segPolyline({ kind: 'bspline', ...cv }, Math.PI / 90)) : poly(pts);
        return draft.tool === 'cspline' ? `${curve} ${poly(pts)}` : curve;
      }
      case 'ellipse':
      case 'earc': {
        if (draft.refs.length === 1) return poly([a.p, cur]);
        const ax = draft.refs[1].p, ra = Math.hypot(ax.x - a.p.x, ax.y - a.p.y), rot = Math.atan2(ax.y - a.p.y, ax.x - a.p.x);
        const at = (rb: number, t: number) => ({ x: a.p.x + ra * Math.cos(t) * Math.cos(rot) - rb * Math.sin(t) * Math.sin(rot), y: a.p.y + ra * Math.cos(t) * Math.sin(rot) + rb * Math.sin(t) * Math.cos(rot) });
        const ring = (rb: number, t0 = 0, t1 = 2 * Math.PI) => poly(Array.from({ length: 97 }, (_, i) => at(rb, t0 + ((t1 - t0) * i) / 96)));
        if (draft.tool === 'ellipse' || draft.refs.length === 2) {
          // the minor axis from the cursor: its distance from the axis (an arc's start lies on the ellipse)
          const loc = { x: (cur.x - a.p.x) * Math.cos(rot) + (cur.y - a.p.y) * Math.sin(rot), y: -(cur.x - a.p.x) * Math.sin(rot) + (cur.y - a.p.y) * Math.cos(rot) };
          const rb = draft.tool === 'ellipse' ? minorOf(a.p, ax, cur) : Math.abs(loc.y) / Math.sqrt(Math.max(1e-9, 1 - (loc.x / ra) ** 2));
          return `${ring(rb)} ${poly([a.p, ax])}`;
        }
        const st = draft.refs[2].p;
        const loc = (q: Vec2) => ({ x: (q.x - a.p.x) * Math.cos(rot) + (q.y - a.p.y) * Math.sin(rot), y: -(q.x - a.p.x) * Math.sin(rot) + (q.y - a.p.y) * Math.cos(rot) });
        const ls = loc(st), rb = Math.abs(ls.y) / Math.sqrt(Math.max(1e-9, 1 - (ls.x / ra) ** 2));
        const t0 = Math.atan2(ls.y / rb, ls.x / ra), lc = loc(cur);
        let t1 = Math.atan2(lc.y / rb, lc.x / ra);
        while (t1 <= t0) t1 += 2 * Math.PI;
        return ring(rb, t0, t1);
      }
      case 'rect': {
        const p = S(a.p), q = S(cur);
        return `M${p.x} ${p.y}H${q.x}V${q.y}H${p.x}Z`;
      }
      case 'crect': {
        const dx = cur.x - a.p.x, dy = cur.y - a.p.y;
        const p = S({ x: a.p.x - dx, y: a.p.y - dy }), q = S(cur);
        return `M${p.x} ${p.y}H${q.x}V${q.y}H${p.x}Z`;
      }
      case 'circle': return circ(a.p, Math.hypot(cur.x - a.p.x, cur.y - a.p.y));
      case 'polygon': {
        const r = Math.hypot(cur.x - a.p.x, cur.y - a.p.y), a0 = Math.atan2(cur.y - a.p.y, cur.x - a.p.x), n = ui.cadSides;
        const pts = Array.from({ length: n }, (_, i) => S({ x: a.p.x + r * Math.cos(a0 + (2 * Math.PI * i) / n), y: a.p.y + r * Math.sin(a0 + (2 * Math.PI * i) / n) }));
        return `M${pts.map((p) => `${p.x} ${p.y}`).join('L')}Z ${circ(a.p, r)}`;
      }
      case 'arc':
      case 'arc3':
      case 'slot': {
        if (draft.refs.length === 1) {
          const p = S(a.p), q = S(cur);
          return `M${p.x} ${p.y}L${q.x} ${q.y}`;
        }
        const b = draft.refs[1].p;
        if (draft.tool === 'slot') {
          const ux = b.x - a.p.x, uy = b.y - a.p.y, L = Math.hypot(ux, uy) || 1;
          const h = Math.abs(((cur.x - a.p.x) * -uy + (cur.y - a.p.y) * ux) / L);
          const n = { x: (-uy / L) * h, y: (ux / L) * h };
          const P = [{ x: a.p.x + n.x, y: a.p.y + n.y }, { x: b.x + n.x, y: b.y + n.y }, { x: b.x - n.x, y: b.y - n.y }, { x: a.p.x - n.x, y: a.p.y - n.y }].map(S);
          return `M${P[0].x} ${P[0].y}L${P[1].x} ${P[1].y}A${h * z} ${h * z} 0 0 1 ${P[2].x} ${P[2].y}L${P[3].x} ${P[3].y}A${h * z} ${h * z} 0 0 1 ${P[0].x} ${P[0].y}`;
        }
        if (draft.tool === 'arc') {
          const r = Math.hypot(b.x - a.p.x, b.y - a.p.y);
          const a0 = Math.atan2(b.y - a.p.y, b.x - a.p.x);
          let a1 = Math.atan2(cur.y - a.p.y, cur.x - a.p.x);
          while (a1 <= a0) a1 += 2 * Math.PI;
          const p = S(b), q = S({ x: a.p.x + r * Math.cos(a1), y: a.p.y + r * Math.sin(a1) });
          return `M${p.x} ${p.y}A${r * z} ${r * z} 0 ${a1 - a0 > Math.PI ? 1 : 0} 0 ${q.x} ${q.y}`;
        }
        // three-point preview: polyline through start, pick, end
        const p = S(a.p), m = S(cur), q = S(b);
        return `M${p.x} ${p.y}Q${2 * m.x - (p.x + q.x) / 2} ${2 * m.y - (p.y + q.y) / 2} ${q.x} ${q.y}`;
      }
      default:
        return '';
    }
  })();

  const cursorLabel = (() => {
    if (!draft || typed) return null;
    const cur = draft.cur.ref.p;
    const from = draft.tool === 'line' ? lastRef(draft).p : draft.refs[0].p;
    if (draft.tool === 'line') {
      const L = Math.hypot(cur.x - from.x, cur.y - from.y);
      return `${fmtNum(L)}  ∠${fmtNum((Math.atan2(cur.y - from.y, cur.x - from.x) * 180) / Math.PI)}°`;
    }
    if (draft.tool === 'rect') return `${fmtNum(Math.abs(cur.x - from.x))} × ${fmtNum(Math.abs(cur.y - from.y))}`;
    if (draft.tool === 'crect') return `${fmtNum(2 * Math.abs(cur.x - from.x))} × ${fmtNum(2 * Math.abs(cur.y - from.y))}`;
    if (draft.tool === 'circle') return `Ø ${fmtNum(2 * Math.hypot(cur.x - from.x, cur.y - from.y))}`;
    if (draft.tool === 'polygon') return `R ${fmtNum(Math.hypot(cur.x - from.x, cur.y - from.y))} · ${ui.cadSides} sides`;
    if (draft.tool === 'ellipse' && draft.refs.length === 2) {
      const ax = draft.refs[1].p;
      return `a ${fmtNum(Math.hypot(ax.x - from.x, ax.y - from.y))} · b ${fmtNum(minorOf(from, ax, cur))}`;
    }
    if ((draft.tool === 'ellipse' || draft.tool === 'earc') && draft.refs.length === 1) return `a ${fmtNum(Math.hypot(cur.x - from.x, cur.y - from.y))}`;
    return null;
  })();

  const cursor = !interactive ? undefined : tool === 'pan' || space ? 'grab' : tool === 'select' ? 'default' : 'crosshair';
  const curS = draft ? toS(vp, draft.cur.ref.p) : null;

  return (
    <div ref={wrapRef} className={`cad-canvas${interactive ? ' interactive' : ''}`} style={{ width, height }} tabIndex={interactive ? 0 : -1} onKeyDown={onKeyDown} onKeyUp={onKeyUp}>
      <svg
        ref={svgRef} width={width} height={height} className="sk-svg cad-svg" style={{ cursor }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        onPointerLeave={() => { setHover(null); setHoverSnap(null); }}
        onContextMenu={(e) => interactive && e.preventDefault()}
        onDoubleClick={(e) => {
          if (!interactive || !draft) return;
          e.preventDefault();
          if (draft.tool === 'spline' || draft.tool === 'cspline') finishSpline(draft);
          else setDraft(null);
        }}
      >
        {interactive && <CadGrid vp={vp} />}
        {reference?.length ? (
          <path className="cad-ref" d={reference.map((loop) => loop.map((p, i) => {
            const q = toS(vp, p);
            return `${i ? 'L' : 'M'}${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
          }).join(' ') + ' Z').join(' ')} />
        ) : null}
        <ProfileFill regions={profiles.regions} vp={vp} />
        {shown.entities.map((ent) => {
          if (ent.type === 'point') return null;
          const cls = ['cad-ent', ent.construction ? 'cons' : '', ent.ref ? 'ref' : '', ent.type === 'text' ? 'text' : '', entDetermined(ent) ? 'det' : '', badEnts.has(ent.id) ? 'bad' : '', picked.has(ent.id) ? 'sel' : '', hover === ent.id ? (tool === 'trim' ? 'trim' : 'hover') : ''].filter(Boolean).join(' ');
          return <path key={ent.id} d={entityPath(geo, ent, vp)} className={cls} />;
        })}
        {interactive && shown.entities.map((ent) => {
          if (ent.type !== 'spline') return null;
          // tangent handles to their ends, a control spline's polygon through its poles
          const S = (id: string) => toS(vp, geo.P.get(id)!);
          const pairs: [string, string][] = [];
          if (ent.h1) pairs.push([ent.pts[0], ent.h1]);
          if (ent.h2) pairs.push([ent.pts[ent.pts.length - 1], ent.h2]);
          if (ent.mode === 'control') ent.pts.forEach((q, i) => (i + 1 < ent.pts.length || ent.closed) && pairs.push([q, ent.pts[(i + 1) % ent.pts.length]]));
          return pairs.length ? <path key={`h${ent.id}`} className="cad-handle" d={pairs.map(([a, b]) => `M${S(a).x} ${S(a).y}L${S(b).x} ${S(b).y}`).join('')} /> : null;
        })}
        {interactive && shown.points.map((p) => {
          if (!usedPoints.has(p.id)) return null;
          const s = toS(vp, p);
          const isCentre = shown.entities.some((e) => (e.type === 'circle' || e.type === 'arc' || e.type === 'ellipse') && e.c === p.id);
          const cls = ['cad-pt', refPoints.has(p.id) ? 'ref' : '', determined.has(p.id) ? 'det' : '', badEnts.has(p.id) ? 'bad' : '', picked.has(p.id) ? 'sel' : '', hover === p.id ? 'hover' : ''].filter(Boolean).join(' ');
          return isCentre
            ? <path key={p.id} d={`M${s.x - 4} ${s.y}h8M${s.x} ${s.y - 4}v8`} className={`${cls} ctr`} />
            : <rect key={p.id} x={s.x - 2.6} y={s.y - 2.6} width={5.2} height={5.2} className={cls} />;
        })}
        {!interactive && shown.entities.filter((e) => e.type === 'point' && !e.construction).map((e) => {
          const s = toS(vp, geo.P.get((e as { p: string }).p)!);
          return <circle key={e.id} cx={s.x} cy={s.y} r={2} className="cad-ent" />;
        })}
        {shown.constraints.filter((c) => isDimension(c.type)).map((c) => {
          const err = res?.dimErrors?.[c.id];
          const value = fresh && res?.values?.[c.id] !== undefined ? res.values[c.id] : measure(shown, c, geo.P, geo.R);
          const dd = dimDrawing(c, geo, vp, value, err);
          if (!dd) return null;
          const cls = ['cad-dim', c.driving === false ? 'ref' : '', conflicting.has(c.id) ? 'bad' : '', redundant.has(c.id) ? 'warn' : '', err ? 'bad' : '', picked.has(c.id) ? 'sel' : ''].filter(Boolean).join(' ');
          return (
            <g key={c.id} className={cls}>
              <path d={dd.path} className="cad-dim-line" />
              {dd.arrows && <path d={dd.arrows} className="cad-dim-arrow" />}
              <text x={dd.at.x} y={dd.at.y} className="cad-dim-text" textAnchor="middle" dominantBaseline="middle"
                onPointerDown={(e) => onLabelDown(e, c)}
                onDoubleClick={(e) => { if (!interactive) return; e.stopPropagation(); setEditDim({ cid: c.id, text: c.value ?? '' }); }}>
                {dd.text}
              </text>
            </g>
          );
        })}
        {interactive && ui.cadRelations && glyphs(geo, vp).map((gl, i) => (
          <g key={`${gl.c.id}${i}`} className={`cad-glyph${conflicting.has(gl.c.id) ? ' bad' : ''}${redundant.has(gl.c.id) ? ' warn' : ''}${picked.has(gl.c.id) ? ' sel' : ''}`}
            transform={`translate(${gl.at.x} ${gl.at.y})`}
            onPointerDown={(e) => { if (!interactive) return; e.stopPropagation(); select(e.shiftKey ? [...sel, gl.c.id] : [gl.c.id]); }}>
            <rect x={-6.5} y={-6.5} width={13} height={13} rx={3} />
            <text textAnchor="middle" dominantBaseline="central">{gl.text}</text>
          </g>
        ))}
        {draftPath && <path d={draftPath} className="cad-draft" />}
        {interactive && (draft?.cur ?? hoverSnap) && <SnapMarker snap={(draft?.cur ?? hoverSnap)!} vp={vp} />}
        {curS && cursorLabel && <text x={curS.x + 14} y={curS.y - 12} className="cad-draft-len">{cursorLabel}</text>}
        {band && (
          <rect className={`sk-band${band.b.x < band.a.x ? ' crossing' : ''}`} x={Math.min(band.a.x, band.b.x)} y={Math.min(band.a.y, band.b.y)}
            width={Math.abs(band.a.x - band.b.x)} height={Math.abs(band.a.y - band.b.y)} />
        )}
      </svg>
      {typed && curS && draft && (
        <div className="cadw-typed" style={{ left: curS.x + 16, top: curS.y + 10 }}>
          {TYPED_FIELDS[draft.tool]!.map((label, i) => (
            <span key={label} className={i === typed.active ? 'on' : ''}>
              {label} <b>{typed.fields[i] || '…'}</b>
            </span>
          ))}
          <small>Enter to place · Tab next field · Esc cancel</small>
        </div>
      )}
      {editDim && (() => {
        const c = shown.constraints.find((x) => x.id === editDim.cid);
        const dd = c && dimDrawing(c, geo, vp, 0);
        if (!c || !dd) return null;
        return (
          <input
            className="cad-dim-input" autoFocus value={editDim.text}
            style={{ left: dd.at.x - 60, top: dd.at.y - 12 }}
            title="A number in the sketch unit, a value with a unit (25 mm, 30 deg) or any worksheet expression (b/2)"
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setEditDim({ ...editDim, text: e.target.value })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commitDim(editDim.cid, editDim.text);
              if (e.key === 'Escape') { setEditDim(null); wrapRef.current?.focus({ preventScroll: true }); }
            }}
            onBlur={() => commitDim(editDim.cid, editDim.text)}
          />
        );
      })()}
    </div>
  );
});

/** A view that fits the part (geometry and dimension labels) into width × height. */
function framing(region: CadRegion, width: number, height: number): View | null {
  const g = geoOf(region.sketch);
  const b = sketchBox(g);
  if (!b) return null;
  const pad = 36;
  // labels sit a fixed number of pixels off the geometry: frame twice so they are counted at the final zoom
  let v: View = { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, zoom: Math.min((width - 2 * pad) / Math.max(b.x1 - b.x0, 1e-6), (height - 2 * pad) / Math.max(b.y1 - b.y0, 1e-6)) };
  for (let pass = 0; pass < 2; pass++) {
    const box = { ...b };
    for (const c of region.sketch.constraints) {
      if (!isDimension(c.type)) continue;
      const dd = dimDrawing(c, g, { view: v, width, height }, 0);
      if (!dd) continue;
      const w = toW({ view: v, width, height }, dd.at.x, dd.at.y);
      box.x0 = Math.min(box.x0, w.x - 30 / v.zoom); box.x1 = Math.max(box.x1, w.x + 30 / v.zoom);
      box.y0 = Math.min(box.y0, w.y - 8 / v.zoom); box.y1 = Math.max(box.y1, w.y + 8 / v.zoom);
    }
    v = {
      cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2,
      zoom: Math.min((width - 2 * pad) / Math.max(box.x1 - box.x0, 1e-6), (height - 2 * pad) / Math.max(box.y1 - box.y0, 1e-6)),
    };
  }
  return Number.isFinite(v.zoom) && v.zoom > 0 ? v : null;
}

/** The minor semi-axis an ellipse about c with its major axis to a gets from a click at p: p's distance from the axis. */
function minorOf(c: Vec2, a: Vec2, p: Vec2): number {
  return segDistInf(p, c, a);
}

function segDistInf(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  return Math.abs(dx * (p.y - a.y) - dy * (p.x - a.x)) / (Math.hypot(dx, dy) || 1);
}

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

void segDist;
