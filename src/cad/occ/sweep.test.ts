// Sweeps, coils and threads on the B-rep kernel, against closed forms: a profile swept
// square to a path whose curvature it does not exceed keeps V = A·L when its centroid is
// on the path (Pappus–Guldin; the first moment of the section vanishes however it turns),
// a taper by k gives a frustum, a coil's helix is n·√((πD)² + p²) long, and a screw thread
// takes (2π/P)∫ r w(r) dr of cross-section per unit length (a screw-symmetric groove).
import { describe, expect, it } from 'vitest';
import { circles, rect, single, solve, volumes, watchHandles, withCircles } from './fixtures';
import { occ, setOccEnabled } from './kernel';
import { buildResultOcc } from './result';
import { buildDesignOcc } from './build';
import type { CoilFeature, DesignItem, SweepFeature } from '../design';
import type { CadSketch } from '../model';
import { refTo } from '../topology';
import { grooveArea, parseThread } from '../threads';
import { evaluateWorksheet, type CadResult, type MathResult } from '../../engine/evaluator';
import { createRegion, emptyWorksheet, type CadRegion } from '../../model/types';
import type { Vec3 } from '../solid';

const { PI, sqrt, hypot } = Math;
const near = (v: number, want: number, rel = 1e-9) => expect(Math.abs(v - want) / Math.max(Math.abs(want), 1e-300)).toBeLessThan(rel);

/** Open sketch curves: lines between points and arcs (centre, from, to; anticlockwise). */
function curves(p: string, lines: [number, number, number, number][], arcs: [number, number, number, number, number, number][] = []): CadSketch {
  const sk: CadSketch = { points: [], entities: [], constraints: [] };
  const pt = (x: number, y: number) => {
    const hit = sk.points.find((q) => Math.hypot(q.x - x, q.y - y) < 1e-12);
    if (hit) return hit.id;
    const id = `${p}p${sk.points.length}`;
    sk.points.push({ id, x, y });
    return id;
  };
  lines.forEach(([x0, y0, x1, y1], i) => sk.entities.push({ id: `${p}l${i}`, type: 'line', p1: pt(x0, y0), p2: pt(x1, y1) }));
  arcs.forEach(([cx, cy, x0, y0, x1, y1], i) => {
    const c = `${p}c${i}`;
    sk.points.push({ id: c, x: cx, y: cy });
    sk.entities.push({ id: `${p}a${i}`, type: 'arc', c, p1: pt(x0, y0), p2: pt(x1, y1) });
  });
  return sk;
}

const run = (items: DesignItem[], pre: string[] = []) => {
  const { res } = solve(single(items), pre);
  return { res, V: volumes(res), errors: res.design!.errors, warnings: res.design!.warnings ?? {} };
};

/** A sweep of the first profile of sketch s1 (on XY) along the curves of sketch s2. */
const sweepOf = (profile: CadSketch, path: CadSketch, more: Partial<SweepFeature> = {}, pathPlane: { ref: 'XY' | 'XZ' | 'YZ'; offset?: string } = { ref: 'XZ' }): DesignItem[] => [
  { kind: 'sketch', id: 's1', name: 'Profile', plane: { ref: 'XY' }, sketch: profile },
  { kind: 'sketch', id: 's2', name: 'Path', plane: pathPlane, sketch: path },
  { kind: 'sweep', id: 'f1', name: 'Sweep1', sketch: 's1', path: { kind: 'sketch', sketch: 's2' }, op: 'new', ...more },
];

