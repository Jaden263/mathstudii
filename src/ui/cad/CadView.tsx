import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch } from 'react';
import {
  MousePointer2, Slash, Square, Circle as CircleIcon, RotateCcw, Dot, Ruler, Maximize, Trash2, Check, Box, PenTool,
  FileDown, FileUp, Construction, Hand, Columns2,
} from 'lucide-react';
import type { CadRegion } from '../../model/types';
import type { RegionResult } from '../../engine/evaluator';
import type { CadResult } from '../../cad/evaluate';
import { revolveAxis } from '../../cad/evaluate';
import { cadId, isDimension, removeFromSketch, sketchSig, type CadConstraint, type CadEntity, type CadSketch, type CadView as View, type ConstraintType } from '../../cad/model';
import { solveSketch, measure } from '../../cad/solver';
import { findProfiles, type Vec2 } from '../../cad/profile';
import {
  CONSTRAINT_TOOLS, constraintFromSelection, dimensionFromSelection, entityRadius, hitTest, localValues, solveLocal, withSolution,
  type DimKind, type Geo,
} from '../../cad/edit';
import { extrudeMesh, revolveMesh, type Mesh } from '../../cad/mesh';
import type { Action } from '../store';
import { useSketchUI, type CadTool } from '../sketch/context';
import { exportFile, pickFile } from '../../platform/files';
import { Cad3DView } from './Cad3DView';
import { ProfileFill, dimDrawing, entityPath, glyphs, toS, toW, type Vp } from './cadRender';

interface Props {
  region: CadRegion;
  result?: RegionResult;
  editing: boolean;
  selected: boolean;
  dispatch: Dispatch<Action>;
  onDone: (moveBelow?: boolean) => void;
}

const TOOLS: { tool: CadTool; icon: typeof Slash; label: string; key: string }[] = [
  { tool: 'select', icon: MousePointer2, label: 'Select, drag geometry, drag dimension labels (S)', key: 's' },
  { tool: 'line', icon: Slash, label: 'Line chain (L): click points; click the first point, right-click or Esc to finish', key: 'l' },
  { tool: 'rect', icon: Square, label: 'Rectangle (R): two corners', key: 'r' },
  { tool: 'circle', icon: CircleIcon, label: 'Circle (C): centre, then radius', key: 'c' },
  { tool: 'arc', icon: RotateCcw, label: 'Arc (A): centre, start, end (counter-clockwise)', key: 'a' },
  { tool: 'point', icon: Dot, label: 'Point (P)', key: 'p' },
  { tool: 'dim', icon: Ruler, label: 'Dimension (D): pick a line, circle, arc, two points, a point and a line, or two lines — then click where the dimension goes', key: 'd' },
  { tool: 'pan', icon: Hand, label: 'Pan (or drag with the middle mouse button)', key: ' ' },
];

const SNAP_PX = 8;
const AUTO_HV = (3 * Math.PI) / 180;

/** A clicked location: an existing point, a point on a curve, or free space. */
interface Ref {
  id?: string;
  on?: string;
  p: Vec2;
}

type Draft = { tool: CadTool; refs: Ref[]; cur: Ref };

type Drag =
  | { mode: 'points'; grab: Map<string, Vec2>; base: CadSketch; moved: boolean }
  | { mode: 'label'; cid: string; sx: number; sy: number; orig: { x: number; y: number }; moved: boolean }
  | { mode: 'pan'; sx: number; sy: number; view: View }
  | { mode: 'band'; a: Vec2; b: Vec2 };

function geoOf(sk: CadSketch): Geo {
  return {
    sk,
    P: new Map(sk.points.map((p) => [p.id, { x: p.x, y: p.y }])),
    R: new Map(sk.entities.filter((e) => e.type === 'circle').map((e) => [e.id, Math.abs((e as { r: number }).r)])),
  };
}

function bbox(g: Geo): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: Vec2, r = 0) => {
    x0 = Math.min(x0, p.x - r); x1 = Math.max(x1, p.x + r);
    y0 = Math.min(y0, p.y - r); y1 = Math.max(y1, p.y + r);
  };
  for (const p of g.P.values()) add(p);
  for (const e of g.sk.entities) if (e.type === 'circle') add(g.P.get(e.c)!, entityRadius(g, e));
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

