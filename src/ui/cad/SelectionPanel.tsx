// The inspector of the faces and edges picked in the 3-D view: what each one is (surface
// or curve type, area, radius, axis, length), totals for several, and for two of them
// their angle, gap and the exact smallest distance from the kernel.
import { useEffect, useState } from 'react';
import { Ruler, X } from 'lucide-react';
import type { BuildResult, EdgeInfo, FaceInfo } from '../../cad/buildResult';
import type { CadDesign } from '../../cad/design';
import type { CadResult } from '../../cad/evaluate';
import { designNumbers } from '../../cad/keys';
import type { Distance, EntityRef } from '../../cad/kernel/protocol';
import { bodyOf, pickGeometry, pickId, relation, type Pick, type Selection } from '../../cad/selection';
import { m4Dir, norm3, type Vec3 } from '../../cad/solid';
import { fmtNum } from './cadRender';
import { isSuperseded, kernelRequest } from './kernelClient';
import { num } from './SketchPanel';

const SURFACE: Record<string, string> = { plane: 'Plane', cylinder: 'Cylinder', cone: 'Cone', sphere: 'Sphere', torus: 'Torus', bspline: 'Freeform', other: 'Surface' };
const CURVE: Record<string, string> = { line: 'Line', circle: 'Circle', ellipse: 'Ellipse', bspline: 'Spline', other: 'Curve' };
const deg = (a: number) => `${num((a * 180) / Math.PI, 5)}°`;
const vec = (v: Vec3) => v.map((x) => fmtNum(Math.abs(x) < 1e-12 ? 0 : x)).join(', ');

/** Short name of a pick: "Cylinder face", "Circle edge". */
export function pickLabel(p: Pick): string {
  return p.kind === 'face' ? `${SURFACE[p.type] ?? 'Surface'} face` : `${CURVE[p.type] ?? 'Curve'} edge`;
}

/** Rows describing a face or edge (directions turned into assembly coordinates by M). */
function facts(info: FaceInfo | EdgeInfo, M: number[], u: string): [string, string][] {
  const dir = (d: Vec3) => vec(norm3(m4Dir(M, d)));
  const rows: [string, string][] = [];
  if ('area' in info) {
    rows.push(['Area', `${num(info.area)} ${u}²`]);
    if (info.frame) rows.push(['Normal', dir(info.frame.n)]);
    if (info.radius !== undefined) rows.push([info.type === 'torus' ? 'Major radius' : 'Radius', `${num(info.radius)} ${u}`]);
    if (info.radius !== undefined && (info.type === 'cylinder' || info.type === 'sphere')) rows.push(['Diameter', `${num(2 * info.radius)} ${u}`]);
    if (info.minorRadius !== undefined) rows.push(['Minor radius', `${num(info.minorRadius)} ${u}`]);
    if (info.angle !== undefined) rows.push(['Half angle', deg(info.angle)]);
    if (info.axis && info.type !== 'sphere') rows.push(['Axis', dir(info.axis.d)]);
  } else {
    rows.push(['Length', `${num(info.length)} ${u}`]);
    if (info.circle) {
      rows.push(['Radius', `${num(info.circle.r)} ${u}`], ['Diameter', `${num(2 * info.circle.r)} ${u}`]);
      rows.push(['Axis', dir(info.circle.axis)]);
    }
    if (info.line) rows.push(['Direction', dir([info.line.b[0] - info.line.a[0], info.line.b[1] - info.line.a[1], info.line.b[2] - info.line.a[2]])]);
  }
  return rows;
}

const asRef = (p: Pick): EntityRef => ({ kind: p.kind, occ: p.occ, body: p.body, index: p.index });

/** The occurrence a pick is in, named as in the browser; only said in an assembly (bodies share names). */
function occurrenceName(design: CadDesign, id: string): string {
  const o = design.occurrences.find((q) => q.id === id);
  if (!o || design.occurrences.length < 2) return '';
  const c = design.components.find((q) => q.id === o.component);
  return o.name || `${c?.name ?? '?'}:${design.occurrences.filter((q) => q.component === o.component).indexOf(o) + 1}`;
}

