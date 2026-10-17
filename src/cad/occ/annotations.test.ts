// Drawing annotations on the exact model: dimensions pick named vertices, edges and
// faces, follow a model edit to the new size, and are lost (flagged, not silently wrong)
// when what they measure is gone; hole callouts come from the hole feature.
import { describe, expect, it } from 'vitest';
import type { CadDesign } from '../design';
import { STANDARD_VIEWS } from '../drawing';
import { dimensionValue, drawnParts, pickAt, pickOf, resolvePick, viewEntities, viewFrame, type ViewFrame } from '../drawingRefs';
import type { DimAnnotation, DrawPick } from '../annotations';
import { holeCallout, holeCount, holeData, holeOfKey } from '../annotations';
import { displayFor } from '../kernel/service';
import { points, rect, single, solve, withCircles } from './fixtures';

/** A w × 60 × 10 plate from the origin, with a Ø20 hole at (50, 30) unless left out. */
const plate = (w: number, hole = true) => single([
  { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: hole ? withCircles(rect('a', 0, 0, w, 60), 'h', [[50, 30, 10]]) : rect('a', 0, 0, w, 60) },
  { kind: 'extrude', id: 'f1', name: 'Plate', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
]);

function built(design: CadDesign) {
  const { numbers, res } = solve(design);
  const build = displayFor(design, numbers)!;
  return { parts: drawnParts(build, design), res, build };
}

const top: ViewFrame = viewFrame(STANDARD_VIEWS.top);
const front: ViewFrame = viewFrame(STANDARD_VIEWS.front);

/** The pick at a point of a view (points first), as the drawing's tool makes it. */
function pick(design: CadDesign, f: ViewFrame, x: number, y: number, o: { points?: boolean } = {}): DrawPick {
  const { parts } = built(design);
  const hit = pickAt(viewEntities(parts, f), x, y, 0.5, 0.5, o)!;
  expect(hit).not.toBeNull();
  return pickOf(hit, parts);
}

function value(design: CadDesign, f: ViewFrame, d: DimAnnotation): number | null | 'lost' {
  const { parts } = built(design);
  const a = resolvePick(d.a, parts, f), b = d.b && resolvePick(d.b, parts, f);
  if (!a.ok || (b && !b.ok)) return 'lost';
  return dimensionValue(d, a, b && b.ok ? b : undefined);
}

describe('associative drawing dimensions', () => {
  it('a width between two corners follows the plate from 100 to 120 mm; a Ø of the hole stays 20', () => {
    const p100 = plate(100);
    // the corners of the top view at (0, 0) and (100, 0): vertices named after their faces,
    // the one on the top face (nearer the viewer than the one under it)
    const a = pick(p100, top, 0.1, 0.1), b = pick(p100, top, 99.9, -0.1);
    expect(a.snap).toBe('vertex');
    expect(a.ref?.key).toBe('f1/end|f1/side:al0|f1/side:al3');
    const width: DimAnnotation = { id: 'w', kind: 'dim', view: 'top', type: 'linear', orient: 'h', a, b, text: [50, -15] };
    expect(value(p100, top, width)).toBeCloseTo(100, 9);
    const hole = pick(p100, top, 60.05, 30, { points: false });
    expect(hole.snap).toBe('circle');
    const dia: DimAnnotation = { id: 'd', kind: 'dim', view: 'top', type: 'diameter', a: hole, text: [70, 45] };
    expect(value(p100, top, dia)).toBeCloseTo(20, 12);
    // the model made wider: the same picks measure the new plate
    const p120 = plate(120);
    expect(value(p120, top, width)).toBeCloseTo(120, 9);
    expect(value(p120, top, dia)).toBeCloseTo(20, 12);
    // the front view: the plate's thickness between its top and bottom edges (two lines)
    const t1 = pick(p120, front, 30, 10, { points: false }), t2 = pick(p120, front, 30, 0, { points: false });
    expect([t1.snap, t2.snap]).toEqual(['line', 'line']);
    expect(value(p120, front, { id: 't', kind: 'dim', view: 'front', type: 'linear', a: t1, b: t2, text: [-15, 5] })).toBeCloseTo(10, 12);
  });

  it('a dimension to the hole is lost when the hole goes, and says so', () => {
    const p = plate(100);
    const corner = pick(p, top, 0, 0), centre = pick(p, top, 50, 30);
    expect(centre.snap).toBe('centre');
    const pos: DimAnnotation = { id: 'x', kind: 'dim', view: 'top', type: 'linear', orient: 'h', a: corner, b: centre, text: [25, -10] };
    expect(value(p, top, pos)).toBeCloseTo(50, 9);
    const noHole = plate(100, false);
    expect(value(noHole, top, pos)).toBe('lost');
    const { parts } = built(noHole);
    const r = resolvePick(centre, parts, top);
    expect(r).toEqual({ ok: false, why: 'the edge it was on is gone' });
    // the corner itself is still there
    expect(resolvePick(corner, parts, top).ok).toBe(true);
  });

  it('a cylinder seen side-on is measured across its outlines (Ø on the silhouettes)', () => {
    const pin = single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: withCircles({ points: [], entities: [], constraints: [] }, 'c', [[0, 0, 12.5]]) },
      { kind: 'extrude', id: 'f1', name: 'Pin', sketch: 's1', extent: { type: 'one', d: '40' }, op: 'new' },
    ]);
    const sil = pick(pin, front, 12.5, 20, { points: false });
    expect(sil.snap).toBe('cyl');
    expect(value(pin, front, { id: 'p', kind: 'dim', view: 'front', type: 'diameter', a: sil, text: [0, 50] })).toBeCloseTo(25, 12);
  });
});