describe('sweep', () => {
  const r = 3, L = 100, R = 40;

  it('a circle along a straight path: πr²L', () => {
    // the path on XZ runs up the z axis from the profile's centre
    const { V, errors } = run(sweepOf(circles('c', [[0, 0, r]]), curves('q', [[0, 0, 0, L]])));
    expect(errors).toEqual({});
    near(V[0], PI * r * r * L);
  });

  it('a circle along a quarter arc of radius R: Pappus πr²·πR/2', () => {
    // centre (R, 0) on XZ, from (R, R) anticlockwise to the origin: the path starts at the profile
    const { V, errors } = run(sweepOf(circles('c', [[0, 0, r]]), curves('q', [], [[R, 0, R, R, 0, 0]])));
    expect(errors).toEqual({});
    near(V[0], PI * r * r * ((PI * R) / 2));
  });

  it('a line then a tangent arc, and a pipe (annulus) along them: A·L', () => {
    const path = curves('q', [[0, 0, 0, 60]], [[R, 60, 0, 60, R, 60 + R]].map(([cx, cy, x0, y0, x1, y1]) => [cx, cy, x1, y1, x0, y0] as [number, number, number, number, number, number]));
    const Lp = 60 + (PI * R) / 2;
    near(run(sweepOf(circles('c', [[0, 0, r]]), path)).V[0], PI * r * r * Lp);
    // a tube: the hole is swept too and cut out
    const tube = run(sweepOf(circles('c', [[0, 0, r], [0, 0, r - 1]]), path));
    expect(tube.errors).toEqual({});
    near(tube.V[0], PI * (r * r - (r - 1) ** 2) * Lp);
  });

  it('a profile in the middle of the path sweeps the whole path; one off the path follows Pappus with its centroid’s radius', () => {
    // the path from z = −50 to 50 through the profile
    near(run(sweepOf(circles('c', [[0, 0, r]]), curves('q', [[0, -50, 0, 50]]))).V[0], PI * r * r * 100);
    // the profile's centre 5 off a quarter arc (on the outside): its centroid goes round at R + 5
    near(run(sweepOf(circles('c', [[-5, 0, r]]), curves('q', [], [[R, 0, R, R, 0, 0]]))).V[0], PI * r * r * ((PI * (R + 5)) / 2));
  });

  it('a right-angled corner is mitred: A·(L1 + L2)', () => {
    const { V, errors } = run(sweepOf(circles('c', [[0, 0, r]]), curves('q', [[0, 0, 0, 50], [0, 50, 50, 50]])));
    expect(errors).toEqual({});
    near(V[0], PI * r * r * 100);
  });

  it('a twisted square keeps V = a²L (along a line and along an arc)', () => {
    const a = 10;
    for (const twist of ['90 deg', '360 deg']) {
      const { V, errors } = run(sweepOf(rect('s', -a / 2, -a / 2, a / 2, a / 2), curves('q', [[0, 0, 0, L]]), { twist }));
      expect(errors).toEqual({});
      // the twisted faces are approximated (B-splines through the guide): 10⁻⁵
      near(V[0], a * a * L, 1e-5);
    }
    const arc = run(sweepOf(rect('s', -a / 2, -a / 2, a / 2, a / 2), curves('q', [], [[R, 0, R, R, 0, 0]]), { twist: '90 deg' }));
    expect(arc.errors).toEqual({});
    near(arc.V[0], a * a * ((PI * R) / 2), 1e-5);
  });

  it('a taper to k makes a frustum: A·L(1 + k + k²)/3', () => {
    for (const k of [0.5, 2]) {
      const { V, errors } = run(sweepOf(circles('c', [[0, 0, r]]), curves('q', [[0, 0, 0, L]]), { scale: String(k) }));
      expect(errors).toEqual({});
      // the scaled circle sweeps a B-spline cone (approximated)
      near(V[0], (PI * r * r * L * (1 + k + k * k)) / 3, 1e-6);
    }
  });

  it('parallel: the profile only moves, so the volume is A times the path’s rise (Cavalieri)', () => {
    // up 60, then a quarter arc of radius 40 that rises 40 more and turns over towards x
    const path = curves('q', [[0, 0, 0, 60]], [[R, 60, R, 60 + R, 0, 60]]);
    const { V, errors } = run(sweepOf(circles('c', [[0, 0, r]]), path, { orientation: 'parallel' }));
    expect(errors).toEqual({});
    near(V[0], PI * r * r * 100);
  });

  it('a sweep that would cut through itself says so instead of a wrong solid', () => {
    // a profile wider than the bend
    const big = run(sweepOf(circles('c', [[0, 0, 50]]), curves('q', [], [[R, 0, R, R, 0, 0]])));
    expect(big.errors.f1).toMatch(/reaches 50 mm from the path, but the path bends with a radius of 40 mm/);
    // a path that comes back past the profile: a U whose arms are 10 apart, the profile 12 across
    const u = curves('q', [[0, 0, 0, 50], [10, 50, 10, 0]], [[5, 50, 10, 50, 0, 50]]);
    const back = run(sweepOf(circles('c', [[0, 0, 6]]), u));
    expect(back.errors.f1).toMatch(/bends with a radius of 5 mm|comes within/);
    const wide = run(sweepOf(circles('c', [[0, 0, 4]]), curves('q', [[0, 0, 0, 50], [20, 50, 20, 0], [20, 0, 2, 0]], [[10, 50, 20, 50, 0, 50]])));
    expect(wide.errors.f1).toMatch(/comes within 2 mm of itself, closer than the profile is wide \(8 mm\)/);
    // a parallel sweep turning back along the profile's plane folds over
    const fold = run(sweepOf(circles('c', [[0, 0, r]]), curves('q', [[0, 0, 0, 50], [0, 50, 50, 50], [50, 50, 50, 0]]), { orientation: 'parallel' }));
    expect(fold.errors.f1).toMatch(/fold over itself/);
  });

  it('joins, cuts and intersects with targets; the faces carry the profile’s names', () => {
    const items: DesignItem[] = [
      { kind: 'sketch', id: 's0', name: 'Base', plane: { ref: 'XY' }, sketch: rect('b', -20, -20, 20, 20) },
      { kind: 'extrude', id: 'f0', name: 'Block', sketch: 's0', extent: { type: 'one', d: '40' }, op: 'new' },
      ...sweepOf(circles('c', [[0, 0, r]]), curves('q', [[0, -10, 0, 50]]), { op: 'cut' }),
    ];
    const { V, errors } = run(items);
    expect(errors).toEqual({});
    // a hole through the block: 40·40·40 − πr²·40
    near(V[0], 64000 - PI * r * r * 40);
    const b = buildResultOcc(occ()!, single(items), solve(single(items)).numbers).components.c1.bodies[0];
    expect(b.faces.some((f) => f.key === 'f1/side:ck0' && f.type === 'cylinder')).toBe(true);
  });

  it('along edges of a body (picked by reference) and following them when the body changes', () => {
    // a 30 × 20 × 10 block: sweep a circle along its top front edge, then its length grows
    const pre = (w: number) => [`w := ${w} mm`];
    const block: DesignItem[] = [
      { kind: 'sketch', id: 's0', name: 'Base', plane: { ref: 'XY' }, sketch: { ...rect('b', 0, 0, 30, 20), constraints: [{ id: 'k0', type: 'fix', refs: ['bp0'], at: { x: 0, y: 0 } }, { id: 'k1', type: 'horizontal', refs: ['bl0'] }, { id: 'k2', type: 'horizontal', refs: ['bl2'] }, { id: 'k3', type: 'vertical', refs: ['bl1'] }, { id: 'k4', type: 'vertical', refs: ['bl3'] }, { id: 'k5', type: 'length', refs: ['bl0'], value: 'w' }, { id: 'k6', type: 'length', refs: ['bl1'], value: '20' }] } },
      { kind: 'extrude', id: 'f0', name: 'Block', sketch: 's0', extent: { type: 'one', d: '10' }, op: 'new' },
    ];
    const built = buildResultOcc(occ()!, single(block), solve(single(block), pre(30)).numbers).components.c1.bodies[0];
    const edge = built.edges.find((e) => Math.hypot(e.mid[0] - 15, e.mid[1], e.mid[2] - 10) < 1e-6)!;
    const items: DesignItem[] = [...block,
      // the profile on a plane square to the edge at its start (YZ through x = 0)
      { kind: 'sketch', id: 's1', name: 'Profile', plane: { ref: 'YZ' }, sketch: circles('c', [[0, 10, 2]]) },
      { kind: 'sweep', id: 'f1', name: 'Sweep1', sketch: 's1', path: { kind: 'edges', edges: [refTo('edge', 'f0', edge)] }, op: 'new' },
    ];
    for (const w of [30, 45]) {
      const { V, errors } = run(items, pre(w));
      expect(errors).toEqual({});
      near(V[1], PI * 4 * w);
    }
  });
});

