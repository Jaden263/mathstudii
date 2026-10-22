// The Sheet Metal tab of the CAD workspace, as in Fusion: the component's rules, Flange on
// a sketch profile, Edge flange and Hem on edges picked in the view, Bend along a sketch
// line, and the flat pattern of a sheet-metal body with its bend table, as DXF or SVG.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Download, PenTool, X } from 'lucide-react';
import type { CadComponent, CadDesign, DesignFeature, DesignItem, DesignSketch } from '../../cad/design';
import { isSketch } from '../../cad/design';
import type { BodyResult } from '../../cad/buildResult';
import type { DesignResult } from '../../cad/evaluate';
import { designNumbers } from '../../cad/keys';
import { primPath } from '../../cad/drawingSheet';
import { bendAllowance, bendNote, din6935, SHEET_MATERIALS, sheetMaterial, DEFAULT_RULES, type FlatPattern, type SheetFeature, type SheetRules } from '../../cad/sheetMetal';
import { flatDxf, flatSvg, fmtLen } from '../../cad/flatExport';
import { baseName, keyFeature, refTo, resolveRef, type TopoRef } from '../../cad/topology';
import { exportFile } from '../../platform/files';
import { Expr, Pick } from './FeatureDialogs';
import { isSuperseded, kernelRequest } from './kernelClient';
import { sketchRegions } from './useDesign';
import type { CadResult } from '../../cad/evaluate';
import { num } from './SketchPanel';
import { BendIcon, EdgeFlangeIcon, FlangeIcon, FlatIcon, HemIcon, RulesIcon } from './sheetIcons';

/** Sheet features that pick edges in the view. */
export const pickingEdges = (f: DesignItem | undefined): f is Extract<SheetFeature, { kind: 'edgeflange' | 'hem' }> => f?.kind === 'edgeflange' || f?.kind === 'hem';

type Button = (p: { icon: ReactNode; label: string; title: string; on?: boolean; disabled?: boolean; onClick: () => void }) => ReactNode;
type GroupOf = (p: { label: string; children: ReactNode }) => ReactNode;

export function SheetRibbon({ Group, Button, active, flatOn, onSketch, onStart, onRules, onFlat, onExport }: {
  Group: GroupOf;
  Button: Button;
  active?: string;
  flatOn: boolean;
  onSketch: () => void;
  onStart: (kind: SheetFeature['kind']) => void;
  onRules: () => void;
  onFlat: () => void;
  onExport: (format: 'dxf' | 'svg') => void;
}) {
  return (
    <>
      <Group label="Rules">
        <Button icon={<RulesIcon />} label="Rules" title="Sheet-metal rules of the active component: material, thickness, bend radius, K-factor, reliefs" onClick={onRules} />
      </Group>
      <Group label="Create">
        <Button icon={<PenTool size={20} />} label="Sketch" title="Create a sketch on a plane or a flat face" onClick={onSketch} />
        <Button icon={<FlangeIcon />} label="Flange" title="A sheet from a sketch: a closed profile makes a plate, open lines a strip bent at every corner" on={active === 'flange'} onClick={() => onStart('flange')} />
        <Button icon={<EdgeFlangeIcon />} label="Edge flange" title="Flanges on straight edges of the sheet picked in the view: height, angle, position, offsets" on={active === 'edgeflange'} onClick={() => onStart('edgeflange')} />
        <Button icon={<HemIcon />} label="Hem" title="Fold edges of the sheet back by 180°, open with a gap or closed" on={active === 'hem'} onClick={() => onStart('hem')} />
        <Button icon={<BendIcon />} label="Bend" title="Bend the sheet along a line sketched on it" on={active === 'bend'} onClick={() => onStart('bend')} />
      </Group>
      <Group label="Flat pattern">
        <Button icon={<FlatIcon />} label="Flat pattern" title="The flat blank of the sheet-metal body with its bend lines and bend table" on={flatOn} onClick={onFlat} />
        <Button icon={<Download size={20} />} label="DXF" title="The flat pattern as DXF (R12, 1:1): contour, cut-outs, bend lines on layer BEND" onClick={() => onExport('dxf')} />
        <Button icon={<Download size={20} />} label="SVG" title="The flat pattern as SVG at true size" onClick={() => onExport('svg')} />
      </Group>
    </>
  );
}

// ------------------------------------------------------------ starting a feature

