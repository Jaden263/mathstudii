// Sweeps, coils and threads: the geometry that is not the kernel's. The path of a sweep
// from sketch curves joined end to end (or edges picked on a body), the helix and the
// section of a coil, the groove of a screw thread, and the checks that keep a sweep from
// cutting through itself: OCCT builds such a solid without complaint, with a volume that
// counts the overlap twice.
import type { CadSketch } from './model';
import type { ProfileRegion, Seg } from './profile';
import { add3, cross3, dot3, len3, norm3, scale3, sub3, type Frame, type Vec3 } from './solid';
import type { BodyTopology } from './topology';
import type { FaceInfo } from './buildResult';
import { grooveWidth, type ThreadSize } from './threads';
import { sizeWords } from './modify';

const { PI, cos, sin, abs, max, min } = Math;

/**
 * A helix about an axis: it starts at o + r·x and turns `turns` times, rising `pitch` per
 * turn along `axis`; right-handed (anticlockwise seen from the top) unless `left`.
 */
export interface Helix {
  /** On the axis, level with the start. */
  o: Vec3;
  /** Unit axis, the way the helix rises. */
  axis: Vec3;
  /** Unit direction from the axis to the start, square to it. */
  x: Vec3;
  r: number;
  pitch: number;
  turns: number;
  left?: boolean;
}

/** Point of a helix at angle φ (radians from its start). */
export function helixPoint(h: Helix, phi: number): Vec3 {
  const y = cross3(h.axis, h.x);
  const s = h.left ? -1 : 1;
  return add3(add3(add3(h.o, scale3(h.x, h.r * cos(phi))), scale3(y, s * h.r * sin(phi))), scale3(h.axis, (h.pitch * phi) / (2 * PI)));
}

/** Unit tangent of a helix at angle φ. */
export function helixTangent(h: Helix, phi: number): Vec3 {
  const y = cross3(h.axis, h.x);
  const s = h.left ? -1 : 1;
  return norm3(add3(add3(scale3(h.x, -h.r * sin(phi)), scale3(y, s * h.r * cos(phi))), scale3(h.axis, h.pitch / (2 * PI))));
}

/** Length of a helix: turns · √((2πr)² + p²). */
export const helixLength = (h: Helix) => h.turns * Math.hypot(2 * PI * h.r, h.pitch);

/** A piece of a path in component coordinates: a line, an arc through three points, a whole circle. */
export type PathSeg =
  | { kind: 'line'; a: Vec3; b: Vec3 }
  | { kind: 'arc'; a: Vec3; m: Vec3; b: Vec3 }
  | { kind: 'circle'; c: Vec3; n: Vec3; x: Vec3; r: number };

/** A path as the kernel takes it: pieces joined end to end, a helix, or edges of a body in order. */
export type PathGeom<S> =
  | { kind: 'segs'; segs: PathSeg[] }
  | { kind: 'helix'; helix: Helix }
  | { kind: 'edges'; body: S; edges: number[] };

export interface SweepOptions {
  /**
   * perpendicular: the profile turns with the path (corrected Frenet); parallel: it only
   * moves; axis: it turns about `axis` only (a binormal kept at a fixed angle to it, as a
   * coil's section or a thread's profile does).
   */
  orientation: 'perpendicular' | 'parallel' | 'axis';
  axis?: Vec3;
  /** Turn of the profile about the path from its start to its end, radians. */
  twist: number;
  /** Size at the end over size at the start. */
  scale: number;
  /** The part's unit, for sizes in messages. */
  unit?: string;
}

// ------------------------------------------------------------ sketch paths

const P3 = (f: Frame, x: number, y: number): Vec3 => [f.o[0] + f.u[0] * x + f.v[0] * y, f.o[1] + f.u[1] * x + f.v[1] * y, f.o[2] + f.u[2] * x + f.v[2] * y];

/**
 * The curves of a sketch as one path (component coordinates): lines and arcs joined end to
 * end into a chain, open or closed, or one circle. Throws when they branch or fall apart.
 * `curves` missing: every line, arc and circle that is not construction geometry.
 */
