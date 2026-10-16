// Influence lines and moving loads of a beam region: the definitions read from the
// worksheet (presets such as EN 1991-2 Load Model 1 expanded to axles and a lane load),
// the analysis run along the load path, and the moving loads brought into the load
// combinations as variable actions: a combination's bounds are its static solution
// plus, per moving load, its factor times the moving load's extreme at each station.
import type { Unit } from 'mathjs';
import type { BeamRegion } from '../model/types';
import { math, isUnit } from '../engine/math';
import { LM1, type BeamCombo, type BeamInfluenceLine, type BeamMovingLoad } from './model';
import {
  boundExtremes, influenceAnalysis, linearPieces, loadPath, MAX_POSITIONS,
  type Critical, type ExtremeKey, type InfluenceQuery, type PathSeg, type ReactionKey, type TrainEnvelope, type TrainSpec,
} from './influence';
import { memberAt, StructureError, type BeamSolution, type MemberResult, type NumStructure } from './solve';

const LENGTH_TO_M: Record<string, number> = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 };

type Eval = (src: string) => unknown;
/** An expression in SI `base`; bare numbers take `fallback`. */
type Read = (src: string, base: string, fallback: string, what: string) => number;

export interface TrafficLine {
  id: string;
  name: string;
  quantity: BeamInfluenceLine['quantity'];
  /** Load positions (global x, m; repeated at a jump) and ordinates per newton (M in m, w in m/N). */
  x: number[];
  v: number[];
  /** The section: member, distance along it (m), and its global x (m). */
  member?: string;
  s?: number;
  xs?: number;
}

export interface TrafficMoving {
  id: string;
  name: string;
  /** Axle loads (N) and their distances behind the first (m); the uniform load (N/m). */
  P: number[];
  offsets: number[];
  q: number;
  dir: TrainSpec['dir'];
  /** Bounds over every position (absent when the analysis failed). */
  env?: TrainEnvelope;
}

export interface TrafficResult {
  path: PathSeg[];
  /** Load positions (m) and their spacing. */
  xs: number[];
  step: number;
  /** The step asked for was finer than the analysis takes (MAX_POSITIONS). */
  widened?: boolean;
  lines: TrafficLine[];
  moving: TrafficMoving[];
  /** The structure without loads or settlements, in SI: the train at one position is solved on it. */
  structure: NumStructure;
  error?: string;
}

