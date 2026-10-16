// Evaluates a 3-D frame region in the worksheet: coordinates, sections, supports and
// loads are read from the worksheet scope, the frame is solved per load case and
// combination (first or second order, with buckling), and reactions, displacements,
// member extremes, the internal forces along each member and α_cr are exported under
// the region's name.
import type { Unit } from 'mathjs';
import type { Frame3DRegion } from '../model/types';
import { math, isUnit } from '../engine/math';
import { sectionProps } from '../engine/sections';
import { concreteGrade, STEEL_GRADES, timberGrade } from '../engine/materials';
import { quantity } from '../beam/evaluate';
import { loadCase } from '../beam/model';
import { shearModulus, SHEAR_FACTOR } from '../beam/shear';
import { identifierOf } from '../beam/traffic';
import {
  FORCES, InstabilityError, memberAt3, memberAxes, memberExtremes, solveFrame3, StructureError,
  type Axes, type ForceKey, type FrameSolution, type Member3Result, type NumFrame, type NumLoad3, type NumMember3, type NumSupport3, type Vec3,
} from './solve';
import { buckling3, type Buckling3Result } from './buckling';
import { RELEASES, type F3Dir, type F3Section } from './model';

type Eval = (src: string) => unknown;

/** Section and material values in SI (m², m⁴, m³, Pa, kg/m³). */
export interface Section3SI {
  A: number;
  Iy: number;
  Iz: number;
  It: number;
  Avy?: number;
  Avz?: number;
  Wy?: number;
  Wz?: number;
  E: number;
  G: number;
  rho: number;
}

/** A load as drawn: where it acts and its global vector(s) in SI. */
export type LoadGlyph3 =
  | { id: string; kind: 'node'; node: string; F: Vec3; M: Vec3; case?: string }
  | { id: string; kind: 'point'; member: string; t: number; F: Vec3; moment: boolean; case?: string }
  | { id: string; kind: 'line'; member: string; t1: number; t2: number; q1: Vec3; q2: Vec3; case?: string };

export interface Case3Result {
  id: string;
  name: string;
  kind?: 'ULS' | 'SLS';
  /** Lowest α_cr of the case or combination (with buckling on). */
  alpha?: number;
  error?: string;
  /** Kept on the worker side only (dropped before the result goes to the page). */
  solution?: FrameSolution;
  buckling?: Buckling3Result;
}

export interface Frame3DResult {
  kind: 'frame3d';
  /** Node positions (m) and member geometry, as evaluated. */
  pos: Record<string, Vec3>;
  geometry: Record<string, { L: number; axes: Axes }>;
  /** Section values by section id. */
  sections: Record<string, Section3SI>;
  loads: LoadGlyph3[];
  /** What is shown: the only solution, or the chosen case / combination / envelope (max side). */
  solution?: FrameSolution;
  /** The envelope's lower side, when it is shown. */
  lower?: FrameSolution;
  cases?: Case3Result[];
  combos?: Case3Result[];
  /** Case id, combination id or 'envelope'. */
  view?: string;
  buckling?: Buckling3Result;
  analysis?: { shear: boolean; secondOrder: boolean; buckling: boolean };
  /** Item id (node, member, section, support, load, 'names') → problem with it. */
  errors: Record<string, string>;
  error?: string;
  /** Solving time, ms. */
  millis?: number;
}

const LENGTH_TO_M: Record<string, number> = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 };
const PLAIN = /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i;

/** g of EN 1991-1-1 unit weights (25 kN/m³ reinforced concrete). */
const GRAVITY = 9.80665;

/** E, G (Pa) and ρ (kg/m³) of a material class: steel EN 1993-1-1 3.2.6, concrete EN 1992-1-1 Table 3.1 (ν = 0.2, 25 kN/m³), timber EN 338 / EN 14080. */
export function materialValues(name: string): { E: number; G: number; rho: number } {
  const key = name.trim().toUpperCase().replace(/\s+/g, '');
  if (STEEL_GRADES.some((g) => key.startsWith(g))) return { E: 210e9, G: shearModulus(210e9, 'steel'), rho: 7850 };
  if (/^C\d/.test(key) && key.includes('/')) {
    const c = concreteGrade(name);
    return { E: c.E_cm * 1e9, G: shearModulus(c.E_cm * 1e9, 'concrete'), rho: 25e3 / GRAVITY };
  }
  const t = timberGrade(name);
  return { E: t.E_0_mean * 1e9, G: t.G_mean * 1e9, rho: t.rho_mean };
}

