// Space frames by the direct stiffness method: twelve unknowns per member (three
// displacements and three rotations at each end), Euler–Bernoulli or Timoshenko members,
// linear elastic. Works in SI units (N, m, Pa).
//
// Axes: global Z is up. A member's local x runs from its start to its end. For a member
// that is not vertical, local z lies in the vertical plane through it and points down
// (the side gravity loads act on) and y = z × x, so a beam's y axis is horizontal and its
// strong axis (I_y) carries the vertical loads; a vertical member has y along global Y
// and z = x × y. β turns y and z about x (right-handed), or a reference direction sets z.
// Internal forces act on the face whose outward normal is +x: N (tension positive), V_y,
// V_z, the torsion T and the moments M_y, M_z as vectors along the local axes, so
// σ = N/A + M_y z/I_y − M_z y/I_z, and a sagging beam has M_y > 0.
//
// Members stay whole, as in the plane solver: loads along a member enter through their
// fixed-end forces in both bending planes, the internal forces follow from statics per
// stretch between loads (exact polynomials), and the displacements from integrating the
// curvatures between the exact end displacements. Released end forces (hinges, a sliding
// or torsion-free end) are condensed out of the member and recovered afterwards, so the
// member's own end displacements are known too. Supports are eliminated, the unknowns
// numbered by reverse Cuthill–McKee and K factorised as L Lᵀ inside its envelope, so a
// frame of a few thousand unknowns solves in a fraction of a second.
//
// Second order: P-Δ and P-δ with the consistent geometric stiffness of the axial force in
// both bending planes (no torsional or Wagner terms: lateral-torsional buckling is not
// covered), on members cut into short elements, iterated on the axial forces.
import { geometricK, lineFixedEnd, localK, momentFixedEnd, pointFixedEnd, StructureError, InstabilityError, polyAt } from '../beam/solve';
import { SparseSym, skylineCholesky, skylineSolve } from '../beam/sparse';
import { symmetricEigen } from '../beam/eigen';

export { StructureError, InstabilityError };

export type Vec3 = [number, number, number];
/** Rows: the local x, y and z axes in global coordinates. */
export type Axes = [Vec3, Vec3, Vec3];

export interface NumNode3 {
  id: string;
  /** Name for messages (the id otherwise). */
  name?: string;
  x: number;
  y: number;
  z: number;
}

/** Released end forces, in the order N, V_y, V_z, T, M_y, M_z. */
export type Releases = boolean[];

export const END_FORCES = ['N', 'Vy', 'Vz', 'T', 'My', 'Mz'] as const;

export interface NumMember3 {
  id: string;
  /** Name for messages (the id otherwise). */
  name?: string;
  a: string;
  b: string;
  E: number;
  G: number;
  A: number;
  /** Second moments about local y (strong axis of a profile) and z, torsion constant; m⁴. */
  Iy: number;
  Iz: number;
  It: number;
  /** Shear areas for V_y and V_z, m²: with them a Timoshenko member. */
  Avy?: number;
  Avz?: number;
  /** Elastic section moduli, m³ (for the stress, optional). */
  Wy?: number;
  Wz?: number;
  /** Rotation of the section about the member axis, rad. */
  beta?: number;
  /** A direction (global) local z leans towards, instead of the default. */
  ref?: Vec3;
  relA?: Releases;
  relB?: Releases;
}

export interface NumSupport3 {
  id: string;
  node: string;
  /** Per global unknown u_x u_y u_z φ_x φ_y φ_z: true = held, false = free, a number = spring (N/m, N·m/rad). */
  dofs: (boolean | number)[];
}

export type NumLoad3 =
  | { id: string; type: 'node'; node: string; F: Vec3; M: Vec3 }
  /** A force and a moment at fraction t along a member, in global or member axes. */
  | { id: string; type: 'point'; member: string; t: number; F: Vec3; M: Vec3; local: boolean }
  /** A line load from t1 to t2 along a member, q1 → q2 (force per length of member), in global or member axes. */
  | { id: string; type: 'line'; member: string; t1: number; t2: number; q1: Vec3; q2: Vec3; local: boolean };

export interface NumFrame {
  nodes: NumNode3[];
  members: NumMember3[];
  supports: NumSupport3[];
  loads: NumLoad3[];
}

/** One stretch of a member between loads (or, in second order, of an element): exact polynomials in its own x. */
export interface FramePiece {
  /** Start along the member and length, m. */
  s0: number;
  L: number;
  N: number[];
  Vy: number[];
  Vz: number[];
  T: number[];
  My: number[];
  Mz: number[];
  /** Displacements in member axes along x, y, z, and the twist. */
  u: number[];
  v: number[];
  w: number[];
  phi: number[];
}

export const FORCES = ['N', 'Vy', 'Vz', 'T', 'My', 'Mz'] as const;
export type ForceKey = (typeof FORCES)[number];

export interface Member3Result {
  id: string;
  L: number;
  axes: Axes;
  /** Stations: distance from the start node; a station repeats where a value jumps. */
  s: number[];
  N: number[];
  Vy: number[];
  Vz: number[];
  T: number[];
  My: number[];
  Mz: number[];
  /** Global displacement at each station. */
  ux: number[];
  uy: number[];
  uz: number[];
  pieces: FramePiece[];
  /** Forces the nodes exert on the member's ends, member axes: start, end (N, V_y, V_z, T, M_y, M_z each). */
  ends: [number[], number[]];
}

export interface Reaction3 {
  id: string;
  node: string;
  /** Force and moment of the support on the node, global axes. */
  F: Vec3;
  M: Vec3;
}

export interface FrameSolution {
  members: Member3Result[];
  reactions: Reaction3[];
  /** Node displacements, global: u_x u_y u_z φ_x φ_y φ_z. */
  nodes: Record<string, number[]>;
  /** Degree of static indeterminacy (0 = determinate). */
  indeterminacy: number;
  /** Unknowns of the system solved. */
  unknowns: number;
  secondOrder?: { iterations: number };
}

export interface Solve3Options {
  /** Equilibrium on the deformed structure (P-Δ and P-δ), iterated on the axial forces. */
  secondOrder?: boolean;
}

// ---------------------------------------------------------------- vectors

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / n, a[1] / n, a[2] / n];
};
/** R v (global → member axes) and Rᵀ v (member → global). */
export const toLocal = (R: Axes, v: Vec3): Vec3 => [dot(R[0], v), dot(R[1], v), dot(R[2], v)];
export const toGlobal3 = (R: Axes, v: Vec3): Vec3 => [
  R[0][0] * v[0] + R[1][0] * v[1] + R[2][0] * v[2],
  R[0][1] * v[0] + R[1][1] * v[1] + R[2][1] * v[2],
  R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2],
];

