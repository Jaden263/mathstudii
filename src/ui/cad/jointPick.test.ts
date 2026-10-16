// Joint origins picked on the model: the candidates a face offers (its snap points and the
// sketch points lying in it) and the glyphs that show them.
import { describe, expect, it } from 'vitest';
import { points, rect, single, solve, withCircles } from '../../cad/occ/fixtures';
import { occ } from '../../cad/occ/kernel';
import { buildResultOcc } from '../../cad/occ/result';
import { IDENTITY } from '../../cad/solid';
import { candidateGlyphs, jointCandidates, nearestCandidate } from './jointPick';

describe('joint origins on the model', () => {
  // a 100 × 60 × 10 plate with a Ø20 hole at (50, 30); points sketched on its top and on its bottom plane
  const design = single([
    { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: withCircles(rect('a', 0, 0, 100, 60), 'h', [[50, 30, 10]]) },
    { kind: 'extrude', id: 'f1', name: 'Plate', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
    { kind: 'sketch', id: 's2', name: 'OnTop', plane: { ref: 'XY', offset: '10' }, sketch: points('t', [[80, 15]]) },
    { kind: 'sketch', id: 's3', name: 'Below', plane: { ref: 'XY' }, sketch: points('b', [[20, 15]]) },
  ]);
  const { res, numbers } = solve(design);
  const plate = buildResultOcc(occ()!, design, numbers).components.c1.bodies[0];
  const top = plate.faces.find((f) => f.key === 'f1/end')!;
  const cands = jointCandidates(design, res.design, 'c1', plate, { face: top.index }, (v) => `${v} mm`);

  it('a flat face offers its centre, its circles’ centres, edge midpoints, corners and the sketch points in it', () => {
    const kinds = cands.map((c) => (c.origin.kind === 'snap' ? c.origin.snap : c.origin.kind));
    expect(kinds.filter((k) => k === 'centroid')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'centre')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'mid')).toHaveLength(4);
    expect(kinds.filter((k) => k === 'vertex')).toHaveLength(4);
    // the point sketched on the top plane is offered, the one on the bottom plane is not
    const pts = cands.filter((c) => c.origin.kind === 'point');
    expect(pts.map((c) => c.label)).toEqual(['point of OnTop']);
    expect(pts[0].o).toEqual([80, 15, 10]);
  });

  it('the pointer near the hole takes its centre; the glyphs mark it with its Z axis', () => {
    const i = nearestCandidate(cands, [52, 31, 10]);
    expect(cands[i].label).toBe('centre of the ⌀20 mm circle');
    expect(cands[i].z[2]).toBeCloseTo(1, 12);
    const [others, chosen] = candidateGlyphs(cands, i, IDENTITY, 100);
    // a 12-gon ring for every other candidate; the chosen: two rings, the axis and its head
    expect(others.segments.length).toBe((cands.length - 1) * 12 * 6);
    expect(chosen.segments.length).toBe((20 + 8 + 3) * 6);
    expect(chosen.overlay).toBe(true);
  });
});
