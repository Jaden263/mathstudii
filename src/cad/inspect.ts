// Inspection helpers that need no kernel: section planes moved into a component, the cut
// faces of a section, and distances measured on display data (the mesh kernel's
// approximation; the B-rep kernel measures exactly, occ/query.ts).
import type { BodyResult, BuildResult } from './buildResult';
import type { CadDesign } from './design';
import { m4Point, type M4, type Vec3 } from './solid';

/** A section plane: what lies on the normal's side (n·x ≥ offset) is kept. */
export interface SectionPlane {
  n: Vec3;
  offset: number;
}

/** The plane in the coordinates of a component placed by M (rigid or mirroring). */
export function planeToLocal(M: M4, p: SectionPlane): SectionPlane {
  const { n } = p;
  // x_world = A x + t: n·(A x + t) ≥ offset  ⇔  (Aᵀ n)·x ≥ offset − n·t
  const nl: Vec3 = [M[0] * n[0] + M[1] * n[1] + M[2] * n[2], M[4] * n[0] + M[5] * n[1] + M[6] * n[2], M[8] * n[0] + M[9] * n[1] + M[10] * n[2]];
  const l = Math.hypot(nl[0], nl[1], nl[2]) || 1;
  return { n: [nl[0] / l, nl[1] / l, nl[2] / l], offset: (p.offset - (n[0] * M[12] + n[1] * M[13] + n[2] * M[14])) / l };
}

/** Faces of a sectioned body that lie in the section plane, facing the side cut away. */
export function capFaces(b: BodyResult, p: SectionPlane, size: number): number[] {
  const tol = Math.max(size, 1) * 1e-7;
  return b.faces.filter((f) => {
    if (f.type !== 'plane' || !f.frame) return false;
    const { n, o } = f.frame;
    return n[0] * p.n[0] + n[1] * p.n[1] + n[2] * p.n[2] < -1 + 1e-9 && Math.abs(o[0] * p.n[0] + o[1] * p.n[1] + o[2] * p.n[2] - p.offset) < tol;
  }).map((f) => f.index);
}

/** Something picked to measure: a face or edge of a body in an occurrence, or a point (assembly coordinates). */
export type EntityRef =
  | { kind: 'face' | 'edge'; occ: string; body: string; index: number }
  | { kind: 'point'; p: Vec3 };

export interface Distance {
  d: number;
  /** Closest points (assembly coordinates). */
  a: Vec3;
  b: Vec3;
  /** Computed on the exact surfaces (else on the display mesh). */
  exact: boolean;
}

/** The body an entity belongs to, with its placement. */
export function entityBody(build: BuildResult, design: CadDesign, r: EntityRef): { body: BodyResult; M: M4 } | null {
  if (r.kind === 'point') return null;
  const o = design.occurrences.find((q) => q.id === r.occ);
  const body = o && build.components[o.component]?.bodies.find((b) => b.id === r.body);
  const M = build.placements[r.occ]?.matrix;
  return body && M ? { body, M } : null;
}

/** Sample points of an entity in assembly coordinates: the mesh vertices of a face, the polyline of an edge. */
export function entityPoints(build: BuildResult, design: CadDesign, r: EntityRef): Vec3[] {
  if (r.kind === 'point') return [r.p];
  const hit = entityBody(build, design, r);
  if (!hit) return [];
  const { body, M } = hit;
  const out: Vec3[] = [];
  if (r.kind === 'edge') {
    const p = body.edges[r.index]?.points ?? new Float32Array(0);
    for (let i = 0; i + 2 < p.length; i += 3) out.push(m4Point(M, [p[i], p[i + 1], p[i + 2]]));
    return out;
  }
  const { positions: P, indices: I, faceOf } = body.mesh;
  const seen = new Set<number>();
  for (let t = 0; t < faceOf.length; t++) {
    if (faceOf[t] !== r.index) continue;
    for (let k = 0; k < 3; k++) {
      const v = I[3 * t + k];
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(m4Point(M, [P[3 * v], P[3 * v + 1], P[3 * v + 2]]));
    }
  }
  return out;
}

/**
 * Smallest distance between two entities over their sample points: the mesh kernel's
 * measure (exact for corners, within the facet size elsewhere).
 */
export function approxDistance(build: BuildResult, design: CadDesign, a: EntityRef, b: EntityRef): Distance | null {
  // every pair is compared: at most ~2000 points a side
  const thin = (ps: Vec3[]) => (ps.length > 2000 ? ps.filter((_, i) => i % Math.ceil(ps.length / 2000) === 0) : ps);
  const A = thin(entityPoints(build, design, a)), B = thin(entityPoints(build, design, b));
  if (!A.length || !B.length) return null;
  let best: Distance = { d: Infinity, a: A[0], b: B[0], exact: false };
  for (const p of A) for (const q of B) {
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    if (d < best.d) best = { d, a: p, b: q, exact: false };
  }
  return best;
}
