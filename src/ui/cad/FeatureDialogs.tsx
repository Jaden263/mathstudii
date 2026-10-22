// Feature and joint dialogs of the CAD workspace. A dialog edits the real timeline
// item, so the model previews every change; Cancel rolls the edits back.
import type { ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import type { CadResult } from '../../cad/evaluate';
import {
  FEATURE_LABEL, isConstruct, isSketch, profileKey,
  type CadComponent, type CadDesign, type CadJoint, type ConstructItem, type DesignFeature, type DesignItem, type DesignSketch, type Direction, type Extent, type FeatureOp, type JointOrigin,
} from '../../cad/design';
import { LazyInput } from '../sketch/SketchProps';
import { sketchRegions } from './useDesign';
import { ThreadTable, sizeChoices } from './threadParts';
import { JOINT_DOFS, JOINT_LABEL, dofWord, type DofKey } from '../../cad/assembly';
import type { DofValues } from '../../cad/kinematics';
import { JointDofFields } from './AssemblyPanels';

/** The joint types with what they move by. */
const JOINT_TYPES = (Object.keys(JOINT_LABEL) as (keyof typeof JOINT_LABEL)[]).map((t) => [t, JOINT_DOFS[t].length ? `${JOINT_LABEL[t]} (${JOINT_DOFS[t].map((k) => dofWord(t, k)).join(', ')})` : JOINT_LABEL[t]] as [typeof t, string]);

export function Dialog({ title, error, children, onOk, onCancel, okLabel = 'OK' }: { title: string; error?: string; children: ReactNode; onOk: () => void; onCancel: () => void; okLabel?: string }) {
  return (
    <div className="cadd" role="dialog" aria-label={title}>
      <div className="cadd-head">{title}</div>
      <div className="cadd-body">
        {children}
        {error && <div className="region-error">{error}</div>}
      </div>
      <div className="cadd-foot">
        <button className="btn primary" onClick={onOk}><Check size={14} /> {okLabel}</button>
        <button className="btn" onClick={onCancel}><X size={14} /> Cancel</button>
      </div>
    </div>
  );
}

export function Expr({ label, value, onChange, hint, placeholder }: { label: string; value: string; onChange: (v: string) => void; hint?: string; placeholder?: string }) {
  return (
    <label className="field" title={hint ?? 'A number in the part unit (degrees for angles), a value with a unit, or a worksheet expression'}>
      <span>{label}</span>
      <LazyInput label={label} value={value} placeholder={placeholder} onCommit={(v) => onChange(v.trim())} />
    </label>
  );
}

export function Pick<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

export function Checks({ label, items, value, onChange, empty, allLabel }: { label: string; items: [string, string][]; value?: string[]; onChange: (v: string[] | undefined) => void; empty: string; allLabel?: string }) {
  const sel = value ?? [];
  return (
    <div className="field">
      <span>{label}</span>
      {!items.length && <p className="hint">{empty}</p>}
      <div className="cadd-checks">
        {allLabel && items.length > 0 && (
          <label className="check"><input type="checkbox" checked={!sel.length} onChange={() => onChange(undefined)} /> {allLabel}</label>
        )}
        {items.map(([id, l]) => (
          <label key={id} className="check">
            <input type="checkbox" checked={sel.includes(id)} onChange={(e) => {
              const next = e.target.checked ? [...sel, id] : sel.filter((x) => x !== id);
              onChange(next.length ? next : undefined);
            }} /> {l}
          </label>
        ))}
      </div>
    </div>
  );
}

const OPS: [FeatureOp, string][] = [['new', 'New body'], ['join', 'Join'], ['cut', 'Cut'], ['intersect', 'Intersect']];
const DIRS: [Direction, string][] = [['auto', 'Automatic'], ['+', 'Along the normal'], ['-', 'Against the normal']];

interface FeatureProps {
  design: CadDesign;
  comp: CadComponent;
  feature: DesignFeature;
  result?: CadResult;
  unit: string;
  onChange: (patch: Partial<DesignFeature>, coalesce?: string) => void;
}

/** Bodies of the component before this feature (by the latest result). */
export function bodyOptions(comp: CadComponent, result: CadResult | undefined): [string, string][] {
  return (result?.design?.bodies[comp.id] ?? []).map((b) => [b.id, b.name]);
}

/** Rounded or chamfered edges at one end of an extrusion. */
function EdgeField({ label, value, onChange }: { label: string; value?: { type: 'fillet' | 'chamfer'; r: string }; onChange: (v: { type: 'fillet' | 'chamfer'; r: string } | undefined) => void }) {
  return (
    <>
      <Pick
        label={label} value={value?.type ?? 'none'} options={[['none', 'Sharp'], ['fillet', 'Rounded (fillet)'], ['chamfer', 'Chamfered']]}
        onChange={(t) => onChange(t === 'none' ? undefined : { type: t as 'fillet' | 'chamfer', r: value?.r ?? '2' })}
      />
      {value && <Expr label={value.type === 'fillet' ? 'Radius' : 'Chamfer size'} value={value.r} onChange={(r) => onChange({ ...value, r })} />}
    </>
  );
}

export function FeatureFields({ design, comp, feature: f, result, unit, onChange }: FeatureProps) {
  const sketches = comp.items.filter(isSketch);
  const upto = comp.items.indexOf(f);
  const before = comp.items.slice(0, upto < 0 ? undefined : upto);
  const sketchSel = (value: string) => (
    <Pick label="Sketch" value={value} options={sketches.map((s) => [s.id, s.name])} onChange={(v) => onChange({ sketch: v, profiles: undefined } as Partial<DesignFeature>)} />
  );
  const targets = (v?: string[]) => (
    <Checks label="Bodies" items={bodyOptions(comp, result)} value={v} onChange={(t) => onChange({ targets: t } as Partial<DesignFeature>)} empty="No bodies yet" allLabel="Automatic" />
  );
  const profiles = (sid: string, v?: string[]) => {
    const ds = sketches.find((s) => s.id === sid);
    const regions = ds ? sketchRegions(ds, result) : [];
    return (
      <div className="field">
        <span>Profiles</span>
        <p className="hint">
          {!regions.length ? 'The sketch has no closed profile.' : !v?.length ? `All ${regions.length} profile${regions.length > 1 ? 's' : ''} — click profiles in the view to pick some.` : `${v.length} of ${regions.length} picked (click in the view to change).`}
          {v?.length ? <> <button className="link" onClick={() => onChange({ profiles: undefined } as Partial<DesignFeature>)}>Use all</button></> : null}
        </p>
      </div>
    );
  };
  switch (f.kind) {
    case 'extrude': {
      const ex = f.extent;
      const setEx = (e: Extent, key?: string) => onChange({ extent: e }, key);
      return (
        <>
          {sketchSel(f.sketch)}
          {profiles(f.sketch, f.profiles)}
          <Pick label="Extent" value={ex.type} options={[['one', 'Distance'], ['symmetric', 'Symmetric'], ['two', 'Two sides'], ['all', 'Through all']]}
            onChange={(t) => setEx(t === 'one' ? { type: 'one', d: 'd' in ex ? ex.d : '10' } : t === 'symmetric' ? { type: 'symmetric', d: 'd' in ex ? ex.d : '10' } : t === 'two' ? { type: 'two', d: 'd' in ex ? ex.d : '10', d2: '5' } : { type: 'all' })} />
          {ex.type !== 'all' && <Expr label={ex.type === 'symmetric' ? 'Total distance' : 'Distance'} value={ex.d} onChange={(d) => setEx({ ...ex, d } as Extent, 'd')} />}
          {ex.type === 'two' && <Expr label="Distance, other side" value={ex.d2} onChange={(d2) => setEx({ ...ex, d2 }, 'd2')} />}
          {(ex.type === 'one' || ex.type === 'all') && <Pick label="Direction" value={ex.dir ?? 'auto'} options={DIRS} onChange={(dir) => setEx({ ...ex, dir: dir === 'auto' ? undefined : dir })} />}
          {ex.type === 'all' && <label className="check"><input type="checkbox" checked={!!ex.both} onChange={(e) => setEx({ ...ex, both: e.target.checked || undefined })} /> Both sides</label>}
          <Pick label="Operation" value={f.op} options={OPS} onChange={(op) => onChange({ op })} />
          {f.op !== 'new' && targets(f.targets)}
          <label className="check" title="Only a wall along the outline: enclosures, tubes, channels">
            <input type="checkbox" checked={!!f.thin} onChange={(e) => onChange({ thin: e.target.checked ? { t: '2', side: 'inside', cap: 'start' } : undefined, ...(e.target.checked ? { edgeStart: undefined, edgeEnd: undefined } : {}) })} /> Thin (shell)
          </label>
          {f.thin && (
            <>
              <Expr label="Wall thickness" value={f.thin.t} onChange={(t) => onChange({ thin: { ...f.thin!, t } }, 'thin')} />
              <Pick label="Wall" value={f.thin.side} options={[['inside', 'Inside the outline'], ['outside', 'Outside'], ['center', 'Centred']]} onChange={(side) => onChange({ thin: { ...f.thin!, side } })} />
              <Pick label="Closed ends" value={f.thin.cap} options={[['start', 'Start (open box)'], ['none', 'None (tube)'], ['end', 'End'], ['both', 'Both (hollow)']]} onChange={(cap) => onChange({ thin: { ...f.thin!, cap } })} />
            </>
          )}
          {!f.thin && (
            <>
              <EdgeField label="Start edges" value={f.edgeStart} onChange={(e) => onChange({ edgeStart: e }, 'es')} />
              <EdgeField label="End edges" value={f.edgeEnd} onChange={(e) => onChange({ edgeEnd: e }, 'ee')} />
            </>
          )}
        </>
      );
    }
    case 'loft': {
      const withProfiles = sketches.filter((s) => sketchRegions(s, result).length > 0);
      const opts = withProfiles.map((s) => [s.id, s.name] as [string, string]);
      return (
        <>
          <Pick label="From sketch" value={f.sketch} options={opts} onChange={(v) => onChange({ sketch: v, profile: undefined })} />
          <Pick label="To sketch" value={f.sketch2} options={opts} onChange={(v) => onChange({ sketch2: v, profile2: undefined })} />
          <p className="hint">The first closed profile of each sketch is joined by a ruled surface. Put the sketches on parallel or tilted planes (Sketch → offset plane).</p>
          <Pick label="Operation" value={f.op} options={OPS} onChange={(op) => onChange({ op })} />
          {f.op !== 'new' && targets(f.targets)}
        </>
      );
    }
    case 'revolve': {
      const ds = sketches.find((s) => s.id === f.sketch);
      const lines = ds?.sketch.entities.filter((e) => e.type === 'line') ?? [];
      return (
        <>
          {sketchSel(f.sketch)}
          {profiles(f.sketch, f.profiles)}
          <Pick label="Axis" value={f.axis} options={[['x', 'Sketch x axis'], ['y', 'Sketch y axis'], ...lines.map((l, i) => [l.id, `Line ${i + 1}${l.construction ? ' (construction)' : ''}`] as [string, string])]} onChange={(axis) => onChange({ axis })} />
          <Expr label="Angle" value={f.angle} onChange={(angle) => onChange({ angle }, 'angle')} />
          <label className="check"><input type="checkbox" checked={!!f.flip} onChange={(e) => onChange({ flip: e.target.checked || undefined })} /> Other direction</label>
          <Pick label="Operation" value={f.op} options={OPS} onChange={(op) => onChange({ op })} />
          {f.op !== 'new' && targets(f.targets)}
        </>
      );
    }
    case 'hole': {
      const ds = sketches.find((s) => s.id === f.sketch);
      const pts = ds?.sketch.entities.filter((e) => e.type === 'point') ?? [];
      return (
        <>
          {sketchSel(f.sketch)}
          <Checks label="Centres (sketch points)" items={pts.map((p, i) => [p.id, `Point ${i + 1}`])} value={f.points} onChange={(points) => onChange({ points })} empty="Add points to the sketch for the hole centres" allLabel="All points" />
          <Pick label="Type" value={f.style} options={[['simple', 'Simple'], ['counterbore', 'Counterbore'], ['countersink', 'Countersink']]} onChange={(style) => onChange({ style })} />
          <label className="check" title="Drilled to the tap drill of an ISO metric thread (d − P), threaded to a depth">
            <input type="checkbox" checked={!!f.tap} onChange={(e) => onChange({ tap: e.target.checked ? { size: 'M8' } : undefined })} /> Tapped
          </label>
          {f.tap ? (
            <>
              <Pick label="Thread (ISO 262)" value={f.tap.size} options={sizeChoices()} onChange={(size) => onChange({ tap: { ...f.tap!, size } })} />
              <ThreadTable size={f.tap.size} />
              <Expr label="Thread depth" value={f.tap.depth ?? ''} placeholder={f.through ? 'all the way' : 'the hole’s depth'} onChange={(depth) => onChange({ tap: { ...f.tap!, depth: depth || undefined } }, 'tdepth')} />
              <label className="check" title="True helical geometry (slower to build); otherwise cosmetic"><input type="checkbox" checked={!!f.tap.modeled} onChange={(e) => onChange({ tap: { ...f.tap!, modeled: e.target.checked || undefined } })} /> Modeled thread</label>
            </>
          ) : <Expr label="Diameter" value={f.d} onChange={(d) => onChange({ d }, 'd')} />}
          <label className="check"><input type="checkbox" checked={!!f.through} onChange={(e) => onChange({ through: e.target.checked || undefined })} /> Through all</label>
          {!f.through && <Expr label="Depth" value={f.depth} onChange={(depth) => onChange({ depth }, 'depth')} />}
          {f.style === 'counterbore' && (
            <div className="row2">
              <Expr label="Counterbore Ø" value={f.cbD ?? ''} placeholder="1.8 × Ø" onChange={(cbD) => onChange({ cbD }, 'cbD')} />
              <Expr label="Counterbore depth" value={f.cbDepth ?? ''} placeholder="0.6 × Ø" onChange={(cbDepth) => onChange({ cbDepth }, 'cbDepth')} />
            </div>
          )}
          {f.style === 'countersink' && (
            <div className="row2">
              <Expr label="Countersink Ø" value={f.csD ?? ''} placeholder="2 × Ø" onChange={(csD) => onChange({ csD }, 'csD')} />
              <Expr label="Angle" value={f.csAngle ?? ''} placeholder="90" onChange={(csAngle) => onChange({ csAngle }, 'csAngle')} />
            </div>
          )}
          <Pick label="Direction" value={f.dir ?? 'auto'} options={DIRS} onChange={(dir) => onChange({ dir: dir === 'auto' ? undefined : dir })} />
          {targets(f.targets)}
        </>
      );
    }
    case 'rib': {
      // sketches with open curves: lines and arcs
      const isOpen = (e: (typeof sketches)[number]['sketch']['entities'][number]) => e.type === 'line' || e.type === 'arc' || (e.type === 'spline' && !e.closed) || (e.type === 'ellipse' && !!e.p1);
      const open = sketches.filter((s) => s.sketch.entities.some(isOpen));
      const ds = sketches.find((s) => s.id === f.sketch);
      const curves = ds?.sketch.entities.filter(isOpen) ?? [];
      return (
        <>
          <Pick label="Sketch" value={f.sketch} options={open.map((s) => [s.id, s.name])} onChange={(sketch) => onChange({ sketch, curves: undefined })} />
          <Checks label="Curves" items={curves.map((e) => [e.id, `${e.type} ${ds!.sketch.entities.indexOf(e) + 1}${e.construction ? ' (construction)' : ''}`])} value={f.curves}
            onChange={(c) => onChange({ curves: c })} empty="The sketch has no lines or arcs" allLabel="All of the sketch (not construction)" />
          <div className="row2">
            <Expr label="Thickness" value={f.thickness} onChange={(thickness) => onChange({ thickness }, 'thickness')} />
            <Pick label="Thickness to" value={f.side ?? 'symmetric'} options={[['symmetric', 'Both sides'], ['one', 'Side of the normal'], ['other', 'Other side']]} onChange={(side) => onChange({ side: side === 'symmetric' ? undefined : side })} />
          </div>
          <Pick label="Depth" value={f.depth === undefined ? 'next' : 'depth'} options={[['next', 'To the next faces'], ['depth', 'A depth']]} onChange={(k) => onChange({ depth: k === 'next' ? undefined : '10' })} />
          {f.depth !== undefined && <Expr label="Depth from the curve" value={f.depth} onChange={(depth) => onChange({ depth }, 'depth')} />}
          <label className="check"><input type="checkbox" checked={!!f.flip} onChange={(e) => onChange({ flip: e.target.checked || undefined })} /> Flip direction</label>
          <Pick label="Operation" value={f.op} options={[['join', 'Join'], ['new', 'New body']]} onChange={(op) => onChange({ op })} />
          {f.op === 'join' && targets(f.targets)}
          <p className="hint">Draw an open line or arc on a plane through the middle of the rib, its ends on the faces it closes against: it grows in that plane to the body.</p>
        </>
      );
    }
    case 'pattern':
    case 'mirror': {
      const feats = before.filter((i): i is DesignFeature => !isSketch(i) && (i.kind === 'extrude' || i.kind === 'revolve' || i.kind === 'hole' || i.kind === 'sweep' || i.kind === 'coil' || i.kind === 'rib'));
      const axes = axisOptions(sketches, constructBefore(comp, f));
      return (
        <>
          <Pick label="Copy" value={f.of} options={[['features', 'Features'], ['bodies', 'Bodies']]} onChange={(of) => onChange({ of, refs: [] })} />
          {f.of === 'features'
            ? <Checks label="Features" items={feats.map((x) => [x.id, x.name])} value={f.refs} onChange={(refs) => onChange({ refs: refs ?? [] })} empty="No extrude, revolve or hole before this feature" />
            : <Checks label="Bodies (or click them)" items={bodyOptions(comp, result)} value={f.refs} onChange={(refs) => onChange({ refs: refs ?? [] })} empty="No bodies yet" />}
          {f.kind === 'pattern' ? (
            <>
              <Pick label="Pattern" value={f.type} options={[['rect', 'Rectangular'], ['circ', 'Circular']]} onChange={(type) => onChange({ type, spacing: type === 'circ' ? '360' : '20' })} />
              <Pick label={f.type === 'circ' ? 'Axis' : 'Direction'} value={f.axis} options={axes} onChange={(axis) => onChange({ axis })} />
              <div className="row2">
                <Expr label="Count" value={f.count} onChange={(count) => onChange({ count }, 'count')} />
                <Expr label={f.type === 'circ' ? 'Total angle' : 'Spacing'} value={f.spacing} onChange={(spacing) => onChange({ spacing }, 'spacing')} />
              </div>
              {f.type === 'rect' && (
                <>
                  <Pick label="Second direction" value={f.axis2 ?? ''} options={[['', 'None'], ...axes]} onChange={(a) => onChange({ axis2: a || undefined, count2: f.count2 ?? '2', spacing2: f.spacing2 ?? '20' })} />
                  {f.axis2 && (
                    <div className="row2">
                      <Expr label="Count" value={f.count2 ?? ''} onChange={(count2) => onChange({ count2 }, 'count2')} />
                      <Expr label="Spacing" value={f.spacing2 ?? ''} onChange={(spacing2) => onChange({ spacing2 }, 'spacing2')} />
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <Pick label="Mirror plane" value={f.plane} options={planeOptions(comp, f)} onChange={(plane) => onChange({ plane })} />
          )}
          {f.of === 'bodies' && <label className="check"><input type="checkbox" checked={!!f.join} onChange={(e) => onChange({ join: e.target.checked || undefined })} /> Join the copies to the original</label>}
        </>
      );
    }
    case 'combine': {
      const bodies = bodyOptions(comp, result);
      return (
        <>
          <Pick label="Target body" value={f.target} options={[['', '— pick —'], ...bodies]} onChange={(target) => onChange({ target, tools: f.tools.filter((t) => t !== target) })} />
          <Checks label="Tool bodies" items={bodies.filter(([id]) => id !== f.target)} value={f.tools} onChange={(tools) => onChange({ tools: tools ?? [] })} empty="Needs at least two bodies" />
          <Pick label="Operation" value={f.op} options={[['join', 'Join'], ['cut', 'Cut'], ['intersect', 'Intersect']]} onChange={(op) => onChange({ op })} />
          <label className="check"><input type="checkbox" checked={!!f.keepTools} onChange={(e) => onChange({ keepTools: e.target.checked || undefined })} /> Keep the tool bodies</label>
        </>
      );
    }
  }
  void design; void unit; void profileKey;
  return null;
}

export function axisOptions(sketches: DesignSketch[], construct: ConstructItem[] = []): [string, string][] {
  const out: [string, string][] = [['X', 'X axis'], ['Y', 'Y axis'], ['Z', 'Z axis']];
  for (const a of construct) if (a.kind === 'axis') out.push([a.id, a.name]);
  for (const s of sketches) {
    s.sketch.entities.forEach((e, i) => {
      if (e.type === 'line') out.push([`${s.id}/${e.id}`, `${s.name} · line ${i + 1}${e.construction ? ' (construction)' : ''}`]);
    });
  }
  return out;
}

/** The construction planes, axes and points of a component before an item (all of them when it is not in the timeline). */
export function constructBefore(comp: CadComponent, item?: DesignItem): ConstructItem[] {
  const upto = item ? comp.items.indexOf(item) : -1;
  return comp.items.slice(0, upto < 0 ? undefined : upto).filter(isConstruct);
}

/** Planes a feature can use: the origin planes, the planes of sketches and the construction planes before it. */
export function planeOptions(comp: CadComponent, item?: DesignItem): [string, string][] {
  const upto = item ? comp.items.indexOf(item) : -1;
  const before = comp.items.slice(0, upto < 0 ? undefined : upto);
  return [['XY', 'XY plane'], ['XZ', 'XZ plane'], ['YZ', 'YZ plane'],
    ...before.filter((i): i is ConstructItem => i.kind === 'plane').map((p) => [p.id, p.name] as [string, string]),
    ...before.filter(isSketch).map((s) => [s.id, `Plane of ${s.name}`] as [string, string])];
}

export const featureTitle = (f: DesignFeature) => `${FEATURE_LABEL[f.kind]}${f.name ? ` — ${f.name}` : ''}`;

// ------------------------------------------------------------ joints

/** Joint origins a component offers in the dropdown: its origin and its sketch points. */
export function originOptions(design: CadDesign, cid: string): { key: string; label: string; origin: JointOrigin }[] {
  const comp = design.components.find((c) => c.id === cid);
  const out: { key: string; label: string; origin: JointOrigin }[] = [{ key: 'origin', label: 'Component origin (Z up)', origin: { kind: 'origin' } }];
  // construction points (Z up), axes (Z along them) and planes (Z their normal)
  for (const ci of comp?.items.filter(isConstruct) ?? []) out.push({ key: `datum/${ci.id}`, label: `${ci.name} (construction ${ci.kind})`, origin: { kind: 'datum', id: ci.id } });
  for (const s of comp?.items.filter(isSketch) ?? []) {
    const label = new Map<string, string>();
    // circle centres first: that is what shafts and holes turn about
    for (const pass of [0, 1, 2]) {
      s.sketch.entities.forEach((e, i) => {
        if (pass === 0 && (e.type === 'circle' || e.type === 'arc')) label.set(e.c, label.get(e.c) ?? `${e.type} ${i + 1} centre`);
        if (pass === 1 && e.type === 'point') label.set(e.p, label.get(e.p) ?? `point ${i + 1}`);
        if (pass === 2 && e.type === 'line') {
          label.set(e.p1, label.get(e.p1) ?? `line ${i + 1} start`);
          label.set(e.p2, label.get(e.p2) ?? `line ${i + 1} end`);
        }
      });
    }
    for (const [pid, l] of label) {
      for (const [axis, al] of [['n', 'normal'], ['u', 'sketch x'], ['v', 'sketch y']] as const) {
        out.push({ key: `${s.id}/${pid}/${axis}`, label: `${s.name} · ${l} · Z = ${al}`, origin: { kind: 'point', sketch: s.id, point: pid, axis } });
      }
    }
  }
  return out;
}

export const originKey = (o: JointOrigin) => (o.kind === 'origin' ? 'origin' : o.kind === 'point' ? `${o.sketch}/${o.point}/${o.axis ?? 'n'}` : o.kind === 'datum' ? `datum/${o.id}` : o.kind);

export function JointFields({ design, joint: j, picking, onPick, onChange, values, unit, onDrive }: {
  design: CadDesign;
  joint: CadJoint;
  picking: 'a' | 'b' | null;
  onPick: (side: 'a' | 'b' | null) => void;
  onChange: (patch: Partial<CadJoint>, coalesce?: string) => void;
  /** The joint's DOFs as placed. */
  values?: DofValues;
  unit: string;
  onDrive?: (dof: DofKey) => void;
}) {
  const occName = (id: string) => {
    const o = design.occurrences.find((q) => q.id === id);
    const c = design.components.find((q) => q.id === o?.component);
    return o?.name ?? `${c?.name ?? '?'}:${design.occurrences.filter((q) => q.component === o?.component).indexOf(o!) + 1}`;
  };
  const side = (s: 'a' | 'b', title: string) => {
    const end = j[s];
    const occ = design.occurrences.find((o) => o.id === end.occ);
    const opts = occ ? originOptions(design, occ.component) : [];
    const key = originKey(end.origin);
    return (
      <fieldset className="cadd-side">
        <legend>{title}</legend>
        <Pick label="Occurrence" value={end.occ} options={design.occurrences.map((o) => [o.id, occName(o.id)])} onChange={(occ) => onChange({ [s]: { occ, origin: { kind: 'origin' } } } as Partial<CadJoint>)} />
        <Pick label="Joint origin" value={key} options={[
          ...(key === 'frame' ? [['frame', 'Picked on the model'] as [string, string]] : []),
          ...(end.origin.kind === 'snap' ? [['snap', `On the model: ${end.origin.label}`] as [string, string]] : []),
          ...opts.map((o) => [o.key, o.label] as [string, string]),
        ]}
          onChange={(k) => {
            const o = opts.find((x) => x.key === k);
            if (o) onChange({ [s]: { occ: end.occ, origin: o.origin } } as Partial<CadJoint>);
          }} />
        <button className={`btn${picking === s ? ' primary' : ''}`} onClick={() => onPick(picking === s ? null : s)}>
          {picking === s ? 'Click a snap point… (Esc to stop)' : 'Pick on the model'}
        </button>
      </fieldset>
    );
  };
  return (
    <>
      <Pick label="Type" value={j.type} options={JOINT_TYPES} onChange={(type) => onChange({ type })} />
      {side('b', 'Moves (child)')}
      {side('a', 'Onto (parent)')}
      <JointDofFields joint={j} values={values} unit={unit} onChange={onChange} onDrive={onDrive} />
      <label className="check"><input type="checkbox" checked={!!j.flip} onChange={(e) => onChange({ flip: e.target.checked || undefined })} /> Flip (faces mate: the Z axes point at each other)</label>
      <p className="hint">The child's joint origin is put on the parent's, Z on Z. The values accept worksheet expressions, so a calculation can drive the mechanism; set the DOFs a loop of joints finds (a four-bar's pins) to Solved.</p>
    </>
  );
}
