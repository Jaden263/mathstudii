// A beam or plane frame on the page. Click it to edit: draw members, click to place
// supports, hinges and loads (a value field opens right at the load), then switch the
// diagram strip below to reactions, N, V, M or the deflected shape. While editing, the
// wheel or a pinch zooms the drawing about the pointer, and dragging empty space, the
// middle button or Space + drag pans it; loads are picked anywhere on their glyph.
import { useEffect, useMemo, useRef, useState, type Dispatch, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MousePointer2, Slash, Maximize, Trash2, Check, Magnet, ArrowDown, RotateCcw, CircleDot, ZoomIn, ZoomOut, Ruler, Pencil, SlidersHorizontal } from 'lucide-react';
import type { BeamRegion } from '../../model/types';
import type { RegionResult } from '../../engine/evaluator';
import type { BeamResult } from '../../beam/evaluate';
import {
  beamId, loadCase, nextLabel, removeItems, splitMember,
  type BeamData, type BeamDiagram, type BeamLoad, type BeamMember, type BeamPanel, type BeamView as View, type LoadAt,
} from '../../beam/model';
import { readNumber } from '../../beam/units';
import type { Action } from '../store';
import { useSketchUI, type BeamTool } from '../sketch/context';
import { ContextMenu, type MenuItem, type MenuState } from '../ContextMenu';
import {
  Diagram, FrameMultiples, LENGTH_M, LoadGlyph, Reactions, STRIP_H, StackedDiagrams, SupportGlyph, autoPanels, fitView, fmt, fmtAlpha, loadText, modeShown, stackLayout, units,
} from './beamDraw';
import { ZOOM_STEP, gridLines, panBy, pinchView, toS, toW, wheelFactor, wheelPixels, zoomAt, zoomLimits, type P2, type Vp } from './beamGeom';
import { boxPick, lineStack, loadShape, pick, pickScene, type Pick } from './beamPick';
import { beamKey } from './beamKeys';
import { BeamUnitsFields } from './BeamUnits';
import { lowerBound, straightBeam } from '../../beam/evaluate';
import { trainLoads } from '../../beam/influence';
import { solveStructure } from '../../beam/solve';
import { InfluencePanels, SectionMarks, TrainGlyph } from './beamInfluence';

type LineLoad = Extract<BeamLoad, { type: 'line' }>;

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
  { tool: 'select', label: 'Select', title: 'Select (V): click anything, Shift+click for more, Shift+drag a box; drag nodes and loads, double-click a load for its value, right-click for its menu. Drag empty space to pan', icon: <MousePointer2 size={16} /> },
  { tool: 'member', label: 'Member', title: 'Draw members: click points, Esc or right-click to stop (B)', icon: <Slash size={16} /> },
  { tool: 'pin', label: 'Pin', title: 'Pinned support: holds x and y (P)', icon: <Glyph><path d="M0 -6 L-6 4 L6 4 Z" /><line x1={-8} y1={6} x2={8} y2={6} /></Glyph> },
  { tool: 'roller', label: 'Roller', title: 'Roller: holds one direction (R)', icon: <Glyph><path d="M0 -7 L-6 2 L6 2 Z" /><circle cx={-3} cy={5} r={1.8} /><circle cx={3} cy={5} r={1.8} /><line x1={-8} y1={8} x2={8} y2={8} /></Glyph> },
  { tool: 'fixed', label: 'Fixed', title: 'Fixed support: holds x, y and rotation (X)', icon: <Glyph><line x1={-8} y1={0} x2={8} y2={0} /><line x1={-6} y1={0} x2={-9} y2={5} /><line x1={-1} y1={0} x2={-4} y2={5} /><line x1={4} y1={0} x2={1} y2={5} /><line x1={9} y1={0} x2={6} y2={5} /></Glyph> },
  { tool: 'hinge', label: 'Hinge', title: 'Hinge at a node: members turn freely there (G)', icon: <CircleDot size={16} /> },
  { tool: 'force', label: 'Force', title: 'Point load on a node or member (F)', icon: <ArrowDown size={16} /> },
  { tool: 'line', label: 'Line load', title: 'Distributed load: click a member, or drag along it for part of it (Q)', icon: <Glyph><line x1={-8} y1={-6} x2={8} y2={-6} /><path d="M-6 -6 V3 M-8 1 L-6 4 L-4 1 M0 -6 V3 M-2 1 L0 4 L2 1 M6 -6 V3 M4 1 L6 4 L8 1" /></Glyph> },
  { tool: 'moment', label: 'Moment', title: 'Concentrated moment (M)', icon: <RotateCcw size={16} /> },
];

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
  | { kind: 'member'; id: string; t: number; p: P2 };

type Drag =
  | { mode: 'node'; id: string; moved: boolean; base: BeamData }
  | { mode: 'line'; member: string; t0: number; t1: number; sx: number; sy: number }
  | { mode: 'pan'; sx: number; sy: number; view: View; moved: boolean }
  /** A selection box; `add`: what was selected before (Shift). */
  | { mode: 'band'; a: P2; b: P2; add: string[] }
  /** A point load or moment moved along its member (or onto another node or member). */
  | { mode: 'load'; id: string; sx: number; sy: number; moved: boolean; base: BeamData }
  /** The start (0) or end (1) of a line load moved along its member. */
  | { mode: 'grip'; id: string; end: 0 | 1; sx: number; sy: number; moved: boolean; base: BeamData }
  | { mode: 'pinch'; ids: [number, number]; start: [P2, P2]; view: View };

/** The value box of a load: its fields as typed, and the one that has the focus. */
interface Edit {
  id: string;
  fields: Record<string, string>;
  focus: string;
}

const DIRECTIONS: [number, string][] = [[-90, 'Down ↓'], [90, 'Up ↑'], [0, 'Right →'], [180, 'Left ←']];
const KIND_NAME = { node: 'node', member: 'member', support: 'support', load: 'load' } as const;