describe('coil', () => {
  const coil = (more: Partial<CoilFeature> = {}): CoilFeature => ({
    kind: 'coil', id: 'f1', name: 'Coil1', plane: 'XY', mode: 'revs-pitch', d: '40', revs: '5', pitch: '8', section: 'circle', size: '4', op: 'new', ...more,
  });

  it('a circular section r on diameter D, pitch p, n turns: V = πr²·n·√((πD)² + p²)', () => {
    const { V, errors } = run([coil()]);
    expect(errors).toEqual({});
    // the helix's 3-D curve is approximated to 10⁻⁷: the volume to about 10⁻⁶
    near(V[0], PI * 4 * 5 * hypot(PI * 40, 8), 1e-6);
  });

  it('revolutions and height, height and pitch give the same coil', () => {
    const want = PI * 4 * 5 * hypot(PI * 40, 8);
    near(run([coil({ mode: 'revs-height', revs: '5', height: '40' })]).V[0], want, 1e-6);
    near(run([coil({ mode: 'height-pitch', height: '40', pitch: '8' })]).V[0], want, 1e-6);
  });

  it('a square section s: s²·L; triangles (centred on the diameter) by the swept flux', () => {
    const s = 3, D = 40, p = 8, n = 3;
    const len = n * hypot(PI * D, p);
    near(run([coil({ section: 'square', size: String(s), revs: String(n) })]).V[0], s * s * len, 1e-6);
    // a section square to the helix at radius R, its centroid at x̄ from the axis: per turn
    // V = A ((2π)² R x̄ + p²) / √((2πR)² + p²) (the screw motion's flux through it); the
    // triangle's centroid is h/6 from the middle of its radial extent, out or in
    const h = (sqrt(3) / 2) * s, A = (sqrt(3) / 4) * s * s, R = D / 2;
    for (const [section, xbar] of [['triangle-out', R - h / 6], ['triangle-in', R + h / 6]] as const) {
      const want = (n * A * ((2 * PI) ** 2 * R * xbar + p * p)) / hypot(2 * PI * R, p);
      near(run([coil({ section, size: String(s), revs: String(n) })]).V[0], want, 1e-6);
    }
  });

  it('inside and outside the diameter: the helix moves by half the section', () => {
    // a circle of 4 inside D = 40 follows a helix of diameter 36
    near(run([coil({ position: 'inside' })]).V[0], PI * 4 * 5 * hypot(PI * 36, 8), 1e-6);
    near(run([coil({ position: 'outside' })]).V[0], PI * 4 * 5 * hypot(PI * 44, 8), 1e-6);
  });

  it('turns that would overlap and a section across the axis are refused', () => {
    // a section of 4 tilted by the helix angle is 4/cos α wide along the axis
    const tight = run([coil({ pitch: '4' })]);
    expect(tight.errors.f1).toMatch(/the turns overlap: the section is 4\.0\d* mm wide along the axis, the pitch only 4 mm/);
    expect(run([coil({ d: '3' })]).errors.f1).toMatch(/reaches the coil’s axis/);
  });

  it('stands on a face and its centre point, left- or right-handed; a cut makes a spiral groove', () => {
    const items: DesignItem[] = [
      { kind: 'sketch', id: 's0', name: 'Base', plane: { ref: 'XY' }, sketch: circles('b', [[0, 0, 30]]) },
      { kind: 'extrude', id: 'f0', name: 'Drum', sketch: 's0', extent: { type: 'one', d: '50' }, op: 'new' },
    ];
    const V0 = PI * 900 * 50;
    // a groove of 4 round the drum's surface (on its diameter, half in the material)
    const cut = run([...items, coil({ d: '60', revs: '4', pitch: '10', op: 'cut', plane: 'XY' })]);
    expect(cut.errors).toEqual({});
    expect(cut.V[0]).toBeLessThan(V0);
    // left-handed: the same volume, a mirror image
    const left = run([...items, coil({ d: '60', revs: '4', pitch: '10', op: 'cut', hand: 'left' })]);
    near(left.V[0], cut.V[0], 1e-6);
  });

  it('is a helix path for a sweep (path only: no body of its own)', () => {
    // a circle on the plane square to the helix at its start (20, 0, 0), tilted by the helix angle
    const alpha = Math.atan2(10, 2 * PI * 20);
    const profileFrame = { o: [20, 0, 0] as Vec3, u: [1, 0, 0] as Vec3, v: [0, Math.sin(alpha), -Math.cos(alpha)] as Vec3 };
    const sweep: DesignItem[] = [
      coil({ pathOnly: true, d: '40', revs: '2', pitch: '10' }),
      { kind: 'sketch', id: 's1', name: 'Section', plane: { frame: profileFrame }, sketch: circles('c', [[0, 0, 2]]) },
      { kind: 'sweep', id: 'f2', name: 'Sweep1', sketch: 's1', path: { kind: 'coil', coil: 'f1' }, op: 'new' },
    ];
    const { V, errors } = run(sweep);
    expect(errors).toEqual({});
    expect(V.length).toBe(1);
    near(V[0], PI * 4 * 2 * hypot(PI * 40, 10), 1e-6);
  });
});

