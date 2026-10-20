// Persistent names of the faces, edges and vertices of a body, and references to them
// that survive edits (the "topological naming problem"), solved as serious CAD systems
// mitigate it: names from the feature history, geometry when a name is gone, and an
// honest "reference lost" when neither finds the entity, never a guess.
//
// Names (the kernels make them, occ/topology.ts):
// - a face: `${feature}/${role}` from the history (f1/end, f1/side:l3, f2/hole0:wall,
//   f3.2.f2/hole0:wall for a pattern copy); a face that merged several is the sorted list
//   `a+b`; the pieces of a split face are `a#1`, `a#2` … in the order of their place on the
//   face's own surface (u, then v);
// - an edge: the names of its two faces, sorted, `a|b`; several edges between the same
//   two faces are `a|b~1`, `a|b~2` … along the first face's u axis;
// - a vertex: the sorted names of the faces meeting there, `a|b|c` (fewer than three: of
//   its edges, `e1&e2`), `~n` when several share them.
//
// A reference keeps the name and a hint of the geometry. It is found again by its name,
// else by its name's family (the same faces after a split or a merge: the piece nearest
// to the hint), else by the hint alone when the entity is still exactly where it was
// (renamed, not moved), else it is lost.
import type { CurveKind, EdgeInfo, FaceInfo, SurfaceKind, VertexInfo } from './buildResult';
import { add3, cross3, dot3, frameFromNormal, len3, norm3, scale3, sub3, type Frame, type Vec3 } from './solid';
import { hashString } from './keys';

export type TopoKind = 'face' | 'edge' | 'vertex';

/** What a reference remembers of the geometry it names. */
export interface TopoHint {
  /** Face centroid, edge midpoint or the vertex (component coordinates). */
  p: Vec3;
  /** Plane normal (out of the material), line direction, or the axis of a cylinder, cone or circle. */
  d?: Vec3;
  type: SurfaceKind | CurveKind | 'vertex';
  /** Radius of a cylinder, sphere or circle. */
  r?: number;
  /** Area of a face, length of an edge. */
  size?: number;
}

/** A face, edge or vertex of a body of the component the reference is used in. */
export interface TopoRef {
  kind: TopoKind;
  /** Id of the body it was picked on. */
  body: string;
  key: string;
  hint: TopoHint;
}

/** An edge as references see it (its display polyline left out). */
export type EdgeFacts = Omit<EdgeInfo, 'points'>;

/** The named faces, edges and vertices of one body (a BodyResult is one). */
export interface BodyTopology {
  id: string;
  faces: FaceInfo[];
  edges: EdgeFacts[];
  vertices: VertexInfo[];
  box: { min: Vec3; max: Vec3 } | null;
  /** False for the mesh kernel: its faces carry no names, only geometry. */
  named?: boolean;
}

// ------------------------------------------------------------ names

/**
 * Unique names from base names that may repeat: a base that occurs once stays as it is,
 * repeated ones become `${base}${sep}1`, `${sep}2` … ordered by `place` (compared entry by
 * entry, values within `tol` counting as equal; the input order breaks the last ties).
 */
export function uniqueNames(base: string[], place: (i: number) => number[], sep: string, tol: number): string[] {
  const groups = new Map<string, number[]>();
  base.forEach((b, i) => groups.set(b, [...(groups.get(b) ?? []), i]));
  const out = [...base];
  for (const [b, idx] of groups) {
    if (idx.length < 2) continue;
    const at = new Map(idx.map((i) => [i, place(i)]));
    idx.sort((p, q) => {
      const a = at.get(p)!, c = at.get(q)!;
      for (let k = 0; k < Math.min(a.length, c.length); k++) if (Math.abs(a[k] - c[k]) > tol) return a[k] - c[k];
      return p - q;
    });
    idx.forEach((i, k) => (out[i] = `${b}${sep}${k + 1}`));
  }
  return out;
}

/** Name of a face from the history keys that reach it: one, or several merged ('?' when none). */
export function faceName(keys: string[]): string {
  const ks = [...new Set(keys.filter(Boolean))].sort();
  return ks.length ? ks.join('+') : '?';
}

