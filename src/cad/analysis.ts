// Surface analyses of the Inspect tab, on a body's display data (BuildResult):
//
// - Draft: the angle between a face and the pull direction d of a mould, asin(n·d) for
//   the outward normal n: positive where the face looks along d (it parts that way),
//   negative where it looks against it, insufficient within ± the threshold of 0 (a wall
//   parallel to d would drag along the mould). Flat faces take their exact normal, curved
//   ones are coloured vertex by vertex.
// - Curvature: mean H = (κ1 + κ2)/2 and Gaussian K = κ1·κ2, positive where the surface
//   bends away from its outward normal (a shaft, a ball), negative where it bends towards
//   it (a hole); K < 0 at saddles. Exact from the surface where OCCT's type gives it in
//   closed form (planes, cylinders, cones, spheres, tori); estimated on the mesh for the
//   others, from the change of OCCT's exact vertex normals across each triangle
//   (Rusinkiewicz, "Estimating curvatures and their derivatives on triangle meshes", 2004).
import type { BodyMesh, BodyResult, FaceInfo } from './buildResult';
import { cross3, dot3, len3, norm3, sub3, type Vec3 } from './solid';

export type DraftClass = 'positive' | 'negative' | 'insufficient';

/** Draft angle (radians) of a surface with outward normal n against a pull direction (unit). */
export const draftAngle = (n: Vec3, pull: Vec3) => Math.asin(Math.max(-1, Math.min(1, dot3(norm3(n), pull))));

/** A draft angle against the least the mould needs (both radians). */
export function draftClass(angle: number, least: number): DraftClass {
  const tol = 1e-9;
  if (angle >= least - tol) return 'positive';
  if (angle <= -least + tol) return 'negative';
  return 'insufficient';
}

/** Colours (sRGB) of the draft classes, as in Fusion's draft analysis: green, red, and yellow for too little. */
export const DRAFT_COLOURS: Record<DraftClass, [number, number, number]> = {
  positive: [0.22, 0.68, 0.33],
  negative: [0.84, 0.23, 0.2],
  insufficient: [0.98, 0.8, 0.18],
};

/**
 * Per vertex colours of a body's mesh for a draft analysis, the pull direction given in
 * the body's own coordinates (unit). Flat faces take their exact normal.
 */
export function draftTint(b: BodyResult, pull: Vec3, least: number): Float32Array {
  const { normals, indices, faceOf } = b.mesh;
  const out = new Float32Array(normals.length);
  const flat = b.faces.map((f) => (f.type === 'plane' && f.frame ? DRAFT_COLOURS[draftClass(draftAngle(f.frame.n, pull), least)] : null));
  for (let t = 0; t < faceOf.length; t++) {
    const fixed = flat[faceOf[t]];
    for (let k = 0; k < 3; k++) {
      const v = indices[3 * t + k];
      const c = fixed ?? DRAFT_COLOURS[draftClass(draftAngle([normals[3 * v], normals[3 * v + 1], normals[3 * v + 2]], pull), least)];
      out.set(c, 3 * v);
    }
  }
  return out;
}

// ------------------------------------------------------------ curvature

/** Mean and Gaussian curvature at every vertex of a mesh: [H0, K0, H1, K1 …]. */
export type Curvatures = Float32Array;

/**
 * Curvatures of a face of a closed-form surface at a point p with outward normal n, or
 * null for surfaces without one (B-splines, offsets, swept surfaces).
 */