/** Within this sine of the vertical a member counts as vertical (its y axis is then global Y). */
const VERTICAL = 1e-3;

/** A member's length and local axes (see the head of this file). */
export function memberAxes(a: Vec3, b: Vec3, beta = 0, ref?: Vec3): { L: number; R: Axes } {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L = Math.hypot(d[0], d[1], d[2]);
  const ex = unit(d);
  let ey: Vec3, ez: Vec3;
  if (ref) {
    const k = dot(ref, ex), r: Vec3 = [ref[0] - k * ex[0], ref[1] - k * ex[1], ref[2] - k * ex[2]];
    if (!(Math.hypot(...r) > 1e-9 * Math.hypot(...ref))) throw new StructureError('A member’s reference direction lies along the member');
    ez = unit(r);
    ey = cross(ez, ex);
  } else if (Math.hypot(ex[0], ex[1]) < VERTICAL) {
    ey = [0, 1, 0];
    ez = unit(cross(ex, ey));
    ey = cross(ez, ex);
  } else {
    // −Z less its part along the member
    ez = unit([ex[0] * ex[2], ex[1] * ex[2], ex[2] * ex[2] - 1]);
    ey = cross(ez, ex);
  }
  if (beta) {
    const c = Math.cos(beta), s = Math.sin(beta);
    [ey, ez] = [[c * ey[0] + s * ez[0], c * ey[1] + s * ez[1], c * ey[2] + s * ez[2]], [c * ez[0] - s * ey[0], c * ez[1] - s * ey[1], c * ez[2] - s * ey[2]]];
  }
  return { L, R: [ex, ey, ez] };
}

// ---------------------------------------------------------------- element matrices

export const GAvy = (m: NumMember3) => (m.Avy && m.Avy > 0 ? m.G * m.Avy : Infinity);
export const GAvz = (m: NumMember3) => (m.Avz && m.Avz > 0 ? m.G * m.Avz : Infinity);
const phiOf = (EI: number, GA: number, L: number) => (12 * EI) / (GA * L * L);

// the two bending planes in the twelve unknowns u v w θx θy θz (start, end); θy = −w′,
// so the x-z plane is the plane frame's with the signs of its rotations turned
const XY = [1, 5, 7, 11], XZ = [2, 4, 8, 10], XZ_SIGN = [1, -1, 1, -1];

/** Put the transverse part (v1 θ1 v2 θ2 = rows 1 2 4 5) of a plane-frame matrix into both bending planes. */
function planes(k: number[][], ky: number[][], kz: number[][]): void {
  const t = [1, 2, 4, 5];
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
    k[XY[a]][XY[b]] += ky[t[a]][t[b]];
    k[XZ[a]][XZ[b]] += XZ_SIGN[a] * XZ_SIGN[b] * kz[t[a]][t[b]];
  }
}

const zeros12 = () => Array.from({ length: 12 }, () => new Array<number>(12).fill(0));

/** Local stiffness (12 × 12) of a space frame member: axial, torsion and both bending planes (Timoshenko with shear areas). */
export function localK3(m: NumMember3, L: number): number[][] {
  const k = zeros12();
  const ea = (m.E * m.A) / L, gj = (m.G * m.It) / L;
  k[0][0] = k[6][6] = ea;
  k[0][6] = k[6][0] = -ea;
  k[3][3] = k[9][9] = gj;
  k[3][9] = k[9][3] = -gj;
  planes(k, localK(m.E, m.A, m.Iz, L, GAvy(m)), localK(m.E, m.A, m.Iy, L, GAvz(m)));
  return k;
}

/** Consistent geometric stiffness of an axial force varying linearly from Na to Nb, both bending planes. */
export function geometricK3(m: NumMember3, L: number, Na: number, Nb: number): number[][] {
  const k = zeros12();
  planes(k, geometricK(Na, L, phiOf(m.E * m.Iz, GAvy(m), L), Nb), geometricK(Na, L, phiOf(m.E * m.Iy, GAvz(m), L), Nb));
  return k;
}

/** A load on an element in member axes, a from its start: a force and a moment at a point, or a linear line load. */
export type ElemLoad =
  | { kind: 'point'; a: number; F: Vec3; M: Vec3 }
  | { kind: 'line'; a: number; b: number; qa: Vec3; qb: Vec3 };

/** Equivalent nodal loads (member axes, both ends fixed) of the loads on an element. */
export function fixedEnd3(m: NumMember3, L: number, loads: ElemLoad[]): number[] {
  const f = new Array<number>(12).fill(0);
  const EIy = m.E * m.Iy, EIz = m.E * m.Iz, gy = GAvy(m), gz = GAvz(m);
  // gyz: the plane-frame values for x-y (v, θz) and x-z (w, −θy)
  const add = (py: number[], pz: number[]) => {
    f[0] += py[0];
    f[6] += py[3];
    for (let a = 0; a < 4; a++) {
      f[XY[a]] += py[[1, 2, 4, 5][a]];
      f[XZ[a]] += XZ_SIGN[a] * pz[[1, 2, 4, 5][a]];
    }
  };
  for (const l of loads) {
    if (l.kind === 'point') {
      const [Fx, Fy, Fz] = l.F, [Mx, My, Mz] = l.M;
      add(pointFixedEnd(L, l.a, Fx, Fy, EIz, gy), pointFixedEnd(L, l.a, 0, Fz, EIy, gz));
      // a moment about +y turns the x-z plane the other way: −M_y there
      if (My || Mz) add(momentFixedEnd(L, l.a, Mz, EIz, gy), momentFixedEnd(L, l.a, -My, EIy, gz));
      f[3] += (Mx * (L - l.a)) / L;
      f[9] += (Mx * l.a) / L;
    } else {
      add(
        lineFixedEnd(L, { a: l.a, b: l.b, qxa: l.qa[0], qxb: l.qb[0], qya: l.qa[1], qyb: l.qb[1] }, EIz, gy),
        lineFixedEnd(L, { a: l.a, b: l.b, qxa: 0, qxb: 0, qya: l.qa[2], qyb: l.qb[2] }, EIy, gz),
      );
    }
  }
  return f;
}

// ---------------------------------------------------------------- statics along an element

interface Stretch3 {
  x0: number;
  L: number;
  N: number[];
  Vy: number[];
  Vz: number[];
  T: number[];
  My: number[];
  Mz: number[];
}

const padd = (a: number[], b: number[]) => Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] ?? 0) + (b[i] ?? 0));
const pscale = (a: number[], k: number) => a.map((v) => v * k);
const pint = (a: number[]) => [0, ...a.map((v, i) => v / (i + 1))];
const pder = (a: number[]) => a.slice(1).map((v, i) => v * (i + 1));