/** Key of an edge from the keys of its faces (a seam has the same face twice). */
export function edgeKey(a: string | undefined, b: string | undefined): string {
  if (!a || !b) return '';
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Key of a vertex: the faces meeting there, or with fewer than three of them its edges. */
export function vertexKey(faces: string[], edges: string[]): string {
  const fs = [...new Set(faces)].sort();
  if (fs.length >= 3) return fs.join('|');
  return [...new Set(edges)].sort().join('&');
}

/** A name without the indices that told apart pieces and parallel edges. */
export const baseName = (key: string) => key.replace(/[#~]\d+/g, '');

const faceTokens = (key: string) => baseName(key).split('+');
const meets = (a: string[], b: string[]) => a.some((x) => b.includes(x));
const sameFace = (a: string, b: string) => meets(faceTokens(a), faceTokens(b));

function sameEdge(a: string, b: string): boolean {
  const [a0, a1 = a0] = baseName(a).split('|'), [b0, b1 = b0] = baseName(b).split('|');
  return (sameFace(a0, b0) && sameFace(a1, b1)) || (sameFace(a0, b1) && sameFace(a1, b0));
}

/** Every one of `want` matched by a different one of `have`. */
function matchAll(want: string[], have: string[], same: (a: string, b: string) => boolean): boolean {
  if (want.length !== have.length) return false;
  const free = [...have];
  for (const w of want) {
    const i = free.findIndex((h) => same(w, h));
    if (i < 0) return false;
    free.splice(i, 1);
  }
  return true;
}

/**
 * Whether a name is the same entity as a stored one after a split, a merge or a change
 * in how many share its faces: faces share a history key, edges join the same two
 * faces, vertices sit where the same faces (or edges) meet.
 */
export function sameFamily(kind: TopoKind, stored: string, cand: string): boolean {
  if (!stored || !cand) return false;
  if (kind === 'face') return sameFace(stored, cand);
  if (kind === 'edge') return sameEdge(stored, cand);
  const s = baseName(stored), c = baseName(cand);
  if (s.includes('&') !== c.includes('&')) return false;
  return s.includes('&') ? matchAll(s.split('&'), c.split('&'), sameEdge) : matchAll(s.split('|'), c.split('|'), sameFace);
}

// ------------------------------------------------------------ references

type Entity = FaceInfo | EdgeFacts | VertexInfo;

const isFace = (e: Entity): e is FaceInfo => 'area' in e;
const isEdge = (e: Entity): e is EdgeFacts => 'length' in e;

/** The point a reference's hint stands for, on an entity. */
export function entityPoint(e: Entity): Vec3 {
  return isFace(e) ? e.c : isEdge(e) ? e.mid : e.p;
}

/** Normal of a plane, direction of a line, axis of anything round. */
function entityDir(e: Entity): Vec3 | undefined {
  if (isFace(e)) return e.frame?.n ?? (e.type === 'sphere' ? undefined : e.axis?.d);
  if (isEdge(e)) return e.line ? norm3(sub3(e.line.b, e.line.a)) : e.circle?.axis;
  return undefined;
}

const entityRadius = (e: Entity) => (isFace(e) ? e.radius : isEdge(e) ? e.circle?.r : undefined);

/** A reference to a face, edge or vertex of a body, with what finds it again. */
export function refTo(kind: TopoKind, body: string, e: Entity): TopoRef {
  const hint: TopoHint = { p: entityPoint(e), type: kind === 'vertex' ? 'vertex' : (e as FaceInfo | EdgeFacts).type };
  const d = entityDir(e), r = entityRadius(e);
  if (d) hint.d = d;
  if (r !== undefined) hint.r = r;
  if (isFace(e)) hint.size = e.area;
  else if (isEdge(e)) hint.size = e.length;
  return { kind, body, key: e.key, hint };
}

export const entitiesOf = (b: BodyTopology, kind: TopoKind): Entity[] => (kind === 'face' ? b.faces : kind === 'edge' ? b.edges : b.vertices);

/** Size of a body (its box diagonal), the scale of the tolerances. */
export function topologySize(b: BodyTopology): number {
  return b.box ? Math.max(len3(sub3(b.box.max, b.box.min)), 1e-9) : 1;
}

export type Resolution =
  | { ok: true; body: string; index: number; by: 'key' | 'family' | 'geometry' }
  | { ok: false };

/**
 * Whether an entity is the one a hint describes, still exactly where it was: the same
 * type and place, direction (either way round for lines and axes) and radius.
 */
function matchesHint(e: Entity, h: TopoHint, kind: TopoKind, tol: number): boolean {
  if (kind !== 'vertex' && (e as FaceInfo | EdgeFacts).type !== h.type) return false;
  if (len3(sub3(entityPoint(e), h.p)) > tol) return false;
  const d = entityDir(e);
  if (h.d && d) {
    const c = dot3(norm3(h.d), norm3(d));
    // a plane's normal has a side; a line or an axis does not
    if ((isFace(e) && e.type === 'plane' ? c : Math.abs(c)) < 1 - 1e-9) return false;
  }
  const r = entityRadius(e);
  return h.r === undefined || r === undefined || Math.abs(r - h.r) <= tol;
}

export interface ResolveOptions {
  /**
   * Fall back to the nearest entity of the same type within this fraction of the body's
   * size (the selection does, as a convenience); references never do, by default only an
   * entity that has not moved is found by its geometry.
   */
  near?: number;
}

/**
 * Find a reference again in the bodies of its component: by its key; else by the key's
 * family, the candidate nearest to the hint; else by its geometry, if the entity has not
 * moved; else it is lost. The body it was picked on is searched first, then the others
 * (a body joined into another one carries its faces' names along).
 */
export function resolveRef(ref: TopoRef, bodies: BodyTopology[], o: ResolveOptions = {}): Resolution {
  const own = bodies.filter((b) => b.id === ref.body);
  for (const pool of own.length ? [own, bodies.filter((b) => b.id !== ref.body)] : [bodies]) {
    const hit = resolveIn(ref, pool, o);
    if (hit.ok) return hit;
  }
  return { ok: false };
}

function resolveIn(ref: TopoRef, bodies: BodyTopology[], o: ResolveOptions): Resolution {
  type Cand = { body: BodyTopology; e: Entity; d: number };
  const all: Cand[] = bodies.flatMap((body) => entitiesOf(body, ref.kind).map((e) => ({ body, e, d: len3(sub3(entityPoint(e), ref.hint.p)) })));
  // nearest to the hint; a tie (a symmetric split) goes to the first name
  const best = (cs: Cand[]) => cs.reduce<Cand | null>((b, c) => {
    if (!b) return c;
    const tie = Math.abs(c.d - b.d) <= 1e-9 * topologySize(c.body);
    return (tie ? c.e.key < b.e.key : c.d < b.d) ? c : b;
  }, null);
  const found = (c: Cand | null, by: 'key' | 'family' | 'geometry'): Resolution => (c ? { ok: true, body: c.body.id, index: c.e.index, by } : { ok: false });
  if (ref.key) {
    const exact = all.filter((c) => c.e.key === ref.key);
    if (exact.length) return found(best(exact), 'key');
    const family = all.filter((c) => sameFamily(ref.kind, ref.key, c.e.key));
    if (family.length) return found(best(family), 'family');
  }
  // should several be in its place, the one of the size it had
  const size = (e: Entity) => (isFace(e) ? e.area : isEdge(e) ? e.length : 0);
  const still = all.filter((c) => matchesHint(c.e, ref.hint, ref.kind, 1e-6 * topologySize(c.body)))
    .sort((a, b) => (ref.hint.size === undefined ? 0 : Math.abs(size(a.e) - ref.hint.size) - Math.abs(size(b.e) - ref.hint.size)));
  if (still.length) return found(still[0], 'geometry');
  if (o.near) {
    const close = all.filter((c) => (ref.kind === 'vertex' || (c.e as FaceInfo | EdgeFacts).type === ref.hint.type) && c.d <= o.near! * topologySize(c.body));
    if (close.length) return found(best(close), 'geometry');
  }
  return { ok: false };
}

/** The entity a resolution found. */
export function resolvedEntity<K extends TopoKind>(bodies: BodyTopology[], kind: K, r: Resolution): (K extends 'face' ? FaceInfo : K extends 'edge' ? EdgeFacts : VertexInfo) | null {
  if (!r.ok) return null;
  const b = bodies.find((q) => q.id === r.body);
  return (b ? entitiesOf(b, kind)[r.index] ?? null : null) as never;
}

// ------------------------------------------------------------ sketch planes on faces

/**
 * The point of a face a sketch's origin sits on, when it sits on one: a vertex (a part
 * drawn from the origin) or the centre of a circle or arc edge (a disc centred on it).
 * The sketch then moves with that point when the face moves in its plane.
 */
export interface FaceAnchor {
  /** The vertex, or the circle or arc edge whose centre it is. */
  ref: TopoRef;
  /** Where the point was when the sketch was made. */
  at: Vec3;
}

/** The anchor of a sketch origin `o` on a face of a body: its vertex or circle centre at `o`, if any. */
export function faceAnchor(b: BodyTopology, face: FaceInfo, o: Vec3): FaceAnchor | undefined {
  const tol = 1e-6 * topologySize(b);
  for (const e of b.edges) {
    // a seam is no edge of the shape, and a closed curve's one vertex only where its parameter starts
    if (!e.faces.includes(face.index) || e.faces[0] === e.faces[1]) continue;
    if (e.circle && len3(sub3(e.circle.c, o)) <= tol) return { ref: refTo('edge', b.id, e), at: e.circle.c };
    for (const vi of e.v[0] !== e.v[1] ? e.v : []) {
      const v = b.vertices[vi];
      if (v && len3(sub3(v.p, o)) <= tol) return { ref: refTo('vertex', b.id, v), at: v.p };
    }
  }
  return undefined;
}

/** Where an anchor is on the bodies as built, or null when its vertex or circle is gone. */
export function anchorPoint(a: FaceAnchor, bodies: BodyTopology[]): Vec3 | null {
  const r = resolveRef(a.ref, bodies);
  if (a.ref.kind === 'vertex') return resolvedEntity(bodies, 'vertex', r)?.p ?? null;
  return resolvedEntity(bodies, 'edge', r)?.circle?.c ?? null;
}

/** The smallest rotation taking unit vector a onto unit vector b (Rodrigues), or null when they are opposite. */
function turnOnto(a: Vec3, b: Vec3): ((x: Vec3) => Vec3) | null {
  const k = cross3(a, b), c = dot3(a, b);
  if (c < -1 + 1e-9) return null;
  return (x) => add3(add3(scale3(x, c), cross3(k, x)), scale3(k, dot3(k, x) / (1 + c)));
}

/**
 * The plane of a sketch on a face, found again on the face as it is now: the normal from
 * the face, the x axis the stored one turned with the face. The origin moves with the
 * face's anchor (`anchor`: where it was and where it is now) if the sketch has one;
 * otherwise it is the stored origin projected onto the new plane. So a face that moved
 * along its normal (the base extruded taller) carries the sketch with it, one that grew
 * or shrank in its plane leaves it where it was, and one that moved in its plane takes
 * it along when the sketch origin sits on one of its vertices or circle centres. Null
 * when the face is no longer flat.
 */
export function faceFrame(stored: Frame, face: FaceInfo, anchor?: { from: Vec3; to: Vec3 }): Frame | null {
  if (face.type !== 'plane' || !face.frame) return null;
  const n = norm3(face.frame.n);
  const turn = turnOnto(norm3(stored.n), n);
  const moved = anchor && turn ? add3(anchor.to, turn(sub3(stored.o, anchor.from))) : stored.o;
  const o = sub3(moved, scale3(n, dot3(sub3(moved, face.frame.o), n)));
  const u1 = turn ? turn(stored.u) : stored.u;
  const u0 = sub3(u1, scale3(n, dot3(u1, n)));
  const u = len3(u0) > 1e-6 ? norm3(u0) : frameFromNormal(o, n).u;
  return { o, u, v: cross3(n, u), n };
}

/** The feature that made a face, from its name (the pattern or mirror for a copy: its own id). */
export function keyFeature(key: string): string {
  const path = baseName(key).split('+')[0].split('/')[0];
  return path.split('.').pop()!;
}

/** Words for a face from its history name: "the end face of Extrude1", "the wall of hole 2 of Hole1". */
export function faceWords(key: string, featureName: (id: string) => string | undefined): string {
  const first = baseName(key).split('+')[0];
  const slash = first.indexOf('/');
  if (slash < 0) return 'a face';
  const path = first.slice(0, slash), role = first.slice(slash + 1);
  const copy = path.includes('.') ? ` (copy ${path.split('.')[1]} of ${featureName(path.split('.')[0]) ?? 'a pattern'})` : '';
  const feature = featureName(path.split('.').pop()!) ?? 'a feature';
  const hole = /^hole(\d+):(\w+)/.exec(role);
  // an imported face: named after its body and surface (occ/stepImport.ts)
  const imported = /^b(\d+):([a-z])/.exec(role);
  if (imported) {
    const kind = ({ p: 'flat', c: 'cylindrical', k: 'conical', s: 'spherical', t: 'toroidal' } as Record<string, string>)[imported[2]] ?? 'curved';
    return `a ${kind} face of ${feature}${+imported[1] ? ` (body ${+imported[1] + 1})` : ''}${copy}`;
  }
  // sheet metal: a flange or bend of an edge flange, hem, bend or bent strip (sheetMetal.ts)
  const sheet = /^(fl|bend)(?::[^/]*)?\/(start|end|side:(\w+))/.exec(role);
  if (sheet) {
    const side = sheet[3];
    const face = sheet[2] === 'start' || side === 'a' ? 'face A' : sheet[2] === 'end' || side === 'b' ? 'face B' : side === 'far' ? 'far edge face' : 'side face';
    return `the ${face} of the ${sheet[1] === 'fl' ? 'flange' : 'bend'} of ${feature}${copy}`;
  }
  const what = role === 'start' ? 'start face' : role === 'end' ? 'end face' : role.startsWith('side') ? 'side face'
    : role.startsWith('round') ? 'rounding' : role.startsWith('chamfer') ? 'chamfer'
      : role.startsWith('in:') ? 'inner wall' : role.startsWith('out:') ? 'outer wall' : role === 'split' ? 'cut face'
        : role.startsWith('thread') ? 'thread'
          : hole ? `${hole[2] === 'wall' ? 'wall' : hole[2] === 'bottom' ? 'bottom' : hole[2] === 'thread' ? 'thread' : 'face'} of hole ${+hole[1] + 1}` : 'face';
  return `the ${what} of ${feature}${copy}`;
}

/** Words for an edge from its name: "the edge between the end face and the side face of Extrude1". */
export function edgeWords(key: string, featureName: (id: string) => string | undefined): string {
  const [a, b] = baseName(key).split('|');
  if (!a || !b) return 'an edge';
  const wa = faceWords(a, featureName), wb = faceWords(b, featureName);
  // two faces of the same feature: say it once
  const of = (w: string) => w.slice(w.indexOf(' of ') + 4);
  if (a !== b && of(wa) === of(wb) && !wa.includes('(')) return `the edge between ${wa.slice(0, wa.indexOf(' of '))} and ${wb.slice(0, wb.indexOf(' of '))} of ${of(wa)}`;
  return a === b ? `an edge of ${wa}` : `the edge between ${wa} and ${wb}`;
}

/** Words for what a reference names. */
export function refWords(ref: TopoRef, featureName: (id: string) => string | undefined): string {
  if (!ref.key) return ref.kind === 'face' ? 'a face' : ref.kind === 'edge' ? 'an edge' : 'a vertex';
  return ref.kind === 'face' ? faceWords(ref.key, featureName) : ref.kind === 'edge' ? edgeWords(ref.key, featureName) : 'a corner';
}

/**
 * A short, stable name for a picked entity (from its reference), for the faces an operation
 * makes from it: a rounding is `f5/round:${token}`, so the pick is found again from it. Its
 * own name would do, but names hold the separators of names (`a|b`, `a+b`).
 */
export function refToken(ref: TopoRef): string {
  return nameToken(ref.key || ref.hint.p.map((v) => v.toPrecision(9)).join(','));
}

/** A name as a short token of hex digits (for names inside names). */
export const nameToken = (name: string) => hashString(name).slice(-6);
