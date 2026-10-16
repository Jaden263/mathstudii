// Evaluates a plate region in the worksheet: the outline, supports, loads and material are
// read from the worksheet scope, the plate is meshed and solved once per change of those
// numbers (the factor is kept, so recalculating the sheet for anything else costs
// nothing), every load case is one right-hand side and every combination a sum of cases.
// The page gets the mesh with the fields of what it shows; the worksheet gets the extremes,
// the reactions, the reinforcement and each field as a function of (x, y).
import type { Unit } from 'mathjs';
import type { PlateRegion } from '../model/types';
import { math, isUnit } from '../engine/math';
import { concreteGrade, STEEL_GRADES, TIMBER_GRADES } from '../engine/materials';
import { quantity } from '../beam/evaluate';
import { loadCase } from '../beam/model';
import { POISSON } from '../beam/shear';
import { identifierOf } from '../beam/traffic';
import { cleanPolygon, meshPlate, type MeshFeatures, type PlateMesh } from './mesh';
import { combineFields, lineReactions, PlateError, solvePlate, type NumPlate, type NumPlateLoad, type NumPlateSupport, type PlateFields, type PlateSolution } from './solve';
import { minimumSteel, principal, rebarProps, steelArea, surfaceStress, woodArmer, type RebarProps } from './design';
import { PlateSampler } from './sample';
import { edgeName, type PlateLoad } from './model';
import type { Pt } from './cdt';

type Eval = (src: string) => unknown;

/** Every field the plan can show: w per node, the rest per element corner. */
export interface PlateFieldSet {
  w: Float64Array | Float32Array;
  mx: Float64Array | Float32Array;
  my: Float64Array | Float32Array;
  mxy: Float64Array | Float32Array;
  vx: Float64Array | Float32Array;
  vy: Float64Array | Float32Array;
  m1: Float64Array | Float32Array;
  m2: Float64Array | Float32Array;
  /** Wood–Armer moments (bottom ≥ 0, top ≤ 0) and reinforcement (m²/m), with a concrete design. */
  mxb?: Float64Array | Float32Array;
  myb?: Float64Array | Float32Array;
  mxt?: Float64Array | Float32Array;
  myt?: Float64Array | Float32Array;
  asxb?: Float64Array | Float32Array;
  asyb?: Float64Array | Float32Array;
  asxt?: Float64Array | Float32Array;
  asyt?: Float64Array | Float32Array;
  /** Von Mises stress at the faces (steel). */
  sigma?: Float64Array | Float32Array;
}

export type FieldKey = keyof PlateFieldSet;
export const CORNER_FIELDS: FieldKey[] = ['mx', 'my', 'mxy', 'vx', 'vy', 'm1', 'm2', 'mxb', 'myb', 'mxt', 'myt', 'asxb', 'asyb', 'asxt', 'asyt', 'sigma'];

/** A support's reaction in the view shown: the total (N, up), per length along a line (N/m), the end forces. */
export interface PlateReaction {
  id: string;
  name: string;
  kind: 'edge' | 'wall' | 'column';
  R: number;
  /** Envelope: the least total. */
  Rmin?: number;
  /** Line supports: positions along the line (m) and reactions per length there. */
  s?: number[];
  r?: number[];
  rmin?: number[];
  ends?: [number, number];
  /** The nodes along it (to draw the reaction), with the line's end points. */
  a?: Pt;
  b?: Pt;
}

/** A load as drawn (m, N). */
export type PlateGlyph =
  | { id: string; kind: 'area' | 'self'; q: number; case?: string }
  | { id: string; kind: 'patch'; q: number; poly: Pt[]; case?: string }
  | { id: string; kind: 'line'; q: number; a: Pt; b: Pt; case?: string }
  | { id: string; kind: 'point'; F: number; at: Pt; case?: string };

export interface PlateCase {
  id: string;
  name: string;
  kind?: 'ULS' | 'SLS';
  error?: string;
  /** Worker side only. */
  fields?: PlateFieldSet;
  raw?: PlateFields;
}

export interface PlateResult {
  kind: 'plate';
  /** Geometry as evaluated (m). */
  outline: Pt[];
  openings: { id: string; points: Pt[] }[];
  walls: { id: string; a: Pt; b: Pt }[];
  columns: { id: string; at: Pt; head?: Pt[] }[];
  loads: PlateGlyph[];
  mesh?: PlateMesh;
  /** What is shown: one case or combination, or the envelope's upper side… */
  fields?: PlateFieldSet;
  /** …and its lower side. */
  lower?: PlateFieldSet;
  reactions?: PlateReaction[];
  cases?: PlateCase[];
  combos?: PlateCase[];
  /** Case id, combination id or 'envelope'. */
  view?: string;
  /** E (Pa), ν, t (m), D (N·m), self-weight per area (N/m²). */
  material?: { E: number; nu: number; t: number; D: number; g: number; steel: boolean };
  /** Concrete design: effective depths (m), a_s,min per direction (m²/m), corners where μ exceeds μ_lim. */
  design?: { dx: number; dy: number; asMinX: number; asMinY: number; over: number };
  unknowns?: number;
  millis?: number;
  /** The solution came from the cache (nothing about the plate changed). */
  cached?: boolean;
  /** Item id ('t', 'material', 'mesh', a load, wall, column, 'edge:i') → its problem. */
  errors: Record<string, string>;
  error?: string;
  /** Kept on the worker side only. */
  solution?: PlateSolution;
  rebar?: RebarProps;
}

