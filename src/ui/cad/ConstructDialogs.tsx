// Dialogs of the sweep, coil and thread features and of construction planes, axes and
// points. Faces, edges and vertices are picked in the 3-D view: a field's Pick button makes
// the next click fill it (CadWorkspace turns the click into a reference); a thread's faces
// and a sweep's path edges are clicked in and out directly. Every size is a worksheet
// expression.
import { Crosshair } from 'lucide-react';
import type { CadResult } from '../../cad/evaluate';
import {
  isSketch, itemName,
  type AxisDef, type CadComponent, type CadDesign, type CoilFeature, type ConstructItem, type DesignFeature, type DesignItem, type PlaneDef, type PointDef,
  type SweepFeature, type ThreadFeature,
} from '../../cad/design';
import { refWords, type TopoRef } from '../../cad/topology';
import { Checks, Pick, axisOptions, bodyOptions, constructBefore, planeOptions } from './FeatureDialogs';
import { Expr, Picked } from './ModifyDialogs';
import { sketchRegions } from './useDesign';
import { ThreadTable, sizeChoices } from './threadParts';

/** What a field takes from a click in the view. */
export type PickKind =
  /** a flat face, an origin or construction plane */
  | 'plane'
  /** a straight edge, a circle or a cylinder (its axis) */
  | 'axis'
  /** a vertex, or a circle (its centre) */
  | 'point'
  /** a vertex only */
  | 'vertex'
  /** an edge */
  | 'curve'
  /** a circle or a sphere (its centre) */
  | 'centre'
  /** a cylinder or a cone */
  | 'cylinder'
  /** any face */
  | 'face';

/** A field of one of these dialogs waiting for a click. */
export interface FieldPick {
  field: string;
  kind: PickKind;
}

export const isBuildFeature = (f: DesignItem): f is SweepFeature | CoilFeature | ThreadFeature | ConstructItem =>
  f.kind === 'sweep' || f.kind === 'coil' || f.kind === 'thread' || f.kind === 'plane' || f.kind === 'axis' || f.kind === 'point';

/** The item with a picked value put into a field (construction items keep their picks in `def`; a plane through points collects three). */
export function withPick(f: SweepFeature | CoilFeature | ThreadFeature | ConstructItem, field: string, value: string | TopoRef): Partial<DesignItem> {
  if (f.kind === 'plane' || f.kind === 'axis' || f.kind === 'point') {
    const def = f.def as unknown as Record<string, unknown>;
    if (field === 'points') {
      const pts = [...((def.points as unknown[]) ?? [])];
      return { def: { ...f.def, points: [...(pts.length >= 3 ? [] : pts), value] } } as Partial<DesignItem>;
    }
    return { def: { ...f.def, [field]: value } } as Partial<DesignItem>;
  }
  return { [field]: value } as Partial<DesignItem>;
}

interface Props<F> {
  design: CadDesign;
  comp: CadComponent;
  feature: F;
  result?: CadResult;
  unit: string;
  /** The field waiting for a click. */
  pick?: FieldPick;
  onPick: (p: FieldPick | undefined) => void;
  onChange: (patch: Partial<DesignItem>, coalesce?: string) => void;
}

const OPS: [string, string][] = [['new', 'New body'], ['join', 'Join'], ['cut', 'Cut'], ['intersect', 'Intersect']];

/** Words for what a field holds: a reference picked in the view, or one of the options. */
function holds(design: CadDesign, v: unknown, options: [string, string][]): string {
  if (v === undefined || v === '') return '';
  if (typeof v === 'string') return options.find(([k]) => k === v)?.[1] ?? itemName(design, v) ?? v;
  return refWords(v as TopoRef, (id) => itemName(design, id)).replace(/^the /, '');
}

/**
 * A field filled from a list or by a click in the view: a select of the choices (and
 * what was picked, when it was picked), and the Pick button.
 */
