// The smallest distance between two placed triangle meshes, for the clearance of a motion
// frame by frame: a tree of boxes over each mesh's triangles, searched branch and bound
// (a node of the other mesh is boxed again where the placement puts it, so two flat parts
// stacked a millimetre apart are told apart by their boxes), and the exact distance between two
// triangles (Ericson, Real-Time Collision Detection, §5.1: closest points of segments and
// of a point and a triangle; triangles that cross are 0 apart). Overlapping meshes, and a
// mesh inside another, are 0 apart.
import { m4Inv, m4Mul, type M4, type Vec3 } from './solid';

interface Node {
  c: Vec3;
  r: number;
  min: Vec3;
  max: Vec3;
  /** Children, or the triangles of a leaf. */
  kids?: [Node, Node];
  tris?: number[];
}

export interface MeshTree {
  pos: Float32Array;
  idx: Uint32Array;
  root: Node | null;
  box: { min: Vec3; max: Vec3 } | null;
}

const LEAF = 4;

/** The sphere tree of a mesh (positions x, y, z …, triangles by vertex index). */
export function meshTree(pos: Float32Array, idx: Uint32Array): MeshTree {
  const n = Math.floor(idx.length / 3);
  const cen = new Float64Array(3 * n);
  for (let t = 0; t < n; t++) for (let d = 0; d < 3; d++) cen[3 * t + d] = (pos[3 * idx[3 * t] + d] + pos[3 * idx[3 * t + 1] + d] + pos[3 * idx[3 * t + 2] + d]) / 3;
  const boxOf = (tris: number[]) => {
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const t of tris) for (let k = 0; k < 3; k++) for (let d = 0; d < 3; d++) {
      const v = pos[3 * idx[3 * t + k] + d];
      if (v < min[d]) min[d] = v;
      if (v > max[d]) max[d] = v;
    }
    return { min, max };
  };
  const build = (tris: number[]): Node => {
    const b = boxOf(tris);
    const c: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    let r = 0;
    for (const t of tris) for (let k = 0; k < 3; k++) {
      const i = 3 * idx[3 * t + k];
      r = Math.max(r, Math.hypot(pos[i] - c[0], pos[i + 1] - c[1], pos[i + 2] - c[2]));
    }
    if (tris.length <= LEAF) return { c, r, min: b.min, max: b.max, tris };
    // split at the median of the centroids along the longest side
    const ext = [0, 1, 2].map((d) => b.max[d] - b.min[d]);
    const ax = ext.indexOf(Math.max(...ext));
    const sorted = [...tris].sort((p, q) => cen[3 * p + ax] - cen[3 * q + ax]);
    const h = sorted.length >> 1;
    return { c, r, min: b.min, max: b.max, kids: [build(sorted.slice(0, h)), build(sorted.slice(h))] };
  };
  const all = Array.from({ length: n }, (_, i) => i);
  return { pos, idx, root: n ? build(all) : null, box: n ? boxOf(all) : null };
}

// ------------------------------------------------------------ closest points