export function exactCurvature(f: FaceInfo, p: Vec3, n: Vec3): [number, number] | null {
  switch (f.type) {
    case 'plane':
      return [0, 0];
    case 'cylinder':
    case 'cone':
    case 'sphere':
    case 'torus': {
      if (!f.axis || f.radius === undefined) return null;
      const d = norm3(f.axis.d), w = sub3(p, f.axis.p);
      const radial = sub3(w, [d[0] * dot3(w, d), d[1] * dot3(w, d), d[2] * dot3(w, d)]);
      const rho = len3(radial);
      if (f.type === 'sphere') {
        // the centre is the axis point; the sign: the normal away from it (a ball) or towards it (a dimple)
        const s = Math.sign(dot3(n, w)) || 1;
        return [s / f.radius, 1 / (f.radius * f.radius)];
      }
      if (f.type === 'cylinder') {
        const s = Math.sign(dot3(n, radial)) || 1;
        return [s / (2 * f.radius), 0];
      }
      if (f.type === 'cone') {
        // around the cone: the circle of radius ρ seen at the half angle α, κ = cos α / ρ; along it 0
        if (f.angle === undefined || !(rho > 0)) return null;
        const s = Math.sign(dot3(n, radial)) || 1;
        return [(s * Math.cos(f.angle)) / (2 * rho), 0];
      }
      // a torus: κ1 = 1/r round the tube, κ2 = cos v / ρ round the axis (v from the outer equator)
      const r = f.minorRadius;
      if (r === undefined || !(rho > 0)) return null;
      const u = norm3(radial), h = dot3(w, d);
      const c: Vec3 = [f.axis.p[0] + d[0] * h + u[0] * f.radius, f.axis.p[1] + d[1] * h + u[1] * f.radius, f.axis.p[2] + d[2] * h + u[2] * f.radius];
      const cosv = (rho - f.radius) / r;
      const s = Math.sign(dot3(n, sub3(p, c))) || 1;
      const k1 = s / r, k2 = (s * cosv) / rho;
      return [(k1 + k2) / 2, k1 * k2];
    }
    default:
      return null;
  }
}

/**
 * Mean and Gaussian curvature at the vertices of one face's triangles, from the vertex
 * normals: each triangle's second fundamental form II solves II·(e·u, e·v) = (Δn·u, Δn·v)
 * over its three edges e (least squares), is carried into every corner's tangent frame
 * and averaged there weighted by the triangle's area.
 */
export function meshCurvature(m: BodyMesh, triangles: number[], out: Curvatures): void {
  const P = m.positions, N = m.normals, I = m.indices;
  const acc = new Map<number, [number, number, number, number]>();
  const pt = (v: number): Vec3 => [P[3 * v], P[3 * v + 1], P[3 * v + 2]];
  const nm = (v: number): Vec3 => [N[3 * v], N[3 * v + 1], N[3 * v + 2]];
  const frame = (n: Vec3): [Vec3, Vec3] => {
    const a: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = norm3(cross3(a, n));
    return [u, cross3(n, u)];
  };
  for (const t of triangles) {
    const vs = [I[3 * t], I[3 * t + 1], I[3 * t + 2]];
    const ps = vs.map(pt), ns = vs.map(nm);
    const fn = cross3(sub3(ps[1], ps[0]), sub3(ps[2], ps[0]));
    const area = len3(fn) / 2;
    if (!(area > 0)) continue;
    const [u, v] = frame(norm3(fn));
    // normal equations of the 6 × 3 system in (e, f, g)
    const A = [0, 0, 0, 0, 0, 0, 0, 0, 0], B = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const i = k, j = (k + 1) % 3;
      const e = sub3(ps[j], ps[i]), dn = sub3(ns[j], ns[i]);
      const eu = dot3(e, u), ev = dot3(e, v), nu = dot3(dn, u), nv = dot3(dn, v);
      // rows: [eu, ev, 0]·(e f g) = nu, [0, eu, ev]·(e f g) = nv
      const rows: [number[], number][] = [[[eu, ev, 0], nu], [[0, eu, ev], nv]];
      for (const [r, y] of rows) for (let a = 0; a < 3; a++) {
        B[a] += r[a] * y;
        for (let b = 0; b < 3; b++) A[3 * a + b] += r[a] * r[b];
      }
    }
    const sol = solve3(A, B);
    if (!sol) continue;
    const [e, f, g] = sol;
    // the tensor in 3-D: T = e·uuᵀ + f·(uvᵀ + vuᵀ) + g·vvᵀ, read in each corner's frame
    const T = (x: Vec3, y: Vec3) => e * dot3(x, u) * dot3(y, u) + f * (dot3(x, u) * dot3(y, v) + dot3(x, v) * dot3(y, u)) + g * dot3(x, v) * dot3(y, v);
    vs.forEach((vi, k) => {
      const [cu, cv] = frame(norm3(ns[k]));
      const a = acc.get(vi) ?? [0, 0, 0, 0];
      a[0] += area * T(cu, cu);
      a[1] += area * T(cu, cv);
      a[2] += area * T(cv, cv);
      a[3] += area;
      acc.set(vi, a);
    });
  }
  for (const [vi, [e, f, g, w]] of acc) {
    out[2 * vi] = (e + g) / (2 * w);
    out[2 * vi + 1] = (e * g - f * f) / (w * w);
  }
}