export function SelectionPanel({ picks, build, design, result, unit, onBody, onClear }: {
  picks: Selection; build: BuildResult; design: CadDesign; result?: CadResult; unit: string;
  onBody: (occ: string, body: string) => void; onClear: () => void;
}) {
  const u = unit;
  const [dist, setDist] = useState<{ ids: string; d: Distance | null; error?: string } | null>(null);
  const ids = picks.map(pickId).join(' ');
  useEffect(() => setDist(null), [ids]);
  const shown = picks.slice(0, 6);
  const faces = picks.filter((p) => p.kind === 'face'), edges = picks.filter((p) => p.kind === 'edge');
  const area = faces.reduce((s, p) => s + (bodyOf(build, design, p.occ, p.body)?.faces[p.index]?.area ?? 0), 0);
  const length = edges.reduce((s, p) => s + (bodyOf(build, design, p.occ, p.body)?.edges[p.index]?.length ?? 0), 0);
  const pair = picks.length === 2 ? [pickGeometry(build, design, picks[0]), pickGeometry(build, design, picks[1])] : null;
  const rel = pair?.[0] && pair[1] ? relation(pair[0], pair[1]) : null;
  const measure = () => {
    const dr = result?.design;
    if (!dr || picks.length !== 2) return;
    kernelRequest({ op: 'distance', design, numbers: designNumbers(dr), a: asRef(picks[0]), b: asRef(picks[1]) }, 'distance').then(
      (d) => setDist({ ids, d }),
      (e) => !isSuperseded(e) && setDist({ ids, d: null, error: (e as Error).message }),
    );
  };
  return (
    <div className="props">
      <h3 className="sub">Selection · {faces.length ? `${faces.length} face${faces.length > 1 ? 's' : ''}` : ''}{faces.length && edges.length ? ', ' : ''}{edges.length ? `${edges.length} edge${edges.length > 1 ? 's' : ''}` : ''}</h3>
      <ul className="cadw-sel">
        {shown.map((p) => {
          const b = bodyOf(build, design, p.occ, p.body);
          const info = p.kind === 'face' ? b?.faces[p.index] : b?.edges[p.index];
          const M = build.placements[p.occ]?.matrix;
          if (!b || !info || !M) return null;
          const occ = occurrenceName(design, p.occ);
          return (
            <li key={pickId(p)}>
              <div className="cadw-sel-title">{pickLabel(p)} <em>on <button className="link" onClick={() => onBody(p.occ, p.body)}>{b.name}</button>{occ && ` · ${occ}`}</em></div>
              <table className="props-table"><tbody>
                {facts(info, M, u).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}
              </tbody></table>
            </li>
          );
        })}
      </ul>
      {picks.length > shown.length && <p className="hint">… and {picks.length - shown.length} more</p>}
      {picks.length > 1 && (
        <table className="props-table"><tbody>
          {faces.length > 1 && <tr><td>Total area</td><td>{num(area)} {u}²</td></tr>}
          {edges.length > 1 && <tr><td>Total length</td><td>{num(length)} {u}</td></tr>}
          {rel?.angle !== undefined && <tr><td>Angle</td><td>{deg(rel.angle)}</td></tr>}
          {rel?.gap !== undefined && <tr><td>Parallel, apart</td><td>{num(rel.gap)} {u}</td></tr>}
          {dist?.ids === ids && dist.d && <tr><td>Smallest distance</td><td><b>{num(dist.d.d)}</b> {u}{dist.d.exact ? '' : ' (mesh)'}</td></tr>}
        </tbody></table>
      )}
      {dist?.ids === ids && dist.error && <div className="region-error">{dist.error}</div>}
      <p className="hint">Shift-click adds faces and edges, or takes them out again.</p>
      <div className="cadd-actions">
        {picks.length === 2 && <button className="btn" onClick={measure} title="The smallest distance between the two, on the exact geometry"><Ruler size={13} /> Distance</button>}
        <button className="btn" onClick={onClear}><X size={13} /> Clear</button>
      </div>
    </div>
  );
}