/** The fields of a load's value box. */
function editFields(l: BeamLoad): Record<string, string> {
  if (l.type === 'line') return { q1: l.q1, q2: l.q2 ?? '' };
  if (l.type === 'force') return { value: l.value, angle: String(l.angle) };
  return { value: l.value };
}

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
  const unitsRef = useRef<HTMLSpanElement>(null);
  const res = result?.kind === 'beam' ? (result as BeamResult) : undefined;
  const data: BeamData = { nodes: region.nodes, members: region.members, supports: region.supports, loads: region.loads };
  const mine = ui.regionId === region.id;
  const sel = useMemo(() => new Set(mine ? ui.selected : []), [mine, ui.selected]);
  const tool: BeamTool = editing && mine ? ui.beamTool : 'select';
  const [liveView, setLiveView] = useState<View | null>(null);
  const [chainFrom, setChainFrom] = useState<string | P2 | null>(null);
  const [cursor, setCursor] = useState<{ p: P2; snap: Hit | null } | null>(null);
  const [lineDrag, setLineDrag] = useState<{ member: string; t0: number; t1: number } | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  /** What a click would pick (select tool). */
  const [hover, setHover] = useState<Pick | null>(null);
  const [band, setBand] = useState<{ a: P2; b: P2 } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [space, setSpace] = useState(false);
  const [grabbing, setGrabbing] = useState(false);
  const [unitsOpen, setUnitsOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const drag = useRef<Drag | null>(null);
  const editRef = useRef(edit);
  editRef.current = edit;
  /** Touch points on the drawing (two of them pinch). */
  const touches = useRef(new Map<number, P2>());
  /** A click on the page that started editing: what it was on is picked once editing. */
  const pendingPick = useRef<P2 | null>(null);
  // the latest region and selection, for menus and window listeners that outlive a render
  const live = useRef({ region, ui });
  live.current = { region, ui };
  // load cases: what is shown, the lower envelope bound, the case new loads go into
  const lc = region.loadCases;
  const lcView = res?.view;
  // a moving load shown: its envelope, or with the train placed, the response to the train there
  const traffic = region.traffic;
  const movings = traffic?.loads ?? [];
  const moving = traffic?.view && lcView === traffic.view ? res?.traffic?.moving.find((m) => m.id === traffic.view) : undefined;
  const [train, setTrain] = useState<{ id: string; lead: number; dir: 1 | -1 } | null>(null);
  const trainAt = moving?.P.length && train?.id === moving.id ? train : null;
  const instant = useMemo(() => {
    const tr = res?.traffic;
    if (!trainAt || !tr || !moving) return undefined;
    try {
      return solveStructure({ ...tr.structure, loads: trainLoads(tr.path, tr.structure, moving, trainAt.lead, trainAt.dir) });
    } catch {
      return undefined;
    }
  }, [trainAt, res?.traffic, moving]);
  const shown = res && instant ? { ...res, solution: instant } : res;
  const low = instant ? undefined : lowerBound(res);
  const newCase = lc ? (lc.cases.find((c) => c.id === lc.view)?.id ?? lc.cases[0]?.id) : undefined;
  const loadLook = (l: BeamLoad): { faded: boolean; tag?: string } => {
    if (moving) return { faded: true };
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
  // influence lines get full-width panels below the diagrams
  const nIL = stacked && region.members.length > 0 && !traffic?.hideLines ? traffic?.lines.length ?? 0 : 0;
  const hasPanels = stacked && region.members.length > 0 && (kinds.length > 0 || nIL > 0);
  // The drawing scales with its region like a picture: it is laid out at a logical size
  // (560 px wide at scale 1) and the SVG viewBox maps that onto the region, so text,
  // lines, symbols and diagrams all grow and shrink together with the frame.
  const stripH = stacked && region.members.length > 0 ? STRIP_H : 0; // logical height of the diagram strip
  const nPanels = hasPanels ? kinds.length : 0;
  const naturalH = nPanels || nIL ? stackLayout(0, BASE_W, nPanels, !!segs, nIL).required - STRIP_H : 300 - stripH;
  const kW = region.width / BASE_W;
  const k = Math.min(3, Math.max(0.5, Math.min(kW, region.height / (naturalH + stripH))));
  const W = region.width / k, svgH = region.height / k - stripH;
  const lay = stackLayout(svgH + STRIP_H, W, nPanels, !!segs, nIL);
  const modelH = stacked && region.members.length > 0 ? lay.modelH : svgH;

  // The page shows the structure framed; while editing the view is the user's (zoomed and
  // panned by hand it stays so, until Fit), kept in the region without an undo step.
  // stacked line loads (G and Q on one span) need room above the structure
  const maxStack = useMemo(() => region.loads.reduce((m, _l, i) => Math.max(m, lineStack(region.loads, i)), 0), [region.loads]);
  const fitMargins = { l: 100, r: 100, t: 70 + maxStack * 46, b: 100 };
  const autoView = useMemo(() => fitView(data, W, modelH, fitMargins), [region.nodes, W, modelH, maxStack]); // eslint-disable-line react-hooks/exhaustive-deps
  const view = liveView ?? (editing ? region.view : autoView ?? region.view);
  const vp: Vp = { view, width: W, height: modelH };
  const lim = zoomLimits(data, W, region.grid);

  // a new set of diagrams makes the region tall enough for them (pushing what is below down)
  const growKey = hasPanels ? `${kinds.join(',')}|${segs ? 'beam' : 'frame'}|${nIL}` : '';
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
  const note = (text: string) => setMsg(text);
  useEffect(() => {
    if (!msg) return;
    const t = window.setTimeout(() => setMsg(''), 4000);
    return () => window.clearTimeout(t);
  }, [msg]);

  // ------------------------------------------------------------ view

  // a zoom or pan changes the view continuously: it stays local and goes into the region
  // once the gesture rests (no undo step, no recalculation per wheel notch)
  const liveRef = useRef<View | null>(null);
  const viewRef = useRef(view);
  viewRef.current = liveRef.current ?? view;
  const limRef = useRef(lim);
  limRef.current = lim;
  const viewTimer = useRef<number | undefined>(undefined);
  const showView = (v: View | null) => {
    liveRef.current = v;
    setLiveView(v);
  };
  const flushView = () => {
    window.clearTimeout(viewTimer.current);
    const v = liveRef.current;
    if (v) set({ view: v }, false);
    showView(null);
  };
  const setView = (v: View, immediate = false) => {
    showView(v);
    viewRef.current = v;
    window.clearTimeout(viewTimer.current);
    if (immediate) flushView();
    else viewTimer.current = window.setTimeout(flushView, 300);
  };
  const flushRef = useRef(flushView);
  flushRef.current = flushView;
  // unmounting mid-gesture keeps the last view
  useEffect(() => () => {
    if (liveRef.current) flushRef.current();
  }, []);
  const centre = (): P2 => ({ x: W / 2, y: modelH / 2 });
  const zoomStep = (dir: 1 | -1) => setView(zoomAt({ ...vp, view: viewRef.current }, centre(), dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP, lim), true);
  const fit = () => {
    const v = fitView(data, W, modelH, fitMargins);
    if (v) setView(v, true);
  };

  // entering edit mode frames the structure (unless it was zoomed by hand last time)
  useEffect(() => {
    if (!editing) {
      setChainFrom(null);
      setEdit(null);
      setHover(null);
      setBand(null);
      setMenu(null);
      setUnitsOpen(false);
      setSpace(false);
      drag.current = null;
      touches.current.clear();
      if (liveRef.current) flushView();
      return;
    }
    const seen = autoView ?? region.view;
    if (autoView && !region.view.manual) set({ view: autoView }, false);
    wrapRef.current?.focus({ preventScroll: true });
    // a structure that is there opens with the Select tool (a click on a load picks it,
    // it does not start a member); an empty one with the Member tool, ready to draw.
    // The click that started editing picks what it was on.
    const at = pendingPick.current;
    pendingPick.current = null;
    const h = at && region.members.length ? pick(sceneFor({ view: seen, width: W, height: modelH }), at) : null;
    setUi({ regionId: region.id, beamTool: region.members.length ? 'select' : 'member', selected: h ? [h.id] : [] });
    if (h) showProperties();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  useEffect(() => {
    setChainFrom(null);
    setHover(null);
  }, [ui.beamTool]);

  // the wheel zooms the drawing about the pointer while it is edited (the page scrolls
  // otherwise); a trackpad pinch (Ctrl + wheel) too, instead of zooming the page
  useEffect(() => {
    const el = svgRef.current;
    if (!el || !editing) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setMenu(null);
      const rect = el.getBoundingClientRect();
      const kk = rect.width / W;
      const v = viewRef.current;
      if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // a sideways swipe moves the drawing
        setView(panBy(v, -wheelPixels({ deltaY: e.deltaX, deltaMode: e.deltaMode }) / kk, 0));
        return;
      }
      const y = (e.clientY - rect.top) / kk;
      const s = { x: (e.clientX - rect.left) / kk, y: y <= modelH ? y : modelH / 2 };
      setView(zoomAt({ view: v, width: W, height: modelH }, s, wheelFactor(e), limRef.current));
    };
    // two fingers on the drawing are its own: the page must not pinch-zoom or scroll as well
    const onTouch = (e: TouchEvent) => e.stopPropagation();
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouch, { passive: true });
    el.addEventListener('touchmove', onTouch, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouch);
      el.removeEventListener('touchmove', onTouch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, W, modelH]);

  // Delete with the focus outside the drawing (the side panel's buttons, the page) still
  // deletes what is picked in the beam, and never the beam region itself
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'Delete' && e.key !== 'Backspace') || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (!t || wrapRef.current?.contains(t) || document.querySelector('.ctx-menu')) return;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return;
      const other = t.closest?.('[data-region-id]');
      if (other && other.getAttribute('data-region-id') !== region.id) return;
      const { ui: u2 } = live.current;
      if (u2.regionId !== region.id || !u2.selected.length) return;
      // (the worksheet leaves a key alone whose default was prevented)
      e.preventDefault();
      deleteIds(u2.selected);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, region.id]);

  // the units popover closes when the pointer goes down elsewhere
  useEffect(() => {
    if (!unitsOpen) return;
    const close = (e: PointerEvent) => {
      if (!unitsRef.current?.contains(e.target as Node)) setUnitsOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [unitsOpen]);

  // ------------------------------------------------------------ hit testing

  const screenOf = (e: { clientX: number; clientY: number }): P2 => {
    const rect = svgRef.current!.getBoundingClientRect();
    const k = rect.width / W;
    return { x: (e.clientX - rect.left) / k, y: (e.clientY - rect.top) / k };
  };
  // where the pointer last was, to the fraction of a pixel: a double-click or a right-click
  // (mouse events, in whole pixels) picks just what the hover showed there
  const lastPointer = useRef<{ clientX: number; clientY: number } | null>(null);
  const pointOf = (e: { clientX: number; clientY: number }): P2 => {
    const p = lastPointer.current;
    return screenOf(p && Math.abs(p.clientX - e.clientX) < 1.5 && Math.abs(p.clientY - e.clientY) < 1.5 ? p : e);
  };
  const nodeById = (id: string) => region.nodes.find((q) => q.id === id);

  // what is drawn, as the clicks see it
  const show = region.show;
  const diagramOn = !stacked && show !== 'model' && show !== 'reactions' && (show === 'mode' ? !!modeShown(region, res) : !!res?.solution);
  const loadsShown = stacked || show !== 'reactions';
  const labelsOn = !diagramOn && !trainAt;
  const grips = useMemo(() => new Set(region.loads.filter((l) => l.type === 'line' && sel.has(l.id)).map((l) => l.id)), [region.loads, sel]);
  const sceneFor = (v: Vp) => pickScene(region, v, {
    loads: loadsShown, vals: res?.values, grips,
    text: (l) => (labelsOn ? loadText(region, l, res?.values[l.id], loadLook(l).tag) : ''),
    faded: (l) => loadLook(l).faded,
  });
  const scene = sceneFor(vp);

  /** Nodes and members under a drawing point (for snapping what is drawn). */
  const hitTest = (s: P2, kinds: Hit['kind'][]): Hit | null => {
    let best: { h: Hit; d: number } | null = null;
    const consider = (h: Hit, d: number, tol = SNAP_PX) => {
      if (d <= tol && (!best || d < best.d)) best = { h, d };
    };
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

  /** A fraction along a member rounded to the grid (Alt: as it is). */
  const snapT = (memberId: string, t: number, alt: boolean): number => {
    const m = region.members.find((q) => q.id === memberId);
    const a = m && nodeById(m.a), b = m && nodeById(m.b);
    const L = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
    if (!region.snap || alt || !(region.grid > 0) || !(L > 0)) return Math.min(1, Math.max(0, t));
    const step = region.grid / L;
    return Math.min(1, Math.max(0, Math.round(t / step) * step));
  };

  /** Where a drawing point falls along a member: the fraction and how far off it is (drawing px). */
  const along = (memberId: string, s: P2): { t: number; d: number } | null => {
    const m = region.members.find((q) => q.id === memberId);
    const a = m && nodeById(m.a), b = m && nodeById(m.b);
    if (!a || !b) return null;
    const A = toS(vp, a), B = toS(vp, b);
    const L2 = (B.x - A.x) ** 2 + (B.y - A.y) ** 2;
    if (!(L2 > 0)) return null;
    const t = Math.max(0, Math.min(1, ((s.x - A.x) * (B.x - A.x) + (s.y - A.y) * (B.y - A.y)) / L2));
    return { t, d: Math.hypot(s.x - (A.x + (B.x - A.x) * t), s.y - (A.y + (B.y - A.y) * t)) };
  };

  /** Where a click lands while drawing: a node, a point on a member, or the (snapped) grid. */
  const snapPoint = (s: P2, alt: boolean): { p: P2; snap: Hit | null } => {
    const h = hitTest(s, ['node', 'member']);
    if (h && (h.kind === 'node' || h.kind === 'member')) {
      if (h.kind === 'member' && region.snap && !alt) {
        // round the position along the member to the grid
        const m = region.members.find((q) => q.id === h.id)!;
        const a = nodeById(m.a)!, b = nodeById(m.b)!;
        const t = snapT(m.id, h.t, alt);
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
    setEdit({ id, fields: editFields(l), focus: 'value' });
  };

  const placeLine = (member: string, t0: number, t1: number) => {
    const id = beamId('l');
    const [a, b] = t0 <= t1 ? [t0, t1] : [t1, t0];
    const partial = b - a > 0.02 && (a > 0.001 || b < 0.999);
    const l: BeamLoad = { id, type: 'line', member, q1: '5', dir: 'global', ...(partial ? { t1: +a.toFixed(6), t2: +b.toFixed(6) } : {}), ...(newCase ? { case: newCase } : {}) };
    commit({ ...data, loads: [...data.loads, l] });
    select([id]);
    setEdit({ id, fields: editFields(l), focus: 'q1' });
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

  /** Remove these items (and what hangs on them) from the latest region, as one undo step. */
  const deleteIds = (ids: string[]) => {
    const r = live.current.region;
    if (!ids.length) return;
    const d: BeamData = { nodes: r.nodes, members: r.members, supports: r.supports, loads: r.loads };
    const next = removeItems(d, new Set(ids));
    const gone = d.loads.length - next.loads.length + d.members.length - next.members.length + d.supports.length - next.supports.length;
    dispatch({ type: 'update', id: region.id, patch: next });
    setUi({ regionId: region.id, selected: [] });
    setHover(null);
    if (editRef.current && ids.includes(editRef.current.id)) setEdit(null);
    if (gone) note(`Deleted ${gone === 1 ? (next.loads.length < d.loads.length ? 'a load' : 'an item') : `${gone} items`} (Ctrl+Z brings ${gone === 1 ? 'it' : 'them'} back)`);
  };
  const deleteSelected = () => {
    if (mine && ui.selected.length) deleteIds(ui.selected);
  };
  const selectAll = () => select([...region.nodes, ...region.members, ...region.supports, ...region.loads].map((q) => q.id));

  /** Change a load of the latest region. */
  const updLoad = (id: string, patch: Partial<BeamLoad>, coalesce?: string) => {
    const r = live.current.region;
    dispatch({ type: 'update', id: region.id, patch: { loads: r.loads.map((l) => (l.id === id ? ({ ...l, ...patch } as BeamLoad) : l)) }, coalesce });
  };

  /** Open the value box of a load; a click near a line load's end puts the focus on q₂. */
  const openEdit = (id: string, at?: P2) => {
    const l = live.current.region.loads.find((q) => q.id === id);
    if (!l) return;
    let focus = l.type === 'line' ? 'q1' : 'value';
    if (l.type === 'line' && at) {
      const sh = scene.loads.find((x) => x.shape.id === id)?.shape;
      if (sh?.kind === 'line' && Math.hypot(at.x - sh.ends[1].x, at.y - sh.ends[1].y) < Math.hypot(at.x - sh.ends[0].x, at.y - sh.ends[0].y) && (l.q2 ?? '') !== '') focus = 'q2';
    }
    select([id]);
    setEdit({ id, fields: editFields(l), focus });
  };

  const commitEdit = () => {
    const ed = editRef.current;
    if (!ed) return;
    editRef.current = null;
    const l = live.current.region.loads.find((q) => q.id === ed.id);
    if (l) {
      const f = ed.fields;
      let next: BeamLoad;
      if (l.type === 'line') {
        const q2 = f.q2?.trim();
        const nl: LineLoad = { ...l, q1: f.q1?.trim() || '0' };
        if (q2) nl.q2 = q2;
        else delete nl.q2;
        next = nl;
      } else if (l.type === 'force') {
        // the angle in degrees, or with a unit (0.5 rad)
        const a = readNumber(f.angle ?? '', 'deg');
        next = { ...l, value: f.value?.trim() || '0', angle: a === null ? l.angle : a };
      } else next = { ...l, value: f.value?.trim() || '0' };
      if (JSON.stringify(next) !== JSON.stringify(l)) updLoad(l.id, next);
    }
    setEdit(null);
    wrapRef.current?.focus({ preventScroll: true });
  };
  const cancelEdit = () => {
    editRef.current = null;
    setEdit(null);
    wrapRef.current?.focus({ preventScroll: true });
  };

  // ------------------------------------------------------------ pointer

  const startPan = (e: React.PointerEvent<SVGSVGElement>, s: P2) => {
    drag.current = { mode: 'pan', sx: s.x, sy: s.y, view: viewRef.current, moved: false };
    setGrabbing(true);
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  /** A second finger comes down: what the first one was doing is undone. */
  const dropDrag = () => {
    const dr = drag.current;
    if ((dr?.mode === 'node' || dr?.mode === 'load' || dr?.mode === 'grip') && dr.moved) commit(dr.base, `move:${dr.id}`);
    if (dr?.mode === 'band') setBand(null);
    if (dr?.mode === 'line') setLineDrag(null);
    drag.current = null;
    setGrabbing(false);
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!editing) {
      // the click that starts editing: what it is on gets picked once the editor is up
      if (e.button === 0) pendingPick.current = screenOf(e);
      return;
    }
    e.stopPropagation();
    // keep focus where we put it: the value field of a new load must not lose it to the click
    e.preventDefault();
    if (!editRef.current) wrapRef.current?.focus({ preventScroll: true });
    setMenu(null);
    setUnitsOpen(false);
    lastPointer.current = { clientX: e.clientX, clientY: e.clientY };
    const s = screenOf(e);
    if (e.pointerType === 'touch') {
      touches.current.set(e.pointerId, s);
      if (touches.current.size === 2) {
        // two fingers pinch and pan the drawing
        dropDrag();
        const [[i1, p1], [i2, p2]] = [...touches.current];
        drag.current = { mode: 'pinch', ids: [i1, i2], start: [p1, p2], view: viewRef.current };
        svgRef.current?.setPointerCapture(e.pointerId);
        return;
      }
      if (touches.current.size > 2) return;
    }
    // the middle button, Space + drag, Alt + drag pan
    if (e.button === 1 || (e.button === 0 && (space || (e.altKey && tool === 'select')))) {
      startPan(e, s);
      return;
    }
    // the right button's menu comes with the contextmenu event
    if (e.button !== 0) return;
    // a click while a value is open just confirms it
    if (editRef.current) {
      commitEdit();
      return;
    }
    // the diagrams under the structure are not part of the drawing
    if (s.y > modelH) {
      if (tool === 'select' && !e.shiftKey) select([]);
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
        const h = pick(scene, s);
        const add = e.shiftKey || e.ctrlKey || e.metaKey;
        if (!h) {
          // empty space: Shift + drag selects with a box, a plain drag pans
          if (add) {
            drag.current = { mode: 'band', a: s, b: s, add: mine ? ui.selected : [] };
            svgRef.current?.setPointerCapture(e.pointerId);
          } else {
            select([]);
            startPan(e, s);
          }
          return;
        }
        if (h.kind === 'load' && h.grip !== undefined) {
          drag.current = { mode: 'grip', id: h.id, end: h.grip, sx: s.x, sy: s.y, moved: false, base: data };
          svgRef.current?.setPointerCapture(e.pointerId);
          return;
        }
        if (add) {
          const cur = mine ? ui.selected : [];
          select(cur.includes(h.id) ? cur.filter((x) => x !== h.id) : [...cur, h.id]);
          return;
        }
        select([h.id]);
        if (h.kind === 'node') {
          drag.current = { mode: 'node', id: h.id, moved: false, base: data };
          svgRef.current?.setPointerCapture(e.pointerId);
        } else if (h.kind === 'load' && region.loads.find((l) => l.id === h.id)?.type !== 'line') {
          drag.current = { mode: 'load', id: h.id, sx: s.x, sy: s.y, moved: false, base: data };
          svgRef.current?.setPointerCapture(e.pointerId);
        }
        showProperties();
        break;
      }
    }
  };

  /** A point load dragged: along its member, or onto the node or member under the pointer. */
  const moveLoad = (dr: Extract<Drag, { mode: 'load' }>, s: P2, alt: boolean) => {
    const l = dr.base.loads.find((q) => q.id === dr.id);
    if (!l || l.type === 'line') return;
    let at: LoadAt | null = null;
    if ('member' in l.at) {
      const p = along(l.at.member, s);
      if (p && p.d < 40) at = { member: l.at.member, t: snapT(l.at.member, p.t, alt) };
    }
    if (!at) {
      const h = hitTest(s, ['node', 'member']);
      if (h?.kind === 'node') at = { node: h.id };
      else if (h?.kind === 'member') at = { member: h.id, t: snapT(h.id, h.t, alt) };
    }
    if (!at) return;
    dr.moved = true;
    commit({ ...dr.base, loads: dr.base.loads.map((q) => (q.id === dr.id ? ({ ...q, at } as BeamLoad) : q)) }, `move:${dr.id}`);
  };

  /** A line load's start or end dragged along its member. */
  const moveGrip = (dr: Extract<Drag, { mode: 'grip' }>, s: P2, alt: boolean) => {
    const l = dr.base.loads.find((q) => q.id === dr.id);
    if (!l || l.type !== 'line') return;
    const p = along(l.member, s);
    if (!p) return;
    const t = snapT(l.member, p.t, alt);
    let t1 = l.t1 ?? 0, t2 = l.t2 ?? 1;
    const gap = 0.01;
    if (dr.end === 0) t1 = Math.min(t, t2 - gap);
    else t2 = Math.max(t, t1 + gap);
    t1 = +Math.max(0, t1).toFixed(6);
    t2 = +Math.min(1, t2).toFixed(6);
    // the whole member again: no fractions stored, as a load drawn on it
    const next: LineLoad = { ...l, t1, t2 };
    if (t1 <= 1e-6 && t2 >= 1 - 1e-6) {
      delete next.t1;
      delete next.t2;
    }
    dr.moved = true;
    commit({ ...dr.base, loads: dr.base.loads.map((q) => (q.id === dr.id ? next : q)) }, `move:${dr.id}`);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!editing) return;
    lastPointer.current = { clientX: e.clientX, clientY: e.clientY };
    const s = screenOf(e);
    if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) touches.current.set(e.pointerId, s);
    const dr = drag.current;
    if (dr?.mode === 'pinch') {
      const a = touches.current.get(dr.ids[0]), b = touches.current.get(dr.ids[1]);
      if (a && b) showView(pinchView({ view: dr.view, width: W, height: modelH }, dr.start, [a, b], lim));
      return;
    }
    if (dr?.mode === 'pan') {
      if (!dr.moved && Math.hypot(s.x - dr.sx, s.y - dr.sy) < 3) return;
      dr.moved = true;
      showView(panBy(dr.view, s.x - dr.sx, s.y - dr.sy));
      return;
    }
    if (dr?.mode === 'band') {
      dr.b = s;
      setBand({ a: dr.a, b: s });
      return;
    }
    if (dr?.mode === 'node') {
      let w = toW(vp, s);
      if (region.snap && !e.altKey && region.grid > 0) w = { x: Math.round(w.x / region.grid) * region.grid, y: Math.round(w.y / region.grid) * region.grid };
      dr.moved = true;
      commit({ ...dr.base, nodes: dr.base.nodes.map((q) => (q.id === dr.id ? { ...q, x: w.x, y: w.y } : q)) }, `move:${dr.id}`);
      return;
    }
    if (dr?.mode === 'load' || dr?.mode === 'grip') {
      // a click is not a drag: nothing moves until the pointer does
      if (!dr.moved && Math.hypot(s.x - dr.sx, s.y - dr.sy) < 3) return;
      if (dr.mode === 'load') moveLoad(dr, s, e.altKey);
      else moveGrip(dr, s, e.altKey);
      return;
    }
    if (dr?.mode === 'line') {
      const p = along(dr.member, s);
      if (!p) return;
      const t = snapT(dr.member, p.t, e.altKey);
      if (region.snap && !e.altKey) dr.t0 = snapT(dr.member, dr.t0, false);
      dr.t1 = t;
      setLineDrag({ member: dr.member, t0: dr.t0, t1: t });
      return;
    }
    if (s.y > modelH) {
      setCursor(null);
      setHover(null);
      return;
    }
    setCursor(snapPoint(s, e.altKey));
    const h = tool === 'select' && !space ? pick(scene, s) : null;
    setHover((old) => (old?.id === h?.id && old?.kind === h?.kind && (old as { grip?: number } | null)?.grip === (h as { grip?: number } | null)?.grip ? old : h));
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'touch') touches.current.delete(e.pointerId);
    const dr = drag.current;
    if (dr?.mode === 'pinch') {
      if (touches.current.size < 2) {
        drag.current = null;
        if (liveRef.current) setView(liveRef.current, true);
      }
      return;
    }
    drag.current = null;
    if (dr?.mode === 'pan') {
      setGrabbing(false);
      if (dr.moved && liveRef.current) setView(liveRef.current, true);
    }
    if (dr?.mode === 'band') {
      setBand(null);
      if (Math.abs(dr.b.x - dr.a.x) > 3 || Math.abs(dr.b.y - dr.a.y) > 3) {
        const ids = boxPick(scene, dr.a, dr.b);
        select([...new Set([...dr.add, ...ids])]);
        if (ids.length) showProperties();
      }
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
    const s = pointOf(e);
    const h = s.y <= modelH ? pick(scene, s, ['load']) : null;
    if (h) openEdit(h.id, s);
  };

  // ------------------------------------------------------------ right-click menu

  const menuItems = (h: Pick | null, ids: string[]): MenuItem[] => {
    if (!h) {
      return [
        { label: 'Fit', icon: <Maximize size={14} />, shortcut: '0', onClick: fit },
        { label: 'Zoom in', icon: <ZoomIn size={14} />, shortcut: '+', onClick: () => zoomStep(1) },
        { label: 'Zoom out', icon: <ZoomOut size={14} />, shortcut: '−', onClick: () => zoomStep(-1) },
        { separator: true },
        { label: 'Select all', shortcut: 'Ctrl+A', onClick: selectAll },
        ...(ids.length ? [{ label: `Delete selected (${ids.length})`, icon: <Trash2 size={14} />, shortcut: 'Del', danger: true, onClick: () => deleteIds(ids) } as MenuItem] : []),
        { separator: true },
        { label: 'Done', icon: <Check size={14} />, shortcut: 'Esc', onClick: () => onDone(false) },
      ];
    }
    const items: MenuItem[] = [];
    const many = ids.length > 1;
    const l = h.kind === 'load' ? region.loads.find((q) => q.id === h.id) : undefined;
    if (l && !many) {
      items.push({ label: l.type === 'line' ? 'Edit values…' : 'Edit value…', icon: <Pencil size={14} />, shortcut: 'Double-click', onClick: () => openEdit(l.id) });
      if (l.type === 'force') {
        items.push({ label: 'Direction', submenu: DIRECTIONS.map(([a, label]) => ({ label, checked: l.angle === a, onClick: () => updLoad(l.id, { angle: a }) })) });
      }
      if (lc) {
        items.push({ label: 'Load case', submenu: lc.cases.map((c) => ({ label: `${c.name}${c.label ? ` · ${c.label}` : ''}`, checked: loadCase(l, lc) === c.id, onClick: () => updLoad(l.id, { case: c.id }) })) });
      }
    }
    if (h.kind === 'support' && !many) {
      items.push({
        label: 'Turn 90°', icon: <RotateCcw size={14} />,
        onClick: () => {
          const r = live.current.region;
          set({ supports: r.supports.map((sp) => (sp.id === h.id ? { ...sp, angle: (sp.angle + 90) % 360 } : sp)) });
        },
      });
    }
    if (!many) items.push({ label: 'Properties…', icon: <SlidersHorizontal size={14} />, onClick: showProperties });
    items.push({ separator: true });
    items.push({ label: many ? `Delete ${ids.length} items` : `Delete ${KIND_NAME[h.kind]}`, icon: <Trash2 size={14} />, shortcut: 'Del', danger: true, onClick: () => deleteIds(ids) });
    return items;
  };

  const onContextMenu = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!editing) return;
    // the editor's own menu, not the page's or the region's
    e.preventDefault();
    if (tool === 'member' && chainFrom) {
      setChainFrom(null);
      return;
    }
    if (editRef.current) commitEdit();
    const s = pointOf(e);
    const h = s.y <= modelH ? pick(scene, s) : null;
    let ids = mine ? ui.selected : [];
    if (h && !ids.includes(h.id)) {
      ids = [h.id];
      select(ids);
    }
    setMenu({ x: e.clientX, y: e.clientY, items: menuItems(h, ids) });
  };

  // ------------------------------------------------------------ keyboard

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!editing) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const act = beamKey(e);
    // undo, redo, save, page zoom: the worksheet's (a note about what Ctrl+Z would undo is done with)
    if (act.kind === 'pass') {
      if (/^[zy]$/i.test(e.key)) setMsg('');
      return;
    }
    // other keys belong to the beam while it is edited (Delete must not remove the region)
    e.stopPropagation();
    if (act.kind === 'none') return;
    e.preventDefault();
    switch (act.kind) {
      case 'delete': deleteSelected(); break;
      case 'escape':
        // step back: a box or drag, a member being drawn, the selection, then editing
        if (drag.current) dropDrag();
        else if (chainFrom) setChainFrom(null);
        else if (mine && ui.selected.length) select([]);
        else onDone(false);
        break;
      case 'selectAll': selectAll(); break;
      case 'tool': setUi({ regionId: region.id, beamTool: act.tool }); break;
      case 'zoom': zoomStep(act.dir); break;
      case 'fit': fit(); break;
      case 'pan': setView(panBy(viewRef.current, act.dx, act.dy)); break;
      case 'space': setSpace(true); break;
    }
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === ' ') setSpace(false);
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

  // buckling modes exist with the buckling or the second-order option
  const buckling = !!(region.analysis?.buckling || region.analysis?.secondOrder);
  const mode = modeShown(region, res);
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
  // the value box sits just above the load's glyph
  const editPos = (() => {
    if (!editLoad) return null;
    const i = region.loads.indexOf(editLoad);
    const sh = loadShape(data, editLoad, vp, { vals: res?.values[editLoad.id], stack: lineStack(region.loads, i), text: '' });
    if (!sh) return null;
    if (sh.kind === 'line') {
      const top = sh.area[1].y < sh.area[2].y ? sh.area[1] : sh.area[2];
      return { x: (sh.area[1].x + sh.area[2].x) / 2, y: Math.min(top.y, sh.area[0].y, sh.area[3].y) - 22 };
    }
    if (sh.kind === 'moment') return { x: sh.at.x, y: sh.at.y - sh.r - 22 };
    return { x: (sh.arrow.from.x + sh.arrow.to.x) / 2, y: Math.min(sh.arrow.from.y, sh.arrow.to.y) - 22 };
  })();
  const draftFrom = chainFrom ? (typeof chainFrom === 'string' ? N.get(chainFrom) : chainFrom) : null;
  const sol = shown?.solution;
  const hoverLoad = hover?.kind === 'load' ? region.loads.find((l) => l.id === hover.id) : undefined;
  const cursorStyle = !editing ? undefined
    : grabbing ? 'grabbing'
    : space ? 'grab'
    : tool !== 'select' ? 'crosshair'
    : hover?.kind === 'load' && hover.grip !== undefined ? 'ew-resize'
    : hover?.kind === 'node' || (hoverLoad && hoverLoad.type !== 'line') ? 'move'
    : hover ? 'pointer'
    : 'default';
  const unitHint = editLoad ? (editLoad.type === 'force' ? region.forceUnit : editLoad.type === 'moment' ? `${region.forceUnit}·${region.lengthUnit}` : `${region.forceUnit}/${region.lengthUnit}`) : '';
  const hov = (id: string) => editing && hover?.id === id && !sel.has(id);
  const zoomPct = autoView ? Math.round((view.zoom / autoView.zoom) * 100) : 100;
  const status = msg || [
    cursor ? `${fmt(cursor.p.x)}, ${fmt(cursor.p.y)} ${region.lengthUnit}` : `grid ${region.grid} ${region.lengthUnit}`,
    `${zoomPct} %`,
    ...(mine && ui.selected.length > 1 ? [`${ui.selected.length} selected`] : []),
  ].join(' · ');
  const editField = (f: string, label: string, placeholder?: string) => (
    <input
      key={f} autoFocus={edit?.focus === f} value={edit?.fields[f] ?? ''} placeholder={placeholder} spellCheck={false} aria-label={label} className={f === 'angle' ? 'bm-angle' : undefined}
      onChange={(e) => edit && setEdit({ ...edit, fields: { ...edit.fields, [f]: e.target.value } })}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commitEdit();
        if (e.key === 'Escape') cancelEdit();
        e.stopPropagation();
      }}
    />
  );

  return (
    <div ref={wrapRef} className={`sketch-region beam-region${editing ? ' editing' : ''}`} style={{ width: region.width, height: region.height }} tabIndex={editing ? 0 : -1} onKeyDown={onKeyDown} onKeyUp={onKeyUp} onBlur={() => setSpace(false)}>
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
          <button className="icon-btn" title="Zoom out (−) · the wheel or a pinch zooms about the pointer" aria-label="Zoom out" onClick={() => zoomStep(-1)}><ZoomOut size={16} /></button>
          <button className="icon-btn" title="Zoom in (+) · drag empty space, the middle button or Space + drag to pan" aria-label="Zoom in" onClick={() => zoomStep(1)}><ZoomIn size={16} /></button>
          <button className="icon-btn" title="Fit the structure into the frame (0)" aria-label="Fit" onClick={fit}><Maximize size={16} /></button>
          <span className="bm-units-wrap" ref={unitsRef}>
            <button className={`bm-tool bm-units-btn${unitsOpen ? ' on' : ''}`} title="Units of lengths and forces, and of the results" aria-label="Units" aria-expanded={unitsOpen} aria-haspopup="dialog"
              onClick={() => setUnitsOpen((o) => !o)}>
              <Ruler size={16} /><span>{region.lengthUnit}, {region.forceUnit}</span>
            </button>
            {unitsOpen && (
              <div className="bm-pop" role="dialog" aria-label="Units" onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Escape') {
                  setUnitsOpen(false);
                  wrapRef.current?.focus({ preventScroll: true });
                }
              }}>
                <BeamUnitsFields region={region} result={res} dispatch={dispatch} onChanged={note} />
              </div>
            )}
          </span>
          <span className="sk-sep" />
          <button className="icon-btn" title="Delete selected (Del)" aria-label="Delete selected" disabled={!mine || !ui.selected.length} onClick={deleteSelected}><Trash2 size={16} /></button>
          <button className="icon-btn" title="Done (Esc)" aria-label="Done" onClick={() => onDone(false)}><Check size={16} /></button>
        </div>
      )}
      <svg
        ref={svgRef} width={region.width} height={svgH * k} viewBox={`0 0 ${W} ${svgH}`} className="sk-svg bm-svg" style={{ cursor: cursorStyle }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onPointerLeave={() => { setCursor(null); setHover(null); }} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu}
        role="img" aria-label={region.name ? `Beam ${region.name}` : 'Beam'}
      >
        <defs>
          {/* the structure stays above the diagrams, however it is zoomed or panned */}
          <clipPath id={`bm-clip-${region.id}`}><rect x={0} y={0} width={W} height={modelH} /></clipPath>
        </defs>
        {hasPanels && shown && (shown.solution || mode) && (segs
          ? <StackedDiagrams r={region} d={data} res={shown} vp={vp} top={modelH} layout={lay} kinds={kinds} segs={segs} width={W} low={low} />
          : <FrameMultiples r={region} d={data} res={shown} top={modelH} layout={lay} kinds={kinds} width={W} low={low} />)}
        {nIL > 0 && res?.traffic && (
          <InfluencePanels r={region} d={data} res={res} vp={vp} top={modelH + lay.rows * lay.panelH} h={lay.extraH} width={W}
            train={trainAt && moving ? moving.P.map((P, i) => ({ P, x: trainAt.lead - trainAt.dir * moving.offsets[i] })) : undefined} />
        )}
        {hasPanels && !res?.solution && !mode && (
          <g>
            <line x1={0} y1={modelH} x2={W} y2={modelH} className="bm-panel-sep" />
            <text x={W / 2} y={modelH + (svgH - modelH) / 2} textAnchor="middle" className="bm-empty">
              {res?.error ? `No diagrams yet: ${res.error}` : 'Add supports and loads to see the diagrams'}
            </text>
          </g>
        )}
        <g clipPath={`url(#bm-clip-${region.id})`}>
          {editing && region.grid > 0 && <BeamGrid vp={vp} step={region.grid} />}
          {diagramOn && <Diagram r={region} d={data} vp={vp} res={shown!} kind={show as 'N' | 'V' | 'M' | 'deflection'} low={low} />}
          {/* members */}
          {region.members.map((m) => {
            const a = N.get(m.a), b = N.get(m.b);
            if (!a || !b) return null;
            const A = toS(vp, a), B = toS(vp, b);
            const L = Math.hypot(B.x - A.x, B.y - A.y) || 1;
            const dir = { x: (B.x - A.x) / L, y: (B.y - A.y) / L };
            const err = res?.errors[m.id];
            return (
              <g key={m.id} className={`bm-member${sel.has(m.id) ? ' sel' : ''}${hov(m.id) ? ' hover' : ''}${err ? ' err' : ''}${diagramOn ? ' faint' : ''}`}>
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
                <SupportGlyph at={c} type={sp.type} angle={sp.angle} cls={sel.has(sp.id) ? 'sel' : hov(sp.id) ? 'hover' : ''} spring={!!sp.k?.trim()} rotSpring={sp.type === 'fixed' && !!sp.kr?.trim()} />
                <text x={c.x - Math.cos(a) * 16 + Math.sin(a) * 30} y={c.y + Math.sin(a) * 16 + Math.cos(a) * 30 + 4} className="bm-support-label" textAnchor="middle">{sp.label}</text>
              </g>
            );
          })}
          {/* nodes */}
          {region.nodes.map((q) => {
            const c = toS(vp, q);
            return <circle key={q.id} cx={c.x} cy={c.y} r={editing ? 3.2 : 2.2} className={`bm-node${sel.has(q.id) ? ' sel' : ''}${hov(q.id) ? ' hover' : ''}`} />;
          })}
          {/* loads or reactions */}
          {loadsShown && region.loads.map((l, i) => (
            <LoadGlyph key={l.id} r={region} d={data} l={l} vp={vp} res={res} sel={sel.has(l.id)} hover={hov(l.id)} label={labelsOn} {...loadLook(l)} stack={lineStack(region.loads, i)} />
          ))}
          {reactionsOn && <Reactions r={region} d={data} vp={vp} res={shown!} />}
          {nIL > 0 && <SectionMarks r={region} vp={vp} />}
          {trainAt && moving && res && <TrainGlyph r={region} d={data} res={res} vp={vp} moving={moving} lead={trainAt.lead} dir={trainAt.dir} />}
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
          {band && (
            <rect x={Math.min(band.a.x, band.b.x)} y={Math.min(band.a.y, band.b.y)} width={Math.abs(band.b.x - band.a.x)} height={Math.abs(band.b.y - band.a.y)}
              className={`bm-band${band.b.x < band.a.x ? ' crossing' : ''}`} pointerEvents="none" />
          )}
          {!region.members.length && (
            <text x={W / 2} y={svgH / 2} textAnchor="middle" className="bm-empty">
              {editing ? 'Click two points to draw a member — then add supports and loads' : 'Empty beam — double-click to draw a structure'}
            </text>
          )}
        </g>
      </svg>
      {edit && editPos && editLoad && (
        <div
          key={edit.id} className="bm-edit" style={{ left: Math.min(Math.max(editPos.x * k - 80, 4), region.width - 230), top: Math.max(editPos.y * k - 14, 4) }}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={(e) => {
            // leaving the box (not moving between its fields) confirms it
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commitEdit();
          }}
        >
          {editLoad.type === 'line' ? (
            <>
              <span>q₁</span>{editField('q1', 'Line load at the start')}
              <span>q₂</span>{editField('q2', 'Line load at the end (empty: uniform)', '= q₁')}
            </>
          ) : editField('value', editLoad.type === 'moment' ? 'Moment' : 'Load value')}
          <span title="Unit of a bare number; write one to use another (12 kN·m, 2.5 kN/m)">{unitHint}{editLoad.type === 'moment' ? ' ↺' : ''}</span>
          {editLoad.type === 'force' && <><span>∠</span>{editField('angle', 'Direction in degrees (−90 = down)')}<span>°</span></>}
          {lc && (
            <select
              className="bm-case" aria-label="Load case" value={loadCase(editLoad, lc)}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => updLoad(editLoad.id, { case: e.target.value })}
            >
              {lc.cases.map((c) => <option key={c.id} value={c.id}>{c.name}{c.label ? ` · ${c.label}` : ''}</option>)}
            </select>
          )}
        </div>
      )}
      {menu && createPortal(<ContextMenu menu={menu} onClose={() => { setMenu(null); wrapRef.current?.focus({ preventScroll: true }); }} />, document.body)}
      {/* the strip and the summary scale with the drawing */}
      <div className="bm-chrome" style={{ width: W, height: region.height / k, transform: `scale(${k})` }}>
        {moving && moving.P.length > 0 && res?.traffic && (() => {
          // the train's first axle from where it enters to where it leaves
          const tr = res.traffic, len = moving.offsets[moving.offsets.length - 1] ?? 0;
          const x0 = tr.path[0].x0, x1 = tr.path[tr.path.length - 1].x1, Lm = LENGTH_M[region.lengthUnit] ?? 1;
          const start = () => {
            const e = moving.env?.extremes.M_max;
            return { id: moving.id, lead: e?.lead ?? (x0 + x1) / 2, dir: e?.dir ?? 1 } as const;
          };
          const dir = trainAt?.dir ?? 1;
          const lo = dir === 1 ? x0 : x0 - len, hi = dir === 1 ? x1 + len : x1;
          return (
            <div className="bm-tabs bm-train" role="toolbar" aria-label="Moving load position" onPointerDown={(e) => e.stopPropagation()}>
              <button className={!trainAt ? 'on' : ''} title="Upper and lower bound over every position" onClick={() => setTrain(null)}>Envelope</button>
              <button className={trainAt ? 'on' : ''} title="Place the train and see its diagrams (its axles: a uniform load has no one position)" onClick={() => setTrain(trainAt ?? { ...start() })}>Train</button>
              {trainAt && (
                <>
                  <input type="range" min={lo} max={hi} step={tr.step || (hi - lo) / 200} value={Math.min(hi, Math.max(lo, trainAt.lead))} aria-label="Position of the first axle"
                    onChange={(e) => setTrain({ ...trainAt, lead: Number(e.target.value) })} />
                  <span className="bm-train-x">{fmt(trainAt.lead / Lm)} {region.lengthUnit}</span>
                  <button title="Travel the other way" aria-label="Reverse the direction" onClick={() => setTrain({ ...trainAt, dir: trainAt.dir === 1 ? -1 : 1 })}>{trainAt.dir === 1 ? '→' : '←'}</button>
                </>
              )}
            </div>
          );
        })()}
        {editing && <div className="sk-status bm-status" role="status">{status}</div>}
      {region.members.length > 0 && (
          <div className={`bm-tabs${stacked ? ' stacked' : ''}`} role="toolbar" aria-label="Diagrams" onPointerDown={(e) => e.stopPropagation()}>
            {(lc || movings.length > 0) && (
              <>
                <select
                  className="bm-view" aria-label="Load case, combination or moving load shown" value={moving ? moving.id : lc ? lcView ?? '' : ''}
                  title="Show one load case, one combination, the envelope of the combinations, or a moving load's envelope"
                  onChange={(e) => {
                    const v = e.target.value, isMoving = movings.some((m) => m.id === v);
                    set({ ...(traffic ? { traffic: { ...traffic, view: isMoving ? v : undefined } } : {}), ...(lc && !isMoving ? { loadCases: { ...lc, view: v } } : {}) }, false);
                  }}
                >
                  {lc ? (
                    <>
                      <optgroup label="Combinations">
                        {lc.combos.map((c) => <option key={c.id} value={c.id}>{c.name} = {comboText(c, [...lc.cases, ...movings])}</option>)}
                        {lc.combos.length > 1 && <option value="envelope">Envelope (min / max)</option>}
                      </optgroup>
                      <optgroup label="Load cases">
                        {lc.cases.map((c) => <option key={c.id} value={c.id}>{c.name}{c.label ? ` · ${c.label}` : ''}</option>)}
                      </optgroup>
                    </>
                  ) : <option value="">Loads</option>}
                  {movings.length > 0 && (
                    <optgroup label="Moving loads">
                      {movings.map((m) => <option key={m.id} value={m.id}>{m.name} (envelope)</option>)}
                    </optgroup>
                  )}
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
        {sol && !lc && !movings.length && !(stacked && kinds.includes('mode')) && (
          <div className={`bm-summary${stacked && region.members.length > 0 ? ' in-strip' : ''}`}>
            {sol.max.M && <span>M<sub>max</sub> {u.moment(sol.max.M.value)}</span>}
            {sol.max.V && !(stacked && region.members.length > 0) && <span>V<sub>max</sub> {u.force(sol.max.V.value)}</span>}
            {sol.max.w && <span>δ<sub>max</sub> {u.defl(sol.max.w.value)}</span>}
            {sol.max.sigma && !(stacked && region.members.length > 0) && <span>σ<sub>max</sub> {u.stress(sol.max.sigma.value)}</span>}
            {res?.buckling && <span>α<sub>cr</sub> {fmtAlpha(res.buckling.modes[0]?.alpha ?? Infinity)}</span>}
          </div>
        )}
        {/* above the strip (in the flow it fell under it, hidden) */}
        {(res?.error || (res && Object.keys(res.errors).length > 0)) && (
          <div className={`region-error bm-error${region.members.length > 0 ? ' over-strip' : ''}`} role="alert">{res.error ?? Object.values(res.errors)[0]}</div>
        )}
      </div>
      {(editing || regionSelected) && <div className="resize-handle sk-resize" onPointerDown={startResize} title="Drag to resize" aria-label="Resize beam" />}
    </div>
  );
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

/** The grid, thinned out when zoomed out (every 2nd, 5th, 10th … line), with major lines. */
function BeamGrid({ vp, step }: { vp: Vp; step: number }) {
  const g = gridLines(vp, step);
  if (!g) return null;
  const minor: string[] = [], major: string[] = [];
  for (const x of g.xs) (x.major ? major : minor).push(`M${toS(vp, { x: x.v, y: 0 }).x.toFixed(1)} 0V${vp.height}`);
  for (const y of g.ys) (y.major ? major : minor).push(`M0 ${toS(vp, { x: 0, y: y.v }).y.toFixed(1)}H${vp.width}`);
  const o = toS(vp, { x: 0, y: 0 });
  return (
    <g pointerEvents="none">
      <path d={minor.join('')} className="bm-grid" />
      <path d={major.join('')} className="bm-grid major" />
      <path d={`M${o.x} 0V${vp.height}M0 ${o.y}H${vp.width}`} className="bm-axis" />
    </g>
  );
}
