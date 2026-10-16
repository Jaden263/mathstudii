// Linear plate analysis on a quad mesh: MITC4 elements, supports along lines (simply
// supported, clamped, elastic), at points and under column heads (an elastic bedding), and
// area, patch, line and point loads per load case. The stiffness is assembled once,
// numbered node by node for a small envelope and factorised in it (skyline.ts); every
// load case is one more right-hand side.
//
// A simple support is the "hard" one: w = 0 and the rotation along the edge β_s = 0, which
// Kirchhoff's w = 0 along a line implies, so the twisting moments and corner forces come
// out as in the plate tables. On an edge that is not along x or y the node's rotations are
// turned into the edge's normal and tangent.
//
// Results are recovered per element corner: moments from the Gauss points, extrapolated
// and averaged at each node over the elements around it, but only among those on the same
// side of a wall or line load, where shear forces jump; the shear forces follow from
// equilibrium, q_x = ∂m_x/∂x + ∂m_xy/∂y, q_y = ∂m_xy/∂x + ∂m_y/∂y, of the smoothed moments
// (the element's own shear strains carry the thin plate's tiny γ and are useless for
// q there).
import { EnvelopeMatrix, envelopeCholesky, envelopeSolve, nodeGraph, nodeOrder } from './skyline';
import { insidePolygon, type Pt } from './cdt';
import { beddingStiffness, centreOperator, extrapolatedMoments, inverseMap, mitc4Stiffness, pressureLoad, rigidity, shape, type PlateRigidity } from './mitc4';
import { buildRecovery, recover, type Recovery } from './recovery';
import { ElementIndex, elementXY, nearestNode, nodesOnSegment, type PlateMesh } from './mesh';

export type NumPlateSupport =
  /** Along a line: an outline edge or a wall. */
  | { id: string; kind: 'line'; a: Pt; b: Pt; fix: 'simple' | 'clamped' | 'spring'; k?: number; kr?: number }
  /** At a point: rigid, or a spring k (N/m). */
  | { id: string; kind: 'point'; at: Pt; k?: number }
  /** Under a polygon: an elastic bedding of modulus c (N/m³), a column head. */
  | { id: string; kind: 'area'; polygon: Pt[]; c: number };

export type NumPlateLoad =
  /** A pressure q (N/m², downwards) over the plate, or over a polygon of it (a patch). */
  | { id: string; case: string; type: 'area'; q: number; polygon?: Pt[] }
  /** A line load q (N/m) from a to b. */
  | { id: string; case: string; type: 'line'; q: number; a: Pt; b: Pt }
  /** A point force F (N, downwards). */
  | { id: string; case: string; type: 'point'; F: number; at: Pt };

export interface NumPlate {
  mesh: PlateMesh;
  E: number;
  nu: number;
  t: number;
  supports: NumPlateSupport[];
  loads: NumPlateLoad[];
  /** Load case ids, in order (each solved on its own). */
  cases: string[];
  /** Lines across which the shear forces jump (walls, line loads): no smoothing across them. */
  jumps?: [Pt, Pt][];
}

/** Results of one load case (or a combination of them: they add up). */
export interface PlateFields {
  /** Per node: deflection (m, down) and rotations βx, βy (βx ≈ −∂w/∂x). */
  w: Float64Array;
  bx: Float64Array;
  by: Float64Array;
  /** Per element corner (4 per element): moments (N·m/m) and shear forces (N/m). */
  mx: Float64Array;
  my: Float64Array;
  mxy: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  /** Reaction per node, upwards (N): rigid supports, springs and bedding. */
  R: Float64Array;
  /** Total reaction of each support (N, upwards), in the order of the supports. */
  support: Float64Array;
  /** Total load (N, downwards). */
  load: number;
}

/** Where each support acts in the mesh. */
export interface SupportNodes {
  id: string;
  /** Nodes it holds (line: sorted along it) and their share of the line (m), for reactions per length. */
  nodes: number[];
  trib?: number[];
  /** Line supports: the ends are corners shared with another support (their reactions are corner forces). */
  length?: number;
}

export interface PlateSolution {
  mesh: PlateMesh;
  rig: PlateRigidity;
  supports: SupportNodes[];
  cases: PlateFields[];
  unknowns: number;
  /** Assembly, factorisation and solution, ms. */
  millis: number;
}