/**
 * The internal forces along an element from statics: the forces at its start (pe, member
 * axes) and the loads before each point. A stretch begins at every point load and at both
 * ends of every line load and holds the values just after it.
 */
export function elemStatics(L: number, loads: ElemLoad[], pe: number[]): Stretch3[] {
  const tol = 1e-12 * L;
  const cuts = loads.flatMap((l) => (l.kind === 'line' ? [l.a, l.b] : [l.a])).sort((p, q) => p - q);
  const xs = [0];
  for (const x of cuts) if (x > xs[xs.length - 1] + tol && x < L - tol) xs.push(x);
  xs.push(L);
  return xs.slice(0, -1).map((x0, k) => {
    // S = −(start forces) − (loads before x), moments about the section
    let N = [-pe[0]], Vy = [-pe[1]], Vz = [-pe[2]], T = [-pe[3]];
    let My = [-pe[4] - x0 * pe[2], -pe[2]], Mz = [-pe[5] + x0 * pe[1], pe[1]];
    for (const l of loads) {
      if (l.kind === 'point') {
        if (l.a > x0 + tol) continue;
        const [Fx, Fy, Fz] = l.F, [Mx, Mly, Mlz] = l.M, d = x0 - l.a;
        N = padd(N, [-Fx]);
        Vy = padd(Vy, [-Fy]);
        Vz = padd(Vz, [-Fz]);
        T = padd(T, [-Mx]);
        My = padd(My, [-d * Fz - Mly, -Fz]);
        Mz = padd(Mz, [d * Fy - Mlz, Fy]);
        continue;
      }
      // the part from a to min(x0, b) as a resultant, the rest along the stretch
      const len = l.b - l.a, c = Math.min(x0, l.b), part = Math.max(0, c - l.a), inside = x0 >= l.a - tol && x0 < l.b - tol;
      const comp = (q: number) => {
        const qa = l.qa[q], slope = (l.qb[q] - qa) / len, qc = qa + slope * part, Q = (part * (qa + qc)) / 2;
        const q0 = inside ? qa + slope * (x0 - l.a) : 0, b = inside ? slope : 0;
        return { F: [Q, q0, b / 2], M: [(x0 - c) * Q + (part * part * (2 * qa + qc)) / 6, Q, q0 / 2, b / 6] };
      };
      const qx = comp(0), qy = comp(1), qz = comp(2);
      N = padd(N, pscale(qx.F, -1));
      Vy = padd(Vy, pscale(qy.F, -1));
      Vz = padd(Vz, pscale(qz.F, -1));
      My = padd(My, pscale(qz.M, -1));
      Mz = padd(Mz, qy.M);
    }
    return { x0, L: xs[k + 1] - x0, N, Vy, Vz, T, My, Mz };
  });
}

/** ∫₀ˣ of a function given per stretch, continuous from stretch to stretch. */
function stretchInt(parts: { L: number }[], f: number[][]): number[][] {
  let acc = 0;
  return f.map((p, k) => {
    const q = pint(p);
    q[0] += acc;
    acc = polyAt(q, parts[k].L);
    return q;
  });
}

function stretchAt(parts: { x0: number; L: number }[], f: number[][], x: number): number {
  const k = parts.findIndex((q, i) => x <= q.x0 + q.L || i === parts.length - 1);
  return polyAt(f[k], x - parts[k].x0);
}

/** A function closed onto end values: f + d1 + (d2 − d1 − f(L)) x / L per stretch. */
function closeOnto(parts: { x0: number; L: number }[], f: number[][], L: number, d1: number, d2: number): number[][] {
  const lin = (d2 - d1 - stretchAt(parts, f, L)) / L;
  return f.map((p, k) => padd(p, [d1 + lin * parts[k].x0, lin]));
}

/**
 * Displacements of an element (first order) per stretch: v from M_z/EI_z, w from
 * −M_y/EI_y (each plus the shear strain V/GA_v), u from N/EA and the twist from T/GI_t,
 * all between the member's exact end displacements dm (member axes).
 */
function elasticLine(m: NumMember3, L: number, parts: Stretch3[], dm: number[]): Pick<FramePiece, 'u' | 'v' | 'w' | 'phi'>[] {
  const sy = Number.isFinite(GAvy(m)) ? 1 / GAvy(m) : 0, sz = Number.isFinite(GAvz(m)) ? 1 / GAvz(m) : 0;
  const twice = (f: number[][]) => stretchInt(parts, stretchInt(parts, f));
  const v = twice(parts.map((q) => pscale(q.Mz, 1 / (m.E * m.Iz)))).map((p, k) => padd(p, stretchInt(parts, parts.map((q) => pscale(q.Vy, sy)))[k]));
  const w = twice(parts.map((q) => pscale(q.My, -1 / (m.E * m.Iy)))).map((p, k) => padd(p, stretchInt(parts, parts.map((q) => pscale(q.Vz, sz)))[k]));
  const u = stretchInt(parts, parts.map((q) => pscale(q.N, 1 / (m.E * m.A))));
  const phi = stretchInt(parts, parts.map((q) => pscale(q.T, 1 / (m.G * m.It))));
  const U = closeOnto(parts, u, L, dm[0], dm[6]), V = closeOnto(parts, v, L, dm[1], dm[7]);
  const W = closeOnto(parts, w, L, dm[2], dm[8]), P = closeOnto(parts, phi, L, dm[3], dm[9]);
  return parts.map((_, k) => ({ u: U[k], v: V[k], w: W[k], phi: P[k] }));
}

/**
 * Second order, one bending plane: the moment B is statics on the deformed element,
 * B = B_I + N₀ (d − d₁), with the deflection d from B itself (d″ = B/EI, plus −∫B′/GA_v),
 * by substitution; then closed onto the end moment the stiffness gives. In x-y B = M_z and
 * d = v; in x-z B = −M_y and d = w.
 */
function planeSecondOrder(parts: Stretch3[], BI: number[][], EI: number, GA: number, N0: number, d1: number, d2: number, Bend: number, L: number): { B: number[][]; d: number[][] } {
  const sh = Number.isFinite(GA) ? 1 / GA : 0;
  const shape = (B: number[][]) => {
    const bend = stretchInt(parts, stretchInt(parts, B.map((q) => pscale(q, 1 / EI))));
    const shear = stretchInt(parts, B.map((q) => pscale(pder(q), -sh)));
    return closeOnto(parts, bend.map((p, k) => padd(p, shear[k])), L, d1, d2);
  };
  let B = BI;
  const size = Math.max(...parts.flatMap((q, k) => BI[k].map((c, i) => Math.abs(c) * q.L ** i)), Math.abs(Bend), 1e-300);
  for (let round = 0; round < 8; round++) {
    const d = shape(B);
    const next = BI.map((b, k) => padd(b, pscale(padd(d[k], [-d1]), N0)));
    const change = Math.max(Math.abs(stretchAt(parts, next, L) - stretchAt(parts, B, L)), Math.abs(stretchAt(parts, next, L / 2) - stretchAt(parts, B, L / 2)));
    B = next;
    if (change <= 1e-10 * size) break;
  }
  const close = (Bend - stretchAt(parts, B, L)) / L;
  B = B.map((q, k) => padd(q, [close * parts[k].x0, close]));
  return { B, d: shape(B) };
}

