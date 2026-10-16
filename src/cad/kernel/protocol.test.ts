// Display data crosses from a worker to the UI by structured clone (or transfer): the
// typed arrays must all be found for a transfer list and survive the copy intact.
import { describe, expect, it } from 'vitest';
import { rect, single, solve, withCircles } from '../occ/fixtures';
import { occ } from '../occ/kernel';
import { buildResultOcc } from '../occ/result';
import { displayMesh } from '../display';
import { buffersOf } from './protocol';

describe('display data between threads', () => {
  const design = single([
    { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: withCircles(rect('a', 0, 0, 40, 30), 'h', [[20, 15, 5]]) },
    { kind: 'extrude', id: 'f1', name: 'E', sketch: 's1', extent: { type: 'one', d: '8' }, op: 'new' },
  ]);
  const r = buildResultOcc(occ()!, design, solve(design).numbers);

  it('finds every typed array of a build result once', () => {
    const b = r.components.c1.bodies[0];
    // four mesh arrays and one polyline per edge, each on a buffer of its own
    const arrays = [b.mesh.positions, b.mesh.normals, b.mesh.indices, b.mesh.faceOf, ...b.edges.map((e) => e.points)];
    expect(new Set(buffersOf(r))).toEqual(new Set(arrays.map((a) => a.buffer)));
  });

  it('a structured clone draws the same as the original', () => {
    const copy = structuredClone(r);
    const [a, b] = [r, copy].map((x) => displayMesh(x.components.c1.bodies[0]));
    expect(b.indices).toEqual(a.indices);
    expect(b.faceStart).toEqual(a.faceStart);
    expect(b.lines).toEqual(a.lines);
    expect(copy.components.c1.bodies[0].faces.map((f) => f.key)).toEqual(r.components.c1.bodies[0].faces.map((f) => f.key));
    expect(copy.components.c1.bodies[0].mass.V).toBeCloseTo(40 * 30 * 8 - Math.PI * 25 * 8, 9);
  });
});