export class PlateError extends Error {}

/** Supports meeting at less than this (sin 20°) are one smooth line. */
const SMOOTH = Math.sin((20 * Math.PI) / 180);

export function solvePlate(p: NumPlate): PlateSolution {
  const t0 = performance.now();
  const { mesh } = p;
  const nn = mesh.x.length, ne = mesh.quads.length / 4;
  const rig = rigidity(p.E, p.nu, p.t);
  const span = Math.hypot(Math.max(...mesh.x) - Math.min(...mesh.x), Math.max(...mesh.y) - Math.min(...mesh.y));
  const tol = 1e-7 * span;

  // ------------------------------------------------------------ supports on the mesh
  const wFixed = new Uint8Array(nn), rotFixed = new Uint8Array(nn);
  const tangents: Pt[][] = Array.from({ length: nn }, () => []);
  const owner = new Int32Array(nn).fill(-1);
  /** Springs as small matrices on their nodes (3 DOFs each), global rotations. */
  const springs: { nodes: number[]; K: Float64Array; s: number }[] = [];
  const supportNodes: SupportNodes[] = [];
  const bedded: { e: number; c: number; s: number }[] = [];
  const lines: SupportData['lines'] = [];
  p.supports.forEach((s, si) => {
    if (s.kind === 'line') {
      const on = nodesOnSegment(mesh, s.a, s.b, tol);
      const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
      if (on.length < 2) throw new PlateError(`A support line (${fmtPt(s.a)} – ${fmtPt(s.b)}) is not on the plate`);
      const sx = (s.b[0] - s.a[0]) / L, sy = (s.b[1] - s.a[1]) / L;
      // shares of the line between the nodes (along the curve where they sit on one)
      const gap = on.map((q, i) => (i + 1 < on.length ? Math.hypot(mesh.x[on[i + 1].node] - mesh.x[q.node], mesh.y[on[i + 1].node] - mesh.y[q.node]) : 0));
      const trib = on.map((_, i) => ((i > 0 ? gap[i - 1] : 0) + gap[i]) / 2);
      // the direction of the line at each node: the curve's on a curved run
      const tan = on.map(({ node: q }): Pt => (mesh.tangent && (mesh.tangent[2 * q] || mesh.tangent[2 * q + 1]) ? [mesh.tangent[2 * q], mesh.tangent[2 * q + 1]] : [sx, sy]));
      supportNodes.push({ id: s.id, nodes: on.map((q) => q.node), trib, length: L });
      if (s.fix === 'spring') {
        // k ∫ N_i N_j ds on w, k_r ∫ N_i N_j ds (n nᵀ) on the rotations about the line
        const nrm = [sy, -sx];
        for (let i = 0; i + 1 < on.length; i++) {
          const l = gap[i], Ks = new Float64Array(36);
          for (const [r, c, f] of [[0, 0, 2], [1, 1, 2], [0, 1, 1], [1, 0, 1]]) {
            Ks[6 * 3 * r + 3 * c] = ((s.k ?? 0) * l * f) / 6;
            for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) Ks[6 * (3 * r + 1 + a) + 3 * c + 1 + b] = ((s.kr ?? 0) * l * f * nrm[a] * nrm[b]) / 6;
          }
          springs.push({ nodes: [on[i].node, on[i + 1].node], K: Ks, s: si });
        }
        for (const q of on) if (owner[q.node] < 0 && !wFixed[q.node]) owner[q.node] = si;
        return;
      }
      lines.push({ si, nodes: on.map((q) => q.node), trib, s: tan, clamped: s.fix === 'clamped' });
      on.forEach((q, i) => {
        if (!wFixed[q.node]) owner[q.node] = si;
        wFixed[q.node] = 1;
        if (s.fix === 'clamped') rotFixed[q.node] = 1;
        else tangents[q.node].push(tan[i]);
      });
    } else if (s.kind === 'point') {
      const { node, d } = nearestNode(mesh, s.at);
      if (d > tol * 10) throw new PlateError(`The point support at ${fmtPt(s.at)} is not on the plate`);
      supportNodes.push({ id: s.id, nodes: [node] });
      if (s.k) springs.push({ nodes: [node], K: Float64Array.from([s.k, 0, 0, 0, 0, 0, 0, 0, 0]), s: si });
      else wFixed[node] = 1;
      // a point support takes its node over from a line through it
      owner[node] = si;
    } else {
      const els: number[] = [];
      for (let e = 0; e < ne; e++) {
        const c = centroid(mesh, e);
        if (insidePolygon(c[0], c[1], s.polygon)) els.push(e);
      }
      if (!els.length) throw new PlateError(`A column head (${fmtPt(s.polygon[0])} …) holds no element: make the elements smaller`);
      const nodes = new Set<number>();
      for (const e of els) {
        bedded.push({ e, c: s.c, s: si });
        for (let k = 0; k < 4; k++) nodes.add(mesh.quads[4 * e + k]);
      }
      supportNodes.push({ id: s.id, nodes: [...nodes] });
    }
  });
  if (!p.supports.length) throw new PlateError('The plate has no supports');

  // rotations: a node on one straight support keeps the rotation across it, a corner of two
  // or a clamp fixes both; supports meeting at less than 20° (a polygon standing for a curved
  // edge) count as one with their mean direction, since fixing both rotations at every vertex
  // of a polygon makes a circle clamped as the polygon gets finer (Babuška's paradox)
  const turn: (Pt | null)[] = new Array(nn).fill(null);
  for (let i = 0; i < nn; i++) {
    if (rotFixed[i] || !tangents[i].length) continue;
    const s0 = tangents[i][0];
    let sx = 0, sy = 0, smooth = true;
    for (const s of tangents[i]) {
      if (Math.abs(s[0] * s0[1] - s[1] * s0[0]) > SMOOTH) smooth = false;
      const sign = s[0] * s0[0] + s[1] * s0[1] < 0 ? -1 : 1;
      sx += sign * s[0];
      sy += sign * s[1];
    }
    if (smooth) turn[i] = [sx / Math.hypot(sx, sy), sy / Math.hypot(sx, sy)];
    else rotFixed[i] = 1;
  }
  // numbering of the unknowns node by node in the order of least envelope: w, then β_n, β_s (turned nodes) or βx, βy
  const eq = new Int32Array(3 * nn).fill(-1);
  let n = 0;
  const graph = nodeGraph(nn, mesh.quads);
  for (const i of nodeOrder(graph, mesh.x, mesh.y)) {
    if (!wFixed[i]) eq[3 * i] = n++;
    if (rotFixed[i]) continue;
    eq[3 * i + 1] = n++;
    if (!turn[i]) eq[3 * i + 2] = n++;
  }
  if (!n) throw new PlateError('Every node is held: nothing to solve');

  // ------------------------------------------------------------ stiffness
  // the envelope: each row from the first unknown of any node sharing an element with its node
  const firstOf = (q: number) => (eq[3 * q] >= 0 ? eq[3 * q] : eq[3 * q + 1] >= 0 ? eq[3 * q + 1] : eq[3 * q + 2]);
  const first = new Int32Array(n);
  for (let q = 0; q < nn; q++) {
    let f = firstOf(q);
    if (f < 0) continue;
    for (const r of graph[q]) {
      const g = firstOf(r);
      if (g >= 0 && g < f) f = g;
    }
    for (let c = 0; c < 3; c++) if (eq[3 * q + c] >= 0) first[eq[3 * q + c]] = Math.min(f, eq[3 * q + c]);
  }
  const K = new EnvelopeMatrix(first);
  const T = (i: number): number[] | null => {
    const s = turn[i];
    // global (βx, βy) = n β_n + s β_s, n = (s_y, −s_x)
    return s ? [s[1], s[0], -s[0], s[1]] : null;
  };
  // elements of the same shape (most of a grid) share their matrices
  const elemK: Float64Array[] = new Array(ne), elemS: Float64Array[] = new Array(ne);
  const byShape = new Map<string, [Float64Array, Float64Array]>();
  const nodes4 = (e: number) => [mesh.quads[4 * e], mesh.quads[4 * e + 1], mesh.quads[4 * e + 2], mesh.quads[4 * e + 3]];
  const scatter = (ns: number[], Ke: Float64Array) => {
    const m = 3 * ns.length;
    const dof = ns.flatMap((q) => [3 * q, 3 * q + 1, 3 * q + 2]);
    const Kt = rotate(ns, Ke, T);
    for (let r = 0; r < m; r++) {
      const er = eq[dof[r]];
      if (er < 0) continue;
      for (let c = 0; c < m; c++) {
        const ec = eq[dof[c]];
        if (ec >= 0 && ec <= er) K.add(er, ec, Kt[m * r + c]);
      }
    }
  };
  for (let e = 0; e < ne; e++) {
    const xy = elementXY(mesh, e);
    const key = [2, 3, 4, 5, 6, 7].map((k) => Math.round((xy[k] - xy[k % 2]) / tol)).join(',');
    let km = byShape.get(key);
    if (!km) byShape.set(key, (km = [mitc4Stiffness(xy, rig), centreOperator(xy, rig)]));
    [elemK[e], elemS[e]] = km;
    scatter(nodes4(e), elemK[e]);
  }
  const bedK = bedded.map(({ e, c }) => beddingStiffness(elementXY(mesh, e), c));
  bedded.forEach(({ e }, i) => scatter(nodes4(e), bedK[i]));
  // springs act on w and the global rotations: turned like an element's
  for (const sp of springs) scatter(sp.nodes, sp.K);

  const fail = { row: -1 };
  const ch = envelopeCholesky(K, fail);
  if (!ch) {
    const node = eq.findIndex((q) => q === fail.row);
    const at = node >= 0 ? Math.floor(node / 3) : 0;
    throw new PlateError(`The plate is not held enough: it can move near (${fmtPt([mesh.x[at], mesh.y[at]])}) — add supports`);
  }

  // ------------------------------------------------------------ loads and solutions
  const index = new ElementIndex(mesh);
  const recovery = buildRecovery(mesh, p.jumps ?? []);
  const cases = p.cases.map((cid) => {
    const F = new Float64Array(3 * nn);
    for (const l of p.loads) if (l.case === cid) addLoad(F, l, mesh, index, tol);
    const b = new Float64Array(n);
    for (let i = 0; i < nn; i++) {
      const tr = T(i);
      const fw = F[3 * i], fx = F[3 * i + 1], fy = F[3 * i + 2];
      if (eq[3 * i] >= 0) b[eq[3 * i]] += fw;
      const fr = tr ? [tr[0] * fx + tr[2] * fy, tr[1] * fx + tr[3] * fy] : [fx, fy];
      if (eq[3 * i + 1] >= 0) b[eq[3 * i + 1]] += fr[0];
      if (eq[3 * i + 2] >= 0) b[eq[3 * i + 2]] += fr[1];
    }
    const x = envelopeSolve(ch, b);
    const u = new Float64Array(3 * nn);
    for (let i = 0; i < nn; i++) {
      u[3 * i] = eq[3 * i] >= 0 ? x[eq[3 * i]] : 0;
      const r1 = eq[3 * i + 1] >= 0 ? x[eq[3 * i + 1]] : 0, r2 = eq[3 * i + 2] >= 0 ? x[eq[3 * i + 2]] : 0;
      const tr = T(i);
      // back to global: β = n β_n + s β_s
      u[3 * i + 1] = tr ? tr[0] * r1 + tr[1] * r2 : r1;
      u[3 * i + 2] = tr ? tr[2] * r1 + tr[3] * r2 : r2;
    }
    return fields(mesh, rig, elemK, elemS, u, F, { wFixed, owner, springs, bedded, bedK, lines, recovery, kinds: p.supports.map((q) => q.kind) }, p.supports.length);
  });
  return { mesh, rig, supports: supportNodes, cases, unknowns: n, millis: performance.now() - t0 };
}