function PickOne({ label, value, options, design, field, kind, pick, onPick, onChange, none }: {
  label: string; value: unknown; options: [string, string][]; design: CadDesign; field: string; kind: PickKind;
  pick?: FieldPick; onPick: (p: FieldPick | undefined) => void; onChange: (v: string | undefined) => void; none?: string;
}) {
  const picked = value !== undefined && typeof value !== 'string';
  const listed = typeof value === 'string' && options.some(([k]) => k === value);
  const key = value === undefined || value === '' ? '' : listed ? (value as string) : 'picked';
  const waiting = pick?.field === field;
  const opts: [string, string][] = [...(none !== undefined ? [['', none] as [string, string]] : []), ...options];
  if (key === 'picked') opts.push(['picked', `${picked ? 'Picked' : 'Missing'}: ${holds(design, value, options)}`]);
  return (
    <div className="cadd-pickfield">
      <Pick label={label} value={key} options={opts} onChange={(k) => k !== 'picked' && onChange(k || undefined)} />
      <button className={`btn${waiting ? ' primary' : ''}`} onClick={() => onPick(waiting ? undefined : { field, kind })} title="Click it in the view">
        <Crosshair size={13} /> {waiting ? 'Click in the view…' : 'Pick'}
      </button>
    </div>
  );
}

/** Sketch points and construction points before an item, as choices. */
function pointOptions(comp: CadComponent, item: DesignItem): [string, string][] {
  const upto = comp.items.indexOf(item);
  const before = comp.items.slice(0, upto < 0 ? undefined : upto);
  const out: [string, string][] = before.filter((i): i is ConstructItem => i.kind === 'point').map((p) => [p.id, p.name]);
  for (const s of before.filter(isSketch)) {
    s.sketch.entities.forEach((e, i) => {
      if (e.type === 'point') out.push([`${s.id}/${e.p}`, `${s.name} · point ${i + 1}`]);
      if (e.type === 'circle' || e.type === 'arc') out.push([`${s.id}/${e.c}`, `${s.name} · centre of ${e.type} ${i + 1}`]);
    });
  }
  return out;
}

/** Lines, arcs and circles of the sketches before an item, as choices. */
function curveOptions(comp: CadComponent, item: DesignItem, only?: 'circles'): [string, string][] {
  const upto = comp.items.indexOf(item);
  const out: [string, string][] = [];
  for (const s of comp.items.slice(0, upto < 0 ? undefined : upto).filter(isSketch)) {
    s.sketch.entities.forEach((e, i) => {
      if (e.type === 'point' || (only && e.type === 'line')) return;
      out.push([`${s.id}/${e.id}`, `${s.name} · ${e.type} ${i + 1}${e.construction ? ' (construction)' : ''}`]);
    });
  }
  return out;
}

/** The bodies a join, cut or intersect works on (none ticked: every body it meets); clicking a body in the view does the same. */
function Targets({ comp, result, value, onChange }: { comp: CadComponent; result?: CadResult; value?: string[]; onChange: (v: string[] | undefined) => void }) {
  return <Checks label="Bodies" items={bodyOptions(comp, result)} value={value} onChange={onChange} empty="No bodies yet" allLabel="Automatic" />;
}

// ------------------------------------------------------------ sweep

