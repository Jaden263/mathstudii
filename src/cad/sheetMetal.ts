// Sheet metal as Fusion makes it: rules per component (thickness t, inner bend radius R,
// K-factor, bend and corner reliefs) and flanges, hems and bends kept as a model of flat
// pieces and the folds between them. The folded solid and the flat pattern are both made
// from that model, so they agree by construction: a flange is a prism of its flat outline,
// a bend an exact cylindrical strip about its axis, and the flat pattern lays every piece
// out where it lay before folding, each bend as wide as its bend allowance
// BA = θ·(R + K·t) (θ in radians): the length of the fibre at R + K·t, which keeps its
// length while the sheet bends.
//
// Flat coordinates: x, y in the plane of the blank, z through it (0 … t). Face A is z = 0,
// face B is z = t. A bend "up" turns towards +z (face B inside, at radius R), "down"
// towards −z (face A inside). Pieces keep their flat coordinates; where one is in the part
// is the chain of folds from the base flange to it (chainMatrix), each fold a turn about its
// bend's axis after the bend's flat width is taken out.
import type { Loop, ProfileRegion, Seg, Vec2 } from './profile';
import { loopMoment, loopPolygon, reverseSeg, segPoint } from './profile';
import type { TopoRef } from './topology';
import type { Prim } from './drawing2d';
import { add3, cross3, m4Inv, m4Mul, m4Point, m4Rotate, m4Translate, scale3, type Frame, type M4, type Vec3 } from './solid';

// ------------------------------------------------------------ rules and materials

export type ReliefKind = 'rect' | 'round' | 'tear';
export type CornerKind = 'none' | 'square' | 'round';

/** A component's sheet-metal rules (worksheet expressions; lengths in the part unit unless they carry one). */
export interface SheetRules {
  /** Key of SHEET_MATERIALS: its K-factor when `k` is empty. */
  material?: string;
  /** Thickness. */
  t: string;
  /** Inner bend radius. */
  r: string;
  /** K-factor: where the fibre that keeps its length lies, as a fraction of t from the inside. */
  k?: string;
  /** Bend relief where a flange is narrower than its edge: rectangular, round-ended or a plain tear. */
  relief?: ReliefKind;
  /** Relief width (empty: t) and how far it reaches past the bend (empty: t). */
  reliefW?: string;
  reliefD?: string;
  /** Corner relief where two bends meet. */
  corner?: CornerKind;
  /** Its size (empty: R + t). */
  cornerS?: string;
}

export interface SheetMaterial {
  key: string;
  name: string;
  density: string;
  K: number;
}

/**
 * Default K-factors for air bending with R from t to 3t. Steel 0.44 is the K-factor of
 * Autodesk Fusion's built-in sheet-metal rules (which use it for every material); aluminium,
 * stainless steel and copper are typical values for the same process, within the 0.40–0.45
 * that generic K-factor charts give for R = t … 3t (softer metals lower). The K-factor
 * depends on the material, the tooling and R/t: a test bend gives the one to use for parts
 * that need it.
 */
export const SHEET_MATERIALS: SheetMaterial[] = [
  { key: 'steel', name: 'Steel', density: '7850 kg/m^3', K: 0.44 },
  { key: 'aluminium', name: 'Aluminium', density: '2700 kg/m^3', K: 0.43 },
  { key: 'stainless', name: 'Stainless steel', density: '8000 kg/m^3', K: 0.45 },
  { key: 'copper', name: 'Copper', density: '8960 kg/m^3', K: 0.44 },
];

export const DEFAULT_RULES: SheetRules = { material: 'steel', t: '2 mm', r: '2 mm', relief: 'rect', corner: 'none' };

export const sheetMaterial = (key?: string) => SHEET_MATERIALS.find((m) => m.key === key) ?? SHEET_MATERIALS[0];

const RELIEF_CODE: Record<ReliefKind, number> = { rect: 0, round: 1, tear: 2 };
const CORNER_CODE: Record<CornerKind, number> = { none: 0, square: 1, round: 2 };
export const reliefOf = (code: number | undefined): ReliefKind => (['rect', 'round', 'tear'] as const)[code ?? 0] ?? 'rect';
export const cornerOf = (code: number | undefined): CornerKind => (['none', 'square', 'round'] as const)[code ?? 0] ?? 'none';

type Value = (src: string | undefined, fallback: string, kind: 'L' | 'A', what: string) => number;
type Ratio = (src: string | undefined, fallback: string, what: string) => number;

/**
 * The rules as numbers in a sheet feature's parameters (so a change of the rules rebuilds
 * every sheet feature of the component): t, R, K, relief (code) and its width rw and depth
 * rd, corner (code) and its size cs.
 */
export function sheetRuleNumbers(rules: SheetRules | undefined, value: Value, ratio: Ratio): Record<string, number> {
  const r = rules ?? DEFAULT_RULES;
  const t = value(r.t, '2 mm', 'L', 'sheet thickness');
  if (!(t > 0)) throw new Error('the sheet thickness must be positive');
  const R = value(r.r, `${t}`, 'L', 'bend radius');
  if (!(R > 0)) throw new Error('the bend radius must be positive');
  const K = r.k?.trim() ? ratio(r.k, '0.44', 'K-factor') : sheetMaterial(r.material).K;
  if (!(K >= 0 && K <= 1)) throw new Error('the K-factor is a fraction of the thickness from 0 to 1');
  const rw = r.reliefW?.trim() ? value(r.reliefW, `${t}`, 'L', 'relief width') : t;
  const rd = r.reliefD?.trim() ? value(r.reliefD, `${t}`, 'L', 'relief depth') : t;
  const cs = r.cornerS?.trim() ? value(r.cornerS, `${R + t}`, 'L', 'corner relief size') : R + t;
  if (!(rw >= 0 && rd >= 0 && cs >= 0)) throw new Error('relief sizes must not be negative');
  const relief = RELIEF_CODE[r.relief ?? 'rect'] ?? 0;
  if (relief === 1 && rd < rw / 2) throw new Error('a round relief reaches at least half its width past the bend');
  return { t, R, K, rw, rd, relief, corner: CORNER_CODE[r.corner ?? 'none'] ?? 0, cs };
}

// ------------------------------------------------------------ bend allowance

/** Bend allowance: the developed length of a bend of angle θ (radians), BA = θ·(R + K·t). */
export const bendAllowance = (theta: number, R: number, K: number, t: number) => theta * (R + K * t);

/** How far a bend's tangent line lies from the virtual sharp of its outer face, (R + t)·tan(θ/2), and of its inner face, R·tan(θ/2). */
export const outerSetback = (theta: number, R: number, t: number) => (R + t) * Math.tan(theta / 2);
export const innerSetback = (theta: number, R: number) => R * Math.tan(theta / 2);