export function sketchPath(sk: CadSketch, sol: { points: Record<string, [number, number]>; radii: Record<string, number> }, f: Frame, curves?: string[]): { segs: PathSeg[]; closed: boolean; ids: string[] } {
  const ents = sk.entities.filter((e) => e.type !== 'point' && (curves?.length ? curves.includes(e.id) : !e.construction));
  if (!ents.length) throw new Error('the path sketch has no curves');
  const at = (id: string) => sol.points[id];
  const circle = ents.find((e) => e.type === 'circle');
  if (circle?.type === 'circle') {
    if (ents.length > 1) throw new Error('a circle is a path of its own: pick it alone, or the lines and arcs of one chain');
    const [cx, cy] = at(circle.c);
    return { segs: [{ kind: 'circle', c: P3(f, cx, cy), n: f.n, x: f.u, r: sol.radii[circle.id] ?? circle.r }], closed: true, ids: [circle.id] };
  }
  // ends of every curve; points are the same where their ids or their places are
  type Piece = { id: string; ends: [string, string]; seg: (fwd: boolean) => PathSeg };
  const pieces: Piece[] = ents.map((e) => {
    if (e.type === 'line') {
      const a = at(e.p1), b = at(e.p2);
      return { id: e.id, ends: [e.p1, e.p2], seg: (fwd) => ({ kind: 'line', a: P3(f, ...(fwd ? a : b)), b: P3(f, ...(fwd ? b : a)) }) };
    }
    if (e.type !== 'arc') throw new Error('the path has a curve that is not a line, arc or circle');
    const c = at(e.c), a = at(e.p1), b = at(e.p2);
    const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
    const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
    let a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
    while (a1 <= a0 + 1e-12) a1 += 2 * PI;
    const mid: [number, number] = [c[0] + r * cos((a0 + a1) / 2), c[1] + r * sin((a0 + a1) / 2)];
    return { id: e.id, ends: [e.p1, e.p2], seg: (fwd) => ({ kind: 'arc', a: P3(f, ...(fwd ? a : b)), m: P3(f, ...mid), b: P3(f, ...(fwd ? b : a)) }) };
  });
  // points that coincide by place are one node
  const size = max(1, ...Object.values(sol.points).map(([x, y]) => Math.hypot(x, y)));
  const nodeOf = new Map<string, string>();
  const reps: string[] = [];
  for (const p of pieces) for (const id of p.ends) {
    if (nodeOf.has(id)) continue;
    const q = at(id);
    const same = reps.find((r) => Math.hypot(at(r)[0] - q[0], at(r)[1] - q[1]) <= 1e-7 * size);
    nodeOf.set(id, same ?? id);
    if (!same) reps.push(id);
  }
  const deg = new Map<string, number>();
  for (const p of pieces) for (const id of p.ends) deg.set(nodeOf.get(id)!, (deg.get(nodeOf.get(id)!) ?? 0) + 1);
  if ([...deg.values()].some((d) => d > 2)) throw new Error('the path branches: three curves meet at a point — pick the curves of one chain');
  const open = [...deg].filter(([, d]) => d === 1).map(([n]) => n);
  if (open.length !== 0 && open.length !== 2) throw new Error('the path curves are not joined end to end');
  // walk the chain from an open end (or anywhere when it is closed)
  let node = open[0] ?? nodeOf.get(pieces[0].ends[0])!;
  const left = new Set(pieces);
  const segs: PathSeg[] = [], ids: string[] = [];
  while (left.size) {
    const next = [...left].find((p) => p.ends.some((id) => nodeOf.get(id) === node));
    if (!next) throw new Error('the path curves are not joined end to end: they fall into separate pieces');
    left.delete(next);
    const fwd = nodeOf.get(next.ends[0]) === node;
    segs.push(next.seg(fwd));
    ids.push(next.id);
    node = nodeOf.get(next.ends[fwd ? 1 : 0])!;
  }
  return { segs, closed: open.length === 0, ids };
}

