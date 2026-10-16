// A rib's own geometry: its open curve as one chain in the sketch plane, and the strip the
// curve sweeps towards the body. The kernel cuts the bodies out of that strip and keeps the
// pieces that start at the curve, so the rib closes against whatever faces it meets.
import type { CadSketch } from './model';
import { loopMoment, segPoint, type Loop, type ProfileRegion, type Seg, type Vec2 } from './profile';
import { sketchPath, type PathSeg } from './sweep';
import type { Frame, Vec3 } from './solid';

const { PI, atan2, hypot, abs } = Math;

/** The sketch plane itself: sketch coordinates in, sketch coordinates out. */
const PLANE: Frame = { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };

export interface RibCurve {
  /** Lines and arcs from one end to the other (sketch coordinates). */
  segs: Seg[];
  /** The sketch entity of each. */
  ids: string[];
  a: Vec2;
  b: Vec2;
  /** Unit normal of the chord a → b in the plane, to its left. */
  n: Vec2;
  /** Length of the chord. */
  chord: number;
  /** Half way along the curve. */
  mid: Vec2;
}

const sub = (p: Vec2, q: Vec2): Vec2 => ({ x: p.x - q.x, y: p.y - q.y });
const plus = (p: Vec2, d: Vec2): Vec2 => ({ x: p.x + d.x, y: p.y + d.y });
const flat = (p: Vec3): Vec2 => ({ x: p[0], y: p[1] });

/** A three-point arc as an arc about its centre, from a to b through m. */
function arcSeg(a: Vec2, m: Vec2, b: Vec2): Seg {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  const A = a.x * a.x + a.y * a.y, M = m.x * m.x + m.y * m.y, B = b.x * b.x + b.y * b.y;
  const c = { x: (A * (m.y - b.y) + M * (b.y - a.y) + B * (a.y - m.y)) / d, y: (A * (b.x - m.x) + M * (a.x - b.x) + B * (m.x - a.x)) / d };
  const a0 = atan2(a.y - c.y, a.x - c.x);
  const turn = (p: Vec2) => (((atan2(p.y - c.y, p.x - c.x) - a0) % (2 * PI)) + 2 * PI) % (2 * PI);
  const tm = turn(m), tb = turn(b);
  // anticlockwise when the middle comes first going that way round
  return { kind: 'arc', c, r: hypot(a.x - c.x, a.y - c.y), a0, a1: tm < tb ? a0 + tb : a0 - (2 * PI - tb) };
}

function toSeg(s: PathSeg): Seg {
  if (s.kind === 'line') return { kind: 'line', a: flat(s.a), b: flat(s.b) };
  if (s.kind === 'arc') return arcSeg(flat(s.a), flat(s.m), flat(s.b));
  throw new Error('a rib is made from an open curve, not a circle');
}

const segLength = (s: Seg) => (s.kind === 'line' ? hypot(s.b.x - s.a.x, s.b.y - s.a.y) : s.r * abs(s.a1 - s.a0));

const reversed = (s: Seg): Seg => (s.kind === 'line' ? { kind: 'line', a: s.b, b: s.a } : { ...s, a0: s.a1, a1: s.a0 });

/**
 * The curve of a rib: the lines and arcs of its sketch joined end to end into one open chain
 * that runs one way along its chord (the strip it sweeps would otherwise fold over itself).
 */
export function ribCurve(sk: CadSketch, sol: { points: Record<string, [number, number]>; radii: Record<string, number> }, curves?: string[]): RibCurve {
  const chosen = sk.entities.filter((e) => e.type !== 'point' && (curves?.length ? curves.includes(e.id) : !e.construction));
  if (chosen.some((e) => e.type === 'circle')) throw new Error('a rib is made from an open curve: lines and arcs, not a circle');
  let path: ReturnType<typeof sketchPath>;
  try {
    path = sketchPath(sk, sol, PLANE, curves);
  } catch (e) {
    // the sweep's words for a path, said of a rib
    const m = (e instanceof Error ? e.message : String(e))
      .replace('the path sketch', 'the rib’s sketch').replace('the path curves', 'the rib’s curves').replace('the path branches', 'the rib’s curves branch').replace('the path has', 'the rib’s sketch has');
    throw new Error(m);
  }
  if (path.closed) throw new Error('the rib’s curve is closed: a rib is made from an open curve (extrude a closed profile)');
  const segs = path.segs.map(toSeg);
  const a = segPoint(segs[0], 0), b = segPoint(segs[segs.length - 1], 1);
  const c = sub(b, a), chord = hypot(c.x, c.y);
  const total = segs.reduce((s, q) => s + segLength(q), 0);
  if (!(chord > 1e-9 * total)) throw new Error('the rib’s curve ends where it starts: a rib is made from an open curve');
  const e = { x: c.x / chord, y: c.y / chord };
  // every piece must go on along the chord, never back
  for (const s of segs) {
    const n = s.kind === 'line' ? 1 : 32;
    for (let i = 0; i < n; i++) {
      const p = segPoint(s, i / n), q = segPoint(s, (i + 1) / n);
      if ((q.x - p.x) * e.x + (q.y - p.y) * e.y < -1e-9 * total) {
        throw new Error('the rib’s curve turns back on itself: it must run one way from end to end — make two ribs');
      }
    }
  }
  // half way along it
  let left = total / 2, mid = a;
  for (const s of segs) {
    const L = segLength(s);
    if (left <= L) {
      mid = segPoint(s, L > 0 ? left / L : 0);
      break;
    }
    left -= L;
  }
  return { segs, ids: path.ids, a, b, n: { x: -e.y, y: e.x }, chord, mid };
}

/**
 * The strip the curve sweeps along its normal (side +1: the normal's way, −1: the other)
 * for `depth`, as a profile region: the curve, its end, the curve moved, its start. The
 * faces take the curve's entities, and `start`, `end`, `far…` for the others.
 */
export function ribRegion(c: RibCurve, side: 1 | -1, depth: number): ProfileRegion {
  const d = { x: c.n.x * side * depth, y: c.n.y * side * depth };
  const moved = (s: Seg): Seg => (s.kind === 'line' ? { kind: 'line', a: plus(s.a, d), b: plus(s.b, d) } : { ...s, c: plus(s.c, d) });
  const far = c.segs.map(moved).reverse().map(reversed);
  let loop: Loop = {
    segs: [...c.segs, { kind: 'line', a: c.b, b: plus(c.b, d) }, ...far, { kind: 'line', a: plus(c.a, d), b: c.a }],
    entities: [...c.ids, 'end', ...far.map((_, i) => `far${i}`), 'start'],
  };
  // loops run anticlockwise
  if (loopMoment(loop, 0, 0) < 0) loop = { segs: loop.segs.map(reversed).reverse(), entities: [...loop.entities].reverse() };
  return { outer: loop, holes: [] };
}
