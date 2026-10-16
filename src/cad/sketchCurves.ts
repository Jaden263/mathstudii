// The curve of every sketch entity as profile segments: the one place that knows how a
// spline's points, an ellipse's axes or a text's string become geometry. Profiles, both
// kernels, the 2-D and 3-D views, hit testing and the sketch tools all go through here,
// so they all see the same curve.
import type { CadEllipse, CadEntity, CadSpline } from './model';
import { segBreaks, segDeriv, segPoint, type Loop, type Seg, type Vec2 } from './profile';
import { controlSpline, ellipseParam, interpolate, sweepCCW, type BSpline, type Ellipse } from './curves';
import { textLoops } from './text';

export type PointAt = (id: string) => Vec2 | undefined;
export type RadiusAt = (id: string) => number | undefined;

/** The B-spline of a spline entity: through its fit points (tangent handles at the ends) or on its poles. Null when degenerate. */
export function splineOf(e: CadSpline, P: PointAt): BSpline | null {
  const Q: Vec2[] = [];
  for (const id of e.pts) {
    const p = P(id);
    if (!p) return null;
    Q.push(p);
  }
  if (e.mode === 'control') {
    const deg = e.knots ? e.knots.length - Q.length - 1 : 0;
    if (e.knots && !e.closed && deg >= 1 && deg <= 3) return { deg, poles: Q.map((q) => ({ ...q })), knots: e.knots };
    return controlSpline(Q, e.closed);
  }
  const h0 = e.h1 ? P(e.h1) : undefined, h1 = e.h2 ? P(e.h2) : undefined;
  return interpolate(Q, { closed: e.closed, h0: e.closed ? undefined : h0, h1: e.closed ? undefined : h1 })?.curve ?? null;
}

/** The full ellipse of an ellipse entity (its first axis from the centre to `a`). */
export function ellipseOf(e: CadEllipse, P: PointAt, R?: RadiusAt): Ellipse | null {
  const c = P(e.c), a = P(e.a);
  if (!c || !a) return null;
  const ra = Math.hypot(a.x - c.x, a.y - c.y), rb = Math.abs(R?.(e.id) ?? e.r);
  if (!(ra > 0 && rb > 0)) return null;
  return { c, ra, rb, rot: Math.atan2(a.y - c.y, a.x - c.x) };
}

/** The ends of an open curve (lines, arcs, elliptical arcs, open splines), or null. */
export function entityEnds(e: CadEntity): [string, string] | null {
  switch (e.type) {
    case 'line':
    case 'arc': return [e.p1, e.p2];
    case 'ellipse': return e.p1 && e.p2 ? [e.p1, e.p2] : null;
    case 'spline': return e.closed ? null : [e.pts[0], e.pts[e.pts.length - 1]];
    default: return null;
  }
}

/** The segments of an entity's curve (none for points and degenerate curves). */
export function entitySegs(e: CadEntity, P: PointAt, R?: RadiusAt): Seg[] {
  switch (e.type) {
    case 'line': {
      const a = P(e.p1), b = P(e.p2);
      return a && b ? [{ kind: 'line', a, b }] : [];
    }
    case 'circle': {
      const c = P(e.c), r = Math.abs(R?.(e.id) ?? e.r);
      return c && r > 0 ? [{ kind: 'arc', c, r, a0: 0, a1: 2 * Math.PI }] : [];
    }
    case 'arc': {
      const c = P(e.c), a = P(e.p1), b = P(e.p2);
      if (!c || !a || !b) return [];
      const a0 = Math.atan2(a.y - c.y, a.x - c.x);
      return [{ kind: 'arc', c, r: Math.hypot(a.x - c.x, a.y - c.y), a0, a1: a0 + sweepCCW(a0, Math.atan2(b.y - c.y, b.x - c.x)) }];
    }
    case 'ellipse': {
      const el = ellipseOf(e, P, R);
      if (!el) return [];
      if (!e.p1 || !e.p2) return [{ kind: 'ellipse', ...el, t0: 0, t1: 2 * Math.PI }];
      const a = P(e.p1), b = P(e.p2);
      if (!a || !b) return [];
      const t0 = ellipseParam(el, a);
      return [{ kind: 'ellipse', ...el, t0, t1: t0 + sweepCCW(t0, ellipseParam(el, b)) }];
    }
    case 'spline': {
      const s = splineOf(e, P);
      return s ? [{ kind: 'bspline', ...s }] : [];
    }
    case 'text': {
      const p = P(e.p);
      return p ? textLoops(e.text, e.size, e.angle ?? 0, p, e.id).flatMap((l) => l.segs) : [];
    }
    case 'point': return [];
  }
}