export function SweepFields({ comp, feature: f, result, onChange }: Props<SweepFeature>) {
  const sketches = comp.items.filter(isSketch);
  const withProfiles = sketches.filter((s) => sketchRegions(s, result).length > 0);
  const coils = comp.items.filter((i): i is CoilFeature => i.kind === 'coil' && comp.items.indexOf(i) < comp.items.indexOf(f));
  const pathSketch = f.path.kind === 'sketch' ? sketches.find((s) => s.id === (f.path as { sketch: string }).sketch) : undefined;
  const curves = pathSketch?.sketch.entities.filter((e) => e.type !== 'point') ?? [];
  const path = f.path;
  return (
    <>
      <Pick label="Profile sketch" value={f.sketch} options={withProfiles.map((s) => [s.id, s.name])} onChange={(sketch) => onChange({ sketch, profile: undefined } as Partial<DesignItem>)} />
      <p className="hint">{f.profile ? 'One profile picked (click another in the view to change it).' : 'Its first profile — click a profile in the view to pick another.'}</p>
      <Pick label="Path" value={path.kind} options={[['sketch', 'Sketch curves'], ['edges', 'Edges of a body'], ['coil', 'Helix of a coil']]}
        onChange={(kind) => onChange({ path: kind === 'sketch' ? { kind, sketch: sketches.find((s) => s.id !== f.sketch)?.id ?? f.sketch } : kind === 'edges' ? { kind, edges: [] } : { kind, coil: coils[coils.length - 1]?.id ?? '' } } as Partial<DesignItem>)} />
      {path.kind === 'sketch' && (
        <>
          <Pick label="Path sketch" value={path.sketch} options={sketches.map((s) => [s.id, s.name])} onChange={(sketch) => onChange({ path: { kind: 'sketch', sketch } } as Partial<DesignItem>)} />
          <div className="field">
            <span>Curves</span>
            <div className="cadd-checks">
              <label className="check"><input type="checkbox" checked={!path.curves?.length} onChange={() => onChange({ path: { ...path, curves: undefined } } as Partial<DesignItem>)} /> All of the sketch (not construction)</label>
              {curves.map((e, i) => (
                <label key={e.id} className="check">
                  <input type="checkbox" checked={!!path.curves?.includes(e.id)} onChange={(ev) => {
                    const next = ev.target.checked ? [...(path.curves ?? []), e.id] : (path.curves ?? []).filter((x) => x !== e.id);
                    onChange({ path: { ...path, curves: next.length ? next : undefined } } as Partial<DesignItem>);
                  }} /> {e.type} {i + 1}{e.construction ? ' (construction)' : ''}
                </label>
              ))}
            </div>
            <p className="hint">Lines, arcs or a circle joined end to end; the sweep starts at the end nearer the profile.</p>
          </div>
        </>
      )}
      {path.kind === 'edges' && (
        <>
          <Picked label="Path edges" n={path.edges.length} what={['edge', 'edges']} onClear={() => onChange({ path: { kind: 'edges', edges: [] } } as Partial<DesignItem>)} />
          <p className="hint">Click edges of a body in the view (end to end); click one again to take it out.</p>
        </>
      )}
      {path.kind === 'coil' && (
        <Pick label="Coil" value={path.coil} options={[['', '— pick —'], ...coils.map((c) => [c.id, c.name] as [string, string])]} onChange={(coil) => onChange({ path: { kind: 'coil', coil } } as Partial<DesignItem>)} />
      )}
      <Pick label="Orientation" value={f.orientation ?? 'perpendicular'} options={[['perpendicular', 'Perpendicular (turns with the path)'], ['parallel', 'Parallel (keeps its orientation)']]}
        onChange={(orientation) => onChange({ orientation: orientation === 'perpendicular' ? undefined : orientation } as Partial<DesignItem>)} />
      <div className="row2">
        <Expr label="Twist angle" value={f.twist ?? ''} placeholder="0" onChange={(twist) => onChange({ twist: twist || undefined } as Partial<DesignItem>, 'twist')} />
        <Expr label="End scale (taper)" value={f.scale ?? ''} placeholder="1" hint="Size of the profile at the end of the path as a factor of its size at the start" onChange={(scale) => onChange({ scale: scale || undefined } as Partial<DesignItem>, 'scale')} />
      </div>
      <Pick label="Operation" value={f.op} options={OPS} onChange={(op) => onChange({ op } as Partial<DesignItem>)} />
      {f.op !== 'new' && <Targets comp={comp} result={result} value={f.targets} onChange={(targets) => onChange({ targets } as Partial<DesignItem>)} />}
    </>
  );
}

// ------------------------------------------------------------ coil

