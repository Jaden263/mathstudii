// Evaluates a beam region in the worksheet: load and section expressions are read from
// the worksheet scope, the structure is solved, and reactions, extremes and (for a
// straight horizontal beam) the functions M(x), V(x), N(x), w(x) are exported under
// the region's name. Options: shear deformation, second order, buckling (α_cr).
import type { Unit } from 'mathjs';
import type { BeamRegion } from '../model/types';
import { math, isUnit } from '../engine/math';
import { loadCase, type BeamSection } from './model';
import { InstabilityError, memberAt, solveStructure, StructureError, type BeamSolution, type Extreme, type MemberResult, type NumLoad, type NumMember, type NumStructure, type Reaction } from './solve';
import { bucklingAnalysis, type BucklingResult } from './buckling';
import { profileShearArea, rhsShearArea, SHEAR_FACTOR, shearModulus, weldedShearArea } from './shear';
import { identifierOf, movingParts, solveTraffic, trafficValue, withMoving, type TrafficResult } from './traffic';

/** Result of one load case or one combination. */
export interface CaseResult {
  id: string;
  name: string;
  kind?: 'ULS' | 'SLS';
  solution?: BeamSolution;
  /** Linear buckling of the combination (with the buckling or second-order option). */
  buckling?: BucklingResult;
  /** With moving loads: the combination's bounds (`solution` is the upper one). */
  range?: { max: BeamSolution; min: BeamSolution };
  error?: string;
}

export interface BeamResult {
  kind: 'beam';
  /** What is shown: the only solution, or the chosen case / combination / envelope (max side). */
  solution?: BeamSolution;
  /** With load cases: each case and combination on its own. */
  cases?: CaseResult[];
  combos?: CaseResult[];
  /** Envelope of the combinations: N, V, M over the ULS ones, deflection over the SLS ones. */
  envelope?: { max: BeamSolution; min: BeamSolution };
  /** Case id, combination id or 'envelope' (what `solution` holds). */
  view?: string;
  /** Load id → evaluated values in SI (force N, moment N·m, line load q1/q2 N/m). */
  values: Record<string, number[]>;
  /** Item id (load, member, 'section') → problem with its expression. */
  errors: Record<string, string>;
  /** Default section in SI (E Pa, A m², I m⁴, W m³; with shear deformation G Pa, A_v m²). */
  section?: SectionSI;
  /** Buckling of what is shown (the envelope: of the combination with the lowest α_cr). */
  buckling?: BucklingResult;
  /** The analysis options in effect (absent: first order, no shear, no buckling). */
  analysis?: { shear: boolean; secondOrder: boolean; buckling: boolean };
  /** Influence lines and moving loads. */
  traffic?: TrafficResult;
  /** The loads' own solution while `solution` shows a moving load's envelope. */
  staticSolution?: BeamSolution;
  error?: string;
}