/**
 * DIN 6935 (cold bending of flat steel): the correction factor k = 0.65 + 0.5·lg(r/s)
 * (1 above r/s = 5) and the compensation v that the legs a, b measured outside (to the outer
 * virtual sharp) take: L = a + b + v, with the opening angle β = 180° − θ,
 *   β ≤ 90°:        v = π·(180° − β)/180°·(r + s/2·k) − 2(r + s)
 *   90° < β ≤ 165°: v = π·(180° − β)/180°·(r + s/2·k) − 2(r + s)·tan((180° − β)/2)
 *   β > 165°:       v ≈ 0.
 * Null for a sharp fold (r = 0), where the formula has no k.
 */
export function din6935(theta: number, r: number, s: number): { k: number; v: number } | null {
  if (!(r > 0) || !(s > 0)) return null;
  const k = r / s > 5 ? 1 : 0.65 + 0.5 * Math.log10(r / s);
  const beta = Math.PI - theta;
  const arc = theta * (r + (s / 2) * k);
  const v = beta <= Math.PI / 2 + 1e-12 ? arc - 2 * (r + s) : beta <= (165 * Math.PI) / 180 ? arc - 2 * (r + s) * Math.tan(theta / 2) : 0;
  return { k, v };
}

// ------------------------------------------------------------ the model

export interface SheetFlange {
  /** Tag of its faces (`${feature}` for a base flange from a closed profile, `${feature}/fl:…` otherwise). */
  tag: string;
  /** Its outline in flat coordinates (outer loop counter-clockwise, holes clockwise). */
  region: ProfileRegion;
  /** Tags of the bends from the base flange to it, outermost last. */
  chain: string[];
}

export interface SheetBend {
  tag: string;
  /** Chain of the flange it is on. */
  chain: string[];
  /** Its tangent line on that flange (flat coordinates): o + s·e for s0 ≤ s ≤ s1; the bend goes out along w (unit, square to e). */
  o: Vec2;
  e: Vec2;
  w: Vec2;
  s0: number;
  s1: number;
  /** Bend angle θ (radians, 0 < θ ≤ π), towards +z when `up`, its inner radius and flat width. */
  angle: number;
  up: boolean;
  R: number;
  BA: number;
}

export interface SheetModel {
  /** The body it describes. */
  body: string;
  t: number;
  K: number;
  /** Flat coordinates → component coordinates of the base flange. */
  root: M4;
  flanges: SheetFlange[];
  bends: SheetBend[];
}

const v2 = (x: number, y: number): Vec2 => ({ x, y });
const vadd = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const vsub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const vmul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
const vdot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const vcross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
const vlen = (a: Vec2) => Math.hypot(a.x, a.y);
const vunit = (a: Vec2): Vec2 => vmul(a, 1 / (vlen(a) || 1));
const line = (a: Vec2, b: Vec2): Seg => ({ kind: 'line', a, b });

/** A fold: the moving side's flat coordinates → its parent's flat coordinates (the bend's width taken out, then turned about its axis). */
export function foldMatrix(b: SheetBend, t: number): M4 {
  const { p, d } = bendAxis(b, t);
  return m4Mul(m4Rotate(p, d, b.angle), m4Translate([-b.w.x * b.BA, -b.w.y * b.BA, 0]));
}

/**
 * The axis a bend turns about, in its flange's flat coordinates: over the tangent line at
 * t + R (up) or −R (down), turning the moving side up (or down) by the right-hand rule.
 */
export function bendAxis(b: SheetBend, t: number): { p: Vec3; d: Vec3 } {
  const n: Vec3 = [0, 0, 1], w: Vec3 = [b.w.x, b.w.y, 0];
  return { p: add3([b.o.x, b.o.y, 0], scale3(n, b.up ? t + b.R : -b.R)), d: b.up ? cross3(w, n) : cross3(n, w) };
}

/** Flat coordinates of the piece at the end of a chain → component coordinates. */
export function chainMatrix(m: SheetModel, chain: string[]): M4 {
  let M = m.root;
  for (const tag of chain) {
    const b = m.bends.find((q) => q.tag === tag);
    if (!b) throw new Error('a bend of the sheet is missing');
    M = m4Mul(M, foldMatrix(b, m.t));
  }
  return M;
}

/** The frame of a matrix (its columns: x, y, z axes and origin). */
export const matrixFrame = (M: M4): Frame => ({ o: [M[12], M[13], M[14]], u: [M[0], M[1], M[2]], v: [M[4], M[5], M[6]], n: [M[8], M[9], M[10]] });

/**
 * A bend's cross-section at its tangent line, to revolve about its axis: the rectangle
 * s0 … s1 along the line by 0 … t through the sheet, in a frame (u along the line, v
 * through the sheet) in component coordinates, with the axis in that frame. Its edges are
 * named a (face A), b (face B), e0 and e1 (its ends).
 */
export function bendSection(m: SheetModel, b: SheetBend): { region: ProfileRegion; frame: Frame; axis: { p: Vec2; d: Vec2 } } {
  const P = chainMatrix(m, b.chain);
  const o: Vec3 = [b.o.x, b.o.y, 0], u: Vec3 = [b.e.x, b.e.y, 0], v: Vec3 = [0, 0, 1];
  const local: Frame = { o, u, v, n: cross3(u, v) };
  const frame: Frame = { o: m4Point(P, local.o), u: dirOf(P, local.u), v: dirOf(P, local.v), n: dirOf(P, local.n) };
  const { s0, s1 } = b, t = m.t;
  const region: ProfileRegion = {
    outer: { segs: [line(v2(s0, 0), v2(s1, 0)), line(v2(s1, 0), v2(s1, t)), line(v2(s1, t), v2(s0, t)), line(v2(s0, t), v2(s0, 0))], entities: ['a', 'e1', 'b', 'e0'] },
    holes: [],
  };
  const d = bendAxis(b, t).d;
  return { region, frame, axis: { p: v2(0, b.up ? t + b.R : -b.R), d: v2(Math.sign(d[0] * u[0] + d[1] * u[1]) || 1, 0) } };
}

const dirOf = (M: M4, d: Vec3): Vec3 => [M[0] * d[0] + M[4] * d[1] + M[8] * d[2], M[1] * d[0] + M[5] * d[1] + M[9] * d[2], M[2] * d[0] + M[6] * d[1] + M[10] * d[2]];

/** The flat region of a bend: its strip, s0 … s1 along the tangent line by BA out along w. */
export function bendStrip(b: SheetBend): ProfileRegion {
  return { outer: rectLoop(b.o, b.e, b.w, b.s0, b.s1, 0, b.BA, ['a', 'e1', 'b', 'e0']), holes: [] };
}

/** The centre line of a bend in the flat (where a bend line is drawn). */
export function bendLine(b: SheetBend): [Vec2, Vec2] {
  const c = vadd(b.o, vmul(b.w, b.BA / 2));
  return [vadd(c, vmul(b.e, b.s0)), vadd(c, vmul(b.e, b.s1))];
}

/**
 * The loop of the rectangle o + s·u + q·v for s in a … b, q in c … d, counter-clockwise,
 * its sides named (q = c, s = b, q = d, s = a).
 */
