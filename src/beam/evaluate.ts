// Evaluates a beam region in the worksheet: load and section expressions are read from
// the worksheet scope, the structure is solved, and reactions, extremes and (for a
// straight horizontal beam) the functions M(x), V(x), N(x), w(x) are exported under
// the region's name.
import type { Unit } from 'mathjs';
import type { BeamRegion } from '../model/types';
import { math, isUnit } from '../engine/math';
import type { BeamSection } from './model';
import { memberAt, solveStructure, StructureError, type BeamSolution, type NumLoad, type NumMember, type NumStructure } from './solve';

export interface BeamResult {
  kind: 'beam';
  solution?: BeamSolution;
  /** Load id → evaluated values in SI (force N, moment N·m, line load q1/q2 N/m). */
  values: Record<string, number[]>;
  /** Item id (load, member, 'section') → problem with its expression. */
  errors: Record<string, string>;
  /** Default section in SI (E Pa, A m², I m⁴, W m³). */
  section?: { E: number; A: number; I: number; W?: number };
  error?: string;
}

const LENGTH_TO_M: Record<string, number> = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 };

type Eval = (src: string) => unknown;

/** An expression in the given dimension; bare numbers take the default unit. */
function quantity(evalExpr: Eval, src: string, base: string, fallback: string, what: string): number {
  const v = evalExpr(src.trim() || '0');
  const u = typeof v === 'number' ? math.unit(v, fallback) : isUnit(v) ? (v as Unit) : null;
  if (!u) throw new Error(`${what}: expected a number`);
  if (!u.equalBase(math.unit(base))) throw new Error(`${what}: expected units like ${fallback}, got ${u.formatUnits()}`);
  const n = u.toNumeric(base) as number;
  if (!Number.isFinite(n)) throw new Error(`${what}: not a finite number`);
  return n;
}

export function sectionValues(evalExpr: Eval, s: BeamSection): { E: number; A: number; I: number; W?: number } {
  const E = quantity(evalExpr, s.E, 'Pa', 'GPa', 'E');
  const A = quantity(evalExpr, s.A, 'm^2', 'cm^2', 'A');
  const I = quantity(evalExpr, s.I, 'm^4', 'cm^4', 'I');
  const W = s.W?.trim() ? quantity(evalExpr, s.W, 'm^3', 'cm^3', 'W') : undefined;
  if (!(E > 0 && A > 0 && I > 0)) throw new Error('E, A and I must be positive');
  return { E, A, I, ...(W && W > 0 ? { W } : {}) };
}

export function solveBeam(r: BeamRegion, evalExpr: Eval): BeamResult {
  const res: BeamResult = { kind: 'beam', values: {}, errors: {} };
  const k = LENGTH_TO_M[r.lengthUnit] ?? 1;
  const F = r.forceUnit;
  try {
    res.section = sectionValues(evalExpr, r.section);
  } catch (e) {
    res.errors.section = (e as Error).message;
  }
  const members: NumMember[] = [];
  for (const m of r.members) {
    let sec = res.section;
    if (m.section) {
      try {
        sec = sectionValues(evalExpr, m.section);
      } catch (e) {
        res.errors[m.id] = (e as Error).message;
        sec = undefined;
      }
    }
    if (sec) members.push({ id: m.id, a: m.a, b: m.b, ...sec, hingeA: m.hingeA, hingeB: m.hingeB });
  }
  const loads: NumLoad[] = [];
  for (const l of r.loads) {
    try {
      if (l.type === 'force') {
        const P = quantity(evalExpr, l.value, 'N', F, 'Force');
        const a = (l.angle * Math.PI) / 180;
        res.values[l.id] = [P];
        loads.push({ id: l.id, type: 'force', at: l.at, Fx: P * Math.cos(a), Fy: P * Math.sin(a) });
      } else if (l.type === 'moment') {
        const M = quantity(evalExpr, l.value, 'N m', `${F} ${r.lengthUnit}`, 'Moment');
        res.values[l.id] = [M];
        loads.push({ id: l.id, type: 'moment', at: l.at, M });
      } else {
        const q1 = quantity(evalExpr, l.q1, 'N/m', `${F}/${r.lengthUnit}`, 'Line load');
        const q2 = l.q2?.trim() ? quantity(evalExpr, l.q2, 'N/m', `${F}/${r.lengthUnit}`, 'Line load (end)') : q1;
        res.values[l.id] = [q1, q2];
        loads.push({ id: l.id, type: 'line', member: l.member, t1: l.t1 ?? 0, t2: l.t2 ?? 1, q1, q2, dir: l.dir });
      }
    } catch (e) {
      res.errors[l.id] = (e as Error).message;
    }
  }
  if (!r.members.length) return res;
  const firstError = Object.values(res.errors)[0];
  if (members.length < r.members.length) {
    res.error = firstError ?? 'A member has no section';
    return res;
  }
  const st: NumStructure = {
    nodes: r.nodes.map((q) => ({ id: q.id, x: q.x * k, y: q.y * k })),
    members,
    supports: r.supports.map((s) => ({ id: s.id, node: s.node, type: s.type, angle: (s.angle * Math.PI) / 180, label: s.label })),
    loads,
  };
  try {
    res.solution = solveStructure(st);
  } catch (e) {
    res.error = e instanceof StructureError ? e.message : `Could not solve: ${(e as Error).message}`;
  }
  return res;
}

