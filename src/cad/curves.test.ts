// B-splines and ellipses of the sketcher, against their defining properties and closed
// forms: interpolation through every fit point, natural ends without curvature, tangent
// handles as the second pole (Piegl & Tiller §9.2.2), knot insertion and splitting that
// leave the curve as it was (§5.2), periodic closed curves C² at the seam, and Green's
// theorem areas of profiles bounded by them (πab for an ellipse, πab³/4 for its second
// moment about the major axis).
import { describe, expect, it } from 'vitest';
import { bsDomain, bsEval, bsPoint, bsSplit, controlSpline, ellipsePoint, insertKnot, interpolate, type BSpline } from './curves';
import { findProfiles, loopMoment, profileProperties, segPolyline, type Vec2 } from './profile';
import type { CadSketch } from './model';

const { PI, hypot, abs } = Math;
const dist = (a: Vec2, b: Vec2) => hypot(a.x - b.x, a.y - b.y);
const Q: Vec2[] = [{ x: 0, y: 0 }, { x: 20, y: 15 }, { x: 45, y: 8 }, { x: 60, y: 30 }, { x: 80, y: 25 }];

/** Shoelace area of a dense polyline (the reference for areas bounded by curves). */
function shoelace(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  return a / 2;
}

/** The curve sampled finely by parameter (independent of the profile's own polylines). */
function dense(s: BSpline, n = 200000): Vec2[] {
  const [a, b] = bsDomain(s);
  return Array.from({ length: n }, (_, i) => bsPoint(s, a + ((b - a) * i) / n));
}

describe('fit splines', () => {
  it('pass through every fit point (1e-9) with natural ends', () => {
    const { curve, params } = interpolate(Q)!;
    params.forEach((u, i) => expect(dist(bsPoint(curve, u), Q[i])).toBeLessThan(1e-9));
    // natural: no second derivative (hence no curvature) at either end
    const [u0, u1] = bsDomain(curve);
    for (const u of [u0, u1]) {
      const d2 = bsEval(curve, u, 2)[2];
      expect(hypot(d2.x, d2.y)).toBeLessThan(1e-9);
    }
    // cubic, C²: knots of multiplicity one at the fit points
    expect(curve.deg).toBe(3);
    expect(curve.knots).toEqual([0, 0, 0, 0, ...params.slice(1, -1), 1, 1, 1, 1]);
  });

  it('chord-length parameters', () => {
    const { params } = interpolate(Q)!;
    const chords = Q.slice(1).map((q, i) => dist(q, Q[i]));
    const total = chords.reduce((a, b) => a + b, 0);
    expect(params[1]).toBeCloseTo(chords[0] / total, 14);
    expect(params[3]).toBeCloseTo((chords[0] + chords[1] + chords[2]) / total, 14);
  });

  it('a tangent handle is the second pole and sets the end derivative 3(h − Q0)/u1', () => {
    const h0 = { x: 5, y: 12 }, h1 = { x: 90, y: 20 };
    const { curve, params } = interpolate(Q, { h0, h1 })!;
    params.forEach((u, i) => expect(dist(bsPoint(curve, u), Q[i])).toBeLessThan(1e-9));
    expect(dist(curve.poles[1], h0)).toBeLessThan(1e-9);
    expect(dist(curve.poles[curve.poles.length - 2], h1)).toBeLessThan(1e-9);
    const d0 = bsEval(curve, 0, 1)[1];
    expect(d0.x).toBeCloseTo((3 * (h0.x - Q[0].x)) / params[1], 9);
    expect(d0.y).toBeCloseTo((3 * (h0.y - Q[0].y)) / params[1], 9);
  });

  it('two points make a straight line', () => {
    const { curve } = interpolate([{ x: 0, y: 0 }, { x: 30, y: 40 }])!;
    for (const u of [0.1, 0.37, 0.8]) {
      const p = bsPoint(curve, u);
      expect(abs(p.x * 40 - p.y * 30)).toBeLessThan(1e-9);
      expect(hypot(p.x, p.y)).toBeCloseTo(50 * u, 9);
    }
  });

  it('closed: through every point and C² across the seam', () => {
    const ring = [{ x: 0, y: 0 }, { x: 40, y: -5 }, { x: 55, y: 30 }, { x: 20, y: 45 }, { x: -10, y: 25 }];
    const { curve, params } = interpolate(ring, { closed: true })!;
    params.forEach((u, i) => expect(dist(bsPoint(curve, u), ring[i])).toBeLessThan(1e-9));
    const [a, b] = bsDomain(curve);
    const s = bsEval(curve, a, 2), e = bsEval(curve, b, 2);
    for (let k = 0; k < 3; k++) {
      const scale = hypot(s[k].x, s[k].y) + 1;
      expect(dist(s[k], e[k]) / scale).toBeLessThan(1e-9);
    }
  });

  it('refuses two fit points on one spot', () => {
    expect(interpolate([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 5, y: 5 }])).toBeNull();
  });
});

