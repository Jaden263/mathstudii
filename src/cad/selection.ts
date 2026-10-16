// Faces and edges picked in the 3-D view: the selection the inspector describes and the
// modify features (fillet, chamfer, shell, draft) will take. A pick names a face or edge
// of a body in an occurrence by its index in the body's tables, and remembers what finds
// it again after a rebuild renumbers them: the face's history key (edges: the keys of
// their two faces) and where it was.
import type { BodyResult, BuildResult, CurveKind, EdgeInfo, FaceInfo, SurfaceKind } from './buildResult';
import type { CadDesign } from './design';
import { cross3, dot3, len3, m4Dir, norm3, sub3, type M4, type Vec3 } from './solid';

export interface Pick {
  kind: 'face' | 'edge';
  occ: string;
  body: string;
  index: number;
  /** History key of the face (an edge: of its two faces), '' when unknown. */
  key: string;
  /** Where it was (component coordinates): the face centroid, the edge midpoint. */
  at: Vec3;
  type: SurfaceKind | CurveKind;
}

export type Selection = Pick[];

/** Identity of a face or edge in a build (picks, highlight sets). */
export const pickId = (p: { kind: 'face' | 'edge'; occ: string; body: string; index: number }) => `${p.kind === 'face' ? 'f' : 'e'}:${p.occ}:${p.body}:${p.index}`;

/** Point halfway along a polyline (by length). */
export function polylineMid(p: Float32Array): Vec3 {
  const n = p.length / 3;
  if (!n) return [0, 0, 0];
  let total = 0;
  for (let i = 1; i < n; i++) total += Math.hypot(p[3 * i] - p[3 * i - 3], p[3 * i + 1] - p[3 * i - 2], p[3 * i + 2] - p[3 * i - 1]);
  let left = total / 2;
  for (let i = 1; i < n; i++) {
    const l = Math.hypot(p[3 * i] - p[3 * i - 3], p[3 * i + 1] - p[3 * i - 2], p[3 * i + 2] - p[3 * i - 1]);
    if (l >= left && l > 0) {
      const t = left / l;
      return [0, 1, 2].map((k) => p[3 * i - 3 + k] + (p[3 * i + k] - p[3 * i - 3 + k]) * t) as Vec3;
    }
    left -= l;
  }
  return [p[0], p[1], p[2]];
}

/** The body of an occurrence in a build. */
export function bodyOf(build: BuildResult, design: CadDesign, occ: string, body: string): BodyResult | undefined {
  const o = design.occurrences.find((q) => q.id === occ);
  return o ? build.components[o.component]?.bodies.find((b) => b.id === body) : undefined;
}

/** A pick of face or edge `index` of a body, or null when there is none. */
export function pickOf(build: BuildResult, design: CadDesign, kind: 'face' | 'edge', occ: string, body: string, index: number): Pick | null {
  const b = bodyOf(build, design, occ, body);
  if (!b) return null;
  if (kind === 'face') {
    const f = b.faces[index];
    return f ? { kind, occ, body, index, key: f.key, at: f.c, type: f.type } : null;
  }
  const e = b.edges[index];
  return e ? { kind, occ, body, index, key: e.key, at: polylineMid(e.points), type: e.type } : null;
}

/** A click replaces the selection; with shift it adds the pick, or takes it out again. Nothing hit clears it (unless adding). */
export function select(sel: Selection, p: Pick | null, add: boolean): Selection {
  if (!p) return add ? sel : [];
  const id = pickId(p);
  if (!add) return sel.length === 1 && pickId(sel[0]) === id ? sel : [p];
  return sel.some((q) => pickId(q) === id) ? sel.filter((q) => pickId(q) !== id) : [...sel, p];
}

const dist = (a: Vec3, b: Vec3) => len3(sub3(a, b));

function boxSize(b: BodyResult): number {
  return b.box ? dist(b.box.min, b.box.max) : 1;
}

/**
 * The picks found again in a new build: the same key (the nearest when a boolean split the
 * face), else the nearest face or edge of the same type within 5 % of the body's size;
 * picks of bodies that are gone, or with nothing close enough, drop out.
 */