// ---------------------------------------------------------------- members as substructures

/** An element of a member: where it lies along it, the loads on it (member axes), and its twelve unknowns among the member's. */
export interface Elem {
  t0: number;
  t1: number;
  L: number;
  loads: ElemLoad[];
  dofs: number[];
}

/**
 * A member as a substructure: n elements in a row (one in first order). Its unknowns are
 * the twelve its end nodes see (member axes: 0–5 at the start, 6–11 at the end), then its
 * own: a released end's unknowns (free of the node) and six at each point between
 * elements. Its own unknowns are condensed out, so the structure's system holds only the
 * nodes, whatever the elements.
 */
export interface Chain {
  member: NumMember3;
  index: number;
  /** Node indices at the start and end. */
  i: number;
  j: number;
  L: number;
  R: Axes;
  elems: Elem[];
  /** Unknowns in all (12 + its own). */
  size: number;
  /** Local unknowns released at the ends (0–5 start, 6–11 end). */
  released: number[];
}

export interface FrameMesh3 {
  nodeIndex: Map<string, number>;
  pos: Vec3[];
  chains: Chain[];
  /** Per node: some member ends there (a node in the table that no member uses yet is not part of the structure). */
  connected: boolean[];
}

const clampT = (t: number) => Math.min(1, Math.max(0, t));

/**
 * Elements per member for second order and buckling: eight cubic elements put the critical
 * load of a fixed-ended column within 0.1 % (four: 0.8 %); big frames get fewer, never
 * under four.
 */
export function elementsPerMember3(members: number): number {
  return Math.max(4, Math.min(8, Math.floor(2000 / Math.max(1, members))));
}

/** The structure's nodes and its members cut into n elements each, with the loads on them in member axes. */
export function frameMesh3(st: NumFrame, n = 1): FrameMesh3 {
  if (!st.members.length) throw new StructureError('Add at least one member');
  if (!st.supports.length) throw new StructureError('Add supports: the structure needs to be held in place');
  const nodeIndex = new Map<string, number>();
  const pos: Vec3[] = [];
  for (const q of st.nodes) {
    if (nodeIndex.has(q.id)) continue;
    nodeIndex.set(q.id, pos.length);
    pos.push([q.x, q.y, q.z]);
  }
  const loadsOn = st.members.map((): ElemLoad[] => []);
  const axes = st.members.map((m) => {
    const i = nodeIndex.get(m.a), j = nodeIndex.get(m.b);
    if (i === undefined || j === undefined) throw new StructureError(`Member ${m.name ?? m.id} is missing a node`);
    if (!(m.E > 0 && m.G > 0 && m.A > 0 && m.Iy > 0 && m.Iz > 0 && m.It > 0)) throw new StructureError(`Member ${m.name ?? m.id}: E, G, A, I_y, I_z and I_t must be positive`);
    const ax = memberAxes(pos[i], pos[j], m.beta, m.ref);
    if (!(ax.L > 0)) throw new StructureError(`Member ${m.name ?? m.id} has zero length`);
    return ax;
  });
  const byId = new Map(st.members.map((m, k) => [m.id, k]));
  for (const l of st.loads) {
    if (l.type === 'node') {
      if (!nodeIndex.has(l.node)) throw new StructureError('A load sits on a missing node');
      continue;
    }
    const k = byId.get(l.member);
    if (k === undefined) throw new StructureError('A load sits on a missing member');
    const { L, R } = axes[k], loc = (v: Vec3) => (l.local ? v : toLocal(R, v));
    if (l.type === 'point') loadsOn[k].push({ kind: 'point', a: clampT(l.t) * L, F: loc(l.F), M: loc(l.M) });
    else {
      const ta = clampT(Math.min(l.t1, l.t2)), tb = clampT(Math.max(l.t1, l.t2));
      if (!(tb > ta)) continue;
      const qAt = (t: number): Vec3 => {
        const f = (t - l.t1) / (l.t2 - l.t1);
        return [0, 1, 2].map((c) => l.q1[c] + (l.q2[c] - l.q1[c]) * f) as Vec3;
      };
      loadsOn[k].push({ kind: 'line', a: ta * L, b: tb * L, qa: loc(qAt(ta)), qb: loc(qAt(tb)) });
    }
  }
  const chains = st.members.map((m, k): Chain => {
    const relA = (m.relA ?? []).flatMap((r, q) => (r && q < 6 ? [q] : [])), relB = (m.relB ?? []).flatMap((r, q) => (r && q < 6 ? [q] : []));
    freeOfLoads(m, relA, relB, loadsOn[k]);
    // own unknowns: released start ones, the points between elements, released end ones
    const ownA = new Map(relA.map((c, q) => [c, 12 + q]));
    const inner = 12 + relA.length;
    const ownB = new Map(relB.map((c, q) => [c, inner + 6 * (n - 1) + q]));
    const { L } = axes[k];
    const elems = Array.from({ length: n }, (_, q): Elem => {
      const x0 = (L * q) / n, x1 = q === n - 1 ? L : (L * (q + 1)) / n, last = q === n - 1;
      const dofs = [
        ...[0, 1, 2, 3, 4, 5].map((c) => (q === 0 ? ownA.get(c) ?? c : inner + 6 * (q - 1) + c)),
        ...[0, 1, 2, 3, 4, 5].map((c) => (last ? ownB.get(c) ?? 6 + c : inner + 6 * q + c)),
      ];
      return { t0: x0 / L, t1: x1 / L, L: x1 - x0, loads: loadsWithin(loadsOn[k], x0, x1, last), dofs };
    });
    return {
      member: m, index: k, i: nodeIndex.get(m.a)!, j: nodeIndex.get(m.b)!, L, R: axes[k].R, elems,
      size: inner + 6 * (n - 1) + relB.length, released: [...relA, ...relB.map((c) => 6 + c)],
    };
  });
  // a node no member uses (one just added to the table) stays out of the system, else it
  // would be a mechanism; a load on it has nothing to act on
  const connected = pos.map(() => false);
  for (const c of chains) connected[c.i] = connected[c.j] = true;
  for (const l of st.loads) {
    if (l.type !== 'node' || connected[nodeIndex.get(l.node)!]) continue;
    const q = st.nodes.find((p) => p.id === l.node);
    throw new StructureError(`A load acts on node ${q?.name ?? l.node}, which no member connects`);
  }
  return { nodeIndex, pos, chains, connected };
}