export interface StartContext {
  design: CadDesign;
  comp: CadComponent;
  id: string;
  name: string;
  items: DesignItem[];
  result?: CadResult;
  /** The sketch selected (in the browser or by a profile). */
  selSketch?: DesignSketch;
  selProfile?: { sketch: string; key: string } | null;
  /** Straight edges picked in the view (used up). */
  edges: () => TopoRef[];
  sheetBodies: string[];
}

/** A new sheet feature from what is selected, or a message saying what to do first. */
export function startSheet(kind: SheetFeature['kind'], cx: StartContext): DesignFeature | string {
  const { id, name } = cx;
  const lastSketch = (pred: (s: DesignSketch) => boolean) => [...cx.items].reverse().find((i): i is DesignSketch => isSketch(i) && pred(i));
  const lines = (s: DesignSketch) => s.sketch.entities.some((e) => e.type === 'line' && !e.construction);
  if (kind === 'flange') {
    const closed = (s: DesignSketch) => sketchRegions(s, cx.result).length > 0;
    const sk = cx.selProfile ? cx.items.find((i): i is DesignSketch => isSketch(i) && i.id === cx.selProfile!.sketch)
      : cx.selSketch && (closed(cx.selSketch) || lines(cx.selSketch)) ? cx.selSketch : lastSketch((s) => closed(s) || lines(s));
    if (!sk) return 'Sketch the flange first: a closed profile for a plate, or lines end to end for a bent strip';
    const open = !closed(sk);
    return { kind, id, name, sketch: sk.id, ...(cx.selProfile?.sketch === sk.id ? { profile: cx.selProfile.key } : {}), ...(open ? { width: '40' } : {}) };
  }
  if (kind === 'bend') {
    // a flange's own profile is no bend line
    const profiles = new Set(cx.items.flatMap((i) => (i.kind === 'flange' ? [i.sketch] : [])));
    const bendLines = (s: DesignSketch) => lines(s) && !profiles.has(s.id);
    const sk = cx.selSketch && bendLines(cx.selSketch) ? cx.selSketch : lastSketch(bendLines);
    if (!sk) return 'Sketch the bend line on a face of the sheet first (Sketch, then a line across the face)';
    if (!cx.sheetBodies.length) return 'A bend goes on a sheet-metal body: make one with Flange first';
    return { kind, id, name, sketch: sk.id, angle: '90' };
  }
  if (!cx.sheetBodies.length) return `${kind === 'hem' ? 'A hem' : 'An edge flange'} goes on a sheet-metal body: make one with Flange first`;
  const edges = cx.edges();
  if (kind === 'hem') return { kind, id, name, edges, type: 'open', length: '' };
  return { kind, id, name, edges, height: '20' };
}

/**
 * A click on an edge while an edge flange or hem is open: a straight edge of a sheet-metal
 * body goes in, or out again; a patch for the feature, or what is wrong with the edge.
 */
export function pickSheetEdge(f: Extract<SheetFeature, { kind: 'edgeflange' | 'hem' }>, body: BodyResult, edgeIndex: number | undefined, shown: BodyResult[], sheet: boolean): Partial<DesignItem> | string {
  if (edgeIndex === undefined) return 'Click a straight edge of the sheet (an outline edge of a flange)';
  const e = body.edges[edgeIndex];
  if (!e?.line) return 'A flange goes on a straight edge';
  if (!sheet) return 'That body is not sheet metal: start it with Flange';
  // an edge this feature made itself is no edge it goes on
  if (e.faces.some((i) => baseName(body.faces[i]?.key ?? '').split('+').some((k) => keyFeature(k) === f.id))) return `${f.name} made that edge: pick one of the sheet's edges before it`;
  const i = f.edges.findIndex((r) => {
    const res = resolveRef(r, shown);
    return res.ok && res.body === body.id && res.index === edgeIndex;
  });
  return { edges: i >= 0 ? f.edges.filter((_, k) => k !== i) : [...f.edges, refTo('edge', body.id, e)] } as Partial<DesignItem>;
}

export function sheetHint(f: SheetFeature): string {
  switch (f.kind) {
    case 'flange': return 'Pick the sketch and its profile in the dialog (or click a profile) · the rules give the thickness · Esc cancels';
    case 'edgeflange': return 'Click straight edges of the sheet for flanges (an edge on the top face bends up) · click one again to take it out · Esc cancels';
    case 'hem': return 'Click straight edges of the sheet to hem them · click one again to take it out · Esc cancels';
    case 'bend': return 'Pick the sketch with the bend line in the dialog · the side that stays is the one the flange hangs from (Flip for the other) · Esc cancels';
  }
}