function solve3(A: number[], b: number[]): Vec3 | null {
  const det = (m: number[]) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const D = det(A);
  const scale = Math.abs(A[0] * A[4] * A[8]) + 1e-300;
  if (!(Math.abs(D) > 1e-12 * scale)) return null;
  const col = (k: number) => A.map((x, i) => (i % 3 === k ? b[(i / 3) | 0] : x));
  return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
}

const cached = new WeakMap<BodyResult, Curvatures>();

/** H and K at every vertex of a body: exact on closed-form faces, from the mesh on the others (made once per body). */
export function bodyCurvature(b: BodyResult): Curvatures {
  const hit = cached.get(b);
  if (hit) return hit;
  const m = b.mesh, out = new Float32Array((m.positions.length / 3) * 2);
  const byFace = new Map<number, number[]>();
  for (let t = 0; t < m.faceOf.length; t++) {
    const f = m.faceOf[t];
    if (!byFace.has(f)) byFace.set(f, []);
    byFace.get(f)!.push(t);
  }
  for (const [fi, tris] of byFace) {
    const face = b.faces[fi];
    const verts = new Set(tris.flatMap((t) => [m.indices[3 * t], m.indices[3 * t + 1], m.indices[3 * t + 2]]));
    let exact = !!face;
    for (const v of verts) {
      const hk = face && exactCurvature(face, [m.positions[3 * v], m.positions[3 * v + 1], m.positions[3 * v + 2]], [m.normals[3 * v], m.normals[3 * v + 1], m.normals[3 * v + 2]]);
      if (!hk) {
        exact = false;
        break;
      }
      out[2 * v] = hk[0];
      out[2 * v + 1] = hk[1];
    }
    if (!exact) meshCurvature(m, tris, out);
  }
  cached.set(b, out);
  return out;
}

/**
 * Diverging colours (sRGB) for a signed value against its range: blue where negative,
 * white at 0, red where positive (ColorBrewer RdBu, its ends clamped).
 */
export function divergingColour(x: number, range: number): [number, number, number] {
  const t = range > 0 ? Math.max(-1, Math.min(1, x / range)) : 0;
  const stops: [number, [number, number, number]][] = [
    [-1, [0.13, 0.4, 0.67]], [-0.5, [0.57, 0.77, 0.87]], [0, [0.97, 0.97, 0.97]], [0.5, [0.96, 0.65, 0.51]], [1, [0.7, 0.09, 0.17]],
  ];
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i];
    if (t <= t1) {
      const [t0, c0] = stops[i - 1];
      const k = (t - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k];
    }
  }
  return stops[stops.length - 1][1];
}

/** Per vertex colours of a body for its mean (`which` 0) or Gaussian (1) curvature against a range. */
export function curvatureTint(b: BodyResult, which: 0 | 1, range: number): Float32Array {
  const hk = bodyCurvature(b);
  const out = new Float32Array(b.mesh.positions.length);
  for (let v = 0; v < out.length / 3; v++) out.set(divergingColour(hk[2 * v + which], range), 3 * v);
  return out;
}

/**
 * A range that shows the bodies' curvature well: the 95th percentile of its magnitude
 * over their vertices (a few sharp roundings would otherwise wash everything out).
 */
export function curvatureRange(bodies: BodyResult[], which: 0 | 1): number {
  const all: number[] = [];
  for (const b of bodies) {
    const hk = bodyCurvature(b);
    for (let v = which; v < hk.length; v += 2) if (hk[v] !== 0) all.push(Math.abs(hk[v]));
  }
  if (!all.length) return 0;
  all.sort((a, b) => a - b);
  return all[Math.min(all.length - 1, Math.floor(0.95 * all.length))];
}