const LENGTH_TO_M: Record<string, number> = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 };
const PLAIN = /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i;
const GRAVITY = 9.80665;

/** E (Pa), ν and ρ (kg/m³): concrete EN 1992-1-1 Table 3.1 (ν = 0.2, 25 kN/m³), steel EN 1993-1-1 3.2.6. */
export function plateMaterial(name: string): { E: number; nu: number; rho: number; steel: boolean } {
  const key = name.trim().toUpperCase().replace(/\s+/g, '');
  if (STEEL_GRADES.some((g) => key.startsWith(g))) return { E: 210e9, nu: POISSON.steel, rho: 7850, steel: true };
  if (/^C\d/.test(key) && !TIMBER_GRADES.some((g) => g.toUpperCase() === key)) return { E: concreteGrade(name).E_cm * 1e9, nu: POISSON.concrete, rho: 25e3 / GRAVITY, steel: false };
  throw new Error(`Plates are isotropic: choose a concrete class (C30/37 …), a steel grade (S355 …) or your own E and ν (not "${name}")`);
}

/** A round element size near A/1200 elements: 1, 2, 2.5, 5 × 10ⁿ. */
export function autoSize(area: number): number {
  const h = Math.sqrt(area / 1200);
  const p = 10 ** Math.floor(Math.log10(h)), f = h / p;
  return (f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10) * p;
}

// ---------------------------------------------------------------- the solve, cached

const cache = new Map<string, { mesh: PlateMesh; sol: PlateSolution }>();

function solveCached(features: MeshFeatures, p: Omit<NumPlate, 'mesh'>): { mesh: PlateMesh; sol: PlateSolution; cached: boolean } {
  const key = JSON.stringify([features, p]);
  const hit = cache.get(key);
  if (hit) {
    // most recently used last
    cache.delete(key);
    cache.set(key, hit);
    return { ...hit, cached: true };
  }
  const mesh = meshPlate(features);
  const sol = solvePlate({ ...p, mesh });
  cache.set(key, { mesh, sol });
  while (cache.size > 6) cache.delete(cache.keys().next().value!);
  return { mesh, sol, cached: false };
}

// ---------------------------------------------------------------- region → numbers → results