// ------------------------------------------------------------ the dialogs' fields

export function SheetFields({ comp, feature: f, result, onChange, onRules }: {
  comp: CadComponent;
  feature: SheetFeature;
  result?: CadResult;
  onChange: (p: Partial<DesignItem>, key?: string) => void;
  onRules: () => void;
}) {
  const sketches = comp.items.filter(isSketch);
  const rules = comp.sheet ?? DEFAULT_RULES;
  const ruleLine = (
    <p className="hint">
      t = {rules.t}, R = {rules.r}, K = {rules.k?.trim() || `${sheetMaterial(rules.material).K} (${sheetMaterial(rules.material).name.toLowerCase()})`}
      {' '}<button className="link" onClick={onRules}>Rules…</button>
    </p>
  );
  const flip = (label: string) => (
    <label className="check"><input type="checkbox" checked={!!f.flip} onChange={(e) => onChange({ flip: e.target.checked || undefined } as Partial<DesignItem>)} /> {label}</label>
  );
  const edges = (n: number) => <p className="hint">{n ? `${n} edge${n > 1 ? 's' : ''} picked (click edges in the view to add or take them out).` : 'Click straight edges of the sheet in the view.'}</p>;
  switch (f.kind) {
    case 'flange': {
      const sk = sketches.find((s) => s.id === f.sketch);
      const regions = sk ? sketchRegions(sk, result) : [];
      const open = !regions.length || !!f.curves?.length;
      return (
        <>
          <Pick label="Sketch" value={f.sketch} options={sketches.map((s) => [s.id, s.name])} onChange={(v) => onChange({ sketch: v, profile: undefined, curves: undefined } as Partial<DesignItem>)} />
          <p className="hint">{open ? 'Open lines: a strip bent at every corner with the rules’ radius; the lines are one face of the sheet.' : `A plate of the ${f.profile ? 'picked' : 'first'} closed profile${regions.length > 1 ? ` (of ${regions.length}; click one in the view)` : ''}.`}</p>
          {open && (
            <>
              <Expr label="Width" value={f.width ?? ''} placeholder="50" onChange={(width) => onChange({ width } as Partial<DesignItem>, 'width')} />
              <Pick label="Width goes" value={f.symmetric ? 'sym' : f.reverse ? 'rev' : 'one'} options={[['one', 'Along the sketch normal'], ['sym', 'Both ways'], ['rev', 'Against the normal']]}
                onChange={(v) => onChange({ symmetric: v === 'sym' || undefined, reverse: v === 'rev' || undefined } as Partial<DesignItem>)} />
            </>
          )}
          {flip(open ? 'Thickness to the other side of the lines' : 'Thickness below the sketch plane')}
          {ruleLine}
        </>
      );
    }
    case 'edgeflange':
      return (
        <>
          {edges(f.edges.length)}
          <Expr label="Height" value={f.height} onChange={(height) => onChange({ height } as Partial<DesignItem>, 'height')} hint="Measured from the virtual sharp of the outer (or inner) faces to the flange's edge" />
          <Pick label="Height to" value={f.datum ?? 'outer'} options={[['outer', 'Outer virtual sharp'], ['inner', 'Inner virtual sharp']]} onChange={(datum) => onChange({ datum: datum === 'outer' ? undefined : datum } as Partial<DesignItem>)} />
          <Expr label="Bend angle" value={f.angle ?? ''} placeholder="90" onChange={(angle) => onChange({ angle: angle || undefined } as Partial<DesignItem>, 'angle')} />
          <Pick label="Bend position" value={f.position ?? 'inside'} options={[['inside', 'Inside (outer face on the edge)'], ['outside', 'Outside (inner face on the edge)'], ['centre', 'Centre (mid-plane on the edge)'], ['adjacent', 'Adjacent (bend starts at the edge)']]}
            onChange={(position) => onChange({ position: position === 'inside' ? undefined : position } as Partial<DesignItem>)} />
          <div className="row2">
            <Expr label="Offset, start" value={f.offset1 ?? ''} placeholder="0" onChange={(offset1) => onChange({ offset1: offset1 || undefined } as Partial<DesignItem>, 'o1')} />
            <Expr label="Offset, end" value={f.offset2 ?? ''} placeholder="0" onChange={(offset2) => onChange({ offset2: offset2 || undefined } as Partial<DesignItem>, 'o2')} />
          </div>
          {flip('Bend the other way')}
          {ruleLine}
        </>
      );
    case 'hem':
      return (
        <>
          {edges(f.edges.length)}
          <Pick label="Type" value={f.type} options={[['open', 'Open (a gap)'], ['closed', 'Closed (flat on the sheet)']]} onChange={(type) => onChange({ type } as Partial<DesignItem>)} />
          {f.type === 'open' && <Expr label="Gap" value={f.gap ?? ''} placeholder="t" onChange={(gap) => onChange({ gap: gap || undefined } as Partial<DesignItem>, 'gap')} />}
          <Expr label="Length" value={f.length} placeholder="4·t" onChange={(length) => onChange({ length } as Partial<DesignItem>, 'length')} hint="From the outside of the fold to the hem's edge" />
          <Pick label="Position" value={f.position ?? 'adjacent'} options={[['adjacent', 'Fold starts at the edge'], ['inside', 'Outside of the fold on the edge']]} onChange={(position) => onChange({ position: position === 'adjacent' ? undefined : position } as Partial<DesignItem>)} />
          {flip('Fold to the other side')}
          {ruleLine}
        </>
      );
    case 'bend': {
      const sk = sketches.find((s) => s.id === f.sketch);
      const lines = sk?.sketch.entities.filter((e) => e.type === 'line' && !e.construction) ?? [];
      return (
        <>
          <Pick label="Sketch" value={f.sketch} options={sketches.map((s) => [s.id, s.name])} onChange={(v) => onChange({ sketch: v, line: undefined } as Partial<DesignItem>)} />
          {lines.length > 1 && <Pick label="Bend line" value={f.line ?? lines[0].id} options={lines.map((e, i) => [e.id, `Line ${i + 1}`])} onChange={(line) => onChange({ line } as Partial<DesignItem>)} />}
          <Expr label="Bend angle" value={f.angle} onChange={(angle) => onChange({ angle } as Partial<DesignItem>, 'angle')} />
          <Pick label="Bend line is" value={f.placement ?? 'centre'} options={[['centre', 'The middle of the bend'], ['start', 'Where the bend starts'], ['end', 'Where the bend ends']]} onChange={(placement) => onChange({ placement: placement === 'centre' ? undefined : placement } as Partial<DesignItem>)} />
          <label className="check"><input type="checkbox" checked={!!f.down} onChange={(e) => onChange({ down: e.target.checked || undefined } as Partial<DesignItem>)} /> Bend away from the sketch’s side</label>
          {flip('The other side moves')}
          <p className="hint">The sheet is made again from its flanges: cut-outs through it go along, other features made on it before the bend do not.</p>
          {ruleLine}
        </>
      );
    }
  }
}