export function CadView({ region, result, editing, selected: regionSelected, dispatch, onDone }: Props) {
  const { ui, setUi, separate, showProperties } = useSketchUI();
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [live, setLive] = useState<CadSketch | null>(null);
  const [liveView, setLiveView] = useState<View | null>(null);
  const [liveOffset, setLiveOffset] = useState<{ cid: string; offset: { x: number; y: number } } | null>(null);
  const [band, setBand] = useState<{ a: Vec2; b: Vec2 } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [dimPicks, setDimPicks] = useState<string[]>([]);
  const [dimKind, setDimKind] = useState<DimKind>('smart');
  const [editDim, setEditDim] = useState<{ cid: string; text: string } | null>(null);
  const [msg, setMsg] = useState<string>('');
  const drag = useRef<Drag | null>(null);
  const raf = useRef(0);
  const pendingDrag = useRef<Map<string, Vec2> | null>(null);

  const res = result?.kind === 'cad' ? (result as CadResult) : undefined;
  const sig = useMemo(() => sketchSig(region.sketch), [region.sketch]);
  const fresh = !!res && res.sig === sig;
  const view = liveView ?? region.view;
  const split = region.mode === 'split';
  const sketchW = split ? Math.round(region.width * 0.58) : region.width;
  const vp: Vp = { view, width: sketchW, height: region.height };
  const mine = ui.regionId === region.id;
  const sel = useMemo(() => new Set(mine ? ui.selected : []), [mine, ui.selected]);
  const tool: CadTool = editing && mine ? ui.cadTool : 'select';

  // solved geometry: the worksheet's result when it belongs to this sketch, else the stored state
  const shown = useMemo(() => {
    if (live) return live;
    let sk = fresh && res ? withSolution(region.sketch, res.points, res.radii) : region.sketch;
    if (liveOffset) sk = { ...sk, constraints: sk.constraints.map((c) => (c.id === liveOffset.cid ? { ...c, offset: liveOffset.offset } : c)) };
    return sk;
  }, [live, fresh, res, region.sketch, liveOffset]);
  const geo = useMemo(() => geoOf(shown), [shown]);
  const profiles = useMemo(() => findProfiles(shown), [shown]);

  // keep the stored geometry in step with what the worksheet solved (dimensions driven by variables)
  useEffect(() => {
    if (!fresh || !res || live || drag.current) return;
    const moved = region.sketch.points.some((p) => {
      const q = res.points[p.id];
      return q && Math.hypot(q[0] - p.x, q[1] - p.y) > 1e-9 * Math.max(1, Math.abs(p.x), Math.abs(p.y));
    }) || region.sketch.entities.some((e) => e.type === 'circle' && res.radii[e.id] !== undefined && Math.abs(res.radii[e.id] - e.r) > 1e-9 * Math.max(1, e.r));
    if (moved) dispatch({ type: 'update', id: region.id, patch: { sketch: withSolution(region.sketch, res.points, res.radii) }, history: false });
  }, [fresh, res, live, region.sketch, region.id, dispatch]);

  useEffect(() => {
    if (!editing) {
      setDraft(null);
      setBand(null);
      setDimPicks([]);
      setEditDim(null);
    } else wrapRef.current?.focus({ preventScroll: true });
  }, [editing]);

  useEffect(() => {
    if (!msg) return;
    const t = window.setTimeout(() => setMsg(''), 4000);
    return () => window.clearTimeout(t);
  }, [msg]);

  const select = (ids: string[]) => setUi({ regionId: region.id, selected: ids });
  const setTool = (t: CadTool) => {
    setUi({ regionId: region.id, cadTool: t });
    setDraft(null);
    setDimPicks([]);
    wrapRef.current?.focus({ preventScroll: true });
  };

  /** Solve locally and store: geometry responds at once, the worksheet follows. */
  const commit = useCallback((next: CadSketch, coalesce?: string) => {
    dispatch({ type: 'update', id: region.id, patch: { sketch: solveLocal(next, region.unit, res?.values) }, coalesce });
  }, [dispatch, region.id, region.unit, res?.values]);

  // ------------------------------------------------------------ coordinates & snapping

  const screenOf = (e: { clientX: number; clientY: number }): Vec2 => {
    const rect = svgRef.current!.getBoundingClientRect();
    const k = rect.width / sketchW;
    return { x: (e.clientX - rect.left) / k, y: (e.clientY - rect.top) / k };
  };
  const worldOf = (e: { clientX: number; clientY: number }) => {
    const s = screenOf(e);
    return toW(vp, s.x, s.y);
  };

  const snapRef = (e: { clientX: number; clientY: number; altKey?: boolean }, skip = new Set<string>()): Ref => {
    const w = worldOf(e);
    if (e.altKey) return { p: w };
    const pick = hitTest(geo, w, SNAP_PX / view.zoom, skip);
    if (pick?.kind === 'point') return { id: pick.id, p: geo.P.get(pick.id)! };
    if (pick?.kind === 'entity') {
      // project onto the curve so the new point sits on it
      const ent = shown.entities.find((x) => x.id === pick.id)!;
      if (ent.type === 'line') {
        const a = geo.P.get(ent.p1)!, b = geo.P.get(ent.p2)!;
        const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((w.x - a.x) * dx + (w.y - a.y) * dy) / L2));
        return { on: ent.id, p: { x: a.x + t * dx, y: a.y + t * dy } };
      }
      if (ent.type === 'circle' || ent.type === 'arc') {
        const c = geo.P.get(ent.c)!, r = entityRadius(geo, ent);
        const L = Math.hypot(w.x - c.x, w.y - c.y) || 1;
        return { on: ent.id, p: { x: c.x + ((w.x - c.x) * r) / L, y: c.y + ((w.y - c.y) * r) / L } };
      }
    }
    return { p: w };
  };

  // ------------------------------------------------------------ creating geometry

  /** Resolve a Ref into a point id, adding the point (and an on-curve constraint) to `sk`. */
  const pointFor = (sk: CadSketch, r: Ref): string => {
    if (r.id) return r.id;
    const id = cadId('p');
    sk.points.push({ id, x: r.p.x, y: r.p.y });
    if (r.on) {
      const ent = sk.entities.find((e) => e.id === r.on);
      if (ent?.type === 'line') sk.constraints.push({ id: cadId('k'), type: 'pointOnLine', refs: [id, ent.id] });
      else if (ent) sk.constraints.push({ id: cadId('k'), type: 'pointOnCircle', refs: [id, ent.id] });
    }
    r.id = id;
    return id;
  };

  const clone = (sk: CadSketch): CadSketch => ({ points: [...sk.points], entities: [...sk.entities], constraints: [...sk.constraints] });
  const construction = ui.cadConstruction || undefined;

  const addLine = (sk: CadSketch, a: Ref, b: Ref) => {
    const fresh2 = !a.id || !b.id;
    const p1 = pointFor(sk, a), p2 = pointFor(sk, b);
    const id = cadId('e');
    sk.entities.push({ id, type: 'line', p1, p2, construction });
    // nearly horizontal/vertical lines snap to it (not when joining two existing points)
    const dx = b.p.x - a.p.x, dy = b.p.y - a.p.y;
    const ang = Math.atan2(Math.abs(dy), Math.abs(dx));
    if (fresh2 && ang < AUTO_HV) sk.constraints.push({ id: cadId('k'), type: 'horizontal', refs: [id] });
    else if (fresh2 && Math.PI / 2 - ang < AUTO_HV) sk.constraints.push({ id: cadId('k'), type: 'vertical', refs: [id] });
    return id;
  };

  const clickDraw = (ref: Ref, e: React.PointerEvent) => {
    const z = view.zoom;
    if (!draft) {
      if (tool === 'point') {
        if (ref.id) return;
        const sk = clone(shown);
        const p = pointFor(sk, ref);
        sk.entities.push({ id: cadId('e'), type: 'point', p, construction });
        commit(sk);
        return;
      }
      setDraft({ tool, refs: [ref], cur: ref });
      return;
    }
    const d = draft;
    const first = d.refs[0];
    const tiny = (a: Ref, b: Ref) => Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y) * z < 3;
    if (d.tool === 'line') {
      const last = d.refs[d.refs.length - 1];
      if (tiny(last, ref) && !(ref.id && ref.id !== last.id)) return;
      const sk = clone(shown);
      addLine(sk, last, ref);
      commit(sk);
      // closing on the chain's first point ends it
      if (ref.id && ref.id === first.id && d.refs.length > 1) setDraft(null);
      else setDraft({ ...d, refs: [...d.refs.slice(0, -1), last, ref], cur: ref });
      return;
    }
    if (d.tool === 'rect') {
      if (tiny(first, ref)) return;
      const sk = clone(shown);
      const a = first, c = ref;
      const b: Ref = { p: { x: c.p.x, y: a.p.y } }, dd: Ref = { p: { x: a.p.x, y: c.p.y } };
      const ids = [pointFor(sk, a), pointFor(sk, b), pointFor(sk, c), pointFor(sk, dd)];
      const lines = ids.map((p, i) => {
        const id = cadId('e');
        sk.entities.push({ id, type: 'line', p1: p, p2: ids[(i + 1) % 4], construction });
        return id;
      });
      sk.constraints.push(
        { id: cadId('k'), type: 'horizontal', refs: [lines[0]] }, { id: cadId('k'), type: 'vertical', refs: [lines[1]] },
        { id: cadId('k'), type: 'horizontal', refs: [lines[2]] }, { id: cadId('k'), type: 'vertical', refs: [lines[3]] },
      );
      commit(sk);
      select(lines);
      setDraft(null);
      return;
    }
    if (d.tool === 'circle') {
      if (tiny(first, ref)) return;
      const sk = clone(shown);
      const c = pointFor(sk, { ...first });
      const r = Math.hypot(ref.p.x - first.p.x, ref.p.y - first.p.y);
      const id = cadId('e');
      sk.entities.push({ id, type: 'circle', c, r, construction });
      // a click on a curve or point makes the circle pass through it
      if (ref.id) sk.constraints.push({ id: cadId('k'), type: 'pointOnCircle', refs: [ref.id, id] });
      commit(sk);
      select([id]);
      setDraft(null);
      return;
    }
    if (d.tool === 'arc') {
      if (d.refs.length === 1) {
        if (tiny(first, ref)) return;
        setDraft({ ...d, refs: [first, ref], cur: ref });
        return;
      }
      const start = d.refs[1];
      const sk = clone(shown);
      const c = pointFor(sk, { ...first });
      const p1 = pointFor(sk, start);
      // the end point lies on the circle through the start point
      const r = Math.hypot(start.p.x - first.p.x, start.p.y - first.p.y);
      const ang = Math.atan2(ref.p.y - first.p.y, ref.p.x - first.p.x);
      const endRef: Ref = ref.id ? ref : { p: { x: first.p.x + r * Math.cos(ang), y: first.p.y + r * Math.sin(ang) } };
      const p2 = pointFor(sk, endRef);
      const id = cadId('e');
      sk.entities.push({ id, type: 'arc', c, p1, p2, construction });
      commit(sk);
      select([id]);
      setDraft(null);
      return;
    }
    void e;
  };

  // ------------------------------------------------------------ constraints & dimensions

  const applyConstraint = (type: ConstraintType) => {
    const out = constraintFromSelection(type, geo, mine ? ui.selected : []);
    if (typeof out === 'string') {
      setMsg(out);
      return;
    }
    commit({ ...shown, constraints: [...shown.constraints, ...out] });
  };

  const createDimension = (picks: string[], at?: Vec2) => {
    const c = dimensionFromSelection(geo, picks, dimKind);
    if (typeof c === 'string') {
      setMsg(c);
      return;
    }
    // place the label where the user clicked
    if (at) {
      const dd = dimDrawing(c, geo, vp, 0);
      if (dd && c.type !== 'angle') c.offset = { x: (at.x - dd.at.x) / view.zoom, y: -(at.y - dd.at.y) / view.zoom };
    }
    commit({ ...shown, constraints: [...shown.constraints, c] });
    setDimPicks([]);
    select([c.id]);
    setEditDim({ cid: c.id, text: c.value ?? '' });
  };

  const commitDim = (cid: string, text: string) => {
    const t = text.trim();
    setEditDim(null);
    if (!t) return;
    commit({ ...shown, constraints: shown.constraints.map((c) => (c.id === cid ? { ...c, value: t } : c)) });
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

  // ------------------------------------------------------------ view

  const commitView = (v: View) => {
    setLiveView(null);
    dispatch({ type: 'update', id: region.id, patch: { view: v }, history: false });
  };

  const fit = () => {
    const b = bbox(geo);
    if (!b) return;
    // dimension labels belong in the frame too
    for (const c of shown.constraints) {
      if (!isDimension(c.type)) continue;
      const dd = dimDrawing(c, geo, vp, 0);
      if (!dd) continue;
      const w = toW(vp, dd.at.x, dd.at.y);
      b.x0 = Math.min(b.x0, w.x); b.x1 = Math.max(b.x1, w.x);
      b.y0 = Math.min(b.y0, w.y); b.y1 = Math.max(b.y1, w.y);
    }
    const w = Math.max(b.x1 - b.x0, 1e-6), h = Math.max(b.y1 - b.y0, 1e-6);
    const zoom = Math.min((sketchW - 70) / w, (region.height - 70) / h);
    commitView({ cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : view.zoom });
  };

  const startResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const sheet = (e.currentTarget as HTMLElement).closest('.sheet') as HTMLElement | null;
    const pageZoom = sheet ? sheet.getBoundingClientRect().width / sheet.offsetWidth : 1;
    const start = { x: e.clientX, y: e.clientY, w: region.width, h: region.height, view: region.view };
    const move = (ev: PointerEvent) => {
      const kx = (start.w + (ev.clientX - start.x) / pageZoom) / start.w;
      const ky = (start.h + (ev.clientY - start.y) / pageZoom) / start.h;
      const k = Math.max(200 / start.w, 140 / start.h, Math.max(kx, ky));
      dispatch({
        type: 'update', id: region.id, coalesce: `resize:${region.id}`,
        patch: { width: Math.round(start.w * k), height: Math.round(start.h * k), view: { ...start.view, zoom: start.view.zoom * k } },
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      separate(`resize:${region.id}`);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

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
    if (!editing) return;
    e.stopPropagation();
    // no compatibility mousedown: its default action would steal focus from the dimension input
    e.preventDefault();
    wrapRef.current?.focus({ preventScroll: true });
    const s = screenOf(e);
    if (e.button === 1 || tool === 'pan') {
      e.preventDefault();
      drag.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, view };
      svgRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const w = toW(vp, s.x, s.y);
    if (tool === 'select') {
      const pick = hitTest(geo, w, SNAP_PX / view.zoom);
      if (!pick) {
        if (!e.shiftKey) select([]);
        drag.current = { mode: 'band', a: s, b: s };
        svgRef.current?.setPointerCapture(e.pointerId);
        return;
      }
      const ids = e.shiftKey ? (sel.has(pick.id) ? [...sel].filter((x) => x !== pick.id) : [...sel, pick.id]) : sel.has(pick.id) ? [...sel] : [pick.id];
      select(ids);
      // drag the picked point, or every point of the picked entity
      let pts: string[] = [];
      if (pick.kind === 'point') pts = [pick.id];
      else {
        const ent = shown.entities.find((x) => x.id === pick.id);
        if (ent?.type === 'line') pts = [ent.p1, ent.p2];
        else if (ent?.type === 'circle') pts = [ent.c];
        else if (ent?.type === 'arc') pts = [ent.c, ent.p1, ent.p2];
        else if (ent?.type === 'point') pts = [ent.p];
      }
      const grab = new Map(pts.map((id) => [id, { x: geo.P.get(id)!.x - w.x, y: geo.P.get(id)!.y - w.y }]));
      drag.current = { mode: 'points', grab, base: shown, moved: false };
      svgRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    if (tool === 'dim') {
      const pick = hitTest(geo, w, SNAP_PX / view.zoom);
      if (pick && pick.kind !== 'constraint') {
        const next = dimPicks.includes(pick.id) ? dimPicks.filter((x) => x !== pick.id) : dimPicks.length >= 2 ? [pick.id] : [...dimPicks, pick.id];
        setDimPicks(next);
        // a lone circle or arc has only one sensible dimension: place it right away
        const ent = shown.entities.find((x) => x.id === pick.id);
        if (next.length === 1 && (ent?.type === 'circle' || ent?.type === 'arc')) createDimension(next);
        return;
      }
      if (dimPicks.length) createDimension(dimPicks, s);
      return;
    }
    clickDraw(snapRef(e), e);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!editing) return;
    const d = drag.current;
    const s = screenOf(e);
    if (d?.mode === 'pan') {
      const k = svgRef.current!.getBoundingClientRect().width / sketchW;
      setLiveView({ ...d.view, cx: d.view.cx - (e.clientX - d.sx) / k / view.zoom, cy: d.view.cy + (e.clientY - d.sy) / k / view.zoom });
      return;
    }
    if (d?.mode === 'band') {
      d.b = s;
      setBand({ a: d.a, b: s });
      return;
    }
    if (d?.mode === 'points') {
      const w = toW(vp, s.x, s.y);
      d.moved = true;
      pendingDrag.current = new Map([...d.grab].map(([id, o]) => [id, { x: w.x + o.x, y: w.y + o.y }]));
      if (!raf.current) raf.current = requestAnimationFrame(runDrag);
      return;
    }
    if (d?.mode === 'label') {
      const z = view.zoom;
      const c = shown.constraints.find((x) => x.id === d.cid);
      d.moved = true;
      const dx = (e.clientX - d.sx) / z, dy = -(e.clientY - d.sy) / z;
      const offset = c?.type === 'angle' ? { x: d.orig.x + (dx + dy) / 2, y: 0 } : { x: d.orig.x + dx, y: d.orig.y + dy };
      setLiveOffset({ cid: d.cid, offset });
      return;
    }
    if (tool === 'select' || tool === 'dim') {
      const pick = hitTest(geo, toW(vp, s.x, s.y), SNAP_PX / view.zoom);
      setHover(pick?.id ?? null);
    } else if (draft) setDraft({ ...draft, cur: snapRef(e) });
    else {
      const r = snapRef(e);
      setHover(r.id ?? r.on ?? null);
    }
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.mode === 'pan') commitView(liveView ?? view);
    else if (d.mode === 'band') {
      setBand(null);
      const a = toW(vp, Math.min(d.a.x, d.b.x), Math.max(d.a.y, d.b.y)), b = toW(vp, Math.max(d.a.x, d.b.x), Math.min(d.a.y, d.b.y));
      if (Math.abs(d.a.x - d.b.x) < 3 && Math.abs(d.a.y - d.b.y) < 3) return;
      const inside = (id: string) => {
        const p = geo.P.get(id)!;
        return p.x >= a.x && p.x <= b.x && p.y >= a.y && p.y <= b.y;
      };
      const ents = shown.entities.filter((x) => {
        const pts = x.type === 'line' ? [x.p1, x.p2] : x.type === 'arc' ? [x.p1, x.p2] : x.type === 'circle' ? [x.c] : [x.p];
        return pts.every(inside);
      });
      const pts = shown.points.filter((p) => inside(p.id)).map((p) => p.id);
      select([...new Set([...(e.shiftKey ? [...sel] : []), ...ents.map((x) => x.id), ...pts])]);
    } else if (d.mode === 'points') {
      if (raf.current) {
        cancelAnimationFrame(raf.current);
        runDrag();
      }
      if (d.moved && live) commit(live, `cad-drag:${region.id}`);
      setLive(null);
    } else if (d.mode === 'label') {
      if (d.moved && liveOffset) commit({ ...shown, constraints: shown.constraints.map((c) => (c.id === d.cid ? { ...c, offset: liveOffset.offset } : c)) }, `cad-label:${d.cid}`);
      setLiveOffset(null);
    }
  };

  const onLabelDown = (e: React.PointerEvent, c: CadConstraint) => {
    if (!editing) return;
    e.stopPropagation();
    if (e.button !== 0) return;
    select(e.shiftKey ? [...sel, c.id] : [c.id]);
    drag.current = { mode: 'label', cid: c.id, sx: e.clientX, sy: e.clientY, orig: c.offset ?? { x: 0, y: 0 }, moved: false };
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onGlyphDown = (e: React.PointerEvent, c: CadConstraint) => {
    if (!editing) return;
    e.stopPropagation();
    select(e.shiftKey ? [...sel, c.id] : [c.id]);
  };

  // ------------------------------------------------------------ keyboard

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!editing) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT') return;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') {
      handled();
      if (draft) setDraft(null);
      else if (dimPicks.length) setDimPicks([]);
      else if (mine && ui.selected.length) select([]);
      else if (ui.cadTool !== 'select') setTool('select');
      else onDone(false);
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      handled();
      deleteSelected();
      return;
    }
    const k = e.key.toLowerCase();
    const hasSel = mine && ui.selected.length > 0;
    const ct = CONSTRAINT_TOOLS.find((t) => t.key === k);
    if (hasSel && ct && tool === 'select') {
      handled();
      applyConstraint(ct.type as ConstraintType);
      return;
    }
    if (k === 'x') {
      handled();
      toggleConstruction();
      return;
    }
    const t = TOOLS.find((x) => x.key === k && x.key !== ' ');
    if (t) {
      handled();
      setTool(t.tool);
    }
  };

  // ------------------------------------------------------------ DXF / STL

  const importDxf = async () => {
    const file = await pickFile('.dxf');
    if (!file) return;
    try {
      const { dxfToSketch } = await import('../../cad/dxf');
      const { sketch, unit, warnings } = dxfToSketch(await file.text());
      const empty = !region.sketch.entities.length;
      const merged: CadSketch = {
        points: [...shown.points, ...sketch.points],
        entities: [...shown.entities, ...sketch.entities],
        constraints: [...shown.constraints, ...sketch.constraints],
      };
      dispatch({ type: 'update', id: region.id, patch: { sketch: merged, ...(empty && unit ? { unit } : {}) } });
      setMsg(`Imported ${sketch.entities.length} entities from ${file.name}${warnings.length ? ` · ${warnings.join('; ')}` : ''}`);
      window.setTimeout(() => {
        const b = bbox(geoOf(merged));
        if (!b) return;
        const w = Math.max(b.x1 - b.x0, 1e-6), h = Math.max(b.y1 - b.y0, 1e-6);
        commitView({ cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, zoom: Math.min((sketchW - 70) / w, (region.height - 70) / h) });
      }, 0);
    } catch (err) {
      setMsg(`Could not read ${file.name}: ${(err as Error).message}`);
    }
  };

  const fileBase = (region.name.trim() || 'part').replace(/[^\w.-]+/g, '_');

  const exportDxf = async () => {
    const { sketchToDxf } = await import('../../cad/dxf');
    await exportFile(`${fileBase}.dxf`, sketchToDxf(shown, region.unit), 'application/dxf');
  };

  // ------------------------------------------------------------ 3-D

  const mesh: Mesh | null = useMemo(() => {
    if (region.mode === '2d' || !res?.mass) return null;
    try {
      const f = region.feature;
      if (f.type === 'extrude' && res.depth) return extrudeMesh(profiles.regions, res.depth, f.symmetric);
      if (f.type === 'revolve' && res.angle) {
        const axis = revolveAxis(shown, f, geo.P);
        return axis ? revolveMesh(profiles.regions, axis, res.angle) : null;
      }
    } catch {
      return null;
    }
    return null;
  }, [region.mode, region.feature, res?.mass, res?.depth, res?.angle, profiles.regions, shown, geo.P]);

  const exportStl = () => {
    if (!mesh) return;
    import('../../cad/stl').then(({ meshToStl }) => exportFile(`${fileBase}.stl`, meshToStl(mesh, fileBase), 'model/stl'));
  };

  const setMode = (mode: CadRegion['mode']) => {
    dispatch({ type: 'update', id: region.id, patch: { mode } });
    if (mode !== '2d' && region.feature.type === 'none') {
      dispatch({ type: 'update', id: region.id, patch: { feature: { type: 'extrude', depth: '10' } } });
      showProperties();
    }
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
      case 'point': return determined.has(e.p);
    }
  };
  const picked = new Set([...sel, ...dimPicks]);
  const usedPoints = new Set(shown.entities.flatMap((e) => (e.type === 'line' ? [e.p1, e.p2] : e.type === 'arc' ? [e.c, e.p1, e.p2] : e.type === 'circle' ? [e.c] : [e.p])));

  const draftPath = (() => {
    if (!draft) return '';
    const [a] = draft.refs;
    const cur = draft.cur.p;
    const S = (p: Vec2) => toS(vp, p);
    if (draft.tool === 'line') {
      const last = draft.refs[draft.refs.length - 1].p;
      const p = S(last), q = S(cur);
      return `M${p.x} ${p.y}L${q.x} ${q.y}`;
    }
    if (draft.tool === 'rect') {
      const p = S(a.p), q = S(cur);
      return `M${p.x} ${p.y}H${q.x}V${q.y}H${p.x}Z`;
    }
    if (draft.tool === 'circle' || (draft.tool === 'arc' && draft.refs.length === 1)) {
      const c = S(a.p), r = Math.hypot(cur.x - a.p.x, cur.y - a.p.y) * z;
      return draft.tool === 'circle'
        ? `M${c.x - r} ${c.y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`
        : `M${c.x} ${c.y}L${S(cur).x} ${S(cur).y}`;
    }
    if (draft.tool === 'arc') {
      const st = draft.refs[1].p;
      const r = Math.hypot(st.x - a.p.x, st.y - a.p.y);
      const a0 = Math.atan2(st.y - a.p.y, st.x - a.p.x);
      let a1 = Math.atan2(cur.y - a.p.y, cur.x - a.p.x);
      while (a1 <= a0) a1 += 2 * Math.PI;
      const p = S(st), q = S({ x: a.p.x + r * Math.cos(a1), y: a.p.y + r * Math.sin(a1) });
      return `M${p.x} ${p.y}A${r * z} ${r * z} 0 ${a1 - a0 > Math.PI ? 1 : 0} 0 ${q.x} ${q.y}`;
    }
    return '';
  })();
  const draftLen = draft && (draft.tool === 'line' || draft.tool === 'circle')
    ? Math.hypot(draft.cur.p.x - draft.refs[draft.refs.length - 1].p.x, draft.cur.p.y - draft.refs[draft.refs.length - 1].p.y)
    : null;

  const status = (() => {
    if (res?.error) return { cls: 'bad', text: res.error };
    if (!shown.entities.length) return { cls: '', text: editing ? 'Draw with the line, rectangle, circle and arc tools, then add constraints and dimensions' : 'Empty CAD part' };
    if (!res) return { cls: '', text: 'Solving…' };
    if (!res.ok) return { cls: 'bad', text: `Over-defined: ${res.conflicting.length} conflicting constraint${res.conflicting.length > 1 ? 's' : ''} (red)` };
    const parts: string[] = [];
    parts.push(res.dof === 0 ? 'Fully defined' : `${res.dof} degree${res.dof > 1 ? 's' : ''} of freedom left`);
    if (res.redundant.length) parts.push(`${res.redundant.length} redundant`);
    if (Object.keys(res.dimErrors).length) parts.push(`${Object.keys(res.dimErrors).length} dimension error${Object.keys(res.dimErrors).length > 1 ? 's' : ''}`);
    if (res.section) parts.push(`A = ${+res.section.A.toPrecision(5)} ${region.unit}²`);
    if (res.mass?.m !== undefined) parts.push(`m = ${+res.mass.m.toPrecision(4)} kg`);
    if (res.issues.length) parts.push(res.issues[0]);
    if (res.featureError) parts.push(res.featureError);
    return { cls: res.dof === 0 && !res.featureError ? 'ok' : res.featureError || Object.keys(res.dimErrors).length ? 'warn' : '', text: parts.join(' · ') };
  })();

  const cursor = !editing ? undefined : tool === 'pan' ? 'grab' : tool === 'select' ? 'default' : 'crosshair';
  const origin = toS(vp, { x: 0, y: 0 });

  return (
    <div ref={wrapRef} className={`sketch-region cad-region${editing ? ' editing' : ''}`} style={{ width: region.width }} tabIndex={editing ? 0 : -1} onKeyDown={onKeyDown}>
      {editing && (
        <div className="sk-toolbar cad-toolbar" role="toolbar" aria-label="CAD tools" onPointerDown={(e) => e.stopPropagation()}>
          <div className="cad-row">
            <button className={`icon-btn${region.mode === '2d' ? ' on' : ''}`} title="Sketch (2-D)" aria-label="Sketch view" onClick={() => setMode('2d')}><PenTool size={16} /></button>
            <button className={`icon-btn${split ? ' on' : ''}`} title="Sketch and 3-D model side by side" aria-label="Split view" onClick={() => setMode('split')}><Columns2 size={16} /></button>
            <button className={`icon-btn${region.mode === '3d' ? ' on' : ''}`} title="3-D model (extrude or revolve in the Properties panel)" aria-label="3-D view" onClick={() => setMode('3d')}><Box size={16} /></button>
            <span className="sk-sep" />
            {region.mode !== '3d' && TOOLS.map(({ tool: t, icon: Icon, label }) => (
              <button key={t} className={`icon-btn${ui.cadTool === t && mine ? ' on' : ''}`} title={label} aria-label={label} aria-pressed={ui.cadTool === t && mine} onClick={() => setTool(t)}>
                <Icon size={16} />
              </button>
            ))}
            {region.mode !== '3d' && tool === 'dim' && (
              <select value={dimKind} onChange={(e) => setDimKind(e.target.value as DimKind)} aria-label="Dimension type">
                <option value="smart">Smart</option>
                <option value="horizontal">Horizontal</option>
                <option value="vertical">Vertical</option>
              </select>
            )}
            {region.mode !== '3d' && (
              <button className={`icon-btn${ui.cadConstruction ? ' on' : ''}`} title="Construction geometry (X): toggles the selection, or draws new geometry as construction" aria-label="Construction" onClick={toggleConstruction}>
                <Construction size={16} />
              </button>
            )}
            <span className="sk-sep" />
            {region.mode !== '3d' && <button className="icon-btn" title="Fit the drawing into the frame" aria-label="Fit" onClick={fit}><Maximize size={16} /></button>}
            {region.mode !== '3d' && <button className="icon-btn" title="Import DXF (lines, arcs, circles, polylines)" aria-label="Import DXF" onClick={importDxf}><FileUp size={16} /></button>}
            {region.mode !== '3d' && <button className="icon-btn text-icon" title="Export the sketch as DXF" aria-label="Export DXF" onClick={exportDxf}><FileDown size={16} /><small>DXF</small></button>}
            {region.mode !== '2d' && <button className="icon-btn text-icon" title="Export the solid as STL (3-D printing)" aria-label="Export STL" disabled={!mesh} onClick={exportStl}><FileDown size={16} /><small>STL</small></button>}
            {region.mode !== '3d' && <button className="icon-btn" title="Delete selected (Del)" aria-label="Delete selected" disabled={!mine || !ui.selected.length} onClick={deleteSelected}><Trash2 size={16} /></button>}
            <button className="icon-btn" title="Done (Esc)" aria-label="Done" onClick={() => onDone(false)}><Check size={16} /></button>
          </div>
          {region.mode !== '3d' && (
            <div className="cad-row" aria-label="Constraints">
              {CONSTRAINT_TOOLS.map((t) => (
                <button key={t.type} className="icon-btn cad-cbtn" title={`${t.label}: ${t.help}`} aria-label={t.label} onClick={() => applyConstraint(t.type as ConstraintType)}>
                  {t.glyph}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="cad-body">
      {region.mode !== '2d' && (
        // orbiting only while editing: otherwise clicks select and move the region like any other
        <div className={`cad-3d${split ? ' split' : ''}`} style={{ pointerEvents: editing ? undefined : 'none', order: 2 }} onPointerDown={(e) => editing && e.stopPropagation()}>
          <Cad3DView
            mesh={mesh} width={region.width - (split ? sketchW : 0)} height={region.height} yaw={region.view3d.yaw} pitch={region.view3d.pitch}
            onView={(v) => dispatch({ type: 'update', id: region.id, patch: { view3d: v }, history: false })}
            unitLabel={region.unit}
            message={region.feature.type === 'none' ? 'Choose Extrude or Revolve in the Properties panel' : res?.featureError ?? (profiles.regions.length ? undefined : 'The sketch has no closed profile')}
          />
        </div>
      )}
      {region.mode !== '3d' && (
        <svg
          ref={svgRef} width={sketchW} height={region.height} className="sk-svg cad-svg" style={{ cursor }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onPointerLeave={() => setHover(null)}
          onContextMenu={(e) => { if (editing) { e.preventDefault(); setDraft(null); } }}
          onDoubleClick={(e) => { if (editing && draft) { e.preventDefault(); setDraft(null); } }}
        >
          {editing && (
            <g className="cad-axes" pointerEvents="none">
              <line x1={0} y1={origin.y} x2={sketchW} y2={origin.y} />
              <line x1={origin.x} y1={0} x2={origin.x} y2={region.height} />
            </g>
          )}
          <ProfileFill regions={profiles.regions} vp={vp} />
          {shown.entities.map((ent) => {
            if (ent.type === 'point') return null;
            const cls = [
              'cad-ent',
              ent.construction ? 'cons' : '',
              entDetermined(ent) ? 'det' : '',
              badEnts.has(ent.id) ? 'bad' : '',
              picked.has(ent.id) ? 'sel' : '',
              hover === ent.id ? 'hover' : '',
            ].filter(Boolean).join(' ');
            return <path key={ent.id} d={entityPath(geo, ent, vp)} className={cls} />;
          })}
          {editing && shown.points.map((p) => {
            if (!usedPoints.has(p.id)) return null;
            const s = toS(vp, p);
            const isCentre = shown.entities.some((e) => (e.type === 'circle' || e.type === 'arc') && e.c === p.id);
            const cls = ['cad-pt', determined.has(p.id) ? 'det' : '', badEnts.has(p.id) ? 'bad' : '', picked.has(p.id) ? 'sel' : '', hover === p.id ? 'hover' : ''].filter(Boolean).join(' ');
            return isCentre
              ? <path key={p.id} d={`M${s.x - 4} ${s.y}h8M${s.x} ${s.y - 4}v8`} className={`${cls} ctr`} />
              : <rect key={p.id} x={s.x - 2.6} y={s.y - 2.6} width={5.2} height={5.2} className={cls} />;
          })}
          {!editing && shown.entities.filter((e) => e.type === 'point').map((e) => {
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
                <text
                  x={dd.at.x} y={dd.at.y} className="cad-dim-text" textAnchor="middle" dominantBaseline="middle"
                  onPointerDown={(e) => onLabelDown(e, c)}
                  onDoubleClick={(e) => { if (!editing) return; e.stopPropagation(); setEditDim({ cid: c.id, text: c.value ?? '' }); }}
                >
                  {dd.text}
                </text>
              </g>
            );
          })}
          {editing && glyphs(geo, vp).map((gl, i) => (
            <g key={`${gl.c.id}${i}`} className={`cad-glyph${conflicting.has(gl.c.id) ? ' bad' : ''}${redundant.has(gl.c.id) ? ' warn' : ''}${picked.has(gl.c.id) ? ' sel' : ''}`}
              transform={`translate(${gl.at.x} ${gl.at.y})`} onPointerDown={(e) => onGlyphDown(e, gl.c)}>
              <rect x={-6.5} y={-6.5} width={13} height={13} rx={3} />
              <text textAnchor="middle" dominantBaseline="central">{gl.text}</text>
            </g>
          ))}
          {draftPath && <path d={draftPath} className="cad-draft" />}
          {draft && draftLen !== null && (
            <text x={toS(vp, draft.cur.p).x + 12} y={toS(vp, draft.cur.p).y - 10} className="cad-draft-len">{+draftLen.toPrecision(4)}</text>
          )}
          {band && <rect className="sk-band" x={Math.min(band.a.x, band.b.x)} y={Math.min(band.a.y, band.b.y)} width={Math.abs(band.a.x - band.b.x)} height={Math.abs(band.a.y - band.b.y)} />}
        </svg>
      )}
      </div>
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
      {(editing || status.cls === 'bad') && <div className={`sk-status cad-status ${status.cls}`}>{msg || status.text}</div>}
      {(editing || regionSelected) && (
        <div className="resize-handle sk-resize" onPointerDown={startResize} title="Drag to resize (the drawing scales with it)" aria-label="Resize CAD region" />
      )}
    </div>
  );

}