const segStart = (s: PathSeg): Vec3 => (s.kind === 'circle' ? add3(s.c, scale3(s.x, s.r)) : s.a);
const segEnd = (s: PathSeg): Vec3 => (s.kind === 'circle' ? add3(s.c, scale3(s.x, s.r)) : s.b);
const reverseSeg = (s: PathSeg): PathSeg => (s.kind === 'line' ? { kind: 'line', a: s.b, b: s.a } : s.kind === 'arc' ? { kind: 'arc', a: s.b, m: s.m, b: s.a } : { ...s, n: scale3(s.n, -1) });

/** The path run from the end nearer to `p` (a sweep starts where its profile is). */
export function startNear(segs: PathSeg[], closed: boolean, p: Vec3): PathSeg[] {
  if (closed || !segs.length) return segs;
  const d0 = len3(sub3(segStart(segs[0]), p)), d1 = len3(sub3(segEnd(segs[segs.length - 1]), p));
  return d1 < d0 * (1 - 1e-9) ? segs.map(reverseSeg).reverse() : segs;
}

/**
 * Edges of a body (topology indices) in the order they join end to end, or an error when
 * they do not make one chain.
 */
export function chainEdges(b: BodyTopology, edges: number[]): { edges: number[]; closed: boolean } {
  const list = [...new Set(edges)];
  if (!list.length) throw new Error('pick the edges of the path');
  if (list.length === 1) return { edges: list, closed: b.edges[list[0]].v[0] === b.edges[list[0]].v[1] };
  const deg = new Map<number, number>();
  for (const i of list) for (const v of b.edges[i].v) deg.set(v, (deg.get(v) ?? 0) + 1);
  if ([...deg.values()].some((d) => d > 2)) throw new Error('the path edges branch: three of them meet at a corner — pick the edges of one chain');
  const ends = [...deg].filter(([, d]) => d === 1).map(([v]) => v);
  if (ends.length !== 0 && ends.length !== 2) throw new Error('the path edges are not joined end to end');
  let v = ends.length ? ends[0] : b.edges[list[0]].v[0];
  const left = new Set(list);
  const out: number[] = [];
  while (left.size) {
    const next = [...left].find((i) => b.edges[i].v.includes(v));
    if (next === undefined) throw new Error('the path edges are not joined end to end: they fall into separate pieces');
    left.delete(next);
    out.push(next);
    const [a, c] = b.edges[next].v;
    v = a === v ? c : a;
  }
  return { edges: out, closed: ends.length === 0 };
}

// ------------------------------------------------------------ self-intersection

/** A point along a path: where, its unit tangent, its curvature and its distance along the path. */
export interface PathSample {
  p: Vec3;
  t: Vec3;
  k: number;
  s: number;
}

/** Normal of the plane a path lies in, or null when it is not flat (or a straight line). */
function pathPlane(ps: PathSample[]): Vec3 | null {
  const size = max(1e-12, ...ps.map((q) => len3(sub3(q.p, ps[0].p))));
  let n: Vec3 | null = null;
  for (const q of ps) {
    const c = cross3(ps[0].t, sub3(q.p, ps[0].p));
    if (len3(c) > 1e-6 * size) {
      n = norm3(c);
      break;
    }
  }
  if (!n) return null;
  return ps.every((q) => abs(dot3(sub3(q.p, ps[0].p), n!)) <= 1e-7 * size && abs(dot3(q.t, n!)) <= 1e-7) ? n : null;
}

/**
 * Why a sweep of `profile` (points on its outline) along the sampled path would cut through
 * itself, or null: where the path bends tighter than the profile reaches from it (towards
 * the bend, for a flat path), where it comes back closer to itself than the profile is
 * wide, or, for a parallel sweep, where it turns back through the profile's plane.
 */