/** The axles and the uniform load of a moving load, in SI. */
export function trainOf(ml: BeamMovingLoad, r: BeamRegion, read: Read, evalExpr: Eval): TrainSpec {
  const F = r.forceUnit, Lu = r.lengthUnit;
  const force = (src: string | undefined, what: string) => read(src ?? '', 'N', F, `${ml.name}: ${what}`);
  const len = (src: string | undefined, what: string) => read(src ?? '', 'm', Lu, `${ml.name}: ${what}`);
  const factor = (src: string | undefined, what: string) => {
    const v = evalExpr(src?.trim() || '1');
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${ml.name}: ${what} must be a plain number`);
    return v;
  };
  const dir = ml.dir ?? 'both';
  let P: number[] = [], offsets: number[] = [], q = 0;
  if (ml.preset === 'point') {
    P = [force(ml.P, 'P')];
    offsets = [0];
  } else if (ml.preset === 'crane') {
    const w = force(ml.P, 'wheel load P');
    P = [w, w];
    offsets = [0, len(ml.a, 'wheel spacing a')];
  } else if (ml.preset === 'lm1') {
    // EN 1991-2 4.3.2: tandem of two axles α_Q Q₁k at 1.2 m, and α_q q₁k over the lane width
    const aQ = factor(ml.alphaQ, 'α_Q'), aq = factor(ml.alphaq, 'α_q');
    const w = read(ml.w?.trim() || '3', 'm', 'm', `${ml.name}: lane width w`);
    P = [aQ * LM1.Q * 1e3, aQ * LM1.Q * 1e3];
    offsets = [0, LM1.spacing];
    q = aq * LM1.q * 1e3 * w;
  } else {
    let o = 0;
    (ml.axles ?? []).forEach((ax, i) => {
      if (i > 0) o += len(ax.a, `spacing of axle ${i + 1}`);
      P.push(force(ax.P, `axle ${i + 1}`));
      offsets.push(o);
    });
    q = ml.q?.trim() ? read(ml.q, 'N/m', `${F}/${Lu}`, `${ml.name}: uniform load`) : 0;
  }
  if (offsets.some((o, i) => i > 0 && o < offsets[i - 1])) throw new Error(`${ml.name}: axle spacings cannot be negative`);
  if (!P.length && !q) throw new Error(`${ml.name}: no axles and no uniform load`);
  return { id: ml.id, P, offsets, q, dir };
}

/**
 * A round step near span/200 that divides every axle spacing, so the axles of a train
 * stand on load positions together (1.2 m for LM1: 0.1, 0.2 …). Not finer than the
 * analysis takes (MAX_POSITIONS), since a widened step would divide nothing.
 */
export function autoStep(span: number, offsets: number[]): number {
  const target = span / 200;
  const nice: number[] = [];
  for (let e = Math.ceil(Math.log10(target)); nice.length < 16; e--) {
    for (const m of [5, 2.5, 2, 1]) if (m * 10 ** e <= target * (1 + 1e-9)) nice.push(+(m * 10 ** e).toPrecision(6));
  }
  const divides = (s: number) => offsets.every((o) => Math.abs(o / s - Math.round(o / s)) < 1e-6);
  return nice.find((s) => s >= (span / MAX_POSITIONS) * (1 - 1e-9) && divides(s)) ?? nice[0];
}

/** The member and fraction of an influence line's section: on its member, else the load path first. */
function sectionOf(r: BeamRegion, st: NumStructure, path: PathSeg[], l: BeamInfluenceLine): { member: string; t: number } | null {
  if (!l.at) return null;
  const k = LENGTH_TO_M[r.lengthUnit] ?? 1;
  const px = l.at.x * k, py = l.at.y * k;
  const N = new Map(st.nodes.map((q) => [q.id, q]));
  let size = 0;
  for (const q of st.nodes) size = Math.max(size, Math.abs(q.x), Math.abs(q.y));
  const tol = 1e-6 * Math.max(1, size);
  const onPath = new Set(path.map((p) => p.member));
  const hits: { member: string; t: number; path: boolean; leftEnd: boolean; rightEnd: boolean }[] = [];
  for (const m of st.members) {
    const a = N.get(m.a)!, b = N.get(m.b)!;
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    const t = ((px - a.x) * dx + (py - a.y) * dy) / L2;
    if (t < -tol || t > 1 + tol) continue;
    const tc = Math.min(1, Math.max(0, t));
    if (Math.hypot(a.x + dx * tc - px, a.y + dy * tc - py) > tol) continue;
    const end = (tt: number) => Math.abs(tc - tt) * Math.sqrt(L2) <= tol;
    // which end lies at the point, seen along x (right to left members flip)
    const atA = end(0), atB = end(1), aLeft = a.x < b.x || (a.x === b.x && a.y < b.y);
    hits.push({ member: m.id, t: atA ? 0 : atB ? 1 : tc, path: onPath.has(m.id), leftEnd: aLeft ? atA : atB, rightEnd: aLeft ? atB : atA });
  }
  if (!hits.length) return null;
  const own = l.member ? hits.find((h) => h.member === l.member) : undefined;
  if (own) return own;
  hits.sort((p, q) => Number(q.path) - Number(p.path));
  const pick = hits.filter((h) => h.path === hits[0].path);
  // at a joint: the member to the right of the point, or with `left` the one to its left
  return pick.find((h) => (l.left ? h.rightEnd : h.leftEnd)) ?? pick.find((h) => !h.leftEnd && !h.rightEnd) ?? pick[0];
}

/** Influence lines and moving-load envelopes of a region (undefined when it has none). */
export function solveTraffic(r: BeamRegion, base: Omit<NumStructure, 'loads'>, read: Read, evalExpr: Eval, errors: Record<string, string>): TrafficResult | undefined {
  const tr = r.traffic;
  if (!tr || (!tr.lines.length && !tr.loads.length)) return undefined;
  const structure: NumStructure = { ...base, supports: base.supports.map((s) => ({ ...s, settle: undefined })), loads: [] };
  const out: TrafficResult = { path: [], xs: [], step: 0, lines: [], moving: [], structure };
  try {
    out.path = loadPath(structure, new Set(r.members.filter((m) => m.deck).map((m) => m.id)));
  } catch (e) {
    out.error = (e as Error).message;
    return out;
  }
  const specs: TrainSpec[] = [];
  for (const ml of tr.loads) {
    try {
      const t = trainOf(ml, r, read, evalExpr);
      specs.push(t);
      out.moving.push({ id: ml.id, name: ml.name, P: t.P, offsets: t.offsets, q: t.q, dir: t.dir });
    } catch (e) {
      errors[ml.id] = (e as Error).message;
    }
  }
  const span = out.path[out.path.length - 1].x1 - out.path[0].x0;
  let step: number;
  try {
    step = tr.step?.trim() ? read(tr.step, 'm', r.lengthUnit, 'Step Δx') : autoStep(span, specs.flatMap((t) => t.offsets));
    if (!(step > 0)) throw new Error('Step Δx must be positive');
  } catch (e) {
    out.error = (e as Error).message;
    return out;
  }
  const queries: InfluenceQuery[] = [];
  for (const l of tr.lines) {
    if (l.quantity === 'Ry' || l.quantity === 'Rx' || l.quantity === 'Mr') {
      if (!r.supports.some((s) => s.id === l.support)) errors[l.id] = `${l.name}: pick a support`;
      else queries.push({ id: l.id, kind: l.quantity, support: l.support });
      continue;
    }
    const sec = sectionOf(r, structure, out.path, l);
    if (!sec) errors[l.id] = `${l.name}: the section is not on a member`;
    else queries.push({ id: l.id, kind: l.quantity, ...sec });
  }
  try {
    const res = influenceAnalysis(structure, out.path, step, queries, specs);
    out.xs = res.xs;
    out.step = res.step;
    if (res.step > step * (1 + 1e-9)) out.widened = true;
    for (const line of res.lines) {
      const l = tr.lines.find((q) => q.id === line.id)!, q = queries.find((x) => x.id === line.id)!;
      const m = q.member ? structure.members.find((x) => x.id === q.member) : undefined;
      const item: TrafficLine = { id: l.id, name: l.name, quantity: l.quantity, x: line.x, v: line.v };
      if (m && q.t !== undefined) {
        const N = new Map(structure.nodes.map((n) => [n.id, n]));
        const a = N.get(m.a)!, b = N.get(m.b)!;
        item.member = m.id;
        item.s = q.t * Math.hypot(b.x - a.x, b.y - a.y);
        item.xs = a.x + (b.x - a.x) * q.t;
        // drawn and exported in the beam's sign convention: sagging positive on a member drawn right to left too
        if (l.quantity === 'M' && b.x < a.x) item.v = item.v.map((v) => -v);
      }
      out.lines.push(item);
    }
    for (const env of res.trains) out.moving.find((m) => m.id === env.id)!.env = env;
  } catch (e) {
    out.error = e instanceof StructureError ? e.message : `Could not solve the moving loads: ${(e as Error).message}`;
  }
  return out;
}

/**
 * A combination with moving loads: its static solution plus each moving load's bound
 * times its factor (a positive factor adds the upper bound to the upper side), at the
 * stations of both, with both sides of every static jump.
 */
export function withMoving(sol: BeamSolution, parts: { env: TrainEnvelope; f: number }[], st: NumStructure): { max: BeamSolution; min: BeamSolution } {
  const mk = (): BeamSolution => ({ members: [], reactions: [], nodes: {}, max: {}, indeterminacy: sol.indeterminacy });
  const hi = mk(), lo = mk();
  const keys = ['N', 'V', 'M', 'dx', 'dy'] as const;
  for (const mr of sol.members) {
    const m = st.members.find((q) => q.id === mr.id);
    const L = mr.L;
    const jumps = new Set<number>();
    const stations = new Set<number>(mr.s);
    mr.s.forEach((s, i) => { if (i > 0 && mr.s[i - 1] === s) jumps.add(s); });
    for (const p of mr.pieces) if (p.s0 > 1e-12) jumps.add(p.s0);
    const envs = parts.map(({ env, f }) => ({ f, H: env.max.members.find((q) => q.id === mr.id)!, Lo: env.min.members.find((q) => q.id === mr.id)! }));
    for (const e of envs) for (const s of e.H.s) stations.add(Math.min(L, s));
    const H: MemberResult = { id: mr.id, L, s: [], N: [], V: [], M: [], dx: [], dy: [], pieces: [] };
    const Lo: MemberResult = { id: mr.id, L, s: [], N: [], V: [], M: [], dx: [], dy: [], pieces: [] };
    for (const s of [...stations].sort((a, b) => a - b)) {
      for (const at of jumps.has(s) && s > 0 && s < L ? [s - 1e-9 * L, s] : [s]) {
        const v = memberAt(mr, at);
        H.s.push(s); Lo.s.push(s);
        for (const key of keys) {
          let up = v[key], down = v[key];
          for (const e of envs) {
            const a = memberAt(e.H, at)[key] * e.f, b = memberAt(e.Lo, at)[key] * e.f;
            up += Math.max(a, b);
            down += Math.min(a, b);
          }
          H[key].push(up);
          Lo[key].push(down);
        }
      }
    }
    if (m?.W) H.sigma = H.s.map((_, i) => Math.max(Math.abs(H.N[i]), Math.abs(Lo.N[i])) / m.A + Math.max(Math.abs(H.M[i]), Math.abs(Lo.M[i])) / m.W!);
    H.pieces = linearPieces(H);
    Lo.pieces = linearPieces(Lo);
    hi.members.push(H);
    lo.members.push(Lo);
  }
  hi.reactions = sol.reactions.map((q) => ({ ...q }));
  lo.reactions = sol.reactions.map((q) => ({ ...q }));
  for (const { env, f } of parts) {
    sol.reactions.forEach((q, i) => {
      const a = env.max.reactions.find((x) => x.id === q.id), b = env.min.reactions.find((x) => x.id === q.id);
      if (!a || !b) return;
      for (const key of ['Rx', 'Ry', 'M'] as const) {
        hi.reactions[i][key] += Math.max(f * a[key], f * b[key]);
        lo.reactions[i][key] += Math.min(f * a[key], f * b[key]);
      }
    });
  }
  boundExtremes(hi, lo);
  return { max: hi, min: lo };
}

/** The moving loads of a combination with their factors (worksheet expressions, plain numbers). */
export function movingParts(cb: BeamCombo, tr: TrafficResult, evalExpr: Eval): { env: TrainEnvelope; f: number }[] {
  const out: { env: TrainEnvelope; f: number }[] = [];
  for (const m of tr.moving) {
    const src = cb.factors[m.id]?.trim() ?? '';
    if (!src) continue;
    const f = evalExpr(src);
    if (typeof f !== 'number' || !Number.isFinite(f)) throw new Error(`${cb.name}: the factor for ${m.name} must be a plain number`);
    if (f !== 0 && m.env) out.push({ env: m.env, f });
  }
  return out;
}

/** b.IL.M1(x), b.IL.M1_max …, and b.moving.LM1.M_max, .x_M_max, .pos_M_max, .B.Ry_max, .max.M(x) … */
export function trafficValue(r: BeamRegion, tr: TrafficResult, solutionValue: (sol: BeamSolution) => Record<string, unknown>): Record<string, unknown> {
  const F = r.forceUnit, Lu = r.lengthUnit;
  const k = LENGTH_TO_M[Lu] ?? 1;
  const metric = Lu === 'm' || Lu === 'cm' || Lu === 'mm';
  const length = (v: number) => math.unit(v, 'm').to(Lu);
  const force = (v: number) => math.unit(v, 'N').to(F);
  const moment = (v: number) => math.unit(v, 'N m').to(`${F} ${Lu}`);
  const ordinate = (q: TrafficLine['quantity'], v: number): unknown => (q === 'M' || q === 'Mr' ? length(v) : q === 'w' ? math.unit(v, 'm/N').to(`${metric ? 'mm' : 'in'}/${F}`) : v);
  const xOf = (x: unknown) => {
    const xs = typeof x === 'number' ? x : isUnit(x) ? ((x as Unit).toNumeric(Lu) as number) : NaN;
    if (!Number.isFinite(xs)) throw new Error('x must be a length');
    return xs * k;
  };
  const value: Record<string, unknown> = {};
  const IL: Record<string, unknown> = {};
  for (const l of tr.lines) {
    const name = identifierOf(l.name);
    IL[name] = (x: unknown) => {
      const xm = xOf(x);
      if (xm < l.x[0] - 1e-9 || xm > l.x[l.x.length - 1] + 1e-9) throw new Error(`x is outside the load path (${+(l.x[0] / k).toPrecision(6)} … ${+(l.x[l.x.length - 1] / k).toPrecision(6)} ${Lu})`);
      // the right-hand value where the line jumps
      let i = 0;
      while (i + 1 < l.x.length - 1 && l.x[i + 1] <= xm) i++;
      const h = l.x[i + 1] - l.x[i];
      const v = h > 0 ? l.v[i] + ((l.v[i + 1] - l.v[i]) * (xm - l.x[i])) / h : l.v[i + 1];
      return ordinate(l.quantity, v);
    };
    IL[`${name}_max`] = ordinate(l.quantity, Math.max(...l.v));
    IL[`${name}_min`] = ordinate(l.quantity, Math.min(...l.v));
    // the ordinates as vectors, for tables and sums (a position repeats where the line jumps)
    IL[`${name}_x`] = math.matrix(l.x.map(length) as never);
    IL[`${name}_η`] = IL[`${name}_eta`] = math.matrix(l.v.map((v) => ordinate(l.quantity, v)) as never);
  }
  if (tr.lines.length) value.IL = IL;
  const moving: Record<string, unknown> = {};
  for (const m of tr.moving) {
    const env = m.env;
    if (!env) continue;
    const v: Record<string, unknown> = {};
    const put = (key: ExtremeKey, e: Critical | undefined, unit: (x: number) => unknown) => {
      if (!e) return;
      v[key] = unit(e.value);
      v[`x_${key}`] = length(e.x);
      if (e.lead !== undefined) v[`pos_${key}`] = length(e.lead);
    };
    const ex = env.extremes;
    put('M_max', ex.M_max, moment); put('M_min', ex.M_min, moment);
    put('V_max', ex.V_max, force); put('V_min', ex.V_min, force);
    if (Math.max(Math.abs(ex.N_max?.value ?? 0), Math.abs(ex.N_min?.value ?? 0)) > 1e-9 * Math.max(Math.abs(ex.V_max?.value ?? 0), 1)) {
      put('N_max', ex.N_max, force); put('N_min', ex.N_min, force);
    }
    put('w_max', ex.w_max, (x) => math.unit(x, 'm').to(metric ? 'mm' : 'in'));
    for (const sp of r.supports) {
      const rs = env.reactions[sp.id];
      if (!rs) continue;
      const o: Record<string, unknown> = {};
      for (const key of Object.keys(rs) as ReactionKey[]) {
        if (key.startsWith('M') && sp.type !== 'fixed') continue;
        const e = rs[key]!;
        o[key] = key.startsWith('M') ? moment(e.value) : force(e.value);
        if (e.lead !== undefined) o[`pos_${key}`] = length(e.lead);
      }
      v[sp.label] = o;
    }
    v.max = solutionValue(env.max);
    v.min = solutionValue(env.min);
    moving[identifierOf(m.name)] = v;
  }
  if (Object.keys(moving).length) value.moving = moving;
  return value;
}

/** A name as a worksheet identifier ("ULS 1" → ULS_1). */
export function identifierOf(name: string): string {
  const s = name.trim().replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '');
  return /^\p{L}/u.test(s) ? s : `_${s}`;
}