function rectLoop(o: Vec2, u: Vec2, v: Vec2, a: number, b: number, c: number, d: number, names: [string, string, string, string]): Loop {
  const P = (s: number, q: number) => vadd(o, vadd(vmul(u, s), vmul(v, q)));
  const loop: Loop = { segs: [line(P(a, c), P(b, c)), line(P(b, c), P(b, d)), line(P(b, d), P(a, d)), line(P(a, d), P(a, c))], entities: [...names] };
  return vcross(u, v) > 0 ? loop : reversedLoop(loop);
}

export function reversedLoop(l: Loop): Loop {
  return { segs: l.segs.map(reverseSeg).reverse(), entities: [...l.entities].reverse() };
}

const loopArea = (l: Loop) => loopMoment(l, 0, 0);
const ccw = (l: Loop) => (loopArea(l) >= 0 ? l : reversedLoop(l));

/** Size of the model (the extent of its flat), the scale of the tolerances. */
export function modelSize(m: SheetModel): number {
  let lo = Infinity, hi = -Infinity;
  for (const f of m.flanges) for (const p of loopPolygon(f.region.outer, Math.PI / 8)) {
    lo = Math.min(lo, p.x, p.y);
    hi = Math.max(hi, p.x, p.y);
  }
  return Math.max(hi - lo, 0) + m.t;
}

/**
 * The volume of the sheet as its model makes it: each flange its area times t, each bend
 * the ring sector between R and R + t, θ/2·((R + t)² − R²)·w = θ·w·t·(R + t/2).
 */
export function sheetVolume(m: SheetModel): number {
  const flanges = m.flanges.reduce((s, f) => s + (loopArea(f.region.outer) + f.region.holes.reduce((a, h) => a + loopArea(h), 0)) * m.t, 0);
  return flanges + m.bends.reduce((s, b) => s + b.angle * (b.s1 - b.s0) * m.t * (b.R + m.t / 2), 0);
}

/**
 * What the B-rep kernel finds cut through a sheet's flanges (flat coordinates), and how far
 * the solid's volume is from its model's less those cut-outs: what other features added or
 * took away (bosses, pockets, chamfers, cuts across bends).
 */
export interface SheetCutouts {
  cuts: { tag: string; regions: ProfileRegion[] }[];
  other: number;
}

// ------------------------------------------------------------ base flanges

/** A base flange from a closed profile: the plate of the region on its sketch plane, on the side of its normal (or the other). */
export function plateModel(body: string, region: ProfileRegion, sketch: Frame, flip: boolean, t: number, K: number): SheetModel {
  const F = m4Mul([...sketch.u, 0, ...sketch.v, 0, ...sketch.n, 0, ...sketch.o, 1], m4Translate([0, 0, flip ? -t : 0]));
  return { body, t, K, root: F, flanges: [{ tag: body, region, chain: [] }], bends: [] };
}

export interface StripSpec {
  /** Sketch lines end to end (sketch coordinates) and their ids. */
  pts: Vec2[];
  ids: string[];
  sketch: Frame;
  /** Material on the right of the lines' direction (default: the left). */
  flip: boolean;
  /** Width along the sketch normal: [w0, w1] (from the sketch plane). */
  width: [number, number];
  t: number;
  R: number;
  K: number;
}

/**
 * A base flange from an open profile: the lines as one face of the sheet (face A), the
 * material on one side, bent at every corner with the inner radius R, as wide as asked
 * along the sketch normal. Each line keeps its length to the virtual sharp of face A, so
 * the flat parts are shorter by the setbacks of the bends at their ends.
 */
export function stripModel(body: string, s: StripSpec): SheetModel {
  const { pts, t, R, K } = s;
  const n = pts.length - 1;
  if (n < 1) throw new Error('the open profile has no line');
  const dirs = pts.slice(1).map((p, i) => vunit(vsub(p, pts[i])));
  const lens = pts.slice(1).map((p, i) => vlen(vsub(p, pts[i])));
  const side = s.flip ? -1 : 1;
  // the turn at each corner: its angle, and whether it turns towards the material (up)
  const turns = dirs.slice(1).map((d, i) => {
    const c = vcross(dirs[i], d), cos = Math.max(-1, Math.min(1, vdot(dirs[i], d)));
    const angle = Math.acos(cos);
    if (angle < 1e-9) throw new Error(`the lines ${s.ids[i]} and ${s.ids[i + 1]} run straight on: join them into one line`);
    if (angle > Math.PI - 1e-6) throw new Error(`the profile turns back on itself at the end of ${s.ids[i]}`);
    return { angle, up: c * side > 0 };
  });
  const back = turns.map((q) => (q.up ? outerSetback(q.angle, R, t) : innerSetback(q.angle, R)));
  const flat = lens.map((l, i) => l - (i > 0 ? back[i - 1] : 0) - (i < n - 1 ? back[i] : 0));
  flat.forEach((l, i) => {
    if (!(l > 1e-9 * Math.max(...lens))) throw new Error(`the line ${s.ids[i]} is too short for the bends at its ends: it needs more than ${+((lens[i] - l) || 0).toPrecision(4)}`);
  });
  // flat x along the developed length from the first point, y across the width, z into the material
  const f = s.sketch;
  const d3 = (d: Vec2): Vec3 => [f.u[0] * d.x + f.v[0] * d.y, f.u[1] * d.x + f.v[1] * d.y, f.u[2] * d.x + f.v[2] * d.y];
  const X = d3(dirs[0]), Z = d3(v2(-dirs[0].y * side, dirs[0].x * side)), Y = cross3(Z, X);
  const along = Math.sign(Y[0] * f.n[0] + Y[1] * f.n[1] + Y[2] * f.n[2]) || 1;
  const [y0, y1] = along > 0 ? s.width : [-s.width[1], -s.width[0]];
  if (!(y1 - y0 > 0)) throw new Error('the width must be positive');
  const o = add3(f.o, d3(pts[0]));
  const root: M4 = [...X, 0, ...Y, 0, ...Z, 0, ...o, 1];
  const flanges: SheetFlange[] = [], bends: SheetBend[] = [];
  let x = 0;
  const chain: string[] = [];
  for (let i = 0; i <= n - 1; i++) {
    flanges.push({ tag: `${body}/fl:${s.ids[i]}`, region: { outer: rectLoop(v2(0, 0), v2(1, 0), v2(0, 1), x, x + flat[i], y0, y1, ['w0', 'e1', 'w1', 'e0']), holes: [] }, chain: [...chain] });
    x += flat[i];
    if (i === n - 1) break;
    const q = turns[i];
    const tag = `${body}/bend:${s.ids[i]}`;
    const BA = bendAllowance(q.angle, R, K, t);
    bends.push({ tag, chain: [...chain], o: v2(x, y0), e: v2(0, 1), w: v2(1, 0), s0: 0, s1: y1 - y0, angle: q.angle, up: q.up, R, BA });
    chain.push(tag);
    x += BA;
  }
  return { body, t, K, root, flanges, bends };
}

// ------------------------------------------------------------ edges of the sheet

/** A straight outline edge of a flange: its piece, the segment of its outer loop, and the part of it picked. */
export interface EdgeHit {
  flange: number;
  seg: number;
  /** Extent of the picked edge along the segment (from its start). */
  sA: number;
  sB: number;
  /** The face the edge is on. */
  face: 'A' | 'B';
}