export function solvePlateRegion(r: PlateRegion, evalExpr: Eval): PlateResult {
  const t0 = performance.now();
  const res: PlateResult = { kind: 'plate', outline: [], openings: [], walls: [], columns: [], loads: [], errors: {} };
  const k = LENGTH_TO_M[r.lengthUnit] ?? 1, F = r.forceUnit, Lu = r.lengthUnit;
  const fail = (id: string, e: unknown) => (res.errors[id] = (e as Error).message);
  const length = (src: string, what: string) => (PLAIN.test(src) ? Number(src) * k : quantity(evalExpr, src, 'm', Lu, what));
  const point = (p: { x: string; y: string }, what: string): Pt => [length(p.x, `${what} x`), length(p.y, `${what} y`)];

  // outline and openings
  try {
    res.outline = r.outline.map((p, i) => point(p, `Corner ${i + 1}`));
    if (res.outline.length < 3) throw new Error('The outline needs at least three corners');
    if (cleanPolygon(res.outline).length < 3) throw new Error('The outline has no area');
  } catch (e) {
    fail('outline', e);
  }
  for (const o of r.openings) {
    try {
      const pts = o.points.map((p, i) => point(p, `${o.name} corner ${i + 1}`));
      if (pts.length < 3) throw new Error('An opening needs at least three corners');
      res.openings.push({ id: o.id, points: pts });
    } catch (e) {
      fail(o.id, e);
    }
  }
  // material and thickness
  let mat: { E: number; nu: number; rho: number; steel: boolean } | undefined;
  let t = 0;
  try {
    t = quantity(evalExpr, r.thickness, 'm', 'mm', 'Thickness');
    if (!(t > 0)) throw new Error('The thickness must be positive');
  } catch (e) {
    fail('t', e);
  }
  try {
    if (r.material === 'custom') {
      const E = quantity(evalExpr, r.E ?? '', 'Pa', 'GPa', 'E');
      const nuV = r.nu?.trim() ? evalExpr(r.nu) : 0.2;
      if (typeof nuV !== 'number' || !(nuV >= 0 && nuV < 0.5)) throw new Error('ν must be a plain number from 0 to 0.5');
      const rho = r.rho?.trim() ? quantity(evalExpr, r.rho, 'kg/m^3', 'kg/m^3', 'ρ') : 0;
      if (!(E > 0)) throw new Error('E must be positive');
      mat = { E, nu: nuV, rho, steel: false };
    } else mat = plateMaterial(r.material);
  } catch (e) {
    fail('material', e);
  }

  const supports: NumPlateSupport[] = [];
  const names: { id: string; name: string; kind: PlateReaction['kind']; a?: Pt; b?: Pt }[] = [];
  const hardLines: [Pt, Pt][] = [], hardPoints: Pt[] = [], jumps: [Pt, Pt][] = [];
  const n = res.outline.length;
  if (n >= 3) {
    r.edges.slice(0, n).forEach((ed, i) => {
      if (!ed || ed.support === 'free') return;
      const a = res.outline[i], b = res.outline[(i + 1) % n];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) return;
      const id = `edge:${i}`;
      try {
        const sp: NumPlateSupport = { id, kind: 'line', a, b, fix: ed.support };
        if (ed.support === 'spring') {
          const kk = ed.k?.trim() ? quantity(evalExpr, ed.k, 'N/m^2', `${F}/${Lu}^2`, 'Spring') : 0;
          const kr = ed.kr?.trim() ? quantity(evalExpr, ed.kr, 'N', `${F}*${Lu}/${Lu}`, 'Rotational spring') : 0;
          if (!(kk > 0) && !(kr > 0)) throw new Error('An elastic edge needs a spring stiffness (per length)');
          if (kk < 0 || kr < 0) throw new Error('A spring stiffness must be positive');
          Object.assign(sp, { k: kk, kr });
        }
        supports.push(sp);
        names.push({ id, name: edgeName(i), kind: 'edge', a, b });
      } catch (e) {
        fail(id, e);
      }
    });
  }
  for (const w of r.walls) {
    try {
      const a = point(w.a, w.name), b = point(w.b, w.name);
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) throw new Error('The wall has no length');
      const kk = w.k?.trim() ? quantity(evalExpr, w.k, 'N/m^2', `${F}/${Lu}^2`, 'Spring') : 0;
      if (kk < 0) throw new Error('A spring stiffness must be positive');
      supports.push({ id: w.id, kind: 'line', a, b, fix: kk > 0 ? 'spring' : 'simple', ...(kk > 0 ? { k: kk } : {}) });
      names.push({ id: w.id, name: w.name, kind: 'wall', a, b });
      res.walls.push({ id: w.id, a, b });
      hardLines.push([a, b]);
      jumps.push([a, b]);
    } catch (e) {
      fail(w.id, e);
    }
  }
  for (const c of r.columns) {
    try {
      const at = point(c, c.name);
      const kk = c.k?.trim() ? quantity(evalExpr, c.k, 'N/m', `${F}/${Lu}`, 'Spring') : 0;
      if (kk < 0) throw new Error('A spring stiffness must be positive');
      if (c.b?.trim()) {
        const b = quantity(evalExpr, c.b, 'm', 'mm', 'Column size b'), h = c.round ? b : quantity(evalExpr, c.h?.trim() ? c.h : c.b, 'm', 'mm', 'Column size h');
        if (!(b > 0 && h > 0)) throw new Error('The column size must be positive');
        const H = c.H?.trim() ? length(c.H, 'Column height') : 3;
        if (!(H > 0)) throw new Error('The column height must be positive');
        // the head: a rectangle, or a polygon of 16 sides for a round column
        const head: Pt[] = c.round
          ? Array.from({ length: 16 }, (_, i) => [at[0] + (b / 2) * Math.cos((Math.PI * i) / 8), at[1] + (b / 2) * Math.sin((Math.PI * i) / 8)])
          : [[at[0] - b / 2, at[1] - h / 2], [at[0] + b / 2, at[1] - h / 2], [at[0] + b / 2, at[1] + h / 2], [at[0] - b / 2, at[1] + h / 2]];
        // a spring k spreads over the head; else the column pressed along its height, E A / H over A
        const area = c.round ? (Math.PI * b * b) / 4 : b * h;
        const cBed = kk > 0 ? kk / area : (mat?.E ?? 30e9) / H;
        supports.push({ id: c.id, kind: 'area', polygon: head, c: cBed });
        head.forEach((p, i) => hardLines.push([p, head[(i + 1) % head.length]]));
        res.columns.push({ id: c.id, at, head });
      } else {
        supports.push({ id: c.id, kind: 'point', at, ...(kk > 0 ? { k: kk } : {}) });
        hardPoints.push(at);
        res.columns.push({ id: c.id, at });
      }
      names.push({ id: c.id, name: c.name, kind: 'column' });
    } catch (e) {
      fail(c.id, e);
    }
  }

  // loads, each tagged with its case
  const lc = r.loadCases;
  const cases = lc ? lc.cases.map((c) => c.id) : ['all'];
  const loads: NumPlateLoad[] = [];
  const softLines: [Pt, Pt][] = [], softPoints: Pt[] = [];
  for (const l of r.loads) {
    const c = lc ? loadCase(l, lc) : 'all';
    const tag = lc ? { case: c } : {};
    try {
      const area = (src: string) => quantity(evalExpr, src, 'N/m^2', `${F}/${Lu}^2`, 'Area load');
      if (l.type === 'area') {
        const q = area(l.q);
        loads.push({ id: l.id, case: c, type: 'area', q });
        res.loads.push({ id: l.id, kind: 'area', q, ...tag });
      } else if (l.type === 'self') {
        const f = l.factor?.trim() ? Number(evalExpr(l.factor)) : 1;
        if (!Number.isFinite(f)) throw new Error('Self-weight: the factor must be a plain number');
        if (!mat || !t) continue;
        const q = mat.rho * GRAVITY * t * f;
        if (q) loads.push({ id: l.id, case: c, type: 'area', q });
        res.loads.push({ id: l.id, kind: 'self', q, ...tag });
      } else if (l.type === 'patch') {
        const q = area(l.q);
        const [x1, x2] = [length(l.x1, 'x₁'), length(l.x2, 'x₂')].sort((p, q2) => p - q2), [y1, y2] = [length(l.y1, 'y₁'), length(l.y2, 'y₂')].sort((p, q2) => p - q2);
        if (!(x2 > x1 && y2 > y1)) throw new Error('The patch has no area');
        const poly: Pt[] = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
        loads.push({ id: l.id, case: c, type: 'area', q, polygon: poly });
        poly.forEach((p, i) => softLines.push([p, poly[(i + 1) % 4]]));
        res.loads.push({ id: l.id, kind: 'patch', q, poly, ...tag });
      } else if (l.type === 'line') {
        const q = quantity(evalExpr, l.q, 'N/m', `${F}/${Lu}`, 'Line load');
        const a: Pt = [length(l.x1, 'x₁'), length(l.y1, 'y₁')], b: Pt = [length(l.x2, 'x₂'), length(l.y2, 'y₂')];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) throw new Error('The line load has no length');
        loads.push({ id: l.id, case: c, type: 'line', q, a, b });
        softLines.push([a, b]);
        jumps.push([a, b]);
        res.loads.push({ id: l.id, kind: 'line', q, a, b, ...tag });
      } else {
        const Fv = quantity(evalExpr, l.F, 'N', F, 'Force');
        const at: Pt = [length(l.x, 'x'), length(l.y, 'y')];
        loads.push({ id: l.id, case: c, type: 'point', F: Fv, at });
        softPoints.push(at);
        res.loads.push({ id: l.id, kind: 'point', F: Fv, at, ...tag });
      }
    } catch (e) {
      fail(l.id, e);
    }
  }

  // reinforcement (concrete only)
  let rp: RebarProps | undefined;
  if (r.rebar && mat && !mat.steel && t > 0) {
    try {
      if (r.material === 'custom') throw new Error('Reinforcement needs a concrete class');
      rp = rebarProps({
        concrete: r.material, steel: r.rebar.steel, t, outer: r.rebar.outer,
        cover: quantity(evalExpr, r.rebar.cover, 'm', 'mm', 'Cover'), bar: quantity(evalExpr, r.rebar.bar, 'm', 'mm', 'Bar diameter'),
      });
    } catch (e) {
      fail('rebar', e);
    }
  }

  const blocking = ['outline', 't', 'material'].map((id) => res.errors[id]).find(Boolean)
    ?? r.openings.map((o) => res.errors[o.id]).find(Boolean) ?? [...r.walls, ...r.columns].map((q) => res.errors[q.id]).find(Boolean)
    ?? r.edges.map((_, i) => res.errors[`edge:${i}`]).find(Boolean);
  if (blocking || !mat || !t) {
    res.error = blocking ?? 'The plate has an error';
    return res;
  }
  if (!supports.length) {
    res.error = 'Give the plate supports: an edge (Outline tab), a wall or a column';
    return res;
  }
  let size: number;
  try {
    const A = Math.abs(cleanPolygon(res.outline).reduce((s, p, i, arr) => s + p[0] * arr[(i + 1) % arr.length][1] - arr[(i + 1) % arr.length][0] * p[1], 0) / 2);
    size = r.mesh?.trim() ? length(r.mesh, 'Element size') : autoSize(A);
    if (!(size > 0)) throw new Error('The element size must be positive');
  } catch (e) {
    fail('mesh', e);
    res.error = (e as Error).message;
    return res;
  }
  res.material = { E: mat.E, nu: mat.nu, t, D: (mat.E * t ** 3) / (12 * (1 - mat.nu ** 2)), g: mat.rho * GRAVITY * t, steel: mat.steel };
  if (rp) res.design = { dx: rp.dx, dy: rp.dy, asMinX: minimumSteel(rp.dx, rp), asMinY: minimumSteel(rp.dy, rp), over: 0 };
  res.rebar = rp;

  let solved: ReturnType<typeof solveCached>;
  try {
    solved = solveCached(
      { outline: res.outline, openings: res.openings.map((o) => o.points), lines: hardLines, points: hardPoints, softLines, softPoints, size },
      { E: mat.E, nu: mat.nu, t, supports, loads, cases, jumps },
    );
  } catch (e) {
    res.error = e instanceof PlateError ? e.message : `Could not solve: ${(e as Error).message}`;
    return res;
  }
  const { mesh, sol } = solved;
  res.mesh = mesh;
  res.solution = sol;
  res.unknowns = sol.unknowns;
  res.cached = solved.cached;
  const derive = (f: PlateFields) => fieldSet(f, mesh, rp, mat!.steel ? t : 0);

  const reactionsOf = (f: PlateFields): PlateReaction[] => names.map((nm) => {
    const si = sol.supports.findIndex((s) => s.id === nm.id);
    const out: PlateReaction = { id: nm.id, name: nm.name, kind: nm.kind, R: f.support[si] ?? 0, a: nm.a, b: nm.b };
    if (nm.kind !== 'column' && si >= 0) Object.assign(out, lineReactions(sol, f, si));
    return out;
  });

  try {
    if (!lc) {
      const f = sol.cases[0];
      res.fields = derive(f);
      res.reactions = reactionsOf(f);
    } else {
      const caseFields = new Map(lc.cases.map((c, i) => [c.id, sol.cases[i]]));
      res.cases = lc.cases.map((c) => ({ id: c.id, name: c.name, raw: caseFields.get(c.id), fields: derive(caseFields.get(c.id)!) }));
      res.combos = lc.combos.map((cb) => {
        const list: PlateFields[] = [], factors: number[] = [];
        for (const c of lc.cases) {
          const src = cb.factors[c.id]?.trim() ?? '';
          if (!src) continue;
          const fv = evalExpr(src);
          if (typeof fv !== 'number' || !Number.isFinite(fv)) return { id: cb.id, name: cb.name, kind: cb.kind, error: `${cb.name}: the factor for ${c.name} must be a plain number` };
          list.push(caseFields.get(c.id)!);
          factors.push(fv);
        }
        const raw = list.length ? combineFields(list, factors) : combineFields([sol.cases[0]], [0]);
        return { id: cb.id, name: cb.name, kind: cb.kind, raw, fields: derive(raw) };
      });
      const view = lc.view ?? lc.combos.find((c) => c.kind === 'ULS')?.id ?? lc.combos[0]?.id ?? lc.cases[0]?.id;
      res.view = view;
      const ok = res.combos.filter((c) => c.fields);
      if (view === 'envelope' && ok.length) {
        const env = envelope(ok);
        res.fields = env.max;
        res.lower = env.min;
        res.reactions = envelopeReactions(ok.filter((c) => c.kind !== 'SLS').map((c) => reactionsOf(c.raw!)), reactionsOf(ok[0].raw!));
      } else {
        const shown = [...res.combos, ...res.cases].find((c) => c.id === view) ?? res.combos.find((c) => c.fields) ?? res.cases[0];
        res.fields = shown.fields;
        res.reactions = shown.raw ? reactionsOf(shown.raw) : undefined;
      }
      const failed = res.combos.find((c) => c.error);
      if (failed) res.error = failed.error;
    }
  } catch (e) {
    res.error = `Could not evaluate the results: ${(e as Error).message}`;
  }
  if (res.design && rp) res.design.over = overCount(res, rp);
  res.millis = performance.now() - t0;
  return res;
}

