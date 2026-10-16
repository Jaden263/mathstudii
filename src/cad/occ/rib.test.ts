// Ribs on the B-rep kernel (and the mesh kernel), against closed forms: the gusset in the
// corner of an L bracket from a diagonal line is the triangle h²/2 times its thickness, from
// a concave quarter arc the square less the quarter disc, to a depth the triangle less the
// one the depth leaves open.
import { describe, expect, it } from 'vitest';
import { rect, single, solve, volumes, watchHandles } from './fixtures';
import { occ, setOccEnabled } from './kernel';
import { buildDesignOcc } from './build';
import { buildResultOcc } from './result';
import type { DesignItem, RibFeature } from '../design';
import type { CadSketch } from '../model';

const { PI, SQRT2 } = Math;
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
  return { res, V: volumes(res), errors: res.design!.errors, bodies: res.design!.bodies.c1 ?? [] };
};

/**
 * An L bracket 40 wide (y −20…20): a foot 60 long and T thick on XY, a wall 10 thick and 60
 * high at x 0…10. Its inside corner is at (10, T) on XZ (x, z).
 */
const bracket = (T = '10'): DesignItem[] => [
  { kind: 'sketch', id: 's0', name: 'Foot', plane: { ref: 'XY' }, sketch: rect('a', 0, -20, 60, 20) },
  { kind: 'extrude', id: 'f0', name: 'Foot', sketch: 's0', extent: { type: 'one', d: T }, op: 'new' },
  { kind: 'sketch', id: 's1', name: 'Wall', plane: { ref: 'XY' }, sketch: rect('b', 0, -20, 10, 20) },
  { kind: 'extrude', id: 'f1', name: 'Wall', sketch: 's1', extent: { type: 'one', d: '60' }, op: 'join' },
];
const BRACKET = 60 * 40 * 10 + 10 * 40 * 50;

/** A rib from the curves of a sketch on XZ (sketch x, y = model x, z). */
const ribOn = (sk: CadSketch, more: Partial<RibFeature> = {}): DesignItem[] => [
  { kind: 'sketch', id: 's2', name: 'Gusset', plane: { ref: 'XZ' }, sketch: sk },
  { kind: 'rib', id: 'f2', name: 'Rib1', sketch: 's2', thickness: '4', op: 'join', ...more },
];
const diagonal = () => curves('q', [[10, 50, 50, 10]]);