/** The flange outline edge a straight edge of the body (component coordinates) lies on, if any. */
export function findEdge(m: SheetModel, a: Vec3, b: Vec3): EdgeHit | null {
  const tol = 1e-6 * modelSize(m);
  for (let i = 0; i < m.flanges.length; i++) {
    const f = m.flanges[i];
    const inv = m4Inv(chainMatrix(m, f.chain));
    const pa = m4Point(inv, a), pb = m4Point(inv, b);
    const face = Math.abs(pa[2]) < tol && Math.abs(pb[2]) < tol ? 'A' : Math.abs(pa[2] - m.t) < tol && Math.abs(pb[2] - m.t) < tol ? 'B' : null;
    if (!face) continue;
    const segs = f.region.outer.segs;
    for (let k = 0; k < segs.length; k++) {
      const s = segs[k];
      if (s.kind !== 'line') continue;
      const L = vlen(vsub(s.b, s.a));
      if (!(L > tol)) continue;
      const e = vmul(vsub(s.b, s.a), 1 / L);
      const off = (p: Vec3) => Math.abs(vcross(e, vsub(v2(p[0], p[1]), s.a)));
      const at = (p: Vec3) => vdot(e, vsub(v2(p[0], p[1]), s.a));
      if (off(pa) > tol || off(pb) > tol) continue;
      const sA = Math.min(at(pa), at(pb)), sB = Math.max(at(pa), at(pb));
      if (sA < -tol || sB > L + tol || sB - sA < tol) continue;
      return { flange: i, seg: k, sA: Math.max(0, sA), sB: Math.min(L, sB), face };
    }
  }
  return null;
}

// ------------------------------------------------------------ edge flanges and hems

export interface FlangeSpec {
  /** Tag of the new flange piece and of its bend; `token` names the edges it adds to its parent. */
  tag: string;
  bendTag: string;
  token: string;
  angle: number;
  R: number;
  up: boolean;
  /** Flat length of the flange past its bend. */
  length: number;
  /** How far inside the edge the bend's tangent line lies (Inside, Outside, Centre positions). */
  setback: number;
  /** Offsets of its ends from the ends of the picked edge. */
  o1: number;
  o2: number;
  relief: { kind: ReliefKind; w: number; d: number };
  corner: { kind: CornerKind; size: number };
}

export interface FlangeAdded {
  model: SheetModel;
  flange: SheetFlange;
  bend: SheetBend;
  /** The parent as it was, and what its new outline takes away (flat coordinates), to cut from the body. */
  parent: SheetFlange;
  removed: ProfileRegion[];
}

/**
 * A flange on a straight outline edge of a flange: the bend's tangent line `setback` inside
 * the edge (between the offsets), the parent's outline taken back to it, with reliefs where
 * the parent goes on beside the bend and a corner relief where its end meets the tangent line
 * of another bend of the parent (end to end, or ending on it). The flange is the rectangle
 * past the bend. What the parent's outline loses comes back as regions to cut from the body,
 * each exactly the old outline less the new one (a cut tool reaching past the parent would
 * nick a bend beside it).
 */
