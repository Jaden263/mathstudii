// A beam or plane frame on the page. Double-click to edit: draw members, click to place
// supports, hinges and loads (a value field opens right at the load), then switch the
// diagram strip below to reactions, N, V, M or the deflected shape.
import { useEffect, useMemo, useRef, useState, type Dispatch, type JSX, type ReactNode } from 'react';
import { MousePointer2, Slash, Maximize, Trash2, Check, Magnet, ArrowDown, RotateCcw, CircleDot } from 'lucide-react';
import type { BeamRegion } from '../../model/types';
import type { RegionResult } from '../../engine/evaluator';
import type { BeamResult } from '../../beam/evaluate';
import {
  beamId, loadCase, loadPoint, nextLabel, removeItems, splitMember,
  type BeamData, type BeamDiagram, type BeamLoad, type BeamMember, type BeamPanel, type BeamView as View,
} from '../../beam/model';
import type { Action } from '../store';
import { useSketchUI, type BeamTool } from '../sketch/context';
import {
  Diagram, FrameMultiples, LoadGlyph, Reactions, STRIP_H, StackedDiagrams, SupportGlyph, autoPanels, fitView, fmt, fmtAlpha, modeShown, stackLayout, toS, toW, units,
  type P2, type Vp,
} from './beamDraw';
import { straightBeam } from '../../beam/evaluate';

interface Props {
  region: BeamRegion;
  result?: RegionResult;
  editing: boolean;
  selected: boolean;
  dispatch: Dispatch<Action>;
  onDone: (moveBelow?: boolean) => void;
}

const SNAP_PX = 10;
/** Width at which the drawing is shown at its natural size. */
const BASE_W = 560;

function Glyph({ children }: { children: ReactNode }) {
  return <svg width={18} height={18} viewBox="-10 -10 20 20" className="bm-tool-glyph" aria-hidden>{children}</svg>;
}

const TOOLS: { tool: BeamTool; label: string; title: string; icon: JSX.Element }[] = [
  { tool: 'select', label: 'Select', title: 'Select, move nodes, double-click a load to change its value (V)', icon: <MousePointer2 size={16} /> },
  { tool: 'member', label: 'Member', title: 'Draw members: click points, Esc or right-click to stop (B)', icon: <Slash size={16} /> },
  { tool: 'pin', label: 'Pin', title: 'Pinned support: holds x and y (P)', icon: <Glyph><path d="M0 -6 L-6 4 L6 4 Z" /><line x1={-8} y1={6} x2={8} y2={6} /></Glyph> },
  { tool: 'roller', label: 'Roller', title: 'Roller: holds one direction (R)', icon: <Glyph><path d="M0 -7 L-6 2 L6 2 Z" /><circle cx={-3} cy={5} r={1.8} /><circle cx={3} cy={5} r={1.8} /><line x1={-8} y1={8} x2={8} y2={8} /></Glyph> },
  { tool: 'fixed', label: 'Fixed', title: 'Fixed support: holds x, y and rotation (X)', icon: <Glyph><line x1={-8} y1={0} x2={8} y2={0} /><line x1={-6} y1={0} x2={-9} y2={5} /><line x1={-1} y1={0} x2={-4} y2={5} /><line x1={4} y1={0} x2={1} y2={5} /><line x1={9} y1={0} x2={6} y2={5} /></Glyph> },
  { tool: 'hinge', label: 'Hinge', title: 'Hinge at a node: members turn freely there (G)', icon: <CircleDot size={16} /> },
  { tool: 'force', label: 'Force', title: 'Point load on a node or member (F)', icon: <ArrowDown size={16} /> },
  { tool: 'line', label: 'Line load', title: 'Distributed load: click a member, or drag along it for part of it (Q)', icon: <Glyph><line x1={-8} y1={-6} x2={8} y2={-6} /><path d="M-6 -6 V3 M-8 1 L-6 4 L-4 1 M0 -6 V3 M-2 1 L0 4 L2 1 M6 -6 V3 M4 1 L6 4 L8 1" /></Glyph> },
  { tool: 'moment', label: 'Moment', title: 'Concentrated moment (M)', icon: <RotateCcw size={16} /> },
];
const KEYS: Record<string, BeamTool> = { v: 'select', b: 'member', p: 'pin', r: 'roller', x: 'fixed', g: 'hinge', f: 'force', q: 'line', m: 'moment' };

const DIAGRAMS: { id: BeamDiagram; label: string; title: string }[] = [
  { id: 'model', label: 'Model', title: 'The structure and its loads' },
  { id: 'reactions', label: 'Reactions', title: 'Support reactions' },
  { id: 'N', label: 'N', title: 'Normal (axial) force, tension positive' },
  { id: 'V', label: 'V', title: 'Shear force' },
  { id: 'M', label: 'M', title: 'Bending moment, drawn on the tension side' },
  { id: 'deflection', label: 'δ', title: 'Deflected shape (exaggerated)' },
  { id: 'mode', label: 'Buckling', title: 'Buckling mode (normalised) and its load factor α_cr' },
];

type Hit =
  | { kind: 'node'; id: string; p: P2 }
  | { kind: 'member'; id: string; t: number; p: P2 }
  | { kind: 'support'; id: string }
  | { kind: 'load'; id: string };

type Drag =
  | { mode: 'node'; id: string; moved: boolean; base: BeamData }
  | { mode: 'line'; member: string; t0: number; t1: number; sx: number; sy: number }
  | { mode: 'pan'; sx: number; sy: number; view: View };

/** Members point left → right (or upwards), so their +y side is up or to the left. */
function orient(d: BeamData, m: BeamMember): BeamMember {
  const a = d.nodes.find((q) => q.id === m.a)!, b = d.nodes.find((q) => q.id === m.b)!;
  const flip = b.x < a.x - 1e-12 || (Math.abs(b.x - a.x) <= 1e-12 && b.y < a.y);
  return flip ? { ...m, a: m.b, b: m.a, hingeA: m.hingeB, hingeB: m.hingeA } : m;
}