const fmtPt = (p: Pt) => `${+p[0].toFixed(3)}, ${+p[1].toFixed(3)}`;

export function centroid(m: PlateMesh, e: number): Pt {
  let x = 0, y = 0;
  for (let k = 0; k < 4; k++) {
    x += m.x[m.quads[4 * e + k]];
    y += m.y[m.quads[4 * e + k]];
  }
  return [x / 4, y / 4];
}

/** Tᵀ K T for an element matrix on nodes ns (3 DOFs each), T turning the rotations of some nodes. */
function rotate(ns: number[], Ke: Float64Array, T: (i: number) => number[] | null): Float64Array {
  const ts = ns.map(T);
  if (ts.every((t) => !t)) return Ke;
  const m = 3 * ns.length;
  // K T: columns of each turned node
  const KT = Float64Array.from(Ke);
  ts.forEach((t, a) => {
    if (!t) return;
    const c1 = 3 * a + 1, c2 = 3 * a + 2;
    for (let r = 0; r < m; r++) {
      const k1 = Ke[m * r + c1], k2 = Ke[m * r + c2];
      KT[m * r + c1] = k1 * t[0] + k2 * t[2];
      KT[m * r + c2] = k1 * t[1] + k2 * t[3];
    }
  });
  // Tᵀ (K T): rows
  const out = Float64Array.from(KT);
  ts.forEach((t, a) => {
    if (!t) return;
    const r1 = 3 * a + 1, r2 = 3 * a + 2;
    for (let c = 0; c < m; c++) {
      const k1 = KT[m * r1 + c], k2 = KT[m * r2 + c];
      out[m * r1 + c] = t[0] * k1 + t[2] * k2;
      out[m * r2 + c] = t[1] * k1 + t[3] * k2;
    }
  });
  return out;
}