export function sweepClash(ps: PathSample[], closed: boolean, profile: Vec3[], normal: Vec3, parallel: boolean, unit?: string): string | null {
  if (ps.length < 2 || !profile.length) return null;
  const c = scale3(profile.reduce((a, q) => add3(a, q), [0, 0, 0] as Vec3), 1 / profile.length);
  // where the profile sits on the path
  let ia = 0;
  ps.forEach((q, i) => {
    if (len3(sub3(q.p, c)) < len3(sub3(ps[ia].p, c))) ia = i;
  });
  const at = ps[ia];
  const reach = max(...profile.map((q) => len3(sub3(q, at.p))));
  const L = ps[ps.length - 1].s;
  const w = (v: number) => sizeWords(v, unit);
  if (parallel) {
    const sides = ps.map((q) => dot3(q.t, normal));
    if (sides.some((v) => v * sides[ia] <= 0)) return 'the path turns back along the profile’s plane: a parallel sweep would fold over itself (use Perpendicular)';
  } else {
    // a flat path bends in its plane: what counts is how far the profile reaches that way
    const n = pathPlane(ps);
    const side = n ? norm3(cross3(n, at.t)) : null;
    const towards = side ? max(...profile.map((q) => abs(dot3(sub3(q, at.p), side)))) : reach;
    const kmax = max(...ps.map((q) => q.k));
    if (kmax > 0 && towards >= (1 - 1e-9) / kmax) {
      return `the profile reaches ${w(towards)} from the path, but the path bends with a radius of ${w(1 / kmax)}: the sweep would cut through itself`;
    }
  }
  // the path coming back near itself: points farther apart along it than half a turn round
  // the profile (Schur: a curve bending no tighter than the profile reaches cannot be closer
  // than 2·reach there) but closer than the profile is wide
  const cell = 2 * reach;
  if (!(cell > 0)) return null;
  const grid = new Map<string, number[]>();
  const key = (p: Vec3) => p.map((v) => Math.floor(v / cell)).join(',');
  ps.forEach((q, i) => {
    const k = key(q.p);
    grid.set(k, [...(grid.get(k) ?? []), i]);
  });
  let worst: { d: number } | null = null;
  for (let i = 0; i < ps.length; i++) {
    const [gx, gy, gz] = ps[i].p.map((v) => Math.floor(v / cell));
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const j of grid.get(`${gx + dx},${gy + dy},${gz + dz}`) ?? []) {
        if (j <= i) continue;
        let apart = ps[j].s - ps[i].s;
        if (closed) apart = min(apart, L - apart);
        if (apart <= PI * reach * (1 + 1e-9)) continue;
        const d = len3(sub3(ps[i].p, ps[j].p));
        if (d < 2 * reach * (1 - 1e-9) && (!worst || d < worst.d)) worst = { d };
      }
    }
  }
  return worst ? `the path comes within ${w(worst.d)} of itself, closer than the profile is wide (${w(2 * reach)}): the sweep would cut through itself` : null;
}

/**
 * Normals that turn as little as possible along the sampled path (a rotation-minimising
 * frame, by Wang et al.'s double reflection), starting square to the first tangent: the
 * frame a twist turns the profile against.
 */
