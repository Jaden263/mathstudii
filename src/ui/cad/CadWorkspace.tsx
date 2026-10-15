// The CAD workspace, laid out like Fusion: toolbar tabs (Solid, Assemble, Inspect,
// File; Sketch and Constrain while a sketch is open), the browser on the left, the 3-D
// viewport with its ViewCube, a dialog / properties panel on the right and the
// timeline of the active component at the bottom. Used by the separate CAD window
// and, on small screens, full-screen inside the page.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  MousePointer2, Slash, Square, SquareDashed, Circle as CircleIcon, RotateCcw, Spline, Hexagon, Pill, Dot, Ruler,
  SquareRoundCorner, Scissors, SquareSplitHorizontal, Construction, Trash2, Box, PenTool, FileUp, FileDown, Undo2, Redo2, X,
  ArrowUpFromLine, RotateCw, ChevronRight, ChevronDown, ListTree, PanelRight, CircleDot, Grid3x3, FlipHorizontal2, Combine,
  Boxes, Link2, Anchor, Move3d, ScanSearch, Eye, EyeOff, CheckCircle2, SkipBack, StepBack, StepForward, SkipForward,
  Layers, Crosshair, Download, Magnet, Waypoints,
} from 'lucide-react';
import type { CadRegion } from '../../model/types';
import type { CadResult } from '../../cad/evaluate';
import { MATERIALS, cadId, reserveDimNames, type CadSketch, type ConstraintType } from '../../cad/model';
import { CONSTRAINT_TOOLS } from '../../cad/edit';
import {
  FEATURE_LABEL, activeItems, designOf, findSketch, isSketch, nextName, profileKey,
  type CadComponent, type CadDesign, type CadJoint, type CadOccurrence, type DesignFeature, type DesignItem, type DesignSketch, type PlaneRef,
} from '../../cad/design';
import { Arena, dot3, frameFromNormal, m4Dir, m4Inv, m4Point, norm3, scale3, sectionInPlane, sharedVolume, sub3, transformSolid, type Vec3 } from '../../cad/solid';
import type { Mesh } from '../../cad/mesh';
import type { Vec2 } from '../../cad/profile';
import { projectLoops } from '../../cad/project';
import type { Action } from '../store';
import { useSketchUI, type CadTool } from '../sketch/context';
import { exportFile, pickFile } from '../../platform/files';
import { LazyInput } from '../sketch/SketchProps';
import { CadCanvas, type CadCanvasHandle, type CanvasStatus } from './CadCanvas';
import { STANDARD_VIEWS, type Display } from './Cad3DView';
import { Scene3D, type PickHit, type SceneView } from './Scene3D';
import { buildScene, editOccurrence, sketchRegions, useBuilt, useKernel } from './useDesign';
import { Dialog, Expr, FeatureFields, JointFields, featureTitle } from './FeatureDialogs';
import { MassTable, SketchPanel, num } from './SketchPanel';
import { fmtNum } from './cadRender';

interface Props {
  region: CadRegion;
  result?: CadResult;
  dispatch: (a: Action) => void;
  onClose: () => void;
  /** Separate window: show whether the worksheet is still connected. */
  connected?: boolean;
}

type Tab = 'solid' | 'assemble' | 'inspect' | 'file' | 'sketch' | 'constrain';

type Dlg =
  | { kind: 'feature'; cid: string; id: string; mark: number; isNew: boolean }
  | { kind: 'sketch'; ref: PlaneRef; offset: string }
  | { kind: 'joint'; id: string; mark: number; isNew: boolean; picking: 'a' | 'b' | null; snap?: string }
  | { kind: 'measure'; pts: Vec3[] }
  | { kind: 'interference'; rows: { a: string; b: string; v: number }[] | null };

function RibbonButton({ icon, label, title, on, disabled, onClick }: { icon: ReactNode; label: string; title: string; on?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button className={`cadw-rbtn${on ? ' on' : ''}`} title={title} aria-label={label} aria-pressed={on} disabled={disabled} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="cadw-group" role="group" aria-label={label}>
      <div className="cadw-group-items">{children}</div>
      <div className="cadw-group-label">{label}</div>
    </div>
  );
}

/** Size of an element, kept up to date. */
function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(100, Math.floor(el.clientWidth)), h: Math.max(100, Math.floor(el.clientHeight)) }));
    ro.observe(el);
    setSize({ w: Math.max(100, Math.floor(el.clientWidth)), h: Math.max(100, Math.floor(el.clientHeight)) });
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

type Snapshot = Partial<CadRegion>;

/**
 * Undo inside the CAD window applies to this part only (as in any CAD program), not
 * to whatever was last typed on the worksheet. Every undo is still an ordinary
 * worksheet edit, so the worksheet's own history stays complete.
 */
function usePartHistory(region: CadRegion, dispatch: (a: Action) => void) {
  const undoStack = useRef<{ before: Snapshot; key?: string }[]>([]);
  const redoStack = useRef<Snapshot[]>([]);
  const current = useRef(region);
  current.current = region;
  const [, bump] = useState(0);
  const pick = (keys: string[]): Snapshot => Object.fromEntries(keys.map((k) => [k, (current.current as unknown as Record<string, unknown>)[k]]));
  const tracked = useCallback((a: Action) => {
    if (a.type === 'update' && a.id === current.current.id && a.history !== false) {
      const top = undoStack.current[undoStack.current.length - 1];
      if (!(a.coalesce && top?.key === a.coalesce)) {
        undoStack.current.push({ before: pick(Object.keys(a.patch)), key: a.coalesce });
        if (undoStack.current.length > 300) undoStack.current.shift();
      }
      redoStack.current = [];
      bump((n) => n + 1);
    }
    // several edits in one event build on each other
    if (a.type === 'update' && a.id === current.current.id) current.current = { ...current.current, ...(a.patch as Partial<CadRegion>) };
    dispatch(a);
  }, [dispatch]);
  const undo = useCallback(() => {
    const e = undoStack.current.pop();
    if (!e) return;
    redoStack.current.push(pick(Object.keys(e.before)));
    dispatch({ type: 'update', id: current.current.id, patch: e.before });
    bump((n) => n + 1);
  }, [dispatch]);
  const redo = useCallback(() => {
    const e = redoStack.current.pop();
    if (!e) return;
    undoStack.current.push({ before: pick(Object.keys(e)) });
    dispatch({ type: 'update', id: current.current.id, patch: e });
    bump((n) => n + 1);
  }, [dispatch]);
  /** Undo depth now, to roll back to with `revertTo` (a cancelled dialog). */
  const mark = useCallback(() => undoStack.current.length, []);
  const revertTo = useCallback((m: number) => {
    if (undoStack.current.length <= m) return;
    const first = undoStack.current[m];
    undoStack.current.length = m;
    dispatch({ type: 'update', id: current.current.id, patch: first.before });
    bump((n) => n + 1);
  }, [dispatch]);
  /** Stop the last step from absorbing the next edit with the same key. */
  const seal = useCallback(() => {
    const top = undoStack.current[undoStack.current.length - 1];
    if (top) top.key = undefined;
  }, []);
  return { tracked, undo, redo, mark, revertTo, seal, canUndo: undoStack.current.length > 0, canRedo: redoStack.current.length > 0 };
}

const mapComp = (d: CadDesign, cid: string, fn: (c: CadComponent) => CadComponent): CadDesign => ({ ...d, components: d.components.map((c) => (c.id === cid ? fn(c) : c)) });

const ICON: Record<DesignItem['kind'], ReactNode> = {
  sketch: <PenTool size={14} />, extrude: <ArrowUpFromLine size={14} />, revolve: <RotateCw size={14} />, hole: <CircleDot size={14} />,
  pattern: <Grid3x3 size={14} />, mirror: <FlipHorizontal2 size={14} />, combine: <Combine size={14} />,
};

const splitKey = (key: string) => {
  const rest = key.slice(2), i = rest.indexOf(':');
  return [rest.slice(0, i), rest.slice(i + 1)] as const;
};
const parseBody = (key: string) => {
  const [occ, body] = splitKey(key);
  return { occ, body };
};
const parseProfile = (key: string) => {
  const [sketch, k] = splitKey(key);
  return { sketch, key: k };
};