/**
 * Values of a profile from the library, SI. The shear areas: V_z along the web
 * EN 1993-1-1 6.2.6(3)a (the library's A_vz), V_y along the flanges A − h_w t_w (6.2.6(3)e,
 * written for welded sections, used for rolled ones too); hollow sections 2A/π and A b/(b + h).
 */
export function profileValues(name: string): Pick<Section3SI, 'A' | 'Iy' | 'Iz' | 'It' | 'Avy' | 'Avz' | 'Wy' | 'Wz'> {
  const p = sectionProps(name);
  const A = p.A * 1e-6;
  const Avy = p.family === 'I' ? (p.A - (p.h - 2 * p.t_f) * p.t_w) * 1e-6 : p.family === 'CHS' ? SHEAR_FACTOR.chs * A : (p.A * p.b) / (p.b + p.h) * 1e-6;
  return { A, Iy: p.I_y * 1e-12, Iz: p.I_z * 1e-12, It: p.I_t * 1e-12, Avy, Avz: p.A_vz * 1e-6, Wy: p.W_el_y * 1e-9, Wz: p.W_el_z * 1e-9 };
}

export function sectionValues3(evalExpr: Eval, s: F3Section): Section3SI {
  const q = (src: string | undefined, base: string, unit: string, what: string) => quantity(evalExpr, src ?? '', base, unit, what);
  const opt = (src: string | undefined, base: string, unit: string, what: string) => (src?.trim() ? q(src, base, unit, what) : undefined);
  const geo = s.profile ? profileValues(s.profile) : {
    A: q(s.A, 'm^2', 'cm^2', 'A'), Iy: q(s.Iy, 'm^4', 'cm^4', 'I_y'), Iz: q(s.Iz, 'm^4', 'cm^4', 'I_z'), It: q(s.It, 'm^4', 'cm^4', 'I_t'),
    Avy: opt(s.Avy, 'm^2', 'cm^2', 'A_vy'), Avz: opt(s.Avz, 'm^2', 'cm^2', 'A_vz'), Wy: opt(s.Wy, 'm^3', 'cm^3', 'W_y'), Wz: opt(s.Wz, 'm^3', 'cm^3', 'W_z'),
  };
  if (s.profile) {
    // a value typed over the profile's wins
    for (const [key, base, unit] of [['Avy', 'm^2', 'cm^2'], ['Avz', 'm^2', 'cm^2']] as const) {
      const v = opt(s[key], base, unit, key);
      if (v !== undefined) geo[key] = v;
    }
  }
  let mat: { E: number; G: number; rho: number };
  if (s.material && s.material !== 'custom') mat = materialValues(s.material);
  else {
    const E = q(s.E, 'Pa', 'GPa', 'E');
    mat = { E, G: s.G?.trim() ? q(s.G, 'Pa', 'GPa', 'G') : shearModulus(E, 'steel'), rho: s.rho?.trim() ? q(s.rho, 'kg/m^3', 'kg/m^3', 'ρ') : 0 };
  }
  const out = { ...geo, ...mat };
  if (!(out.A > 0 && out.Iy > 0 && out.Iz > 0 && out.It > 0 && out.E > 0 && out.G > 0)) throw new Error('A, I_y, I_z, I_t, E and G must be positive');
  return out;
}

/** A direction "x, y, z" or an axis name (X, −Y …). */
function parseDirection(src: string): Vec3 {
  const t = src.trim().replace(/−/g, '-');
  const axis = /^([+-]?)([XYZ])$/i.exec(t);
  if (axis) {
    const v: Vec3 = [0, 0, 0];
    v['XYZ'.indexOf(axis[2].toUpperCase())] = axis[1] === '-' ? -1 : 1;
    return v;
  }
  const parts = t.split(/[\s,;]+/).filter(Boolean).map(Number);
  if (parts.length !== 3 || !parts.every(Number.isFinite) || !parts.some((v) => v !== 0)) throw new Error('Reference direction: give three numbers "x, y, z" or an axis (X, −Y …)');
  return parts as Vec3;
}

const axisOf = (d: F3Dir): Vec3 => {
  const v: Vec3 = [0, 0, 0];
  v['XYZ'.indexOf(d.toUpperCase())] = 1;
  return v;
};