/** The loads between x0 and x1 of a member, measured from x0 (a point load on a cut goes to the element after it). */
function loadsWithin(loads: ElemLoad[], x0: number, x1: number, last: boolean): ElemLoad[] {
  const out: ElemLoad[] = [];
  for (const l of loads) {
    if (l.kind === 'point') {
      if (l.a >= x0 && (l.a < x1 || last)) out.push({ ...l, a: l.a - x0 });
      continue;
    }
    const la = Math.max(l.a, x0), lb = Math.min(l.b, x1);
    if (!(lb - la > 1e-12 * (x1 - x0))) continue;
    const at = (x: number) => [0, 1, 2].map((c) => l.qa[c] + ((l.qb[c] - l.qa[c]) * (x - l.a)) / (l.b - l.a)) as Vec3;
    out.push({ kind: 'line', a: la - x0, b: lb - x0, qa: at(la), qb: at(lb) });
  }
  return out;
}

/**
 * A member released at both ends in N, V_y, V_z or T is free to slide, shift or spin in
 * that direction (harmless while nothing loads it that way); a load that way has no path.
 */
function freeOfLoads(m: NumMember3, relA: number[], relB: number[], loads: ElemLoad[]): void {
  const both = (c: number) => relA.includes(c) && relB.includes(c);
  for (const c of [0, 1, 2, 3]) {
    if (!both(c)) continue;
    const loaded = loads.some((l) => (c === 3 ? l.kind === 'point' && l.M[0] !== 0 : l.kind === 'point' ? l.F[c] !== 0 : l.qa[c] !== 0 || l.qb[c] !== 0));
    if (loaded) throw new StructureError(`Member ${m.name ?? m.id} is released in ${END_FORCES[c]} at both ends, but a load on it needs that force`);
  }
  // shear and moment both released at both ends: the member turns freely in that plane
  for (const [v, mo, c] of [[1, 5, 2], [2, 4, 1]] as const) {
    if (both(v) && both(mo) && loads.some((l) => l.kind === 'point' && l.M[c] !== 0)) throw new StructureError(`Member ${m.name ?? m.id} turns freely about its ${c === 2 ? 'z' : 'y'} axis, but a moment acts on it`);
  }
}

/** A dense Cholesky factor of a member's own block (ni × ni, lower), with the rows' first nonzero. */
interface OwnFactor {
  L: number[][];
  first: number[];
  /** Pivots held by their own diagonal: the member's free motions (rigid spin or shift). */
  locked: number;
}

/**
 * Cholesky of a member's own block, its envelope kept. A pivot that is zero to round-off
 * (a member free to spin, see freeOfLoads) is held by its own diagonal; a negative one
 * (second order) means the member buckles between its nodes.
 */
function ownCholesky(A: number[][], name: string): OwnFactor {
  const n = A.length;
  const first = A.map((row, i) => {
    let j = 0;
    while (j < i && row[j] === 0) j++;
    return j;
  });
  const L = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  let locked = 0;
  for (let i = 0; i < n; i++) {
    const Li = L[i];
    for (let j = first[i]; j <= i; j++) {
      const Lj = L[j];
      let s = A[i][j];
      for (let k = Math.max(first[i], first[j]); k < j; k++) s -= Li[k] * Lj[k];
      if (j < i) Li[j] = s / Lj[j];
      else {
        const d = A[i][i];
        if (!(s > 1e-12 * d)) {
          if (!(Math.abs(s) <= 1e-12 * Math.abs(d)) || !(d > 0)) throw new InstabilityError(`Second order: member ${name} buckles between its nodes (the loads are above its critical load)`);
          s = d;
          locked++;
        }
        Li[i] = Math.sqrt(s);
      }
    }
  }
  return { L, first, locked };
}

function ownForward({ L, first }: OwnFactor, b: ArrayLike<number>): number[] {
  const n = b.length, x = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    const Li = L[i];
    for (let k = first[i]; k < i; k++) s -= Li[k] * x[k];
    x[i] = s / Li[i];
  }
  return x;
}

function ownBackward({ L, first }: OwnFactor, b: ArrayLike<number>): number[] {
  const x = Array.from(b);
  for (let i = x.length - 1; i >= 0; i--) {
    const Li = L[i];
    x[i] /= Li[i];
    const xi = x[i];
    for (let k = first[i]; k < i; k++) x[k] -= Li[k] * xi;
  }
  return x;
}

/** A member's matrices and loads assembled from its elements (`Ne`: the elements' axial forces, for the geometric stiffness). */
export interface ChainSystem {
  /** Element stiffness (with the geometric stiffness when asked) and fixed-end forces, member axes. */
  k: number[][][];
  f: number[][];
  /** The member's own block factor, Z = L⁻¹ K_oe (own × 12), and y = L⁻¹ f_o. */
  own: OwnFactor;
  Z: number[][];
  y: number[];
  /** Its stiffness and loads as the nodes see them, member axes: S = K_ee − Zᵀ Z, g = f_e − Zᵀ y. */
  S: number[][];
  g: number[];
}

/** Assemble a member's matrix from its elements; `add` gives each element's extra matrix (geometric stiffness). */
export function chainMatrix(c: Chain, mat: (e: Elem, q: number) => number[][]): number[][] {
  const K = Array.from({ length: c.size }, () => new Array<number>(c.size).fill(0));
  c.elems.forEach((e, q) => {
    const k = mat(e, q);
    for (let a = 0; a < 12; a++) for (let b = 0; b < 12; b++) if (k[a][b]) K[e.dofs[a]][e.dofs[b]] += k[a][b];
  });
  return K;
}

export function chainSystem(c: Chain, Ne?: [number, number][]): ChainSystem {
  const m = c.member;
  const k = c.elems.map((e, q) => {
    const ke = localK3(m, e.L);
    if (Ne) {
      const kg = geometricK3(m, e.L, Ne[q][0], Ne[q][1]);
      for (let a = 0; a < 12; a++) for (let b = 0; b < 12; b++) ke[a][b] += kg[a][b];
    }
    return ke;
  });
  const f = c.elems.map((e) => fixedEnd3(m, e.L, e.loads));
  const K = chainMatrix(c, (_, q) => k[q]);
  const F = new Array<number>(c.size).fill(0);
  c.elems.forEach((e, q) => e.dofs.forEach((d, a) => (F[d] += f[q][a])));
  const ni = c.size - 12;
  const own = ownCholesky(Array.from({ length: ni }, (_, a) => K[12 + a].slice(12)), m.name ?? m.id);
  // Z column by column: L⁻¹ times the own × end block
  const cols = Array.from({ length: 12 }, (_, e) => ownForward(own, Array.from({ length: ni }, (__, a) => K[12 + a][e])));
  const Z = Array.from({ length: ni }, (_, a) => cols.map((col) => col[a]));
  const y = ownForward(own, F.slice(12));
  const S = Array.from({ length: 12 }, (_, a) => Array.from({ length: 12 }, (__, b) => {
    let s = K[a][b];
    for (let r = 0; r < ni; r++) s -= Z[r][a] * Z[r][b];
    return s;
  }));
  const g = Array.from({ length: 12 }, (_, a) => {
    let s = F[a];
    for (let r = 0; r < ni; r++) s -= Z[r][a] * y[r];
    return s;
  });
  return { k, f, own, Z, y, S, g };
}

