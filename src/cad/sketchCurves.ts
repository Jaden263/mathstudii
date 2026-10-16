// The curve of every sketch entity as profile segments: the one place that knows how a
// spline's points, an ellipse's axes or a text's string become geometry. Profiles, both
// kernels, the 2-D and 3-D views, hit testing and the sketch tools all go through here,
// so they all see the same curve.
import type { CadEllipse, CadEntity, CadSpline } from './model';
import type { Loop, Seg, Vec2 } from './profile';
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
  if (e.mode === 'control') return controlSpline(Q, e.closed);
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