/** The rules dialog's fields; the numbers they give (t, R, K of a sheet feature as resolved) for what BA and DIN 6935 say. */
export function RulesFields({ rules, onChange, numbers }: { rules: SheetRules; onChange: (r: SheetRules, key?: string) => void; numbers?: Record<string, number> }) {
  const set = (p: Partial<SheetRules>, key?: string) => onChange({ ...rules, ...p }, key);
  const mat = sheetMaterial(rules.material);
  const p = numbers;
  const din = p && din6935(Math.PI / 2, p.R, p.t);
  return (
    <>
      <Pick label="Material" value={mat.key} options={SHEET_MATERIALS.map((m) => [m.key, `${m.name} (K = ${m.K})`])} onChange={(material) => set({ material })} />
      <Expr label="Thickness t" value={rules.t} onChange={(t) => set({ t }, 't')} />
      <Expr label="Inner bend radius R" value={rules.r} onChange={(r) => set({ r }, 'r')} />
      <Expr label="K-factor" value={rules.k ?? ''} placeholder={String(mat.K)} onChange={(k) => set({ k: k || undefined }, 'k')} hint="Where the fibre that keeps its length lies, as a fraction of t from the inside of the bend: BA = θ·(R + K·t)" />
      <Pick label="Bend relief" value={rules.relief ?? 'rect'} options={[['rect', 'Rectangular'], ['round', 'Round end'], ['tear', 'Tear (no cut)']]} onChange={(relief) => set({ relief })} />
      {rules.relief !== 'tear' && (
        <div className="row2">
          <Expr label="Relief width" value={rules.reliefW ?? ''} placeholder="t" onChange={(reliefW) => set({ reliefW: reliefW || undefined }, 'rw')} />
          <Expr label="Past the bend" value={rules.reliefD ?? ''} placeholder="t" onChange={(reliefD) => set({ reliefD: reliefD || undefined }, 'rd')} />
        </div>
      )}
      <Pick label="Corner relief" value={rules.corner ?? 'none'} options={[['none', 'None (open corner)'], ['square', 'Square'], ['round', 'Round']]} onChange={(corner) => set({ corner })} />
      {rules.corner && rules.corner !== 'none' && <Expr label="Corner relief size" value={rules.cornerS ?? ''} placeholder="R + t" onChange={(cornerS) => set({ cornerS: cornerS || undefined }, 'cs')} />}
      {p && (
        <table className="props-table"><tbody>
          <tr><td>BA at 90°</td><td>{num(bendAllowance(Math.PI / 2, p.R, p.K, p.t))} = (π/2)·(R + K·t)</td></tr>
          {din && <tr><td>DIN 6935</td><td>k = {num(din.k, 4)}, v(90°) = {num(din.v)}</td></tr>}
        </tbody></table>
      )}
      <p className="hint">K-factors: steel 0.44 is the K-factor of Fusion’s built-in rules; the others are typical air-bending values for R from t to 3t (generic K-factor charts give 0.40–0.45 there, softer metals lower). A test bend gives the K-factor of your tooling. Choosing a material also sets the component’s density for the blank’s mass.</p>
    </>
  );
}