export function CoilFields({ design, comp, feature: f, result, pick, onPick, onChange }: Props<CoilFeature>) {
  const set = (patch: Partial<CoilFeature>, key?: string) => onChange(patch as Partial<DesignItem>, key);
  return (
    <>
      <PickOne label="Plane it stands on" value={f.plane} options={planeOptions(comp, f)} design={design} field="plane" kind="plane" pick={pick} onPick={onPick} onChange={(plane) => plane && set({ plane })} />
      <PickOne label="Centre" value={f.centre} options={pointOptions(comp, f)} none="The plane’s origin (a face: its centre)" design={design} field="centre" kind="point" pick={pick} onPick={onPick} onChange={(centre) => set({ centre })} />
      <label className="check"><input type="checkbox" checked={!!f.flip} onChange={(e) => set({ flip: e.target.checked || undefined })} /> Grow the other way</label>
      <Pick label="Type" value={f.mode} options={[['revs-height', 'Revolutions and height'], ['revs-pitch', 'Revolutions and pitch'], ['height-pitch', 'Height and pitch']]} onChange={(mode) => set({ mode })} />
      <div className="row2">
        <Expr label="Diameter" value={f.d} onChange={(d) => set({ d }, 'd')} />
        {f.mode !== 'height-pitch' && <Expr label="Revolutions" value={f.revs ?? ''} placeholder="5" onChange={(revs) => set({ revs }, 'revs')} />}
        {f.mode !== 'revs-pitch' && <Expr label="Height" value={f.height ?? ''} placeholder="50" onChange={(height) => set({ height }, 'height')} />}
        {f.mode !== 'revs-height' && <Expr label="Pitch" value={f.pitch ?? ''} placeholder="5" onChange={(pitch) => set({ pitch }, 'pitch')} />}
      </div>
      <Pick label="Rotation" value={f.hand ?? 'right'} options={[['right', 'Right-hand (anticlockwise seen from the top)'], ['left', 'Left-hand (clockwise)']]} onChange={(hand) => set({ hand: hand === 'right' ? undefined : hand })} />
      <div className="row2">
        <Pick label="Section" value={f.section} options={[['circle', 'Circular'], ['square', 'Square'], ['triangle-out', 'Triangular (external)'], ['triangle-in', 'Triangular (internal)']]} onChange={(section) => set({ section })} />
        <Expr label={f.section === 'circle' ? 'Section diameter' : 'Section side'} value={f.size} onChange={(size) => set({ size }, 'size')} />
      </div>
      <Pick label="Section position" value={f.position ?? 'center'} options={[['center', 'On centre'], ['inside', 'Inside'], ['outside', 'Outside']]} onChange={(position) => set({ position: position === 'center' ? undefined : position })} />
      <label className="check" title="Only the helix: a path for a sweep"><input type="checkbox" checked={!!f.pathOnly} onChange={(e) => set({ pathOnly: e.target.checked || undefined })} /> Path only (for a sweep, no body)</label>
      {!f.pathOnly && <Pick label="Operation" value={f.op} options={OPS} onChange={(op) => set({ op: op as CoilFeature['op'] })} />}
      {!f.pathOnly && f.op !== 'new' && <Targets comp={comp} result={result} value={f.targets} onChange={(targets) => set({ targets })} />}
      <p className="hint">The section stands square to the helix; turns that would overlap are refused.</p>
    </>
  );
}

// ------------------------------------------------------------ thread

export function ThreadFields({ feature: f, onChange }: Props<ThreadFeature>) {
  const set = (patch: Partial<ThreadFeature>, key?: string) => onChange(patch as Partial<DesignItem>, key);
  return (
    <>
      <Picked label="Cylindrical faces" n={f.faces.length} what={['face', 'faces']} onClear={() => set({ faces: [] })} />
      <Pick label="Size (ISO 262)" value={f.size} options={sizeChoices()} onChange={(size) => set({ size })} />
      <ThreadTable size={f.size} />
      <div className="row2">
        <Expr label="Length" value={f.length ?? ''} placeholder="the whole face" onChange={(length) => set({ length: length || undefined }, 'length')} />
        <Expr label="Offset from the end" value={f.offset ?? ''} placeholder="0" onChange={(offset) => set({ offset: offset || undefined }, 'offset')} />
      </div>
      <label className="check"><input type="checkbox" checked={!!f.flip} onChange={(e) => set({ flip: e.target.checked || undefined })} /> Start at the other end</label>
      <Pick label="Hand" value={f.hand ?? 'right'} options={[['right', 'Right-hand'], ['left', 'Left-hand']]} onChange={(hand) => set({ hand: hand === 'right' ? undefined : hand })} />
      <label className="check" title="True helical geometry (slower to build); otherwise the thread is an attribute: the inspector lists it, the view draws rings">
        <input type="checkbox" checked={!!f.modeled} onChange={(e) => set({ modeled: e.target.checked || undefined })} /> Modeled
      </label>
      <p className="hint">Click cylindrical faces: a shaft gets an external thread, a hole an internal one. The profile is ISO 68-1’s basic profile (no tolerance class).</p>
    </>
  );
}

