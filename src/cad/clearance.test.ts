// Distances between placed meshes against hand calculations: boxes apart along an axis, by
// a corner, turned; crossing and nested meshes; the closest points of segments and of a
// point and a triangle (Ericson, Real-Time Collision Detection, §5.1).
import { describe, expect, it } from 'vitest';
import { meshDistance, meshTree, pointTriangleDistance2, segmentDistance2, triangleDistance2 } from './clearance';
import { IDENTITY, m4Mul, m4Rotate, m4Translate } from './solid';

/** An axis-aligned box as 12 triangles, facing out. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
  const P = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]].flat();
  const F = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]].flat();
  return meshTree(new Float32Array(P), new Uint32Array(F));
}

describe('closest points', () => {
  it('of two segments: skew, parallel and end to end', () => {
    // skew: x axis at z = 0 and y axis at z = 2 cross 2 apart
    expect(segmentDistance2([-1, 0, 0], [1, 0, 0], [0, -1, 2], [0, 1, 2])).toBeCloseTo(4, 14);
    // parallel, offset 3 in y and overlapping in x
    expect(segmentDistance2([0, 0, 0], [4, 0, 0], [2, 3, 0], [6, 3, 0])).toBeCloseTo(9, 14);
    // collinear, a gap of 1 between their ends
    expect(segmentDistance2([0, 0, 0], [1, 0, 0], [2, 0, 0], [5, 0, 0])).toBeCloseTo(1, 14);
  });

  it('of a point and a triangle: over the face, beside an edge, beyond a corner', () => {
    const a: [number, number, number] = [0, 0, 0], b: [number, number, number] = [4, 0, 0], c: [number, number, number] = [0, 4, 0];
    expect(pointTriangleDistance2([1, 1, 3], a, b, c)).toBeCloseTo(9, 14);
    // beside the hypotenuse x + y = 4: from (3, 3, 0) it is (6 − 4)/√2 = √2 away
    expect(pointTriangleDistance2([3, 3, 0], a, b, c)).toBeCloseTo(2, 14);
    expect(pointTriangleDistance2([-3, -4, 0], a, b, c)).toBeCloseTo(25, 14);
  });

  it('of two triangles: apart, and crossing', () => {
    expect(triangleDistance2([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 0, 2], [1, 0, 2], [0, 1, 2]])).toBeCloseTo(4, 14);
    // a vertical triangle through the middle of a flat one
    expect(triangleDistance2([[-1, -1, 0], [3, -1, 0], [-1, 3, 0]], [[0.5, 0.5, -1], [0.6, 0.5, 1], [0.5, 0.6, 1]])).toBe(0);
  });
});

describe('placed meshes', () => {
  const unit = box(0, 0, 0, 1, 1, 1);
  it('two cubes 2.5 apart along x', () => {
    expect(meshDistance(unit, IDENTITY, unit, m4Translate([3.5, 0, 0]))).toBeCloseTo(2.5, 6);
  });

  it('corner to corner: √(1² + 2² + 2²) = 3', () => {
    expect(meshDistance(unit, IDENTITY, unit, m4Translate([2, 3, 3]))).toBeCloseTo(3, 6);
  });

  it('a cube turned 45° about z, its edge towards a face: 3 − √2/2 − 1', () => {
    // centre at x = 3; the turned cube reaches √2/2 from its centre, the other's face is at x = 1
    const M = m4Mul(m4Translate([3, 0.5, 0]), m4Mul(m4Rotate([0, 0, 0], [0, 0, 1], Math.PI / 4), m4Translate([-0.5, -0.5, 0])));
    expect(meshDistance(unit, IDENTITY, unit, M)).toBeCloseTo(3 - Math.SQRT2 / 2 - 1, 6);
  });

  it('crossing, nested and the cut-off', () => {
    expect(meshDistance(unit, IDENTITY, unit, m4Translate([0.5, 0.5, 0.5]))).toBe(0);
    // a small cube inside a big one: no faces cross, yet they overlap
    expect(meshDistance(box(-5, -5, -5, 5, 5, 5), IDENTITY, unit, IDENTITY)).toBe(0);
    expect(meshDistance(unit, IDENTITY, box(-5, -5, -5, 5, 5, 5), IDENTITY)).toBe(0);
    // nothing closer than 2: not worth measuring
    expect(meshDistance(unit, IDENTITY, unit, m4Translate([3.5, 0, 0]), 2)).toBe(Infinity);
  });

  it('two flat bars stacked 1 apart, the upper turned: their faces are 1 apart everywhere they overlap', () => {
    const bar = box(0, 0, 0, 130, 12, 5);
    const M = m4Mul(m4Translate([10, 2, 6]), m4Rotate([0, 0, 0], [0, 0, 1], 0.3));
    expect(meshDistance(bar, IDENTITY, bar, M)).toBeCloseTo(1, 6);
  });
});