export interface SectionSI {
  E: number;
  A: number;
  I: number;
  W?: number;
  G?: number;
  Av?: number;
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

export function sectionValues(evalExpr: Eval, s: BeamSection, shear = false): SectionSI {
  const E = quantity(evalExpr, s.E, 'Pa', 'GPa', 'E');
  const A = quantity(evalExpr, s.A, 'm^2', 'cm^2', 'A');
  const I = quantity(evalExpr, s.I, 'm^4', 'cm^4', 'I');
  const W = s.W?.trim() ? quantity(evalExpr, s.W, 'm^3', 'cm^3', 'W') : undefined;
  if (!(E > 0 && A > 0 && I > 0)) throw new Error('E, A and I must be positive');
  return { E, A, I, ...(W && W > 0 ? { W } : {}), ...(shear ? shearValues(evalExpr, s, E, A) : {}) };
}

/** Shear modulus and shear area of a section (Timoshenko members). */
function shearValues(evalExpr: Eval, s: BeamSection, E: number, A: number): { G: number; Av: number } {
  const G = s.G?.trim() ? quantity(evalExpr, s.G, 'Pa', 'GPa', 'G') : shearModulus(E, s.material, s.grade);
  const len = (src: string, what: string) => quantity(evalExpr, src, 'm', 'mm', what);
  const r = s.shear;
  const Av = !r ? profileShearArea(s.label) ?? SHEAR_FACTOR.rect * A
    : r.kind === 'rhs' ? rhsShearArea(A, len(r.h, 'h'), len(r.b, 'b'))
    : r.kind === 'welded' ? weldedShearArea(len(r.hw, 'h_w'), len(r.tw, 't_w'))
    : r.kind === 'value' ? quantity(evalExpr, r.Av, 'm^2', 'cm^2', 'A_v')
    : SHEAR_FACTOR[r.kind] * A;
  if (!(G > 0 && Av > 0)) throw new Error('G and the shear area A_v must be positive');
  return { G, Av };
}

export function solveBeam(r: BeamRegion, evalExpr: Eval): BeamResult {
  const res: BeamResult = { kind: 'beam', values: {}, errors: {} };
  const k = LENGTH_TO_M[r.lengthUnit] ?? 1;
  const F = r.forceUnit;
  const an = r.analysis ?? {};
  const withShear = !!an.shear, second = !!an.secondOrder, wantBuckling = !!an.buckling || second;
  if (r.analysis) res.analysis = { shear: withShear, secondOrder: second, buckling: wantBuckling };
  try {
    res.section = sectionValues(evalExpr, r.section, withShear);
  } catch (e) {
    res.errors.section = (e as Error).message;
  }
  const members: NumMember[] = [];
  for (const m of r.members) {
    let sec = res.section;
    if (m.section) {
      try {
        sec = sectionValues(evalExpr, m.section, withShear);
      } catch (e) {
        res.errors[m.id] = (e as Error).message;
        sec = undefined;
      }
    }
    if (sec) members.push({ id: m.id, a: m.a, b: m.b, ...sec, hingeA: m.hingeA, hingeB: m.hingeB });
  }
  const loads: (NumLoad & { case?: string })[] = [];
  const cases = r.loadCases;
  for (const l of r.loads) {
    const tag = cases ? { case: loadCase(l, cases) } : {};
    try {
      if (l.type === 'force') {
        const P = quantity(evalExpr, l.value, 'N', F, 'Force');
        const a = (l.angle * Math.PI) / 180;
        res.values[l.id] = [P];
        loads.push({ id: l.id, type: 'force', at: l.at, Fx: P * Math.cos(a), Fy: P * Math.sin(a), ...tag });
      } else if (l.type === 'moment') {
        const M = quantity(evalExpr, l.value, 'N m', `${F} ${r.lengthUnit}`, 'Moment');
        res.values[l.id] = [M];
        loads.push({ id: l.id, type: 'moment', at: l.at, M, ...tag });
      } else {
        const q1 = quantity(evalExpr, l.q1, 'N/m', `${F}/${r.lengthUnit}`, 'Line load');
        const q2 = l.q2?.trim() ? quantity(evalExpr, l.q2, 'N/m', `${F}/${r.lengthUnit}`, 'Line load (end)') : q1;
        res.values[l.id] = [q1, q2];
        loads.push({ id: l.id, type: 'line', member: l.member, t1: l.t1 ?? 0, t2: l.t2 ?? 1, q1, q2, dir: l.dir, ...tag });
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
  const base: Omit<NumStructure, 'loads'> = {
    nodes: r.nodes.map((q) => ({ id: q.id, x: q.x * k, y: q.y * k })),
    members,
    supports: r.supports.map((s) => {
      const extra: { k?: number; kr?: number; settle?: number } = {};
      try {
        if (s.k?.trim()) extra.k = quantity(evalExpr, s.k, 'N/m', `${F}/${r.lengthUnit}`, `Spring at ${s.label}`);
        // kN·m/rad: the radian carries no dimension here
        const perRad: Eval = (src) => {
          const v = evalExpr(src);
          return isUnit(v) && (v as unknown as { dimensions: number[] }).dimensions[7] === -1 ? math.multiply(v as Unit, math.unit(1, 'rad')) : v;
        };
        if (s.kr?.trim() && s.type === 'fixed') extra.kr = quantity(perRad, s.kr, 'N m', `${F} ${r.lengthUnit}`, `Rotational spring at ${s.label}`);
        if (s.settle?.trim()) extra.settle = quantity(evalExpr, s.settle, 'm', 'mm', `Settlement at ${s.label}`);
        if ((extra.k !== undefined && !(extra.k > 0)) || (extra.kr !== undefined && !(extra.kr > 0))) throw new Error(`Spring at ${s.label}: the stiffness must be positive`);
      } catch (e) {
        res.errors[s.id] = (e as Error).message;
      }
      return { id: s.id, node: s.node, type: s.type, angle: (s.angle * Math.PI) / 180, label: s.label, ...extra };
    }),
  };
  const supportError = r.supports.map((s) => res.errors[s.id]).find(Boolean);
  if (supportError) {
    res.error = supportError;
    return res;
  }
  // influence lines and moving loads (linear, along the load path)
  try {
    res.traffic = solveTraffic(r, base, (src, b, fb, what) => quantity(evalExpr, src, b, fb, what), evalExpr, res.errors);
  } catch (e) {
    res.error = `Moving loads: ${(e as Error).message}`;
  }
  // first order, then buckling from its axial forces, then (below the critical load only)
  // second order; an unstable load set keeps its buckling result and gets an error
  const solve = (ls: NumLoad[]): { solution?: BeamSolution; buckling?: BucklingResult; error?: string } => {
    const st: NumStructure = { ...base, loads: ls };
    const first = solveStructure(st);
    const buckling = wantBuckling ? bucklingAnalysis(st, first) : undefined;
    if (!second) return { solution: first, buckling };
    const a = buckling?.modes[0]?.alpha;
    if (a !== undefined && a <= 1) return { buckling, error: `above the elastic critical load (α_cr = ${a.toPrecision(3)} < 1): no second-order equilibrium` };
    try {
      const solution = solveStructure(st, { secondOrder: true });
      solution.secondOrder = { iterations: solution.secondOrder?.iterations ?? 0, first: { max: first.max, reactions: first.reactions } };
      return { solution, buckling };
    } catch (e) {
      if (e instanceof InstabilityError) return { buckling, error: e.message };
      throw e;
    }
  };
  if (!cases) {
    try {
      const out = solve(loads);
      res.solution = out.solution;
      res.buckling = out.buckling;
      if (out.error) res.error = out.error[0].toUpperCase() + out.error.slice(1);
    } catch (e) {
      res.error = e instanceof StructureError ? e.message : `Could not solve: ${(e as Error).message}`;
    }
    showMoving(res, r);
    return res;
  }
  // second order is not linear: a combination that is unstable fails on its own
  const run = (c: { id: string; name: string; kind?: 'ULS' | 'SLS' }, ls: NumLoad[]): CaseResult => {
    const out = solve(ls);
    return { ...c, ...out, ...(out.error ? { error: `${c.name}: ${out.error}` } : {}) };
  };
  // load cases: each case alone, each combination as its own factored load set (exact for a
  // linear structure), and the envelope of the combinations
  try {
    res.cases = cases.cases.map((c) => run({ id: c.id, name: c.name }, loads.filter((l) => l.case === c.id)));
    res.combos = cases.combos.map((cb) => {
      const factored: NumLoad[] = [];
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
    // moving loads in a combination: its static part plus their factored bounds
    const tr = res.traffic;
    if (tr) cases.combos.forEach((cb, i) => {
      const c = res.combos![i], parts = movingParts(cb, tr, evalExpr);
      if (!parts.length || !c.solution) return;
      c.range = withMoving(c.solution, parts, tr.structure);
      c.solution = c.range.max;
    });
  } catch (e) {
    res.error = e instanceof StructureError ? e.message : (e as Error).message;
    return res;
  }
  // (a combination with moving loads brings both its bounds)
  const bounds = (c: CaseResult) => (c.range ? [c.range.max, c.range.min] : c.solution ? [c.solution] : []);
  const uls = res.combos.filter((c) => c.kind === 'ULS').flatMap(bounds);
  const sls = res.combos.filter((c) => c.kind === 'SLS').flatMap(bounds);
  const all = res.combos.flatMap(bounds);
  if (all.length) res.envelope = envelopeOf(uls.length ? uls : all, sls.length ? sls : uls.length ? uls : all);
  const view = cases.view ?? cases.combos.find((c) => c.kind === 'ULS')?.id ?? cases.combos[0]?.id ?? cases.cases[0]?.id;
  res.view = view;
  const shown = [...res.combos, ...res.cases].find((c) => c.id === view);
  res.solution = view === 'envelope' ? res.envelope?.max
    : shown ? shown.solution : res.combos[0]?.solution ?? res.cases[0]?.solution;
  res.buckling = view === 'envelope' ? governing(res.combos)?.buckling : shown?.buckling;
  const failed = res.combos.find((c) => c.error) ?? res.cases.find((c) => c.error);
  if (failed) res.error = shown?.error ?? failed.error;
  showMoving(res, r);
  return res;
}

/** A moving load picked in the strip: its envelope is shown (the loads' own solution stays for the worksheet). */
function showMoving(res: BeamResult, r: BeamRegion): void {
  const id = r.traffic?.view;
  const m = id ? res.traffic?.moving.find((q) => q.id === id) : undefined;
  if (!m?.env) return;
  if (res.solution) m.env.max.indeterminacy = m.env.min.indeterminacy = res.solution.indeterminacy;
  res.staticSolution = res.solution;
  res.solution = m.env.max;
  res.view = m.id;
  res.buckling = undefined;
}

/** The lower bound drawn with what is shown: of the envelope, of a combination with moving loads, of a moving load. */
export function lowerBound(res?: BeamResult): BeamSolution | undefined {
  if (!res?.view) return undefined;
  if (res.view === 'envelope') return res.envelope?.min;
  return res.combos?.find((c) => c.id === res.view)?.range?.min ?? res.traffic?.moving.find((m) => m.id === res.view)?.env?.min;
}

/** The combination with the lowest α_cr: the ULS ones, or all when there are none. */
function governing(list: CaseResult[]): CaseResult | undefined {
  const uls = list.filter((c) => c.kind === 'ULS' && c.buckling);
  let best: CaseResult | undefined;
  for (const c of uls.length ? uls : list.filter((q) => q.buckling)) {
    if (!best || (c.buckling!.modes[0]?.alpha ?? Infinity) < (best.buckling!.modes[0]?.alpha ?? Infinity)) best = c;
  }
  return best;
}

function scaleLoad(l: NumLoad, f: number): NumLoad {
  if (l.type === 'force') return { ...l, Fx: l.Fx * f, Fy: l.Fy * f };
  if (l.type === 'moment') return { ...l, M: l.M * f };
  return { ...l, q1: l.q1 * f, q2: l.q2 * f };
}

/**
 * Upper and lower bounds of several solutions of the same structure. Forces come from
 * `forces`, displacements from `defl`. Stations are the union of every solution's
 * stations, with both sides of each jump.
 */
export function envelopeOf(forces: BeamSolution[], defl: BeamSolution[]): { max: BeamSolution; min: BeamSolution } {
  const sols = [...new Set([...forces, ...defl])];
  const first = sols[0];
  const mk = (): BeamSolution => ({ members: [], reactions: [], nodes: {}, max: {}, indeterminacy: first.indeterminacy });
  const hi = mk(), lo = mk();
  for (const m0 of first.members) {
    const all = sols.map((sol) => sol.members.find((q) => q.id === m0.id)!);
    const L = m0.L;
    const jumps = new Set<number>();
    const stations = new Set<number>();
    for (const mr of all) {
      mr.s.forEach((s, i) => {
        stations.add(s);
        if (i > 0 && mr.s[i - 1] === s) jumps.add(s);
      });
      for (const p of mr.pieces) if (p.s0 > 1e-12) jumps.add(p.s0);
    }
    const pts: { s: number; at: number }[] = [];
    for (const s of [...stations].sort((a, b) => a - b)) {
      if (jumps.has(s) && s > 0 && s < L) pts.push({ s, at: s - 1e-9 * L });
      pts.push({ s, at: s });
    }
    const empty = (): MemberResult => ({ id: m0.id, L, s: [], N: [], V: [], M: [], dx: [], dy: [], pieces: [] });
    const H = empty(), Lo = empty();
    for (const { s, at } of pts) {
      const f = forces.map((sol) => memberAt(sol.members.find((q) => q.id === m0.id)!, at));
      const d = defl.map((sol) => memberAt(sol.members.find((q) => q.id === m0.id)!, at));
      H.s.push(s); Lo.s.push(s);
      for (const key of ['N', 'V', 'M'] as const) {
        H[key].push(Math.max(...f.map((v) => v[key])));
        Lo[key].push(Math.min(...f.map((v) => v[key])));
      }
      for (const key of ['dx', 'dy'] as const) {
        H[key].push(Math.max(...d.map((v) => v[key])));
        Lo[key].push(Math.min(...d.map((v) => v[key])));
      }
    }
    hi.members.push(H);
    lo.members.push(Lo);
  }
  // extremes over both bounds (largest magnitude), on the max side so labels find them
  const pick = (key: 'N' | 'V' | 'M'): Extreme | undefined => {
    let best: Extreme | undefined;
    for (const env of [hi, lo]) for (const mr of env.members) mr[key].forEach((v, i) => {
      if (!best || Math.abs(v) > Math.abs(best.value)) best = { value: v, member: mr.id, s: mr.s[i], x: 0, y: 0 };
    });
    return best;
  };
  for (const key of ['N', 'V', 'M'] as const) {
    const e = pick(key);
    if (e) hi.max[key] = lo.max[key] = e;
  }
  let w: Extreme | undefined;
  for (const env of [hi, lo]) for (const mr of env.members) mr.dy.forEach((v, i) => {
    const mag = Math.hypot(v, mr.dx[i]);
    if (!w || mag > w.value) w = { value: mag, member: mr.id, s: mr.s[i], x: 0, y: 0 };
  });
  if (w) hi.max.w = lo.max.w = w;
  const sig = forces.map((sol) => sol.max.sigma).filter((x): x is Extreme => !!x).sort((a, b) => b.value - a.value)[0];
  if (sig) hi.max.sigma = lo.max.sigma = sig;
  // reactions: per support the largest and smallest of each component over the force solutions
  hi.reactions = first.reactions.map((r0) => {
    const rs = forces.map((sol) => sol.reactions.find((q) => q.id === r0.id)!);
    return { ...r0, Rx: Math.max(...rs.map((q) => q.Rx)), Ry: Math.max(...rs.map((q) => q.Ry)), M: Math.max(...rs.map((q) => q.M)) };
  });
  lo.reactions = first.reactions.map((r0) => {
    const rs = forces.map((sol) => sol.reactions.find((q) => q.id === r0.id)!);
    return { ...r0, Rx: Math.min(...rs.map((q) => q.Rx)), Ry: Math.min(...rs.map((q) => q.Ry)), M: Math.min(...rs.map((q) => q.M)) };
  });
  return { max: hi, min: lo };
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

/** Worksheet value: reactions per support, extremes and functions along a straight beam; influence lines and moving loads. */
export function beamValue(r: BeamRegion, res: BeamResult): Record<string, unknown> {
  const value = loadsValue(r, res);
  if (res.traffic) {
    Object.assign(value, trafficValue(r, res.traffic, (sol) => solutionValue(r, sol)));
    // a combination with moving loads has two bounds: b.combos.ULS the upper, b.combos.ULS.min the lower
    const combos = value.combos as Record<string, Record<string, unknown>> | undefined;
    for (const c of res.combos ?? []) if (c.range && combos?.[identifierOf(c.name)]) combos[identifierOf(c.name)].min = solutionValue(r, c.range.min);
  }
  return value;
}

function loadsValue(r: BeamRegion, res: BeamResult): Record<string, unknown> {
  if (!r.loadCases || !res.combos) {
    const sol = res.staticSolution ?? res.solution;
    if (sol) return solutionValue(r, sol, res.buckling);
    // above the critical load in second order: α_cr is all there is
    const value: Record<string, unknown> = {};
    if (res.buckling) stabilityValue(r, res.buckling, value);
    return value;
  }
  // with load cases: b.cases.G, b.combos.ULS, and at the top the governing values:
  // forces and reactions over the ULS combinations, deflection over the SLS ones
  const named = (list: CaseResult[] = []) => Object.fromEntries(list.filter((c) => c.solution).map((c) => [identifierOf(c.name), solutionValue(r, c.solution!, c.buckling)]));
  const value: Record<string, unknown> = { cases: named(res.cases), combos: named(res.combos) };
  // the lowest α_cr over the ULS combinations
  const gov = governing(res.combos);
  if (gov) stabilityValue(r, gov.buckling!, value);
  // a combination without second-order equilibrium leaves no governing values to give
  if (res.combos.some((c) => c.error)) return value;
  const uls = res.combos.filter((c) => c.kind === 'ULS' && c.solution);
  const sls = res.combos.filter((c) => c.kind === 'SLS' && c.solution);
  const forceSet = uls.length ? uls : res.combos.filter((c) => c.solution);
  const deflSet = sls.length ? sls : forceSet;
  if (!forceSet.length) return value;
  // the functions M(x), w(x) … of the first ULS combination
  Object.assign(value, solutionValue(r, forceSet[0].solution!));
  const governingOf = (pick: (sol: BeamSolution) => { max: BeamSolution['max']; reactions: Reaction[] } | undefined) => {
    const biggest = (sols: CaseResult[], key: keyof BeamSolution['max']) => {
      let best: Extreme | undefined;
      for (const c of sols) {
        const e = pick(c.solution!)?.max[key];
        if (e && (!best || Math.abs(e.value) > Math.abs(best.value))) best = e;
      }
      return best;
    };
    const max: BeamSolution['max'] = {};
    for (const key of ['M', 'V', 'N', 'sigma'] as const) {
      const e = biggest(forceSet, key);
      if (e) max[key] = e;
    }
    const w = biggest(deflSet, 'w');
    if (w) max.w = w;
    // reactions: the largest resultant over the ULS combinations
    const reactions = (pick(forceSet[0].solution!)?.reactions ?? []).map((q) => {
      let best = q;
      for (const c of forceSet) {
        const x = pick(c.solution!)?.reactions.find((y) => y.id === q.id);
        if (x && Math.hypot(x.Rx, x.Ry) > Math.hypot(best.Rx, best.Ry)) best = x;
      }
      return best;
    });
    return extremesValue(r, max, reactions);
  };
  Object.assign(value, governingOf((sol) => sol));
  // second order: the governing first-order values beside them
  if (forceSet[0].solution!.secondOrder?.first) value.first = governingOf((sol) => sol.secondOrder?.first);
  return value;
}

/** α_cr (lowest mode), all modes' α as a vector, and L_cr per member in drawing order (∞ in tension). */
function stabilityValue(r: BeamRegion, b: BucklingResult, value: Record<string, unknown>): void {
  const alphas = b.modes.map((m) => m.alpha);
  value.α_cr = value.alpha_cr = alphas[0] ?? Infinity;
  value.α_cr_modes = value.alpha_cr_modes = math.matrix(alphas);
  value.L_cr = math.matrix(r.members.map((m) => math.unit(b.Lcr[m.id] ?? Infinity, 'm').to(r.lengthUnit)) as never);
}

/** Reactions and extremes of a solution. */
function extremesValue(r: BeamRegion, max: BeamSolution['max'], reactions: BeamSolution['reactions']): Record<string, unknown> {
  const F = r.forceUnit, Lu = r.lengthUnit;
  const metric = Lu === 'm' || Lu === 'cm' || Lu === 'mm';
  const force = (v: number) => math.unit(v, 'N').to(F);
  const moment = (v: number) => math.unit(v, 'N m').to(`${F} ${Lu}`);
  const defl = (v: number) => math.unit(v, 'm').to(metric ? 'mm' : 'in');
  const value: Record<string, unknown> = {};
  for (const q of reactions) {
    value[q.label] = { Rx: force(q.Rx), Ry: force(q.Ry), M: moment(q.M), R: force(Math.hypot(q.Rx, q.Ry)) };
  }
  if (max.M) value.M_max = moment(max.M.value);
  if (max.V) value.V_max = force(max.V.value);
  if (max.N) value.N_max = force(max.N.value);
  if (max.w) value.w_max = defl(max.w.value);
  if (max.sigma) value.σ_max = value.sigma_max = math.unit(max.sigma.value, 'Pa').to('MPa');
  return value;
}

function solutionValue(r: BeamRegion, sol: BeamSolution, buckling?: BucklingResult): Record<string, unknown> {
  const F = r.forceUnit, Lu = r.lengthUnit;
  const metric = Lu === 'm' || Lu === 'cm' || Lu === 'mm';
  const force = (v: number) => math.unit(v, 'N').to(F);
  const moment = (v: number) => math.unit(v, 'N m').to(`${F} ${Lu}`);
  const defl = (v: number) => math.unit(v, 'm').to(metric ? 'mm' : 'in');
  const value = extremesValue(r, sol.max, sol.reactions);
  // second order: the first-order values next to it (b.first.M_max)
  const first = sol.secondOrder?.first;
  if (first) value.first = extremesValue(r, first.max, first.reactions);
  if (buckling) stabilityValue(r, buckling, value);
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