export function resolveSelection(sel: Selection, build: BuildResult, design: CadDesign): Selection {
  const out: Selection = [];
  for (const p of sel) {
    const b = bodyOf(build, design, p.occ, p.body);
    if (!b) continue;
    const list: (FaceInfo | EdgeInfo)[] = p.kind === 'face' ? b.faces : b.edges;
    const at = (x: FaceInfo | EdgeInfo) => ('c' in x ? x.c : polylineMid(x.points));
    let best: { i: number; d: number } | null = null;
    const consider = (x: FaceInfo | EdgeInfo, d: number) => {
      if (!best || d < best.d) best = { i: x.index, d };
    };
    if (p.key) for (const x of list) if (x.key === p.key) consider(x, dist(at(x), p.at));
    if (!best) {
      const tol = 0.05 * boxSize(b);
      for (const x of list) {
        const d = dist(at(x), p.at);
        if (x.type === p.type && d <= tol) consider(x, d);
      }
    }
    const found = best as { i: number; d: number } | null;
    if (!found) continue;
    const q = pickOf(build, design, p.kind, p.occ, p.body, found.i);
    if (q && !out.some((r) => pickId(r) === pickId(q))) out.push(q);
  }
  return out;
}

/** What a pick is, in assembly coordinates: plane normal, line direction, axis. */
export interface PickGeometry {
  pick: Pick;
  info: FaceInfo | EdgeInfo;
  M: M4;
  /** Unit normal of a planar face (or of a circle's plane), direction of a straight edge, axis of a cylinder or cone. */
  dir?: Vec3;
  /** A point on that plane, line or axis. */
  p?: Vec3;
  /** dir is a plane normal (else a line direction). */
  normal?: boolean;
}

export function pickGeometry(build: BuildResult, design: CadDesign, p: Pick): PickGeometry | null {
  const b = bodyOf(build, design, p.occ, p.body);
  const M = build.placements[p.occ]?.matrix;
  const info = b && (p.kind === 'face' ? b.faces[p.index] : b.edges[p.index]);
  if (!b || !M || !info) return null;
  const pt = (q: Vec3): Vec3 => [M[0] * q[0] + M[4] * q[1] + M[8] * q[2] + M[12], M[1] * q[0] + M[5] * q[1] + M[9] * q[2] + M[13], M[2] * q[0] + M[6] * q[1] + M[10] * q[2] + M[14]];
  const g: PickGeometry = { pick: p, info, M };
  if ('frame' in info && info.frame) Object.assign(g, { dir: norm3(m4Dir(M, info.frame.n)), p: pt(info.frame.o), normal: true });
  else if ('axis' in info && info.axis) Object.assign(g, { dir: norm3(m4Dir(M, info.axis.d)), p: pt(info.axis.p) });
  else if ('line' in info && info.line) Object.assign(g, { dir: norm3(m4Dir(M, sub3(info.line.b, info.line.a))), p: pt(info.line.a) });
  // a circle stands for its plane: parallel to a face it lies in, its gap to it along the normal
  else if ('circle' in info && info.circle) Object.assign(g, { dir: norm3(m4Dir(M, info.circle.axis)), p: pt(info.circle.c), normal: true });
  return g;
}

/**
 * How two picks stand to each other: the angle between them (planes by their normals,
 * lines and axes by their directions, a line and a plane as the line's angle to the
 * plane) and, when they are parallel, the distance between them.
 */
export function relation(a: PickGeometry, b: PickGeometry): { angle?: number; gap?: number } {
  if (!a.dir || !b.dir || !a.p || !b.p) return {};
  const c = Math.min(1, Math.abs(dot3(a.dir, b.dir)));
  const mixed = !!a.normal !== !!b.normal;
  // a line against a plane: 90° minus the angle to the normal
  const angle = mixed ? Math.asin(c) : Math.acos(c);
  const out: { angle?: number; gap?: number } = { angle };
  const parallel = mixed ? c < 1e-9 : c > 1 - 1e-12;
  if (!parallel) return out;
  const d = sub3(b.p, a.p);
  if (a.normal || b.normal) {
    // planes (or a line and a plane): along the normal
    const n = a.normal ? a.dir : b.dir;
    out.gap = Math.abs(dot3(d, n));
  } else out.gap = len3(cross3(d, a.dir)); // parallel lines or axes
  return out;
}
