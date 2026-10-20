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
  Layers, Crosshair, Download, Magnet, Waypoints, Cone, SquareSlash, FileBox,
  Radius, Octagon, PackageOpen, Pyramid, ArrowUpDown, Slice, Move, Route, Tornado, Screw, Diamond, MoveDiagonal, Locate, TriangleRight,
  LineSquiggle, SplinePointer, Ellipse as EllipseIcon, CircleDotDashed, Type, VectorSquare, CornerRightDown, MoveHorizontal, ScissorsLineDashed,
  Grid2x2, Rotate3d, ScanLine,
  SlidersHorizontal, Cog, Group as GroupIcon, Link, Clapperboard, Expand, ClipboardList, Play, Film, Images,
} from 'lucide-react';
import type { CadRegion } from '../../model/types';
import type { CadResult } from '../../cad/evaluate';
import { MATERIALS, cadId, reserveDimNames, type CadSketch, type ConstraintType, type SketchSource } from '../../cad/model';
import { withReferencesOf } from '../../cad/reference';
import { CONSTRAINT_TOOLS } from '../../cad/edit';
import {
  FEATURE_LABEL, MODIFY_KINDS, activeItems, designOf, facePlane, findSketch, isConstruct, isModify, isSketch, itemName, jointFrame, nextName, picksOnBodies, profileKey, sketchFace,
  type CadComponent, type CadDesign, type CadJoint, type CadOccurrence, type ConstructItem, type DesignFeature, type DesignItem, type DesignSketch, type JointOrigin,
  type ModifyFeature, type PlaneRef,
} from '../../cad/design';
import { MM_PER, threadFor } from '../../cad/threads';
import { m4Dir, m4Inv, m4Point, norm3, sub3, type Vec3 } from '../../cad/solid';
import { baseName, edgeWords, faceWords, keyFeature, refTo, refToken, resolveRef, type TopoRef } from '../../cad/topology';
import type { Vec2 } from '../../cad/profile';
import { designNumbers } from '../../cad/keys';
import type { BodyResult } from '../../cad/buildResult';
import type { Distance, EntityRef, Interference, SectionBody } from '../../cad/kernel/protocol';
import { bodyOf, pickOf, resolveSelection, select, type Selection } from '../../cad/selection';
import type { Action } from '../store';
import { useSketchUI, type CadTool } from '../sketch/context';
import { exportFile, pickFile } from '../../platform/files';
import { LazyInput } from '../sketch/SketchProps';
import { CadCanvas, type CadCanvasHandle, type CanvasStatus } from './CadCanvas';
import { STANDARD_VIEWS, type Display } from './Cad3DView';
import { Scene3D, sceneBounds, type Bounds, type PickHit, type SceneView } from './Scene3D';
import { buildScene, editOccurrence, sketchRegions } from './useDesign';
import { exportPart, type PartFormat } from './exportPart';
import { pickLabel, SelectionPanel } from './SelectionPanel';
import { isSuperseded, kernelRequest, useBuildResult, warmKernel } from './kernelClient';
import { Checks, Dialog, Expr, FeatureFields, JointFields, Pick, featureTitle } from './FeatureDialogs';
import { ModifyFields, type PickTarget } from './ModifyDialogs';
import { BuildFields, emptyDef, isBuildFeature, withPick, type FieldPick } from './ConstructDialogs';
import { candidateGlyphs, jointCandidates, nearestCandidate, type JointCandidate } from './jointPick';
import { MassTable, SketchPanel, num } from './SketchPanel';
import { fmtNum } from './cadRender';
import { JOINT_DOFS, JOINT_LABEL, dofLabel, isAngleDof, type DofKey } from '../../cad/assembly';
import { bomCsv, bomTable, bomTsv } from '../../cad/bom';
import { autoExplode } from '../../cad/explode';
import { m4Mul } from '../../cad/solid';
import { sampleTimes } from '../../cad/motion';
import { asBuiltOrigin, placementsWithout } from '../../cad/kinematics';
import { paintHits, useAssemblyView } from './assemblyView';
import { BomPanel, ClearanceChart, DrivePanel, ExplodeFields, JointDofFields, LinkFields, MotionFields, MotionTransport, dofExpr, dofText, drivePatches, drivenDofs, motionTsv, useMotionPlayer } from './AssemblyPanels';
import { canRecord, exportPngFrames, recordWebm } from './motionExport';

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
  /**
   * A feature being edited. Modify features: `target` is the plane or axis field waiting for a
   * click, `set` the fillet set clicked edges go into, and `rollback` the timeline marker to
   * put back afterwards (a feature edited from the timeline is shown as it was built).
   */
  | { kind: 'feature'; cid: string; id: string; mark: number; isNew: boolean; target?: PickTarget; set?: number; rollback?: { marker: number | undefined }; pick?: FieldPick }
  /** A new sketch: on an origin plane or a construction plane (its id). */
  | { kind: 'sketch'; ref: PlaneRef | string; offset: string }
  /** `asBuilt`: one pick places both origins where the parts are now (nothing moves). */
  | { kind: 'joint'; id: string; mark: number; isNew: boolean; picking: 'a' | 'b' | null; snap?: string; asBuilt?: boolean }
  /** A DOF moved by hand: the view follows, the document only on Set as value. */
  | { kind: 'drive'; joint: string; dof: DofKey; value: number }
  | { kind: 'link'; id: string; mark: number; isNew: boolean }
  /** Occurrences to lock together. */
  | { kind: 'group'; occs: string[] }
  | { kind: 'motion'; id: string; mark: number; isNew: boolean; busy?: string }
  | { kind: 'measure'; picks: Measured[]; result?: Distance | null; error?: string }
  | { kind: 'interference'; rows: Interference[] | null; error?: string };

/** Something picked to measure, with what the panel says about it. */
interface Measured {
  ref: EntityRef;
  label: string;
}

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
  /** Make everything since undo depth `m` one step (a dialog's edits and the rollback around them). */
  const squash = useCallback((m: number) => {
    const steps = undoStack.current.slice(m);
    if (steps.length < 2) return;
    const before: Record<string, unknown> = {};
    for (const e of steps) for (const [k, v] of Object.entries(e.before)) if (!(k in before)) before[k] = v;
    undoStack.current.length = m;
    undoStack.current.push({ before: before as Snapshot });
  }, []);
  return { tracked, undo, redo, mark, revertTo, seal, squash, canUndo: undoStack.current.length > 0, canRedo: redoStack.current.length > 0 };
}

const fmtLen = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(3));

const mapComp = (d: CadDesign, cid: string, fn: (c: CadComponent) => CadComponent): CadDesign => ({ ...d, components: d.components.map((c) => (c.id === cid ? fn(c) : c)) });

const ICON: Record<DesignItem['kind'], ReactNode> = {
  sketch: <PenTool size={14} />, extrude: <ArrowUpFromLine size={14} />, revolve: <RotateCw size={14} />, hole: <CircleDot size={14} />,
  pattern: <Grid3x3 size={14} />, mirror: <FlipHorizontal2 size={14} />, combine: <Combine size={14} />, loft: <Cone size={14} />,
  fillet: <Radius size={14} />, chamfer: <Octagon size={14} />, shell: <PackageOpen size={14} />, draft: <Pyramid size={14} />,
  presspull: <ArrowUpDown size={14} />, split: <Slice size={14} />, move: <Move size={14} />,
  sweep: <Route size={14} />, coil: <Tornado size={14} />, thread: <Screw size={14} />, rib: <TriangleRight size={14} />,
  plane: <Diamond size={14} />, axis: <MoveDiagonal size={14} />, point: <Locate size={14} />,
};

/** Where a sketch is: "the XY plane", "the end face of Extrude1", "face of Body1" (made before sketches followed faces). */
const planeWords = (s: DesignSketch) => ('ref' in s.plane ? `the ${s.plane.ref} plane` : sketchFace(s) && s.plane.label ? `the ${s.plane.label}` : s.plane.label ?? 'a face');