/** Derived fields from a solution's moments: principal and Wood–Armer moments, reinforcement, surface stress. */
function fieldSet(f: PlateFields, mesh: PlateMesh, rp: RebarProps | undefined, steelT: number): PlateFieldSet {
  const nc = mesh.quads.length;
  const m1 = new Float64Array(nc), m2 = new Float64Array(nc);
  for (let c = 0; c < nc; c++) [m1[c], m2[c]] = principal(f.mx[c], f.my[c], f.mxy[c]);
  const out: PlateFieldSet = { w: f.w, mx: f.mx, my: f.my, mxy: f.mxy, vx: f.vx, vy: f.vy, m1, m2 };
  if (rp) {
    const mxb = new Float64Array(nc), myb = new Float64Array(nc), mxt = new Float64Array(nc), myt = new Float64Array(nc);
    const asxb = new Float64Array(nc), asyb = new Float64Array(nc), asxt = new Float64Array(nc), asyt = new Float64Array(nc);
    for (let c = 0; c < nc; c++) {
      const wa = woodArmer(f.mx[c], f.my[c], f.mxy[c]);
      mxb[c] = wa.xb; myb[c] = wa.yb; mxt[c] = wa.xt; myt[c] = wa.yt;
      asxb[c] = steelArea(wa.xb, rp.dx, rp).as;
      asyb[c] = steelArea(wa.yb, rp.dy, rp).as;
      asxt[c] = steelArea(-wa.xt, rp.dx, rp).as;
      asyt[c] = steelArea(-wa.yt, rp.dy, rp).as;
    }
    Object.assign(out, { mxb, myb, mxt, myt, asxb, asyb, asxt, asyt });
  }
  if (steelT) {
    const sigma = new Float64Array(nc);
    for (let c = 0; c < nc; c++) sigma[c] = surfaceStress(f.mx[c], f.my[c], f.mxy[c], steelT);
    out.sigma = sigma;
  }
  return out;
}

