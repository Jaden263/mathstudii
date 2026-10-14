// The CAD workspace: ribbon, feature tree, viewport (sketch, 3-D or both), properties
// and status bar. Used by the separate CAD window and, on small screens, full-screen
// inside the page.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  MousePointer2, Slash, Square, SquareDashed, Circle as CircleIcon, RotateCcw, Spline, Hexagon, Pill, Dot, Ruler,
  SquareRoundCorner, Scissors, SquareSplitHorizontal, Construction, Trash2, Maximize, Box, PenTool, Columns2,
  FileUp, FileDown, Undo2, Redo2, X, Magnet, ArrowUpFromLine, RotateCw, Weight, Crosshair, ChevronRight, ChevronDown,
  ScanEye, Grid3x3, ListTree, PanelRight,
} from 'lucide-react';
import type { CadRegion } from '../../model/types';
import type { CadResult } from '../../cad/evaluate';
import { MATERIALS, isDimension, removeFromSketch, type CadSketch, type CadFeature, type ConstraintType } from '../../cad/model';
import { CONSTRAINT_TOOLS, solveLocal } from '../../cad/edit';
import type { Vec2 } from '../../cad/profile';
import type { Action } from '../store';
import { useSketchUI, type CadTool } from '../sketch/context';
import { exportFile, pickFile } from '../../platform/files';
import { CadCanvas, sketchBox, type CadCanvasHandle, type CanvasStatus } from './CadCanvas';
import { Cad3DView, STANDARD_VIEWS, type Display } from './Cad3DView';
import { CadProps } from './CadProps';
import { useCadMesh } from './useCadMesh';
import { fmtNum } from './cadRender';

interface Props {
  region: CadRegion;
  result?: CadResult;
  dispatch: (a: Action) => void;
  onClose: () => void;
  /** Separate window: show whether the worksheet is still connected. */
  connected?: boolean;
}

type Tab = 'sketch' | 'constrain' | 'feature' | 'inspect' | 'view' | 'file';

const TABS: { id: Tab; label: string }[] = [
  { id: 'sketch', label: 'Sketch' },
  { id: 'constrain', label: 'Constrain' },
  { id: 'feature', label: 'Features' },
  { id: 'inspect', label: 'Inspect' },
  { id: 'view', label: 'View' },
  { id: 'file', label: 'File' },
];

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
  return { tracked, undo, redo, canUndo: undoStack.current.length > 0, canRedo: redoStack.current.length > 0 };
}