export function addFlange(m: SheetModel, hit: EdgeHit, sp: FlangeSpec): FlangeAdded {
  const parent = m.flanges[hit.flange];
  const outer = parent.region.outer;
  const segs = outer.segs, N = segs.length;
  const seg = segs[hit.seg];
  if (seg.kind !== 'line') throw new Error('a flange goes on a straight edge');
  const tol = 1e-7 * modelSize(m);
  const A = seg.a, B = seg.b, L = vlen(vsub(B, A));
  const e = vmul(vsub(B, A), 1 / L);
  // the outer loop runs counter-clockwise: the material is on its left
  const nIn = v2(-e.y, e.x), wOut = vmul(nIn, -1);
  const P = (s: number, q: number) => vadd(A, vadd(vmul(e, s), vmul(nIn, q)));
  const sb = sp.setback > tol ? sp.setback : 0, deep = sb > 0;
  let a = hit.sA + sp.o1, b = hit.sB - sp.o2;
  if (!(b - a > tol)) throw new Error('the offsets leave nothing of the edge');
  const atStart = a <= tol, atEnd = b >= L - tol;
  if (atStart) a = 0;
  if (atEnd) b = L;
  const ip = (hit.seg + N - 1) % N, inx = (hit.seg + 1) % N;
  const sameFlange = (q: SheetBend) => q.chain.join('/') === parent.chain.join('/');
  // a flange already on (part of) this edge
  for (const q of m.bends) {
    if (!sameFlange(q) || Math.abs(vcross(q.e, e)) > 1e-9 || Math.abs(vdot(vsub(q.o, A), nIn)) > tol) continue;
    const [u0, u1] = [q.s0, q.s1].map((s) => vdot(vsub(vadd(q.o, vmul(q.e, s)), A), e)).sort((x, y) => x - y);
    if (Math.min(u1, b) - Math.max(u0, a) > tol) throw new Error('that edge has a flange on it already');
  }
  const rw = sp.relief.kind === 'tear' ? 0 : sp.relief.w, round = sp.relief.kind === 'round';
  const depth = sb + sp.relief.d;
  const cs = sp.corner.kind === 'none' ? 0 : sp.corner.size;
  const own = outer.entities[hit.seg];
  let n = 0;
  const fresh = () => `${sp.token}:r${n++}`;
  /** A corner where this bend's end meets the tangent segment of another bend of the parent. */
  const meets = (p: Vec2) => m.bends.some((q) => {
    if (!sameFlange(q) || Math.abs(vcross(q.e, vsub(p, q.o))) > tol) return false;
    const s = vdot(vsub(p, q.o), q.e);
    return s > Math.min(q.s0, q.s1) - tol && s < Math.max(q.s0, q.s1) + tol;
  });
  /** A neighbouring line cut back to depth q: its end at the edge moved along it. */
  const trimmed = (nb: Seg, end: 'a' | 'b', q: number): { seg: Seg; p: Vec2 } => {
    if (nb.kind !== 'line') throw new Error('the edge’s neighbour is curved: give the flange offsets, or the Adjacent position');
    const far = end === 'b' ? nb.a : nb.b, near = end === 'b' ? nb.b : nb.a;
    const qf = vdot(vsub(far, A), nIn), qn = vdot(vsub(near, A), nIn);
    if (!(qf - qn > q + tol)) throw new Error('the sheet is not that deep beside the edge: the bend does not fit there');
    const p = vadd(near, vmul(vsub(far, near), (q - qn) / (qf - qn)));
    return { seg: end === 'b' ? line(nb.a, p) : line(p, nb.b), p };
  };
  const named = new Map<Seg, string>();
  const put = (into: Seg[], names: string[], s: Seg, name: string) => {
    if (s.kind === 'line' && vlen(vsub(s.b, s.a)) <= tol) return;
    into.push(s);
    names.push(name);
    named.set(s, name);
  };
  // the pieces of the parent the new outline cuts off: its new stretch, then back along the old
  // outline. The new stretch keeps the names it has in the outline, so the faces the cut leaves
  // are named as a rebuild of the parent from its outline would name them
  const removed: Loop[] = [];
  const piece = (path: Seg[], old: Vec2[]) => {
    const back = old.slice().reverse().filter((p, i, all) => i === 0 || vlen(vsub(p, all[i - 1])) > tol);
    const closing = back.slice(0, -1).map((p, i) => line(p, back[i + 1]));
    const lp: Loop = { segs: [...path, ...closing], entities: [...path.map((q) => named.get(q) ?? `${sp.token}:x`), ...closing.map((_, i) => `${sp.token}:o${n}.${i}`)] };
    if (Math.abs(loopArea(lp)) > tol * tol) removed.push(ccw(lp));
  };
  /** A corner relief from `from` to `to` about the corner E: a square, or a quarter circle. */
  const corner = (E: Vec2, from: Vec2, to: Vec2): Seg[] => {
    if (sp.corner.kind === 'round') return [arcAbout(E, from, to)];
    const far = vadd(from, vsub(to, E));
    return [line(from, far), line(far, to)];
  };
  /** A relief slot from the edge at s0 to depth and back up at s1 (its far end square, or a half circle). */
  const slot = (s0: number, s1: number, q0: number, q1: number): Seg[] => {
    if (!round) return [line(P(s0, q0), P(s0, depth)), line(P(s0, depth), P(s1, depth)), line(P(s1, depth), P(s1, q1))];
    const h = depth - rw / 2;
    return [line(P(s0, q0), P(s0, h)), halfArc(P((s0 + s1) / 2, h), P(s0, h), nIn), line(P(s1, h), P(s1, q1))];
  };

  // ---- the start of the edge: `from` is where the new outline leaves the old one, `via` the
  // corners of the old outline from there to the edge
  const head: Seg[] = [], headNames: string[] = [];
  let newPrev: Seg | null = null, a1 = a, from: Vec2;
  const via: Vec2[] = [];
  if (atStart) {
    let X = A;
    if (deep) {
      ({ seg: newPrev, p: X } = trimmed(segs[ip], 'b', sb));
      via.push(A);
    }
    from = X;
    const aX = vdot(vsub(X, A), e);
    a1 = Math.max(aX, 0);
    // a neighbour leaning out: the tangent line starts square to the edge
    if (aX < -tol) put(head, headNames, line(X, P(0, sb)), fresh());
    const E = P(a1, sb);
    if (cs > tol && vlen(vsub(X, E)) < tol && meets(E)) {
      // corner relief: the neighbour stops `cs` short of the corner, the bend starts `cs` on
      const pv = newPrev ?? segs[ip];
      if (pv.kind !== 'line' || vlen(vsub(pv.b, pv.a)) <= cs + tol) throw new Error('the corner relief is larger than the edge beside it');
      const c0 = vadd(E, vmul(vunit(vsub(pv.a, pv.b)), cs)), c1 = P(a1 + cs, sb);
      newPrev = line(pv.a, c0);
      const cut = corner(E, c0, c1);
      for (const s of cut) put(head, headNames, s, fresh());
      if (deep) from = c0;
      else piece(cut, [c0, A, c1]);
      a1 += cs;
    }
  } else if (rw > tol) {
    if (a - rw < tol) throw new Error('the offset is smaller than the relief is wide: make it 0, or larger than the relief width');
    put(head, headNames, line(A, P(a - rw, 0)), own);
    from = P(a - rw, 0);
    const cut = slot(a - rw, a, 0, sb);
    for (const s of cut) put(head, headNames, s, fresh());
    if (!deep) piece(cut, [P(a - rw, 0), P(a, 0)]);
  } else {
    put(head, headNames, line(A, P(a, 0)), own);
    from = P(a, 0);
    put(head, headNames, line(P(a, 0), P(a, sb)), fresh());
  }

  // ---- the end of the edge, the same mirrored: `to` is where the new outline comes back
  const tail: Seg[] = [], tailNames: string[] = [];
  let newNext: Seg | null = null, b1 = b, to: Vec2;
  const viaEnd: Vec2[] = [];
  if (atEnd) {
    let Y = B;
    if (deep) {
      ({ seg: newNext, p: Y } = trimmed(segs[inx], 'a', sb));
      viaEnd.push(B);
    }
    to = Y;
    const bY = vdot(vsub(Y, A), e);
    b1 = Math.min(bY, L);
    if (bY > L + tol) put(tail, tailNames, line(P(L, sb), Y), fresh());
    const E = P(b1, sb);
    if (cs > tol && vlen(vsub(Y, E)) < tol && meets(E)) {
      const nx = newNext ?? segs[inx];
      if (nx.kind !== 'line' || vlen(vsub(nx.b, nx.a)) <= cs + tol) throw new Error('the corner relief is larger than the edge beside it');
      const c1 = vadd(E, vmul(vunit(vsub(nx.b, nx.a)), cs)), c0 = P(b1 - cs, sb);
      newNext = line(c1, nx.b);
      const cut = corner(E, c0, c1);
      for (const s of cut) put(tail, tailNames, s, fresh());
      if (deep) to = c1;
      else piece(cut, [c0, B, c1]);
      b1 -= cs;
    }
  } else if (rw > tol) {
    if (b + rw > L - tol) throw new Error('the offset is smaller than the relief is wide: make it 0, or larger than the relief width');
    const cut = slot(b, b + rw, sb, 0);
    for (const s of cut) put(tail, tailNames, s, fresh());
    put(tail, tailNames, line(P(b + rw, 0), B), own);
    to = P(b + rw, 0);
    if (!deep) piece(cut, [P(b, 0), P(b + rw, 0)]);
  } else {
    put(tail, tailNames, line(P(b, sb), P(b, 0)), fresh());
    put(tail, tailNames, line(P(b, 0), B), own);
    to = P(b, 0);
  }
  if (!(b1 - a1 > tol)) throw new Error('the reliefs leave nothing of the edge for the bend');
  const tangent = line(P(a1, sb), P(b1, sb));
  named.set(tangent, `${sp.token}:t`);
  // with a setback, everything from where the outline leaves to where it comes back is one piece
  if (deep) {
    const onEdge = (s: Seg) => s.kind === 'line' && Math.abs(vdot(vsub(s.a, A), nIn)) < tol && Math.abs(vdot(vsub(s.b, A), nIn)) < tol;
    piece([...head, tangent, ...tail].filter((s) => !onEdge(s)), [from, ...via, ...viaEnd, to]);
  }

  // the parent's new outline
  const outSegs: Seg[] = [], outNames: string[] = [];
  for (let i = 0; i < N; i++) {
    if (i === hit.seg) {
      outSegs.push(...head, tangent, ...tail);
      outNames.push(...headNames, `${sp.token}:t`, ...tailNames);
    } else {
      outSegs.push(i === ip && newPrev ? newPrev : i === inx && newNext ? newNext : segs[i]);
      outNames.push(outer.entities[i]);
    }
  }
  const edited: SheetFlange = { ...parent, region: { outer: { segs: outSegs, entities: outNames }, holes: parent.region.holes } };

  if (!(sp.length > tol)) throw new Error('the flange is too short for its bend: make it longer');
  const bend: SheetBend = { tag: sp.bendTag, chain: [...parent.chain], o: P(0, sb), e, w: wOut, s0: a1, s1: b1, angle: sp.angle, up: sp.up, R: sp.R, BA: bendAllowance(sp.angle, sp.R, m.K, m.t) };
  const flange: SheetFlange = {
    tag: sp.tag,
    region: { outer: rectLoop(bend.o, e, wOut, a1, b1, bend.BA, bend.BA + sp.length, ['near', 'e1', 'far', 'e0']), holes: [] },
    chain: [...parent.chain, sp.bendTag],
  };
  const model: SheetModel = { ...m, flanges: [...m.flanges.map((f, i) => (i === hit.flange ? edited : f)), flange], bends: [...m.bends, bend] };
  return { model, flange, bend, parent, removed: removed.map((o) => ({ outer: o, holes: [] })) };
}

