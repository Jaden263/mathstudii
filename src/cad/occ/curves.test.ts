// Splines, ellipses and text on the B-rep kernel. The OCCT curves are the sketch's own
// (the same poles and knots, a true gp_Elips), so an extrusion's volume is the profile's
// Green's-theorem area times its height to rounding: V = πab·h for an ellipse, A·h for a
// spline profile with A from the dense curve, (2π r²)·L along a spline path by Pappus.
// Text: capitals stand capHeight × size tall (694/1000 in this font), counters are holes.
import { describe, expect, it } from 'vitest';
import { rect, single, solve, volumes, watchHandles } from './fixtures';
import { occ, setOccEnabled, scratch, xyz } from './kernel';
import { buildDesignOcc } from './build';
import type { DesignItem } from '../design';
import type { CadSketch } from '../model';
import { bsDomain, bsEval, bsPoint, interpolate } from '../curves';
import { findProfiles, profileProperties, type Vec2 } from '../profile';
import { capHeight } from '../text';

const { PI, abs, hypot } = Math;
const near = (v: number, want: number, rel = 1e-9) => expect(abs(v - want) / abs(want)).toBeLessThan(rel);

const ellipse = (a: number, b: number, extra: Partial<CadSketch> = {}): CadSketch => ({
  points: [{ id: 'c', x: 0, y: 0 }, { id: 'a', x: a, y: 0 }],
  entities: [{ id: 'e', type: 'ellipse', c: 'c', a: 'a', r: b }],
  constraints: [],
  ...extra,
});
const RING: Vec2[] = [{ x: 0, y: 0 }, { x: 40, y: -5 }, { x: 55, y: 30 }, { x: 20, y: 45 }, { x: -10, y: 25 }];
const closedSpline = (pts: Vec2[], mode?: 'control'): CadSketch => ({
  points: pts.map((p, i) => ({ id: `q${i}`, ...p })),
  entities: [{ id: 's', type: 'spline', pts: pts.map((_, i) => `q${i}`), closed: true, ...(mode ? { mode } : {}) }],
  constraints: [],
});
const text = (s: string, size: number): CadSketch => ({
  points: [{ id: 'p', x: 0, y: 0 }],
  entities: [{ id: 't', type: 'text', p: 'p', text: s, size }],
  constraints: [],
});
const extrude = (sk: CadSketch, d = 10): DesignItem[] => [
  { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: sk },
  { kind: 'extrude', id: 'f1', name: 'E', sketch: 's1', extent: { type: 'one', d: String(d) }, op: 'new' },
];

/** Shoelace area of the curve sampled densely by parameter. */
function denseArea(pts: Vec2[], closed: boolean): number {
  const c = interpolate(pts, { closed })!.curve;
  const [a, b] = bsDomain(c), n = 200000;
  let s = 0, prev = bsPoint(c, a);
  for (let i = 1; i <= n; i++) {
    const q = bsPoint(c, a + ((b - a) * i) / n);
    s += prev.x * q.y - q.x * prev.y;
    prev = q;
  }
  return abs(s / 2);
}

describe('ellipses on the B-rep kernel', () => {
  it('an extruded ellipse: V = πab·h', () => {
    const { res } = solve(single(extrude(ellipse(30, 12), 10)));
    expect(res.featureError).toBeUndefined();
    expect(res.design!.brep).toBe(true);
    near(volumes(res)[0], PI * 30 * 12 * 10);
  });

  it('an ellipse whose drawn axis is the shorter one (gp_Elips wants the major radius first)', () => {
    const { res } = solve(single(extrude(ellipse(8, 20), 5)));
    near(volumes(res)[0], PI * 8 * 20 * 5);
  });

  it('an elliptical arc closed by its chord: half the ellipse, πab/2·h', () => {
    const sk: CadSketch = {
      points: [{ id: 'c', x: 0, y: 0 }, { id: 'a', x: 30, y: 0 }, { id: 'p', x: 30, y: 0 }, { id: 'q', x: -30, y: 0 }],
      entities: [{ id: 'e', type: 'ellipse', c: 'c', a: 'a', r: 12, p1: 'p', p2: 'q' }, { id: 'l', type: 'line', p1: 'q', p2: 'p' }],
      constraints: [],
    };
    const { res } = solve(single(extrude(sk, 4)));
    expect(res.featureError).toBeUndefined();
    near(volumes(res)[0], (PI * 30 * 12 * 4) / 2);
  });

  it('the mesh kernel builds it from a fine polygon (within 2·10⁻⁴)', () => {
    setOccEnabled(false);
    try {
      const { res } = solve(single(extrude(ellipse(30, 12), 10)));
      expect(res.design!.brep).toBeFalsy();
      near(volumes(res)[0], PI * 30 * 12 * 10, 2e-4);
    } finally {
      setOccEnabled(true);
    }
  });
});