export function CadWorkspace({ region, result, dispatch: rawDispatch, onClose, connected = true }: Props) {
  const { tracked: dispatch, undo: onUndo, redo: onRedo, canUndo, canRedo } = usePartHistory(region, rawDispatch);
  const { ui, setUi } = useSketchUI();
  const [tab, setTab] = useState<Tab>('sketch');
  const [status, setStatus] = useState<CanvasStatus>({ hint: '', msg: '' });
  const [display, setDisplay] = useState<Display>('shadedEdges');
  const [showTree, setShowTree] = useState(true);
  const [showProps, setShowProps] = useState(true);
  const [open, setOpen] = useState<Record<string, boolean>>({ part: true, sketch: true, dims: true });
  const [fileMsg, setFileMsg] = useState('');
  const canvas = useRef<CadCanvasHandle>(null);
  const [viewRef, size] = useSize<HTMLDivElement>();
  const mode = region.mode;
  const split = mode === 'split';
  const sketchW = split ? Math.floor(size.w / 2) : size.w;
  const mesh = useCadMesh(region, result, mode !== '2d');
  const set = (patch: Partial<CadRegion>, history = true) => dispatch({ type: 'update', id: region.id, patch, ...(history ? {} : { history: false as const }) });
  const tool = ui.regionId === region.id ? ui.cadTool : 'select';

  // the workspace owns the selection while it is open
  useEffect(() => {
    if (ui.regionId !== region.id) setUi({ regionId: region.id, selected: [], cadTool: region.sketch.entities.length ? 'select' : 'line' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region.id]);
  // a different viewport layout re-frames the sketch
  const firstMode = useRef(true);
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (!firstMode.current) canvas.current?.fit();
      firstMode.current = false;
      canvas.current?.focus();
    }, 60);
    return () => window.clearTimeout(t);
  }, [mode]);

  const pickTool = (t: CadTool) => {
    setUi({ regionId: region.id, cadTool: t });
    if (mode === '3d') set({ mode: 'split' }, false);
    window.setTimeout(() => canvas.current?.focus(), 0);
  };
  const toolBtn = (t: CadTool, icon: ReactNode, label: string, title: string) => (
    <RibbonButton key={t} icon={icon} label={label} title={title} on={tool === t} onClick={() => pickTool(t)} />
  );
  const cmd = (f: (c: CadCanvasHandle) => void) => {
    if (canvas.current) f(canvas.current);
    canvas.current?.focus();
  };

  const setFeature = (feature: CadFeature) => set({ feature });
  const f = region.feature;
  const lines = region.sketch.entities.filter((e) => e.type === 'line');
  const material = MATERIALS.find((m) => m.density === region.density.trim());

  // ------------------------------------------------------------ files

  const fileBase = (region.name.trim() || 'part').replace(/[^\w.-]+/g, '_');
  const importDxf = async () => {
    const file = await pickFile('.dxf');
    if (!file) return;
    try {
      const { dxfToSketch } = await import('../../cad/dxf');
      const { sketch, unit, warnings } = dxfToSketch(await file.text());
      const sk = region.sketch;
      const merged: CadSketch = { points: [...sk.points, ...sketch.points], entities: [...sk.entities, ...sketch.entities], constraints: [...sk.constraints, ...sketch.constraints] };
      set({ sketch: merged, ...(!sk.entities.length && unit ? { unit } : {}), viewW: undefined });
      setFileMsg(`Imported ${sketch.entities.length} entities from ${file.name}${warnings.length ? ` · ${warnings.join('; ')}` : ''}`);
      window.setTimeout(() => canvas.current?.fit(), 50);
    } catch (err) {
      setFileMsg(`Could not read ${file.name}: ${(err as Error).message}`);
    }
  };
  const exportDxf = async () => {
    const { sketchToDxf } = await import('../../cad/dxf');
    await exportFile(`${fileBase}.dxf`, sketchToDxf(region.sketch, region.unit), 'application/dxf');
  };
  const exportStl = async () => {
    if (!mesh) return setFileMsg('Add an extrude or revolve feature first');
    const { meshToStl } = await import('../../cad/stl');
    await exportFile(`${fileBase}.stl`, meshToStl(mesh, fileBase), 'model/stl');
  };

  // ------------------------------------------------------------ keyboard (when the canvas is not focused)

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) onRedo(); else onUndo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); onRedo(); }
  }, [onUndo, onRedo]);
  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  // ------------------------------------------------------------ feature tree

  const sk = region.sketch;
  const dims = sk.constraints.filter((c) => isDimension(c.type));
  const geomCount = sk.entities.filter((e) => e.type !== 'point' || !e.construction).length;
  const consCount = sk.constraints.length - dims.length;
  const sel = ui.regionId === region.id ? ui.selected : [];
  const selectIds = (ids: string[]) => setUi({ regionId: region.id, selected: ids });
  const dofBadge = !result ? '…' : !result.ok ? '⚠' : result.dof === 0 ? '✓' : `${result.dof}`;
  const featureLabel = f.type === 'extrude' ? `Extrude · ${f.depth}${f.symmetric ? ' (mid-plane)' : ''}` : f.type === 'revolve' ? `Revolve · ${f.angle}${/[a-z°]/i.test(f.angle) ? '' : '°'}` : 'No 3-D feature';
  const deleteConstraint = (id: string) => set({ sketch: solveLocal(removeFromSketch(sk, new Set([id])), region.unit, result?.values) });
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const Node = ({ k, icon, label, badge, children, onClick, active }: { k: string; icon: ReactNode; label: string; badge?: string; children?: ReactNode; onClick?: () => void; active?: boolean }) => (
    <li>
      <div className={`cadw-node${active ? ' on' : ''}`}>
        {children ? <button className="cadw-twisty" onClick={() => toggle(k)} aria-label={open[k] ? 'Collapse' : 'Expand'}>{open[k] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button> : <span className="cadw-twisty" />}
        <button className="cadw-node-label" onClick={onClick ?? (() => toggle(k))}>{icon}<span>{label}</span>{badge && <em className={`cadw-badge ${badge === '✓' ? 'ok' : badge === '⚠' ? 'bad' : ''}`}>{badge}</em>}</button>
      </div>
      {children && open[k] && <ul>{children}</ul>}
    </li>
  );

  // ------------------------------------------------------------ status

  const st = (() => {
    if (!result) return { cls: '', text: 'Solving…' };
    if (result.error) return { cls: 'bad', text: result.error };
    if (!result.ok) return { cls: 'bad', text: `Over-defined: ${result.conflicting.length} conflicting` };
    const errs = Object.keys(result.dimErrors).length;
    if (errs) return { cls: 'warn', text: `${errs} dimension error${errs > 1 ? 's' : ''}` };
    return result.dof === 0 ? { cls: 'ok', text: 'Fully defined' } : { cls: 'free', text: `Under-defined · ${result.dof} DOF` };
  })();
  const c = status.cursor;
  const view3d = region.view3dW ?? { ...STANDARD_VIEWS.iso, zoom: 1, pan: { x: 0, y: 0 } };
  const setView3d = (v: Partial<NonNullable<CadRegion['view3dW']>>) => set({ view3dW: { ...view3d, ...v } }, false);
  const empty = !sk.entities.length;
  void sketchBox;
  const fitAll = () => {
    if (mode !== '3d') canvas.current?.fit();
    if (mode !== '2d') setView3d({ zoom: 1, pan: { x: 0, y: 0 } });
  };

  return (
    <div className="cadw" onPointerDown={(e) => e.stopPropagation()}>
      <header className="cadw-head">
        <div className="cadw-brand"><Box size={18} /> <b>mathstudii CAD</b></div>
        <input className="cadw-name" value={region.name} placeholder="Part name (variable)" aria-label="Part name"
          title="The worksheet uses this name: part.A, part.m, part.d1 …" onChange={(e) => set({ name: e.target.value.trim() })} />
        <select value={region.unit} onChange={(e) => set({ unit: e.target.value as CadRegion['unit'] })} aria-label="Units" title="Sketch units">
          {['mm', 'cm', 'm', 'in'].map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
        {!connected && <span className="cadw-disconnected">Worksheet not connected — edits are not saved</span>}
        <span className="cadw-spacer" />
        <button className="icon-btn" onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo"><Undo2 size={17} /></button>
        <button className="icon-btn" onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)" aria-label="Redo"><Redo2 size={17} /></button>
        <button className={`icon-btn${showTree ? ' on' : ''}`} onClick={() => setShowTree(!showTree)} title="Feature tree" aria-label="Feature tree"><ListTree size={17} /></button>
        <button className={`icon-btn${showProps ? ' on' : ''}`} onClick={() => setShowProps(!showProps)} title="Properties" aria-label="Properties"><PanelRight size={17} /></button>
        <button className="cadw-close" onClick={onClose} title="Close the CAD window (the part stays in the worksheet)"><X size={16} /> Close</button>
      </header>

      <nav className="cadw-tabs" role="tablist">
        {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </nav>
      <div className="cadw-ribbon" role="toolbar">
        {tab === 'sketch' && (
          <>
            <Group label="Select">
              {toolBtn('select', <MousePointer2 size={20} />, 'Select', 'Select and drag (S)')}
            </Group>
            <Group label="Draw">
              {toolBtn('line', <Slash size={20} />, 'Line', 'Line chain (L) — type a length while drawing')}
              {toolBtn('rect', <Square size={20} />, 'Rectangle', 'Corner rectangle (R)')}
              {toolBtn('crect', <SquareDashed size={20} />, 'Centre rect', 'Centre rectangle (Shift+R)')}
              {toolBtn('circle', <CircleIcon size={20} />, 'Circle', 'Circle (C)')}
              {toolBtn('arc', <RotateCcw size={20} />, 'Arc', 'Centre arc (A)')}
              {toolBtn('arc3', <Spline size={20} />, '3-pt arc', '3-point arc (Shift+A)')}
              {toolBtn('polygon', <Hexagon size={20} />, 'Polygon', 'Regular polygon (G)')}
              {toolBtn('slot', <Pill size={20} />, 'Slot', 'Straight slot (O)')}
              {toolBtn('point', <Dot size={20} />, 'Point', 'Point (P)')}
            </Group>
            <Group label="Modify">
              {toolBtn('fillet', <SquareRoundCorner size={20} />, 'Fillet', 'Sketch fillet (I)')}
              {toolBtn('trim', <Scissors size={20} />, 'Trim', 'Trim (T)')}
              {toolBtn('mirror', <SquareSplitHorizontal size={20} />, 'Mirror', 'Mirror the selection about a line (M)')}
              <RibbonButton icon={<Construction size={20} />} label="Construction" title="Construction geometry (X)" on={ui.cadConstruction} onClick={() => cmd((cv) => cv.toggleConstruction())} />
              <RibbonButton icon={<Trash2 size={20} />} label="Delete" title="Delete the selection (Del)" disabled={!sel.length} onClick={() => cmd((cv) => cv.deleteSelected())} />
            </Group>
            <Group label="Dimension">
              {toolBtn('dim', <Ruler size={20} />, 'Dimension', 'Smart dimension (D)')}
            </Group>
            <Group label="Options">
              <div className="cadw-options">
                {tool === 'polygon' && <label>Sides <input type="number" min={3} max={64} value={ui.cadSides} onChange={(e) => setUi({ cadSides: Math.max(3, Math.min(64, Number(e.target.value) || 6)) })} /></label>}
                {tool === 'fillet' && <label>Radius <input type="number" min={0} step="any" value={ui.cadFillet} onChange={(e) => setUi({ cadFillet: Math.max(0, Number(e.target.value)) })} /> {region.unit}</label>}
                {tool === 'dim' && (
                  <label>Type <select value={ui.cadDimKind} onChange={(e) => setUi({ cadDimKind: e.target.value as typeof ui.cadDimKind })}>
                    <option value="smart">Smart</option><option value="horizontal">Horizontal</option><option value="vertical">Vertical</option>
                  </select></label>
                )}
                <label title="Snap to the grid"><input type="checkbox" checked={ui.cadGridSnap} onChange={(e) => setUi({ cadGridSnap: e.target.checked })} /> Grid snap</label>
              </div>
            </Group>
          </>
        )}
        {tab === 'constrain' && (
          <>
            <Group label="Relations">
              {CONSTRAINT_TOOLS.map((t) => (
                <RibbonButton key={t.type} icon={<b className="cadw-glyph">{t.glyph}</b>} label={t.label} title={`${t.help}${t.key ? ` (${t.key.toUpperCase()})` : ''}`}
                  onClick={() => cmd((cv) => cv.applyConstraint(t.type as ConstraintType))} />
              ))}
            </Group>
            <Group label="Dimension">
              {toolBtn('dim', <Ruler size={20} />, 'Dimension', 'Smart dimension (D)')}
            </Group>
            <Group label="Edit">
              <RibbonButton icon={<Trash2 size={20} />} label="Delete" title="Delete the selected constraint or geometry (Del)" disabled={!sel.length} onClick={() => cmd((cv) => cv.deleteSelected())} />
            </Group>
          </>
        )}
        {tab === 'feature' && (
          <>
            <Group label="Solid">
              <RibbonButton icon={<ArrowUpFromLine size={20} />} label="Extrude" title="Extrude the profile" on={f.type === 'extrude'}
                onClick={() => { setFeature({ type: 'extrude', depth: f.type === 'extrude' ? f.depth : '10' }); if (mode === '2d') set({ mode: 'split' }, false); }} />
              <RibbonButton icon={<RotateCw size={20} />} label="Revolve" title="Revolve the profile about an axis" on={f.type === 'revolve'}
                onClick={() => { setFeature({ type: 'revolve', axis: f.type === 'revolve' ? f.axis : 'y', angle: f.type === 'revolve' ? f.angle : '360' }); if (mode === '2d') set({ mode: 'split' }, false); }} />
              <RibbonButton icon={<PenTool size={20} />} label="Sketch only" title="No 3-D feature" on={f.type === 'none'} onClick={() => setFeature({ type: 'none' })} />
            </Group>
            <Group label="Parameters">
              <div className="cadw-options">
                {f.type === 'extrude' && (
                  <>
                    <label>Depth <input className="mono" defaultValue={f.depth} key={`d${f.depth}`} onBlur={(e) => setFeature({ ...f, depth: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} /></label>
                    <label><input type="checkbox" checked={!!f.symmetric} onChange={(e) => setFeature({ ...f, symmetric: e.target.checked || undefined })} /> Mid-plane</label>
                  </>
                )}
                {f.type === 'revolve' && (
                  <>
                    <label>Axis <select value={f.axis} onChange={(e) => setFeature({ ...f, axis: e.target.value })}>
                      <option value="y">Y axis</option><option value="x">X axis</option>
                      {lines.map((l, i) => <option key={l.id} value={l.id}>Line {i + 1}{l.construction ? ' (construction)' : ''}</option>)}
                    </select></label>
                    <label>Angle <input className="mono" defaultValue={f.angle} key={`a${f.angle}`} onBlur={(e) => setFeature({ ...f, angle: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} /></label>
                  </>
                )}
                {f.type === 'none' && <span className="cadw-muted">Pick Extrude or Revolve to make a solid</span>}
              </div>
            </Group>
            <Group label="Material">
              <div className="cadw-options">
                <label><Weight size={14} /> <select value={material?.density ?? (region.density.trim() ? 'custom' : 'none')} onChange={(e) => e.target.value !== 'custom' && set({ density: e.target.value === 'none' ? '' : e.target.value })}>
                  {MATERIALS.map((m) => <option key={m.name} value={m.density}>{m.name}</option>)}
                  <option value="custom">Custom</option><option value="none">No mass</option>
                </select></label>
                <label>ρ <input className="mono" defaultValue={region.density} key={`r${region.density}`} onBlur={(e) => set({ density: e.target.value.trim() })} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} /></label>
              </div>
            </Group>
          </>
        )}
        {tab === 'inspect' && (
          <>
            <Group label="Measure">
              {toolBtn('measure', <Ruler size={20} />, 'Measure', 'Measure distances, angles, radii (Q)')}
            </Group>
            <Group label="Mass properties">
              <div className="cadw-readout">
                {result?.section && <span>A = <b>{fmtNum(result.section.A)}</b> {region.unit}²</span>}
                {result?.section && <span>I<sub>x</sub> = <b>{+result.section.Ix.toPrecision(5)}</b> {region.unit}⁴</span>}
                {result?.mass && <span>V = <b>{+result.mass.V.toPrecision(5)}</b> {region.unit}³</span>}
                {result?.mass?.m !== undefined && <span>m = <b>{+result.mass.m.toPrecision(4)}</b> kg</span>}
                {!result?.section && <span className="cadw-muted">No closed profile yet</span>}
              </div>
            </Group>
          </>
        )}
        {tab === 'view' && (
          <>
            <Group label="Viewport">
              <RibbonButton icon={<PenTool size={20} />} label="Sketch" title="2-D sketch" on={mode === '2d'} onClick={() => set({ mode: '2d' }, false)} />
              <RibbonButton icon={<Columns2 size={20} />} label="Split" title="Sketch and 3-D side by side" on={split} onClick={() => set({ mode: 'split' }, false)} />
              <RibbonButton icon={<Box size={20} />} label="3-D" title="3-D model" on={mode === '3d'} onClick={() => set({ mode: '3d' }, false)} />
              <RibbonButton icon={<Maximize size={20} />} label="Fit" title="Zoom to fit (F)" onClick={fitAll} />
            </Group>
            <Group label="Standard views (3-D)">
              {(['front', 'top', 'right', 'iso'] as const).map((v) => (
                <RibbonButton key={v} icon={<ScanEye size={20} />} label={v[0].toUpperCase() + v.slice(1)} title={`${v} view`} disabled={mode === '2d'}
                  onClick={() => setView3d({ ...STANDARD_VIEWS[v], zoom: 1, pan: { x: 0, y: 0 } })} />
              ))}
            </Group>
            <Group label="Display">
              <div className="cadw-options">
                <label>3-D <select value={display} onChange={(e) => setDisplay(e.target.value as Display)}>
                  <option value="shadedEdges">Shaded with edges</option><option value="shaded">Shaded</option><option value="wireframe">Wireframe</option>
                </select></label>
                <label><input type="checkbox" checked={ui.cadGridSnap} onChange={(e) => setUi({ cadGridSnap: e.target.checked })} /> <Grid3x3 size={14} /> Grid snap</label>
                <label><input type="checkbox" checked={ui.cadRelations} onChange={(e) => setUi({ cadRelations: e.target.checked })} /> Show relations</label>
              </div>
            </Group>
          </>
        )}
        {tab === 'file' && (
          <>
            <Group label="Import">
              <RibbonButton icon={<FileUp size={20} />} label="DXF" title="Import lines, arcs, circles and polylines from a DXF file" onClick={importDxf} />
            </Group>
            <Group label="Export">
              <RibbonButton icon={<FileDown size={20} />} label="DXF" title="Export the sketch as DXF (for other CAD and laser/waterjet cutting)" onClick={exportDxf} />
              <RibbonButton icon={<FileDown size={20} />} label="STL" title="Export the solid as STL (3-D printing)" disabled={!mesh} onClick={exportStl} />
            </Group>
            {fileMsg && <div className="cadw-filemsg">{fileMsg}</div>}
          </>
        )}
      </div>

      <div className="cadw-main">
        {showTree && (
          <aside className="cadw-tree" aria-label="Feature tree">
            <ul>
              <Node k="part" icon={<Box size={14} />} label={region.name || 'Part'} onClick={() => selectIds([])}>
                <Node k="origin" icon={<Crosshair size={14} />} label="Origin">
                  <li><div className="cadw-node leaf"><span className="cadw-twisty" /><span className="cadw-axisx">━</span> X axis</div></li>
                  <li><div className="cadw-node leaf"><span className="cadw-twisty" /><span className="cadw-axisy">┃</span> Y axis</div></li>
                </Node>
                <Node k="sketch" icon={<PenTool size={14} />} label="Sketch" badge={dofBadge} onClick={() => { selectIds([]); if (mode === '3d') set({ mode: 'split' }, false); }}>
                  <Node k="geom" icon={<Slash size={13} />} label={`Geometry (${geomCount})`} onClick={() => selectIds(sk.entities.map((e) => e.id))} />
                  <Node k="cons" icon={<b className="cadw-glyph sm">⊥</b>} label={`Relations (${consCount})`}>
                    {sk.constraints.filter((k) => !isDimension(k.type)).map((k) => (
                      <li key={k.id}>
                        <div className={`cadw-node leaf${sel.includes(k.id) ? ' on' : ''}${result?.conflicting.includes(k.id) ? ' bad' : result?.redundant.includes(k.id) ? ' warn' : ''}`}>
                          <span className="cadw-twisty" />
                          <button className="cadw-node-label" onClick={() => selectIds([k.id])}>{CONSTRAINT_TOOLS.find((t) => t.type === k.type)?.label ?? k.type.replace(/([A-Z])/g, ' $1').toLowerCase()}</button>
                          <button className="cadw-del" onClick={() => deleteConstraint(k.id)} aria-label="Delete"><Trash2 size={12} /></button>
                        </div>
                      </li>
                    ))}
                  </Node>
                  <Node k="dims" icon={<Ruler size={13} />} label={`Dimensions (${dims.length})`}>
                    {dims.map((k) => (
                      <li key={k.id}>
                        <div className={`cadw-node leaf${sel.includes(k.id) ? ' on' : ''}${result?.dimErrors[k.id] ? ' bad' : ''}`}>
                          <span className="cadw-twisty" />
                          <button className="cadw-node-label" onClick={() => selectIds([k.id])}>
                            <code>{k.name ?? '·'}</code> = {k.value}{k.driving === false ? ' (ref)' : ''}
                          </button>
                          <button className="cadw-del" onClick={() => deleteConstraint(k.id)} aria-label="Delete"><Trash2 size={12} /></button>
                        </div>
                      </li>
                    ))}
                  </Node>
                </Node>
                <Node k="feature" icon={f.type === 'revolve' ? <RotateCw size={14} /> : <ArrowUpFromLine size={14} />} label={featureLabel} onClick={() => setTab('feature')} active={tab === 'feature'} />
                <Node k="material" icon={<Weight size={14} />} label={`Material: ${material?.name ?? (region.density.trim() ? region.density : 'none')}`} onClick={() => setTab('feature')} />
              </Node>
            </ul>
            {result?.mass && (
              <div className="cadw-summary">
                <div>V = {+result.mass.V.toPrecision(5)} {region.unit}³</div>
                {result.mass.m !== undefined && <div>m = {+result.mass.m.toPrecision(4)} kg</div>}
              </div>
            )}
          </aside>
        )}

        <section className="cadw-view" ref={viewRef}>
          {mode !== '3d' && (
            <CadCanvas ref={canvas} region={region} result={result} dispatch={dispatch} width={sketchW} height={size.h} interactive
              onStatus={setStatus} onUndo={onUndo} onRedo={onRedo} />
          )}
          {mode !== '2d' && (
            <div className="cadw-3d" style={{ width: size.w - (split ? sketchW : 0), height: size.h }}>
              <Cad3DView
                mesh={mesh} width={size.w - (split ? sketchW : 0)} height={size.h} navigation="full" display={display}
                yaw={view3d.yaw} pitch={view3d.pitch} zoom={view3d.zoom} pan={view3d.pan}
                onView={(v) => setView3d({ yaw: v.yaw, pitch: v.pitch, zoom: v.zoom ?? 1, pan: v.pan ?? { x: 0, y: 0 } })}
                unitLabel={region.unit}
                message={f.type === 'none' ? 'Features → Extrude or Revolve builds the solid' : result?.featureError}
              />
              <div className="cadw-viewcube">
                {(['front', 'top', 'right', 'iso'] as const).map((v) => (
                  <button key={v} onClick={() => setView3d({ ...STANDARD_VIEWS[v], zoom: 1, pan: { x: 0, y: 0 } })} title={`${v} view`}>{v[0].toUpperCase() + v.slice(1)}</button>
                ))}
              </div>
            </div>
          )}
          {empty && mode !== '3d' && (
            <div className="cadw-empty">
              <b>Start sketching</b>
              <span>Line (L), Rectangle (R), Circle (C) … then add relations and dimensions. Dimensions take worksheet expressions like <code>b/2</code>.</span>
            </div>
          )}
        </section>

        {showProps && (
          <aside className="cadw-props" aria-label="Properties">
            <CadProps region={region} result={result} dispatch={dispatch} />
          </aside>
        )}
      </div>

      <footer className="cadw-status">
        <span className="cadw-coords">{c ? <>X <b>{fmtNum(c.x)}</b> Y <b>{fmtNum(c.y)}</b> {region.unit}</> : ' '}</span>
        <span className={`cadw-dof ${st.cls}`}>{st.text}</span>
        <span className="cadw-hint">{status.msg || status.hint}</span>
        <label className="cadw-snaptoggle" title="Show relation glyphs"><input type="checkbox" checked={ui.cadRelations} onChange={(e) => setUi({ cadRelations: e.target.checked })} /> Relations</label>
        <label className="cadw-snaptoggle" title="Snap to the grid"><Magnet size={13} /> <input type="checkbox" checked={ui.cadGridSnap} onChange={(e) => setUi({ cadGridSnap: e.target.checked })} /> Grid</label>
        <span className="cadw-units">{region.unit}</span>
      </footer>
    </div>
  );
}

export type { Vec2 };