const startOf = (s: Seg): Vec2 => segPoint(s, 0);
const endOf = (s: Seg): Vec2 => segPoint(s, 1);

/** An arc about c from p to q the short way round (a corner relief's quarter). */
function arcAbout(c: Vec2, p: Vec2, q: Vec2): Seg {
  const a0 = Math.atan2(p.y - c.y, p.x - c.x);
  let d = Math.atan2(q.y - c.y, q.x - c.x) - a0;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return { kind: 'arc', c, r: Math.hypot(p.x - c.x, p.y - c.y), a0, a1: a0 + d };
}

/** The half circle about c from p (to the point opposite) that bulges towards `toward` (a round relief's end). */
function halfArc(c: Vec2, p: Vec2, toward: Vec2): Seg {
  const a0 = Math.atan2(p.y - c.y, p.x - c.x);
  const mid = a0 + Math.PI / 2;
  const d = Math.cos(mid) * toward.x + Math.sin(mid) * toward.y > 0 ? Math.PI : -Math.PI;
  return { kind: 'arc', c, r: Math.hypot(p.x - c.x, p.y - c.y), a0, a1: a0 + d };
}

// ------------------------------------------------------------ bends along a line

export interface BendSpec {
  tag: string;
  bendTag: string;
  angle: number;
  R: number;
  /** The side the bend turns towards (component coordinates: the normal of the sketch the line is on, or its opposite). */
  normal: Vec3;
  /** Where the line lies in the bend's flat width: its middle, or at the tangent line of the side that stays or of the side that moves. */
  placement: 'centre' | 'start' | 'end';
  /** Move the other side than the one found. */
  flip: boolean;
}

/** Where a line (flat coordinates, through p along e) crosses a loop: the parameters along it, sorted, with the segment crossed. */
function crossings(loop: Loop, p: Vec2, e: Vec2, tol: number): { u: number; seg: number }[] {
  const n = v2(-e.y, e.x);
  const out: { u: number; seg: number }[] = [];
  loop.segs.forEach((s, k) => {
    if (s.kind === 'line') {
      const da = vdot(vsub(s.a, p), n), db = vdot(vsub(s.b, p), n);
      if ((da > tol && db > tol) || (da < -tol && db < -tol) || Math.abs(da - db) < tol) return;
      const lam = da / (da - db);
      // a crossing at a corner is counted on the segment it enters
      if (lam < -1e-12 || lam >= 1 - 1e-12) return;
      out.push({ u: vdot(vsub(vadd(s.a, vmul(vsub(s.b, s.a), lam)), p), e), seg: k });
    } else {
      const pts = loopPolygon({ segs: [s], entities: [''] }, Math.PI / 180);
      const q = [...pts, endOf(s)];
      for (let i = 0; i + 1 < q.length; i++) {
        const da = vdot(vsub(q[i], p), n), db = vdot(vsub(q[i + 1], p), n);
        if ((da > 0) !== (db > 0)) out.push({ u: vdot(vsub(vadd(q[i], vmul(vsub(q[i + 1], q[i]), da / (da - db))), p), e), seg: k });
      }
    }
  });
  return out.sort((x, y) => x.u - y.u);
}

/**
 * The part of a loop on one side of a line: {x : x·nrm ≤ c}. The loop must cross the line
 * square to it, on straight segments, exactly twice; the cut is closed along the line by a
 * segment named `name`. Null when nothing of it is on that side.
 */
function clipLoop(loop: Loop, nrm: Vec2, c: number, name: string, tol: number): Loop | null {
  const f = (p: Vec2) => vdot(p, nrm) - c;
  const segs: Seg[] = [], names: string[] = [];
  const cuts: number[] = [];
  loop.segs.forEach((s, k) => {
    const fa = f(startOf(s)), fb = f(endOf(s));
    if (fa <= tol && fb <= tol) {
      segs.push(s);
      names.push(loop.entities[k]);
      return;
    }
    if (fa > tol && fb > tol) return;
    if (s.kind !== 'line') throw new Error('the bend line crosses a curved edge of the sheet: draw it across straight edges');
    if (Math.abs(vcross(vunit(vsub(s.b, s.a)), nrm)) > 1e-7) throw new Error('the bend line must cross the sheet square to its edges');
    const x = vadd(s.a, vmul(vsub(s.b, s.a), fa / (fa - fb)));
    if (fa <= tol) {
      segs.push(line(s.a, x));
      names.push(loop.entities[k]);
      cuts.push(segs.length);
    } else {
      segs.push(line(x, s.b));
      names.push(loop.entities[k]);
    }
  });
  if (!segs.length) return null;
  if (cuts.length > 1) throw new Error('the bend line must cross the sheet once (the flange is not convex there)');
  if (cuts.length === 1) {
    // close the cut along the line: from where the loop leaves the side to where it comes back
    const i = cuts[0];
    const from = endOf(segs[i - 1]), to = startOf(segs[i % segs.length]);
    segs.splice(i, 0, line(from, to));
    names.splice(i, 0, name);
  }
  return { segs, entities: names };
}

/** Which side of the line a whole loop is on: −1, +1, or 0 when it crosses (within tol). */
function sideOf(loop: Loop, p: Vec2, w: Vec2, lo: number, hi: number): -1 | 1 | 0 {
  const qs = loopPolygon(loop, Math.PI / 36).map((x) => vdot(vsub(x, p), w));
  if (Math.max(...qs) <= lo) return -1;
  if (Math.min(...qs) >= hi) return 1;
  return 0;
}

export interface BendAlong {
  model: SheetModel;
  /** The flange that was split (its tag), the side that moves (its new tag) and the bend between. */
  split: string;
  moving: string;
  bend: SheetBend;
}

/**
 * A bend along a line drawn on a face of a flange (component coordinates p, q): the flange
 * is split by the bend's flat width along the line, the part on the moving side turns about
 * the bend's axis, and with it every flange and bend hanging from that part.
 */