// ---------------------------------------------------------------- loads

/** Gauss–Legendre points on [0, 1]. */
const GL3: [number, number][] = [[0.5 - Math.sqrt(15) / 10, 5 / 18], [0.5, 8 / 18], [0.5 + Math.sqrt(15) / 10, 5 / 18]];
/** Dunavant's 7-point rule on a triangle (degree 5): barycentric (a, b, b) orbits and weights. */
const TRI7: [number, number, number, number][] = (() => {
  const out: [number, number, number, number][] = [[1 / 3, 1 / 3, 1 / 3, 0.225]];
  const a1 = 0.059715871789770, b1 = 0.470142064105115, w1 = 0.132394152788506;
  const a2 = 0.797426985353087, b2 = 0.101286507323456, w2 = 0.125939180544827;
  for (const [a, b, w] of [[a1, b1, w1], [a2, b2, w2]]) out.push([a, b, b, w], [b, a, b, w], [b, b, a, w]);
  return out;
})();

/** Add ∫ N_i q over the part of each element inside a convex polygon (or all of it) to F. */
function addLoad(F: Float64Array, l: NumPlateLoad, m: PlateMesh, index: ElementIndex, tol: number) {
  const ne = m.quads.length / 4;
  const addAt = (e: number, x: number, y: number, f: number) => {
    const xy = elementXY(m, e);
    const nat = inverseMap(xy, x, y);
    if (!nat) return false;
    const N = shape(nat[0], nat[1]);
    for (let k = 0; k < 4; k++) F[3 * m.quads[4 * e + k]] += N[k] * f;
    return true;
  };
  if (l.type === 'area') {
    if (!l.polygon) {
      for (let e = 0; e < ne; e++) {
        const f = pressureLoad(elementXY(m, e), l.q);
        for (let k = 0; k < 4; k++) F[3 * m.quads[4 * e + k]] += f[3 * k];
      }
      return;
    }
    const poly = l.polygon;
    const bx0 = Math.min(...poly.map((q) => q[0])), bx1 = Math.max(...poly.map((q) => q[0]));
    const by0 = Math.min(...poly.map((q) => q[1])), by1 = Math.max(...poly.map((q) => q[1]));
    let covered = 0;
    for (const e of index.inBox(bx0, by0, bx1, by1)) {
      const xy = elementXY(m, e);
      const quad: Pt[] = [0, 1, 2, 3].map((k) => [xy[2 * k], xy[2 * k + 1]]);
      const part = clipPolygon(quad, poly);
      if (part.length < 3) continue;
      const area = polyArea(part), full = polyArea(quad);
      if (area <= 1e-12 * full) continue;
      covered += area;
      if (area >= full * (1 - 1e-9)) {
        const f = pressureLoad(xy, l.q);
        for (let k = 0; k < 4; k++) F[3 * m.quads[4 * e + k]] += f[3 * k];
        continue;
      }
      // the covered part, fanned into triangles, each by a degree-5 rule
      for (let k = 1; k + 1 < part.length; k++) {
        const [a, b, c] = [part[0], part[k], part[k + 1]];
        const A = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
        for (const [la, lb, lc, w] of TRI7) addAt(e, la * a[0] + lb * b[0] + lc * c[0], la * a[1] + lb * b[1] + lc * c[1], l.q * A * w);
      }
    }
    // a patch wholly off the plate (or in an opening) is a mistake, not a load of nothing
    if (!(covered > 0)) throw new PlateError(`The patch load at ${fmtPt(poly[0])} – ${fmtPt(poly[2] ?? poly[1])} is not on the plate`);
    return;
  }
  if (l.type === 'point') {
    for (const e of index.candidates(l.at[0], l.at[1])) {
      const nat = inverseMap(elementXY(m, e), l.at[0], l.at[1]);
      if (nat && Math.abs(nat[0]) <= 1 + 1e-9 && Math.abs(nat[1]) <= 1 + 1e-9) {
        addAt(e, l.at[0], l.at[1], l.F);
        return;
      }
    }
    throw new PlateError(`The point load at ${fmtPt(l.at)} is not on the plate`);
  }
  // a line load: the stretch inside each element, each stretch once (one on a shared edge goes to one element)
  const { a, b } = l;
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!(L > 0)) return;
  const pieces: { e: number; s0: number; s1: number }[] = [];
  for (const e of index.inBox(Math.min(a[0], b[0]) - tol, Math.min(a[1], b[1]) - tol, Math.max(a[0], b[0]) + tol, Math.max(a[1], b[1]) + tol)) {
    const xy = elementXY(m, e);
    const c = clipSegment(a, b, [0, 1, 2, 3].map((k) => [xy[2 * k], xy[2 * k + 1]] as Pt), tol / L);
    if (c && (c[1] - c[0]) * L > tol) pieces.push({ e, s0: c[0], s1: c[1] });
  }
  if (!pieces.length) throw new PlateError(`The line load ${fmtPt(a)} – ${fmtPt(b)} is not on the plate`);
  pieces.sort((p, q) => p.s0 - q.s0);
  let done = 0;
  for (const pc of pieces) {
    const s0 = Math.max(pc.s0, done), s1 = pc.s1;
    if ((s1 - s0) * L <= tol) continue;
    for (const [g, w] of GL3) {
      const s = s0 + (s1 - s0) * g;
      addAt(pc.e, a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, l.q * (s1 - s0) * L * w);
    }
    done = Math.max(done, s1);
  }
}