export function solveFrame3D(r: Frame3DRegion, evalExpr: Eval): Frame3DResult {
  const t0 = performance.now();
  const res: Frame3DResult = { kind: 'frame3d', pos: {}, geometry: {}, sections: {}, loads: [], errors: {} };
  const k = LENGTH_TO_M[r.lengthUnit] ?? 1;
  const F = r.forceUnit, Lu = r.lengthUnit;
  const an = r.analysis ?? {};
  const withShear = !!an.shear, second = !!an.secondOrder, wantBuckling = !!an.buckling || second;
  if (r.analysis) res.analysis = { shear: withShear, secondOrder: second, buckling: wantBuckling };
  const fail = (id: string, e: unknown) => (res.errors[id] = (e as Error).message);
  // plain numbers skip the expression engine (big frames have thousands of coordinates)
  const length = (src: string, what: string) => (PLAIN.test(src) ? Number(src) * k : quantity(evalExpr, src, 'm', Lu, what));

  // names are worksheet keys: they must be distinct
  const names = new Map<string, number>();
  for (const q of [...r.nodes, ...r.members]) names.set(q.name.trim(), (names.get(q.name.trim()) ?? 0) + 1);
  const dup = [...names].find(([n, c]) => c > 1 && n);
  if (dup) res.errors.names = `Two items are named ${dup[0]}: give each node and member its own name`;

  for (const n of r.nodes) {
    try {
      res.pos[n.id] = [length(n.x, `${n.name} x`), length(n.y, `${n.name} y`), length(n.z, `${n.name} z`)];
    } catch (e) {
      fail(n.id, e);
    }
  }
  for (const s of r.sections) {
    try {
      res.sections[s.id] = sectionValues3(evalExpr, s);
    } catch (e) {
      fail(s.id, e);
    }
  }
  const members: NumMember3[] = [];
  for (const m of r.members) {
    try {
      const sec = res.sections[m.section];
      if (!sec) throw new Error(r.sections.some((s) => s.id === m.section) ? 'Its section has an error' : 'Choose a section');
      const a = res.pos[m.a], b = res.pos[m.b];
      if (!a || !b) throw new Error('A node of the member is missing or has an error');
      let beta = 0;
      if (m.beta?.trim()) {
        const v = evalExpr(m.beta);
        beta = typeof v === 'number' ? (v * Math.PI) / 180 : isUnit(v) ? ((v as Unit).toNumeric('rad') as number) : NaN;
        if (!Number.isFinite(beta)) throw new Error('β: expected an angle');
      }
      const ref = m.ref?.trim() ? parseDirection(m.ref) : undefined;
      const geo = memberAxes(a, b, beta, ref);
      if (!(geo.L > 0)) throw new Error('The member has zero length');
      res.geometry[m.id] = { L: geo.L, axes: geo.R };
      const rel = (list?: string[]) => (list?.length ? RELEASES.map((q) => list.includes(q)) : undefined);
      members.push({
        id: m.id, name: m.name, a: m.a, b: m.b, E: sec.E, G: sec.G, A: sec.A, Iy: sec.Iy, Iz: sec.Iz, It: sec.It, Wy: sec.Wy, Wz: sec.Wz,
        // shear deformation: the section's shear areas, 5/6 A without them
        ...(withShear ? { Avy: sec.Avy ?? SHEAR_FACTOR.rect * sec.A, Avz: sec.Avz ?? SHEAR_FACTOR.rect * sec.A } : {}),
        beta, ref, relA: rel(m.relA), relB: rel(m.relB),
      });
    } catch (e) {
      fail(m.id, e);
    }
  }

  const supports: NumSupport3[] = [];
  for (const sp of r.supports) {
    try {
      // kN·m/rad: the radian carries no dimension here
      const perRad: Eval = (src) => {
        const v = evalExpr(src);
        return isUnit(v) && (v as unknown as { dimensions: number[] }).dimensions[7] === -1 ? math.multiply(v as Unit, math.unit(1, 'rad')) : v;
      };
      const dofs = sp.dofs.slice(0, 6).map((d, c) => {
        const t = d.trim().toLowerCase();
        if (t === 'fixed' || t === 'x') return true;
        if (t === 'free' || t === '' || t === '-' || t === '—') return false;
        const kq = c < 3 ? quantity(evalExpr, d, 'N/m', `${F}/${Lu}`, 'Spring') : quantity(perRad, d, 'N m', `${F} ${Lu}`, 'Rotational spring');
        if (!(kq > 0)) throw new Error('A spring stiffness must be positive');
        return kq;
      });
      while (dofs.length < 6) dofs.push(false);
      supports.push({ id: sp.id, node: sp.node, dofs });
    } catch (e) {
      fail(sp.id, e);
    }
  }

  // loads, each tagged with its case
  const cases = r.loadCases;
  const memberById = new Map(members.map((m) => [m.id, m]));
  // a node no member uses yet is not part of the structure
  const connected = new Set(r.members.flatMap((m) => [m.a, m.b]));
  const loads: (NumLoad3 & { case?: string })[] = [];
  for (const l of r.loads) {
    const tag = cases ? { case: loadCase(l, cases) } : {};
    try {
      const force = (src: string | undefined, what: string) => (src?.trim() ? quantity(evalExpr, src, 'N', F, what) : 0);
      const moment = (src: string | undefined, what: string) => (src?.trim() ? quantity(evalExpr, src, 'N m', `${F} ${Lu}`, what) : 0);
      if (l.type === 'node') {
        if (!res.pos[l.node]) throw new Error('Its node is missing');
        if (!connected.has(l.node)) throw new Error('No member is connected to its node');
        const Fv: Vec3 = [force(l.Fx, 'F_x'), force(l.Fy, 'F_y'), force(l.Fz, 'F_z')], Mv: Vec3 = [moment(l.Mx, 'M_x'), moment(l.My, 'M_y'), moment(l.Mz, 'M_z')];
        loads.push({ id: l.id, type: 'node', node: l.node, F: Fv, M: Mv, ...tag });
        res.loads.push({ id: l.id, kind: 'node', node: l.node, F: Fv, M: Mv, ...tag });
        continue;
      }
      if (l.type === 'self') {
        const f = l.factor?.trim() ? Number(evalExpr(l.factor)) : 1;
        if (!Number.isFinite(f)) throw new Error('Self-weight: the factor must be a plain number');
        for (const m of r.members) {
          const sec = res.sections[m.section], geo = res.geometry[m.id];
          if (!sec || !geo || !memberById.has(m.id) || !sec.rho) continue;
          const q: Vec3 = [0, 0, -sec.rho * GRAVITY * sec.A * f];
          loads.push({ id: `${l.id}:${m.id}`, type: 'line', member: m.id, t1: 0, t2: 1, q1: q, q2: q, local: false, ...tag });
          res.loads.push({ id: l.id, kind: 'line', member: m.id, t1: 0, t2: 1, q1: q, q2: q, ...tag });
        }
        continue;
      }
      const geo = res.geometry[l.member];
      if (!geo || !memberById.has(l.member)) throw new Error('Its member is missing or has an error');
      const local = l.dir === 'x' || l.dir === 'y' || l.dir === 'z';
      const dir = axisOf(l.dir);
      const toG = (v: Vec3): Vec3 => (local ? [0, 1, 2].map((c) => geo.axes[0][c] * v[0] + geo.axes[1][c] * v[1] + geo.axes[2][c] * v[2]) as Vec3 : v);
      const tAt = (src: string | undefined, fallback: number, what: string) => {
        if (!src?.trim()) return fallback;
        const a = length(src, what);
        if (a < -1e-9 * geo.L || a > geo.L * (1 + 1e-9)) throw new Error(`${what} is outside the member (0 … ${+(geo.L / k).toPrecision(6)} ${Lu})`);
        return Math.min(1, Math.max(0, a / geo.L));
      };
      if (l.type === 'point') {
        const t = tAt(l.at, 0.5, 'The position');
        const v = l.moment ? moment(l.value, 'Moment') : force(l.value, 'Force');
        const vec: Vec3 = [dir[0] * v, dir[1] * v, dir[2] * v];
        const zero: Vec3 = [0, 0, 0];
        loads.push({ id: l.id, type: 'point', member: l.member, t, F: l.moment ? zero : vec, M: l.moment ? vec : zero, local, ...tag });
        res.loads.push({ id: l.id, kind: 'point', member: l.member, t, F: toG(vec), moment: !!l.moment, ...tag });
      } else {
        const t1 = tAt(l.from, 0, 'The start'), t2 = tAt(l.to, 1, 'The end');
        if (!(t2 > t1)) throw new Error('The line load must end after it starts');
        let q1 = quantity(evalExpr, l.q1, 'N/m', `${F}/${Lu}`, 'Line load');
        let q2 = l.q2?.trim() ? quantity(evalExpr, l.q2, 'N/m', `${F}/${Lu}`, 'Line load (end)') : q1;
        if (l.projected && !local) {
          // per length across the load: the member's length seen along the load's direction
          const c = Math.abs(dot3(geo.axes[0], dir)), f = Math.sqrt(Math.max(0, 1 - c * c));
          q1 *= f;
          q2 *= f;
        }
        const v1: Vec3 = [dir[0] * q1, dir[1] * q1, dir[2] * q1], v2: Vec3 = [dir[0] * q2, dir[1] * q2, dir[2] * q2];
        loads.push({ id: l.id, type: 'line', member: l.member, t1, t2, q1: v1, q2: v2, local, ...tag });
        res.loads.push({ id: l.id, kind: 'line', member: l.member, t1, t2, q1: toG(v1), q2: toG(v2), ...tag });
      }
    } catch (e) {
      fail(l.id, e);
    }
  }
  if (!r.members.length) return res;
  const firstError = r.nodes.map((n) => res.errors[n.id]).find(Boolean) ?? r.sections.map((s) => res.errors[s.id]).find(Boolean)
    ?? r.members.map((m) => res.errors[m.id]).find(Boolean) ?? r.supports.map((s) => res.errors[s.id]).find(Boolean);
  if (firstError || members.length < r.members.length) {
    res.error = firstError ?? 'A member has an error';
    return res;
  }
  const base: Omit<NumFrame, 'loads'> = {
    nodes: r.nodes.filter((n) => res.pos[n.id]).map((n) => ({ id: n.id, name: n.name, x: res.pos[n.id][0], y: res.pos[n.id][1], z: res.pos[n.id][2] })),
    members, supports,
  };

  // first order, then buckling from its axial forces, then (below the critical load only) second order
  const solve = (ls: NumLoad3[]): { solution?: FrameSolution; buckling?: Buckling3Result; error?: string } => {
    const st: NumFrame = { ...base, loads: ls };
    const first = solveFrame3(st);
    const buckling = wantBuckling ? buckling3(st, first) : undefined;
    if (!second) return { solution: first, buckling };
    const a = buckling?.modes[0]?.alpha;
    if (a !== undefined && a <= 1) return { buckling, error: `above the elastic critical load (α_cr = ${a.toPrecision(3)} < 1): no second-order equilibrium` };
    try {
      return { solution: solveFrame3(st, { secondOrder: true }), buckling };
    } catch (e) {
      if (e instanceof InstabilityError) return { buckling, error: e.message };
      throw e;
    }
  };
  try {
    if (!cases) {
      const out = solve(loads);
      res.solution = out.solution;
      res.buckling = out.buckling;
      if (out.error) res.error = out.error[0].toUpperCase() + out.error.slice(1);
    } else {
      const run = (c: { id: string; name: string; kind?: 'ULS' | 'SLS' }, ls: NumLoad3[]): Case3Result => {
        const out = solve(ls);
        return { ...c, ...out, alpha: out.buckling?.modes[0]?.alpha, ...(out.error ? { error: `${c.name}: ${out.error}` } : {}) };
      };
      res.cases = cases.cases.map((c) => run({ id: c.id, name: c.name }, loads.filter((l) => l.case === c.id)));
      res.combos = cases.combos.map((cb) => {
        const factored: NumLoad3[] = [];
        for (const c of cases.cases) {
          const src = cb.factors[c.id]?.trim() ?? '';
          if (!src) continue;
          const f = evalExpr(src);
          if (typeof f !== 'number' || !Number.isFinite(f)) throw new Error(`${cb.name}: the factor for ${c.name} must be a plain number`);
          if (f === 0) continue;
          for (const l of loads) if (l.case === c.id) factored.push(scaleLoad(l, f));
        }
        return run({ id: cb.id, name: cb.name, kind: cb.kind }, factored);
      });
      const uls = res.combos.filter((c) => c.kind === 'ULS' && c.solution).map((c) => c.solution!);
      const sls = res.combos.filter((c) => c.kind === 'SLS' && c.solution).map((c) => c.solution!);
      const all = res.combos.flatMap((c) => (c.solution ? [c.solution] : []));
      const view = cases.view ?? cases.combos.find((c) => c.kind === 'ULS')?.id ?? cases.combos[0]?.id ?? cases.cases[0]?.id;
      res.view = view;
      const shown = [...res.combos, ...res.cases].find((c) => c.id === view);
      if (view === 'envelope' && all.length) {
        const env = envelope3(uls.length ? uls : all, sls.length ? sls : uls.length ? uls : all);
        res.solution = env.max;
        res.lower = env.min;
        res.buckling = governing(res.combos)?.buckling;
      } else {
        res.solution = shown?.solution ?? res.combos[0]?.solution ?? res.cases[0]?.solution;
        res.buckling = shown?.buckling;
      }
      const failed = res.combos.find((c) => c.error) ?? res.cases.find((c) => c.error);
      if (failed) res.error = shown?.error ?? failed.error;
    }
  } catch (e) {
    res.error = e instanceof StructureError ? e.message : `Could not solve: ${(e as Error).message}`;
  }
  res.millis = performance.now() - t0;
  return res;
}