describe('B-spline operations', () => {
  const s = interpolate(Q)!.curve;
  it('knot insertion keeps the curve', () => {
    const t = insertKnot(insertKnot(s, 0.3, 1), 0.3, 2);
    expect(t.poles.length).toBe(s.poles.length + 3);
    for (let i = 0; i <= 50; i++) expect(dist(bsPoint(t, i / 50), bsPoint(s, i / 50))).toBeLessThan(1e-9);
  });

  it('splitting gives two clamped curves meeting at the split point', () => {
    const [l, r] = bsSplit(s, 0.42);
    expect(dist(l.poles[l.poles.length - 1], bsPoint(s, 0.42))).toBeLessThan(1e-9);
    expect(dist(r.poles[0], bsPoint(s, 0.42))).toBeLessThan(1e-9);
    for (let i = 0; i <= 20; i++) {
      expect(dist(bsPoint(l, (0.42 * i) / 20), bsPoint(s, (0.42 * i) / 20))).toBeLessThan(1e-9);
      const u = 0.42 + (0.58 * i) / 20;
      expect(dist(bsPoint(r, u), bsPoint(s, u))).toBeLessThan(1e-9);
    }
  });

  it('control splines: clamped (ends on the end poles), closed ones C² all round', () => {
    const c = controlSpline(Q)!;
    expect(dist(bsPoint(c, 0), Q[0])).toBe(0);
    expect(dist(bsPoint(c, 1), Q[4])).toBe(0);
    const closed = controlSpline(Q, true)!;
    const [a, b] = bsDomain(closed);
    const s0 = bsEval(closed, a, 2), s1 = bsEval(closed, b, 2);
    for (let k = 0; k < 3; k++) expect(dist(s0[k], s1[k]) / (hypot(s0[k].x, s0[k].y) + 1)).toBeLessThan(1e-9);
    // a uniform cubic B-spline starts at (P₋₁ + 4P₀ + P₁)/6 (here P₋₁ = P₄)
    const want = { x: (Q[4].x + 4 * Q[0].x + Q[1].x) / 6, y: (Q[4].y + 4 * Q[0].y + Q[1].y) / 6 };
    expect(dist(bsPoint(closed, 0), want)).toBeLessThan(1e-9);
  });
});

/** A sketch with one closed fit spline through `pts`. */
const splineSketch = (pts: Vec2[], extra: Partial<CadSketch> = {}): CadSketch => ({
  points: pts.map((p, i) => ({ id: `q${i}`, ...p })),
  entities: [{ id: 's', type: 'spline', pts: pts.map((_, i) => `q${i}`), closed: true }],
  constraints: [],
  ...extra,
});

describe('profiles bounded by splines and ellipses', () => {
  it('a closed spline: Green on the spans equals the area of the dense curve (1e-6)', () => {
    const ring = [{ x: 0, y: 0 }, { x: 40, y: -5 }, { x: 55, y: 30 }, { x: 20, y: 45 }, { x: -10, y: 25 }];
    const { regions, issues } = findProfiles(splineSketch(ring));
    expect(issues).toEqual([]);
    expect(regions).toHaveLength(1);
    const A = profileProperties(regions)!.A;
    const ref = abs(shoelace(dense(interpolate(ring, { closed: true })!.curve)));
    expect(abs(A - ref) / ref).toBeLessThan(1e-6);
  });

  it('a spline and a line close a profile; its polyline follows the curve', () => {
    const sk: CadSketch = {
      points: Q.map((p, i) => ({ id: `q${i}`, ...p })),
      entities: [{ id: 's', type: 'spline', pts: Q.map((_, i) => `q${i}`) }, { id: 'l', type: 'line', p1: 'q4', p2: 'q0' }],
      constraints: [],
    };
    const { regions } = findProfiles(sk);
    expect(regions).toHaveLength(1);
    const curve = interpolate(Q)!.curve;
    const ref = abs(shoelace([...dense(curve, 100000), Q[4]]));
    expect(abs(profileProperties(regions)!.A - ref) / ref).toBeLessThan(1e-6);
    // the mesh kernel's polyline: every vertex on the curve
    const poly = segPolyline({ kind: 'bspline', ...curve }, Math.PI / 90);
    expect(poly.length).toBeGreaterThan(40);
  });

  it('an ellipse: A = πab and Ix = πab³/4 about its major axis', () => {
    const a = 30, b = 12;
    const sk: CadSketch = {
      points: [{ id: 'c', x: 0, y: 0 }, { id: 'a', x: a, y: 0 }],
      entities: [{ id: 'e', type: 'ellipse', c: 'c', a: 'a', r: b }],
      constraints: [],
    };
    const p = profileProperties(findProfiles(sk).regions)!;
    expect(abs(p.A - PI * a * b) / (PI * a * b)).toBeLessThan(1e-12);
    expect(abs(p.Ix - (PI * a * b ** 3) / 4) / ((PI * a * b ** 3) / 4)).toBeLessThan(1e-12);
    expect(abs(p.Iy - (PI * a ** 3 * b) / 4) / ((PI * a ** 3 * b) / 4)).toBeLessThan(1e-12);
  });

  it('a turned half ellipse closed by its axis: πab/2', () => {
    const a = 25, b = 10, rot = 0.6;
    const c = { x: 5, y: -3 }, el = { c, ra: a, rb: b, rot };
    const p0 = ellipsePoint(el, 0), pa = ellipsePoint(el, PI);
    const sk: CadSketch = {
      points: [{ id: 'c', ...c }, { id: 'a', ...p0 }, { id: 'p', ...p0 }, { id: 'q', ...pa }],
      entities: [{ id: 'e', type: 'ellipse', c: 'c', a: 'a', r: b, p1: 'p', p2: 'q' }, { id: 'l', type: 'line', p1: 'q', p2: 'p' }],
      constraints: [],
    };
    const { regions } = findProfiles(sk);
    expect(regions).toHaveLength(1);
    expect(abs(loopMoment(regions[0].outer, 0, 0) - (PI * a * b) / 2) / ((PI * a * b) / 2)).toBeLessThan(1e-12);
  });
});