describe('rib', () => {
  it('a diagonal line in the corner of an L bracket: the triangle h²/2 · t, joined to the bracket', () => {
    const items = [...bracket(), ...ribOn(diagonal())];
    const { V, errors } = run(items);
    expect(errors).toEqual({});
    expect(V.length).toBe(1);
    near(V[0], BRACKET + (40 * 40) / 2 * 4);
    // its slanted face is named after the line: 40√2 long, 4 thick
    const d = single(items);
    const b = buildResultOcc(occ()!, d, solve(d).numbers).components.c1.bodies[0];
    near(b.faces.find((f) => f.key === 'f2/side:ql0')!.area, 40 * SQRT2 * 4);
  });

  it('the line drawn either way round, and from the far end, gives the same rib', () => {
    near(run([...bracket(), ...ribOn(curves('q', [[50, 10, 10, 50]]))]).V[0], BRACKET + 3200);
  });

  it('a concave quarter arc: the square less the quarter disc, (40² − π·40²/4) · t', () => {
    // centre (50, 50), from (10, 50) anticlockwise to (50, 10): it bows into the corner
    const { V, errors } = run([...bracket(), ...ribOn(curves('q', [], [[50, 50, 10, 50, 50, 10]]))]);
    expect(errors).toEqual({});
    near(V[0], BRACKET + (1600 - 400 * PI) * 4);
  });

  it('a depth: the band between the line and the line moved 10 towards the corner', () => {
    // inside x, z ≥ 10 the triangle x + z ≤ c has legs c − 20: 800 − (40 − 10√2)²/2
    const { V, errors } = run([...bracket(), ...ribOn(diagonal(), { depth: '10' })]);
    expect(errors).toEqual({});
    near(V[0], BRACKET + (800 - (40 - 10 * SQRT2) ** 2 / 2) * 4);
  });

  it('the thickness on one side of the sketch plane or the other (XZ looks along +Y: its normal is −Y)', () => {
    const yg = (side: RibFeature['side']) => {
      const { bodies, V } = run([...bracket(), ...ribOn(diagonal(), { side })]);
      near(V[0], BRACKET + 3200);
      return bodies[0].mass!.yg;
    };
    near(yg('symmetric') + 1, 1, 1e-9);
    near(yg('one'), (3200 * -2) / (BRACKET + 3200));
    near(yg('other'), (3200 * 2) / (BRACKET + 3200));
  });

  it('follows the bracket: a thinner foot leaves the rib closing on it lower down', () => {
    // foot 5 thick: the line's end goes straight down its normal to (45, 5), then the foot's
    // top: the triangle 800 and 5 high of the strip between z 5 and 10, ∫(30 + z) dz = 187.5
    const items = [...bracket('T_f'), ...ribOn(diagonal())];
    near(run(items, ['T_f := 10 mm']).V[0], BRACKET + 3200);
    const thin = run(items, ['T_f := 5 mm']);
    expect(thin.errors).toEqual({});
    near(thin.V[0], 60 * 40 * 5 + 10 * 40 * 55 + (800 + 187.5) * 4);
  });

  it('a line over a plate grows down to it; flipped there is nothing to meet', () => {
    const plate: DesignItem[] = [
      { kind: 'sketch', id: 's0', name: 'Plate', plane: { ref: 'XY' }, sketch: rect('a', 0, -20, 100, 20) },
      { kind: 'extrude', id: 'f0', name: 'Plate', sketch: 's0', extent: { type: 'one', d: '10' }, op: 'new' },
    ];
    const line = curves('q', [[20, 30, 80, 30]]);
    const { V, errors } = run([...plate, ...ribOn(line, { thickness: '3' })]);
    expect(errors).toEqual({});
    near(V[0], 100 * 40 * 10 + 60 * 20 * 3);
    expect(run([...plate, ...ribOn(line, { flip: true })]).errors.f2).toMatch(/flipped, the rib meets no face/);
    // a new body of its own
    const apart = run([...plate, ...ribOn(line, { thickness: '3', op: 'new' })]);
    expect(apart.V.length).toBe(2);
    near(apart.V[1], 60 * 20 * 3);
  });

  it('says what is wrong: inside the body, nothing to meet, closed, turning back, a circle', () => {
    const err = (sk: CadSketch, more: Partial<RibFeature> = {}) => run([...bracket(), ...ribOn(sk, more)]).errors.f2;
    expect(err(curves('q', [[2, 20, 2, 40]]))).toMatch(/lies inside the body/);
    // upright, beside the wall but above it: both ways along x run past the bracket
    expect(err(curves('q', [[-30, 70, -30, 90]]))).toMatch(/meets no face on either side/);
    // lower down, it grows to the wall's outside: 30 × 20
    near(run([...bracket(), ...ribOn(curves('q', [[-30, 20, -30, 40]]))]).V[0], BRACKET + 30 * 20 * 4);
    expect(err(curves('q', [[10, 50, 50, 10], [50, 10, 50, 50], [50, 50, 10, 50]]))).toMatch(/closed/);
    expect(err(curves('q', [[10, 50, 50, 10], [50, 10, 30, 10]]))).toMatch(/turns back on itself/);
    const circle: CadSketch = { points: [{ id: 'c', x: 30, y: 30 }], entities: [{ id: 'k', type: 'circle', c: 'c', r: 5 }], constraints: [] };
    expect(err(circle)).toMatch(/not a circle/);
    expect(run([...ribOn(diagonal())]).errors.f2).toMatch(/there is none yet/);
  });

  it('the mesh kernel builds the same gusset', () => {
    setOccEnabled(false);
    try {
      const { res } = solve(single([...bracket(), ...ribOn(diagonal())]));
      expect(res.design!.brep).toBeFalsy();
      expect(res.design!.errors).toEqual({});
      near(volumes(res)[0], BRACKET + 3200, 1e-9);
    } finally {
      setOccEnabled(true);
    }
  });

  it('deletes every OCCT object it makes', () => {
    const oc = occ()!;
    for (const items of [[...bracket(), ...ribOn(diagonal())], [...bracket(), ...ribOn(curves('q', [], [[50, 50, 10, 50, 50, 10]]), { depth: '5' })]]) {
      const d = single(items);
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