/** Corners where a Wood–Armer moment needs more than μ_lim (compression reinforcement or a thicker slab). */
function overCount(res: PlateResult, rp: RebarProps): number {
  const sets = [res.fields, ...(res.combos ?? []).filter((c) => c.kind !== 'SLS').map((c) => c.fields)].filter(Boolean) as PlateFieldSet[];
  let n = 0;
  for (const s of sets) {
    if (!s.mxb) continue;
    for (let c = 0; c < s.mxb.length; c++) {
      if (steelArea(s.mxb[c], rp.dx, rp).over || steelArea(s.myb![c], rp.dy, rp).over || steelArea(-s.mxt![c], rp.dx, rp).over || steelArea(-s.myt![c], rp.dy, rp).over) n++;
    }
    if (n) break;
  }
  return n;
}

/**
 * Upper and lower bounds over the combinations: moments, shear, design moments,
 * reinforcement and stress over the ULS ones, the deflection over the SLS ones (each over
 * all of them where there are none of the kind).
 */
export function envelope(combos: PlateCase[]): { max: PlateFieldSet; min: PlateFieldSet } {
  const uls = combos.filter((c) => c.kind !== 'SLS'), sls = combos.filter((c) => c.kind === 'SLS');
  const forces = (uls.length ? uls : combos).map((c) => c.fields!), defl = (sls.length ? sls : combos).map((c) => c.fields!);
  const bound = (sets: PlateFieldSet[], key: FieldKey, pick: (a: number, b: number) => number) => {
    const first = sets[0][key];
    if (!first) return undefined;
    const out = Float64Array.from(first);
    for (const s of sets.slice(1)) {
      const a = s[key]!;
      for (let i = 0; i < out.length; i++) out[i] = pick(out[i], a[i]);
    }
    return out;
  };
  const side = (pick: (a: number, b: number) => number): PlateFieldSet => {
    const out = { w: bound(defl, 'w', pick)! } as PlateFieldSet;
    for (const key of CORNER_FIELDS) {
      const v = bound(forces, key, pick);
      if (v) out[key] = v;
    }
    return out;
  };
  return { max: side(Math.max), min: side(Math.min) };
}