describe('threads', () => {
  const shaft = (d: number, L: number): DesignItem[] => [
    { kind: 'sketch', id: 's0', name: 'Shaft', plane: { ref: 'XY' }, sketch: circles('s', [[0, 0, d / 2]]) },
    { kind: 'extrude', id: 'f0', name: 'Shaft', sketch: 's0', extent: { type: 'one', d: String(L) }, op: 'new' },
  ];
  const faceOf = (items: DesignItem[], type: string) => {
    const b = buildResultOcc(occ()!, single(items), solve(single(items)).numbers).components.c1.bodies[0];
    return refTo('face', b.id, b.faces.find((f) => f.type === type)!);
  };

  it('a modeled M12 along a whole free rod takes (2π/P)∫ r w dr per unit length', () => {
    const items = shaft(12, 30);
    const side = faceOf(items, 'cylinder');
    const { V, errors } = run([...items, { kind: 'thread', id: 'f1', name: 'Thread1', faces: [side], size: 'M12', modeled: true }]);
    expect(errors).toEqual({});
    const s = parseThread('M12');
    near(V[0], PI * 36 * 30 - grooveArea(s, s.d1 / 2, s.d / 2, false) * 30, 1e-5);
  });

  it('a modeled M12 x 20 from the free end of a bolt with a head; the head is not notched', () => {
    // head Ø20 × 8, shank Ø12 × 40 on top of it
    const items: DesignItem[] = [
      { kind: 'sketch', id: 's0', name: 'Head', plane: { ref: 'XY' }, sketch: circles('h', [[0, 0, 10]]) },
      { kind: 'extrude', id: 'f0', name: 'Head', sketch: 's0', extent: { type: 'one', d: '8' }, op: 'new' },
      { kind: 'sketch', id: 's1', name: 'Shank', plane: { ref: 'XY', offset: '8' }, sketch: circles('s', [[0, 0, 6]]) },
      { kind: 'extrude', id: 'f1', name: 'Shank', sketch: 's1', extent: { type: 'one', d: '40' }, op: 'join' },
    ];
    const V0 = PI * 100 * 8 + PI * 36 * 40;
    const b = buildResultOcc(occ()!, single(items), solve(single(items)).numbers).components.c1.bodies[0];
    const side = refTo('face', b.id, b.faces.find((f) => f.type === 'cylinder' && Math.abs(f.radius! - 6) < 1e-9)!);
    const s = parseThread('M12');
    const Af = grooveArea(s, s.d1 / 2, s.d / 2, false);
    const part = run([...items, { kind: 'thread', id: 'f2', name: 'Thread1', faces: [side], size: 'M12', length: '20', modeled: true }]);
    expect(part.errors).toEqual({});
    near(part.V[0], V0 - Af * 20, 1e-5);
    // the whole shank: the groove's centre stops half its width (at the crest, where it is
    // 7P/8 + 2·0.05P·tan 30° wide) and 0.05P short of the head
    const full = run([...items, { kind: 'thread', id: 'f2', name: 'Thread1', faces: [side], size: 'M12', modeled: true }]);
    expect(full.errors).toEqual({});
    const half = ((7 / 8 + 0.1 * Math.tan(PI / 6)) * s.P) / 2;
    near(full.V[0], V0 - Af * (40 - half - 0.05 * s.P), 1e-5);
  });

  it('cosmetic threads change nothing; the worksheet reads the ISO data', () => {
    const items = shaft(12, 30);
    const side = faceOf(items, 'cylinder');
    const r = run([...items, { kind: 'thread', id: 'f1', name: 'Thread1', faces: [side], size: 'M12' }]);
    expect(r.errors).toEqual({});
    near(r.V[0], PI * 36 * 30);
    // part.Thread1: ISO 724 and ISO 898-1 values in mm
    const t = (r.res.design!.params.f1);
    near(t.P, 1.75);
    near(t.As, parseThread('M12').As);
  });

  it('the worksheet reads part.Thread1 and a tapped part.Hole1: pitch, diameters, A_s, tap drill', () => {
    const items: DesignItem[] = [...shaft(12, 30)];
    const side = faceOf(items, 'cylinder');
    const design = single([...items,
      { kind: 'thread', id: 'f1', name: 'Thread1', faces: [side], size: 'M12' },
      { kind: 'sketch', id: 's1', name: 'End', plane: { ref: 'XY', offset: '30' }, sketch: { points: [{ id: 'q', x: 0, y: 0 }], entities: [{ id: 'e', type: 'point', p: 'q' }], constraints: [] } },
      { kind: 'hole', id: 'f2', name: 'Hole1', sketch: 's1', d: '', depth: '12', style: 'simple', tap: { size: 'M6', depth: '10' } },
    ]);
    const ws = emptyWorksheet();
    const cad = createRegion('cad', 20, 20, { name: 'bolt', design, density: '7850 kg/m^3' }) as CadRegion;
    const maths = ['bolt.Thread1.As = mm^2', 'bolt.Thread1.P = mm', 'bolt.Thread1.d3 = mm', 'bolt.Thread1.d2 = mm', 'bolt.Hole1.drill = mm', 'bolt.Hole1.D1 = mm']
      .map((source, i) => createRegion('math', 20, 300 + 20 * i, { source }));
    ws.regions = [cad, ...maths];
    const out = evaluateWorksheet(ws);
    expect((out.results.get(cad.id) as CadResult).featureError).toBeUndefined();
    const shown = maths.map((m) => {
      const r = out.results.get(m.id) as MathResult;
      expect(r.error).toBeUndefined();
      return r.tex;
    });
    // ISO 898-1: A_s(M12) = 84.3 mm²; d3 = 12 − 1.226869·1.75 = 9.853; d2 = 10.863; M6: tap drill 5, D1 = 4.917
    expect(shown[0]).toContain('84.266');
    expect(shown[1]).toContain('1.75');
    expect(shown[2]).toContain('9.853');
    expect(shown[3]).toContain('10.86');
    expect(shown[4]).toMatch(/\b5\b|= 5/);
    expect(shown[5]).toContain('4.917');
  });

  it('a shaft that does not fit the size is refused', () => {
    const items = shaft(13, 30);
    const side = faceOf(items, 'cylinder');
    expect(run([...items, { kind: 'thread', id: 'f1', name: 'Thread1', faces: [side], size: 'M12' }]).errors.f1).toMatch(/the shaft is Ø13 mm: an M12 thread needs Ø12 mm/);
  });

  it('a tapped M10 hole is drilled 8.5; modeled, its thread takes (2π/P)∫ r w dr from 4.25 to 5', () => {
    const plate: DesignItem[] = [
      { kind: 'sketch', id: 's0', name: 'Plate', plane: { ref: 'XY' }, sketch: rect('r', -20, -20, 20, 20) },
      { kind: 'extrude', id: 'f0', name: 'Plate', sketch: 's0', extent: { type: 'one', d: '20' }, op: 'new' },
      { kind: 'sketch', id: 's1', name: 'Top', plane: { ref: 'XY', offset: '20' }, sketch: { points: [{ id: 'q', x: 0, y: 0 }], entities: [{ id: 'e', type: 'point', p: 'q' }], constraints: [] } },
    ];
    const V0 = 40 * 40 * 20;
    const hole = (tap: { size: string; depth?: string; modeled?: boolean }, through = true): DesignItem => ({ kind: 'hole', id: 'f1', name: 'Hole1', sketch: 's1', d: '6', depth: '15', through, style: 'simple', tap });
    const cosmetic = run([...plate, hole({ size: 'M10' })]);
    expect(cosmetic.errors).toEqual({});
    near(cosmetic.V[0], V0 - PI * 4.25 ** 2 * 20);
    const s = parseThread('M10');
    const modeled = run([...plate, hole({ size: 'M10', modeled: true })]);
    expect(modeled.errors).toEqual({});
    near(modeled.V[0], V0 - PI * 4.25 ** 2 * 20 - grooveArea(s, 4.25, 5, true) * 20, 1e-5);
    // blind, threaded 10 deep in a hole 15 deep
    const blind = run([...plate, hole({ size: 'M10', depth: '10', modeled: true }, false)]);
    expect(blind.errors).toEqual({});
    near(blind.V[0], V0 - PI * 4.25 ** 2 * 15 - grooveArea(s, 4.25, 5, true) * 10, 1e-5);
    expect(run([...plate, hole({ size: 'M10', depth: '20' }, false)]).errors.f1).toMatch(/deeper than the hole/);
  });
});