type P = [number, number, number];
const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: P, b: P) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: P, b: P): P => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Squared distance between segments p1q1 and p2q2 (Ericson §5.1.9). */
export function segmentDistance2(p1: P, q1: P, p2: P, q2: P): number {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s: number, t: number;
  if (a <= 1e-30 && e <= 1e-30) return dot(r, r);
  if (a <= 1e-30) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = dot(d1, r);
    if (e <= 1e-30) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den > 1e-30 * a * e ? clamp01((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const x = sub([p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s], [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t]);
  return dot(x, x);
}

/** Squared distance from p to triangle abc (Ericson §5.1.5, by its Voronoi regions). */
export function pointTriangleDistance2(p: P, a: P, b: P, c: P): number {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  const at = (q: P) => dot(sub(p, q), sub(p, q));
  if (d1 <= 0 && d2 <= 0) return at(a);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return at([a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]);
  }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return at([a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return at([b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]);
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return at([a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]);
}

/** Whether segment pq passes through triangle abc (Möller–Trumbore, t in [0, 1]). */
function segmentHitsTriangle(p: P, q: P, a: P, b: P, c: P): boolean {
  const d = sub(q, p), e1 = sub(b, a), e2 = sub(c, a);
  const h = cross(d, e2), det = dot(e1, h);
  if (Math.abs(det) < 1e-30) return false;
  const s = sub(p, a), u = dot(s, h) / det;
  if (u < 0 || u > 1) return false;
  const qv = cross(s, e1), v = dot(d, qv) / det;
  if (v < 0 || u + v > 1) return false;
  const t = dot(e2, qv) / det;
  return t >= 0 && t <= 1;
}

/** Squared distance between two triangles: 0 when they cross, else the least of edge–edge and vertex–face. */
export function triangleDistance2(A: [P, P, P], B: [P, P, P]): number {
  for (let i = 0; i < 3; i++) {
    if (segmentHitsTriangle(A[i], A[(i + 1) % 3], B[0], B[1], B[2])) return 0;
    if (segmentHitsTriangle(B[i], B[(i + 1) % 3], A[0], A[1], A[2])) return 0;
  }
  let best = Infinity;
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) best = Math.min(best, segmentDistance2(A[i], A[(i + 1) % 3], B[k], B[(k + 1) % 3]));
  for (let i = 0; i < 3; i++) best = Math.min(best, pointTriangleDistance2(A[i], B[0], B[1], B[2]), pointTriangleDistance2(B[i], A[0], A[1], A[2]));
  return best;
}

// ------------------------------------------------------------ meshes

const apply = (M: M4, x: number, y: number, z: number): P => [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]];

/** Whether p lies inside a closed mesh (a ray along +x crosses it an odd number of times). */
function inside(T: MeshTree, p: P): boolean {
  let n = 0;
  const far: P = [p[0] + 1e9, p[1] + 1.23e-7, p[2] + 2.71e-7];
  for (let t = 0; t < T.idx.length; t += 3) {
    const v = (k: number): P => [T.pos[3 * T.idx[t + k]], T.pos[3 * T.idx[t + k] + 1], T.pos[3 * T.idx[t + k] + 2]];
    if (segmentHitsTriangle(p, far, v(0), v(1), v(2))) n++;
  }
  return n % 2 === 1;
}

/**
 * The smallest distance between mesh A placed by MA and mesh B placed by MB (0 when they
 * cross or one holds the other), or Infinity when they are no closer than `cutoff`.
 */
export function meshDistance(A: MeshTree, MA: M4, B: MeshTree, MB: M4, cutoff = Infinity): number {
  if (!A.root || !B.root) return Infinity;
  // B in A's coordinates
  const R = m4Mul(m4Inv(MA), MB);
  const triA = (t: number): [P, P, P] => [0, 1, 2].map((k) => {
    const i = 3 * A.idx[3 * t + k];
    return [A.pos[i], A.pos[i + 1], A.pos[i + 2]] as P;
  }) as [P, P, P];
  const movedB = new Map<number, [P, P, P]>();
  const triB = (t: number): [P, P, P] => {
    let q = movedB.get(t);
    if (!q) movedB.set(t, (q = [0, 1, 2].map((k) => {
      const i = 3 * B.idx[3 * t + k];
      return apply(R, B.pos[i], B.pos[i + 1], B.pos[i + 2]);
    }) as [P, P, P]));
    return q;
  };
  // a node of B boxed again in A's coordinates (its corners placed), once per node
  const placed = new Map<Node, { c: P; min: P; max: P }>();
  const boxB = (b: Node) => {
    let q = placed.get(b);
    if (!q) {
      const min: P = [Infinity, Infinity, Infinity], max: P = [-Infinity, -Infinity, -Infinity];
      for (let c = 0; c < 8; c++) {
        const p = apply(R, c & 1 ? b.max[0] : b.min[0], c & 2 ? b.max[1] : b.min[1], c & 4 ? b.max[2] : b.min[2]);
        for (let i = 0; i < 3; i++) {
          if (p[i] < min[i]) min[i] = p[i];
          if (p[i] > max[i]) max[i] = p[i];
        }
      }
      placed.set(b, (q = { c: apply(R, b.c[0], b.c[1], b.c[2]), min, max }));
    }
    return q;
  };
  // squared, the larger of what the spheres and the boxes allow
  const lower2 = (a: Node, b: Node) => {
    const q = boxB(b);
    let g = 0;
    for (let k = 0; k < 3; k++) {
      const d = Math.max(0, a.min[k] - q.max[k], q.min[k] - a.max[k]);
      g += d * d;
    }
    const s = Math.hypot(a.c[0] - q.c[0], a.c[1] - q.c[1], a.c[2] - q.c[2]) - a.r - b.r;
    return s > 0 ? Math.max(g, s * s) : g;
  };
  let best2 = cutoff * cutoff;
  const visit = (a: Node, b: Node, lb2: number) => {
    // a pair that cannot come closer than the best so far (to a part in 10⁹) is left
    if (lb2 >= best2 * (1 - 2e-9) || best2 === 0) return;
    if (a.tris && b.tris) {
      for (const s of a.tris) {
        const ta = triA(s);
        for (const t of b.tris) best2 = Math.min(best2, triangleDistance2(ta, triB(t)));
      }
      return;
    }
    // open the bigger sphere, the nearer child first
    const split = !b.kids || (a.kids && a.r >= b.r);
    const [x, y] = split ? a.kids!.map((k) => [k, b] as const) : b.kids!.map((k) => [a, k] as const);
    const lx = lower2(x[0], x[1]), ly = lower2(y[0], y[1]);
    if (lx <= ly) {
      visit(x[0], x[1], lx);
      visit(y[0], y[1], ly);
    } else {
      visit(y[0], y[1], ly);
      visit(x[0], x[1], lx);
    }
  };
  visit(A.root, B.root, lower2(A.root, B.root));
  if (best2 > 0) {
    // apart by their surfaces, but where their boxes overlap one may hold the other
    const q = boxB(B.root);
    const overlap = [0, 1, 2].every((k) => A.root!.min[k] <= q.max[k] && q.min[k] <= A.root!.max[k]);
    if (overlap) {
      // a vertex of B in A's coordinates, and one of A in B's
      if (inside(A, apply(R, B.pos[0], B.pos[1], B.pos[2])) || inside(B, apply(m4Mul(m4Inv(MB), MA), A.pos[0], A.pos[1], A.pos[2]))) return 0;
    }
  }
  return best2 < cutoff * cutoff ? Math.sqrt(best2) : Infinity;
}