function envelopeReactions(sets: PlateReaction[][], first: PlateReaction[]): PlateReaction[] {
  if (!sets.length) return first;
  return first.map((r0, i) => {
    const all = sets.map((s) => s[i]);
    const out: PlateReaction = { ...r0, R: Math.max(...all.map((q) => q.R)), Rmin: Math.min(...all.map((q) => q.R)) };
    if (r0.r) {
      out.r = r0.r.map((_, k) => Math.max(...all.map((q) => q.r![k])));
      out.rmin = r0.r.map((_, k) => Math.min(...all.map((q) => q.r![k])));
    }
    return out;
  });
}

/** What the page needs: the mesh and the fields shown in single precision; the cases' names and errors. */
export function slimPlate(res: PlateResult): PlateResult {
  const f32 = (s?: PlateFieldSet): PlateFieldSet | undefined => {
    if (!s) return undefined;
    const out = {} as PlateFieldSet;
    for (const [k, v] of Object.entries(s)) if (v) (out as unknown as Record<string, Float32Array>)[k] = Float32Array.from(v as Float64Array);
    return out;
  };
  const slim = (list?: PlateCase[]) => list?.map(({ id, name, kind, error }) => ({ id, name, kind, error }));
  const { solution: _s, rebar: _r, ...rest } = res;
  void _s;
  void _r;
  return {
    ...rest, cases: slim(res.cases), combos: slim(res.combos), fields: f32(res.fields), lower: f32(res.lower),
    mesh: res.mesh && { ...res.mesh, tangent: undefined, chord: undefined },
  };
}