export function BeamView({ region, result, editing, selected: regionSelected, dispatch, onDone }: Props) {
  const { ui, setUi, showProperties, separate } = useSketchUI();
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const res = result?.kind === 'beam' ? (result as BeamResult) : undefined;
  const data: BeamData = { nodes: region.nodes, members: region.members, supports: region.supports, loads: region.loads };
  const mine = ui.regionId === region.id;
  const sel = useMemo(() => new Set(mine ? ui.selected : []), [mine, ui.selected]);
  const tool: BeamTool = editing && mine ? ui.beamTool : 'select';
  const [liveView, setLiveView] = useState<View | null>(null);
  const [chainFrom, setChainFrom] = useState<string | P2 | null>(null);
  const [cursor, setCursor] = useState<{ p: P2; snap: Hit | null } | null>(null);
  const [lineDrag, setLineDrag] = useState<{ member: string; t0: number; t1: number } | null>(null);
  const [edit, setEdit] = useState<{ id: string; field: 'value' | 'q1' | 'q2'; text: string } | null>(null);
  const drag = useRef<Drag | null>(null);
  const editRef = useRef(edit);
  editRef.current = edit;
  // load cases: what is shown, the lower envelope bound, the case new loads go into
  const lc = region.loadCases;
  const lcView = res?.view;
  const low = lcView === 'envelope' ? res?.envelope?.min : undefined;
  const newCase = lc ? (lc.cases.find((c) => c.id === lc.view)?.id ?? lc.cases[0]?.id) : undefined;
  const loadLook = (l: BeamLoad): { faded: boolean; tag?: string } => {
    if (!lc) return { faded: false };
    const cid = loadCase(l, lc);
    const tag = lc.cases.find((c) => c.id === cid)?.name;
    if (!lcView || lcView === 'envelope') return { faded: false, tag };
    if (lc.cases.some((c) => c.id === lcView)) return { faded: cid !== lcView, tag };
    const f = lc.combos.find((c) => c.id === lcView)?.factors[cid]?.trim();
    return { faded: !f || f === '0', tag };
  };

  // diagrams under the structure: the structure gets the top of the region
  const stacked = (region.layout ?? 'stack') === 'stack';
  const segs = useMemo(() => straightBeam(region), [region.nodes, region.members]); // eslint-disable-line react-hooks/exhaustive-deps
  const kinds = region.panels ?? autoPanels(res);
  const hasPanels = stacked && region.members.length > 0 && kinds.length > 0;
  // The drawing scales with its region like a picture: it is laid out at a logical size
  // (560 px wide at scale 1) and the SVG viewBox maps that onto the region, so text,
  // lines, symbols and diagrams all grow and shrink together with the frame.
  const stripH = stacked && region.members.length > 0 ? STRIP_H : 0; // logical height of the diagram strip
  const nPanels = hasPanels ? kinds.length : 0;
  const naturalH = nPanels ? stackLayout(0, BASE_W, nPanels, !!segs).required - STRIP_H : 300 - stripH;
  const kW = region.width / BASE_W;
  const k = Math.min(3, Math.max(0.5, Math.min(kW, region.height / (naturalH + stripH))));
  const W = region.width / k, svgH = region.height / k - stripH;
  const lay = stackLayout(svgH + STRIP_H, W, nPanels, !!segs);
  const modelH = stacked && region.members.length > 0 ? lay.modelH : svgH;

  // the page shows the structure framed; while editing the view stays put
  // stacked line loads (G and Q on one span) need room above the structure
  const maxStack = useMemo(() => region.loads.reduce((m, _l, i) => Math.max(m, lineStack(region.loads, i)), 0), [region.loads]);
  const fitMargins = { l: 100, r: 100, t: 70 + maxStack * 46, b: 100 };
  const autoView = useMemo(() => fitView(data, W, modelH, fitMargins), [region.nodes, W, modelH, maxStack]); // eslint-disable-line react-hooks/exhaustive-deps
  const view = liveView ?? (editing ? region.view : autoView ?? region.view);
  const vp: Vp = { view, width: W, height: modelH };

  // a new set of diagrams makes the region tall enough for them (pushing what is below down)
  const growKey = hasPanels ? `${kinds.join(',')}|${segs ? 'beam' : 'frame'}` : '';
  const grown = useRef('');
  useEffect(() => {
    if (!growKey || grown.current === growKey) return;
    grown.current = growKey;
    // tall enough for the panels at the current width's scale
    const want = Math.round((naturalH + stripH) * kW);
    if (region.height < want - 4) {
      dispatch({ type: 'update', id: region.id, patch: { height: want }, history: false });
      window.setTimeout(() => separate(), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [growKey]);
  const u = units(region);

  const commit = (d: BeamData, coalesce?: string) => dispatch({ type: 'update', id: region.id, patch: d, coalesce });
  const set = (patch: Partial<BeamRegion>, history = true) => dispatch({ type: 'update', id: region.id, patch, ...(history ? {} : { history: false as const }) });
  const select = (ids: string[]) => setUi({ regionId: region.id, selected: ids });

  // entering edit mode frames the structure
  useEffect(() => {
    if (!editing) {
      setChainFrom(null);
      setEdit(null);
      return;
    }
    if (autoView) set({ view: autoView }, false);
    wrapRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  useEffect(() => {
    setChainFrom(null);
  }, [ui.beamTool]);

  // ------------------------------------------------------------ hit testing

  const screenOf = (e: { clientX: number; clientY: number }): P2 => {
    const rect = svgRef.current!.getBoundingClientRect();
    const k = rect.width / W;
    return { x: (e.clientX - rect.left) / k, y: (e.clientY - rect.top) / k };
  };
  const nodeById = (id: string) => region.nodes.find((q) => q.id === id);

  const hitTest = (s: P2, kinds: Hit['kind'][]): Hit | null => {
    let best: { h: Hit; d: number } | null = null;
    const consider = (h: Hit, d: number, tol = SNAP_PX) => {
      if (d <= tol && (!best || d < best.d)) best = { h, d };
    };
    if (kinds.includes('load')) {
      for (const l of region.loads) {
        if (l.type === 'line') {
          const m = region.members.find((q) => q.id === l.member);
          const a = m && nodeById(m.a), b = m && nodeById(m.b);
          if (!a || !b) continue;
          const A = toS(vp, a), B = toS(vp, b);
          const t1 = l.t1 ?? 0, t2 = l.t2 ?? 1;
          const P1 = { x: A.x + (B.x - A.x) * t1, y: A.y + (B.y - A.y) * t1 - 30 }, P2_ = { x: A.x + (B.x - A.x) * t2, y: A.y + (B.y - A.y) * t2 - 30 };
          consider({ kind: 'load', id: l.id }, segDist(s, P1, P2_), 8);
        } else {
          const p = loadPoint(data, l.at);
          if (!p) continue;
          const q = toS(vp, p);
          if (l.type === 'moment') consider({ kind: 'load', id: l.id }, Math.abs(Math.hypot(s.x - q.x, s.y - q.y) - 16), 6);
          else {
            const ang = (l.angle * Math.PI) / 180;
            const from = { x: q.x - Math.cos(ang) * 44, y: q.y + Math.sin(ang) * 44 };
            consider({ kind: 'load', id: l.id }, segDist(s, from, { x: q.x - Math.cos(ang) * 8, y: q.y + Math.sin(ang) * 8 }), 7);
          }
        }
      }
    }
    if (kinds.includes('support')) {
      for (const sp of region.supports) {
        const q = nodeById(sp.node);
        if (!q) continue;
        const c = toS(vp, q);
        const a = (sp.angle * Math.PI) / 180;
        const mid = { x: c.x + Math.sin(a) * 11, y: c.y + Math.cos(a) * 11 };
        consider({ kind: 'support', id: sp.id }, Math.hypot(s.x - mid.x, s.y - mid.y), 11);
      }
    }
    if (kinds.includes('node')) {
      for (const q of region.nodes) {
        const c = toS(vp, q);
        consider({ kind: 'node', id: q.id, p: { x: q.x, y: q.y } }, Math.hypot(s.x - c.x, s.y - c.y) - 2);
      }
    }
    if (best) return (best as { h: Hit }).h;
    if (kinds.includes('member')) {
      for (const m of region.members) {
        const a = nodeById(m.a), b = nodeById(m.b);
        if (!a || !b) continue;
        const A = toS(vp, a), B = toS(vp, b);
        const L2 = (B.x - A.x) ** 2 + (B.y - A.y) ** 2;
        const t = L2 > 0 ? Math.max(0, Math.min(1, ((s.x - A.x) * (B.x - A.x) + (s.y - A.y) * (B.y - A.y)) / L2)) : 0;
        const P = { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t };
        consider({ kind: 'member', id: m.id, t, p: toW(vp, P) }, Math.hypot(s.x - P.x, s.y - P.y), 7);
      }
    }
    return best ? (best as { h: Hit }).h : null;
  };

  /** Where a click lands while drawing: a node, a point on a member, or the (snapped) grid. */
  const snapPoint = (s: P2, alt: boolean): { p: P2; snap: Hit | null } => {
    const h = hitTest(s, ['node', 'member']);
    if (h && (h.kind === 'node' || h.kind === 'member')) {
      if (h.kind === 'member' && region.snap && !alt) {
        // round the position along the member to the grid
        const m = region.members.find((q) => q.id === h.id)!;
        const a = nodeById(m.a)!, b = nodeById(m.b)!;
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        const step = region.grid / L;
        const t = Math.min(1, Math.max(0, Math.round(h.t / step) * step));
        return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, snap: { ...h, t } };
      }
      return { p: h.p, snap: h };
    }
    let w = toW(vp, s);
    if (region.snap && !alt && region.grid > 0) w = { x: Math.round(w.x / region.grid) * region.grid, y: Math.round(w.y / region.grid) * region.grid };
    // a chain keeps to horizontal / vertical when close
    if (chainFrom) {
      const from = typeof chainFrom === 'string' ? nodeById(chainFrom) : chainFrom;
      if (from) {
        if (Math.abs(w.y - from.y) * view.zoom < 8) w = { ...w, y: from.y };
        if (Math.abs(w.x - from.x) * view.zoom < 8) w = { ...w, x: from.x };
      }
    }
    return { p: w, snap: null };
  };

  /** A node at a snapped spot: existing node, split member, or a new free node. */
  const nodeAt = (d: BeamData, at: { p: P2; snap: Hit | null }): { data: BeamData; node: string } => {
    if (at.snap?.kind === 'node') return { data: d, node: at.snap.id };
    if (at.snap?.kind === 'member') {
      const t = at.snap.t;
      const m = d.members.find((q) => q.id === at.snap!.id)!;
      if (t < 1e-9) return { data: d, node: m.a };
      if (t > 1 - 1e-9) return { data: d, node: m.b };
      return splitMember(d, m.id, t);
    }
    const existing = d.nodes.find((q) => Math.abs(q.x - at.p.x) < 1e-9 && Math.abs(q.y - at.p.y) < 1e-9);
    if (existing) return { data: d, node: existing.id };
    const id = beamId('n');
    return { data: { ...d, nodes: [...d.nodes, { id, x: at.p.x, y: at.p.y }] }, node: id };
  };

  // ------------------------------------------------------------ actions

  const placeSupport = (type: 'pin' | 'roller' | 'fixed', at: { p: P2; snap: Hit | null }) => {
    if (!at.snap) return;
    const r = nodeAt(data, at);
    const old = r.data.supports.find((s) => s.node === r.node);
    const sp = { id: old?.id ?? beamId('s'), node: r.node, type, angle: old?.angle ?? 0, label: old?.label ?? nextLabel(r.data.supports) };
    commit({ ...r.data, supports: [...r.data.supports.filter((s) => s.node !== r.node), sp] });
    select([sp.id]);
  };

  const toggleHinge = (nodeId: string) => {
    const at = region.members.filter((m) => m.a === nodeId || m.b === nodeId);
    if (at.length < 2) return;
    const any = at.some((m) => (m.a === nodeId && m.hingeA) || (m.b === nodeId && m.hingeB));
    // a hinge releases every member end at the node but one
    const members = region.members.map((m) => {
      const k = at.indexOf(m);
      if (k < 0) return m;
      const on = !any && k > 0;
      return m.a === nodeId ? { ...m, hingeA: on || undefined } : { ...m, hingeB: on || undefined };
    });
    commit({ ...data, members });
  };

  const placeLoad = (kind: 'force' | 'moment', at: { p: P2; snap: Hit | null }) => {
    if (!at.snap || (at.snap.kind !== 'node' && at.snap.kind !== 'member')) return;
    const where = at.snap.kind === 'node' ? { node: at.snap.id } : { member: at.snap.id, t: at.snap.t };
    const id = beamId('l');
    const cs = newCase ? { case: newCase } : {};
    const l: BeamLoad = kind === 'force' ? { id, type: 'force', at: where, value: '10', angle: -90, ...cs } : { id, type: 'moment', at: where, value: '10', ...cs };
    commit({ ...data, loads: [...data.loads, l] });
    select([id]);
    setEdit({ id, field: 'value', text: '10' });
  };

  const placeLine = (member: string, t0: number, t1: number) => {
    const id = beamId('l');
    const [a, b] = t0 <= t1 ? [t0, t1] : [t1, t0];
    const partial = b - a > 0.02 && (a > 0.001 || b < 0.999);
    const l: BeamLoad = { id, type: 'line', member, q1: '5', dir: 'global', ...(partial ? { t1: +a.toFixed(6), t2: +b.toFixed(6) } : {}), ...(newCase ? { case: newCase } : {}) };
    commit({ ...data, loads: [...data.loads, l] });
    select([id]);
    setEdit({ id, field: 'q1', text: '5' });
  };

  const addMember = (at: { p: P2; snap: Hit | null }) => {
    if (!chainFrom) {
      // the first click only remembers where the member starts
      setChainFrom(at.snap?.kind === 'node' ? at.snap.id : at.snap?.kind === 'member' ? (() => {
        const r = nodeAt(data, at);
        commit(r.data);
        return r.node;
      })() : at.p);
      return;
    }
    let d = data;
    let start: string;
    if (typeof chainFrom === 'string') start = chainFrom;
    else {
      const r = nodeAt(d, { p: chainFrom, snap: null });
      d = r.data;
      start = r.node;
    }
    const r = nodeAt(d, at);
    d = r.data;
    if (r.node === start) return;
    if (d.members.some((m) => (m.a === start && m.b === r.node) || (m.b === start && m.a === r.node))) {
      setChainFrom(r.node);
      return;
    }
    const m = orient(d, { id: beamId('m'), a: start, b: r.node });
    d = { ...d, members: [...d.members, m] };
    commit(d);
    setChainFrom(r.node);
    // the first member frames the view
    if (!region.members.length) {
      const v = fitView(d, W, modelH, fitMargins);
      if (v) set({ view: v }, false);
    }
  };

  const deleteSelected = () => {
    if (!mine || !ui.selected.length) return;
    commit(removeItems(data, new Set(ui.selected)));
    select([]);
  };

  const fit = () => {
    const v = fitView(data, W, modelH, fitMargins);
    if (v) set({ view: v }, false);
  };

  // ------------------------------------------------------------ pointer

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!editing) return;
    e.stopPropagation();
    // keep focus where we put it: the value field of a new load must not lose it to the click
    e.preventDefault();
    if (!editRef.current) wrapRef.current?.focus({ preventScroll: true });
    const s = screenOf(e);
    // the diagrams under the structure are not part of the drawing
    if (s.y > modelH && !drag.current) {
      if (tool === 'select') select([]);
      return;
    }
    if (e.button === 1 || (e.button === 0 && e.altKey && tool === 'select')) {
      drag.current = { mode: 'pan', sx: s.x, sy: s.y, view };
      svgRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button === 2) {
      setChainFrom(null);
      return;
    }
    // a click while a value is open just confirms it
    if (editRef.current) {
      commitEdit();
      return;
    }
    const at = snapPoint(s, e.altKey);
    switch (tool) {
      case 'member': addMember(at); break;
      case 'pin': case 'roller': case 'fixed': placeSupport(tool, at); break;
      case 'hinge': if (at.snap?.kind === 'node') toggleHinge(at.snap.id); break;
      case 'force': case 'moment': placeLoad(tool, at); break;
      case 'line': {
        const h = hitTest(s, ['member']);
        if (h?.kind === 'member') {
          drag.current = { mode: 'line', member: h.id, t0: h.t, t1: h.t, sx: s.x, sy: s.y };
          setLineDrag({ member: h.id, t0: h.t, t1: h.t });
          svgRef.current?.setPointerCapture(e.pointerId);
        }
        break;
      }
      case 'select': {
        const h = hitTest(s, ['load', 'support', 'node', 'member']);
        if (!h) {
          if (!e.shiftKey) select([]);
          drag.current = { mode: 'pan', sx: s.x, sy: s.y, view };
          svgRef.current?.setPointerCapture(e.pointerId);
          return;
        }
        select(e.shiftKey ? [...new Set([...(mine ? ui.selected : []), h.id])] : [h.id]);
        if (h.kind === 'node') {
          drag.current = { mode: 'node', id: h.id, moved: false, base: data };
          svgRef.current?.setPointerCapture(e.pointerId);
        }
        showProperties();
        break;
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!editing) return;
    const s = screenOf(e);
    const dr = drag.current;
    if (dr?.mode === 'pan') {
      setLiveView({ ...dr.view, cx: dr.view.cx - (s.x - dr.sx) / dr.view.zoom, cy: dr.view.cy + (s.y - dr.sy) / dr.view.zoom });
      return;
    }
    if (dr?.mode === 'node') {
      let w = toW(vp, s);
      if (region.snap && !e.altKey && region.grid > 0) w = { x: Math.round(w.x / region.grid) * region.grid, y: Math.round(w.y / region.grid) * region.grid };
      dr.moved = true;
      commit({ ...dr.base, nodes: dr.base.nodes.map((q) => (q.id === dr.id ? { ...q, x: w.x, y: w.y } : q)) }, `move:${dr.id}`);
      return;
    }
    if (dr?.mode === 'line') {
      const m = region.members.find((q) => q.id === dr.member)!;
      const A = toS(vp, nodeById(m.a)!), B = toS(vp, nodeById(m.b)!);
      const L2 = (B.x - A.x) ** 2 + (B.y - A.y) ** 2;
      let t = Math.max(0, Math.min(1, ((s.x - A.x) * (B.x - A.x) + (s.y - A.y) * (B.y - A.y)) / L2));
      if (region.snap && !e.altKey) {
        const Lw = Math.hypot(nodeById(m.b)!.x - nodeById(m.a)!.x, nodeById(m.b)!.y - nodeById(m.a)!.y);
        const step = region.grid / Lw;
        t = Math.min(1, Math.max(0, Math.round(t / step) * step));
        dr.t0 = Math.min(1, Math.max(0, Math.round(dr.t0 / step) * step));
      }
      dr.t1 = t;
      setLineDrag({ member: dr.member, t0: dr.t0, t1: t });
      return;
    }
    if (s.y > modelH) {
      setCursor(null);
      return;
    }
    setCursor(snapPoint(s, e.altKey));
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const dr = drag.current;
    drag.current = null;
    if (dr?.mode === 'pan' && liveView) {
      set({ view: liveView }, false);
      setLiveView(null);
    }
    if (dr?.mode === 'node' && dr.moved) separate();
    if (dr?.mode === 'line') {
      const s = screenOf(e);
      const moved = Math.hypot(s.x - dr.sx, s.y - dr.sy) > 6;
      placeLine(dr.member, moved ? dr.t0 : 0, moved ? dr.t1 : 1);
      setLineDrag(null);
    }
  };

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!editing) return;
    e.stopPropagation();
    if (tool === 'member') {
      setChainFrom(null);
      return;
    }
    const h = hitTest(screenOf(e), ['load']);
    if (h?.kind === 'load') {
      const l = region.loads.find((q) => q.id === h.id)!;
      setEdit(l.type === 'line' ? { id: l.id, field: 'q1', text: l.q1 } : { id: l.id, field: 'value', text: l.value });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!editing || (e.target as HTMLElement).tagName === 'INPUT') return;
    // keys belong to the beam while it is edited (Delete must not remove the region)
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (chainFrom) setChainFrom(null);
      else onDone(false);
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelected();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = KEYS[e.key.toLowerCase()];
    if (t) {
      e.preventDefault();
      setUi({ regionId: region.id, beamTool: t });
    }
  };

  const commitEdit = () => {
    const ed = editRef.current;
    if (!ed) return;
    editRef.current = null;
    const text = ed.text.trim() || '0';
    const old = data.loads.find((l) => l.id === ed.id) as Record<string, unknown> | undefined;
    if (old && old[ed.field] !== text) commit({ ...data, loads: data.loads.map((l) => (l.id === ed.id ? ({ ...l, [ed.field]: text } as BeamLoad) : l)) });
    setEdit(null);
    wrapRef.current?.focus({ preventScroll: true });
  };

  const startResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const sheet = (e.currentTarget as HTMLElement).closest('.sheet') as HTMLElement | null;
    const pageZoom = sheet ? sheet.getBoundingClientRect().width / sheet.offsetWidth : 1;
    const start = { x: e.clientX, y: e.clientY, w: region.width, h: region.height };
    const move = (ev: PointerEvent) => {
      const w = Math.max(260, Math.round(start.w + (ev.clientX - start.x) / pageZoom));
      const h = Math.max(160, Math.round(start.h + (ev.clientY - start.y) / pageZoom));
      dispatch({ type: 'update', id: region.id, coalesce: `resize:${region.id}`, patch: { width: w, height: h } });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      separate(`resize:${region.id}`);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ------------------------------------------------------------ render

  const show = region.show;
  // buckling modes exist with the buckling or the second-order option
  const buckling = !!(region.analysis?.buckling || region.analysis?.secondOrder);
  const mode = modeShown(region, res);
  const diagramOn = !stacked && show !== 'model' && show !== 'reactions' && (show === 'mode' ? !!mode : !!res?.solution);
  const reactionsOn = !!res?.solution && (stacked ? !!region.reactions : show === 'reactions');
  const togglePanel = (k: BeamPanel) => {
    const order: BeamPanel[] = ['N', 'V', 'M', 'deflection', 'mode'];
    const next = kinds.includes(k) ? kinds.filter((x) => x !== k) : order.filter((x) => x === k || kinds.includes(x));
    set({ panels: next }, false);
  };
  const N = new Map(region.nodes.map((q) => [q.id, q]));
  const hingeAt = new Set<string>();
  for (const m of region.members) {
    if (m.hingeA) hingeAt.add(`${m.id}|a`);
    if (m.hingeB) hingeAt.add(`${m.id}|b`);
  }
  const editLoad = edit && region.loads.find((l) => l.id === edit.id);
  const editPos = (() => {
    if (!editLoad) return null;
    if (editLoad.type === 'line') {
      const m = region.members.find((q) => q.id === editLoad.member);
      if (!m) return null;
      const a = toS(vp, N.get(m.a)!), b = toS(vp, N.get(m.b)!);
      const t = ((editLoad.t1 ?? 0) + (editLoad.t2 ?? 1)) / 2;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t - 52 };
    }
    const p = loadPoint(data, editLoad.at);
    return p ? { x: toS(vp, p).x, y: toS(vp, p).y - 66 } : null;
  })();
  const draftFrom = chainFrom ? (typeof chainFrom === 'string' ? N.get(chainFrom) : chainFrom) : null;
  const sol = res?.solution;
  const cursorStyle = !editing ? undefined : tool === 'select' ? 'default' : 'crosshair';
  const unitHint = editLoad ? (editLoad.type === 'force' ? region.forceUnit : editLoad.type === 'moment' ? `${region.forceUnit}·${region.lengthUnit}` : `${region.forceUnit}/${region.lengthUnit}`) : '';

  return (
    <div ref={wrapRef} className={`sketch-region beam-region${editing ? ' editing' : ''}`} style={{ width: region.width, height: region.height }} tabIndex={editing ? 0 : -1} onKeyDown={onKeyDown}>
      {editing && (
        <div className="sk-toolbar bm-toolbar" role="toolbar" aria-label="Beam tools" onPointerDown={(e) => e.stopPropagation()}>
          {TOOLS.map((t) => (
            <button key={t.tool} className={`bm-tool${ui.beamTool === t.tool ? ' on' : ''}`} title={t.title} aria-label={t.label} aria-pressed={ui.beamTool === t.tool}
              onClick={() => { setUi({ regionId: region.id, beamTool: t.tool }); wrapRef.current?.focus({ preventScroll: true }); }}>
              {t.icon}<span>{t.label}</span>
            </button>
          ))}
          <span className="sk-sep" />
          <button className={`icon-btn${region.snap ? ' on' : ''}`} title={`Snap to the ${region.grid} ${region.lengthUnit} grid (hold Alt to place freely)`} aria-label="Snap to grid" onClick={() => set({ snap: !region.snap })}><Magnet size={16} /></button>
          <button className="icon-btn" title="Fit the structure into the frame" aria-label="Fit" onClick={fit}><Maximize size={16} /></button>
          <button className="icon-btn" title="Delete selected (Del)" aria-label="Delete selected" disabled={!mine || !ui.selected.length} onClick={deleteSelected}><Trash2 size={16} /></button>
          <button className="icon-btn" title="Done (Esc)" aria-label="Done" onClick={() => onDone(false)}><Check size={16} /></button>
        </div>
      )}
      <svg
        ref={svgRef} width={region.width} height={svgH * k} viewBox={`0 0 ${W} ${svgH}`} className="sk-svg bm-svg" style={{ cursor: cursorStyle }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onPointerLeave={() => setCursor(null)} onDoubleClick={onDoubleClick} onContextMenu={(e) => editing && e.preventDefault()}
        role="img" aria-label={region.name ? `Beam ${region.name}` : 'Beam'}
      >
        {editing && region.grid > 0 && <BeamGrid vp={vp} step={region.grid} />}
        {hasPanels && res && (res.solution || mode) && (segs
          ? <StackedDiagrams r={region} d={data} res={res} vp={vp} top={modelH} layout={lay} kinds={kinds} segs={segs} width={W} low={low} />
          : <FrameMultiples r={region} d={data} res={res} top={modelH} layout={lay} kinds={kinds} width={W} low={low} />)}
        {hasPanels && !res?.solution && !mode && (
          <g>
            <line x1={0} y1={modelH} x2={W} y2={modelH} className="bm-panel-sep" />
            <text x={W / 2} y={modelH + (svgH - modelH) / 2} textAnchor="middle" className="bm-empty">
              {res?.error ? `No diagrams yet: ${res.error}` : 'Add supports and loads to see the diagrams'}
            </text>
          </g>
        )}
        {diagramOn && <Diagram r={region} d={data} vp={vp} res={res!} kind={show as 'N' | 'V' | 'M' | 'deflection'} low={low} />}
        {/* members */}
        {region.members.map((m) => {
          const a = N.get(m.a), b = N.get(m.b);
          if (!a || !b) return null;
          const A = toS(vp, a), B = toS(vp, b);
          const L = Math.hypot(B.x - A.x, B.y - A.y) || 1;
          const dir = { x: (B.x - A.x) / L, y: (B.y - A.y) / L };
          const err = res?.errors[m.id];
          return (
            <g key={m.id} className={`bm-member${sel.has(m.id) ? ' sel' : ''}${err ? ' err' : ''}${diagramOn ? ' faint' : ''}`}>
              <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} />
              {hingeAt.has(`${m.id}|a`) && <circle cx={A.x + dir.x * 7} cy={A.y + dir.y * 7} r={4} className="bm-hinge" />}
              {hingeAt.has(`${m.id}|b`) && <circle cx={B.x - dir.x * 7} cy={B.y - dir.y * 7} r={4} className="bm-hinge" />}
            </g>
          );
        })}
        {/* supports */}
        {region.supports.map((sp) => {
          const q = N.get(sp.node);
          if (!q) return null;
          const c = toS(vp, q);
          const a = (sp.angle * Math.PI) / 180;
          return (
            <g key={sp.id}>
              <SupportGlyph at={c} type={sp.type} angle={sp.angle} cls={sel.has(sp.id) ? 'sel' : ''} spring={!!sp.k?.trim()} rotSpring={sp.type === 'fixed' && !!sp.kr?.trim()} />
              <text x={c.x - Math.cos(a) * 16 + Math.sin(a) * 30} y={c.y + Math.sin(a) * 16 + Math.cos(a) * 30 + 4} className="bm-support-label" textAnchor="middle">{sp.label}</text>
            </g>
          );
        })}
        {/* nodes */}
        {region.nodes.map((q) => {
          const c = toS(vp, q);
          return <circle key={q.id} cx={c.x} cy={c.y} r={editing ? 3.2 : 2.2} className={`bm-node${sel.has(q.id) ? ' sel' : ''}`} />;
        })}
        {/* loads or reactions */}
        {(stacked || show !== 'reactions') && region.loads.map((l, i) => (
          <LoadGlyph key={l.id} r={region} d={data} l={l} vp={vp} res={res} sel={sel.has(l.id)} label={!diagramOn} {...loadLook(l)} stack={lineStack(region.loads, i)} />
        ))}
        {reactionsOn && <Reactions r={region} d={data} vp={vp} res={res!} />}
        {/* drafts */}
        {editing && draftFrom && cursor && tool === 'member' && (() => {
          const A = toS(vp, draftFrom), B = toS(vp, cursor.p);
          const L = Math.hypot(cursor.p.x - draftFrom.x, cursor.p.y - draftFrom.y);
          return (
            <g className="bm-draft">
              <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} />
              <text x={(A.x + B.x) / 2 + 6} y={(A.y + B.y) / 2 - 8} className="bm-value">{u.length(L)}</text>
            </g>
          );
        })()}
        {lineDrag && (() => {
          const m = region.members.find((q) => q.id === lineDrag.member)!;
          const A = toS(vp, N.get(m.a)!), B = toS(vp, N.get(m.b)!);
          const p = (t: number) => ({ x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t });
          const p0 = p(lineDrag.t0), p1 = p(lineDrag.t1);
          return <path className="bm-draft" d={`M${p0.x} ${p0.y} L${p0.x} ${p0.y - 28} L${p1.x} ${p1.y - 28} L${p1.x} ${p1.y}`} />;
        })()}
        {editing && cursor && tool !== 'select' && (() => {
          const c = toS(vp, cursor.p);
          return <circle cx={c.x} cy={c.y} r={cursor.snap ? 6 : 2.5} className={`sk-cursor${cursor.snap ? ' snapped' : ''}`} pointerEvents="none" />;
        })()}
        {!region.members.length && (
          <text x={W / 2} y={svgH / 2} textAnchor="middle" className="bm-empty">
            {editing ? 'Click two points to draw a member — then add supports and loads' : 'Empty beam — double-click to draw a structure'}
          </text>
        )}
      </svg>
      {edit && editPos && (
        <div className="bm-edit" style={{ left: Math.min(Math.max(editPos.x * k - 70, 4), region.width - 150), top: Math.max(editPos.y * k - 14, 4) }} onPointerDown={(e) => e.stopPropagation()}>
          <input
            autoFocus value={edit.text} spellCheck={false} aria-label="Load value"
            onChange={(e) => setEdit({ ...edit, text: e.target.value })}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit();
              if (e.key === 'Escape') { setEdit(null); wrapRef.current?.focus({ preventScroll: true }); }
              e.stopPropagation();
            }}
            onBlur={commitEdit}
          />
          <span>{unitHint}</span>
          {lc && (() => {
            const l = data.loads.find((q) => q.id === edit.id);
            if (!l) return null;
            return (
              <select
                className="bm-case" aria-label="Load case" value={loadCase(l, lc)}
                onMouseDown={(e) => e.stopPropagation()}
                onChange={(e) => commit({ ...data, loads: data.loads.map((q) => (q.id === l.id ? ({ ...q, case: e.target.value } as BeamLoad) : q)) })}
              >
                {lc.cases.map((c) => <option key={c.id} value={c.id}>{c.name}{c.label ? ` · ${c.label}` : ''}</option>)}
              </select>
            );
          })()}
        </div>
      )}
      {/* the strip and the summary scale with the drawing */}
      <div className="bm-chrome" style={{ width: W, height: region.height / k, transform: `scale(${k})` }}>
        {editing && <div className="sk-status bm-status">{cursor ? `${fmt(cursor.p.x)}, ${fmt(cursor.p.y)} ${region.lengthUnit}` : `grid ${region.grid} ${region.lengthUnit}`}</div>}
      {region.members.length > 0 && (
          <div className={`bm-tabs${stacked ? ' stacked' : ''}`} role="toolbar" aria-label="Diagrams" onPointerDown={(e) => e.stopPropagation()}>
            {lc && (
              <>
                <select
                  className="bm-view" aria-label="Load case or combination shown" value={lcView ?? ''}
                  title="Show one load case, one combination, or the envelope of the combinations"
                  onChange={(e) => set({ loadCases: { ...lc, view: e.target.value } }, false)}
                >
                  <optgroup label="Combinations">
                    {lc.combos.map((c) => <option key={c.id} value={c.id}>{c.name} = {comboText(c, lc.cases)}</option>)}
                    {lc.combos.length > 1 && <option value="envelope">Envelope (min / max)</option>}
                  </optgroup>
                  <optgroup label="Load cases">
                    {lc.cases.map((c) => <option key={c.id} value={c.id}>{c.name}{c.label ? ` · ${c.label}` : ''}</option>)}
                  </optgroup>
                </select>
                <span className="bm-tab-sep" />
              </>
            )}
            <span className="bm-seg">
              <button className={stacked ? 'on' : ''} title="Diagrams neatly under the structure" onClick={(e) => { e.stopPropagation(); set({ layout: 'stack' }, false); }}>Under</button>
              <button className={!stacked ? 'on' : ''} title="One diagram at a time, drawn on the structure" onClick={(e) => { e.stopPropagation(); set({ layout: 'overlay' }, false); }}>On structure</button>
            </span>
            <span className="bm-tab-sep" />
            {stacked ? (
              <>
                {(['N', 'V', 'M', 'deflection', ...(buckling ? ['mode'] : [])] as BeamPanel[]).map((k) => (
                  <button key={k} className={kinds.includes(k) ? 'on' : ''} aria-pressed={kinds.includes(k)} title={DIAGRAMS.find((d) => d.id === k)?.title}
                    onClick={(e) => { e.stopPropagation(); togglePanel(k); }}>{k === 'deflection' ? 'δ' : k === 'mode' ? 'Buckling' : k}</button>
                ))}
                <button className={region.reactions ? 'on' : ''} aria-pressed={!!region.reactions} title="Show the support reactions on the structure"
                  onClick={(e) => { e.stopPropagation(); set({ reactions: !region.reactions }, false); }}>Reactions</button>
              </>
            ) : DIAGRAMS.filter((dg) => dg.id !== 'mode' || buckling).map((dg) => (
              <button key={dg.id} role="tab" aria-selected={show === dg.id} className={show === dg.id ? 'on' : ''} title={dg.title}
                disabled={dg.id === 'mode' ? !mode : dg.id !== 'model' && !res?.solution} onClick={(e) => { e.stopPropagation(); set({ show: dg.id }, false); }}>{dg.label}</button>
            ))}
            {mode && mode.count > 1 && (stacked ? kinds.includes('mode') : show === 'mode') && (
              <>
                <span className="bm-tab-sep" />
                <select
                  className="bm-view" aria-label="Buckling mode shown" value={mode.index} title="Which buckling mode is drawn"
                  onChange={(e) => set({ analysis: { ...region.analysis, mode: Number(e.target.value) } }, false)}
                >
                  {res!.buckling!.modes.map((m, i) => <option key={i} value={i}>Mode {i + 1} · α {fmtAlpha(m.alpha)}</option>)}
                </select>
              </>
            )}
          </div>
        )}
        {sol && !lc && !(stacked && kinds.includes('mode')) && (
          <div className={`bm-summary${stacked && region.members.length > 0 ? ' in-strip' : ''}`}>
            {sol.max.M && <span>M<sub>max</sub> {u.moment(sol.max.M.value)}</span>}
            {sol.max.V && !(stacked && region.members.length > 0) && <span>V<sub>max</sub> {u.force(sol.max.V.value)}</span>}
            {sol.max.w && <span>δ<sub>max</sub> {u.defl(sol.max.w.value)}</span>}
            {sol.max.sigma && !(stacked && region.members.length > 0) && <span>σ<sub>max</sub> {u.stress(sol.max.sigma.value)}</span>}
            {res?.buckling && <span>α<sub>cr</sub> {fmtAlpha(res.buckling.modes[0]?.alpha ?? Infinity)}</span>}
          </div>
        )}
      </div>
      {(editing || regionSelected) && <div className="resize-handle sk-resize" onPointerDown={startResize} title="Drag to resize" aria-label="Resize beam" />}
      {(res?.error || (res && Object.keys(res.errors).length > 0)) && (
        <div className="region-error" role="alert">{res.error ?? Object.values(res.errors)[0]}</div>
      )}
    </div>
  );
}