/** A member's own unknowns from its end unknowns (member axes): x_o = L⁻ᵀ (b − Z x_e), b = L⁻¹ f_o. */
export function ownUnknowns(sys: ChainSystem, xe: number[], b = sys.y): number[] {
  return ownBackward(sys.own, b.map((v, r) => v - sys.Z[r].reduce((s, z, e) => s + z * xe[e], 0)));
}

export { ownForward, ownBackward };

// ---------------------------------------------------------------- the system

/** Unknowns of the structure: six per connected node, less what supports hold. */
export interface Dofs {
  /** Equation of each node unknown (6 per node), −1 where a support holds it or no member ends there. */
  nodeEq: Int32Array;
  count: number;
  /** Springs on node unknowns: equation → stiffness. */
  springs: Map<number, number>;
}

export function nodeDofs(st: NumFrame, mesh: FrameMesh3): Dofs {
  const nn = mesh.pos.length;
  const held = new Uint8Array(6 * nn);
  const springs = new Map<number, number>();
  const springAt: [number, number][] = [];
  for (const sp of st.supports) {
    const k = mesh.nodeIndex.get(sp.node);
    if (k === undefined || !mesh.connected[k]) continue;
    sp.dofs.forEach((d, c) => {
      if (d === true) held[6 * k + c] = 1;
      else if (typeof d === 'number' && d > 0) springAt.push([6 * k + c, d]);
    });
  }
  const nodeEq = new Int32Array(6 * nn).fill(-1);
  let count = 0;
  for (let q = 0; q < 6 * nn; q++) if (!held[q] && mesh.connected[Math.floor(q / 6)]) nodeEq[q] = count++;
  for (const [q, kq] of springAt) if (nodeEq[q] >= 0) springs.set(nodeEq[q], (springs.get(nodeEq[q]) ?? 0) + kq);
  return { nodeEq, count, springs };
}

/** A member's twelve end unknowns (member axes) as [equation, weight] pairs of the node unknowns. */
export function endMap(c: Chain, dofs: Dofs): [number, number][][] {
  const map: [number, number][][] = [];
  for (let l = 0; l < 12; l++) {
    const node = l < 6 ? c.i : c.j, base = 6 * node + (l % 6 < 3 ? 0 : 3), row = c.R[l % 3];
    const out: [number, number][] = [];
    for (let g = 0; g < 3; g++) {
      const eq = dofs.nodeEq[base + g];
      if (eq >= 0 && row[g] !== 0) out.push([eq, row[g]]);
    }
    map.push(out);
  }
  return map;
}

export function scatter(K: SparseSym, k: number[][], map: [number, number][][]): void {
  for (let a = 0; a < 12; a++) for (let b = 0; b < 12; b++) {
    const v = k[a][b];
    if (v) for (const [ia, wa] of map[a]) for (const [ib, wb] of map[b]) K.add(ia, ib, wa * wb * v);
  }
}

export const gather = (map: [number, number][][], x: ArrayLike<number>) => map.map((list) => list.reduce((s, [eq, w]) => s + w * x[eq], 0));

const AXES = ['X', 'Y', 'Z'];

/** Where a factorisation broke down, in words. */
export function mechanismAt(st: NumFrame, mesh: FrameMesh3, dofs: Dofs, row: number): string {
  const q = dofs.nodeEq.indexOf(row);
  if (q < 0) return '';
  const k = Math.floor(q / 6), c = q % 6;
  const node = st.nodes.find((p) => mesh.nodeIndex.get(p.id) === k);
  return node ? ` at node ${node.name ?? node.id}, ${c < 3 ? 'along' : 'about'} ${AXES[c % 3]}` : '';
}

/**
 * Rotations nothing holds: where every member end at a node is released in bending
 * (pin-jointed bars), the node's rotations have no stiffness at all in some directions.
 * K is positive semidefinite, so such a direction n of the node's own 3 × 3 block has
 * K n = 0 in the whole system; it is locked (a stiffness along n changes nothing else),
 * unless a moment acts on it. Returns the locks as entries to add to K.
 */
export function freeRotations(K: SparseSym, F: Float64Array, st: NumFrame, mesh: FrameMesh3, dofs: Dofs): { entries: [number, number, number][]; count: number } {
  const scale = new Float64Array(mesh.pos.length);
  for (const c of mesh.chains) {
    const m = c.member, s = (m.E * Math.max(m.Iy, m.Iz) + m.G * m.It) / c.L;
    scale[c.i] += s;
    scale[c.j] += s;
  }
  const entries: [number, number, number][] = [];
  let count = 0;
  for (let k = 0; k < mesh.pos.length; k++) {
    const eqs = [3, 4, 5].map((c) => dofs.nodeEq[6 * k + c]).filter((q) => q >= 0);
    if (!eqs.length || !(scale[k] > 0)) continue;
    const B = eqs.map((a) => eqs.map((b) => K.rows[a].get(b) ?? 0));
    const { values, vectors } = symmetricEigen(B);
    values.forEach((lam, i) => {
      if (Math.abs(lam) > 1e-11 * scale[k]) return;
      const n = vectors.map((row) => row[i]);
      const load = eqs.reduce((s, q, a) => s + F[q] * n[a], 0);
      if (Math.abs(load) > 1e-9 * Math.max(...eqs.map((q) => Math.abs(F[q])))) {
        const node = st.nodes.find((p) => mesh.nodeIndex.get(p.id) === k);
        throw new StructureError(`A moment acts on a pinned joint${node ? ` (node ${node.name ?? node.id})` : ''}, where nothing can carry it`);
      }
      eqs.forEach((a, p) => eqs.forEach((b, q) => entries.push([a, b, scale[k] * n[p] * n[q]])));
      count++;
    });
  }
  return { entries, count };
}

/** The structure's system: every member condensed to its ends, nodal loads, springs. */
export interface FrameSystem {
  chains: ChainSystem[];
  maps: [number, number][][][];
  K: SparseSym;
  F: Float64Array;
}