describe('splines on the B-rep kernel', () => {
  it('an extruded closed spline: V = A·h with A from Green on the dense curve (1e-6)', () => {
    const { res } = solve(single(extrude(closedSpline(RING), 7)));
    expect(res.featureError).toBeUndefined();
    near(volumes(res)[0], denseArea(RING, true) * 7, 1e-6);
    // and to rounding against the profile's own (span-exact) integral
    near(volumes(res)[0], profileProperties(findProfiles(closedSpline(RING)).regions)!.A * 7, 1e-9);
  });

  it('a closed control-point spline extrudes as its profile', () => {
    const sk = closedSpline(RING, 'control');
    const { res } = solve(single(extrude(sk, 3)));
    near(volumes(res)[0], profileProperties(findProfiles(sk).regions)!.A * 3, 1e-9);
  });

  it('the OCCT edge is the sketch curve: through the fit points (1e-9) and on the polyline', () => {
    const Q = [{ x: 0, y: 0 }, { x: 20, y: 15 }, { x: 45, y: 8 }, { x: 60, y: 30 }];
    const sk: CadSketch = {
      points: Q.map((p, i) => ({ id: `q${i}`, ...p })),
      entities: [{ id: 's', type: 'spline', pts: ['q0', 'q1', 'q2', 'q3'] }, { id: 'l', type: 'line', p1: 'q3', p2: 'q0' }],
      constraints: [],
    };
    const d = single(extrude(sk, 5));
    const { numbers, res } = solve(d);
    expect(res.featureError).toBeUndefined();
    const oc = occ()!;
    const built = buildDesignOcc(oc, d, numbers);
    try {
      const { curve, params } = interpolate(Q)!;
      const us = [...params, ...Array.from({ length: 41 }, (_, i) => i / 40)];
      // the spline's edge on the bottom cap, evaluated at the fit points' parameters and along it
      const found = scratch((t) => {
        const ex = t.add(new oc.TopExp_Explorer(built.components.get('c1')!.bodies[0].solid.shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
        for (; ex.More(); ex.Next()) {
          const a = t.add(new oc.BRepAdaptor_Curve(t.add(oc.TopoDS.Edge(t.add(ex.Current())))));
          if (a.GetType() !== oc.GeomAbs_CurveType.GeomAbs_BSplineCurve) continue;
          const at = (u: number) => xyz(t.add(a.EvalD0(u)));
          if (abs(at(a.FirstParameter())[2]) > 1e-9) continue;
          return { u0: a.FirstParameter(), u1: a.LastParameter(), pts: us.map(at) };
        }
        return null;
      });
      expect(found).not.toBeNull();
      expect(found!.u0).toBe(0);
      expect(found!.u1).toBe(1);
      params.forEach((_, i) => expect(hypot(found!.pts[i][0] - Q[i].x, found!.pts[i][1] - Q[i].y)).toBeLessThan(1e-9));
      for (let i = 0; i <= 40; i++) {
        const p = found!.pts[params.length + i], q = bsPoint(curve, i / 40);
        expect(hypot(p[0] - q.x, p[1] - q.y)).toBeLessThan(1e-9);
      }
    } finally {
      built.free();
    }
  });

  it('a circle swept along an open spline path: V = πr²·L (Pappus)', () => {
    // the path on XZ from the origin; its tangent at the start is the profile's normal (z)
    const path = [{ x: 0, y: 0 }, { x: 5, y: 30 }, { x: 25, y: 55 }, { x: 60, y: 70 }];
    const pathSk: CadSketch = {
      points: [...path.map((p, i) => ({ id: `w${i}`, ...p })), { id: 'h', x: 0, y: 10 }],
      entities: [{ id: 'sp', type: 'spline', pts: path.map((_, i) => `w${i}`), h1: 'h' }],
      constraints: [],
    };
    const r = 2;
    const { res } = solve(single([
      { kind: 'sketch', id: 's1', name: 'Profile', plane: { ref: 'XY' }, sketch: { points: [{ id: 'c', x: 0, y: 0 }], entities: [{ id: 'k', type: 'circle', c: 'c', r }], constraints: [] } },
      { kind: 'sketch', id: 's2', name: 'Path', plane: { ref: 'XZ' }, sketch: pathSk },
      { kind: 'sweep', id: 'f1', name: 'Sweep', sketch: 's1', path: { kind: 'sketch', sketch: 's2' }, op: 'new' },
    ]));
    expect(res.design!.errors).toEqual({});
    // the path's length by Gauss–Legendre on its spans
    const c = interpolate(path, { h0: { x: 0, y: 10 } })!.curve;
    let L = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const d = bsEval(c, (i + 0.5) / n, 1)[1];
      L += hypot(d.x, d.y) / n;
    }
    // OCCT approximates the swept surface (a B-spline pipe), and its volume integral on such
    // faces is good to about 10⁻⁵ (occ/kernel.ts volumeProperties)
    near(volumes(res)[0], PI * r * r * L, 3e-5);
  });
});

describe('text', () => {
  it('extruded text has a positive volume equal to its outline area × height', () => {
    const sk = text('Text 42', 10);
    const { regions } = findProfiles(sk);
    const A = profileProperties(regions)!.A;
    expect(A).toBeGreaterThan(0);
    const { res } = solve(single(extrude(sk, 2)));
    expect(res.featureError).toBeUndefined();
    const V = volumes(res).reduce((a, b) => a + b, 0);
    near(V, A * 2, 1e-9);
  });

  it('capitals stand capHeight × size tall: an "H" of size 20 is 13.88 high', () => {
    expect(capHeight()).toBeCloseTo(0.694, 12);
    const { res } = solve(single(extrude(text('H', 20), 1)));
    const box = res.design!.box!;
    expect(box.max[1] - box.min[1]).toBeCloseTo(0.694 * 20, 9);
    expect(box.min[1]).toBeCloseTo(0, 9);
  });

  it('an "o" has a hole: one region with one hole, the solid a ring', () => {
    const { regions } = findProfiles(text('o', 10));
    expect(regions).toHaveLength(1);
    expect(regions[0].holes).toHaveLength(1);
    const outer = profileProperties([{ outer: regions[0].outer, holes: [] }])!.A;
    const { res } = solve(single(extrude(text('o', 10), 1)));
    expect(volumes(res)[0]).toBeLessThan(outer * 0.8);
    // 'a' and 'e' have their counters too, 'B' two
    expect(findProfiles(text('a', 10)).regions[0].holes).toHaveLength(1);
    expect(findProfiles(text('e', 10)).regions[0].holes).toHaveLength(1);
    expect(findProfiles(text('B', 10)).regions[0].holes).toHaveLength(2);
  });

  it('cut into a plate (engraving): the plate loses the letters\' area × depth', () => {
    const plate: DesignItem[] = [
      { kind: 'sketch', id: 's0', name: 'Plate', plane: { ref: 'XY' }, sketch: rect('r', -5, -5, 60, 20) },
      { kind: 'extrude', id: 'f0', name: 'Plate', sketch: 's0', extent: { type: 'one', d: '5' }, op: 'new' },
    ];
    const sk = text('CAD', 12);
    const A = profileProperties(findProfiles(sk).regions)!.A;
    const { res } = solve(single([
      ...plate,
      { kind: 'sketch', id: 's1', name: 'Text', plane: { ref: 'XY', offset: '5' }, sketch: sk },
      { kind: 'extrude', id: 'f1', name: 'Engrave', sketch: 's1', extent: { type: 'one', d: '1.5' }, op: 'cut' },
    ]));
    expect(res.featureError).toBeUndefined();
    near(volumes(res)[0], 65 * 25 * 5 - A * 1.5, 1e-9);
  });
});

describe('B-rep handles', () => {
  it('deletes every OCCT object of ellipses, splines and text', () => {
    const oc = occ()!;
    const arcSk: CadSketch = {
      points: [{ id: 'c', x: 0, y: 0 }, { id: 'a', x: 30, y: 0 }, { id: 'p', x: 30, y: 0 }, { id: 'q', x: -30, y: 0 }],
      entities: [{ id: 'e', type: 'ellipse', c: 'c', a: 'a', r: 12, p1: 'p', p2: 'q' }, { id: 'l', type: 'line', p1: 'q', p2: 'p' }],
      constraints: [],
    };
    for (const sk of [ellipse(30, 12), arcSk, closedSpline(RING), text('Ok', 10)]) {
      const d = single(extrude(sk, 3));
      const { numbers } = solve(d);
      const watch = watchHandles(oc);
      try {
        const built = buildDesignOcc(oc, d, numbers);
        expect(Object.values(built.components.get('c1')!.errors)).toEqual([]);
        built.free();
        expect(watch.undeleted()).toEqual([]);
      } finally {
        watch.stop();
      }
    }
  });
});