// ------------------------------------------------------------ construction geometry

const PLANE_TYPES: [PlaneDef['type'], string][] = [
  ['offset', 'Offset plane'], ['angle', 'Plane at angle'], ['midplane', 'Midplane'], ['points', 'Plane through three points'],
  ['tangent', 'Tangent plane'], ['path', 'Plane along path'],
];
const AXIS_TYPES: [AxisDef['type'], string][] = [['points', 'Axis through two points'], ['edge', 'Axis through edge'], ['cylinder', 'Axis through cylinder / cone'], ['normal', 'Axis normal to face at point']];
const POINT_TYPES: [PointDef['type'], string][] = [['vertex', 'Point at vertex'], ['centre', 'Point at centre of circle / sphere'], ['edgePlane', 'Point at edge and plane']];

/** A new definition of a construction item's type (expressions default sensibly). */
export function emptyDef(kind: 'plane' | 'axis' | 'point', type: string): PlaneDef | AxisDef | PointDef {
  if (kind === 'plane') {
    switch (type as PlaneDef['type']) {
      case 'offset': return { type: 'offset', plane: 'XY', d: '10' };
      case 'angle': return { type: 'angle', axis: 'X', angle: '45 deg' };
      case 'midplane': return { type: 'midplane', a: 'XY', b: 'XY' };
      case 'points': return { type: 'points', points: [] };
      case 'tangent': return { type: 'tangent', face: undefined as unknown as TopoRef, angle: '0' };
      case 'path': return { type: 'path', curve: '', at: '0' };
    }
  }
  if (kind === 'axis') {
    switch (type as AxisDef['type']) {
      case 'points': return { type: 'points', a: '', b: '' };
      case 'edge': return { type: 'edge', edge: '' };
      case 'cylinder': return { type: 'cylinder', face: undefined as unknown as TopoRef };
      case 'normal': return { type: 'normal', face: undefined as unknown as TopoRef };
    }
  }
  switch (type as PointDef['type']) {
    case 'centre': return { type: 'centre', of: '' };
    case 'edgePlane': return { type: 'edgePlane', curve: '', plane: 'XY' };
    default: return { type: 'vertex', vertex: undefined as unknown as TopoRef };
  }
}