const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function scaleLoad(l: NumLoad3, f: number): NumLoad3 {
  const s = (v: Vec3): Vec3 => [v[0] * f, v[1] * f, v[2] * f];
  if (l.type === 'line') return { ...l, q1: s(l.q1), q2: s(l.q2) };
  return { ...l, F: s(l.F), M: s(l.M) };
}

/** The ULS combination (else any) with the lowest α_cr. */
function governing(list: Case3Result[]): Case3Result | undefined {
  const withB = list.filter((c) => c.buckling?.modes.length);
  const uls = withB.filter((c) => c.kind === 'ULS');
  let best: Case3Result | undefined;
  for (const c of uls.length ? uls : withB) if (!best || c.buckling!.modes[0].alpha < best.buckling!.modes[0].alpha) best = c;
  return best;
}

/**
 * Upper and lower bounds of several solutions of the same frame: forces from `forces`,
 * displacements from `defl`, at the union of every solution's stations (both sides of
 * each jump), reactions and node displacements per component.
 */
export function envelope3(forces: FrameSolution[], defl: FrameSolution[]): { max: FrameSolution; min: FrameSolution } {
  const sols = [...new Set([...forces, ...defl])];
  const first = sols[0];
  const mk = (): FrameSolution => ({ members: [], reactions: [], nodes: {}, indeterminacy: first.indeterminacy, unknowns: first.unknowns });
  const hi = mk(), lo = mk();
  first.members.forEach((m0, mi) => {
    const L = m0.L, jumps = new Set<number>(), stations = new Set<number>();
    for (const sol of sols) {
      const mr = sol.members[mi];
      mr.s.forEach((s, i) => {
        stations.add(s);
        if (i > 0 && mr.s[i - 1] === s) jumps.add(s);
      });
    }
    const pts: { s: number; at: number }[] = [];
    for (const s of [...stations].sort((a, b) => a - b)) {
      if (jumps.has(s) && s > 0 && s < L) pts.push({ s, at: s - 1e-9 * L });
      pts.push({ s, at: s });
    }
    const empty = (): Member3Result => ({ ...m0, s: [], N: [], Vy: [], Vz: [], T: [], My: [], Mz: [], ux: [], uy: [], uz: [], pieces: [] });
    const H = empty(), Lo = empty();
    for (const { s, at } of pts) {
      const f = forces.map((sol) => memberAt3(sol.members[mi], at)), d = defl.map((sol) => memberAt3(sol.members[mi], at));
      H.s.push(s);
      Lo.s.push(s);
      for (const key of FORCES) {
        H[key].push(Math.max(...f.map((v) => v[key])));
        Lo[key].push(Math.min(...f.map((v) => v[key])));
      }
      for (const key of ['ux', 'uy', 'uz'] as const) {
        H[key].push(Math.max(...d.map((v) => v[key])));
        Lo[key].push(Math.min(...d.map((v) => v[key])));
      }
    }
    hi.members.push(H);
    lo.members.push(Lo);
  });
  const bound = (pick: (a: number[]) => number) => first.reactions.map((r0, i) => ({
    ...r0,
    F: [0, 1, 2].map((c) => pick(forces.map((s) => s.reactions[i].F[c]))) as Vec3,
    M: [0, 1, 2].map((c) => pick(forces.map((s) => s.reactions[i].M[c]))) as Vec3,
  }));
  hi.reactions = bound((a) => Math.max(...a));
  lo.reactions = bound((a) => Math.min(...a));
  for (const id of Object.keys(first.nodes)) {
    hi.nodes[id] = [0, 1, 2, 3, 4, 5].map((c) => Math.max(...defl.map((s) => s.nodes[id][c])));
    lo.nodes[id] = [0, 1, 2, 3, 4, 5].map((c) => Math.min(...defl.map((s) => s.nodes[id][c])));
  }
  return { max: hi, min: lo };
}