export function bendAlongLine(m: SheetModel, p3: Vec3, q3: Vec3, sp: BendSpec): BendAlong {
  const size = modelSize(m), tol = 1e-6 * size;
  for (let i = 0; i < m.flanges.length; i++) {
    const X = m.flanges[i];
    const inv = m4Inv(chainMatrix(m, X.chain));
    const pa = m4Point(inv, p3), pb = m4Point(inv, q3);
    const onFace = (z: number) => Math.abs(z) < tol || Math.abs(z - m.t) < tol;
    if (!onFace(pa[2]) || !onFace(pb[2])) continue;
    const p = v2(pa[0], pa[1]), e = vunit(vsub(v2(pb[0], pb[1]), p));
    if (!(vlen(vsub(v2(pb[0], pb[1]), p)) > tol)) continue;
    const xs = crossings(X.region.outer, p, e, tol);
    if (xs.length !== 2) continue;
    const m0 = v2(-e.y, e.x);
    const BA = bendAllowance(sp.angle, sp.R, m.K, m.t);
    // the side that stays: the one its own bend hangs from, else the larger one
    const parentBend = m.bends.find((b) => b.tag === X.chain[X.chain.length - 1]);
    let sign: 1 | -1;
    if (parentBend) {
      const mid = vadd(vadd(parentBend.o, vmul(parentBend.w, parentBend.BA)), vmul(parentBend.e, (parentBend.s0 + parentBend.s1) / 2));
      sign = vdot(vsub(mid, p), m0) > 0 ? -1 : 1;
    } else {
      const left = clipLoop(X.region.outer, vmul(m0, -1), -vdot(p, m0), 'x', tol), right = clipLoop(X.region.outer, m0, vdot(p, m0), 'x', tol);
      sign = Math.abs(left ? loopArea(left) : 0) >= Math.abs(right ? loopArea(right) : 0) ? -1 : 1;
    }
    if (sp.flip) sign = -sign as 1 | -1;
    // w: towards the side that moves
    const w = vmul(m0, -sign);
    const [qa, qb] = sp.placement === 'start' ? [0, BA] : sp.placement === 'end' ? [-BA, 0] : [-BA / 2, BA / 2];
    const base = vdot(p, w);
    const fixedOuter = clipLoop(X.region.outer, w, base + qa, `${sp.tag}:t0`, tol);
    const movingOuter = clipLoop(X.region.outer, vmul(w, -1), -(base + qb), `${sp.tag}:t1`, tol);
    if (!fixedOuter || !movingOuter) throw new Error('the bend’s flat width does not fit on the flange there');
    // the strip between, as wide along the line as the sheet where the bend's ends are
    const ua = crossings(X.region.outer, vadd(p, vmul(w, qa)), e, tol), ub = crossings(X.region.outer, vadd(p, vmul(w, qb)), e, tol);
    if (ua.length !== 2 || ub.length !== 2 || Math.abs(ua[0].u - ub[0].u) > tol || Math.abs(ua[1].u - ub[1].u) > tol) {
      throw new Error('the bend line must cross the sheet square to its edges');
    }
    const fixedHoles: Loop[] = [], movingHoles: Loop[] = [];
    for (const h of X.region.holes) {
      const sd = sideOf(h, p, w, qa - tol, qb + tol);
      if (!sd) throw new Error('a hole of the flange crosses the bend: move it off the bend line');
      (sd < 0 ? fixedHoles : movingHoles).push(h);
    }
    // what hangs from the flange goes with the side it hangs from
    const children = m.bends.filter((b) => b.chain.join('/') === X.chain.join('/'));
    const moves = new Set<string>();
    for (const b of children) {
      const sd = vdot(vsub(vadd(b.o, vmul(b.e, (b.s0 + b.s1) / 2)), p), w);
      const ends = [b.s0, b.s1].map((s) => vdot(vsub(vadd(b.o, vmul(b.e, s)), p), w));
      if (Math.min(...ends) < qb - tol && Math.max(...ends) > qa + tol) throw new Error('a flange hangs from the sheet across the bend line: bend before it is made, or move the line');
      if (sd > 0) moves.add(b.tag);
    }
    const o = vadd(vadd(p, vmul(w, qa)), vmul(e, 0));
    // up: towards +z of the flange, the side the normal points to
    const up = inv[2] * sp.normal[0] + inv[6] * sp.normal[1] + inv[10] * sp.normal[2] > 0;
    const bend: SheetBend = { tag: sp.bendTag, chain: [...X.chain], o, e, w, s0: ua[0].u, s1: ua[1].u, angle: sp.angle, up, R: sp.R, BA };
    const depth = X.chain.length;
    const rechain = (c: string[]) => (c.length > depth && moves.has(c[depth]) ? [...c.slice(0, depth), sp.bendTag, ...c.slice(depth)] : c);
    const flanges: SheetFlange[] = [];
    for (const f of m.flanges) {
      if (f === X) {
        flanges.push({ ...X, region: { outer: fixedOuter, holes: fixedHoles } }, { tag: sp.tag, region: { outer: movingOuter, holes: movingHoles }, chain: [...X.chain, sp.bendTag] });
      } else flanges.push({ ...f, chain: rechain(f.chain) });
    }
    const bends = [...m.bends.map((b) => (moves.has(b.tag) ? { ...b, chain: [...b.chain.slice(0, depth), sp.bendTag, ...b.chain.slice(depth)] } : { ...b, chain: rechain(b.chain) })), bend];
    return { model: { ...m, flanges, bends }, split: X.tag, moving: sp.tag, bend };
  }
  throw new Error('the bend line must lie on a flat face of the sheet and cross it from edge to edge');
}

// ------------------------------------------------------------ the flat pattern's numbers

export interface FlatBend {
  name: string;
  tag: string;
  /** Degrees. */
  angle: number;
  R: number;
  up: boolean;
  BA: number;
  K: number;
  /** Length of the bend line. */
  length: number;
  /** Its centre line in the flat. */
  a: Vec2;
  b: Vec2;
  /** DIN 6935's correction factor k and compensation v (information; null for a sharp fold). */
  din: { k: number; v: number } | null;
}

export interface FlatNumbers {
  bends: FlatBend[];
  /** Area of the blank before cut-outs. */
  area: number;
  box: { x0: number; y0: number; x1: number; y1: number };
  t: number;
  K: number;
}

/** The bend table and the blank's size from the model (cut-outs need the solid: occ/sheet.ts). */
export function flatNumbers(m: SheetModel): FlatNumbers {
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const grow = (p: Vec2) => {
    box.x0 = Math.min(box.x0, p.x);
    box.y0 = Math.min(box.y0, p.y);
    box.x1 = Math.max(box.x1, p.x);
    box.y1 = Math.max(box.y1, p.y);
  };
  let area = 0;
  for (const f of m.flanges) {
    area += loopArea(f.region.outer) + f.region.holes.reduce((s, h) => s + loopArea(h), 0);
    for (const p of loopPolygon(f.region.outer, Math.PI / 180)) grow(p);
  }
  for (const b of m.bends) {
    area += b.BA * (b.s1 - b.s0);
    for (const p of loopPolygon(bendStrip(b).outer)) grow(p);
  }
  const bends = m.bends.map((b, i): FlatBend => {
    const [a, c] = bendLine(b);
    return { name: `Bend${i + 1}`, tag: b.tag, angle: (b.angle * 180) / Math.PI, R: b.R, up: b.up, BA: b.BA, K: m.K, length: b.s1 - b.s0, a, b: c, din: din6935(b.angle, b.R, m.t) };
  });
  return { bends, area, box, t: m.t, K: m.K };
}