/** The members of a straight horizontal beam, left to right, or null for anything else. */
export function straightBeam(r: BeamRegion): { id: string; x0: number; x1: number; flip: boolean }[] | null {
  if (!r.members.length) return null;
  const N = new Map(r.nodes.map((q) => [q.id, q]));
  const y0 = N.get(r.members[0].a)?.y;
  const segs: { id: string; x0: number; x1: number; flip: boolean }[] = [];
  for (const m of r.members) {
    const a = N.get(m.a), b = N.get(m.b);
    if (!a || !b || Math.abs(a.y - y0!) > 1e-9 || Math.abs(b.y - y0!) > 1e-9) return null;
    segs.push({ id: m.id, x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), flip: b.x < a.x });
  }
  segs.sort((p, q) => p.x0 - q.x0);
  for (let i = 1; i < segs.length; i++) if (Math.abs(segs[i].x0 - segs[i - 1].x1) > 1e-9) return null;
  return segs;
}

/** Worksheet value: reactions per support, extremes and functions along a straight beam. */
export function beamValue(r: BeamRegion, res: BeamResult): Record<string, unknown> {
  const sol = res.solution;
  if (!sol) return {};
  const F = r.forceUnit, Lu = r.lengthUnit;
  const metric = Lu === 'm' || Lu === 'cm' || Lu === 'mm';
  const force = (v: number) => math.unit(v, 'N').to(F);
  const moment = (v: number) => math.unit(v, 'N m').to(`${F} ${Lu}`);
  const defl = (v: number) => math.unit(v, 'm').to(metric ? 'mm' : 'in');
  const value: Record<string, unknown> = {};
  for (const q of sol.reactions) {
    value[q.label] = { Rx: force(q.Rx), Ry: force(q.Ry), M: moment(q.M), R: force(Math.hypot(q.Rx, q.Ry)) };
  }
  if (sol.max.M) value.M_max = moment(sol.max.M.value);
  if (sol.max.V) value.V_max = force(sol.max.V.value);
  if (sol.max.N) value.N_max = force(sol.max.N.value);
  if (sol.max.w) value.w_max = defl(sol.max.w.value);
  if (sol.max.sigma) value.σ_max = value.sigma_max = math.unit(sol.max.sigma.value, 'Pa').to('MPa');
  const segs = straightBeam(r);
  if (segs) {
    const k = LENGTH_TO_M[Lu] ?? 1;
    const byId = new Map(sol.members.map((m) => [m.id, m]));
    const at = (x: unknown) => {
      const xs = typeof x === 'number' ? x : isUnit(x) ? ((x as Unit).toNumeric(Lu) as number) : NaN;
      if (!Number.isFinite(xs)) throw new Error('x must be a length');
      const seg = segs.find((s) => xs <= s.x1 + 1e-12) ?? segs[segs.length - 1];
      if (xs < segs[0].x0 - 1e-9 || xs > segs[segs.length - 1].x1 + 1e-9) throw new Error(`x is outside the beam (${segs[0].x0} … ${segs[segs.length - 1].x1} ${Lu})`);
      const mr = byId.get(seg.id)!;
      const sLocal = (seg.flip ? seg.x1 - xs : xs - seg.x0) * k;
      const v = memberAt(mr, sLocal);
      // a member drawn right to left has its local y pointing down: sagging reads negative there
      return { ...v, M: seg.flip ? -v.M : v.M };
    };
    value.M = (x: unknown) => moment(at(x).M);
    value.V = (x: unknown) => force(at(x).V);
    value.N = (x: unknown) => force(at(x).N);
    value.w = (x: unknown) => defl(at(x).dy);
    value.L = math.unit(segs[segs.length - 1].x1 - segs[0].x0, Lu);
  }
  return value;
}