/** What the page needs: the shown solution and the cases' names, errors and α (the worker keeps the rest). */
export function slimFrame3D(res: Frame3DResult): Frame3DResult {
  const slim = (list?: Case3Result[]) => list?.map(({ id, name, kind, alpha, error }) => ({ id, name, kind, alpha, error }));
  return { ...res, cases: slim(res.cases), combos: slim(res.combos) };
}

// ---------------------------------------------------------------- worksheet values

type Value = Record<string, unknown>;

export function frame3dValue(r: Frame3DRegion, res: Frame3DResult): Value {
  const F = r.forceUnit, Lu = r.lengthUnit;
  const metric = Lu === 'm' || Lu === 'cm' || Lu === 'mm';
  const force = (v: number) => math.unit(v, 'N').to(F);
  const moment = (v: number) => math.unit(v, 'N m').to(`${F} ${Lu}`);
  const defl = (v: number) => math.unit(v, 'm').to(metric ? 'mm' : 'in');
  const unitOf = (key: ForceKey) => (key === 'T' || key === 'My' || key === 'Mz' ? moment : force);
  const nodeName = new Map(r.nodes.map((n) => [n.id, n.name.trim()]));

  const reactionsValue = (sol: FrameSolution, value: Value) => {
    for (const q of sol.reactions) {
      const name = nodeName.get(q.node);
      if (!name) continue;
      const o = (value[name] ??= {}) as Value;
      Object.assign(o, {
        Rx: force(q.F[0]), Ry: force(q.F[1]), Rz: force(q.F[2]), R: force(Math.hypot(...q.F)),
        Mx: moment(q.M[0]), My: moment(q.M[1]), Mz: moment(q.M[2]),
      });
    }
  };
  /**
   * Extremes per member and overall, displacements per node; the stress is the largest
   * over `stressFrom` (each solution on its own: an envelope's sides mix their forces).
   */
  const extremesValue = (sol: FrameSolution, value: Value, defls: FrameSolution, stressFrom: FrameSolution[] = [sol]) => {
    const overall: Partial<Record<ForceKey, { max: number; min: number }>> = {};
    sol.members.forEach((mr) => {
      const m = r.members.find((q) => q.id === mr.id);
      if (!m) return;
      const o = (value[m.name.trim()] ??= {}) as Value;
      const ex = memberExtremes(mr);
      for (const key of FORCES) {
        o[`${key}_max`] = unitOf(key)(ex[key].max);
        o[`${key}_min`] = unitOf(key)(ex[key].min);
        const all = (overall[key] ??= { max: -Infinity, min: Infinity });
        all.max = Math.max(all.max, ex[key].max);
        all.min = Math.min(all.min, ex[key].min);
      }
      o.L = math.unit(mr.L, 'm').to(Lu);
      // extreme fibre stress |N|/A + |M_y|/W_y + |M_z|/W_z where the section moduli are known
      const sec = res.sections[m.section];
      if (sec?.Wy && sec.Wz) {
        let sig = 0;
        for (const s of stressFrom) {
          const q = s.members.find((x) => x.id === mr.id);
          q?.s.forEach((_, i) => (sig = Math.max(sig, Math.abs(q.N[i]) / sec.A + Math.abs(q.My[i]) / sec.Wy! + Math.abs(q.Mz[i]) / sec.Wz!)));
        }
        o.σ_max = o.sigma_max = math.unit(sig, 'Pa').to('MPa');
      }
    });
    for (const key of FORCES) {
      const all = overall[key];
      if (!all) continue;
      value[`${key}_max`] = unitOf(key)(all.max);
      value[`${key}_min`] = unitOf(key)(all.min);
    }
    let umax = 0;
    for (const n of r.nodes) {
      const d = defls.nodes[n.id];
      if (!d) continue;
      const o = (value[n.name.trim()] ??= {}) as Value;
      Object.assign(o, { ux: defl(d[0]), uy: defl(d[1]), uz: defl(d[2]), u: defl(Math.hypot(d[0], d[1], d[2])) });
      o.φx = o.phi_x = d[3];
      o.φy = o.phi_y = d[4];
      o.φz = o.phi_z = d[5];
      umax = Math.max(umax, Math.hypot(d[0], d[1], d[2]));
    }
    // along the members too: the largest displacement anywhere
    for (const mr of defls.members) mr.ux.forEach((ux, i) => (umax = Math.max(umax, Math.hypot(ux, mr.uy[i], mr.uz[i]))));
    value.u_max = defl(umax);
  };
  /** The internal forces along each member as functions of the distance from its start. */
  const functionsValue = (sol: FrameSolution, value: Value) => {
    const k = LENGTH_TO_M[Lu] ?? 1;
    sol.members.forEach((mr) => {
      const m = r.members.find((q) => q.id === mr.id);
      if (!m) return;
      const o = (value[m.name.trim()] ??= {}) as Value;
      const at = (x: unknown) => {
        const xs = typeof x === 'number' ? x * k : isUnit(x) ? ((x as Unit).toNumeric('m') as number) : NaN;
        if (!Number.isFinite(xs)) throw new Error('x must be a length');
        if (xs < -1e-9 * mr.L || xs > mr.L * (1 + 1e-9)) throw new Error(`x is outside the member (0 … ${+(mr.L / k).toPrecision(6)} ${Lu})`);
        return memberAt3(mr, Math.min(mr.L, Math.max(0, xs)));
      };
      for (const key of FORCES) o[key] = (x: unknown) => unitOf(key)(at(x)[key]);
      o.ux = (x: unknown) => defl(at(x).ux);
      o.uy = (x: unknown) => defl(at(x).uy);
      o.uz = (x: unknown) => defl(at(x).uz);
    });
  };
  const stability = (b: Buckling3Result | undefined, value: Value) => {
    if (!b) return;
    const alphas = b.modes.map((m) => m.alpha);
    value.α_cr = value.alpha_cr = alphas[0] ?? Infinity;
    value.α_cr_modes = value.alpha_cr_modes = math.matrix(alphas);
    for (const m of r.members) {
      const L = b.Lcr[m.id], o = (value[m.name.trim()] ??= {}) as Value;
      o.L_cr_y = math.unit(L?.y ?? Infinity, 'm').to(Lu);
      o.L_cr_z = math.unit(L?.z ?? Infinity, 'm').to(Lu);
    }
  };
  const solutionValue = (sol: FrameSolution, b?: Buckling3Result): Value => {
    const value: Value = {};
    extremesValue(sol, value, sol);
    reactionsValue(sol, value);
    functionsValue(sol, value);
    stability(b, value);
    return value;
  };

  if (!r.loadCases || !res.combos) {
    if (res.solution) return solutionValue(res.solution, res.buckling);
    const value: Value = {};
    stability(res.buckling, value);
    return value;
  }
  const named = (list: Case3Result[] = []) => Object.fromEntries(list.filter((c) => c.solution).map((c) => [identifierOf(c.name), solutionValue(c.solution!, c.buckling)]));
  const value: Value = { cases: named(res.cases), combos: named(res.combos) };
  // a combination without second-order equilibrium leaves no governing values
  if (res.combos.some((c) => c.error)) {
    stability(governing(res.combos)?.buckling, value);
    return value;
  }
  const uls = res.combos.filter((c) => c.kind === 'ULS' && c.solution).map((c) => c.solution!);
  const sls = res.combos.filter((c) => c.kind === 'SLS' && c.solution).map((c) => c.solution!);
  const forceSet = uls.length ? uls : res.combos.filter((c) => c.solution).map((c) => c.solution!);
  if (!forceSet.length) {
    stability(governing(res.combos)?.buckling, value);
    return value;
  }
  const deflSet = sls.length ? sls : forceSet;
  // governing: forces and reactions over the ULS combinations, displacements over the SLS ones
  const env = envelope3(forceSet, deflSet);
  const gov: Value = {};
  // the functions along the members are those of the first ULS combination
  functionsValue(forceSet[0], gov);
  extremesValue(env.max, gov, env.max, forceSet);
  const low: Value = {};
  extremesValue(env.min, low, env.min);
  for (const [key, v] of Object.entries(low)) {
    // minima from the lower bound, maxima from the upper
    if (key.endsWith('_min')) gov[key] = v;
    else if (v && typeof v === 'object' && !isUnit(v) && gov[key] && typeof gov[key] === 'object') {
      for (const [k2, v2] of Object.entries(v as Value)) if (k2.endsWith('_min')) (gov[key] as Value)[k2] = v2;
    }
  }
  // displacements: the largest magnitude over the SLS combinations, per node
  for (const n of r.nodes) {
    let best: number[] | undefined;
    for (const sol of deflSet) {
      const d = sol.nodes[n.id];
      if (d && (!best || Math.hypot(d[0], d[1], d[2]) > Math.hypot(best[0], best[1], best[2]))) best = d;
    }
    if (!best) continue;
    const o = (gov[n.name.trim()] ??= {}) as Value;
    Object.assign(o, { ux: defl(best[0]), uy: defl(best[1]), uz: defl(best[2]), u: defl(Math.hypot(best[0], best[1], best[2])) });
    // the rotations of that same combination (not the envelope's mixed sides)
    o.φx = o.phi_x = best[3];
    o.φy = o.phi_y = best[4];
    o.φz = o.phi_z = best[5];
  }
  let umax = 0;
  for (const sol of deflSet) for (const mr of sol.members) mr.ux.forEach((ux, i) => (umax = Math.max(umax, Math.hypot(ux, mr.uy[i], mr.uz[i]))));
  gov.u_max = defl(umax);
  // reactions: per support the ULS combination with the largest resultant
  const reactions = forceSet[0].reactions.map((q0, i) => forceSet.map((s) => s.reactions[i]).reduce((a, b) => (Math.hypot(...b.F) > Math.hypot(...a.F) ? b : a), q0));
  reactionsValue({ ...forceSet[0], reactions }, gov);
  // α_cr and the buckling lengths: the lowest over the ULS combinations
  stability(governing(res.combos)?.buckling, gov);
  return { ...gov, ...value };
}