// ------------------------------------------------------------ the flat pattern

/** The sheet-metal bodies of a component (they have a flat pattern in the results). */
export const sheetBodiesOf = (dr: DesignResult | undefined, cid: string | undefined) => (cid ? (dr?.bodies[cid] ?? []).filter((b) => b.flat) : []);

/** Fetch the flat pattern of a body (again when the part changes). */
export function useFlatPattern(design: CadDesign, dr: DesignResult | undefined, cid: string | undefined, body: string | undefined) {
  const [state, setState] = useState<{ fp: FlatPattern | null; error?: string; busy: boolean }>({ fp: null, busy: true });
  useEffect(() => {
    if (!dr || !cid || !body) return;
    let live = true;
    setState((s) => ({ ...s, busy: true }));
    kernelRequest({ op: 'flat', design, numbers: designNumbers(dr), component: cid, body }, 'flat').then(
      (fp) => live && setState({ fp, busy: false }),
      (e) => live && !isSuperseded(e) && setState({ fp: null, busy: false, error: (e as Error).message }),
    );
    return () => {
      live = false;
    };
    // the part as built, not every keystroke elsewhere
  }, [dr?.display, cid, body]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

export async function exportFlat(fp: FlatPattern, format: 'dxf' | 'svg', unit: string, base: string) {
  if (format === 'dxf') await exportFile(`${base}-flat.dxf`, flatDxf(fp, unit), 'application/dxf');
  else await exportFile(`${base}-flat.svg`, flatSvg(fp, unit), 'image/svg+xml');
}

/** The flat pattern over the 3-D view: the blank, its bend lines and notes, the bend table and its values. */
export function FlatPanel({ design, dr, comp, unit, base, onClose }: { design: CadDesign; dr?: DesignResult; comp?: CadComponent; unit: string; base: string; onClose: () => void }) {
  const bodies = sheetBodiesOf(dr, comp?.id);
  const [pick, setPick] = useState<string | undefined>();
  const body = bodies.find((b) => b.id === pick)?.id ?? bodies[0]?.id;
  const { fp, error, busy } = useFlatPattern(design, dr, comp?.id, body);
  const density = comp && dr?.params[comp.id]?.density;
  const view = useMemo(() => {
    if (!fp) return null;
    const b = fp.numbers.box, pad = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.06 + 1e-9;
    const H = b.y0 + b.y1;
    const path = (loops: FlatPattern['outer']) => loops.map((l) => l.map((q) => primPath(q, H)).join('')).join('');
    return { vb: `${b.x0 - pad} ${b.y0 - pad} ${b.x1 - b.x0 + 2 * pad} ${b.y1 - b.y0 + 2 * pad}`, outer: path(fp.outer), inner: path(fp.inner), H, size: Math.max(b.x1 - b.x0, b.y1 - b.y0) };
  }, [fp]);
  const L = fp ? fp.numbers.box.x1 - fp.numbers.box.x0 : 0, W = fp ? fp.numbers.box.y1 - fp.numbers.box.y0 : 0;
  return (
    <div className="cadw-flat" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label="Flat pattern">
      <div className="cadw-flat-head">
        <b>Flat pattern</b>
        {bodies.length > 1 && (
          <select value={body} onChange={(e) => setPick(e.target.value)} aria-label="Body">
            {bodies.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
        {bodies.length === 1 && <span>{bodies[0].name}</span>}
        <span className="cadw-spacer" />
        <button className="btn" disabled={!fp} onClick={() => fp && exportFlat(fp, 'dxf', unit, base)}><Download size={14} /> DXF</button>
        <button className="btn" disabled={!fp} onClick={() => fp && exportFlat(fp, 'svg', unit, base)}><Download size={14} /> SVG</button>
        <button className="icon-btn" onClick={onClose} aria-label="Close the flat pattern"><X size={14} /></button>
      </div>
      {!bodies.length && <p className="hint">This component has no sheet-metal body: make one with Flange (the flat pattern needs OpenCascade).</p>}
      {error && <div className="region-error">{error}</div>}
      {bodies.length > 0 && !fp && !error && <p className="hint">{busy ? 'Unfolding…' : ''}</p>}
      {fp && view && (
        <div className="cadw-flat-body">
          <svg className="cadw-flat-svg" viewBox={view.vb} preserveAspectRatio="xMidYMid meet" aria-label="Flat blank">
            <path d={view.outer} className="cadw-flat-outer" style={{ strokeWidth: view.size / 400 }} />
            <path d={view.inner} className="cadw-flat-inner" style={{ strokeWidth: view.size / 400 }} />
            {fp.numbers.bends.map((b) => {
              const rot = (Math.atan2(b.b.y - b.a.y, b.b.x - b.a.x) * 180) / Math.PI;
              const r = rot > 90 ? rot - 180 : rot <= -90 ? rot + 180 : rot;
              const x = (b.a.x + b.b.x) / 2, y = view.H - (b.a.y + b.b.y) / 2, h = view.size / 45;
              return (
                <g key={b.tag}>
                  <path d={primPath({ k: 'line', x1: b.a.x, y1: b.a.y, x2: b.b.x, y2: b.b.y }, view.H)} className="cadw-flat-bend" style={{ strokeWidth: view.size / 600, strokeDasharray: `${view.size / 60} ${view.size / 120}` }} />
                  <text x={x} y={y - h * 0.5} fontSize={h} textAnchor="middle" transform={`rotate(${-r} ${x} ${y})`} className="cadw-flat-note">{bendNote(b, fmtLen)}</text>
                </g>
              );
            })}
          </svg>
          <div className="cadw-flat-side">
            <table className="props-table"><tbody>
              <tr><td>Blank</td><td>{num(L)} × {num(W)} {unit}</td></tr>
              <tr><td>Area</td><td>{num(fp.area)} {unit}²</td></tr>
              {density ? <tr><td>Mass</td><td>{num(fp.area * fp.numbers.t * density, 4)} kg</td></tr> : null}
              <tr><td>t, K</td><td>{num(fp.numbers.t)} {unit}, {fp.numbers.K}</td></tr>
              <tr><td>Bends</td><td>{fp.numbers.bends.length}{fp.inner.length ? `, ${fp.inner.length} cut-out${fp.inner.length > 1 ? 's' : ''}` : ''}</td></tr>
            </tbody></table>
            {fp.numbers.bends.length > 0 && (
              <table className="props-table cadw-flat-table">
                <thead><tr><th>#</th><th>Angle</th><th>R</th><th>Dir.</th><th>BA</th><th title="DIN 6935 compensation for legs measured outside (information)">v DIN</th></tr></thead>
                <tbody>
                  {fp.numbers.bends.map((b, i) => (
                    <tr key={b.tag}><td>{i + 1}</td><td>{num(b.angle, 4)}°</td><td>{num(b.R)}</td><td>{b.up ? 'up' : 'down'}</td><td>{num(b.BA)}</td><td>{b.din ? num(b.din.v) : '–'}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="hint">BA = θ·(R + K·t). Up and down as seen from this side; the bend lines are the middles of the bends.</p>
            {fp.warnings.map((w) => <p key={w} className="hint warn">{w}</p>)}
          </div>
        </div>
      )}
    </div>
  );
}