function polyArea(p: Pt[]): number {
  let s = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += p[j][0] * p[i][1] - p[i][0] * p[j][1];
  return Math.abs(s) / 2;
}

/** Sutherland–Hodgman: the subject polygon clipped to a convex clip polygon (either orientation). */
export function clipPolygon(subject: Pt[], clip: Pt[]): Pt[] {
  let out = subject;
  const sgn = Math.sign(clip.reduce((s, p, i) => {
    const q = clip[(i + 1) % clip.length];
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0)) || 1;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const side = (p: Pt) => sgn * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
    const input = out;
    out = [];
    for (let k = 0; k < input.length; k++) {
      const p = input[k], q = input[(k + 1) % input.length];
      const sp = side(p), sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return out;
}

/** The parameters (0 … 1) of the part of segment a–b inside a convex counter-clockwise polygon, or null. */
function clipSegment(a: Pt, b: Pt, poly: Pt[], eps: number): [number, number] | null {
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    // inside: (q − p) × (x − p) ≥ 0
    const ex = q[0] - p[0], ey = q[1] - p[1], len = Math.hypot(ex, ey);
    const f0 = (ex * (a[1] - p[1]) - ey * (a[0] - p[0])) / len + eps * Math.hypot(dx, dy);
    const df = (ex * dy - ey * dx) / len;
    if (Math.abs(df) < 1e-15) {
      if (f0 < 0) return null;
      continue;
    }
    const t = -f0 / df;
    if (df > 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

// ---------------------------------------------------------------- results

interface SupportData {
  wFixed: Uint8Array;
  owner: Int32Array;
  springs: { nodes: number[]; K: Float64Array; s: number }[];
  bedded: { e: number; c: number; s: number }[];
  bedK: Float64Array[];
  kinds: NumPlateSupport['kind'][];
  /** Rigid line supports: their nodes along them, shares of the line and its direction at each. */
  lines: { si: number; nodes: number[]; trib: number[]; s: Pt[]; clamped: boolean }[];
  recovery: Recovery;
}

function fields(m: PlateMesh, rig: PlateRigidity, elemK: Float64Array[], elemS: Float64Array[], u: Float64Array, F: Float64Array, s: SupportData, nSupports: number): PlateFields {
  const nn = m.x.length, ne = m.quads.length / 4;
  const w = new Float64Array(nn), bx = new Float64Array(nn), by = new Float64Array(nn);
  for (let i = 0; i < nn; i++) {
    w[i] = u[3 * i];
    bx[i] = u[3 * i + 1];
    by[i] = u[3 * i + 2];
  }
  // internal forces of the plate elements, and their moments at the centres
  const fint = new Float64Array(3 * nn);
  const centres = new Float64Array(3 * ne);
  const ue = new Float64Array(12);
  const gather = (e: number, out: Float64Array) => {
    for (let k = 0; k < 4; k++) for (let c = 0; c < 3; c++) out[3 * k + c] = u[3 * m.quads[4 * e + k] + c];
  };
  for (let e = 0; e < ne; e++) {
    gather(e, ue);
    const Ke = elemK[e], Se = elemS[e];
    for (let r = 0; r < 12; r++) {
      let sum = 0;
      for (let c = 0; c < 12; c++) sum += Ke[12 * r + c] * ue[c];
      fint[3 * m.quads[4 * e + Math.floor(r / 3)] + (r % 3)] += sum;
    }
    for (let r = 0; r < 3; r++) {
      let sum = 0;
      for (let c = 0; c < 12; c++) sum += Se[12 * r + c] * ue[c];
      centres[3 * e + r] = sum;
    }
  }
  const { mx, my, mxy, vx, vy } = recover(m, s.recovery, centres, (corner) => {
    const e = Math.floor(corner / 4), k = corner % 4, ux = new Float64Array(12);
    gather(e, ux);
    return extrapolatedMoments(elementXY(m, e), rig, ux).subarray(3 * k, 3 * k + 3);
  });

  // reactions, upwards: F − f_int at held w, k w at springs and under the bedding
  const R = new Float64Array(nn), support = new Float64Array(nSupports);
  for (let i = 0; i < nn; i++) {
    if (!s.wFixed[i]) continue;
    R[i] = F[3 * i] - fint[3 * i];
  }
  // a hard support also holds the twisting couples g along it (the generalized force of
  // β_s): Kelvin–Tait turns them into forces dg/ds along the line and ∓g at its ends, so
  // the reactions per length are Kirchhoff's V_n = q_n + ∂m_ns/∂s with the corner forces.
  // Their sum along each line is nil. A clamped line holds both rotations, so its couples
  // are bending moments too; Kirchhoff's m_ns vanishes along it (V_n = q_n there) and at a
  // corner where a simple line meets it, so only simple lines convert theirs, and none at
  // a clamped node (splitting a corner's couple there gave one edge the other's bending
  // moment: an L's clamped edges took 55, 69 and 32 kN of 187 kN as the mesh was refined).
  const through = new Map<number, number[]>(), simple = new Map<number, number[]>(), clamped = new Set<number>();
  s.lines.forEach((l, li) => l.nodes.forEach((q) => {
    through.set(q, [...(through.get(q) ?? []), li]);
    if (l.clamped) clamped.add(q);
    else simple.set(q, [...(simple.get(q) ?? []), li]);
  }));
  const dirAt = (li: number, q: number) => s.lines[li].s[s.lines[li].nodes.indexOf(q)];
  const couple = (li: number, q: number): number => {
    // the support's couple on the plate, split between the lines through the node: C = Σ λ_j s_j
    // at a corner of two, an equal share each along a smooth (or straight) run
    if (clamped.has(q)) return 0;
    const cx = -fint[3 * q + 1], cy = -fint[3 * q + 2];
    const ls = simple.get(q)!;
    const own = dirAt(li, q);
    if (ls.length === 2) {
      const other = dirAt(ls[0] === li ? ls[1] : ls[0], q);
      const det = own[0] * other[1] - own[1] * other[0];
      if (Math.abs(det) > SMOOTH) return (cx * other[1] - cy * other[0]) / det;
    }
    return (cx * own[0] + cy * own[1]) / ls.length;
  };
  for (const [li, l] of s.lines.entries()) {
    if (l.clamped) continue;
    const g = l.nodes.map((q, k) => couple(li, q) / l.trib[k]);
    const last = g.length - 1;
    l.nodes.forEach((q, k) => {
      // upwards: ½ (g_{k+1} − g_{k−1}) inside, ½ (g₁ + g₀) and −½ (g_N + g_{N−1}) at the ends
      R[q] += k === 0 ? (g[1] + g[0]) / 2 : k === last ? -(g[last] + g[last - 1]) / 2 : (g[k + 1] - g[k - 1]) / 2;
    });
  }
  // the totals: a corner of two lines gives each half; a column standing on a line takes its node
  const column = (q: number) => s.owner[q] >= 0 && s.kinds[s.owner[q]] === 'point';
  for (let i = 0; i < nn; i++) if (s.wFixed[i] && column(i)) support[s.owner[i]] += R[i];
  for (const l of s.lines) for (const q of l.nodes) if (!column(q)) support[l.si] += R[q] / through.get(q)!.length;
  // a spring's force on its w DOFs (rotational springs give moments, not reactions)
  for (const sp of s.springs) {
    const m3 = 3 * sp.nodes.length;
    sp.nodes.forEach((a, r) => {
      let f = 0;
      for (let c = 0; c < m3; c++) f += sp.K[m3 * 3 * r + c] * u[3 * sp.nodes[Math.floor(c / 3)] + (c % 3)];
      R[a] += f;
      support[sp.s] += f;
    });
  }
  s.bedded.forEach(({ e, s: si }, k) => {
    const Kb = s.bedK[k];
    for (let r = 0; r < 4; r++) {
      let f = 0;
      for (let c = 0; c < 4; c++) f += Kb[12 * 3 * r + 3 * c] * u[3 * m.quads[4 * e + c]];
      R[m.quads[4 * e + r]] += f;
      support[si] += f;
    }
  });
  let load = 0;
  for (let i = 0; i < nn; i++) load += F[3 * i];
  return { w, bx, by, mx, my, mxy, vx, vy, R, support, load };
}

/**
 * The reactions of a line support per length at its nodes, and the forces at its two
 * ends (the corner forces where another support meets it). The nodal reactions of an
 * irregular mesh alternate from node to node (a triangle's vertex and an edge's midpoint
 * gather different shares); a [¼ ½ ¼] filter along the line cancels that alternation and
 * is second-order exact for a smooth distribution.
 */
export function lineReactions(sol: PlateSolution, f: PlateFields, support: number): { s: number[]; r: number[]; ends: [number, number] } {
  const sn = sol.supports[support], { mesh } = sol;
  const n = sn.nodes.length, trib = sn.trib ?? [];
  const s = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(mesh.x[sn.nodes[i]] - mesh.x[sn.nodes[i - 1]], mesh.y[sn.nodes[i]] - mesh.y[sn.nodes[i - 1]]));
  const raw = sn.nodes.map((q, i) => f.R[q] / (trib[i] || 1));
  if (n < 4) return { s, r: raw, ends: [f.R[sn.nodes[0]], f.R[sn.nodes[n - 1]]] };
  const r = raw.map((_, i) => {
    if (i === 0 || i === n - 1) return NaN;
    if (i === 1 || i === n - 2) return (raw[i] + raw[i === 1 ? 2 : n - 3]) / 2;
    return raw[i - 1] / 4 + raw[i] / 2 + raw[i + 1] / 4;
  });
  r[0] = r[1];
  r[n - 1] = r[n - 2];
  return { s, r, ends: [f.R[sn.nodes[0]], f.R[sn.nodes[n - 1]]] };
}

/** Σ factor × fields: a load combination (everything here is linear in the loads). */
export function combineFields(list: PlateFields[], factors: number[]): PlateFields {
  const f0 = list[0];
  const sum = (key: 'w' | 'bx' | 'by' | 'mx' | 'my' | 'mxy' | 'vx' | 'vy' | 'R' | 'support') => {
    const out = new Float64Array(f0[key].length);
    list.forEach((f, i) => {
      const a = factors[i];
      if (!a) return;
      const src = f[key];
      for (let k = 0; k < out.length; k++) out[k] += a * src[k];
    });
    return out;
  };
  return {
    w: sum('w'), bx: sum('bx'), by: sum('by'), mx: sum('mx'), my: sum('my'), mxy: sum('mxy'), vx: sum('vx'), vy: sum('vy'),
    R: sum('R'), support: sum('support'), load: list.reduce((s, f, i) => s + f.load * factors[i], 0),
  };
}