/** How many earlier line loads overlap this one on the same member (it is drawn above them). */
function lineStack(loads: BeamLoad[], i: number): number {
  const l = loads[i];
  if (l.type !== 'line') return 0;
  const a = l.t1 ?? 0, b = l.t2 ?? 1;
  let n = 0;
  for (let k = 0; k < i; k++) {
    const q = loads[k];
    if (q.type === 'line' && q.member === l.member && (q.t1 ?? 0) < b - 1e-9 && (q.t2 ?? 1) > a + 1e-9) n++;
  }
  return n;
}

/** "1.35 G + 1.5 Q" */
function comboText(c: { factors: Record<string, string> }, cases: { id: string; name: string }[]): string {
  const parts = cases.flatMap((k) => {
    const f = c.factors[k.id]?.trim();
    if (!f || f === '0') return [];
    return [f === '1' ? k.name : `${f} ${k.name}`];
  });
  return parts.join(' + ') || '0';
}

function segDist(p: P2, a: P2, b: P2): number {
  const L2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / L2)) : 0;
  return Math.hypot(p.x - (a.x + (b.x - a.x) * t), p.y - (a.y + (b.y - a.y) * t));
}

function BeamGrid({ vp, step }: { vp: Vp; step: number }) {
  const px = step * vp.view.zoom;
  if (px < 6) return null;
  const tl = toW(vp, { x: 0, y: 0 }), br = toW(vp, { x: vp.width, y: vp.height });
  const lines: string[] = [];
  for (let x = Math.ceil(tl.x / step) * step; x <= br.x; x += step) {
    const s = toS(vp, { x, y: 0 }).x;
    lines.push(`M${s.toFixed(1)} 0V${vp.height}`);
  }
  for (let y = Math.ceil(br.y / step) * step; y <= tl.y; y += step) {
    const s = toS(vp, { x: 0, y }).y;
    lines.push(`M0 ${s.toFixed(1)}H${vp.width}`);
  }
  const o = toS(vp, { x: 0, y: 0 });
  return (
    <g pointerEvents="none">
      <path d={lines.join('')} className="bm-grid" />
      <path d={`M${o.x} 0V${vp.height}M0 ${o.y}H${vp.width}`} className="bm-axis" />
    </g>
  );
}