// ---------------------------------------------------------------- worksheet values

type Value = Record<string, unknown>;

/** Field keys and their worksheet names. */
const NAMES: [FieldKey, string][] = [
  ['mx', 'm_x'], ['my', 'm_y'], ['mxy', 'm_xy'], ['m1', 'm_1'], ['m2', 'm_2'], ['vx', 'v_x'], ['vy', 'v_y'],
  ['mxb', 'm_x_bot'], ['myb', 'm_y_bot'], ['mxt', 'm_x_top'], ['myt', 'm_y_top'],
  ['asxb', 'a_s_x_bot'], ['asyb', 'a_s_y_bot'], ['asxt', 'a_s_x_top'], ['asyt', 'a_s_y_top'], ['sigma', 'σ'],
];

export function plateValue(r: PlateRegion, res: PlateResult): Value {
  const F = r.forceUnit, Lu = r.lengthUnit, k = LENGTH_TO_M[Lu] ?? 1;
  const metric = Lu === 'm' || Lu === 'cm' || Lu === 'mm';
  const mesh = res.mesh!;
  const sampler = new PlateSampler(mesh);
  const unitOf = (key: FieldKey | 'w') => {
    if (key === 'w') return (v: number) => math.unit(v, 'm').to(metric ? 'mm' : 'in');
    if (key === 'vx' || key === 'vy') return (v: number) => math.unit(v, 'N/m').to(`${F}/${Lu}`);
    if (key.startsWith('as')) return (v: number) => math.unit(v, 'm^2/m').to('cm^2/m');
    if (key === 'sigma') return (v: number) => math.unit(v, 'Pa').to('MPa');
    return (v: number) => math.unit(v, 'N m / m').to(`${F} ${Lu} / ${Lu}`);
  };
  const coord = (v: unknown, what: string) => {
    const m = typeof v === 'number' ? v * k : isUnit(v) ? ((v as Unit).toNumeric('m') as number) : NaN;
    if (!Number.isFinite(m)) throw new Error(`${what} must be a length`);
    return m;
  };
  const spot = (x: unknown, y: unknown) => {
    const X = coord(x, 'x'), Y = coord(y, 'y');
    const s = sampler.locate(X, Y);
    if (!s) throw new Error(`(${+(X / k).toPrecision(6)}, ${+(Y / k).toPrecision(6)}) ${Lu} is not on the plate`);
    return s;
  };
  /** Extremes of a set (w over nodes, the rest over corners). */
  const extremes = (s: PlateFieldSet, value: Value, lower?: PlateFieldSet) => {
    const ext = (a: ArrayLike<number>) => {
      let mx = -Infinity, mn = Infinity;
      for (let i = 0; i < a.length; i++) {
        if (a[i] > mx) mx = a[i];
        if (a[i] < mn) mn = a[i];
      }
      return { mx, mn };
    };
    const lo = lower ?? s;
    const w = ext(s.w), wl = ext(lo.w);
    const u = unitOf('w');
    // w_max is the largest deflection (downwards positive), w_min the largest lift
    value.w_max = u(w.mx);
    value.w_min = u(wl.mn);
    for (const [key, name] of NAMES) {
      const a = s[key], b = lo[key];
      if (!a || !b) continue;
      const toU = unitOf(key);
      const e = ext(a), el = ext(b);
      if (key === 'mxt' || key === 'myt' || key === 'm2') value[`${name}_min`] = toU(el.mn);
      else if (key === 'mxb' || key === 'myb' || key === 'm1' || key.startsWith('as') || key === 'sigma') value[`${name}_max`] = toU(e.mx);
      else {
        value[`${name}_max`] = toU(e.mx);
        value[`${name}_min`] = toU(el.mn);
      }
    }
    if (s.sigma) value.sigma_max = value['σ_max'];
    // the largest resultant shear |v|
    let vmax = 0;
    for (let c = 0; c < s.vx.length; c++) vmax = Math.max(vmax, Math.hypot(s.vx[c], s.vy[c]), Math.hypot(lo.vx[c], lo.vy[c]));
    value.v_max = unitOf('vx')(vmax);
  };
  const functions = (s: PlateFieldSet, value: Value) => {
    value.w = (x: unknown, y: unknown) => unitOf('w')(sampler.nodal(s.w, spot(x, y)));
    for (const [key, name] of NAMES) {
      const a = s[key];
      if (!a) continue;
      value[name] = (x: unknown, y: unknown) => unitOf(key)(sampler.corner(a, spot(x, y)));
    }
    if (s.sigma) value.sigma = value['σ'];
  };
  const reactions = (list: PlateReaction[] | undefined, value: Value) => {
    let sum = 0;
    for (const q of list ?? []) {
      const o = (value[q.name.trim()] ??= {}) as Value;
      o.R = math.unit(q.R, 'N').to(F);
      sum += q.R;
      if (q.r) {
        const inner = q.r.slice(1, -1).filter(Number.isFinite);
        const all = inner.length ? inner : q.r;
        o.r_max = math.unit(Math.max(...(q.r ? all : [0])), 'N/m').to(`${F}/${Lu}`);
        o.r_min = math.unit(Math.min(...(q.rmin ? q.rmin.slice(1, -1) : all)), 'N/m').to(`${F}/${Lu}`);
        o.F_a = math.unit(q.ends![0], 'N').to(F);
        o.F_b = math.unit(q.ends![1], 'N').to(F);
      }
      if (q.Rmin !== undefined) o.R_min = math.unit(q.Rmin, 'N').to(F);
    }
    value.R_sum = math.unit(sum, 'N').to(F);
  };
  const general = (value: Value) => {
    const m = res.material!;
    value.t = math.unit(m.t, 'm').to('mm');
    value.D = math.unit(m.D, 'N m').to(`${F} ${Lu}`);
    if (res.design) {
      value.d_x = math.unit(res.design.dx, 'm').to('mm');
      value.d_y = math.unit(res.design.dy, 'm').to('mm');
      value.a_s_min_x = math.unit(res.design.asMinX, 'm^2/m').to('cm^2/m');
      value.a_s_min_y = math.unit(res.design.asMinY, 'm^2/m').to('cm^2/m');
    }
  };
  const solutionValue = (s: PlateFieldSet, reacts?: PlateReaction[]): Value => {
    const value: Value = {};
    extremes(s, value);
    functions(s, value);
    reactions(reacts, value);
    return value;
  };
  const reactsOf = (raw?: PlateFields) => (raw ? caseReactions(res, raw) : undefined);

  if (!r.loadCases || !res.combos) {
    const v = solutionValue(res.fields!, res.reactions);
    general(v);
    return v;
  }
  const named = (list: PlateCase[] = []) => Object.fromEntries(list.filter((c) => c.fields).map((c) => {
    const v = solutionValue(c.fields!, reactsOf(c.raw));
    general(v);
    return [identifierOf(c.name), v];
  }));
  const value: Value = { cases: named(res.cases), combos: named(res.combos) };
  const ok = res.combos.filter((c) => c.fields);
  if (!ok.length) return value;
  // governing: moments, shear and reinforcement over the ULS combinations, deflections over the SLS ones
  const env = envelope(ok);
  const gov: Value = {};
  extremes(env.max, gov, env.min);
  // the plain fields as functions of the first ULS combination (w of the first SLS), the envelope's two sides as well
  const firstUls = ok.find((c) => c.kind !== 'SLS') ?? ok[0], firstSls = ok.find((c) => c.kind === 'SLS') ?? ok[0];
  functions({ ...firstUls.fields!, w: firstSls.fields!.w }, gov);
  // design quantities are governed by the envelope: a_s(x, y) is the most needed there
  for (const [key, name] of NAMES) {
    if (key.startsWith('as') || key === 'mxb' || key === 'myb' || key === 'sigma') {
      const a = env.max[key];
      if (a) gov[name] = (x: unknown, y: unknown) => unitOf(key)(sampler.corner(a, spot(x, y)));
    } else if (key === 'mxt' || key === 'myt') {
      const a = env.min[key];
      if (a) gov[name] = (x: unknown, y: unknown) => unitOf(key)(sampler.corner(a, spot(x, y)));
    }
  }
  if (env.max.sigma) gov.sigma = gov['σ'];
  const max: Value = {}, min: Value = {};
  functions(env.max, max);
  functions(env.min, min);
  gov.max = max;
  gov.min = min;
  // reactions: per support the ULS combination with the largest total
  const uls = ok.filter((c) => c.kind !== 'SLS');
  const reacts = (uls.length ? uls : ok).map((c) => reactsOf(c.raw)!);
  const pickR = reacts[0].map((_, i) => reacts.map((l) => l[i]).reduce((a, b) => (Math.abs(b.R) > Math.abs(a.R) ? b : a)));
  reactions(pickR, gov);
  general(gov);
  return { ...gov, ...value };
}

/** The reactions of a case or combination (for its worksheet values). */
function caseReactions(res: PlateResult, f: PlateFields): PlateReaction[] {
  const sol = res.solution!;
  return (res.reactions ?? []).map((q) => {
    const si = sol.supports.findIndex((s) => s.id === q.id);
    const out: PlateReaction = { ...q, R: f.support[si] ?? 0, Rmin: undefined, rmin: undefined };
    if (q.kind !== 'column' && si >= 0) Object.assign(out, lineReactions(sol, f, si));
    return out;
  });
}

export type { PlateLoad };