describe('mesh kernel', () => {
  it('says sweeps, coils and threads need the B-rep kernel; drills a tapped hole; builds construction planes', () => {
    const plate: DesignItem[] = [
      { kind: 'sketch', id: 's0', name: 'Plate', plane: { ref: 'XY' }, sketch: rect('r', -20, -20, 20, 20) },
      { kind: 'extrude', id: 'f0', name: 'Plate', sketch: 's0', extent: { type: 'one', d: '20' }, op: 'new' },
      { kind: 'sketch', id: 's1', name: 'Top', plane: { ref: 'XY', offset: '20' }, sketch: { points: [{ id: 'q', x: 0, y: 0 }], entities: [{ id: 'e', type: 'point', p: 'q' }], constraints: [] } },
      { kind: 'hole', id: 'f1', name: 'Hole1', sketch: 's1', d: '', depth: '', through: true, style: 'simple', tap: { size: 'M10', modeled: true } },
      { kind: 'plane', id: 'p1', name: 'Plane1', def: { type: 'offset', plane: 'XY', d: '7' } },
      { kind: 'coil', id: 'f2', name: 'Coil1', plane: 'p1', mode: 'revs-pitch', d: '60', revs: '2', pitch: '8', section: 'circle', size: '2', op: 'new' },
      ...sweepOf(circles('c', [[50, 0, 2]]), curves('q', [[50, 0, 50, 30]])).map((i) => ({ ...i, id: `w${i.id}` }) as DesignItem).map((i) => (i.kind === 'sweep' ? { ...i, sketch: 'ws1', path: { kind: 'sketch' as const, sketch: 'ws2' } } : i)),
    ];
    setOccEnabled(false);
    try {
      const { res } = solve(single(plate));
      const d = res.design!;
      expect(d.brep).toBeFalsy();
      expect(d.errors.f2).toMatch(/needs the B-rep kernel.*cannot make coils/);
      expect(d.errors.wf1).toMatch(/needs the B-rep kernel.*cannot sweep profiles/);
      expect(d.errors.f1).toBeUndefined();
      expect(d.warnings!.f1).toMatch(/modeled once OpenCascade has loaded/);
      // drilled to the tap drill, Ø8.5 (the mesh's circles are polygons: 2·10⁻⁴)
      near(d.bodies.c1[0].mass!.V, 40 * 40 * 20 - PI * 4.25 ** 2 * 20, 2e-4);
    } finally {
      setOccEnabled(true);
    }
  });
});