/** A flat pattern as the B-rep kernel makes it (occ/flat.ts). */
export interface FlatPattern {
  /** The blank's outer contours and its cut-outs (flat coordinates, part units). */
  outer: Prim[][];
  inner: Prim[][];
  /** Its area less the cut-outs. */
  area: number;
  numbers: FlatNumbers;
  /** Cuts that are not in it, flanges it could not follow. */
  warnings: string[];
}

/** The bend note on a flat pattern: "UP 90° R2". */
export const bendNote = (b: FlatBend, fmt: (v: number) => string) => `${b.up ? 'UP' : 'DOWN'} ${fmt(b.angle)}° R${fmt(b.R)}`;

// ------------------------------------------------------------ features of the timeline

/** Fusion's Flange on a sketch profile: a closed profile makes a plate of thickness t, an open one a strip bent at every corner. */
export interface FlangeFeature {
  id: string;
  name: string;
  suppressed?: boolean;
  kind: 'flange';
  sketch: string;
  /** A closed profile's key; missing: the first closed profile, else the sketch's open lines. */
  profile?: string;
  /** Open profile: its lines (missing: every line that is not construction geometry). */
  curves?: string[];
  /** Material on the other side of the sketch plane (closed) or of the lines (open). */
  flip?: boolean;
  /** Open profile: how wide the strip is along the sketch normal, both ways or against it. */
  width?: string;
  symmetric?: boolean;
  reverse?: boolean;
}

/** Fusion's Flange on edges of the sheet. */
export interface EdgeFlangeFeature {
  id: string;
  name: string;
  suppressed?: boolean;
  kind: 'edgeflange';
  /** Straight outline edges of flanges of a sheet-metal body. */
  edges: TopoRef[];
  /** Height to the virtual sharp of the outer (default) or inner faces. */
  height: string;
  datum?: 'outer' | 'inner';
  /** Bend angle (default 90°). */
  angle?: string;
  /** Where the flange is against the edge: the bend starts at it, or the flange's outer face, inner face or mid-plane is flush with it. */
  position?: 'adjacent' | 'inside' | 'outside' | 'centre';
  /** Offsets of the flange's ends from the ends of the edge. */
  offset1?: string;
  offset2?: string;
  /** Bend the other way (default: towards the side of the face the edge was picked on). */
  flip?: boolean;
}

/** A hem: the edge folded back by 180°, open with a gap or closed flat on the sheet. */
export interface HemFeature {
  id: string;
  name: string;
  suppressed?: boolean;
  kind: 'hem';
  edges: TopoRef[];
  type: 'open' | 'closed';
  /** Gap between the sheet and the folded-back part (open hems). */
  gap?: string;
  /** Length from the outside of the fold to the hem's end. */
  length: string;
  /** The fold starts at the edge (adjacent) or its outside is flush with it (inside). */
  position?: 'adjacent' | 'inside';
  flip?: boolean;
}

/** Fusion's Bend: a flat flange bent along a sketch line drawn on it. */
export interface BendFeature {
  id: string;
  name: string;
  suppressed?: boolean;
  kind: 'bend';
  sketch: string;
  /** A sketch line (missing: the first that is not construction geometry). */
  line?: string;
  angle: string;
  /** Bend away from the side the sketch is seen from. */
  down?: boolean;
  /** The other side of the line moves. */
  flip?: boolean;
  placement?: 'centre' | 'start' | 'end';
}

export type SheetFeature = FlangeFeature | EdgeFlangeFeature | HemFeature | BendFeature;
export const SHEET_KINDS = new Set(['flange', 'edgeflange', 'hem', 'bend']);
export const isSheetFeature = (i: { kind: string }): i is SheetFeature => SHEET_KINDS.has(i.kind);

/**
 * The numbers of a sheet feature: the component's rules and its own sizes (lengths in part
 * units, angles in radians). `value` reads a worksheet expression of a length (L) or angle
 * (A), `ratio` a plain number.
 */
export function sheetParams(rules: SheetRules | undefined, item: SheetFeature, value: Value, ratio: Ratio): Record<string, number> {
  const p = sheetRuleNumbers(rules, value, ratio);
  const positive = (n: number, what: string) => {
    if (!(n > 0)) throw new Error(`the ${what} must be positive`);
    return n;
  };
  const angle = (src: string | undefined, max: number, what: string) => {
    const a = value(src, '90', 'A', what);
    if (!(a > 1e-9 && a <= max + 1e-12)) throw new Error(`the ${what} must be more than 0° and at most ${Math.round((max * 180) / Math.PI)}°`);
    return Math.min(a, max);
  };
  switch (item.kind) {
    case 'flange':
      if (item.width?.trim() || item.curves?.length) p.width = positive(value(item.width, '50', 'L', 'width'), 'width');
      break;
    case 'edgeflange':
      p.height = positive(value(item.height, '20', 'L', 'height'), 'height');
      p.angle = angle(item.angle, Math.PI - 1e-6, 'bend angle');
      for (const [k, src] of [['o1', item.offset1], ['o2', item.offset2]] as const) {
        p[k] = src?.trim() ? value(src, '0', 'L', 'offset') : 0;
        if (p[k] < 0) throw new Error('the offsets must not be negative');
      }
      break;
    case 'hem':
      p.length = positive(value(item.length, `${4 * p.t}`, 'L', 'hem length'), 'hem length');
      if (item.type === 'open') p.gap = positive(value(item.gap, `${p.t}`, 'L', 'gap'), 'gap');
      break;
    case 'bend':
      p.angle = angle(item.angle, Math.PI, 'bend angle');
      break;
  }
  return p;
}

/** What the worksheet reads of a flat pattern (plain numbers, part units). */
export interface FlatSummary {
  /** Extents of the blank along the flat's x and y, and the larger and smaller of them. */
  Lx: number;
  Ly: number;
  L: number;
  W: number;
  /** Area of the blank less its cut-outs. */
  A: number;
  /** Number of bends, the sum of their bend allowances, of DIN 6935's v (information). */
  n: number;
  BA: number;
  v: number;
  t: number;
  K: number;
  warnings?: string[];
}

export function flatSummary(fp: Pick<FlatPattern, 'area' | 'numbers' | 'warnings'>): FlatSummary {
  const { box, bends } = fp.numbers;
  const Lx = box.x1 - box.x0, Ly = box.y1 - box.y0;
  return {
    Lx, Ly, L: Math.max(Lx, Ly), W: Math.min(Lx, Ly), A: fp.area, n: bends.length,
    BA: bends.reduce((s, b) => s + b.BA, 0), v: bends.reduce((s, b) => s + (b.din?.v ?? 0), 0), t: fp.numbers.t, K: fp.numbers.K,
    ...(fp.warnings.length ? { warnings: fp.warnings } : {}),
  };
}