describe('hole callouts from the feature', () => {
  it('four tapped M8 holes, threaded 12 deep in a 15 deep drill: "4× M8 – 6H ↧ 12", then the drill', () => {
    const design = single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: rect('a', 0, 0, 100, 60) },
      { kind: 'extrude', id: 'f1', name: 'Plate', sketch: 's1', extent: { type: 'one', d: '20' }, op: 'new' },
      { kind: 'sketch', id: 's2', name: 'P', plane: { ref: 'XY', offset: '20' }, sketch: points('p', [[15, 15], [85, 15], [85, 45], [15, 45]]) },
      { kind: 'hole', id: 'h1', name: 'Tapped', sketch: 's2', d: '', depth: '15', style: 'simple', tap: { size: 'M8', depth: '12' }, dir: '-' },
    ]);
    const { parts, res } = built(design);
    const keys = parts[0].bodies.flatMap((b) => b.faces.map((f) => f.key));
    // the wall of a hole names its feature and hole
    const wall = keys.find((k) => /h1\/hole\d:wall/.test(k))!;
    expect(holeOfKey(wall)?.feature).toBe('h1');
    expect(holeCount('h1', keys)).toBe(4);
    const item = design.components[0].items.find((i) => i.id === 'h1')!;
    const h = holeData(item as Extract<typeof item, { kind: 'hole' }>, res.design!.params.h1)!;
    // ISO 262: M8 coarse, P = 1.25, tap drill 8 − 1.25 = 6.75
    expect(h).toMatchObject({ style: 'simple', d: 6.75, depth: 15, tap: { name: 'M8', depth: 12 } });
    expect(holeCallout(h, 4, (v) => String(+v.toFixed(2)))).toBe('4× M8 – 6H ↧ 12\nØ6.75 ↧ 15');
  });

  it('counterbored and countersunk holes, through', () => {
    const fmt = (v: number) => String(+v.toFixed(2));
    expect(holeCallout({ style: 'counterbore', d: 8.5, cbD: 14, cbDepth: 8 }, 1, fmt)).toBe('Ø8.5 ⌴ Ø14 ↧ 8');
    expect(holeCallout({ style: 'countersink', d: 8.4, csD: 16, csAngle: Math.PI / 2 }, 2, fmt)).toBe('2× Ø8.4 ⌵ Ø16 × 90°');
    expect(holeCallout({ style: 'simple', d: 9, depth: 20 }, 6, fmt)).toBe('6× Ø9 ↧ 20');
  });
});