describe('B-rep handles', () => {
  it('deletes every OCCT object of sweeps (twisted, tapered, along edges), coils and threads', () => {
    const oc = occ()!;
    const shaftItems: DesignItem[] = [
      { kind: 'sketch', id: 's0', name: 'Shaft', plane: { ref: 'XY' }, sketch: circles('s', [[0, 0, 6]]) },
      { kind: 'extrude', id: 'f0', name: 'Shaft', sketch: 's0', extent: { type: 'one', d: '12' }, op: 'new' },
    ];
    const b = buildResultOcc(oc, single(shaftItems), solve(single(shaftItems)).numbers).components.c1.bodies[0];
    const side = refTo('face', b.id, b.faces.find((f) => f.type === 'cylinder')!);
    const designs = [
      single(sweepOf(rect('s', -2, -2, 2, 2), curves('q', [[0, 0, 0, 30]]), { twist: '90 deg' })),
      single(sweepOf(withCircles(circles('c', [[0, 0, 3]]), 'h', [[0, 0, 2]]), curves('q', [[0, 0, 0, 30]], [[20, 30, 20, 50, 0, 30]]), { scale: '1.5' })),
      single([{ kind: 'coil', id: 'f1', name: 'Coil1', plane: 'XY', mode: 'revs-pitch', d: '20', revs: '2', pitch: '5', section: 'square', size: '2', op: 'new' }]),
      single([...shaftItems, { kind: 'thread', id: 'f1', name: 'Thread1', faces: [side], size: 'M12', modeled: true }]),
    ];
    for (const d of designs) {
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

