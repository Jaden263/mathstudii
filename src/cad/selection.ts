// Faces and edges picked in the 3-D view: the selection the inspector describes and the
// modify features (fillet, chamfer, shell, draft) will take. A pick names a face or edge
// of a body in an occurrence by its index in the body's tables, and remembers what finds
// it again after a rebuild renumbers them: the persistent name of the face or edge
// (topology.ts) and where it was.
import { polylineMid, type BodyResult, type BuildResult, type CurveKind, type EdgeInfo, type FaceInfo, type SurfaceKind } from './buildResult';
import type { CadDesign } from './design';
import { cross3, dot3, len3, m4Dir, norm3, sub3, type M4, type Vec3 } from './solid';
import { resolveRef } from './topology';

export interface Pick {
  kind: 'face' | 'edge';
  occ: string;
  body: string;
  index: number;
  /** Persistent name of the face or edge, '' when unknown (the mesh kernel). */
  key: string;
  /** Where it was (component coordinates): the face centroid, the edge midpoint. */
  at: Vec3;
  type: SurfaceKind | CurveKind;
}

export type Selection = Pick[];

export { polylineMid };

/** Identity of a face or edge in a build (picks, highlight sets). */
export const pickId = (p: { kind: 'face' | 'edge'; occ: string; body: string; index: number }) => `${p.kind === 'face' ? 'f' : 'e'}:${p.occ}:${p.body}:${p.index}`;

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
  return e ? { kind, occ, body, index, key: e.key, at: e.mid, type: e.type } : null;
}

/** A click replaces the selection; with shift it adds the pick, or takes it out again. Nothing hit clears it (unless adding). */
export function select(sel: Selection, p: Pick | null, add: boolean): Selection {
  if (!p) return add ? sel : [];
  const id = pickId(p);
  if (!add) return sel.length === 1 && pickId(sel[0]) === id ? sel : [p];
  return sel.some((q) => pickId(q) === id) ? sel.filter((q) => pickId(q) !== id) : [...sel, p];
}

/**
 * The picks found again in a new build by their names (a split face: the piece nearest to
 * where it was), else the nearest face or edge of the same type within 5 % of the body's
 * size; picks of bodies that are gone, or with nothing close enough, drop out.
 */
export function resolveSelection(sel: Selection, build: BuildResult, design: CadDesign): Selection {
  const out: Selection = [];
  for (const p of sel) {
    const b = bodyOf(build, design, p.occ, p.body);
    if (!b) continue;
    const r = resolveRef({ kind: p.kind, body: p.body, key: p.key, hint: { p: p.at, type: p.type } }, [b], { near: 0.05 });
    const q = r.ok ? pickOf(build, design, p.kind, p.occ, p.body, r.index) : null;
    if (q && !out.some((x) => pickId(x) === pickId(q))) out.push(q);
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
  // a sphere's "axis" only carries its centre: it has no direction to stand in an angle
  else if ('axis' in info && info.axis && info.type !== 'sphere') Object.assign(g, { dir: norm3(m4Dir(M, info.axis.d)), p: pt(info.axis.p) });
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