/** Every reference an item holds (in its fields, lists and definition). */
function refsIn(v: unknown, out: TopoRef[] = []): TopoRef[] {
  if (!v || typeof v !== 'object') return out;
  const r = v as Partial<TopoRef>;
  if ((r.kind === 'face' || r.kind === 'edge' || r.kind === 'vertex') && typeof r.key === 'string' && r.hint) out.push(r as TopoRef);
  else for (const x of Array.isArray(v) ? v : Object.values(v)) refsIn(x, out);
  return out;
}

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
  const { tracked: dispatch, undo: onUndo, redo: onRedo, mark, revertTo, seal, squash, canUndo, canRedo } = usePartHistory(region, rawDispatch);
  const { ui, setUi } = useSketchUI();
  const design = useMemo(() => designOf(region), [region]);
  const designRef = useRef(design);
  designRef.current = design;
  const cur = () => designRef.current;
  const shown = useBuildResult(region.id, design, result);
  const build = shown.build;
  const dr = result?.design;
  const u = region.unit;
  // the kernel loads as soon as the workspace opens
  useEffect(() => warmKernel(), []);
  // the second click of the double-click that opened the workspace over the page picks nothing
  const openedAt = useRef(performance.now());

  const [tab, setTab] = useState<Tab>('solid');
  const [active, setActive] = useState(design.components[0]?.id ?? '');
  const [sketchId, setSketchId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dlg | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  // faces and edges picked in the view (the selection the inspector describes)
  const [picks, setPicks] = useState<Selection>([]);
  const [hoverPick, setHoverPick] = useState<{ key: string; face?: number; edge?: number } | null>(null);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState<CanvasStatus>({ hint: '', msg: '' });
  const [msg, setMsg] = useState('');
  const [display, setDisplay] = useState<Display>('shadedEdges');
  const [showPlanes, setShowPlanes] = useState(true);
  const [isolate, setIsolate] = useState(false);
  // inspection: a section plane through the model
  const [section, setSection] = useState<{ plane: 'XY' | 'XZ' | 'YZ'; at: number; flip: boolean } | null>(null);
  // phones start with the panels folded away; they open over the view
  const narrow = typeof window !== 'undefined' && window.innerWidth < 760;
  const [showTree, setShowTree] = useState(!narrow);
  const [showProps, setShowProps] = useState(!narrow);
  const [open, setOpen] = useState<Record<string, boolean>>({ comps: true, occs: true, joints: true, links: true, groups: true, motions: true });
  // the exploded view: how far out (0…1), null while assembled; trails from where the parts were
  const [explode, setExplode] = useState<number | null>(null);
  const [trails, setTrails] = useState(true);
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

  /** Body outlines in the plane of the open sketch, from the kernel. */
  const [reference, setReference] = useState<Vec2[][]>([]);
  const sketchFrame = ds ? dr?.frames[ds.id] : undefined;
  useEffect(() => {
    if (!ds || !sketchComp || !dr || !sketchFrame) return setReference([]);
    let live = true;
    kernelRequest({ op: 'outline', design: designRef.current, numbers: designNumbers(dr), component: sketchComp.id, frame: sketchFrame }, 'outline').then(
      (r) => live && setReference(r),
      (e) => live && !isSuperseded(e) && setReference([]),
    );
    return () => {
      live = false;
    };
    // the frame is in the design key: a worksheet recalculating for other reasons asks nothing
  }, [ds?.id, sketchComp?.id, dr?.display]); // eslint-disable-line react-hooks/exhaustive-deps

  const enterSketch = (id: string) => {
    finishRollback();
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

  /**
   * A new modify feature, with what is picked in the view (edges for a fillet, faces for a
   * shell …) or the selected body to start from.
   */
  const startModify = (kind: ModifyFeature['kind'], id: string, name: string): ModifyFeature | null => {
    if (!comp) return null;
    if (!bodiesNow.length) {
      setMsg(`There is no body to ${kind === 'presspull' ? 'press-pull' : kind} yet`);
      return null;
    }
    const occ = editOccurrence(design, comp.id);
    const mine = picks.filter((p) => p.occ === occ?.id);
    const refsOf = (k: 'face' | 'edge'): TopoRef[] => mine.filter((p) => p.kind === k).flatMap((p) => {
      const b = build && bodyOf(build, design, p.occ, p.body);
      const e = b && (k === 'face' ? b.faces[p.index] : b.edges[p.index]);
      return e ? [refTo(k, p.body, e)] : [];
    });
    const chosen = sel?.startsWith('body:') ? parseBody(`b:${sel.slice(5)}`).body : undefined;
    const body = chosen && bodiesNow.some((b) => b.id === chosen) ? chosen : bodiesNow[bodiesNow.length - 1].id;
    if (mine.length) setPicks([]);
    switch (kind) {
      case 'fillet': return { kind, id, name, sets: [{ edges: refsOf('edge'), r: '2' }] };
      case 'chamfer': return { kind, id, name, edges: refsOf('edge'), type: 'equal', d: '1' };
      case 'shell': {
        const faces = refsOf('face');
        return { kind, id, name, faces, t: '2', side: 'inside', ...(faces.length ? {} : { body }) };
      }
      case 'draft': return { kind, id, name, faces: refsOf('face'), plane: 'XY', angle: '3 deg' };
      case 'presspull': return { kind, id, name, faces: refsOf('face'), d: '5' };
      case 'split': {
        // through the middle of the body, across its longest side
        const bb = build?.components[comp.id]?.bodies.find((b) => b.id === body)?.box;
        const ext = bb ? [0, 1, 2].map((i) => bb.max[i] - bb.min[i]) : [0, 0, 1];
        const axis = ext.indexOf(Math.max(...ext));
        const plane = (['YZ', 'XZ', 'XY'] as const)[axis];
        // the XZ plane's normal is −Y
        const mid = bb ? ((bb.min[axis] + bb.max[axis]) / 2) * (axis === 1 ? -1 : 1) : 0;
        return { kind, id, name, body, plane, ...(mid ? { offset: String(+mid.toPrecision(6)) } : {}) };
      }
      case 'move': return { kind, id, name, bodies: [body] };
    }
  };

  /** Faces or edges picked in the view (on the active component) that `ok` takes, as references; the picks are used up. */
  const usePicks = (k: 'face' | 'edge', ok: (e: BodyResult['faces'][number] | BodyResult['edges'][number]) => boolean = () => true): TopoRef[] => {
    const occ = comp && editOccurrence(design, comp.id);
    const out: TopoRef[] = [];
    for (const p of picks) {
      if (p.occ !== occ?.id || p.kind !== k) continue;
      const b = build && bodyOf(build, design, p.occ, p.body);
      const e = b && (k === 'face' ? b.faces[p.index] : b.edges[p.index]);
      if (e && ok(e)) out.push(refTo(k, p.body, e));
    }
    if (out.length) setPicks([]);
    return out;
  };

  /** A new sweep, coil, thread or construction item, from what is selected or picked in the view. */
  const startBuild = (kind: 'sweep' | 'coil' | 'thread' | 'plane' | 'axis' | 'point', id: string, name: string, op: 'new' | 'join'): DesignFeature | null => {
    const isCyl = (e: unknown) => (e as { type?: string }).type === 'cylinder';
    const isFlat = (e: unknown) => !!(e as { frame?: unknown }).frame;
    switch (kind) {
      case 'sweep': {
        const sk = selProfile ? findSketch(cur(), selProfile.sketch) : selSketch && sketchRegions(selSketch, result).length ? selSketch : lastSketch((s) => sketchRegions(s, result).length > 0);
        if (!sk) {
          setMsg('Sketch a closed profile, and the path on another plane (lines and arcs end to end), then Sweep');
          return null;
        }
        // the path: edges picked in the view, else the last sketch of open curves, else the helix of a path-only coil
        const edges = usePicks('edge');
        const pathSketch = lastSketch((s) => s.id !== sk.id && s.sketch.entities.some((e) => e.type !== 'point') && !sketchRegions(s, result).length);
        const coil = [...items].reverse().find((i) => i.kind === 'coil' && i.pathOnly);
        const path = edges.length ? { kind: 'edges' as const, edges } : pathSketch ? { kind: 'sketch' as const, sketch: pathSketch.id } : coil ? { kind: 'coil' as const, coil: coil.id } : { kind: 'sketch' as const, sketch: sk.id };
        return { kind, id, name, sketch: sk.id, ...(selProfile?.sketch === sk.id ? { profile: selProfile.key } : {}), path, op };
      }
      case 'coil': {
        const face = usePicks('face', isFlat)[0];
        return { kind, id, name, plane: face ?? 'XY', mode: 'revs-pitch', d: '20', revs: '5', pitch: '5', section: 'circle', size: '2', op };
      }
      case 'thread': {
        if (!bodiesNow.length) {
          setMsg('There is no body to thread yet');
          return null;
        }
        const faces = usePicks('face', isCyl);
        // the size that fits the first face: a shaft's major diameter, a hole's tap drill
        const occ = comp && editOccurrence(design, comp.id);
        const b = faces[0] && occ && build ? bodyOf(build, design, occ.id, faces[0].body) : null;
        const f0 = b?.faces.find((q) => q.key === faces[0].key);
        const fits = f0?.radius ? threadFor(2 * f0.radius * (MM_PER[u] ?? 1), f0.outward === false) : null;
        return { kind, id, name, faces, size: fits?.name ?? 'M10' };
      }
      case 'plane': {
        const face = usePicks('face', isFlat)[0];
        return { kind, id, name, def: { type: 'offset', plane: face ?? 'XY', d: '10' } } as ConstructItem;
      }
      case 'axis': {
        const edge = usePicks('edge', (e) => !!(e as { line?: unknown }).line || !!(e as { circle?: unknown }).circle)[0];
        const cyl = edge ? undefined : usePicks('face', isCyl)[0];
        return { kind, id, name, def: edge ? { type: 'edge', edge } : cyl ? { type: 'cylinder', face: cyl } : emptyDef('axis', 'points') } as ConstructItem;
      }
      case 'point': {
        const circle = usePicks('edge', (e) => !!(e as { circle?: unknown }).circle)[0];
        return { kind, id, name, def: circle ? { type: 'centre', of: circle } : emptyDef('point', 'vertex') } as ConstructItem;
      }
    }
  };

  const startFeature = (kind: DesignFeature['kind']) => {
    if (!comp) return;
    // "Press pull" names its features PressPull1 …
    const name = nextName(cur(), FEATURE_LABEL[kind].replace(/ (\w)/g, (_, c: string) => c.toUpperCase()));
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
    } else if (kind === 'loft') {
      const withProfiles = items.filter((i): i is DesignSketch => isSketch(i) && sketchRegions(i, result).length > 0);
      if (withProfiles.length < 2) return setMsg('A loft joins profiles of two sketches on different planes: make a second sketch on an offset plane first');
      const [a, b] = withProfiles.slice(-2);
      f = { kind, id, name, sketch: a.id, sketch2: b.id, op };
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
    } else if (kind === 'rib') {
      const open = (s: DesignSketch) => s.sketch.entities.some((e) => (e.type === 'line' || e.type === 'arc') && !e.construction);
      const sk = selSketch && open(selSketch) ? selSketch : lastSketch(open);
      if (!sk) return setMsg('Draw the rib’s line on a plane through its middle first (Solid → Sketch)');
      if (!bodiesNow.length) return setMsg('A rib stands on a body: make one first');
      f = { kind, id, name, sketch: sk.id, thickness: '2', op: 'join' };
    } else if (kind === 'sweep' || kind === 'coil' || kind === 'thread' || kind === 'plane' || kind === 'axis' || kind === 'point') {
      const m = startBuild(kind, id, name, op);
      if (!m) return;
      f = m;
    } else if (MODIFY_KINDS.has(kind)) {
      const m = startModify(kind as ModifyFeature['kind'], id, name);
      if (!m) return;
      f = m;
    } else {
      if (bodiesNow.length < 2) return setMsg('Combine needs two bodies in this component');
      f = { kind: 'combine', id, name, target: bodiesNow[0].id, tools: bodiesNow.slice(1).map((b) => b.id), op: 'join' };
    }
    // a feature edited with the timeline rolled back is done: the new one goes where the marker was
    finishRollback();
    seal();
    const m = mark();
    insertItem(comp.id, f);
    setSel(null);
    setDialog({ kind: 'feature', cid: comp.id, id, mark: m, isNew: true });
  };

  const editItem = (cid: string, item: DesignItem) => {
    setActive(cid);
    if (isSketch(item)) return enterSketch(item.id);
    finishRollback();
    seal();
    const m = mark();
    // a modify feature picks on the bodies as it found them: the features after it roll back meanwhile
    const c = cur().components.find((q) => q.id === cid);
    const idx = c ? c.items.indexOf(item) : -1;
    const rollback = c && picksOnBodies(item) && idx + 1 < (c.marker ?? c.items.length) ? { marker: c.marker } : undefined;
    if (rollback) patchComp(cid, { marker: idx + 1 });
    setDialog({ kind: 'feature', cid, id: item.id, mark: m, isNew: false, rollback });
  };

  /** A new sketch on a construction plane (as built: the sketch keeps to it). */
  const sketchOnDatum = (id: string, offset: string) => {
    const cid = design.components.find((c) => c.items.some((i) => i.id === id))?.id;
    const d = cid ? build?.components[cid]?.datums?.[id] : undefined;
    if (!cid || d?.kind !== 'plane') return setMsg('That construction plane has not been built (yet)');
    const off = offset.trim() && offset.trim() !== '0' ? { offset: offset.trim() } : {};
    newSketchOn({ frame: { o: d.frame.o, u: d.frame.u, v: d.frame.v }, datum: id, label: itemName(cur(), id), ...off }, cid);
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
  const startJoint = (asBuilt = false) => {
    const d = cur();
    if (d.occurrences.length < 2) return setMsg('A joint needs two occurrences: Assemble → New component or Insert copy first');
    const ground = d.occurrences.find((o) => o.grounded) ?? d.occurrences[0];
    const other = [...d.occurrences].reverse().find((o) => o.id !== ground.id)!;
    const id = cadId('j');
    seal();
    const m = mark();
    // an as-built joint holds nothing until its origin is picked: a free part must not jump onto the other's origin first
    setDesign({ ...d, joints: [...d.joints, { id, name: nextName(d, 'Joint'), type: 'rigid', a: { occ: ground.id, origin: { kind: 'origin' } }, b: { occ: other.id, origin: { kind: 'origin' } }, angle: '0', offset: '0', ...(asBuilt ? { suppressed: true } : {}) }] });
    openDialog({ kind: 'joint', id, mark: m, isNew: true, picking: 'b', ...(asBuilt ? { asBuilt: true } : {}) });
  };
  /** An as-built joint: one origin picked, the other side's frame put where it is now, so nothing moves. */
  const startAsBuilt = () => startJoint(true);

  // ------------------------------------------------------------ motion

  /** The values of a joint as placed (solved DOFs as found). */
  const placedValues = (jid: string) => build?.kin?.values[jid] ?? dr?.kin?.values[jid];
  const kinJoint = (jid: string) => (build?.kin ?? dr?.kin)?.model.joints.find((q) => q.id === jid);
  /** Drive a DOF by hand, from where it is now. */
  const startDrive = (jid?: string, dof?: DofKey) => {
    const d = cur();
    const j = d.joints.find((q) => q.id === jid) ?? d.joints.find((q) => drivenDofs(d, q).length);
    const k = dof ?? (j && drivenDofs(d, j)[0]);
    if (!j || !k) return setMsg('Drive moves a joint by hand: make a revolute, slider or other moving joint first');
    if (!drivenDofs(d, j).includes(k)) return setMsg(`${j.name}: the ${dofLabel(j.type, k)} follows a motion link — drive the DOF it follows`);
    if (!kinJoint(j.id)) return setMsg(dr?.errors[j.id] ? `${j.name}: ${dr.errors[j.id]}` : 'The joint is not placed yet');
    openDialog({ kind: 'drive', joint: j.id, dof: k, value: placedValues(j.id)?.[k] ?? 0 });
  };
  const startLink = () => {
    const d = cur();
    const moving = d.joints.filter((j) => JOINT_DOFS[j.type].length);
    if (moving.length < 2) return setMsg('A motion link makes one joint follow another (gears, rack and pinion): make two moving joints first');
    const a = moving.find((j) => sel === `joint:${j.id}`) ?? moving[0], b = moving.find((j) => j.id !== a.id)!;
    const id = cadId('l');
    seal();
    const m = mark();
    setDesign({ ...d, links: [...(d.links ?? []), { id, name: nextName(d, 'Link'), a: { joint: a.id, dof: JOINT_DOFS[a.type][0] }, b: { joint: b.id, dof: JOINT_DOFS[b.type][0] }, ratio: '-1' }] });
    openDialog({ kind: 'link', id, mark: m, isNew: true });
  };
  /** Lock occurrences together where they are now. */
  const makeGroup = (occs: string[]) => {
    const d = cur();
    const at = (id: string) => build?.placements[id]?.matrix ?? dr?.placements[id]?.matrix;
    const first = at(occs[0]);
    if (occs.length < 2 || !first) return setMsg('Tick two occurrences or more to lock together');
    const rel = Object.fromEntries(occs.slice(1).flatMap((o) => {
      const M = at(o);
      return M ? [[o, m4Mul(m4Inv(first), M).map((v) => +v.toPrecision(15))]] : [];
    }));
    setDesign({ ...d, groups: [...(d.groups ?? []), { id: cadId('g'), name: nextName(d, 'Group'), occs, rel }] });
    setDialog(null);
  };
  const startMotion = () => {
    const d = cur();
    const j = d.joints.find((q) => JOINT_DOFS[q.type].some((k) => !q.dofs?.[k]?.free));
    if (!j) return setMsg('A motion study moves a joint over time: make a revolute, slider or other moving joint first');
    const k = JOINT_DOFS[j.type].find((x) => !j.dofs?.[x]?.free)!;
    const id = cadId('m');
    seal();
    const m = mark();
    const to = isAngleDof(k) ? '360 deg' : `${+(sceneSize / 2).toPrecision(2)} ${u}`;
    setDesign({ ...d, motions: [...(d.motions ?? []), { id, name: nextName(d, 'Motion'), duration: 4, steps: 72, tracks: [{ joint: j.id, dof: k, keys: [{ t: 0, v: isAngleDof(k) ? '0 deg' : `0 ${u}` }, { t: 4, v: to }] }] }] });
    openDialog({ kind: 'motion', id, mark: m, isNew: true });
  };
  const patchLink = (id: string, patch: Partial<NonNullable<CadDesign['links']>[number]>, coalesce?: string) =>
    setDesign({ ...cur(), links: (cur().links ?? []).map((l) => (l.id === id ? { ...l, ...patch } : l)) }, coalesce);
  const patchGroup = (id: string, patch: Partial<NonNullable<CadDesign['groups']>[number]>) =>
    setDesign({ ...cur(), groups: (cur().groups ?? []).map((g) => (g.id === id ? { ...g, ...patch } : g)) });
  const patchMotion = (id: string, patch: Partial<NonNullable<CadDesign['motions']>[number]>, coalesce?: string) =>
    setDesign({ ...cur(), motions: (cur().motions ?? []).map((m) => (m.id === id ? { ...m, ...patch } : m)) }, coalesce);
  const runAutoExplode = () => {
    const kin = build?.kin ?? dr?.kin;
    if (!build || !kin) return setMsg('The assembly is still being built');
    const offsets = autoExplode(cur(), build, kin);
    if (!Object.keys(offsets).length) return setMsg('Auto explode moves what joints place: no occurrence is placed by a joint');
    setDesign({ ...cur(), occurrences: cur().occurrences.map((o) => (offsets[o.id] ? { ...o, explode: offsets[o.id] } : o)) });
    setExplode(1);
  };

  useEffect(() => {
    if (dialog) setShowProps(true);
  }, [dialog]);
  /** The timeline a feature's dialog rolled back rolls forward again, and the edit with it is one undo step. */
  const finishRollback = () => {
    if (dialog?.kind !== 'feature' || !dialog.rollback) return;
    patchComp(dialog.cid, { marker: dialog.rollback.marker });
    squash(dialog.mark);
  };
  /** Another dialog (or window) taking over keeps the edits of the open one, as OK does. */
  const openDialog = (d: Dlg) => {
    finishRollback();
    setDialog(d);
  };
  const closeDialog = (ok: boolean) => {
    if (!dialog) return;
    if (!ok && (dialog.kind === 'feature' || dialog.kind === 'joint' || dialog.kind === 'link' || dialog.kind === 'motion')) revertTo(dialog.mark);
    if (ok) finishRollback();
    seal();
    setDialog(null);
  };

  // ------------------------------------------------------------ picking

  const occOf = (id: string) => design.occurrences.find((o) => o.id === id);
  // as shown: driven, played or exploded
  const placement = (occId: string) => av.shown?.placements[occId]?.matrix ?? build?.placements[occId]?.matrix ?? dr?.placements[occId]?.matrix;
  const sceneSize = dr?.box ? Math.max(...[0, 1, 2].map((i) => dr.box!.max[i] - dr.box!.min[i]), 20) : 100;
  const motionStudy = dialog?.kind === 'motion' ? design.motions?.find((m) => m.id === dialog.id) : undefined;
  const player = useMotionPlayer(motionStudy?.duration ?? 1, !!motionStudy);
  const linkOpen = dialog?.kind === 'link' ? design.links?.find((l) => l.id === dialog.id) : sel?.startsWith('link:') ? design.links?.find((l) => l.id === sel.slice(5)) : undefined;
  const glyphs = dialog?.kind === 'joint' ? [dialog.id] : dialog?.kind === 'drive' ? [dialog.joint] : linkOpen ? [linkOpen.a.joint, linkOpen.b.joint] : sel?.startsWith('joint:') ? [sel.slice(6)] : [];
  const av = useAssemblyView({ design, build, dr, size: sceneSize, drive: dialog?.kind === 'drive' ? dialog : null, motion: motionStudy ? { study: motionStudy, t: player.t } : null, explode, trails, glyphs });
  const occLabel = (o: CadOccurrence) => {
    const c = design.components.find((q) => q.id === o.component);
    return o.name || `${c?.name ?? '?'}:${design.occurrences.filter((q) => q.component === o.component).indexOf(o) + 1}`;
  };
  /** The body a hit is on, and the face and edge it found. */
  const hitBody = (hit: PickHit): { occ: string; body: string; b: BodyResult } | null => {
    if (!build || !hit.key?.startsWith('b:')) return null;
    const { occ, body } = parseBody(hit.key);
    const b = bodyOf(build, design, occ, body);
    return b ? { occ, body, b } : null;
  };

  /**
   * The joint origins a hit offers (component coordinates): the snap points of the face or
   * edge under the pointer and the sketch points on it, the nearest one first chosen; on a
   * face without any, the spot itself.
   */
  const jointPicks = (hit: PickHit): { occ: string; cands: JointCandidate[]; best: number } | null => {
    const on = hitBody(hit), M = on && placement(on.occ);
    if (!on || !M || !hit.point || (hit.face === undefined && hit.edge === undefined)) return null;
    const p = m4Point(m4Inv(M), hit.point);
    const cid = occOf(on.occ)!.component;
    const cands = jointCandidates(design, dr, cid, on.b, { face: hit.edge === undefined ? hit.face : undefined, edge: hit.edge }, (v) => `${num(v)} ${u}`);
    if (!cands.length && hit.normal) {
      const z = norm3(m4Dir(m4Inv(M), hit.normal));
      cands.push({ origin: { kind: 'frame', o: p, z }, o: p, z, label: 'spot on the face' });
    }
    return { occ: on.occ, cands, best: nearestCandidate(cands, p) };
  };
  const [snapHover, setSnapHover] = useState<{ occ: string; cands: JointCandidate[]; best: number; id: string } | null>(null);
  const jointPicking = dialog?.kind === 'joint' && !!dialog.picking;
  useEffect(() => {
    if (!jointPicking) setSnapHover(null);
  }, [jointPicking]);

  /** What a click measures: a corner of the body when one is close, else the edge or face hit. */
  const measured = (hit: PickHit): Measured | null => {
    const on = hitBody(hit);
    if (!on || !hit.point) return hit.point ? { ref: { kind: 'point', p: hit.point }, label: 'Point' } : null;
    const M = placement(on.occ);
    if (!M) return null;
    let corner: { p: Vec3; d: number } | null = null;
    for (const e of on.b.edges) {
      const q = e.points, n = q.length / 3;
      if (!n) continue;
      for (const k of [0, n - 1]) {
        const w = m4Point(M, [q[3 * k], q[3 * k + 1], q[3 * k + 2]]);
        const d = Math.hypot(...sub3(w, hit.point));
        if (d < sceneSize * 0.02 && (!corner || d < corner.d)) corner = { p: w, d };
      }
    }
    if (corner) return { ref: { kind: 'point', p: corner.p }, label: 'Corner' };
    const kind = hit.edge !== undefined ? 'edge' : 'face';
    const index = hit.edge ?? hit.face;
    const pk = index !== undefined && build ? pickOf(build, design, kind, on.occ, on.body, index) : null;
    if (!pk) return { ref: { kind: 'point', p: hit.point }, label: 'Point' };
    return { ref: { kind, occ: on.occ, body: on.body, index: pk.index }, label: `${pickLabel(pk)} of ${on.b.name}` };
  };

  const measureNow = (picks: Measured[]) => {
    if (picks.length !== 2 || !dr) return;
    kernelRequest({ op: 'distance', design: cur(), numbers: designNumbers(dr), a: picks[0].ref, b: picks[1].ref }, 'measure').then(
      (result) => setDialog((d) => (d?.kind === 'measure' && d.picks === picks ? { ...d, result } : d)),
      (e) => !isSuperseded(e) && setDialog((d) => (d?.kind === 'measure' && d.picks === picks ? { ...d, error: (e as Error).message } : d)),
    );
  };

  /**
   * A click while a modify feature's dialog is open: the plane or axis its field waits for,
   * or an edge, face or body taken in or out of what it works on. A rounding (or chamfer) the
   * feature made stands for the edge it was made from, so clicking it takes that edge out.
   */
  const pickForModify = (c: CadComponent, f: ModifyFeature, hit: PickHit) => {
    if (dialog?.kind !== 'feature') return;
    const on = hitBody(hit);
    if (on && occOf(on.occ)?.component !== c.id) return setMsg('That body belongs to another component');
    const patch = (p: Partial<ModifyFeature>) => patchItem(c.id, f.id, p as Partial<DesignItem>);
    const face = on && hit.face !== undefined && hit.edge === undefined ? on.b.faces[hit.face] : undefined;
    const edge = on && hit.edge !== undefined ? on.b.edges[hit.edge] : undefined;
    // what this feature made itself cannot be what it works on
    const madeHere = (key: string) => baseName(key).split('+').some((k) => keyFeature(k) === f.id);
    const edgeFaces = (e: NonNullable<typeof edge>) => e.faces.map((i) => on!.b.faces[i]?.key ?? '');
    if (dialog.target) {
      if (!on) return;
      if ((face && madeHere(face.key)) || (edge && edgeFaces(edge).some(madeHere))) return setMsg(`${f.name} made that itself: pick something it starts from`);
      if (dialog.target === 'plane') {
        if (!face?.frame) return setMsg('Pick a flat face for the plane');
        patch({ plane: refTo('face', on.body, face) });
      } else {
        const ok = edge ? !!(edge.line || edge.circle) : !!face && (!!face.frame || (!!face.axis && face.type !== 'sphere'));
        if (!ok) return setMsg('Pick a straight edge, a circle, a cylinder or a flat face for the axis');
        const ref = edge ? refTo('edge', on.body, edge) : refTo('face', on.body, face!);
        patch(f.kind === 'draft' ? { pull: ref } : { axis: ref });
      }
      setDialog({ ...dialog, target: undefined });
      return;
    }
    if (f.kind === 'split') return on && patch({ body: on.body });
    if (f.kind === 'move') return on && patch({ bodies: f.bodies.includes(on.body) ? f.bodies.filter((x) => x !== on.body) : [...f.bodies, on.body] });
    if (!on) return;
    // the references this feature holds, found on the bodies as shown (index per body)
    const shown = build?.components[c.id]?.bodies ?? [];
    const at = (ref: TopoRef) => {
      const r = resolveRef(ref, shown);
      return r.ok && r.body === on.body ? r.index : -1;
    };
    if (f.kind === 'fillet' || f.kind === 'chamfer') {
      const role = `${f.id}/${f.kind === 'fillet' ? 'round' : 'chamfer'}:`;
      const token = (key: string) => baseName(key).split('+').find((k) => k.startsWith(role))?.slice(role.length);
      const made = (face ? [face.key] : edge ? edgeFaces(edge) : []).map(token).filter((x): x is string => !!x);
      const lists = f.kind === 'fillet' ? f.sets.map((st) => st.edges) : [f.edges];
      const write = (next: TopoRef[][]) => patch(f.kind === 'fillet' ? { sets: f.sets.map((st, i) => ({ ...st, edges: next[i] })) } : { edges: next[0] });
      if (made.length) return write(lists.map((l) => l.filter((r) => !made.includes(refToken(r)))));
      // an edge, or every edge of a face (not its seams)
      const want = edge ? [edge] : on.b.edges.filter((e) => face && e.faces.includes(face.index) && e.faces[0] !== e.faces[1]);
      if (want.some((e) => edgeFaces(e).some(madeHere))) return setMsg(`${f.name} made that edge: click its rounding to take the edge out`);
      const held = new Set(lists.flat().map(at));
      if (want.every((e) => held.has(e.index))) return write(lists.map((l) => l.filter((r) => !want.some((e) => e.index === at(r)))));
      const add = want.filter((e) => !held.has(e.index)).map((e) => refTo('edge', on.body, e));
      const into = f.kind === 'fillet' ? Math.min(dialog.set ?? 0, f.sets.length - 1) : 0;
      return write(lists.map((l, i) => (i === into ? [...l, ...add] : l)));
    }
    if (!face) return;
    if (madeHere(face.key)) return setMsg(`${f.name} made that face: pick one of the faces it starts from`);
    const i = f.faces.findIndex((r) => at(r) === face.index);
    const faces = i >= 0 ? f.faces.filter((_, k) => k !== i) : [...f.faces, refTo('face', on.body, face)];
    // a shell with no face left open hollows out the body it was on
    patch({ faces, ...(f.kind === 'shell' ? { body: faces.length ? undefined : on.body } : {}) } as Partial<ModifyFeature>);
  };

  /**
   * What a click gives a field of a sweep, coil, thread or construction dialog: an origin or
   * construction plane, or a reference to the face, edge or vertex (the corner of the edge
   * or face nearest to where it was clicked). An error says what the field wants instead.
   */
  const pickValue = (kind: FieldPick['kind'], hit: PickHit, self: string): { value: string | TopoRef } | { error: string } => {
    const key = hit.key ?? '';
    const on = hitBody(hit);
    const face = on && hit.face !== undefined && hit.edge === undefined ? on.b.faces[hit.face] : undefined;
    const edge = on && hit.edge !== undefined ? on.b.edges[hit.edge] : undefined;
    const M = on && placement(on.occ);
    const at = M && hit.point ? m4Point(m4Inv(M), hit.point) : null;
    /** The vertex of an edge or face nearest to the click. */
    const corner = () => {
      if (!on || !at) return null;
      const vs = edge ? edge.v : face ? on.b.edges.filter((e) => e.faces.includes(face.index)).flatMap((e) => e.v) : [];
      const best = vs.map((i) => on.b.vertices[i]).filter(Boolean).sort((a, b) => Math.hypot(...sub3(a.p, at)) - Math.hypot(...sub3(b.p, at)))[0];
      return best ? refTo('vertex', on.body, best) : null;
    };
    switch (kind) {
      case 'plane':
        if (key.startsWith('cp:')) return key.slice(3) === self ? { error: 'Pick another plane' } : { value: key.slice(3) };
        if (key.startsWith('pl:')) return { value: key.slice(3) };
        return face?.frame ? { value: refTo('face', on!.body, face) } : { error: 'Pick a flat face, an origin plane or a construction plane' };
      case 'axis':
        if (edge && (edge.line || edge.circle)) return { value: refTo('edge', on!.body, edge) };
        return face && (face.type === 'cylinder' || face.type === 'cone' || face.type === 'torus') ? { value: refTo('face', on!.body, face) } : { error: 'Pick a straight edge, a circle or a cylinder' };
      case 'point':
      case 'vertex': {
        if (kind === 'point' && edge?.circle) return { value: refTo('edge', on!.body, edge) };
        if (kind === 'point' && face?.type === 'sphere') return { value: refTo('face', on!.body, face) };
        const v = corner();
        return v ? { value: v } : { error: 'Pick near a corner (or a circle for its centre)' };
      }
      case 'curve':
        return edge ? { value: refTo('edge', on!.body, edge) } : { error: 'Pick an edge' };
      case 'centre':
        if (edge?.circle) return { value: refTo('edge', on!.body, edge) };
        return face?.type === 'sphere' ? { value: refTo('face', on!.body, face) } : { error: 'Pick a circle, an arc or a sphere' };
      case 'cylinder':
        // an axis goes through a cone or torus too; a tangent plane says it needs a cylinder
        return face && (face.type === 'cylinder' || face.type === 'cone' || face.type === 'torus') ? { value: refTo('face', on!.body, face) } : { error: 'Pick a cylindrical face' };
      case 'face':
        return face ? { value: refTo('face', on!.body, face) } : { error: 'Pick a face' };
    }
  };

  /**
   * A click while a sweep, coil, thread or construction dialog is open: the field waiting for
   * one, else a thread's faces or a sweep's path edges in or out, or a sweep's profile.
   */
  const pickForBuild = (c: CadComponent, f: Extract<DesignFeature, { kind: 'sweep' | 'coil' | 'thread' | 'plane' | 'axis' | 'point' }>, hit: PickHit) => {
    if (dialog?.kind !== 'feature') return;
    const key = hit.key ?? '';
    const on = hitBody(hit);
    if (on && occOf(on.occ)?.component !== c.id) return setMsg('That body belongs to another component');
    const madeHere = (k: string) => baseName(k).split('+').some((x) => keyFeature(x) === f.id);
    const pk = dialog.pick;
    if (pk) {
      const face = on && hit.face !== undefined ? on.b.faces[hit.face] : undefined;
      if (face && madeHere(face.key)) return setMsg(`${f.name} made that itself: pick something it starts from`);
      const r = pickValue(pk.kind, hit, f.id);
      if ('error' in r) return setMsg(r.error);
      patchItem(c.id, f.id, withPick(f, pk.field, r.value));
      // a plane through points takes three clicks
      const more = pk.field === 'points' && f.kind === 'plane' && f.def.type === 'points' && f.def.points.length < 2;
      setDialog({ ...dialog, pick: more ? pk : undefined });
      return;
    }
    if (f.kind === 'sweep' && key.startsWith('p:')) {
      const p = parseProfile(key);
      return patchItem(c.id, f.id, { sketch: p.sketch, profile: p.key } as Partial<DesignItem>);
    }
    if (!on) return;
    const shownBodies = build?.components[c.id]?.bodies ?? [];
    const at = (ref: TopoRef) => {
      const r = resolveRef(ref, shownBodies);
      return r.ok && r.body === on.body ? r.index : -1;
    };
    if (f.kind === 'thread' && hit.face !== undefined) {
      const face = on.b.faces[hit.face];
      if (face.type !== 'cylinder') return setMsg('A thread goes on a cylindrical face');
      if (madeHere(face.key)) return setMsg(`${f.name} made that face: pick the cylinder it threads`);
      const i = f.faces.findIndex((r) => at(r) === face.index);
      return patchItem(c.id, f.id, { faces: i >= 0 ? f.faces.filter((_, k) => k !== i) : [...f.faces, refTo('face', on.body, face)] } as Partial<DesignItem>);
    }
    if (f.kind === 'sweep' && f.path.kind === 'edges' && hit.edge !== undefined) {
      const edge = on.b.edges[hit.edge];
      const i = f.path.edges.findIndex((r) => at(r) === edge.index);
      const edges = i >= 0 ? f.path.edges.filter((_, k) => k !== i) : [...f.path.edges, refTo('edge', on.body, edge)];
      return patchItem(c.id, f.id, { path: { kind: 'edges', edges } } as Partial<DesignItem>);
    }
    // a sweep or coil that joins, cuts or intersects: a body clicked goes into its targets or out
    if ((f.kind === 'sweep' || f.kind === 'coil') && f.op !== 'new' && !(f.kind === 'coil' && f.pathOnly)) {
      const l = f.targets ?? [];
      const next = l.includes(on.body) ? l.filter((x) => x !== on.body) : [...l, on.body];
      return patchItem(c.id, f.id, { targets: next.length ? next : undefined } as Partial<DesignItem>);
    }
  };

  const onPick = (hit: PickHit, shift = false) => {
    if (performance.now() - openedAt.current < 500) return;
    if (projecting) return projectPick(hit);
    const key = hit.key ?? '';
    if (dialog?.kind === 'feature') {
      const c = design.components.find((q) => q.id === dialog.cid);
      const f = c?.items.find((i) => i.id === dialog.id) as DesignFeature | undefined;
      if (!c || !f) return;
      if (isModify(f)) return pickForModify(c, f, hit);
      if (isBuildFeature(f)) return pickForBuild(c, f, hit);
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
        if (f.kind === 'extrude' || f.kind === 'revolve' || f.kind === 'hole' || f.kind === 'rib') {
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
      if (key.startsWith('cp:')) return sketchOnDatum(key.slice(3), dialog.offset);
      const on = hitBody(hit);
      if (on) {
        // the face's exact plane (component coordinates), and a reference the sketch follows
        const face = hit.face !== undefined ? on.b.faces[hit.face] : undefined;
        if (!face?.frame) return setMsg('Pick a flat face (or an origin plane) to sketch on');
        const label = face.key ? faceWords(face.key, (id) => itemName(cur(), id)).replace(/^the /, '') : `face of ${on.b.name}`;
        const offset = dialog.offset.trim() && dialog.offset.trim() !== '0' ? { offset: dialog.offset.trim() } : {};
        return newSketchOn({ ...facePlane(on.b, face, label), ...offset }, occOf(on.occ)!.component);
      }
      return;
    }
    if (dialog?.kind === 'joint') {
      if (!dialog.picking || !key.startsWith('b:')) return;
      const j = design.joints.find((q) => q.id === dialog.id);
      const picked = jointPicks(hit);
      const c = picked?.cands[picked.best];
      if (!j || !picked || !c) return;
      const { occ } = picked;
      const other = dialog.picking === 'a' ? j.b.occ : j.a.occ;
      const origin: JointOrigin = c.origin;
      if (dialog.asBuilt) {
        // the other side's origin put where the picked one is now: the joint holds the parts as they stand
        const side = dialog.picking, far = side === 'a' ? 'b' : 'a';
        const farOcc = occ === other ? j[side].occ : other;
        // where the parts stand without this joint (not where its present origins put them)
        const kin = build?.kin ?? dr?.kin;
        const now = kin && placementsWithout(kin.model, j.id);
        const placed = (id: string) => now?.[id]?.matrix ?? build?.placements[id]?.matrix ?? dr?.placements[id]?.matrix;
        const Mp = placed(occ), Mf = placed(farOcc), cid = occOf(occ)?.component;
        if (farOcc === occ || !Mp || !Mf || !cid || !dr) return setMsg('Pick a part of one of the two occurrences the joint holds');
        const at = asBuiltOrigin(Mf, Mp, jointFrame(designNumbers(dr), origin, build?.components[cid]?.bodies, dr.frames, undefined, build?.components[cid]?.datums));
        patchJoint(j.id, { [side]: { occ, origin }, [far]: { occ: farOcc, origin: at }, angle: '0', offset: '0', x: undefined, y: undefined, angle2: undefined, angle3: undefined, flip: undefined, suppressed: undefined } as Partial<CadJoint>);
        setSnapHover(null);
        setDialog({ ...dialog, picking: null, snap: `As built on the ${c.label}: the parts stay where they are` });
        return;
      }
      // picking the part the other side already uses swaps the sides
      const patch: Partial<CadJoint> = occ === other
        ? { [dialog.picking]: { occ, origin }, [dialog.picking === 'a' ? 'b' : 'a']: dialog.picking === 'a' ? { ...j.a } : { ...j.b }, flip: true }
        : { [dialog.picking]: { occ, origin }, flip: true };
      patchJoint(j.id, patch);
      setSnapHover(null);
      setDialog({ ...dialog, picking: dialog.picking === 'b' ? 'a' : null, snap: origin.kind === 'frame' ? 'On the face (it has no snap points)' : `Snapped to the ${c.label}` });
      return;
    }
    if (dialog?.kind === 'measure') {
      const m = measured(hit);
      if (!m) return;
      const next = dialog.picks.length >= 2 ? [m] : [...dialog.picks, m];
      setDialog({ kind: 'measure', picks: next });
      measureNow(next);
      return;
    }
    const on = hitBody(hit);
    if (on && build && (hit.edge !== undefined || hit.face !== undefined)) {
      const pk = pickOf(build, design, hit.edge !== undefined ? 'edge' : 'face', on.occ, on.body, hit.edge ?? hit.face!);
      setPicks((cur) => select(cur, pk, shift));
      setSel(null);
      return;
    }
    if (!shift) setPicks([]);
    if (key.startsWith('b:')) setSel(`body:${key.slice(2)}`);
    else if (key.startsWith('p:')) setSel(key);
    else if (!shift) setSel(null);
  };
  // picks follow their faces and edges through a rebuild
  useEffect(() => {
    if (build) setPicks((cur) => (cur.length ? resolveSelection(cur, build, designRef.current) : cur));
  }, [build]);

  // ------------------------------------------------------------ inspect

  const runInterference = () => {
    if (!dr) return setMsg('The part is still being evaluated');
    openDialog({ kind: 'interference', rows: null });
    kernelRequest({ op: 'interference', design: cur(), numbers: designNumbers(dr) }, 'interference').then(
      (rows) => setDialog((d) => (d?.kind === 'interference' ? { kind: 'interference', rows } : d)),
      (e) => !isSuperseded(e) && setDialog((d) => (d?.kind === 'interference' ? { kind: 'interference', rows: [], error: (e as Error).message } : d)),
    );
  };

  // ------------------------------------------------------------ files

  const fileBase = (region.name.trim() || 'part').replace(/[^\w.-]+/g, '_');
  const exportAs = async (format: PartFormat) => {
    setBusy(`Writing ${format.toUpperCase()}…`);
    try {
      await exportPart(region, result, format);
    } catch (e) {
      setMsg(`Export failed: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  };
  const importDxf = async () => {
    if (!ds) return;
    const file = await pickFile('.dxf');
    if (!file) return;
    try {
      const { dxfToSketch } = await import('../../cad/dxf');
      const { sketch, warnings } = dxfToSketch(await file.text());
      const sk = ds.sketch;
      replaceSketch(ds.id, { sketch: { ...sk, points: [...sk.points, ...sketch.points], entities: [...sk.entities, ...sketch.entities], constraints: [...sk.constraints, ...sketch.constraints] }, view: undefined });
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
  // ------------------------------------------------------------ project, include, intersect

  /** Picking edges and faces to project: the 3-D view, the timeline rolled back to the sketch (it can only see the bodies before it). */
  const [projecting, setProjecting] = useState<{ cid: string; sketch: string; marker: number | undefined } | null>(null);
  const startProject = () => {
    if (!ds || !sketchComp) return;
    const idx = sketchComp.items.indexOf(ds);
    if ((sketchComp.marker ?? sketchComp.items.length) > idx) setDesign(mapComp(cur(), sketchComp.id, (c) => ({ ...c, marker: idx })), undefined, false);
    setProjecting({ cid: sketchComp.id, sketch: ds.id, marker: sketchComp.marker });
  };
  const endProject = () => {
    if (!projecting) return;
    const back = projecting.marker;
    setDesign(mapComp(cur(), projecting.cid, (c) => ({ ...c, marker: back })), undefined, false);
    setProjecting(null);
    window.setTimeout(() => canvas.current?.focus(), 60);
  };
  // leaving the sketch (Finish, another sketch) ends picking and rolls the timeline forward again;
  // so does closing the window, else the part would stay rolled back
  useEffect(() => {
    if (projecting && ds?.id !== projecting.sketch) endProject();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projecting, ds]);
  const projectingRef = useRef(projecting);
  projectingRef.current = projecting;
  const setDesignRef = useRef(setDesign);
  setDesignRef.current = setDesign;
  useEffect(() => {
    const rollForward = () => {
      const p = projectingRef.current;
      if (p) setDesignRef.current(mapComp(designRef.current, p.cid, (c) => ({ ...c, marker: p.marker })), undefined, false);
      projectingRef.current = null;
    };
    // a separate CAD window is unloaded, not unmounted
    window.addEventListener('pagehide', rollForward);
    window.addEventListener('beforeunload', rollForward);
    return () => {
      window.removeEventListener('pagehide', rollForward);
      window.removeEventListener('beforeunload', rollForward);
      rollForward();
    };
  }, []);
  const addSource = (src: SketchSource, what: string) => {
    if (!ds) return;
    const now = findSketch(cur(), ds.id)!.sketch;
    replaceSketch(ds.id, { sketch: { ...now, sources: [...(now.sources ?? []), src] } });
    setMsg(`${what}: it comes in as fixed reference geometry and follows the model`);
  };
  const nameOf = (id: string) => itemName(cur(), id);
  const projectPick = (hit: PickHit) => {
    const on = hitBody(hit);
    if (!on || occOf(on.occ)?.component !== projecting?.cid) return setMsg('Pick an edge or a face of a body of this component');
    if (hit.edge !== undefined) {
      const e = on.b.edges[hit.edge];
      return addSource({ id: cadId('r'), kind: 'edge', ref: refTo('edge', on.b.id, e), label: e.key ? edgeWords(e.key, nameOf).replace(/^the /, '') : 'edge' }, 'Projected the edge');
    }
    if (hit.face !== undefined) {
      const f = on.b.faces[hit.face];
      return addSource({ id: cadId('r'), kind: 'face', ref: refTo('face', on.b.id, f), label: `outline of ${f.key ? faceWords(f.key, nameOf).replace(/^the /, '') : 'a face'}` }, 'Projected the face\'s outline');
    }
  };
  const intersect = () => addSource({ id: cadId('r'), kind: 'section', label: 'section of the bodies' }, 'The bodies\' section with the sketch plane');
  /** Construction points and axes before the sketch, to include. */
  const datumsBefore = ds && sketchComp ? sketchComp.items.slice(0, sketchComp.items.indexOf(ds)).filter((i): i is ConstructItem => i.kind === 'point' || i.kind === 'axis') : [];
  // what a build projected goes into the stored sketch (no undo step: it is the model's doing)
  useEffect(() => {
    for (const [id, built] of Object.entries(dr?.rebuilt ?? {})) {
      const now = findSketch(designRef.current, id);
      if (!now) continue;
      const merged = withReferencesOf(now.sketch, built);
      if (merged !== now.sketch) replaceSketch(id, { sketch: merged }, undefined, false);
    }
  }, [dr?.rebuilt, replaceSketch]);

  // ------------------------------------------------------------ keyboard

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    // a slider or a check box takes no typing: Esc still leaves the dialog (a drive's slider)
    const typing = tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && !['range', 'checkbox'].includes((e.target as HTMLInputElement).type));
    if (typing || (tag === 'INPUT' && e.key !== 'Escape')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) onRedo(); else onUndo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); onRedo(); }
    else if (e.key === 'Escape' && projecting) endProject();
    else if (e.key === 'Escape' && dialog?.kind === 'feature' && dialog.target) setDialog({ ...dialog, target: undefined });
    else if (e.key === 'Escape' && dialog?.kind === 'feature' && dialog.pick) setDialog({ ...dialog, pick: undefined });
    else if (e.key === 'Escape' && dialog) closeDialog(false);
    else if (e.key === 'Escape' && !sketchId && picks.length) setPicks([]);
    else if (!sketchId && !dialog && !mod && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'e') startFeature('extrude');
      else if (k === 'h') startFeature('hole');
      else if (k === 'f') startFeature('fillet');
      else if (k === 'q') startFeature('presspull');
      else if (k === 'j') startJoint();
      else if (k === 'm') setDialog({ kind: 'measure', picks: [] });
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
    if (sel?.startsWith('item:')) h.add(`s:${sel.slice(5)}`).add(sel);
    const f = activeFeature;
    const occ = f && dialog?.kind === 'feature' ? editOccurrence(design, dialog.cid) : undefined;
    if (f && occ) {
      if (f.kind === 'extrude' || f.kind === 'revolve') {
        const s = findSketch(design, f.sketch);
        const keys = f.profiles?.length ? f.profiles : s ? sketchRegions(s, result).map(profileKey) : [];
        for (const k of keys) h.add(`p:${f.sketch}:${k}`);
      }
      const bodies = 'targets' in f ? f.targets : (f.kind === 'pattern' || f.kind === 'mirror') && f.of === 'bodies' ? f.refs : f.kind === 'combine' ? [f.target, ...f.tools]
        : f.kind === 'split' ? [f.body] : f.kind === 'move' ? f.bodies : f.kind === 'shell' && !f.faces.length && f.body ? [f.body] : undefined;
      for (const b of bodies ?? []) h.add(`b:${occ.id}:${b}`);
    }
    if (activeJoint) {
      h.add(`o:${activeJoint.a.occ}`);
      h.add(`o:${activeJoint.b.occ}`);
    }
    return h;
  }, [hover, sel, dialog, activeFeature, activeJoint, design, result]);

  const pickProfiles = !dialog || activeFeature?.kind === 'extrude' || activeFeature?.kind === 'revolve' || activeFeature?.kind === 'sweep';
  const box = dr?.box;
  const secNormal: Record<'XY' | 'XZ' | 'YZ', Vec3> = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };
  const secAxis = section ? { XY: 2, XZ: 1, YZ: 0 }[section.plane] : 0;
  const secRange: [number, number] = box ? [box.min[secAxis], box.max[secAxis]] : [-50, 50];
  const sectionOpt = useMemo(() => {
    if (!section) return undefined;
    const n0 = secNormal[section.plane];
    const at = secRange[0] + (secRange[1] - secRange[0]) * section.at;
    // keep the far side: the half towards +n, or towards −n when flipped
    return section.flip ? { n: [-n0[0], -n0[1], -n0[2]] as Vec3, offset: -at } : { n: n0, offset: at };
  }, [section, secRange[0], secRange[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  // the section view comes from the kernel; while the plane is dragged only the newest
  // request waits, and an answer shows unless a newer one already did
  const [cut, setCut] = useState<SectionBody[] | null>(null);
  const cutSeq = useRef({ asked: 0, shown: 0 });
  useEffect(() => {
    if (!sectionOpt || !dr) return setCut(null);
    const n = ++cutSeq.current.asked;
    kernelRequest({ op: 'section', design: designRef.current, numbers: designNumbers(dr), plane: sectionOpt }, 'section').then(
      (bodies) => {
        if (n < cutSeq.current.shown || !cutSeq.current.asked) return;
        cutSeq.current.shown = n;
        setCut(bodies);
      },
      (e) => !isSuperseded(e) && setMsg(`The section failed: ${(e as Error).message}`),
    );
  }, [sectionOpt, dr?.display]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!section) cutSeq.current = { asked: 0, shown: 0 };
  }, [section]);

  /** Faces and edges to mark on each body: the selection (or what is being measured) and what is under the pointer. */
  const measurePicks = dialog?.kind === 'measure' ? dialog.picks : null;
  const marked = useMemo(() => (measurePicks ? measurePicks.flatMap((m) => (m.ref.kind === 'point' ? [] : [m.ref])) : picks), [measurePicks, picks]);
  // what a modify feature works on, as shown: the faces and edges it holds (found by their
  // references), its plane or axis if picked, and the roundings or chamfers it made
  const modified = activeFeature && isModify(activeFeature) ? activeFeature : null;
  // a sweep, coil, thread or construction item: what it holds is marked the same way
  const held = activeFeature && isBuildFeature(activeFeature) ? activeFeature : null;
  const modMarks = useMemo(() => {
    const out = new Map<string, { faces: number[]; edges: number[] }>();
    const occ = (modified || held) && dialog?.kind === 'feature' ? editOccurrence(design, dialog.cid) : undefined;
    const shown = (occ && build?.components[occ.component]?.bodies) || [];
    if (!occ) return out;
    const mark = (body: string, kind: 'face' | 'edge', i: number) => {
      const m = out.get(`b:${occ.id}:${body}`) ?? { faces: [], edges: [] };
      (kind === 'face' ? m.faces : m.edges).push(i);
      out.set(`b:${occ.id}:${body}`, m);
    };
    if (held) {
      for (const ref of refsIn(held)) {
        const r = resolveRef(ref, shown);
        if (r.ok && ref.kind !== 'vertex') mark(r.body, ref.kind, r.index);
      }
      return out;
    }
    if (!modified) return out;
    const f = modified;
    const refs: TopoRef[] = f.kind === 'fillet' ? f.sets.flatMap((st) => st.edges) : f.kind === 'chamfer' ? f.edges : 'faces' in f ? [...f.faces] : [];
    for (const pk of [f.kind === 'draft' || f.kind === 'split' ? f.plane : undefined, f.kind === 'draft' ? f.pull : f.kind === 'move' ? f.axis : undefined]) if (pk && typeof pk !== 'string') refs.push(pk);
    for (const ref of refs) {
      const r = resolveRef(ref, shown);
      if (r.ok) mark(r.body, ref.kind === 'face' ? 'face' : 'edge', r.index);
    }
    if (f.kind === 'fillet' || f.kind === 'chamfer') {
      const role = `${f.id}/${f.kind === 'fillet' ? 'round' : 'chamfer'}:`;
      for (const b of shown) for (const face of b.faces) if (baseName(face.key).split('+').some((k) => k.startsWith(role))) mark(b.id, 'face', face.index);
    }
    return out;
  }, [modified, held, dialog, design, build]);
  const marks = useCallback((key: string) => {
    const selFaces: number[] = [...(modMarks.get(key)?.faces ?? [])], selEdges: number[] = [...(modMarks.get(key)?.edges ?? [])];
    for (const p of modified || held ? [] : marked) if (`b:${p.occ}:${p.body}` === key) (p.kind === 'face' ? selFaces : selEdges).push(p.index);
    const hv = hoverPick?.key === key ? hoverPick : null;
    if (!selFaces.length && !selEdges.length && !hv) return undefined;
    return { selFaces, selEdges, hoverFace: hv && hv.edge === undefined ? hv.face : undefined, hoverEdge: hv?.edge };
  }, [marked, hoverPick, modMarks, modified, held]);
  // origin and construction planes take clicks while a sketch or a plane field waits for one
  const planePicking = dialog?.kind === 'sketch' || (dialog?.kind === 'feature' && dialog.pick?.kind === 'plane');
  const baseScene = useMemo(() => buildScene(design, result, av.shown, {
    active: comp?.id ?? '', highlight, showPlanes: (showPlanes || planePicking) && !section, pickProfiles, isolate, size: sceneSize,
    pickPlanes: planePicking, pickDatums: planePicking, section: section ? cut : undefined, marks,
  }), [design, result, av.shown, comp, highlight, showPlanes, planePicking, pickProfiles, isolate, sceneSize, section, cut, marks]);
  // what is being measured (corner points) and the shortest line between the two, and the
  // joint origins a face or edge offers while a joint picks one, drawn on top
  const measuring = dialog?.kind === 'measure' ? dialog : null;
  const snapping = dialog?.kind === 'joint' && dialog.picking ? snapHover : null;
  const snapM = snapping ? placement(snapping.occ) : undefined;
  const scene = useMemo(() => {
    const extra = snapping && snapM ? candidateGlyphs(snapping.cands, snapping.best, snapM, sceneSize) : [];
    if (measuring?.picks.length) {
      const r = sceneSize * 0.012;
      const cross3d = (p: Vec3) => [p[0] - r, p[1], p[2], p[0] + r, p[1], p[2], p[0], p[1] - r, p[2], p[0], p[1] + r, p[2], p[0], p[1], p[2] - r, p[0], p[1], p[2] + r];
      const segs: number[] = [];
      for (const m of measuring.picks) if (m.ref.kind === 'point') segs.push(...cross3d(m.ref.p));
      const d = measuring.result;
      if (d) segs.push(...d.a, ...d.b, ...cross3d(d.a), ...cross3d(d.b));
      if (segs.length) extra.push({ key: 'measure', segments: new Float32Array(segs), color: [0.95, 0.6, 0.05] as [number, number, number], overlay: true });
    }
    // joint glyphs, explode trails, and the parts a playing study finds overlapping, in red
    extra.push(...av.lines);
    const meshes = paintHits(baseScene.meshes, av.hits, build, design);
    return extra.length || meshes !== baseScene.meshes ? { ...baseScene, meshes, lines: [...baseScene.lines, ...extra] } : baseScene;
  }, [baseScene, measuring, snapping, snapM, sceneSize, av.lines, av.hits, build, design]);
  // while a joint is driven or a study plays the view keeps its framing (a little room to move in)
  const still = useRef<{ key: string; b: Bounds } | null>(null);
  const movingKey = dialog?.kind === 'drive' ? `d:${dialog.joint}/${dialog.dof}` : motionStudy ? `m:${motionStudy.id}` : '';
  if (!movingKey) still.current = null;
  else if (still.current?.key !== movingKey) {
    const b = sceneBounds(scene.meshes, scene.lines, scene.planes);
    if (b) {
      const r = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) * 0.15;
      still.current = { key: movingKey, b: { min: [b.min[0] - r, b.min[1] - r, b.min[2] - r], max: [b.max[0] + r, b.max[1] + r, b.max[2] + r] } };
    }
  }

  // faces and edges are picked one by one, except while a feature dialog picks bodies
  // a modify dialog picks edges (fillet, chamfer, an axis), faces (shell, draft, press-pull, a plane) or bodies
  const modPick = modified && dialog?.kind === 'feature'
    ? (dialog.target === 'plane' ? 'faces' : dialog.target === 'axis' ? 'edges' : modified.kind === 'fillet' || modified.kind === 'chamfer' ? 'edges' : modified.kind === 'split' || modified.kind === 'move' ? 'bodies' : 'faces')
    : null;
  // … and a sweep, coil, thread or construction dialog the faces or edges of its fields, a thread's faces, a sweep's path edges
  const buildPick = held && dialog?.kind === 'feature'
    ? (dialog.pick ? (['plane', 'cylinder', 'face'].includes(dialog.pick.kind) ? 'faces' : 'edges') : held.kind === 'thread' ? 'faces' : held.kind === 'sweep' && held.path.kind === 'edges' ? 'edges' : null)
    : null;
  const facePicking = !dialog || dialog.kind === 'measure' || dialog.kind === 'sketch' || dialog.kind === 'joint' || modPick === 'edges' || modPick === 'faces' || !!buildPick;
  const onHover = (h: PickHit) => {
    const key = h.kind !== 'none' ? h.key : undefined;
    const onBody = !!key?.startsWith('b:') && facePicking;
    const hp = onBody && (h.face !== undefined || h.edge !== undefined) ? { key: key!, face: h.face, edge: dialog?.kind === 'sketch' ? undefined : h.edge } : null;
    setHoverPick((old) => (old?.key === hp?.key && old?.face === hp?.face && old?.edge === hp?.edge ? old : hp));
    const hk = !onBody && key && (key.startsWith('b:') || key.startsWith('p:') || key.startsWith('pl:') || key.startsWith('cp:')) ? key : null;
    setHover((old) => (old === hk ? old : hk));
    // a joint picking its origin: the snap points of what is under the pointer
    const jp = dialog?.kind === 'joint' && dialog.picking && onBody ? jointPicks(h) : null;
    const id = jp ? `${key}:${h.face}:${h.edge}:${jp.best}` : '';
    setSnapHover((old) => ((old?.id ?? '') === id ? old : jp && { ...jp, id }));
  };

  const view3d: SceneView = region.view3dW
    ? { yaw: region.view3dW.yaw, pitch: region.view3dW.pitch, zoom: region.view3dW.zoom ?? 1, pan: region.view3dW.pan ?? { x: 0, y: 0 } }
    : { ...STANDARD_VIEWS.iso, zoom: 1, pan: { x: 0, y: 0 } };
  const setView3d = (v: SceneView) => set({ view3dW: v }, false);

  // ------------------------------------------------------------ browser

  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const Node = ({ k, icon, label, badge, children, onClick, on, extra, bad, warn }: { k: string; icon: ReactNode; label: ReactNode; badge?: string; children?: ReactNode; onClick?: () => void; on?: boolean; extra?: ReactNode; bad?: boolean; warn?: string }) => (
    <li>
      <div className={`cadw-node${on ? ' on' : ''}${bad ? ' bad' : warn ? ' warn' : ''}`} title={warn}>
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
  const warnCount = Object.keys(dr?.warnings ?? {}).length;
  const kernelState = busy || (shown.state === 'loading' ? 'Loading the 3-D kernel…' : shown.state === 'rebuilding' ? 'Rebuilding…' : !result ? 'Evaluating…' : '');
  const hintText = (() => {
    if (msg) return msg;
    if (sketchId) return status.msg || status.hint;
    if (dialog?.kind === 'sketch') return 'Click an origin plane, a construction plane or a flat face to sketch on it';
    if (dialog?.kind === 'joint') {
      if (!dialog.picking) return dialog.snap ?? 'Set the joint type and motion, then OK';
      const at = snapHover?.cands[snapHover.best];
      return at ? `Click: the ${at.label} · move over faces and edges for their snap points` : `Hover a face or edge of the ${dialog.picking === 'b' ? 'part that moves' : 'part it goes onto'}: its snap points show (centres, axes, midpoints, vertices)`;
    }
    if (dialog?.kind === 'measure') return 'Click two faces, edges or corners: the smallest distance between them';
    if (dialog?.kind === 'drive') return 'Drag the slider or type a value: the joints follow · Set as value writes it into the joint · Esc leaves it as it was';
    if (dialog?.kind === 'motion') return 'Play, scrub or step through the study · keys are times and values (worksheet expressions) · red: parts overlapping';
    if (dialog?.kind === 'link') return 'b = ratio · a + offset: pick the DOF that drives and the one that follows';
    if (dialog?.kind === 'group') return 'Tick the occurrences to lock together where they are';
    if (dialog?.kind === 'feature' && modified) {
      if (dialog.target) return dialog.target === 'plane' ? 'Click a flat face for the plane · Esc stops picking' : 'Click a straight edge, a circle, a cylinder or a flat face (its normal) for the axis · Esc stops picking';
      const what: Record<ModifyFeature['kind'], string> = {
        fillet: `Click edges to round them${modified.kind === 'fillet' && modified.sets.length > 1 ? ` (set ${(dialog.set ?? 0) + 1})` : ''} · click a rounding to take its edge out · a face adds its edges`,
        chamfer: 'Click edges to chamfer them · click a chamfer to take its edge out · a face adds its edges',
        shell: 'Click the faces to open · with none, the body is hollowed out',
        draft: 'Click the faces to draft',
        presspull: 'Click flat or cylindrical faces to move them',
        split: 'Click the body to split',
        move: 'Click bodies to move them (click again to leave one out)',
      };
      return `${what[modified.kind]} · Esc cancels`;
    }
    if (dialog?.kind === 'feature' && dialog.pick) {
      const what: Record<FieldPick['kind'], string> = {
        plane: 'a flat face, an origin plane or a construction plane', axis: 'a straight edge, a circle or a cylinder', point: 'a corner (or a circle for its centre)',
        vertex: 'a corner', curve: 'an edge', centre: 'a circle, an arc or a sphere', cylinder: 'a cylindrical face', face: 'a face',
      };
      return `Click ${what[dialog.pick.kind]} · Esc stops picking`;
    }
    if (dialog?.kind === 'feature' && activeFeature?.kind === 'thread') return 'Click cylindrical faces to thread them (a shaft outside, a hole inside) · click one again to take it out · Esc cancels';
    if (dialog?.kind === 'feature' && activeFeature?.kind === 'sweep') {
      const edges = activeFeature.path.kind === 'edges';
      // with edges for the path, an edge clicked goes to the path and a face to the targets
      const bodies = activeFeature.op === 'new' ? '' : edges ? ' · click a face of a body for the targets' : ' · click a body for the targets';
      return `${edges ? 'Click edges of the path, end to end · click' : 'Click'} a profile to sweep it${bodies} · Esc cancels`;
    }
    if (dialog?.kind === 'feature' && activeFeature?.kind === 'coil' && !dialog.pick && activeFeature.op !== 'new' && !activeFeature.pathOnly) return 'Click bodies for the targets (none: every body it meets) · Pick fills a field from the view · Esc cancels';
    if (dialog?.kind === 'feature' && activeFeature?.kind === 'rib') return 'Pick the sketch and its curves in the dialog · click a body to join the rib to it · Esc cancels';
    if (dialog?.kind === 'feature' && held) return 'Pick fills a field from the view (a face, an edge, a corner or a plane) · Esc cancels';
    if (dialog?.kind === 'feature') return 'Click profiles or bodies in the view to pick them · Esc cancels';
    return 'Drag: orbit · Shift/middle-drag: pan · wheel: zoom · E extrude · H hole · F fillet · Q press pull · J joint · M measure';
  })();

  // ------------------------------------------------------------ panels

  const material = (density: string) => MATERIALS.find((m) => m.density === density.trim());
  /** The bill of materials: masses each from the components' (hidden occurrences are left out). */
  const bom = () => bomTable(design, Object.fromEntries(Object.entries(dr?.components ?? {}).map(([k, v]) => [k, v?.m])), region.density);

  const dialogPanel = (() => {
    if (!dialog) return null;
    if (dialog.kind === 'feature' && activeFeature && isModify(activeFeature)) {
      const c = design.components.find((q) => q.id === dialog.cid)!;
      const f = activeFeature;
      return (
        <Dialog title={featureTitle(f)} error={dr?.errors[f.id]} onOk={() => closeDialog(true)} onCancel={() => closeDialog(false)}>
          <ModifyFields design={design} comp={c} feature={f} result={result} target={dialog.target} onTarget={(target) => setDialog({ ...dialog, target })}
            set={dialog.set ?? 0} onSet={(set) => setDialog({ ...dialog, set })}
            onChange={(p, k) => patchItem(c.id, f.id, p as Partial<DesignItem>, k ? `${f.id}:${k}` : undefined)} />
          {dr?.warnings?.[f.id] && <div className="region-warn">{dr.warnings[f.id]}</div>}
          {dialog.rollback && <p className="hint">The timeline is rolled back to {f.name} while you edit it.</p>}
        </Dialog>
      );
    }
    if (dialog.kind === 'feature' && activeFeature && isBuildFeature(activeFeature)) {
      const c = design.components.find((q) => q.id === dialog.cid)!;
      const f = activeFeature;
      return (
        <Dialog title={featureTitle(f)} error={dr?.errors[f.id]} onOk={() => closeDialog(true)} onCancel={() => closeDialog(false)}>
          <BuildFields design={design} comp={c} feature={f} result={result} unit={u} pick={dialog.pick} onPick={(pick) => setDialog({ ...dialog, pick })}
            onChange={(p, k) => patchItem(c.id, f.id, p, k ? `${f.id}:${k}` : undefined)} />
          {dr?.warnings?.[f.id] && <div className="region-warn">{dr.warnings[f.id]}</div>}
          {dialog.rollback && <p className="hint">The timeline is rolled back to {f.name} while you edit it.</p>}
        </Dialog>
      );
    }
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
      const datumPlanes = (comp?.items ?? []).filter((i): i is ConstructItem => i.kind === 'plane' && !!build?.components[comp!.id]?.datums?.[i.id]);
      const origin = ['XY', 'XZ', 'YZ'].includes(dialog.ref);
      return (
        <Dialog title="Create sketch" okLabel="Create" onOk={() => (origin ? newSketchOn({ ref: dialog.ref as PlaneRef, ...offset }) : sketchOnDatum(dialog.ref, dialog.offset))} onCancel={() => setDialog(null)}>
          <p className="hint">Click an origin plane, a construction plane or a flat face of a body in the view, or pick a plane here.</p>
          <label className="field">
            <span>Plane</span>
            <select value={dialog.ref} onChange={(e) => setDialog({ ...dialog, ref: e.target.value })}>
              <option value="XY">XY (top)</option><option value="XZ">XZ (front)</option><option value="YZ">YZ (right)</option>
              {datumPlanes.map((p) => <option key={p.id} value={p.id}>{p.name} (construction plane)</option>)}
            </select>
          </label>
          <Expr label="Offset along the normal" value={dialog.offset} placeholder="0" onChange={(o) => setDialog({ ...dialog, offset: o })} />
        </Dialog>
      );
    }
    if (dialog.kind === 'joint' && activeJoint) {
      return (
        <Dialog title={`Joint — ${activeJoint.name}`} error={dr?.errors[activeJoint.id]} onOk={() => closeDialog(true)} onCancel={() => closeDialog(false)}>
          <label className="check" title="Pick one origin: the other side's goes where it is now, so the parts stay where they are">
            <input type="checkbox" checked={!!dialog.asBuilt} onChange={(e) => {
              // a new joint holds nothing until its as-built origin is picked
              if (dialog.isNew) patchJoint(activeJoint.id, { suppressed: e.target.checked || undefined });
              setDialog({ ...dialog, asBuilt: e.target.checked || undefined, picking: e.target.checked ? 'b' : dialog.picking });
            }} /> As built (nothing moves)
          </label>
          <JointFields design={design} joint={activeJoint} picking={dialog.picking} onPick={(p) => setDialog({ ...dialog, picking: p })}
            onChange={(p, k) => patchJoint(activeJoint.id, p, k ? `${activeJoint.id}:${k}` : undefined)}
            values={placedValues(activeJoint.id)} unit={u} onDrive={(dof) => startDrive(activeJoint.id, dof)} />
          {dr?.warnings?.[activeJoint.id] && <div className="region-warn">{dr.warnings[activeJoint.id]}</div>}
          {dialog.snap && <p className="hint">{dialog.snap}</p>}
        </Dialog>
      );
    }
    if (dialog.kind === 'drive') {
      const j = design.joints.find((q) => q.id === dialog.joint), kj = kinJoint(dialog.joint);
      if (!j || !kj) return null;
      const field = dialog.dof;
      const sol = av.solution;
      const problems = sol ? [...Object.entries(sol.errors).map(([id, e]) => [id, e, 'region-error']), ...Object.entries(sol.warnings).map(([id, e]) => [id, e, 'region-warn'])] : [];
      // the driven value, or (a solved DOF driven) the values of the joints that drive its loop
      const patches = sol ? drivePatches(design, sol.values, (build?.kin ?? dr?.kin)?.values ?? {}, dialog, u, sceneSize) : { [j.id]: { [field]: dofExpr(field, dialog.value, u) } };
      const solvedDrive = !!j.dofs?.[dialog.dof]?.free;
      const written = (p: Partial<CadJoint>) => Object.entries(p).flatMap(([k, v]) => (k === 'dofs' ? Object.values(v as NonNullable<CadJoint['dofs']>).flatMap((d) => (d?.rest ? [`rest ${d.rest}`] : [])) : [String(v)])).join(', ');
      const alsoSet = Object.entries(patches).filter(([id]) => solvedDrive || id !== j.id).map(([id, p]) => `${design.joints.find((q) => q.id === id)?.name ?? id}: ${written(p)}`);
      return (
        <Dialog title={`Drive — ${j.name}`} okLabel="Set as value" onOk={() => {
          if (Object.keys(patches).length) setDesign({ ...cur(), joints: cur().joints.map((q) => (patches[q.id] ? { ...q, ...patches[q.id] } : q)) });
          setDialog(null);
        }} onCancel={() => setDialog(null)}>
          {drivenDofs(design, j).length > 1 && (
            <Pick label="DOF" value={dialog.dof} options={drivenDofs(design, j).map((k) => [k, `${dofLabel(j.type, k)}${j.dofs?.[k]?.free ? ' (solved)' : ''}`] as [DofKey, string])}
              onChange={(dof) => setDialog({ ...dialog, dof, value: placedValues(j.id)?.[dof] ?? 0 })} />
          )}
          <DrivePanel joint={j} dof={dialog.dof} value={dialog.value} unit={u} size={sceneSize} values={{ min: kj.min[dialog.dof], max: kj.max[dialog.dof], rest: kj.rest[dialog.dof] }}
            onValue={(value) => setDialog((d) => (d?.kind === 'drive' ? { ...d, value } : d))} />
          {sol && <p className="hint">Placed at {dofText(dialog.dof, sol.values[j.id]?.[dialog.dof], u)}{design.joints.filter((q) => q.id !== j.id && JOINT_DOFS[q.type].some((k) => q.dofs?.[k]?.free)).map((q) => ` · ${q.name} ${JOINT_DOFS[q.type].filter((k) => q.dofs?.[k]?.free).map((k) => dofText(k, sol.values[q.id]?.[k], u)).join(', ')}`).join('')}</p>}
          {alsoSet.length > 0 && <p className="hint">{solvedDrive ? `${j.name} stays solved: Set as value writes ` : 'Set as value also writes '}{alsoSet.join(' · ')}.</p>}
          {problems.map(([id, e, cls]) => <div key={`${cls}:${id}`} className={cls}>{design.joints.find((q) => q.id === id)?.name ?? id}: {e}</div>)}
        </Dialog>
      );
    }
    if (dialog.kind === 'link' && linkOpen) {
      return (
        <Dialog title={`Motion link — ${linkOpen.name}`} error={dr?.errors[linkOpen.id]} onOk={() => closeDialog(true)} onCancel={() => closeDialog(false)}>
          <LinkFields design={design} link={linkOpen} onChange={(p, k) => patchLink(linkOpen.id, p, k ? `${linkOpen.id}:${k}` : undefined)} />
        </Dialog>
      );
    }
    if (dialog.kind === 'group') {
      return (
        <Dialog title="Rigid group" okLabel="Group" onOk={() => makeGroup(dialog.occs)} onCancel={() => setDialog(null)}>
          <p className="hint">The occurrences ticked are locked together where they are now: what moves one moves them all.</p>
          <Checks label="Occurrences" items={design.occurrences.map((o) => [o.id, occLabel(o)])} value={dialog.occs} onChange={(v) => setDialog({ ...dialog, occs: v ?? [] })} empty="No occurrences" />
        </Dialog>
      );
    }
    if (dialog.kind === 'motion' && motionStudy) {
      const m = motionStudy, r = dr?.motions?.[m.id];
      const canvasOf = () => viewRef.current?.querySelector('canvas') ?? null;
      const name = `${fileBase}-${m.name}`.replace(/[^\w.-]+/g, '_');
      const exporting = async (what: string, run: (cv: HTMLCanvasElement) => Promise<void>) => {
        const cv = canvasOf();
        if (!cv) return setMsg('The 3-D view is not there to record');
        player.setPlaying(false);
        setDialog((d) => (d?.kind === 'motion' ? { ...d, busy: what } : d));
        try {
          await run(cv);
        } catch (e) {
          setMsg(`${what} failed: ${(e as Error).message}`);
        } finally {
          setDialog((d) => (d?.kind === 'motion' ? { ...d, busy: undefined } : d));
        }
      };
      return (
        <Dialog title={`Motion study — ${m.name}`} okLabel="Done" error={dr?.errors[m.id] ?? r?.error} onOk={() => { player.setPlaying(false); closeDialog(true); }} onCancel={() => { player.setPlaying(false); closeDialog(false); }}>
          <MotionTransport player={player} duration={m.duration} steps={m.steps ?? 36} />
          {av.solution && Object.keys(av.solution.warnings).length > 0 && <div className="region-warn">{Object.entries(av.solution.warnings).map(([id, w]) => `${design.joints.find((q) => q.id === id)?.name ?? id}: ${w}`)[0]}</div>}
          {av.hits.size > 0 && <div className="region-error">Overlapping now: {[...av.hits].map((id) => { const o = occOf(id); return o ? occLabel(o) : id; }).join(' and ')}</div>}
          {r && <ClearanceChart result={r} t={player.t} duration={m.duration} unit={u} />}
          {r?.clearanceError && <div className="region-warn">{r.clearanceError}</div>}
          {r?.warning && <div className="region-warn">{r.warning}</div>}
          <MotionFields design={design} study={m} unit={u} onChange={(p, k) => patchMotion(m.id, p, k ? `${m.id}:${k}` : undefined)} />
          <div className="cadd-actions">
            <button className="btn" disabled={!r} title="The sampled frames, tab-separated: paste them into the worksheet for a table" onClick={() => r && void navigator.clipboard?.writeText(motionTsv(design, r, u)).then(() => setMsg('Copied: paste it into the worksheet for a table'), () => setMsg('The clipboard is not available here'))}>Copy table</button>
            <button className="btn" disabled={!!dialog.busy} title="Every sampled frame as a PNG, in a zip" onClick={() => void exporting('PNG frames', (cv) => exportPngFrames(cv, sampleTimes(m), player.setT, name, (n) => setDialog((d) => (d?.kind === 'motion' ? { ...d, busy: `PNG ${n} / ${(m.steps ?? 36) + 1}` } : d))))}><Images size={13} /> PNG frames</button>
            {canRecord() && <button className="btn" disabled={!!dialog.busy} title="Play the study once and record it as WebM video" onClick={() => void exporting('Recording', (cv) => recordWebm(cv, m.duration, player.setT, name))}><Film size={13} /> WebM</button>}
          </div>
          {dialog.busy && <p className="hint">{dialog.busy}…</p>}
          <p className="hint">The worksheet reads <code>{region.name || 'part'}.{m.name}</code>: <code>.t</code>, <code>.table</code>, each joint per frame{m.clearance ? <>, <code>.c</code>, <code>.c_min</code>, <code>.V_int</code></> : ''}, and <code>.of.Joint(x)</code> solved at a value x of the first track.</p>
        </Dialog>
      );
    }
    if (dialog.kind === 'measure') {
      const [a, b] = dialog.picks;
      const r = dialog.result;
      // rounding noise on an axis the two points share reads as 0
      const d = r ? sub3(r.b, r.a).map((v) => (Math.abs(v) < 1e-9 * Math.max(1, r.d) ? 0 : v)) : null;
      const where = (m: Measured) => (m.ref.kind === 'point' ? ` (${m.ref.p.map((v) => fmtNum(v)).join(', ')}) ${u}` : '');
      return (
        <Dialog title="Measure" okLabel="Done" onOk={() => setDialog(null)} onCancel={() => setDialog(null)} error={dialog.error}>
          <p className="hint">Click two faces, edges or corners (corners snap): the smallest distance between them, on the exact geometry.</p>
          {a && <p>A: {a.label}{where(a)}</p>}
          {b && <p>B: {b.label}{where(b)}</p>}
          {b && !r && !dialog.error && <p className="hint">Measuring…</p>}
          {r && d && (
            <table className="props-table"><tbody>
              <tr><td>Distance</td><td><b>{fmtNum(r.d)}</b> {u}{r.exact ? '' : ' (mesh)'}</td></tr>
              <tr><td>ΔX, ΔY, ΔZ</td><td>{d.map((v) => fmtNum(v)).join(', ')} {u}</td></tr>
            </tbody></table>
          )}
        </Dialog>
      );
    }
    if (dialog.kind === 'interference') {
      const name = (id: string) => {
        const o = occOf(id);
        return o ? occLabel(o) : id;
      };
      return (
        <Dialog title="Interference" okLabel="Done" onOk={() => setDialog(null)} onCancel={() => setDialog(null)} error={dialog.error}>
          {!dialog.rows ? <p className="hint">Checking…</p> : !dialog.rows.length ? <p className="hint">No occurrences overlap.</p> : (
            <table className="props-table"><tbody>
              {dialog.rows.map((r, i) => <tr key={i}><td>{name(r.a)} ∩ {name(r.b)}</td><td>{num(r.v, 4)} {u}³</td></tr>)}
            </tbody></table>
          )}
          <button className="btn" onClick={runInterference}>Check again</button>
        </Dialog>
      );
    }
    return null;
  })();

  const selectionPanel = (() => {
    if (picks.length && build) {
      return (
        <SelectionPanel picks={picks} build={build} design={design} result={result} unit={u}
          onBody={(occ, body) => { setPicks([]); setSel(`body:${occ}:${body}`); }} onClear={() => setPicks([])} />
      );
    }
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
          {isSketch(it) && <p className="hint">On {planeWords(it)}{it.plane.offset ? `, offset ${it.plane.offset}` : ''}{'frame' in it.plane ? (sketchFace(it) ? (dr?.warnings?.[it.id] ? '' : ': it follows the face through edits') : ', where the face was when the sketch was made') : ''}.</p>}
          {isSketch(it) && dr?.sketches[it.id] && <p className="hint">{dr.sketches[it.id].dof === 0 ? 'Fully defined' : `${dr.sketches[it.id].dof} DOF free`}{dr.sketches[it.id].section ? ` · A = ${num(dr.sketches[it.id].section!.A)} ${u}²` : ''}</p>}
          {isSketch(it) && <Expr label="Plane offset" value={it.plane.offset ?? ''} placeholder="0" onChange={(v) => patchItem(c.id, it.id, { plane: { ...it.plane, offset: v || undefined } } as Partial<DesignItem>)} />}
          {dr?.errors[it.id] && <div className="region-error">{dr.errors[it.id]}</div>}
          {dr?.warnings?.[it.id] && <div className="region-warn">{dr.warnings[it.id]}</div>}
          <div className="cadd-actions">
            <button className="btn primary" onClick={() => editItem(c.id, it)}>{isSketch(it) ? 'Edit sketch' : 'Edit feature'}</button>
            {!isSketch(it) && <button className="btn" onClick={() => patchItem(c.id, it.id, { suppressed: it.suppressed ? undefined : true })}>{it.suppressed ? 'Unsuppress' : 'Suppress'}</button>}
            {(isSketch(it) || isConstruct(it)) && <button className="btn" onClick={() => patchItem(c.id, it.id, { hidden: it.hidden ? undefined : true } as Partial<DesignItem>)}>{it.hidden ? 'Show' : 'Hide'}</button>}
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
          <ExplodeFields value={o.explode} onChange={(explode) => patchOcc(o.id, { explode })} />
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
          <h3 className="sub">Joint · {JOINT_LABEL[j.type]}</h3>
          <label className="field"><span>Name</span><LazyInput label="Joint name" mono={false} value={j.name} onCommit={(v) => v.trim() && patchJoint(j.id, { name: v.trim() })} /></label>
          {dr?.errors[j.id] && <div className="region-error">{dr.errors[j.id]}</div>}
          {dr?.warnings?.[j.id] && <div className="region-warn">{dr.warnings[j.id]}</div>}
          <JointDofFields joint={j} values={placedValues(j.id)} unit={u} onChange={(p, k) => patchJoint(j.id, p, k ? `${j.id}:${k}` : undefined)} onDrive={(dof) => startDrive(j.id, dof)} />
          {!!dr?.kin?.mobility && <p className="hint">The loops leave {dr.kin.mobility} DOF undetermined: the solved DOFs stay nearest where they started. Drive one more DOF to fix it.</p>}
          <p className="hint">In the worksheet: <code>{region.name || 'part'}.{j.name}</code> {j.type === 'rigid' ? '(rigid joints export nothing)' : ''}</p>
          <div className="cadd-actions">
            <button className="btn primary" onClick={() => { seal(); openDialog({ kind: 'joint', id: j.id, mark: mark(), isNew: false, picking: null }); }}>Edit joint</button>
            {drivenDofs(design, j).length > 0 && <button className="btn" onClick={() => startDrive(j.id)}><SlidersHorizontal size={13} /> Drive</button>}
            <button className="btn" onClick={() => patchJoint(j.id, { suppressed: j.suppressed ? undefined : true })}>{j.suppressed ? 'Unsuppress' : 'Suppress'}</button>
            <button className="btn danger" onClick={() => { setDesign({ ...cur(), joints: cur().joints.filter((q) => q.id !== j.id) }); setSel(null); }}><Trash2 size={13} /> Delete</button>
          </div>
        </div>
      );
    }
    if (sel?.startsWith('link:') && linkOpen) {
      const l = linkOpen;
      return (
        <div className="props">
          <h3 className="sub">Motion link</h3>
          <label className="field"><span>Name</span><LazyInput label="Link name" mono={false} value={l.name} onCommit={(v) => v.trim() && patchLink(l.id, { name: v.trim() })} /></label>
          {dr?.errors[l.id] && <div className="region-error">{dr.errors[l.id]}</div>}
          <LinkFields design={design} link={l} onChange={(p, k) => patchLink(l.id, p, k ? `${l.id}:${k}` : undefined)} />
          <div className="cadd-actions">
            <button className="btn" onClick={() => patchLink(l.id, { suppressed: l.suppressed ? undefined : true })}>{l.suppressed ? 'Unsuppress' : 'Suppress'}</button>
            <button className="btn danger" onClick={() => { setDesign({ ...cur(), links: (cur().links ?? []).filter((q) => q.id !== l.id) }); setSel(null); }}><Trash2 size={13} /> Delete</button>
          </div>
        </div>
      );
    }
    if (sel?.startsWith('group:')) {
      const g = design.groups?.find((q) => q.id === sel.slice(6));
      if (!g) return null;
      return (
        <div className="props">
          <h3 className="sub">Rigid group</h3>
          <label className="field"><span>Name</span><LazyInput label="Group name" mono={false} value={g.name} onCommit={(v) => v.trim() && patchGroup(g.id, { name: v.trim() })} /></label>
          {dr?.errors[g.id] && <div className="region-error">{dr.errors[g.id]}</div>}
          <p className="hint">Locked where they were when grouped: {g.occs.map((id) => { const o = occOf(id); return o ? occLabel(o) : '(gone)'; }).join(', ')}.</p>
          <div className="cadd-actions">
            <button className="btn" onClick={() => patchGroup(g.id, { suppressed: g.suppressed ? undefined : true })}>{g.suppressed ? 'Unsuppress' : 'Suppress'}</button>
            <button className="btn danger" onClick={() => { setDesign({ ...cur(), groups: (cur().groups ?? []).filter((q) => q.id !== g.id) }); setSel(null); }}><Trash2 size={13} /> Ungroup</button>
          </div>
        </div>
      );
    }
    if (sel?.startsWith('motion:')) {
      const m = design.motions?.find((q) => q.id === sel.slice(7));
      if (!m) return null;
      const r = dr?.motions?.[m.id];
      return (
        <div className="props">
          <h3 className="sub">Motion study</h3>
          <label className="field"><span>Name</span><LazyInput label="Study name" mono={false} value={m.name} onCommit={(v) => v.trim() && patchMotion(m.id, { name: v.trim() })} /></label>
          <p className="hint">{fmtNum(m.duration)} s, {m.tracks.length} track{m.tracks.length === 1 ? '' : 's'}, sampled at {(m.steps ?? 36) + 1} frames{m.clearance ? ', clearance tracked' : ''}.</p>
          {dr?.errors[m.id] && <div className="region-error">{dr.errors[m.id]}</div>}
          {r?.error && <div className="region-error">{r.error}</div>}
          {r?.warning && <div className="region-warn">{r.warning}</div>}
          {r?.clearanceError && <div className="region-warn">{r.clearanceError}</div>}
          {r && <ClearanceChart result={r} t={0} duration={m.duration} unit={u} />}
          <p className="hint">In the worksheet: <code>{region.name || 'part'}.{m.name}.t</code>, <code>.table</code>, a joint’s values per frame <code>.{design.joints.find((q) => JOINT_DOFS[q.type].length)?.name ?? 'Joint1'}</code>{m.clearance ? <>, <code>.c</code>, <code>.c_min</code>, <code>.V_int</code></> : ''} and <code>.of.Joint(x)</code> against the first track.</p>
          <div className="cadd-actions">
            <button className="btn primary" onClick={() => { seal(); openDialog({ kind: 'motion', id: m.id, mark: mark(), isNew: false }); }}><Play size={13} /> Open</button>
            <button className="btn danger" onClick={() => { setDesign({ ...cur(), motions: (cur().motions ?? []).filter((q) => q.id !== m.id) }); setSel(null); }}><Trash2 size={13} /> Delete</button>
          </div>
        </div>
      );
    }
    if (sel === 'bom') {
      const table = bom();
      return (
        <div className="props">
          <h3 className="sub">Bill of materials</h3>
          <BomPanel table={table}
            onCopy={() => void navigator.clipboard?.writeText(bomTsv(table)).then(() => setMsg('Copied: paste it into the worksheet for a table'), () => setMsg('The clipboard is not available here'))}
            onCsv={() => void exportFile(`${fileBase}-bom.csv`, bomCsv(table), 'text/csv')} />
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
        {errorCount + warnCount > 0 && (
          <>
            <h3 className="sub">Problems</h3>
            {[...Object.entries(dr!.errors).map(([id, e]) => [id, e, 'region-error']), ...Object.entries(dr!.warnings ?? {}).map(([id, e]) => [id, e, 'region-warn'])].map(([id, e, cls]) => {
              const name = design.components.flatMap((c) => c.items).find((i) => i.id === id)?.name ?? design.joints.find((j) => j.id === id)?.name ?? design.components.find((c) => c.id === id)?.name
                ?? [...(design.links ?? []), ...(design.groups ?? []), ...(design.motions ?? [])].find((x) => x.id === id)?.name ?? (occOf(id) ? occLabel(occOf(id)!) : id);
              return <div key={`${cls}:${id}`} className={cls}>{name}: {e}</div>;
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
        <button className="cadw-close" onClick={() => { finishRollback(); onClose(); }} title="Close the CAD window (the part stays in the worksheet)"><X size={16} /> Close</button>
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
              {toolBtn('spline', <LineSquiggle size={20} />, 'Spline', 'Fit-point spline through the points clicked (N); click the first point again to close it')}
              {toolBtn('cspline', <SplinePointer size={20} />, 'Control spline', 'Control-point spline: the points are its poles (Shift+N)')}
              {toolBtn('ellipse', <EllipseIcon size={20} />, 'Ellipse', 'Ellipse: centre, end of the major axis, minor axis (Shift+E)')}
              {toolBtn('earc', <CircleDotDashed size={20} />, 'Ellipse arc', 'Elliptical arc: centre, end of the major axis, start, end')}
              {toolBtn('point', <Dot size={20} />, 'Point', 'Point (P) — hole centres')}
              {toolBtn('text', <Type size={20} />, 'Text', 'Text (Shift+P): its outline is a profile to extrude or cut')}
            </Group>
            <Group label="Modify">
              {toolBtn('fillet', <SquareRoundCorner size={20} />, 'Fillet', 'Sketch fillet (I)')}
              {toolBtn('chamfer', <CornerRightDown size={20} />, 'Chamfer', 'Sketch chamfer at a corner of two lines (Shift+I)')}
              {toolBtn('offset', <VectorSquare size={20} />, 'Offset', 'Offset a chain (or the selected curves) by a distance (Shift+O); it follows its chain')}
              {toolBtn('trim', <Scissors size={20} />, 'Trim', 'Trim (T)')}
              {toolBtn('extend', <MoveHorizontal size={20} />, 'Extend', 'Extend a line or arc to the next curve (Shift+T)')}
              {toolBtn('break', <ScissorsLineDashed size={20} />, 'Break', 'Split a curve at a point (B)')}
              {toolBtn('mirror', <SquareSplitHorizontal size={20} />, 'Mirror', 'Mirror the selection about a line (M)')}
              <RibbonButton icon={<Grid2x2 size={20} />} label="Pattern" title="Rectangular pattern of the selection (counts and spacings in Options)" disabled={!selIds.length} onClick={() => cmd((cv) => cv.rectPattern())} />
              {toolBtn('cpattern', <Rotate3d size={20} />, 'Circ. pattern', 'Circular pattern of the selection about a point')}
              <RibbonButton icon={<Construction size={20} />} label="Construction" title="Construction geometry (X)" on={ui.cadConstruction} onClick={() => cmd((cv) => cv.toggleConstruction())} />
            </Group>
            <Group label="Project">
              <RibbonButton icon={<Waypoints size={20} />} label="Project" title="Project edges and faces' outlines of the bodies (picked in 3-D) and construction points and axes: fixed reference geometry that follows the model" on={!!projecting} onClick={() => (projecting ? endProject() : startProject())} />
              <RibbonButton icon={<ScanLine size={20} />} label="Intersect" title="The section of the bodies with the sketch plane, as reference geometry that follows the model" onClick={intersect} />
              <RibbonButton icon={<Trash2 size={20} />} label="Delete" title="Delete the selection (Del)" disabled={!selIds.length} onClick={() => cmd((cv) => cv.deleteSelected())} />
            </Group>
            <Group label="Dimension">{toolBtn('dim', <Ruler size={20} />, 'Dimension', 'Smart dimension (D)')}</Group>
            <Group label="Options">
              <div className="cadw-options">
                {tool === 'polygon' && <label>Sides <input type="number" min={3} max={64} value={ui.cadSides} onChange={(e) => setUi({ cadSides: Math.max(3, Math.min(64, Number(e.target.value) || 6)) })} /></label>}
                {tool === 'fillet' && <label>Radius <input type="number" min={0} step="any" value={ui.cadFillet} onChange={(e) => setUi({ cadFillet: Math.max(0, Number(e.target.value)) })} /> {u}</label>}
                {tool === 'offset' && <label title="The offset distance (a dimension you can change afterwards)">Distance <input type="number" min={0} step="any" value={ui.cadOffset} onChange={(e) => setUi({ cadOffset: Math.max(0, Number(e.target.value)) })} /> {u}</label>}
                {tool === 'chamfer' && <label>Distance <input type="number" min={0} step="any" value={ui.cadChamfer} onChange={(e) => setUi({ cadChamfer: Math.max(0, Number(e.target.value)) })} /> {u}</label>}
                {tool === 'text' && (
                  <>
                    <label>Text <input className="cadw-text" value={ui.cadText} onChange={(e) => setUi({ cadText: e.target.value })} /></label>
                    <label title="The font size: capitals are 0.694 of it">Size <input type="number" min={0} step="any" value={ui.cadTextSize} onChange={(e) => setUi({ cadTextSize: Math.max(0, Number(e.target.value)) })} /> {u}</label>
                  </>
                )}
                {(tool === 'select' || tool === 'cpattern') && selIds.length > 0 && (
                  <>
                    <label title="Copies in the first direction (the original counts)">Count <input type="number" min={1} max={200} value={ui.cadCount} onChange={(e) => setUi({ cadCount: Math.max(1, Math.min(200, Math.round(Number(e.target.value)) || 1)) })} /></label>
                    {tool === 'cpattern'
                      ? <label title="The total angle: 360° spreads the copies evenly">Angle <input type="number" step="any" value={ui.cadAngle} onChange={(e) => setUi({ cadAngle: Number(e.target.value) })} /> °</label>
                      : (
                        <>
                          <label title="Spacing along x">Δx <input type="number" step="any" value={ui.cadSpacing} onChange={(e) => setUi({ cadSpacing: Number(e.target.value) })} /></label>
                          <label title="Copies along y (1: a single row)">Rows <input type="number" min={1} max={200} value={ui.cadCount2} onChange={(e) => setUi({ cadCount2: Math.max(1, Math.min(200, Math.round(Number(e.target.value)) || 1)) })} /></label>
                          <label title="Spacing along y">Δy <input type="number" step="any" value={ui.cadSpacing2} onChange={(e) => setUi({ cadSpacing2: Number(e.target.value) })} /></label>
                        </>
                      )}
                  </>
                )}
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
              <RibbonButton icon={<PenTool size={20} />} label="Sketch" title="Create a sketch on a plane or a flat face" on={dialog?.kind === 'sketch'} onClick={() => openDialog({ kind: 'sketch', ref: 'XY', offset: '' })} />
              <RibbonButton icon={<ArrowUpFromLine size={20} />} label="Extrude" title="Extrude profiles: new body, join, cut or intersect (E)" onClick={() => startFeature('extrude')} />
              <RibbonButton icon={<RotateCw size={20} />} label="Revolve" title="Revolve profiles about an axis" onClick={() => startFeature('revolve')} />
              <RibbonButton icon={<Cone size={20} />} label="Loft" title="Loft: join a profile of one sketch to a profile of another (on an offset plane)" onClick={() => startFeature('loft')} />
              <RibbonButton icon={<CircleDot size={20} />} label="Hole" title="Holes at sketch points: simple, counterbore, countersink, tapped (H)" onClick={() => startFeature('hole')} />
              <RibbonButton icon={<Route size={20} />} label="Sweep" title="Sweep a profile along a path: sketch curves, edges or a coil's helix; twist and taper" on={activeFeature?.kind === 'sweep'} onClick={() => startFeature('sweep')} />
              <RibbonButton icon={<Tornado size={20} />} label="Coil" title="A coil (spring): a section along a helix on a plane or face" on={activeFeature?.kind === 'coil'} onClick={() => startFeature('coil')} />
              <RibbonButton icon={<Screw size={20} />} label="Thread" title="ISO metric threads on shafts and in holes, cosmetic or modeled" on={activeFeature?.kind === 'thread'} onClick={() => startFeature('thread')} />
              <RibbonButton icon={<TriangleRight size={20} />} label="Rib" title="A rib (gusset) from an open sketch curve, grown in its plane to the body" on={activeFeature?.kind === 'rib'} onClick={() => startFeature('rib')} />
            </Group>
            <Group label="Construct">
              <RibbonButton icon={<Diamond size={20} />} label="Plane" title="Construction plane: offset, at an angle, midplane, through three points, tangent, along a path" on={activeFeature?.kind === 'plane'} onClick={() => startFeature('plane')} />
              <RibbonButton icon={<MoveDiagonal size={20} />} label="Axis" title="Construction axis: through two points, an edge, a cylinder, or normal to a face" on={activeFeature?.kind === 'axis'} onClick={() => startFeature('axis')} />
              <RibbonButton icon={<Locate size={20} />} label="Point" title="Construction point: a vertex, a circle's centre, an edge crossing a plane" on={activeFeature?.kind === 'point'} onClick={() => startFeature('point')} />
            </Group>
            <Group label="Pattern">
              <RibbonButton icon={<Grid3x3 size={20} />} label="Pattern" title="Rectangular or circular pattern of features or bodies" onClick={() => startFeature('pattern')} />
              <RibbonButton icon={<FlipHorizontal2 size={20} />} label="Mirror" title="Mirror features or bodies about a plane" onClick={() => startFeature('mirror')} />
            </Group>
            <Group label="Modify">
              <RibbonButton icon={<ArrowUpDown size={20} />} label="Press pull" title="Move flat faces along their normal, grow or shrink cylinders (Q)" on={activeFeature?.kind === 'presspull'} onClick={() => startFeature('presspull')} />
              <RibbonButton icon={<Radius size={20} />} label="Fillet" title="Round edges picked in the view, one radius per set or a varying one (F)" on={activeFeature?.kind === 'fillet'} onClick={() => startFeature('fillet')} />
              <RibbonButton icon={<Octagon size={20} />} label="Chamfer" title="Chamfer edges: equal distance, two distances, or distance and angle" on={activeFeature?.kind === 'chamfer'} onClick={() => startFeature('chamfer')} />
              <RibbonButton icon={<PackageOpen size={20} />} label="Shell" title="Hollow a body: walls of a thickness, the picked faces open" on={activeFeature?.kind === 'shell'} onClick={() => startFeature('shell')} />
              <RibbonButton icon={<Pyramid size={20} />} label="Draft" title="Tilt faces about a neutral plane (mould release)" on={activeFeature?.kind === 'draft'} onClick={() => startFeature('draft')} />
              <RibbonButton icon={<Slice size={20} />} label="Split body" title="Split a body by a plane or a flat face into bodies" on={activeFeature?.kind === 'split'} onClick={() => startFeature('split')} />
              <RibbonButton icon={<Move size={20} />} label="Move/Copy" title="Move, turn or copy bodies" on={activeFeature?.kind === 'move'} onClick={() => startFeature('move')} />
              <RibbonButton icon={<Combine size={20} />} label="Combine" title="Join, cut or intersect bodies" onClick={() => startFeature('combine')} />
            </Group>
            <Group label="Inspect">
              <RibbonButton icon={<SquareSlash size={20} />} label="Section" title="Cut the model with a plane to look inside" on={!!section} onClick={() => setSection(section ? null : { plane: 'XZ', at: 0.5, flip: false })} />
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
              <RibbonButton icon={<Link2 size={20} />} label="Joint" title="Join two occurrences: rigid, revolute, slider, cylindrical, pin-slot, planar, ball (J)" onClick={() => startJoint()} />
              <RibbonButton icon={<Link size={20} />} label="As-built" title="A joint where the parts are now: pick one origin, nothing moves" onClick={startAsBuilt} />
              <RibbonButton icon={<Anchor size={20} />} label="Ground" title="Fix the selected occurrence in place" disabled={!selOcc}
                onClick={() => { const o = selOcc && occOf(selOcc); if (o) patchOcc(o.id, { grounded: o.grounded ? undefined : true }); }} />
              <RibbonButton icon={<Move3d size={20} />} label="Move" title="Position the selected occurrence" disabled={!selOcc} onClick={() => selOcc && setSel(`occ:${selOcc}`)} />
            </Group>
            <Group label="Motion">
              <RibbonButton icon={<SlidersHorizontal size={20} />} label="Drive" title="Move a joint by hand with a slider (the selected one): the others follow; the document changes only on Set" on={dialog?.kind === 'drive'}
                onClick={() => startDrive(sel?.startsWith('joint:') ? sel.slice(6) : undefined)} />
              <RibbonButton icon={<Cog size={20} />} label="Motion link" title="One joint follows another: gears, rack and pinion" on={dialog?.kind === 'link'} onClick={startLink} />
              <RibbonButton icon={<GroupIcon size={20} />} label="Rigid group" title="Lock occurrences together where they are" on={dialog?.kind === 'group'} onClick={() => (design.occurrences.length < 2 ? setMsg('A rigid group locks two occurrences or more together') : openDialog({ kind: 'group', occs: selOcc ? [selOcc] : [] }))} />
              <RibbonButton icon={<Clapperboard size={20} />} label="Motion study" title="Keyframes of joints over time: play, clearance per frame, results to the worksheet, video" on={dialog?.kind === 'motion'} onClick={startMotion} />
            </Group>
            <Group label="Check">
              <RibbonButton icon={<ScanSearch size={20} />} label="Interference" title="Find overlapping occurrences" onClick={runInterference} />
              <RibbonButton icon={<Layers size={20} />} label="Isolate" title="Dim everything outside the active component" on={isolate} onClick={() => setIsolate(!isolate)} />
              <RibbonButton icon={<Expand size={20} />} label="Explode" title="Exploded view: each occurrence out by its offset (Auto: along the joints)" on={explode !== null} onClick={() => setExplode(explode === null ? 1 : null)} />
              <RibbonButton icon={<ClipboardList size={20} />} label="BOM" title="Bill of materials: components, quantities, materials, masses" on={sel === 'bom'} onClick={() => { setDialog(null); setSel(sel === 'bom' ? null : 'bom'); }} />
            </Group>
          </>
        )}
        {shownTab === 'inspect' && (
          <>
            <Group label="Inspect">
              <RibbonButton icon={<Ruler size={20} />} label="Measure" title="Smallest distance between two picked faces, edges or corners, on the exact geometry (M)" on={dialog?.kind === 'measure'} onClick={() => openDialog({ kind: 'measure', picks: [] })} />
              <RibbonButton icon={<SquareSlash size={20} />} label="Section" title="Cut the model with a plane to look inside" on={!!section} onClick={() => setSection(section ? null : { plane: 'XZ', at: 0.5, flip: false })} />
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
            <RibbonButton icon={<FileBox size={20} />} label="STEP"
              title={shown.build?.kernel === 'mesh' ? 'STEP needs the exact B-rep kernel, which could not load' : 'Export the exact solids as STEP AP214 (other CAD programs), with names, colours and the assembly'}
              disabled={!!busy || shown.build?.kernel === 'mesh'} onClick={() => void exportAs('step')} />
            <RibbonButton icon={<Download size={20} />} label="STL" title="Export as STL (3-D printing), tessellated finely from the exact surfaces" disabled={!!busy} onClick={() => void exportAs('stl')} />
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
                      {c.items.some(isConstruct) && (
                        <Node k={`cc:${c.id}`} icon={<Diamond size={13} />} label={`Construction (${c.items.filter(isConstruct).length})`}>
                          {c.items.filter(isConstruct).map((ci) => (
                            <Node key={ci.id} k={`ci:${ci.id}`} icon={ICON[ci.kind]} label={ci.name} on={sel === `item:${ci.id}`} onClick={() => { setActive(c.id); setSel(`item:${ci.id}`); }}
                              bad={!!dr?.errors[ci.id]} warn={dr?.warnings?.[ci.id]}
                              extra={eye(ci.hidden, () => patchItem(c.id, ci.id, { hidden: ci.hidden ? undefined : true } as Partial<DesignItem>))} />
                          ))}
                        </Node>
                      )}
                      <Node k={`cs:${c.id}`} icon={<PenTool size={13} />} label={`Sketches (${sks.length})`}>
                        {sks.map((s) => (
                          <Node key={s.id} k={`s:${s.id}`} icon={<PenTool size={12} />} label={s.name} on={sel === `item:${s.id}`} onClick={() => { setActive(c.id); setSel(`item:${s.id}`); }} bad={!!dr?.errors[s.id]} warn={dr?.warnings?.[s.id]}
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
                  <Node key={j.id} k={`j:${j.id}`} icon={<Link2 size={12} />} label={`${j.name} · ${JOINT_LABEL[j.type].toLowerCase()}`} on={sel === `joint:${j.id}`} onClick={() => setSel(`joint:${j.id}`)} bad={!!dr?.errors[j.id]} warn={dr?.warnings?.[j.id]} />
                ))}
              </Node>
              {!!design.links?.length && (
                <Node k="links" icon={<Cog size={14} />} label={`Motion links (${design.links.length})`}>
                  {design.links.map((l) => <Node key={l.id} k={`l:${l.id}`} icon={<Cog size={12} />} label={l.name} on={sel === `link:${l.id}`} onClick={() => setSel(`link:${l.id}`)} bad={!!dr?.errors[l.id]} />)}
                </Node>
              )}
              {!!design.groups?.length && (
                <Node k="groups" icon={<GroupIcon size={14} />} label={`Rigid groups (${design.groups.length})`}>
                  {design.groups.map((g) => <Node key={g.id} k={`g:${g.id}`} icon={<GroupIcon size={12} />} label={`${g.name} · ${g.occs.length}`} on={sel === `group:${g.id}`} onClick={() => setSel(`group:${g.id}`)} bad={!!dr?.errors[g.id]} warn={dr?.warnings?.[g.id]} />)}
                </Node>
              )}
              {!!design.motions?.length && (
                <Node k="motions" icon={<Clapperboard size={14} />} label={`Motion studies (${design.motions.length})`}>
                  {design.motions.map((m) => <Node key={m.id} k={`m:${m.id}`} icon={<Clapperboard size={12} />} label={m.name} on={sel === `motion:${m.id}`} onClick={() => setSel(`motion:${m.id}`)} bad={!!dr?.errors[m.id] || !!dr?.motions?.[m.id]?.error} warn={dr?.motions?.[m.id]?.warning} />)}
                </Node>
              )}
              {design.occurrences.length > 1 && <Node k="bom" icon={<ClipboardList size={14} />} label="Bill of materials" on={sel === 'bom'} onClick={() => setSel('bom')} />}
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
          {inSketch && !projecting ? (
            <CadCanvas ref={canvas} region={sketchRegion!} result={sketchResult} dispatch={sketchDispatch} width={size.w} height={size.h} interactive
              onStatus={setStatus} onUndo={onUndo} onRedo={onRedo} reference={reference} />
          ) : (
            <Scene3D
              width={size.w} height={size.h} meshes={scene.meshes} lines={scene.lines} planes={scene.planes} view={view3d} onView={setView3d} bounds={still.current?.b}
              navigation="full" display={display} onPick={(h, e) => onPick(h, e.shiftKey)} pickEdges={facePicking && dialog?.kind !== 'sketch' && modPick !== 'faces' && buildPick !== 'faces'}
              onHover={onHover}
              message={shown.state === 'loading' && !scene.meshes.length ? 'Loading the 3-D kernel…' : shown.state === 'none' && shown.notice && !scene.meshes.length ? shown.notice : !scene.meshes.length && !scene.lines.length && !scene.planes.length ? 'Solid → Sketch: pick a plane, draw a profile, then Extrude' : undefined}
            />
          )}
          {!inSketch && (shown.notice || (shown.state !== 'ready' && shown.state !== 'none' && scene.meshes.length > 0)) && (
            <span className={`cadw-kernel${shown.notice ? ' warn' : ''}`} title={shown.notice}>{shown.notice ? (shown.noticeShort === 'Mesh kernel' ? 'Mesh kernel (approximate)' : shown.noticeShort) : shown.state === 'loading' ? 'Loading the 3-D kernel…' : 'Rebuilding…'}</span>
          )}
          {!inSketch && section && (
            <div className="cadw-inspect" onPointerDown={(e) => e.stopPropagation()}>
              <b>Section</b>
              <select value={section.plane} onChange={(e) => setSection({ ...section, plane: e.target.value as 'XY' | 'XZ' | 'YZ' })} aria-label="Section plane">
                <option value="XY">XY plane (horizontal)</option><option value="XZ">XZ plane (front)</option><option value="YZ">YZ plane (side)</option>
              </select>
              <input type="range" min={0} max={1} step={0.005} value={section.at} onChange={(e) => setSection({ ...section, at: Number(e.target.value) })} aria-label="Section position" />
              <span className="cadw-inspect-val">{fmtLen(secRange[0] + (secRange[1] - secRange[0]) * section.at)} {region.unit}</span>
              <button className="btn" onClick={() => setSection({ ...section, flip: !section.flip })} title="Keep the other half">Flip</button>
              <button className="icon-btn" onClick={() => setSection(null)} aria-label="Close section"><X size={14} /></button>
            </div>
          )}
          {!inSketch && explode !== null && (
            <div className={`cadw-inspect cadj-explode${section ? ' below' : ''}`} onPointerDown={(e) => e.stopPropagation()}>
              <b>Explode</b>
              <input type="range" min={0} max={1} step={0.01} value={explode} aria-label="How far exploded" onChange={(e) => setExplode(Number(e.target.value))} />
              <span className="cadw-inspect-val">{Math.round(explode * 100)} %</span>
              <button className="btn" onClick={runAutoExplode} title="Offsets for every occurrence a joint places: along the joint's axis, away from what it hangs on">Auto</button>
              <label className="check" title="Lines from where the parts are assembled"><input type="checkbox" checked={trails} onChange={(e) => setTrails(e.target.checked)} /> Trails</label>
              <button className="icon-btn" onClick={() => setExplode(null)} aria-label="Close the exploded view"><X size={14} /></button>
            </div>
          )}
          {inSketch && projecting && (
            <div className="cadw-inspect" onPointerDown={(e) => e.stopPropagation()}>
              <b>Project</b>
              <span>Click edges or faces of the bodies</span>
              {datumsBefore.length > 0 && (
                <select value="" aria-label="Include construction geometry" onChange={(e) => {
                  const d = datumsBefore.find((x) => x.id === e.target.value);
                  if (d) addSource({ id: cadId('r'), kind: 'datum', datum: d.id, label: d.name }, `Included ${d.name}`);
                }}>
                  <option value="">Include construction…</option>
                  {datumsBefore.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.kind})</option>)}
                </select>
              )}
              <button className="btn" onClick={intersect} title="The section of the bodies with the sketch plane">Intersect</button>
              <button className="btn primary" onClick={endProject}>Done</button>
            </div>
          )}
          {inSketch && !projecting && !ds!.sketch.entities.length && (
            <div className="cadw-empty">
              <b>Sketch on {planeWords(ds!)}</b>
              <span>Line (L), Rectangle (R), Circle (C), Spline (N) … then add relations and dimensions. Grey outlines are the bodies this plane cuts — Project and Intersect bring edges, faces and sections in as reference geometry.</span>
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
                  className={`cadw-tl-item${i >= marker ? ' rolled' : ''}${'suppressed' in it && it.suppressed ? ' off' : ''}${dr?.errors[it.id] ? ' bad' : dr?.warnings?.[it.id] ? ' warn' : ''}${sel === `item:${it.id}` ? ' on' : ''}`}
                  title={`${it.name}${dr?.errors[it.id] ? ` — ${dr.errors[it.id]}` : dr?.warnings?.[it.id] ? ` — ${dr.warnings[it.id]}` : ''} (double-click to edit)`} aria-label={it.name}
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
        {!inSketch && (kernelState || errorCount + warnCount > 0) && <span className={`cadw-dof ${errorCount + warnCount ? 'warn' : ''}`}>{kernelState || `${errorCount + warnCount} problem${errorCount + warnCount > 1 ? 's' : ''}`}</span>}
        <span className="cadw-hint">{hintText}</span>
        {inSketch && <label className="cadw-snaptoggle" title="Show relation glyphs"><input type="checkbox" checked={ui.cadRelations} onChange={(e) => setUi({ cadRelations: e.target.checked })} /> Relations</label>}
        {inSketch && <label className="cadw-snaptoggle" title="Snap to the grid"><Magnet size={13} /> <input type="checkbox" checked={ui.cadGridSnap} onChange={(e) => setUi({ cadGridSnap: e.target.checked })} /> Grid</label>}
        <span className="cadw-units">{u}</span>
      </footer>
    </div>
  );
}