export function minimalNormals(ps: PathSample[], start?: Vec3): Vec3[] {
  const t0 = ps[0].t;
  let r = start ? norm3(sub3(start, scale3(t0, dot3(start, t0)))) : null;
  if (!r || !Number.isFinite(r[0])) {
    const any: Vec3 = abs(t0[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    r = norm3(cross3(any, t0));
  }
  const out = [r];
  for (let i = 0; i + 1 < ps.length; i++) {
    const v1 = sub3(ps[i + 1].p, ps[i].p), c1 = dot3(v1, v1);
    if (!(c1 > 0)) {
      out.push(r);
      continue;
    }
    const rL = sub3(r, scale3(v1, (2 / c1) * dot3(v1, r)));
    const tL = sub3(ps[i].t, scale3(v1, (2 / c1) * dot3(v1, ps[i].t)));
    const v2 = sub3(ps[i + 1].t, tL), c2 = dot3(v2, v2);
    r = c2 > 1e-30 ? sub3(rL, scale3(v2, (2 / c2) * dot3(v2, rL))) : rL;
    r = norm3(r);
    out.push(r);
  }
  return out;
}

/**
 * Points of the auxiliary path a twisted sweep follows: at every sample, `rho` from the
 * path along its rotation-minimising normal turned by twist·s/L about the tangent. OCCT
 * points the profile's normal at it, so the profile turns linearly along the path.
 */
export function twistGuide(ps: PathSample[], twist: number, rho: number): Vec3[] {
  const N = minimalNormals(ps);
  const L = ps[ps.length - 1].s || 1;
  return ps.map((q, i) => {
    const th = (twist * q.s) / L, b = cross3(q.t, N[i]);
    return add3(q.p, add3(scale3(N[i], rho * cos(th)), scale3(b, rho * sin(th))));
  });
}

// ------------------------------------------------------------ coils

export type CoilSection = 'circle' | 'square' | 'triangle-out' | 'triangle-in';

/** A loop of straight lines through the points (u, v), counter-clockwise. */
const polyLoop = (pts: [number, number][], tag: string) => ({
  segs: pts.map((p, i): Seg => ({ kind: 'line', a: { x: p[0], y: p[1] }, b: { x: pts[(i + 1) % pts.length][0], y: pts[(i + 1) % pts.length][1] } })),
  entities: pts.map((_, i) => `${tag}${i}`),
});

/**
 * A coil: the helix its section follows and the section, square to the helix at its start
 * (u radially outwards, v = tangent × u, so v runs nearly against the axis). The helix
 * goes through the middle of the section's radial extent: on the diameter (`center`), or
 * so that the section lies inside or outside it. Throws when the section reaches the axis
 * or the turns overlap (the section is wider along the axis than the pitch).
 */
export function coilGeometry(o: { c: Vec3; axis: Vec3; x: Vec3 }, d: number, pitch: number, turns: number, size: number, section: CoilSection, position: 'center' | 'inside' | 'outside', left: boolean, unit?: string): { helix: Helix; frame: Frame; region: ProfileRegion } {
  if (!(d > 0)) throw new Error('the diameter must be positive');
  if (!(pitch > 0)) throw new Error('the pitch must be positive');
  if (!(turns > 0)) throw new Error('the number of revolutions must be positive');
  if (!(size > 0)) throw new Error('the section size must be positive');
  const h = (Math.sqrt(3) / 2) * size;
  // extent of the section radially (u) and along v
  const eu = section === 'circle' || section === 'square' ? size : h;
  const R = d / 2 + (position === 'inside' ? -eu / 2 : position === 'outside' ? eu / 2 : 0);
  const w = (v: number) => sizeWords(v, unit);
  if (eu / 2 >= R * (1 - 1e-9)) throw new Error(`the section (${w(eu)} across) reaches the coil’s axis: make the diameter larger or the section smaller`);
  // the section is tilted by the helix angle α: along the axis it is size / cos α wide
  const cosA = (2 * PI * R) / Math.hypot(2 * PI * R, pitch);
  if (size / cosA >= pitch * (1 - 1e-9)) throw new Error(`the turns overlap: the section is ${w(size / cosA)} wide along the axis, the pitch only ${w(pitch)} — make the pitch larger or the section smaller`);
  const helix: Helix = { o: o.c, axis: norm3(o.axis), x: norm3(o.x), r: R, pitch, turns, ...(left ? { left: true } : {}) };
  const n = helixTangent(helix, 0);
  const u = helix.x, v = cross3(n, u);
  const frame: Frame = { o: helixPoint(helix, 0), u, v, n };
  const s = size / 2;
  const outer = section === 'circle'
    ? { segs: [{ kind: 'arc' as const, c: { x: 0, y: 0 }, r: s, a0: 0, a1: 2 * PI }], entities: ['section'] }
    : section === 'square' ? polyLoop([[-s, -s], [s, -s], [s, s], [-s, s]], 'side')
      : section === 'triangle-out' ? polyLoop([[-h / 2, -s], [h / 2, 0], [-h / 2, s]], 'side')
        : polyLoop([[h / 2, -s], [h / 2, s], [-h / 2, 0]], 'side');
  return { helix, frame, region: { outer, holes: [] } };
}

// ------------------------------------------------------------ threads

/** A screw thread's groove as the kernel cuts it. */
export interface ThreadGeom {
  /** On the axis at the end the thread starts from; `axis` points along the thread (unit). */
  o: Vec3;
  axis: Vec3;
  /** Unit radial direction where the groove's section starts. */
  x: Vec3;
  pitch: number;
  left?: boolean;
  /** The groove's centre runs from z0 to z1 along the axis (z0 < 0: from outside the material). */
  z0: number;
  z1: number;
  /** The groove's section in the half-plane of x and the axis: (r, z) corners about z = 0. */
  section: [number, number][];
  /** Radius of the helix it follows (inside the section). */
  r: number;
}

/** A cylindrical face as a thread sees it: its axis, radius, extent along the axis and which side the material is on. */
export interface ThreadFace {
  /** On the axis at the end the thread starts from, and the axis pointing into the face. */
  o: Vec3;
  axis: Vec3;
  radius: number;
  /** Length of the face along its axis. */
  length: number;
  /** A hole (the material outside the cylinder) rather than a shaft. */
  internal: boolean;
  /** Whether the thread can run out past the start end and past the far end. */
  openStart: boolean;
  openEnd: boolean;
}

/**
 * How a cylindrical face of a body takes a thread: its axial extent (from its edges and
 * vertices) and its ends. An end is open when what borders it lies on the side the groove
 * may run into: a shaft's cap or chamfer (inside its radius), a hole's mouth (a face
 * reaching outwards from it). Without `flip`, the thread starts at an open end.
 */
export function threadFace(b: BodyTopology, face: FaceInfo, flip?: boolean): ThreadFace {
  if (face.type !== 'cylinder' || !face.axis || !face.radius) throw new Error('a thread goes on a cylindrical face');
  if (face.outward === undefined) throw new Error('the kernel does not say which side of the face the material is on');
  const d = norm3(face.axis.d), p0 = face.axis.p, R = face.radius;
  const along = (p: Vec3) => dot3(sub3(p, p0), d);
  const radial = (p: Vec3) => len3(sub3(sub3(p, p0), scale3(d, along(p))));
  const mine = b.edges.filter((e) => e.faces.includes(face.index));
  const zs: number[] = [];
  for (const e of mine) {
    if (e.circle) zs.push(along(e.circle.c));
    for (const vi of e.v) if (b.vertices[vi]) zs.push(along(b.vertices[vi].p));
  }
  if (!zs.length) throw new Error('the cylindrical face has no ends');
  const lo = min(...zs), hi = max(...zs);
  const tol = 1e-6 * max(R, hi - lo);
  const internal = !face.outward;
  /** Whether the faces bordering the face at axial position z leave room for the groove to run out. */
  const open = (z: number) => {
    const across = mine.filter((e) => e.circle && abs(along(e.circle.c) - z) <= tol).map((e) => (e.faces[0] === face.index ? e.faces[1] : e.faces[0]));
    if (!across.length) return false;
    return across.every((fi) => {
      // where the neighbour goes from its edge on this face: in towards the axis or out
      const rs = b.edges.filter((e) => e.faces.includes(fi) && !e.faces.includes(face.index)).flatMap((e) => [
        radial(e.mid), ...e.v.map((vi) => (b.vertices[vi] ? radial(b.vertices[vi].p) : R)),
      ]);
      const inward = !rs.length || rs.some((r) => r < R - tol);
      return internal ? !inward : inward;
    });
  };
  const atLo = open(lo), atHi = open(hi);
  let fromLo = atLo || !atHi;
  if (flip) fromLo = !fromLo;
  const length = hi - lo;
  return {
    o: add3(p0, scale3(d, fromLo ? lo : hi)), axis: fromLo ? d : scale3(d, -1), radius: R, length, internal,
    openStart: fromLo ? atLo : atHi, openEnd: fromLo ? atHi : atLo,
  };
}

/**
 * The groove of an ISO thread on a face: its section (the basic profile's gap between two
 * teeth, carried on straight past the crest into the air so it cuts cleanly, never wider
 * than the pitch) and where it runs. From an open start it begins a pitch outside the
 * material; it ends `length` along (its centre there; the whole face when undefined: past
 * an open far end, or half a groove short of a closed one so it does not notch the
 * shoulder). The material it takes away per unit length is grooveArea between the face's
 * radius and the other diameter.
 */
export function threadGeometry(s: ThreadSize, f: ThreadFace, o: { length?: number; offset?: number; left?: boolean }, unit?: string): ThreadGeom {
  const w = (v: number) => sizeWords(v, unit);
  const R = f.radius, P = s.P;
  if (!f.internal && abs(2 * R - s.d) > 0.02 * s.d) throw new Error(`the shaft is Ø${w(2 * R)}: an ${s.name} thread needs Ø${w(s.d)}`);
  if (f.internal && !(2 * R >= s.d1 - 0.02 * s.d && 2 * R < s.d)) throw new Error(`the hole is Ø${w(2 * R)}: an ${s.name} thread needs a hole between Ø${w(s.d1)} and Ø${w(s.d)} (tap drill Ø${w(s.drill)})`);
  // corners (r, z) of the gap between the teeth, from the inside out. The flanks go on a
  // little past the face (a corner on it would put an edge of the groove on the surface it
  // cuts, which the boolean cannot take), then straight on into the air
  const past = 0.05 * P, ext = 0.25 * P;
  let section: [number, number][];
  if (!f.internal) {
    const r1 = s.d1 / 2, re = max(s.d / 2, R) + past, ro = max(s.d / 2, R) + ext;
    const w1 = grooveWidth(s, r1, false), we = min(grooveWidth(s, re, false), 0.97 * P);
    const rc = s.d1 / 2 + (we - w1) / (2 * Math.tan(PI / 6));
    section = [[r1, -w1 / 2], [rc, -we / 2], [ro, -we / 2], [ro, we / 2], [rc, we / 2], [r1, w1 / 2]];
  } else {
    const r2 = s.d / 2, re = R - past, ri = R - ext;
    const w2 = grooveWidth(s, r2, true), we = min(grooveWidth(s, re, true), 0.97 * P);
    const rc = r2 - (we - w2) / (2 * Math.tan(PI / 6));
    section = [[ri, -we / 2], [rc, -we / 2], [r2, -w2 / 2], [r2, w2 / 2], [rc, we / 2], [ri, we / 2]];
  }
  // half the groove's width, and a little more, keeps its ends off a closed end's face
  const keep = max(...section.map(([, z]) => abs(z))) + 0.05 * P;
  const offset = o.offset ?? 0;
  if (offset < 0) throw new Error('the thread offset must not be negative');
  if (offset >= f.length) throw new Error(`the offset ${w(offset)} is past the end of the face (${w(f.length)} long)`);
  // from an open end the groove starts outside; otherwise its start stays inside the face
  const z0 = f.openStart ? (offset > 0 ? offset : -P) : max(offset, keep);
  let z1: number;
  if (o.length === undefined) z1 = f.openEnd ? f.length + P : f.length - keep;
  else {
    if (!(o.length > 0)) throw new Error('the thread length must be positive');
    if (offset + o.length > f.length * (1 + 1e-9) + (f.openEnd ? P : 0)) throw new Error(`the thread (${w(o.length)} from ${offset ? w(offset) : 'the end'}) is longer than the face (${w(f.length)})`);
    z1 = offset + o.length;
    if (!f.openEnd) z1 = min(z1, f.length - keep);
  }
  if (!(z1 > z0)) throw new Error(`the face (${w(f.length)} long) is too short for an ${s.name} thread`);
  const x0 = abs(f.axis[2]) < 0.9 ? norm3(cross3([0, 0, 1], f.axis)) : norm3(cross3([1, 0, 0], f.axis));
  const rs = section.map(([r]) => r);
  return { o: f.o, axis: f.axis, x: x0, pitch: P, ...(o.left ? { left: true } : {}), z0, z1, section, r: (min(...rs) + max(...rs)) / 2 };
}