export function ConstructFields({ design, comp, feature: f, pick, onPick, onChange }: Props<ConstructItem>) {
  const def = f.def as unknown as Record<string, unknown>;
  const setDef = (patch: Record<string, unknown>, key?: string) => onChange({ def: { ...f.def, ...patch } } as Partial<DesignItem>, key);
  const types = f.kind === 'plane' ? PLANE_TYPES : f.kind === 'axis' ? AXIS_TYPES : POINT_TYPES;
  const one = (label: string, field: string, kind: PickKind, options: [string, string][], none?: string) => (
    <PickOne label={label} value={def[field]} options={options} design={design} field={field} kind={kind} pick={pick} onPick={onPick} none={none}
      onChange={(v) => setDef({ [field]: v })} />
  );
  const planes = planeOptions(comp, f).filter(([id]) => id !== f.id);
  const axes = axisOptions(comp.items.filter(isSketch).filter((s) => comp.items.indexOf(s) < comp.items.indexOf(f)), constructBefore(comp, f));
  const points = pointOptions(comp, f);
  const fieldsOf = () => {
    if (f.kind === 'plane') return planeFields(f.def);
    if (f.kind === 'axis') return axisFields(f.def);
    return pointFields(f.def);
  };
  const planeFields = (d: PlaneDef) => {
    switch (d.type) {
      case 'offset':
        return <>{one('From plane or face', 'plane', 'plane', planes)}<Expr label="Distance" value={d.d} onChange={(v) => setDef({ d: v }, 'd')} /></>;
      case 'angle':
        return <>{one('About an axis or edge', 'axis', 'axis', axes)}{one('From plane (at 0°)', 'plane', 'plane', planes, 'The plane the axis lies in')}<Expr label="Angle" value={d.angle} onChange={(v) => setDef({ angle: v }, 'angle')} /></>;
      case 'midplane':
        return <>{one('First plane or face', 'a', 'plane', planes)}{one('Second plane or face', 'b', 'plane', planes)}</>;
      case 'points':
        return (
          <div className="field">
            <span>Points ({d.points.length} of 3)</span>
            <p className="cadd-picked">
              <b>{d.points.length ? d.points.map((q) => holds(design, q, points)).join(' · ') : 'None yet'}</b>
              {d.points.length > 0 && <button className="link" onClick={() => setDef({ points: [] })}>Clear</button>}
            </p>
            <div className="cadd-pickfield">
              <Pick label="Add" value="" options={[['', '— a sketch or construction point —'], ...points]} onChange={(v) => v && d.points.length < 3 && setDef({ points: [...d.points, v] })} />
              <button className={`btn${pick?.field === 'points' ? ' primary' : ''}`} onClick={() => onPick(pick?.field === 'points' ? undefined : { field: 'points', kind: 'point' })}>
                <Crosshair size={13} /> {pick?.field === 'points' ? 'Click vertices…' : 'Pick'}
              </button>
            </div>
          </div>
        );
      case 'tangent':
        return <>{one('Cylindrical face', 'face', 'cylinder', [])}{one('From the normal of', 'plane', 'plane', planes, 'Level with the axis (default)')}<Expr label="Angle about the axis" value={d.angle} onChange={(v) => setDef({ angle: v }, 'angle')} /></>;
      case 'path':
        return <>{one('Path (edge or sketch curve)', 'curve', 'curve', curveOptions(comp, f))}<Expr label="Position along it (0 to 1)" value={d.at} onChange={(v) => setDef({ at: v }, 'at')} /></>;
    }
  };
  const axisFields = (a: AxisDef) => {
    switch (a.type) {
      case 'points':
        return <>{one('First point', 'a', 'point', points)}{one('Second point', 'b', 'point', points)}</>;
      case 'edge':
        return one('Edge, sketch line or circle', 'edge', 'axis', curveOptions(comp, f));
      case 'cylinder':
        return one('Cylinder, cone or torus', 'face', 'cylinder', []);
      case 'normal':
        return <>{one('Face', 'face', 'face', [])}{one('Through point', 'point', 'point', points, 'The face’s centre')}</>;
    }
  };
  const pointFields = (q: PointDef) => {
    switch (q.type) {
      case 'vertex':
        return one('Vertex', 'vertex', 'vertex', []);
      case 'centre':
        return one('Circle, arc or sphere', 'of', 'centre', curveOptions(comp, f, 'circles'));
      case 'edgePlane':
        return <>{one('Edge or sketch curve', 'curve', 'curve', curveOptions(comp, f))}{one('Plane', 'plane', 'plane', planes)}</>;
    }
  };
  return (
    <>
      <Pick label="Type" value={f.def.type} options={types as [string, string][]} onChange={(t) => { onPick(undefined); onChange({ def: emptyDef(f.kind, t) } as Partial<DesignItem>); }} />
      {fieldsOf()}
      <p className="hint">{f.kind === 'plane' ? 'Sketch on it (Sketch, then click it), mirror or split about it, or stand a coil on it.' : f.kind === 'axis' ? 'Pattern about it, turn bodies about it, or put a joint on it.' : 'Use it in a plane or axis through points, as a coil’s centre or a joint origin.'} It follows what it was made from.</p>
    </>
  );
}

/** The dialog of a sweep, coil, thread or construction item. */
export function BuildFields(p: Props<DesignFeature>) {
  const f = p.feature;
  if (f.kind === 'sweep') return <SweepFields {...p} feature={f} />;
  if (f.kind === 'coil') return <CoilFields {...p} feature={f} />;
  if (f.kind === 'thread') return <ThreadFields {...p} feature={f} />;
  if (f.kind === 'plane' || f.kind === 'axis' || f.kind === 'point') return <ConstructFields {...p} feature={f} />;
  return null;
}