export function frameSystem(st: NumFrame, mesh: FrameMesh3, dofs: Dofs, Ne?: [number, number][][]): FrameSystem {
  const n = dofs.count;
  const K = new SparseSym(n), F = new Float64Array(n);
  for (const l of st.loads) {
    if (l.type !== 'node') continue;
    const k = mesh.nodeIndex.get(l.node)!;
    [...l.F, ...l.M].forEach((v, c) => {
      const eq = dofs.nodeEq[6 * k + c];
      if (eq >= 0) F[eq] += v;
    });
  }
  const maps = mesh.chains.map((c) => endMap(c, dofs));
  const chains = mesh.chains.map((c, ci) => {
    const sys = chainSystem(c, Ne?.[ci]);
    scatter(K, sys.S, maps[ci]);
    maps[ci].forEach((list, a) => { for (const [eq, w] of list) F[eq] += w * sys.g[a]; });
    return sys;
  });
  for (const [eq, kq] of dofs.springs) K.add(eq, eq, kq);
  return { chains, maps, K, F };
}

export function solveFrame3(st: NumFrame, opts: Solve3Options = {}): FrameSolution {
  const second = !!opts.secondOrder;
  // second order works on short elements; first order on the members themselves (exact)
  const mesh = frameMesh3(st, second ? elementsPerMember3(st.members.length) : 1);
  const dofs = nodeDofs(st, mesh);
  const n = dofs.count;
  const nodal = new Float64Array(6 * mesh.pos.length);
  for (const l of st.loads) if (l.type === 'node') [...l.F, ...l.M].forEach((v, c) => (nodal[6 * mesh.nodeIndex.get(l.node)! + c] += v));

  let sys = frameSystem(st, mesh, dofs);
  // (the same locks in every later assembly: second order)
  const locks = freeRotations(sys.K, sys.F, st, mesh, dofs);
  const solve = (s: FrameSystem, unstable: boolean): Float64Array => {
    for (const [a, b, v] of locks.entries) s.K.add(a, b, v);
    if (!n) return new Float64Array(0);
    const fail = { row: -1 };
    const ch = skylineCholesky(s.K, fail);
    if (ch) return skylineSolve(ch, s.F);
    if (unstable) throw new InstabilityError('Second order: the loads reach the critical (buckling) load, so there is no stable equilibrium');
    throw new StructureError(`The structure can move freely (a mechanism)${mechanismAt(st, mesh, dofs, fail.row)}: add supports, or remove releases`);
  };
  let D = solve(sys, false);

  /** Every element's end displacements and end forces (member axes). */
  const elementEnds = () => mesh.chains.map((c, ci) => {
    const cs = sys.chains[ci], xe = gather(sys.maps[ci], D);
    const x = [...xe, ...ownUnknowns(cs, xe)];
    return c.elems.map((e, q) => {
      const dm = e.dofs.map((d) => x[d]);
      const k = cs.k[q], f = cs.f[q];
      const pe = k.map((row, a) => row.reduce((acc, v, b) => acc + v * dm[b], 0) - f[a]);
      return { dm, pe };
    });
  });

  let iterations = 0;
  if (second) {
    let converged = false;
    for (let it = 1; it <= 30 && !converged; it++) {
      const ends = elementEnds();
      const Ne = mesh.chains.map((c, ci) => c.elems.map((e, q): [number, number] => {
        const parts = elemStatics(e.L, e.loads, ends[ci][q].pe), last = parts[parts.length - 1];
        return [polyAt(parts[0].N, 0), polyAt(last.N, last.L)];
      }));
      const next = frameSystem(st, mesh, dofs, Ne);
      const D2 = solve(next, true);
      let dn = 0, nrm = 0;
      for (let q = 0; q < n; q++) {
        dn += (D2[q] - D[q]) ** 2;
        nrm += D2[q] ** 2;
      }
      converged = Math.sqrt(dn) <= 1e-6 * Math.sqrt(nrm) || nrm === 0;
      D = D2;
      sys = next;
      iterations = it;
    }
    if (!converged) throw new InstabilityError('Second order did not converge in 30 iterations: the loads are close to or above the critical load');
  }

  // members: forces, stations and displacements
  const nodeForce = new Float64Array(6 * mesh.pos.length);
  const ends = elementEnds();
  const results = mesh.chains.map((c, ci): Member3Result => {
    const m = c.member;
    const r: Member3Result = { id: m.id, L: c.L, axes: c.R, s: [], N: [], Vy: [], Vz: [], T: [], My: [], Mz: [], ux: [], uy: [], uz: [], pieces: [], ends: [[], []] };
    const first = ends[ci][0].pe, last = ends[ci][c.elems.length - 1].pe;
    r.ends = [first.slice(0, 6), last.slice(6)];
    // released end forces are zero (round-off aside)
    for (const q of c.released) r.ends[q < 6 ? 0 : 1][q % 6] = 0;
    // the forces the member puts on its nodes, global (for the reactions)
    for (const [end, node] of [[0, c.i], [1, c.j]] as const) {
      const F = toGlobal3(c.R, r.ends[end].slice(0, 3) as Vec3), M = toGlobal3(c.R, r.ends[end].slice(3) as Vec3);
      for (let q = 0; q < 3; q++) {
        nodeForce[6 * node + q] += F[q];
        nodeForce[6 * node + 3 + q] += M[q];
      }
    }
    c.elems.forEach((e, q) => {
      const { dm, pe } = ends[ci][q];
      const parts = elemStatics(e.L, e.loads, pe);
      const disp = elasticLine(m, e.L, parts, dm);
      let pieces: FramePiece[];
      if (!second) pieces = parts.map((p, k) => ({ s0: e.t0 * c.L + p.x0, L: p.L, N: p.N, Vy: p.Vy, Vz: p.Vz, T: p.T, My: p.My, Mz: p.Mz, ...disp[k] }));
      else {
        const N0 = -pe[0];
        const xy = planeSecondOrder(parts, parts.map((p) => p.Mz), m.E * m.Iz, GAvy(m), N0, dm[1], dm[7], pe[11], e.L);
        const xz = planeSecondOrder(parts, parts.map((p) => pscale(p.My, -1)), m.E * m.Iy, GAvz(m), N0, dm[2], dm[8], -pe[10], e.L);
        pieces = parts.map((p, k) => {
          const My = pscale(xz.B[k], -1), Mz = xy.B[k];
          return { s0: e.t0 * c.L + p.x0, L: p.L, N: p.N, Vy: pscale(pder(Mz), -1), Vz: pder(My), T: p.T, My, Mz, u: disp[k].u, v: xy.d[k], w: xz.d[k], phi: disp[k].phi };
        });
      }
      r.pieces.push(...pieces);
      for (const p of pieces) stations(r, p);
    });
    return r;
  });

  // reactions: what the members put on a held node, less the loads on it
  const reactions: Reaction3[] = st.supports.flatMap((sp) => {
    const k = mesh.nodeIndex.get(sp.node);
    if (k === undefined || !mesh.connected[k]) return [];
    const R = [0, 1, 2, 3, 4, 5].map((c) => {
      const q = 6 * k + c, d = sp.dofs[c];
      if (d === true) return nodeForce[q] - nodal[q];
      // a spring pulls the node back: −k u
      if (typeof d === 'number' && d > 0) return -d * D[dofs.nodeEq[q]];
      return 0;
    });
    return [{ id: sp.id, node: sp.node, F: [R[0], R[1], R[2]], M: [R[3], R[4], R[5]] }];
  });

  const nodes: FrameSolution['nodes'] = {};
  for (const q of st.nodes) {
    const k = mesh.nodeIndex.get(q.id)!;
    if (!mesh.connected[k]) continue;
    nodes[q.id] = [0, 1, 2, 3, 4, 5].map((c) => {
      const eq = dofs.nodeEq[6 * k + c];
      return eq >= 0 ? D[eq] : 0;
    });
  }
  // degree of indeterminacy: 6m + r − 6j − c (c = released end forces), plus the locked
  // rotations of pinned joints and the free spin (or shift) of members released at both ends
  const restraints = st.supports.reduce((acc, sp) => {
    const k = mesh.nodeIndex.get(sp.node);
    return k === undefined || !mesh.connected[k] ? acc : acc + sp.dofs.filter((d) => d === true || (typeof d === 'number' && d > 0)).length;
  }, 0);
  const releases = mesh.chains.reduce((acc, c) => acc + c.released.length, 0);
  const joints = mesh.connected.filter(Boolean).length, spins = sys.chains.reduce((acc, c) => acc + c.own.locked, 0);
  const indeterminacy = 6 * st.members.length + restraints - 6 * joints - releases + locks.count + spins;
  return { members: results, reactions, nodes, indeterminacy, unknowns: n, ...(second ? { secondOrder: { iterations } } : {}) };
}