/** Entities that are closed by themselves (circles, ellipses, closed splines, text) as loops; null for open ones. */
export function entityLoops(e: CadEntity, P: PointAt, R?: RadiusAt): Loop[] | null {
  if (e.type === 'text') {
    const p = P(e.p);
    return p ? textLoops(e.text, e.size, e.angle ?? 0, p, e.id) : [];
  }
  const closed = e.type === 'circle' || (e.type === 'ellipse' && !(e.p1 && e.p2)) || (e.type === 'spline' && !!e.closed);
  if (!closed) return null;
  return entitySegs(e, P, R).map((s) => ({ segs: [s], entities: [e.id] }));
}

/** Every point id an entity's curve depends on (handles included). */
export const curvePoints = (e: CadEntity): string[] => {
  switch (e.type) {
    case 'line': return [e.p1, e.p2];
    case 'circle': return [e.c];
    case 'arc': return [e.c, e.p1, e.p2];
    case 'ellipse': return [e.c, e.a, ...(e.p1 && e.p2 ? [e.p1, e.p2] : [])];
    case 'spline': return [...e.pts, ...(e.h1 ? [e.h1] : []), ...(e.h2 ? [e.h2] : [])];
    case 'text':
    case 'point': return [e.p];
  }
};

// ------------------------------------------------------------ crossings of curves

const { abs, max, min, hypot, PI } = Math;
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v: Vec2) => hypot(v.x, v.y);
const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;

/** Points along a segment with their parameters (fine enough to find crossings between them). */
function sampled(s: Seg): { t: number; p: Vec2 }[] {
  if (s.kind === 'line') return [{ t: 0, p: s.a }, { t: 1, p: s.b }];
  const br = segBreaks(s, PI / 16);
  const out: { t: number; p: Vec2 }[] = [];
  for (let k = 0; k + 1 < br.length; k++) {
    const n = s.kind === 'bspline' ? 48 : 12;
    for (let i = 0; i < n; i++) {
      const t = br[k] + ((br[k + 1] - br[k]) * i) / n;
      out.push({ t, p: segPoint(s, t) });
    }
  }
  out.push({ t: 1, p: segPoint(s, 1) });
  return out;
}

/** Where two segments cross: polylines first, then Newton on the curves themselves. */
export function segCrossings(A: Seg, B: Seg): { p: Vec2; s: number; t: number }[] {
  const a = sampled(A), b = sampled(B);
  const out: { p: Vec2; s: number; t: number }[] = [];
  let size = 1;
  for (const q of [...a, ...b]) size = max(size, abs(q.p.x), abs(q.p.y));
  for (let i = 0; i + 1 < a.length; i++) {
    const p0 = a[i].p, p1 = a[i + 1].p, r = sub(p1, p0);
    for (let j = 0; j + 1 < b.length; j++) {
      const q0 = b[j].p, q1 = b[j + 1].p, w = sub(q1, q0);
      const den = cross(r, w);
      if (abs(den) < 1e-14 * len(r) * len(w)) continue;
      const u = cross(sub(q0, p0), w) / den, v = cross(sub(q0, p0), r) / den;
      if (u < -1e-9 || u > 1 + 1e-9 || v < -1e-9 || v > 1 + 1e-9) continue;
      let s = a[i].t + (a[i + 1].t - a[i].t) * u, t = b[j].t + (b[j + 1].t - b[j].t) * v;
      for (let it = 0; it < 30; it++) {
        const F = sub(segPoint(A, s), segPoint(B, t)), da = segDeriv(A, s), db = segDeriv(B, t);
        const det = -da.x * db.y + db.x * da.y;
        if (!(abs(det) > 0)) break;
        const ds = (-F.x * -db.y + db.x * -F.y) / det, dt = (da.x * -F.y - -F.x * da.y) / det;
        s = min(1, max(0, s + ds));
        t = min(1, max(0, t + dt));
        if (abs(ds) + abs(dt) < 1e-15) break;
      }
      const p = segPoint(A, s);
      if (len(sub(p, segPoint(B, t))) > 1e-7 * size) continue;
      if (!out.some((x) => len(sub(x.p, p)) < 1e-9 * size)) out.push({ p, s, t });
    }
  }
  return out;
}