export function CadWorkspace({ region, result, dispatch: rawDispatch, onClose, connected = true }: Props) {
  const { tracked: dispatch, undo: onUndo, redo: onRedo, mark, revertTo, seal, canUndo, canRedo } = usePartHistory(region, rawDispatch);
  const { ui, setUi } = useSketchUI();
  const design = useMemo(() => designOf(region), [region]);
  const designRef = useRef(design);
  designRef.current = design;
  const cur = () => designRef.current;
  const K = useKernel();
  const built = useBuilt(region.id, design, result);
  const dr = result?.design;
  const u = region.unit;

  const [tab, setTab] = useState<Tab>('solid');
  const [active, setActive] = useState(design.components[0]?.id ?? '');
  const [sketchId, setSketchId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dlg | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [status, setStatus] = useState<CanvasStatus>({ hint: '', msg: '' });
  const [msg, setMsg] = useState('');
  const [display, setDisplay] = useState<Display>('shadedEdges');
  const [showPlanes, setShowPlanes] = useState(true);
  const [isolate, setIsolate] = useState(false);
  // phones start with the panels folded away; they open over the view
  const narrow = typeof window !== 'undefined' && window.innerWidth < 760;
  const [showTree, setShowTree] = useState(!narrow);
  const [showProps, setShowProps] = useState(!narrow);
  const [open, setOpen] = useState<Record<string, boolean>>({ comps: true, occs: true, joints: true });
  const canvas = useRef<CadCanvasHandle>(null);
  const [viewRef, size] = useSize<HTMLDivElement>();

  const comp = design.components.find((c) => c.id === active) ?? design.components[0];
  useEffect(() => {
    if (comp && comp.id !== active) setActive(comp.id);
  }, [comp, active]);
  useEffect(() => {
    if (comp) setOpen((o) => ({ ...o, [`c:${comp.id}`]: true, [`cb:${comp.id}`]: true, [`cs:${comp.id}`]: true }));
  }, [comp?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!msg) return;
    const t = window.setTimeout(() => setMsg(''), 6000);
    return () => window.clearTimeout(t);
  }, [msg]);

  // ------------------------------------------------------------ edits

  const setDesign = useCallback((d: CadDesign, coalesce?: string, history = true) => {
    designRef.current = d;
    dispatch({ type: 'update', id: region.id, patch: { design: d }, coalesce, ...(history ? {} : { history: false as const }) });
  }, [dispatch, region.id]);
  const set = (patch: Partial<CadRegion>, history = true) => dispatch({ type: 'update', id: region.id, patch, ...(history ? {} : { history: false as const }) });
  const patchComp = (cid: string, patch: Partial<CadComponent>, coalesce?: string) => setDesign(mapComp(cur(), cid, (c) => ({ ...c, ...patch })), coalesce);
  const patchItem = (cid: string, iid: string, patch: Partial<DesignItem>, coalesce?: string) =>
    setDesign(mapComp(cur(), cid, (c) => ({ ...c, items: c.items.map((i) => (i.id === iid ? ({ ...i, ...patch } as DesignItem) : i)) })), coalesce);
  const insertItem = (cid: string, item: DesignItem) => setDesign(mapComp(cur(), cid, (c) => {
    const at = c.marker ?? c.items.length;
    const items = [...c.items];
    items.splice(at, 0, item);
    return { ...c, items, marker: c.marker === undefined ? undefined : c.marker + 1 };
  }));
  const patchOcc = (id: string, patch: Partial<CadOccurrence>, coalesce?: string) =>
    setDesign({ ...cur(), occurrences: cur().occurrences.map((o) => (o.id === id ? { ...o, ...patch } : o)) }, coalesce);
  const patchJoint = (id: string, patch: Partial<CadJoint>, coalesce?: string) =>
    setDesign({ ...cur(), joints: cur().joints.map((j) => (j.id === id ? { ...j, ...patch } : j)) }, coalesce);

  // ------------------------------------------------------------ sketch mode

  const ds = sketchId ? findSketch(design, sketchId) : undefined;
  const sketchComp = ds ? design.components.find((c) => c.items.includes(ds)) : undefined;
  useEffect(() => {
    if (sketchId && !ds) setSketchId(null);
  }, [sketchId, ds]);
  // new dimensions get names that are unique in the whole design
  useEffect(() => {
    if (!ds) return reserveDimNames([]);
    const names: string[] = [];
    for (const c of design.components) for (const i of c.items) if (isSketch(i) && i.id !== ds.id) for (const k of i.sketch.constraints) if (k.name) names.push(k.name);
    reserveDimNames(names);
  }, [design, ds]);
  useEffect(() => () => reserveDimNames([]), []);

  const sketchRegion = useMemo<CadRegion | null>(() => (ds ? { ...region, sketch: ds.sketch, viewW: ds.view, feature: { type: 'none' } } : null), [region, ds]);
  const sketchResult = ds ? dr?.sketches[ds.id] : undefined;
  const replaceSketch = useCallback((id: string, patch: Partial<DesignSketch>, coalesce?: string, history = true) => {
    const d = designRef.current;
    setDesign({ ...d, components: d.components.map((c) => ({ ...c, items: c.items.map((i) => (i.id === id ? ({ ...i, ...patch } as DesignItem) : i)) })) }, coalesce, history);
  }, [setDesign]);
  const sketchDispatch = useCallback((a: Action) => {
    if (a.type === 'update' && a.id === region.id && sketchId) {
      const p = a.patch as Partial<CadRegion>;
      if (p.sketch) replaceSketch(sketchId, { sketch: p.sketch }, a.coalesce, a.history !== false);
      if (p.viewW) replaceSketch(sketchId, { view: p.viewW }, undefined, false);
      return;
    }
    dispatch(a);
  }, [dispatch, region.id, sketchId, replaceSketch]);
  const onSketch = (sk: CadSketch, coalesce?: string) => sketchId && replaceSketch(sketchId, { sketch: sk }, coalesce);

  /** Body outlines in the plane of the open sketch. */
  const reference = useMemo<Vec2[][]>(() => {
    if (!ds || !sketchComp || !built || !dr?.frames[ds.id]) return [];
    const f = dr.frames[ds.id];
    const out: Vec2[][] = [];
    for (const b of built.built.components.get(sketchComp.id)?.bodies ?? []) {
      try {
        out.push(...sectionInPlane(b.solid, f));
      } catch {
        /* empty body */
      }
    }
    return out;
  }, [ds, sketchComp, built, dr]);

  const enterSketch = (id: string) => {
    setDialog(null);
    setSketchId(id);
    setTab('sketch');
    setUi({ regionId: region.id, selected: [], cadTool: findSketch(designRef.current, id)?.sketch.entities.length ? 'select' : 'line' });
    window.setTimeout(() => canvas.current?.focus(), 60);
  };
  const finishSketch = () => {
    setSketchId(null);
    setTab('solid');
    setUi({ regionId: region.id, selected: [], cadTool: 'select' });
  };
  const pickTool = (t: CadTool) => {
    setUi({ regionId: region.id, cadTool: t });
    window.setTimeout(() => canvas.current?.focus(), 0);
  };
  const tool = ui.regionId === region.id ? ui.cadTool : 'select';
  const toolBtn = (t: CadTool, icon: ReactNode, label: string, title: string) => (
    <RibbonButton key={t} icon={icon} label={label} title={title} on={tool === t} onClick={() => pickTool(t)} />
  );
  const cmd = (f: (c: CadCanvasHandle) => void) => {
    if (canvas.current) f(canvas.current);
    canvas.current?.focus();
  };

  // ------------------------------------------------------------ creating things

  const items = comp ? activeItems(comp) : [];
  const bodiesNow = (comp && dr?.bodies[comp.id]) ?? [];
  const lastSketch = (pred: (s: DesignSketch) => boolean) => [...items].reverse().find((i): i is DesignSketch => isSketch(i) && pred(i));
  const selProfile = sel?.startsWith('p:') ? parseProfile(sel) : null;
  const selSketch = sel?.startsWith('item:') ? (items.find((i) => i.id === sel.slice(5) && isSketch(i)) as DesignSketch | undefined) : undefined;

  const startFeature = (kind: DesignFeature['kind']) => {
    if (!comp) return;
    const name = nextName(cur(), FEATURE_LABEL[kind]);
    const id = cadId('f');
    const op = bodiesNow.length ? ('join' as const) : ('new' as const);
    let f: DesignFeature;
    if (kind === 'extrude' || kind === 'revolve') {
      const sk = selProfile ? findSketch(cur(), selProfile.sketch) : selSketch ?? lastSketch((s) => sketchRegions(s, result).length > 0);
      if (!sk) return setMsg('Make a sketch with a closed profile first (Solid → Sketch)');
      const profiles = selProfile && selProfile.sketch === sk.id ? [selProfile.key] : undefined;
      if (kind === 'extrude') f = { kind, id, name, sketch: sk.id, profiles, extent: { type: 'one', d: '10' }, op };
      else {
        const axis = sk.sketch.entities.find((e) => e.type === 'line' && e.construction)?.id ?? 'x';
        f = { kind, id, name, sketch: sk.id, profiles, axis, angle: '360', op };
      }
    } else if (kind === 'hole') {
      const sk = selSketch ?? lastSketch((s) => s.sketch.entities.some((e) => e.type === 'point'));
      if (!sk) return setMsg('Sketch points mark the hole centres: sketch on a face and place points (P)');
      if (!bodiesNow.length) return setMsg('There is no body to drill yet');
      f = { kind, id, name, sketch: sk.id, d: '6', depth: '10', through: true, style: 'simple' };
    } else if (kind === 'pattern') {
      const last = [...items].reverse().find((i) => i.kind === 'hole' || i.kind === 'extrude' || i.kind === 'revolve');
      if (!last) return setMsg('Make a feature or body to pattern first');
      f = { kind, id, name, of: 'features', refs: [last.id], type: 'circ', axis: 'Z', count: '4', spacing: '360' };
    } else if (kind === 'mirror') {
      if (!bodiesNow.length) return setMsg('Make a body to mirror first');
      f = { kind, id, name, of: 'bodies', refs: bodiesNow.map((b) => b.id), plane: 'YZ', join: true };
    } else {
      if (bodiesNow.length < 2) return setMsg('Combine needs two bodies in this component');
      f = { kind: 'combine', id, name, target: bodiesNow[0].id, tools: bodiesNow.slice(1).map((b) => b.id), op: 'join' };
    }
    seal();
    const m = mark();
    insertItem(comp.id, f);
    setSel(null);
    setDialog({ kind: 'feature', cid: comp.id, id, mark: m, isNew: true });
  };

  const editItem = (cid: string, item: DesignItem) => {
    setActive(cid);
    if (isSketch(item)) return enterSketch(item.id);
    seal();
    setDialog({ kind: 'feature', cid, id: item.id, mark: mark(), isNew: false });
  };

  const newSketchOn = (plane: DesignSketch['plane'], cid = comp?.id) => {
    if (!cid) return;
    const id = cadId('s');
    insertItem(cid, { kind: 'sketch', id, name: nextName(cur(), 'Sketch'), plane, sketch: { points: [], entities: [], constraints: [] } });
    setActive(cid);
    enterSketch(id);
  };

  const newComponent = () => {
    const d = cur();
    const cid = cadId('c');
    const name = nextName(d, 'Component');
    const box = dr?.box;
    const w = box ? box.max[0] - box.min[0] : 100;
    setDesign({
      ...d,
      components: [...d.components, { id: cid, name, items: [] }],
      occurrences: [...d.occurrences, { id: cadId('o'), component: cid, pos: [box ? box.max[0] + w * 0.3 : 0, 0, 0] }],
    });
    setActive(cid);
    setMsg(`${name} is active: Solid → Sketch to model it`);
  };
  const insertOccurrence = (cid = comp?.id) => {
    if (!cid) return;
    const d = cur();
    const box = dr?.box;
    const w = box ? box.max[0] - box.min[0] : 100;
    const id = cadId('o');
    setDesign({ ...d, occurrences: [...d.occurrences, { id, component: cid, pos: [box ? box.max[0] + w * 0.3 : 0, 0, 0] }] });
    setSel(`occ:${id}`);
  };
  const startJoint = () => {
    const d = cur();
    if (d.occurrences.length < 2) return setMsg('A joint needs two occurrences: Assemble → New component or Insert copy first');
    const ground = d.occurrences.find((o) => o.grounded) ?? d.occurrences[0];
    const other = [...d.occurrences].reverse().find((o) => o.id !== ground.id)!;
    const id = cadId('j');
    seal();
    const m = mark();
    setDesign({ ...d, joints: [...d.joints, { id, name: nextName(d, 'Joint'), type: 'rigid', a: { occ: ground.id, origin: { kind: 'origin' } }, b: { occ: other.id, origin: { kind: 'origin' } }, angle: '0', offset: '0' }] });
    setDialog({ kind: 'joint', id, mark: m, isNew: true, picking: 'b' });
  };

  useEffect(() => {
    if (dialog) setShowProps(true);
  }, [dialog]);
  const closeDialog = (ok: boolean) => {
    if (!dialog) return;
    if (!ok && (dialog.kind === 'feature' || dialog.kind === 'joint')) revertTo(dialog.mark);
    seal();
    setDialog(null);
  };

  // ------------------------------------------------------------ picking

  const occOf = (id: string) => design.occurrences.find((o) => o.id === id);
  const placement = (occId: string) => built?.built.placements[occId]?.matrix ?? dr?.placements[occId]?.matrix;
  const sceneSize = dr?.box ? Math.max(...[0, 1, 2].map((i) => dr.box!.max[i] - dr.box!.min[i]), 20) : 100;
  const occLabel = (o: CadOccurrence) => {
    const c = design.components.find((q) => q.id === o.component);
    return o.name || `${c?.name ?? '?'}:${design.occurrences.filter((q) => q.component === o.component).indexOf(o) + 1}`;
  };

  /** Joint origin from a click on a face: snaps to circle centres and points of the component's sketches. */
  const pickedOrigin = (occId: string, hit: PickHit): { o: Vec3; z: Vec3; snap?: string } | null => {
    const occ = occOf(occId), M = placement(occId);
    if (!occ || !M || !hit.point || !hit.normal) return null;
    const inv = m4Inv(M);
    const p = m4Point(inv, hit.point), n = norm3(m4Dir(inv, hit.normal));
    let best: { o: Vec3; score: number; label: string } | null = null;
    const c = design.components.find((q) => q.id === occ.component);
    for (const s of c?.items.filter(isSketch) ?? []) {
      const f = dr?.frames[s.id], sol = dr?.sketches[s.id];
      if (!f || !sol) continue;
      const cand: { id: string; tol: number; label: string }[] = [];
      for (const e of s.sketch.entities) {
        if (e.type === 'circle') cand.push({ id: e.c, tol: (sol.radii[e.id] ?? e.r) * 1.15, label: `circle centre (${s.name})` });
        if (e.type === 'arc') cand.push({ id: e.c, tol: sceneSize * 0.04, label: `arc centre (${s.name})` });
        if (e.type === 'point') cand.push({ id: e.p, tol: sceneSize * 0.03, label: `point (${s.name})` });
      }
      for (const k of cand) {
        const q = sol.points[k.id];
        if (!q) continue;
        const w: Vec3 = [f.o[0] + f.u[0] * q[0] + f.v[0] * q[1], f.o[1] + f.u[1] * q[0] + f.v[1] * q[1], f.o[2] + f.u[2] * q[0] + f.v[2] * q[1]];
        const on = sub3(w, scale3(n, dot3(sub3(w, p), n))); // onto the picked face plane
        const score = Math.hypot(...sub3(on, p)) / k.tol;
        if (score < 1 && (!best || score < best.score)) best = { o: on, score, label: k.label };
      }
    }
    return best ? { o: best.o, z: n, snap: best.label } : { o: p, z: n };
  };

  const onPick = (hit: PickHit) => {
    const key = hit.key ?? '';
    if (dialog?.kind === 'feature') {
      const c = design.components.find((q) => q.id === dialog.cid);
      const f = c?.items.find((i) => i.id === dialog.id) as DesignFeature | undefined;
      if (!c || !f) return;
      if (key.startsWith('p:') && (f.kind === 'extrude' || f.kind === 'revolve')) {
        const p = parseProfile(key);
        if (p.sketch !== f.sketch) return patchItem(c.id, f.id, { sketch: p.sketch, profiles: [p.key] } as Partial<DesignItem>);
        const all = f.profiles ?? [];
        const next = all.includes(p.key) ? all.filter((x) => x !== p.key) : [...all, p.key];
        return patchItem(c.id, f.id, { profiles: next.length ? next : undefined } as Partial<DesignItem>);
      }
      if (key.startsWith('b:')) {
        const { occ, body } = parseBody(key);
        if (occOf(occ)?.component !== c.id) return setMsg('That body belongs to another component');
        const toggle = (list: string[] | undefined) => {
          const l = list ?? [];
          return l.includes(body) ? l.filter((x) => x !== body) : [...l, body];
        };
        if (f.kind === 'extrude' || f.kind === 'revolve' || f.kind === 'hole') {
          if (f.kind !== 'hole' && f.op === 'new') return;
          const next = toggle(f.targets);
          return patchItem(c.id, f.id, { targets: next.length ? next : undefined } as Partial<DesignItem>);
        }
        if ((f.kind === 'pattern' || f.kind === 'mirror') && f.of === 'bodies') return patchItem(c.id, f.id, { refs: toggle(f.refs) } as Partial<DesignItem>);
        if (f.kind === 'combine') {
          if (!f.target || f.target === body) return patchItem(c.id, f.id, { target: body, tools: f.tools.filter((t) => t !== body) } as Partial<DesignItem>);
          return patchItem(c.id, f.id, { tools: toggle(f.tools) } as Partial<DesignItem>);
        }
      }
      return;
    }
    if (dialog?.kind === 'sketch') {
      if (key.startsWith('pl:')) return newSketchOn({ ref: key.slice(3) as PlaneRef, ...(dialog.offset.trim() && dialog.offset.trim() !== '0' ? { offset: dialog.offset.trim() } : {}) });
      if (key.startsWith('b:') && hit.point && hit.normal) {
        const { occ, body } = parseBody(key);
        const o = occOf(occ), M = placement(occ);
        if (!o || !M) return;
        const inv = m4Inv(M);
        const p = m4Point(inv, hit.point), n = norm3(m4Dir(inv, hit.normal));
        const f = frameFromNormal(scale3(n, dot3(p, n)), n);
        const bname = dr?.bodies[o.component]?.find((b) => b.id === body)?.name ?? 'body';
        return newSketchOn({ frame: { o: f.o.map((v) => +v.toPrecision(12)) as Vec3, u: f.u, v: f.v }, label: `face of ${bname}` }, o.component);
      }
      return;
    }
    if (dialog?.kind === 'joint') {
      if (!dialog.picking || !key.startsWith('b:')) return;
      const { occ } = parseBody(key);
      const j = design.joints.find((q) => q.id === dialog.id);
      if (!j) return;
      const other = dialog.picking === 'a' ? j.b.occ : j.a.occ;
      const o = pickedOrigin(occ, hit);
      if (!o) return;
      // picking the part the other side already uses swaps the sides
      const patch: Partial<CadJoint> = occ === other
        ? { [dialog.picking]: { occ, origin: { kind: 'frame', o: o.o, z: o.z } }, [dialog.picking === 'a' ? 'b' : 'a']: dialog.picking === 'a' ? { ...j.a } : { ...j.b }, flip: true }
        : { [dialog.picking]: { occ, origin: { kind: 'frame', o: o.o, z: o.z } }, flip: true };
      patchJoint(j.id, patch);
      setDialog({ ...dialog, picking: dialog.picking === 'b' ? 'a' : null, snap: o.snap ? `Snapped to the ${o.snap}` : 'On the face (no centre nearby)' });
      return;
    }
    if (dialog?.kind === 'measure') {
      if (!hit.point) return;
      setDialog({ kind: 'measure', pts: dialog.pts.length >= 2 ? [hit.point] : [...dialog.pts, hit.point] });
      return;
    }
    if (key.startsWith('b:')) setSel(`body:${key.slice(2)}`);
    else if (key.startsWith('p:')) setSel(key);
    else setSel(null);
  };

  // ------------------------------------------------------------ inspect

  const runInterference = () => {
    if (!built) return setMsg('The 3-D kernel is still loading');
    const arena = new Arena();
    try {
      const placed = design.occurrences.filter((o) => !o.hidden).map((o) => {
        const M = built.built.placements[o.id]?.matrix;
        const bodies = built.built.components.get(o.component)?.bodies ?? [];
        return { o, solids: M ? bodies.filter((b) => !b.solid.isEmpty()).map((b) => transformSolid(arena, b.solid, M)) : [] };
      });
      const rows: { a: string; b: string; v: number }[] = [];
      for (let i = 0; i < placed.length; i++) for (let k = i + 1; k < placed.length; k++) {
        let v = 0;
        for (const s of placed[i].solids) for (const t of placed[k].solids) v += sharedVolume(s, t);
        if (v > 1e-9 * sceneSize ** 3) rows.push({ a: occLabel(placed[i].o), b: occLabel(placed[k].o), v });
      }
      setDialog({ kind: 'interference', rows });
    } finally {
      arena.free();
    }
  };

  // ------------------------------------------------------------ files

  const fileBase = (region.name.trim() || 'part').replace(/[^\w.-]+/g, '_');
  const exportStl = async () => {
    if (!built) return setMsg('The 3-D kernel is still loading');
    const parts: Float32Array[] = [];
    for (const o of design.occurrences) {
      const M = built.built.placements[o.id]?.matrix;
      if (o.hidden || !M) continue;
      for (const b of built.built.components.get(o.component)?.bodies ?? []) {
        const m = built.mesh(o.component, b.id);
        if (!m) continue;
        const p = new Float32Array(m.positions.length);
        for (let i = 0; i < p.length; i += 3) p.set(m4Point(M, [m.positions[i], m.positions[i + 1], m.positions[i + 2]]), i);
        parts.push(p);
      }
    }
    if (!parts.length) return setMsg('There is no solid to export');
    const all = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
    let at = 0;
    for (const p of parts) { all.set(p, at); at += p.length; }
    const { meshToStl } = await import('../../cad/stl');
    const mesh: Mesh = { positions: all, normals: all, edges: new Float32Array(0), bounds: { min: [0, 0, 0], max: [0, 0, 0] } };
    await exportFile(`${fileBase}.stl`, meshToStl(mesh, fileBase), 'model/stl');
  };
  const importDxf = async () => {
    if (!ds) return;
    const file = await pickFile('.dxf');
    if (!file) return;
    try {
      const { dxfToSketch } = await import('../../cad/dxf');
      const { sketch, warnings } = dxfToSketch(await file.text());
      const sk = ds.sketch;
      replaceSketch(ds.id, { sketch: { points: [...sk.points, ...sketch.points], entities: [...sk.entities, ...sketch.entities], constraints: [...sk.constraints, ...sketch.constraints] }, view: undefined });
      setMsg(`Imported ${sketch.entities.length} entities from ${file.name}${warnings.length ? ` · ${warnings.join('; ')}` : ''}`);
      window.setTimeout(() => canvas.current?.fit(), 80);
    } catch (err) {
      setMsg(`Could not read ${file.name}: ${(err as Error).message}`);
    }
  };
  const exportDxf = async () => {
    if (!ds) return;
    const { sketchToDxf } = await import('../../cad/dxf');
    await exportFile(`${fileBase}-${ds.name}.dxf`, sketchToDxf(ds.sketch, region.unit), 'application/dxf');
  };
  const project = () => {
    if (!ds) return;
    if (!reference.length) return setMsg('No body crosses this sketch plane');
    const r = projectLoops(ds.sketch, reference);
    replaceSketch(ds.id, { sketch: r.sketch });
    setUi({ regionId: region.id, selected: r.ids });
    setMsg(`Projected ${r.ids.length} edges (fixed in place)`);
  };

  // ------------------------------------------------------------ keyboard

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) onRedo(); else onUndo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); onRedo(); }
    else if (e.key === 'Escape' && dialog) closeDialog(false);
    else if (!sketchId && !dialog && !mod && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'e') startFeature('extrude');
      else if (k === 'h') startFeature('hole');
      else if (k === 'j') startJoint();
      else if (k === 'm') setDialog({ kind: 'measure', pts: [] });
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // ------------------------------------------------------------ scene

  const activeFeature = dialog?.kind === 'feature' ? (design.components.find((q) => q.id === dialog.cid)?.items.find((i) => i.id === dialog.id) as DesignFeature | undefined) : undefined;
  useEffect(() => {
    if (dialog?.kind === 'feature' && !activeFeature) setDialog(null);
  }, [dialog, activeFeature]);
  const activeJoint = dialog?.kind === 'joint' ? design.joints.find((j) => j.id === dialog.id) : undefined;

  const highlight = useMemo(() => {
    const h = new Set<string>();
    if (hover) h.add(hover);
    if (sel?.startsWith('body:')) h.add(`b:${sel.slice(5)}`);
    if (sel?.startsWith('p:')) h.add(sel);
    if (sel?.startsWith('occ:')) h.add(`o:${sel.slice(4)}`);
    if (sel?.startsWith('item:')) h.add(`s:${sel.slice(5)}`);
    const f = activeFeature;
    const occ = f && dialog?.kind === 'feature' ? editOccurrence(design, dialog.cid) : undefined;
    if (f && occ) {
      if (f.kind === 'extrude' || f.kind === 'revolve') {
        const s = findSketch(design, f.sketch);
        const keys = f.profiles?.length ? f.profiles : s ? sketchRegions(s, result).map(profileKey) : [];
        for (const k of keys) h.add(`p:${f.sketch}:${k}`);
      }
      const bodies = 'targets' in f ? f.targets : (f.kind === 'pattern' || f.kind === 'mirror') && f.of === 'bodies' ? f.refs : f.kind === 'combine' ? [f.target, ...f.tools] : undefined;
      for (const b of bodies ?? []) h.add(`b:${occ.id}:${b}`);
    }
    if (activeJoint) {
      h.add(`o:${activeJoint.a.occ}`);
      h.add(`o:${activeJoint.b.occ}`);
    }
    return h;
  }, [hover, sel, dialog, activeFeature, activeJoint, design, result]);

  const pickProfiles = !dialog || activeFeature?.kind === 'extrude' || activeFeature?.kind === 'revolve';
  const scene = useMemo(() => buildScene(region, design, result, built, {
    active: comp?.id ?? '', highlight, showPlanes: showPlanes || dialog?.kind === 'sketch', pickProfiles, isolate, size: sceneSize,
  }), [region, design, result, built, comp, highlight, showPlanes, dialog, pickProfiles, isolate, sceneSize]);

  const view3d: SceneView = region.view3dW
    ? { yaw: region.view3dW.yaw, pitch: region.view3dW.pitch, zoom: region.view3dW.zoom ?? 1, pan: region.view3dW.pan ?? { x: 0, y: 0 } }
    : { ...STANDARD_VIEWS.iso, zoom: 1, pan: { x: 0, y: 0 } };
  const setView3d = (v: SceneView) => set({ view3dW: v }, false);

  // ------------------------------------------------------------ browser

  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const Node = ({ k, icon, label, badge, children, onClick, on, extra, bad }: { k: string; icon: ReactNode; label: ReactNode; badge?: string; children?: ReactNode; onClick?: () => void; on?: boolean; extra?: ReactNode; bad?: boolean }) => (
    <li>
      <div className={`cadw-node${on ? ' on' : ''}${bad ? ' bad' : ''}`}>
        {children ? <button className="cadw-twisty" onClick={() => toggle(k)} aria-label={open[k] ? 'Collapse' : 'Expand'}>{open[k] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button> : <span className="cadw-twisty" />}
        <button className="cadw-node-label" onClick={onClick ?? (() => toggle(k))}>{icon}<span>{label}</span>{badge && <em className={`cadw-badge${badge === '✓' ? ' ok' : ''}`}>{badge}</em>}</button>
        {extra}
      </div>
      {children && open[k] && <ul>{children}</ul>}
    </li>
  );
  const eye = (hidden: boolean | undefined, flip: () => void) => (
    <button className="cadw-eye" onClick={flip} aria-label={hidden ? 'Show' : 'Hide'} title={hidden ? 'Show' : 'Hide'}>{hidden ? <EyeOff size={12} /> : <Eye size={12} />}</button>
  );

  // ------------------------------------------------------------ timeline

  const marker = comp?.marker ?? comp?.items.length ?? 0;
  const setMarker = (m: number) => comp && patchComp(comp.id, { marker: m >= comp.items.length ? undefined : Math.max(0, m) });
  const removeItem = (cid: string, iid: string) => {
    setDesign(mapComp(cur(), cid, (c) => {
      const idx = c.items.findIndex((i) => i.id === iid);
      return { ...c, items: c.items.filter((i) => i.id !== iid), marker: c.marker !== undefined && idx < c.marker ? c.marker - 1 : c.marker };
    }));
    setSel(null);
  };

  // ------------------------------------------------------------ status

  const errorCount = Object.keys(dr?.errors ?? {}).length;
  const kernelState = !K ? 'Loading the 3-D kernel…' : !result ? 'Evaluating…' : '';
  const hintText = (() => {
    if (msg) return msg;
    if (sketchId) return status.msg || status.hint;
    if (dialog?.kind === 'sketch') return 'Click an origin plane or a flat face to sketch on it';
    if (dialog?.kind === 'joint') return dialog.picking ? `Click a face of the ${dialog.picking === 'b' ? 'part that moves' : 'part it goes onto'} (snaps to hole and shaft centres)` : dialog.snap ?? 'Set the joint type and motion, then OK';
    if (dialog?.kind === 'measure') return 'Click two points on the model';
    if (dialog?.kind === 'feature') return 'Click profiles or bodies in the view to pick them · Esc cancels';
    return 'Drag: orbit · Shift/middle-drag: pan · wheel: zoom · E extrude · H hole · J joint · M measure';
  })();

  // ------------------------------------------------------------ panels

  const material = (density: string) => MATERIALS.find((m) => m.density === density.trim());

  const dialogPanel = (() => {
    if (!dialog) return null;
    if (dialog.kind === 'feature' && activeFeature) {
      const c = design.components.find((q) => q.id === dialog.cid)!;
      return (
        <Dialog title={featureTitle(activeFeature)} error={dr?.errors[activeFeature.id]} onOk={() => closeDialog(true)} onCancel={() => closeDialog(false)}>
          <FeatureFields design={design} comp={c} feature={activeFeature} result={result} unit={u}
            onChange={(p, k) => patchItem(c.id, activeFeature.id, p as Partial<DesignItem>, k ? `${activeFeature.id}:${k}` : undefined)} />
        </Dialog>
      );
    }
    if (dialog.kind === 'sketch') {
      const offset = dialog.offset.trim() && dialog.offset.trim() !== '0' ? { offset: dialog.offset.trim() } : {};
      return (
        <Dialog title="Create sketch" okLabel="Create" onOk={() => newSketchOn({ ref: dialog.ref, ...offset })} onCancel={() => setDialog(null)}>
          <p className="hint">Click an origin plane or a flat face of a body in the view, or pick a plane here.</p>
          <label className="field">
            <span>Plane</span>
            <select value={dialog.ref} onChange={(e) => setDialog({ ...dialog, ref: e.target.value as PlaneRef })}>
              <option value="XY">XY (top)</option><option value="XZ">XZ (front)</option><option value="YZ">YZ (right)</option>
            </select>
          </label>
          <Expr label="Offset along the normal" value={dialog.offset} placeholder="0" onChange={(o) => setDialog({ ...dialog, offset: o })} />
        </Dialog>
      );
    }
    if (dialog.kind === 'joint' && activeJoint) {
      return (
        <Dialog title={`Joint — ${activeJoint.name}`} error={dr?.errors[activeJoint.id]} onOk={() => closeDialog(true)} onCancel={() => closeDialog(false)}>
          <JointFields design={design} joint={activeJoint} picking={dialog.picking} onPick={(p) => setDialog({ ...dialog, picking: p })}
            onChange={(p, k) => patchJoint(activeJoint.id, p, k ? `${activeJoint.id}:${k}` : undefined)}
            values={dr?.params[activeJoint.id] as { angle: number; offset: number } | undefined} />
          {dialog.snap && <p className="hint">{dialog.snap}</p>}
        </Dialog>
      );
    }
    if (dialog.kind === 'measure') {
      const [a, b] = dialog.pts;
      const d = a && b ? sub3(b, a) : null;
      return (
        <Dialog title="Measure" okLabel="Done" onOk={() => setDialog(null)} onCancel={() => setDialog(null)}>
          <p className="hint">Click two points on the model.</p>
          {a && <p>A = ({a.map((v) => fmtNum(v)).join(', ')}) {u}</p>}
          {b && <p>B = ({b.map((v) => fmtNum(v)).join(', ')}) {u}</p>}
          {d && (
            <table className="props-table"><tbody>
              <tr><td>Distance</td><td><b>{fmtNum(Math.hypot(...d))}</b> {u}</td></tr>
              <tr><td>ΔX, ΔY, ΔZ</td><td>{d.map((v) => fmtNum(v)).join(', ')} {u}</td></tr>
            </tbody></table>
          )}
        </Dialog>
      );
    }
    if (dialog.kind === 'interference') {
      return (
        <Dialog title="Interference" okLabel="Done" onOk={() => setDialog(null)} onCancel={() => setDialog(null)}>
          {!dialog.rows?.length ? <p className="hint">No occurrences overlap.</p> : (
            <table className="props-table"><tbody>
              {dialog.rows.map((r, i) => <tr key={i}><td>{r.a} ∩ {r.b}</td><td>{num(r.v, 4)} {u}³</td></tr>)}
            </tbody></table>
          )}
          <button className="btn" onClick={runInterference}>Check again</button>
        </Dialog>
      );
    }
    return null;
  })();

  const selectionPanel = (() => {
    if (sel?.startsWith('comp:')) {
      const c = design.components.find((q) => q.id === sel.slice(5));
      if (!c) return null;
      const dens = c.density ?? '';
      return (
        <div className="props">
          <h3 className="sub">Component</h3>
          <label className="field"><span>Name</span><LazyInput label="Component name" mono={false} value={c.name} onCommit={(v) => v.trim() && patchComp(c.id, { name: v.trim() })} /></label>
          <div className="row2">
            <label className="field"><span>Material</span>
              <select value={dens ? material(dens)?.density ?? 'custom' : 'part'} onChange={(e) => e.target.value !== 'custom' && patchComp(c.id, { density: e.target.value === 'part' ? undefined : e.target.value })}>
                <option value="part">Part material</option>
                {MATERIALS.map((m) => <option key={m.name} value={m.density}>{m.name}</option>)}
                <option value="custom">Custom</option>
              </select>
            </label>
            <label className="field"><span>Colour</span><input type="color" value={c.color ?? '#a3b0c4'} onChange={(e) => patchComp(c.id, { color: e.target.value }, `color:${c.id}`)} /></label>
          </div>
          <Expr label="Density (empty: part material)" value={dens} onChange={(v) => patchComp(c.id, { density: v || undefined })} />
          {dr?.errors[c.id] && <div className="region-error">{dr.errors[c.id]}</div>}
          <MassTable m={dr?.components[c.id]} unit={u} />
          <div className="cadd-actions">
            {c.id !== comp?.id && <button className="btn" onClick={() => setActive(c.id)}>Activate</button>}
            <button className="btn" onClick={() => insertOccurrence(c.id)}>Insert a copy</button>
            {design.components.length > 1 && (
              <button className="btn danger" onClick={() => {
                const d = cur();
                const occ = new Set(d.occurrences.filter((o) => o.component === c.id).map((o) => o.id));
                setDesign({ ...d, components: d.components.filter((q) => q.id !== c.id), occurrences: d.occurrences.filter((o) => !occ.has(o.id)), joints: d.joints.filter((j) => !occ.has(j.a.occ) && !occ.has(j.b.occ)) });
                setSel(null);
              }}><Trash2 size={13} /> Delete</button>
            )}
          </div>
        </div>
      );
    }
    if (sel?.startsWith('body:')) {
      const { occ, body } = parseBody(`b:${sel.slice(5)}`);
      const o = occOf(occ);
      const c = o && design.components.find((q) => q.id === o.component);
      const info = c && dr?.bodies[c.id]?.find((b) => b.id === body);
      if (!c || !info) return null;
      const hidden = c.hiddenBodies?.includes(body);
      return (
        <div className="props">
          <h3 className="sub">Body · {c.name}</h3>
          <label className="field"><span>Name</span><LazyInput label="Body name" mono={false} value={info.name} onCommit={(v) => v.trim() && patchComp(c.id, { bodyNames: { ...c.bodyNames, [body]: v.trim() } })} /></label>
          <p className="hint">Made by {c.items.find((i) => i.id === info.feature)?.name ?? info.feature}.</p>
          <MassTable m={info.mass} unit={u} />
          <div className="cadd-actions">
            <button className="btn" onClick={() => patchComp(c.id, { hiddenBodies: hidden ? c.hiddenBodies!.filter((x) => x !== body) : [...(c.hiddenBodies ?? []), body] })}>{hidden ? 'Show' : 'Hide'}</button>
            <button className="btn" onClick={() => setSel(`occ:${occ}`)}>Occurrence…</button>
          </div>
        </div>
      );
    }
    if (sel?.startsWith('item:')) {
      const id = sel.slice(5);
      const c = design.components.find((q) => q.items.some((i) => i.id === id));
      const it = c?.items.find((i) => i.id === id);
      if (!c || !it) return null;
      const idx = c.items.indexOf(it);
      return (
        <div className="props">
          <h3 className="sub">{FEATURE_LABEL[it.kind]}</h3>
          <label className="field"><span>Name</span><LazyInput label="Name" mono={false} value={it.name} onCommit={(v) => v.trim() && patchItem(c.id, it.id, { name: v.trim() })} /></label>
          {isSketch(it) && <p className="hint">On {'ref' in it.plane ? `the ${it.plane.ref} plane` : it.plane.label ?? 'a face'}{it.plane.offset ? `, offset ${it.plane.offset}` : ''}.</p>}
          {isSketch(it) && dr?.sketches[it.id] && <p className="hint">{dr.sketches[it.id].dof === 0 ? 'Fully defined' : `${dr.sketches[it.id].dof} DOF free`}{dr.sketches[it.id].section ? ` · A = ${num(dr.sketches[it.id].section!.A)} ${u}²` : ''}</p>}
          {isSketch(it) && <Expr label="Plane offset" value={it.plane.offset ?? ''} placeholder="0" onChange={(v) => patchItem(c.id, it.id, { plane: { ...it.plane, offset: v || undefined } } as Partial<DesignItem>)} />}
          {dr?.errors[it.id] && <div className="region-error">{dr.errors[it.id]}</div>}
          <div className="cadd-actions">
            <button className="btn primary" onClick={() => editItem(c.id, it)}>{isSketch(it) ? 'Edit sketch' : 'Edit feature'}</button>
            {!isSketch(it) && <button className="btn" onClick={() => patchItem(c.id, it.id, { suppressed: it.suppressed ? undefined : true })}>{it.suppressed ? 'Unsuppress' : 'Suppress'}</button>}
            {isSketch(it) && <button className="btn" onClick={() => patchItem(c.id, it.id, { hidden: it.hidden ? undefined : true } as Partial<DesignItem>)}>{it.hidden ? 'Show' : 'Hide'}</button>}
            <button className="btn" onClick={() => patchComp(c.id, { marker: idx + 1 >= c.items.length ? undefined : idx + 1 })}>Roll back to here</button>
            <button className="btn danger" onClick={() => removeItem(c.id, it.id)}><Trash2 size={13} /> Delete</button>
          </div>
        </div>
      );
    }
    if (sel?.startsWith('occ:')) {
      const o = occOf(sel.slice(4));
      if (!o) return null;
      const by = dr?.placements[o.id]?.by;
      const vec = (v: Vec3 | undefined, i: number, s: string, key: 'pos' | 'rot') => (
        <label className="field"><span>{s}</span>
          <input type="number" step="any" value={+(v?.[i] ?? 0).toFixed(6)} disabled={by === 'joint'} onChange={(e) => {
            const next = [...(v ?? [0, 0, 0])] as Vec3;
            next[i] = Number(e.target.value) || 0;
            patchOcc(o.id, { [key]: next }, `${key}:${o.id}`);
          }} />
        </label>
      );
      return (
        <div className="props">
          <h3 className="sub">Occurrence · {design.components.find((c) => c.id === o.component)?.name}</h3>
          <label className="field"><span>Name</span><LazyInput label="Occurrence name" mono={false} value={o.name ?? ''} placeholder={occLabel(o)} onCommit={(v) => patchOcc(o.id, { name: v.trim() || undefined })} /></label>
          <label className="check"><input type="checkbox" checked={!!o.grounded} onChange={(e) => patchOcc(o.id, { grounded: e.target.checked || undefined })} /> Grounded (fixed in place)</label>
          <p className="hint">{by === 'joint' ? 'Placed by a joint.' : by === 'ground' ? 'Fixed where the values below put it.' : 'Free: placed by the values below.'}</p>
          <div className="row3">{vec(o.pos, 0, `X (${u})`, 'pos')}{vec(o.pos, 1, `Y (${u})`, 'pos')}{vec(o.pos, 2, `Z (${u})`, 'pos')}</div>
          <div className="row3">{vec(o.rot, 0, 'Rx (°)', 'rot')}{vec(o.rot, 1, 'Ry (°)', 'rot')}{vec(o.rot, 2, 'Rz (°)', 'rot')}</div>
          {dr?.errors[o.id] && <div className="region-error">{dr.errors[o.id]}</div>}
          <div className="cadd-actions">
            <button className="btn" onClick={() => patchOcc(o.id, { hidden: o.hidden ? undefined : true })}>{o.hidden ? 'Show' : 'Hide'}</button>
            {design.occurrences.length > 1 && <button className="btn danger" onClick={() => {
              const d = cur();
              setDesign({ ...d, occurrences: d.occurrences.filter((q) => q.id !== o.id), joints: d.joints.filter((j) => j.a.occ !== o.id && j.b.occ !== o.id) });
              setSel(null);
            }}><Trash2 size={13} /> Delete</button>}
          </div>
        </div>
      );
    }
    if (sel?.startsWith('joint:')) {
      const j = design.joints.find((q) => q.id === sel.slice(6));
      if (!j) return null;
      return (
        <div className="props">
          <h3 className="sub">Joint · {j.type}</h3>
          <label className="field"><span>Name</span><LazyInput label="Joint name" mono={false} value={j.name} onCommit={(v) => v.trim() && patchJoint(j.id, { name: v.trim() })} /></label>
          {dr?.errors[j.id] && <div className="region-error">{dr.errors[j.id]}</div>}
          <div className="row2">
            <Expr label="Angle" value={j.angle} onChange={(angle) => patchJoint(j.id, { angle })} />
            <Expr label="Offset" value={j.offset} onChange={(offset) => patchJoint(j.id, { offset })} />
          </div>
          <p className="hint">In the worksheet: <code>{region.name || 'part'}.{j.name}</code> {j.type === 'rigid' ? '(rigid joints export nothing)' : ''}</p>
          <div className="cadd-actions">
            <button className="btn primary" onClick={() => { seal(); setDialog({ kind: 'joint', id: j.id, mark: mark(), isNew: false, picking: null }); }}>Edit joint</button>
            <button className="btn" onClick={() => patchJoint(j.id, { suppressed: j.suppressed ? undefined : true })}>{j.suppressed ? 'Unsuppress' : 'Suppress'}</button>
            <button className="btn danger" onClick={() => { setDesign({ ...cur(), joints: cur().joints.filter((q) => q.id !== j.id) }); setSel(null); }}><Trash2 size={13} /> Delete</button>
          </div>
        </div>
      );
    }
    if (sel?.startsWith('p:')) {
      return <div className="props"><h3 className="sub">Profile</h3><p className="hint">Extrude (E) or Revolve now uses this profile.</p></div>;
    }
    // the whole part
    return (
      <div className="props">
        <h3 className="sub">{region.name || 'Part'}</h3>
        <p className="hint">{design.components.length} component{design.components.length > 1 ? 's' : ''} · {design.occurrences.length} occurrence{design.occurrences.length > 1 ? 's' : ''} · {design.joints.length} joint{design.joints.length === 1 ? '' : 's'}</p>
        <div className="row2">
          <label className="field"><span>Material</span>
            <select value={material(region.density)?.density ?? (region.density.trim() ? 'custom' : 'none')} onChange={(e) => e.target.value !== 'custom' && set({ density: e.target.value === 'none' ? '' : e.target.value })}>
              {MATERIALS.map((m) => <option key={m.name} value={m.density}>{m.name}</option>)}
              <option value="custom">Custom</option><option value="none">No mass</option>
            </select>
          </label>
          <label className="field"><span>Density</span><LazyInput label="Density" value={region.density} onCommit={(v) => set({ density: v.trim() })} /></label>
        </div>
        <h3 className="sub">Mass properties (assembly)</h3>
        <MassTable m={dr?.total} unit={u} />
        {dr?.box && <p className="hint">Size {fmtNum(dr.box.max[0] - dr.box.min[0])} × {fmtNum(dr.box.max[1] - dr.box.min[1])} × {fmtNum(dr.box.max[2] - dr.box.min[2])} {u}</p>}
        {errorCount > 0 && (
          <>
            <h3 className="sub">Problems</h3>
            {Object.entries(dr!.errors).map(([id, e]) => {
              const name = design.components.flatMap((c) => c.items).find((i) => i.id === id)?.name ?? design.joints.find((j) => j.id === id)?.name ?? design.components.find((c) => c.id === id)?.name ?? id;
              return <div key={id} className="region-error">{name}: {e}</div>;
            })}
          </>
        )}
      </div>
    );
  })();

  // ------------------------------------------------------------ render

  const inSketch = !!(ds && sketchRegion);
  const tabs: { id: Tab; label: string }[] = inSketch
    ? [{ id: 'sketch', label: 'Sketch' }, { id: 'constrain', label: 'Constrain' }]
    : [{ id: 'solid', label: 'Solid' }, { id: 'assemble', label: 'Assemble' }, { id: 'inspect', label: 'Inspect' }, { id: 'file', label: 'File' }];
  const shownTab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  const selIds = ui.regionId === region.id ? ui.selected : [];
  const selOcc = sel?.startsWith('occ:') ? sel.slice(4) : sel?.startsWith('body:') ? parseBody(`b:${sel.slice(5)}`).occ : null;

  return (
    <div className="cadw" onPointerDown={(e) => e.stopPropagation()}>
      <header className="cadw-head">
        <div className="cadw-brand"><Box size={18} /> <b>mathstudii CAD</b></div>
        <input className="cadw-name" value={region.name} placeholder="Part name (variable)" aria-label="Part name"
          title="The worksheet uses this name: part.m, part.V, part.d1 …" onChange={(e) => set({ name: e.target.value.trim() })} />
        <select value={region.unit} onChange={(e) => set({ unit: e.target.value as CadRegion['unit'] })} aria-label="Units" title="Model units">
          {['mm', 'cm', 'm', 'in'].map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        {comp && <span className="cadw-active" title="New sketches and features go into the active component"><Layers size={14} /> {comp.name}</span>}
        {!connected && <span className="cadw-disconnected">Worksheet not connected — edits are not saved</span>}
        <span className="cadw-spacer" />
        <button className="icon-btn" onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo"><Undo2 size={17} /></button>
        <button className="icon-btn" onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)" aria-label="Redo"><Redo2 size={17} /></button>
        <button className={`icon-btn${showTree ? ' on' : ''}`} onClick={() => setShowTree(!showTree)} title="Browser" aria-label="Browser"><ListTree size={17} /></button>
        <button className={`icon-btn${showProps ? ' on' : ''}`} onClick={() => setShowProps(!showProps)} title="Properties" aria-label="Properties"><PanelRight size={17} /></button>
        <button className="cadw-close" onClick={onClose} title="Close the CAD window (the part stays in the worksheet)"><X size={16} /> Close</button>
      </header>

      <nav className="cadw-tabs" role="tablist">
        {tabs.map((t) => <button key={t.id} role="tab" aria-selected={shownTab === t.id} className={shownTab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}
        {inSketch && <button className="cadw-finish" onClick={finishSketch} title="Leave the sketch"><CheckCircle2 size={15} /> Finish sketch</button>}
      </nav>
      <div className="cadw-ribbon" role="toolbar">
        {shownTab === 'sketch' && (
          <>
            <Group label="Select">{toolBtn('select', <MousePointer2 size={20} />, 'Select', 'Select and drag (S)')}</Group>
            <Group label="Create">
              {toolBtn('line', <Slash size={20} />, 'Line', 'Line chain (L) — type a length while drawing')}
              {toolBtn('rect', <Square size={20} />, 'Rectangle', 'Corner rectangle (R)')}
              {toolBtn('crect', <SquareDashed size={20} />, 'Centre rect', 'Centre rectangle (Shift+R)')}
              {toolBtn('circle', <CircleIcon size={20} />, 'Circle', 'Circle (C)')}
              {toolBtn('arc', <RotateCcw size={20} />, 'Arc', 'Centre arc (A)')}
              {toolBtn('arc3', <Spline size={20} />, '3-pt arc', '3-point arc (Shift+A)')}
              {toolBtn('polygon', <Hexagon size={20} />, 'Polygon', 'Regular polygon (G)')}
              {toolBtn('slot', <Pill size={20} />, 'Slot', 'Straight slot (O)')}
              {toolBtn('point', <Dot size={20} />, 'Point', 'Point (P) — hole centres')}
            </Group>
            <Group label="Modify">
              {toolBtn('fillet', <SquareRoundCorner size={20} />, 'Fillet', 'Sketch fillet (I)')}
              {toolBtn('trim', <Scissors size={20} />, 'Trim', 'Trim (T)')}
              {toolBtn('mirror', <SquareSplitHorizontal size={20} />, 'Mirror', 'Mirror the selection about a line (M)')}
              <RibbonButton icon={<Construction size={20} />} label="Construction" title="Construction geometry (X)" on={ui.cadConstruction} onClick={() => cmd((cv) => cv.toggleConstruction())} />
              <RibbonButton icon={<Waypoints size={20} />} label="Project" title="Turn the body outlines in this plane into fixed sketch geometry" disabled={!reference.length} onClick={project} />
              <RibbonButton icon={<Trash2 size={20} />} label="Delete" title="Delete the selection (Del)" disabled={!selIds.length} onClick={() => cmd((cv) => cv.deleteSelected())} />
            </Group>
            <Group label="Dimension">{toolBtn('dim', <Ruler size={20} />, 'Dimension', 'Smart dimension (D)')}</Group>
            <Group label="Options">
              <div className="cadw-options">
                {tool === 'polygon' && <label>Sides <input type="number" min={3} max={64} value={ui.cadSides} onChange={(e) => setUi({ cadSides: Math.max(3, Math.min(64, Number(e.target.value) || 6)) })} /></label>}
                {tool === 'fillet' && <label>Radius <input type="number" min={0} step="any" value={ui.cadFillet} onChange={(e) => setUi({ cadFillet: Math.max(0, Number(e.target.value)) })} /> {u}</label>}
                {tool === 'dim' && (
                  <label>Type <select value={ui.cadDimKind} onChange={(e) => setUi({ cadDimKind: e.target.value as typeof ui.cadDimKind })}>
                    <option value="smart">Smart</option><option value="horizontal">Horizontal</option><option value="vertical">Vertical</option>
                  </select></label>
                )}
                <label title="Snap to the grid"><input type="checkbox" checked={ui.cadGridSnap} onChange={(e) => setUi({ cadGridSnap: e.target.checked })} /> Grid snap</label>
              </div>
            </Group>
            <Group label="Insert">
              <RibbonButton icon={<FileUp size={20} />} label="DXF" title="Import lines, arcs and circles from a DXF file" onClick={importDxf} />
              <RibbonButton icon={<FileDown size={20} />} label="Save DXF" title="Export this sketch as DXF" onClick={exportDxf} />
            </Group>
          </>
        )}
        {shownTab === 'constrain' && (
          <>
            <Group label="Relations">
              {CONSTRAINT_TOOLS.map((t) => (
                <RibbonButton key={t.type} icon={<b className="cadw-glyph">{t.glyph}</b>} label={t.label} title={`${t.help}${t.key ? ` (${t.key.toUpperCase()})` : ''}`}
                  onClick={() => cmd((cv) => cv.applyConstraint(t.type as ConstraintType))} />
              ))}
            </Group>
            <Group label="Dimension">{toolBtn('dim', <Ruler size={20} />, 'Dimension', 'Smart dimension (D)')}</Group>
          </>
        )}
        {shownTab === 'solid' && (
          <>
            <Group label="Create">
              <RibbonButton icon={<PenTool size={20} />} label="Sketch" title="Create a sketch on a plane or a flat face" on={dialog?.kind === 'sketch'} onClick={() => setDialog({ kind: 'sketch', ref: 'XY', offset: '' })} />
              <RibbonButton icon={<ArrowUpFromLine size={20} />} label="Extrude" title="Extrude profiles: new body, join, cut or intersect (E)" onClick={() => startFeature('extrude')} />
              <RibbonButton icon={<RotateCw size={20} />} label="Revolve" title="Revolve profiles about an axis" onClick={() => startFeature('revolve')} />
              <RibbonButton icon={<CircleDot size={20} />} label="Hole" title="Holes at sketch points: simple, counterbore, countersink (H)" onClick={() => startFeature('hole')} />
            </Group>
            <Group label="Pattern">
              <RibbonButton icon={<Grid3x3 size={20} />} label="Pattern" title="Rectangular or circular pattern of features or bodies" onClick={() => startFeature('pattern')} />
              <RibbonButton icon={<FlipHorizontal2 size={20} />} label="Mirror" title="Mirror features or bodies about a plane" onClick={() => startFeature('mirror')} />
            </Group>
            <Group label="Modify">
              <RibbonButton icon={<Combine size={20} />} label="Combine" title="Join, cut or intersect bodies" onClick={() => startFeature('combine')} />
            </Group>
            <Group label="View">
              <RibbonButton icon={<Crosshair size={20} />} label="Planes" title="Show the origin planes" on={showPlanes} onClick={() => setShowPlanes(!showPlanes)} />
              <div className="cadw-options">
                <label><select value={display} onChange={(e) => setDisplay(e.target.value as Display)} aria-label="Display style">
                  <option value="shadedEdges">Shaded with edges</option><option value="shaded">Shaded</option><option value="wireframe">Wireframe</option>
                </select></label>
              </div>
            </Group>
          </>
        )}
        {shownTab === 'assemble' && (
          <>
            <Group label="Components">
              <RibbonButton icon={<Boxes size={20} />} label="New" title="New component (it becomes the active one)" onClick={newComponent} />
              <RibbonButton icon={<Box size={20} />} label="Insert copy" title="Another occurrence of the active component" onClick={() => insertOccurrence()} />
            </Group>
            <Group label="Position">
              <RibbonButton icon={<Link2 size={20} />} label="Joint" title="Join two occurrences: rigid, revolute, slider, cylindrical (J)" onClick={startJoint} />
              <RibbonButton icon={<Anchor size={20} />} label="Ground" title="Fix the selected occurrence in place" disabled={!selOcc}
                onClick={() => { const o = selOcc && occOf(selOcc); if (o) patchOcc(o.id, { grounded: o.grounded ? undefined : true }); }} />
              <RibbonButton icon={<Move3d size={20} />} label="Move" title="Position the selected occurrence" disabled={!selOcc} onClick={() => selOcc && setSel(`occ:${selOcc}`)} />
            </Group>
            <Group label="Check">
              <RibbonButton icon={<ScanSearch size={20} />} label="Interference" title="Find overlapping occurrences" onClick={runInterference} />
              <RibbonButton icon={<Layers size={20} />} label="Isolate" title="Dim everything outside the active component" on={isolate} onClick={() => setIsolate(!isolate)} />
            </Group>
          </>
        )}
        {shownTab === 'inspect' && (
          <>
            <Group label="Inspect">
              <RibbonButton icon={<Ruler size={20} />} label="Measure" title="Distance between two picked points (M)" on={dialog?.kind === 'measure'} onClick={() => setDialog({ kind: 'measure', pts: [] })} />
              <RibbonButton icon={<ScanSearch size={20} />} label="Interference" title="Find overlapping occurrences" onClick={runInterference} />
            </Group>
            <Group label="Mass properties">
              <div className="cadw-readout">
                {dr?.total ? <span>V = <b>{num(dr.total.V)}</b> {u}³</span> : <span className="cadw-muted">No solid yet</span>}
                {dr?.total?.m !== undefined && <span>m = <b>{num(dr.total.m, 4)}</b> kg</span>}
                {dr?.total && <span>CoG = ({num(dr.total.xg, 4)}, {num(dr.total.yg, 4)}, {num(dr.total.zg, 4)}) {u}</span>}
              </div>
            </Group>
          </>
        )}
        {shownTab === 'file' && (
          <Group label="Export">
            <RibbonButton icon={<Download size={20} />} label="STL" title="Export the assembly as STL (3-D printing)" onClick={exportStl} />
          </Group>
        )}
      </div>

      <div className="cadw-main">
        {showTree && (
          <aside className="cadw-tree" aria-label="Browser">
            <ul>
              <Node k="comps" icon={<Boxes size={14} />} label="Components">
                {design.components.map((c) => {
                  const bodies = dr?.bodies[c.id] ?? [];
                  const sks = c.items.filter(isSketch);
                  const occ = editOccurrence(design, c.id);
                  return (
                    <Node key={c.id} k={`c:${c.id}`} icon={<input type="radio" className="cadw-radio" checked={c.id === comp?.id} onChange={() => setActive(c.id)} title="Activate" aria-label={`Activate ${c.name}`} />}
                      label={c.name} on={sel === `comp:${c.id}`} onClick={() => setSel(`comp:${c.id}`)} bad={!!dr?.errors[c.id]}>
                      <Node k={`cb:${c.id}`} icon={<Box size={13} />} label={`Bodies (${bodies.length})`}>
                        {bodies.map((b) => (
                          <Node key={b.id} k={`b:${b.id}`} icon={<Box size={12} />} label={b.name} on={!!occ && sel === `body:${occ.id}:${b.id}`}
                            onClick={() => occ && setSel(`body:${occ.id}:${b.id}`)}
                            extra={eye(c.hiddenBodies?.includes(b.id), () => patchComp(c.id, { hiddenBodies: c.hiddenBodies?.includes(b.id) ? c.hiddenBodies.filter((x) => x !== b.id) : [...(c.hiddenBodies ?? []), b.id] }))} />
                        ))}
                      </Node>
                      <Node k={`cs:${c.id}`} icon={<PenTool size={13} />} label={`Sketches (${sks.length})`}>
                        {sks.map((s) => (
                          <Node key={s.id} k={`s:${s.id}`} icon={<PenTool size={12} />} label={s.name} on={sel === `item:${s.id}`} onClick={() => { setActive(c.id); setSel(`item:${s.id}`); }} bad={!!dr?.errors[s.id]}
                            badge={dr?.sketches[s.id] ? (dr.sketches[s.id].dof === 0 ? '✓' : String(dr.sketches[s.id].dof)) : undefined}
                            extra={eye(s.hidden, () => patchItem(c.id, s.id, { hidden: s.hidden ? undefined : true } as Partial<DesignItem>))} />
                        ))}
                      </Node>
                    </Node>
                  );
                })}
              </Node>
              <Node k="occs" icon={<Layers size={14} />} label={`Occurrences (${design.occurrences.length})`}>
                {design.occurrences.map((o) => (
                  <Node key={o.id} k={`o:${o.id}`} icon={o.grounded ? <Anchor size={12} /> : <Move3d size={12} />} label={occLabel(o)} on={sel === `occ:${o.id}`} onClick={() => setSel(`occ:${o.id}`)}
                    badge={dr?.placements[o.id]?.by === 'joint' ? 'joint' : undefined}
                    extra={eye(o.hidden, () => patchOcc(o.id, { hidden: o.hidden ? undefined : true }))} />
                ))}
              </Node>
              <Node k="joints" icon={<Link2 size={14} />} label={`Joints (${design.joints.length})`}>
                {design.joints.map((j) => (
                  <Node key={j.id} k={`j:${j.id}`} icon={<Link2 size={12} />} label={`${j.name} · ${j.type}`} on={sel === `joint:${j.id}`} onClick={() => setSel(`joint:${j.id}`)} bad={!!dr?.errors[j.id]} />
                ))}
              </Node>
            </ul>
            {dr?.total && (
              <div className="cadw-summary">
                <div>V = {num(dr.total.V)} {u}³</div>
                {dr.total.m !== undefined && <div>m = {num(dr.total.m, 4)} kg</div>}
              </div>
            )}
          </aside>
        )}

        <section className="cadw-view" ref={viewRef}>
          {inSketch ? (
            <CadCanvas ref={canvas} region={sketchRegion!} result={sketchResult} dispatch={sketchDispatch} width={size.w} height={size.h} interactive
              onStatus={setStatus} onUndo={onUndo} onRedo={onRedo} reference={reference} />
          ) : (
            <Scene3D
              width={size.w} height={size.h} meshes={scene.meshes} lines={scene.lines} planes={scene.planes} view={view3d} onView={setView3d}
              navigation="full" display={display} onPick={(h) => onPick(h)}
              onHover={(h) => setHover(h.kind !== 'none' && (h.key?.startsWith('b:') || h.key?.startsWith('p:') || h.key?.startsWith('pl:')) ? h.key! : null)}
              message={!K ? 'Loading the 3-D kernel…' : !scene.meshes.length && !scene.lines.length && !scene.planes.length ? 'Solid → Sketch: pick a plane, draw a profile, then Extrude' : undefined}
            />
          )}
          {inSketch && !ds!.sketch.entities.length && (
            <div className="cadw-empty">
              <b>Sketch on {'ref' in ds!.plane ? `the ${ds!.plane.ref} plane` : ds!.plane.label ?? 'a face'}</b>
              <span>Line (L), Rectangle (R), Circle (C) … then add relations and dimensions. Grey outlines are the bodies this plane cuts — Project turns them into geometry.</span>
            </div>
          )}
        </section>

        {showProps && (
          <aside className="cadw-props" aria-label="Properties">
            {dialogPanel ?? (inSketch ? (
              <>
                <h3 className="sub">{ds!.name}</h3>
                <SketchPanel sketch={ds!.sketch} result={sketchResult} unit={u} partName={region.name} selected={selIds}
                  onSelect={(ids) => setUi({ regionId: region.id, selected: ids })} onSketch={onSketch} />
              </>
            ) : selectionPanel)}
          </aside>
        )}
      </div>

      {!inSketch && comp && (
        <div className="cadw-timeline" aria-label="Timeline">
          <div className="cadw-tl-ctl">
            <button className="icon-btn" title="Roll back to the start" aria-label="Roll back to the start" onClick={() => setMarker(0)}><SkipBack size={14} /></button>
            <button className="icon-btn" title="Step back" aria-label="Step back" onClick={() => setMarker(marker - 1)}><StepBack size={14} /></button>
            <button className="icon-btn" title="Step forward" aria-label="Step forward" onClick={() => setMarker(marker + 1)}><StepForward size={14} /></button>
            <button className="icon-btn" title="Play to the end" aria-label="Play to the end" onClick={() => setMarker(comp.items.length)}><SkipForward size={14} /></button>
          </div>
          <div className="cadw-tl-items">
            {comp.items.map((it, i) => (
              <span key={it.id} className="cadw-tl-slot">
                {i === marker && <span className="cadw-tl-marker" title="Timeline marker" />}
                <button
                  className={`cadw-tl-item${i >= marker ? ' rolled' : ''}${'suppressed' in it && it.suppressed ? ' off' : ''}${dr?.errors[it.id] ? ' bad' : ''}${sel === `item:${it.id}` ? ' on' : ''}`}
                  title={`${it.name}${dr?.errors[it.id] ? ` — ${dr.errors[it.id]}` : ''} (double-click to edit)`} aria-label={it.name}
                  onClick={() => setSel(`item:${it.id}`)} onDoubleClick={() => editItem(comp.id, it)}
                >
                  {ICON[it.kind]}
                </button>
              </span>
            ))}
            {marker >= comp.items.length && comp.items.length > 0 && <span className="cadw-tl-marker" title="Timeline marker" />}
            {!comp.items.length && <span className="cadw-muted">The timeline of {comp.name} is empty</span>}
          </div>
        </div>
      )}

      <footer className="cadw-status">
        {inSketch && <span className="cadw-coords">{status.cursor ? <>X <b>{fmtNum(status.cursor.x)}</b> Y <b>{fmtNum(status.cursor.y)}</b> {u}</> : ' '}</span>}
        {inSketch && sketchResult && (
          <span className={`cadw-dof ${!sketchResult.ok ? 'bad' : sketchResult.dof === 0 ? 'ok' : 'free'}`}>
            {!sketchResult.ok ? `Over-defined: ${sketchResult.conflicting.length} conflicting` : sketchResult.dof === 0 ? 'Fully defined' : `Under-defined · ${sketchResult.dof} DOF`}
          </span>
        )}
        {!inSketch && (kernelState || errorCount > 0) && <span className={`cadw-dof ${errorCount ? 'warn' : ''}`}>{kernelState || `${errorCount} problem${errorCount > 1 ? 's' : ''}`}</span>}
        <span className="cadw-hint">{hintText}</span>
        {inSketch && <label className="cadw-snaptoggle" title="Show relation glyphs"><input type="checkbox" checked={ui.cadRelations} onChange={(e) => setUi({ cadRelations: e.target.checked })} /> Relations</label>}
        {inSketch && <label className="cadw-snaptoggle" title="Snap to the grid"><Magnet size={13} /> <input type="checkbox" checked={ui.cadGridSnap} onChange={(e) => setUi({ cadGridSnap: e.target.checked })} /> Grid</label>}
        <span className="cadw-units">{u}</span>
      </footer>
    </div>
  );
}