const STATIONS = 24;

/** Stations along a stretch: both ends (so a jump keeps both sides), evenly between, and where M_y or M_z peaks. */
function stations(r: Member3Result, q: FramePiece): void {
  const n = Math.max(2, Math.ceil((STATIONS * q.L) / r.L));
  const xs = new Set<number>();
  for (let k = 0; k <= n; k++) xs.add((q.L * k) / n);
  for (const V of [q.Vy, q.Vz]) for (const x of rootsOf(V, q.L)) xs.add(x);
  for (const x of [...xs].sort((a, b) => a - b)) {
    r.s.push(q.s0 + x);
    for (const key of FORCES) r[key].push(polyAt(q[key], x));
    const g = toGlobal3(r.axes, [polyAt(q.u, x), polyAt(q.v, x), polyAt(q.w, x)]);
    r.ux.push(g[0]);
    r.uy.push(g[1]);
    r.uz.push(g[2]);
  }
}

/** Zeros of a polynomial inside (0, L): exactly up to a quadratic, else by sign changes and bisection. */
export function rootsOf(p: number[], L: number): number[] {
  const scale = p.reduce((s, c, i) => Math.max(s, Math.abs(c) * L ** i), 0);
  if (!(scale > 0)) return [];
  const c = p.map((v, i) => (Math.abs(v) * L ** i > 1e-13 * scale ? v : 0));
  const deg = c.reduceRight((d, v, i) => (d < 0 && v !== 0 ? i : d), -1);
  let xs: number[];
  if (deg <= 0) xs = [];
  else if (deg === 1) xs = [-c[0] / c[1]];
  else if (deg === 2) {
    const disc = c[1] * c[1] - 4 * c[2] * c[0];
    xs = disc < 0 ? [] : [(-c[1] + Math.sqrt(disc)) / (2 * c[2]), (-c[1] - Math.sqrt(disc)) / (2 * c[2])];
  } else {
    xs = [];
    const steps = 16;
    let x0 = 0, f0 = polyAt(c, 0);
    for (let k = 1; k <= steps; k++) {
      const x1 = (L * k) / steps, f1 = polyAt(c, x1);
      if (f0 * f1 < 0) {
        let a = x0, b = x1, fa = f0;
        for (let it = 0; it < 60; it++) {
          const mid = (a + b) / 2, fm = polyAt(c, mid);
          if (fa * fm <= 0) b = mid;
          else { a = mid; fa = fm; }
        }
        xs.push((a + b) / 2);
      }
      x0 = x1;
      f0 = f1;
    }
  }
  return xs.filter((x) => x > 0 && x < L);
}

/** Values at distance s along a member (the right-hand side at a jump): forces, global displacement, twist. */
export function memberAt3(r: Member3Result, s: number): Record<ForceKey, number> & { ux: number; uy: number; uz: number; phi: number } {
  const p = r.pieces.find((q, i) => s < q.s0 + q.L - 1e-12 * r.L || i === r.pieces.length - 1)!;
  const x = Math.min(Math.max(s - p.s0, 0), p.L);
  const g = toGlobal3(r.axes, [polyAt(p.u, x), polyAt(p.v, x), polyAt(p.w, x)]);
  return {
    N: polyAt(p.N, x), Vy: polyAt(p.Vy, x), Vz: polyAt(p.Vz, x), T: polyAt(p.T, x), My: polyAt(p.My, x), Mz: polyAt(p.Mz, x),
    ux: g[0], uy: g[1], uz: g[2], phi: polyAt(p.phi, x),
  };
}

/** The same over an envelope: the largest from its upper side, the smallest from its lower one. */
export function boundExtremes(hi: Member3Result, lo?: Member3Result): ReturnType<typeof memberExtremes> {
  const out = memberExtremes(hi);
  if (!lo) return out;
  const low = memberExtremes(lo);
  for (const key of FORCES) out[key] = { ...out[key], min: low[key].min, sMin: low[key].sMin };
  return out;
}

/** Largest and smallest of each internal force along a member, with where they are. */
export function memberExtremes(r: Member3Result): Record<ForceKey, { max: number; min: number; sMax: number; sMin: number }> {
  const out = {} as Record<ForceKey, { max: number; min: number; sMax: number; sMin: number }>;
  for (const key of FORCES) {
    let max = -Infinity, min = Infinity, sMax = 0, sMin = 0;
    r[key].forEach((v, i) => {
      if (v > max) { max = v; sMax = r.s[i]; }
      if (v < min) { min = v; sMin = r.s[i]; }
    });
    out[key] = { max, min, sMax, sMin };
  }
  return out;
}
