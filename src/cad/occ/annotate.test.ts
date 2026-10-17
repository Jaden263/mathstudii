// Annotations drawn on real sheets of exact views, checked against hand values: a
// dimension that reads the new size after a model edit with its text kept centred, one
// whose edge is gone drawn where it was and flagged (orange in the DXF), the corners of a
// section's cut faces as associative picks (the thickness of a plate cut through its
// hole), automatic dimensions with each size once, hole callouts from the hole features,
// the parts list of an assembly with repeated parts and its balloons, the ISO 7200 title
// block, and the DIM and TEXT layers of the DXF.
import { describe, expect, it } from 'vitest';
import { evaluateWorksheet, type CadResult } from '../../engine/evaluator';
import { cadExample } from '../../model/examples';
import { createRegion, emptyWorksheet, type CadRegion, type DrawingRegion } from '../../model/types';
import { designOf, type CadDesign } from '../design';
import { designNumbers } from '../keys';
import { answer, displayFor } from '../kernel/service';
import type { DrawView } from '../drawing2d';
import { drawingRequests, layoutSheet, type Sheet, type SheetInfo } from '../drawingSheet';
import { sheetDxf } from '../drawingDxf';
import { annotateSheet, annotationParts, autoBalloons, frameOfView, viewPicks } from '../drawingAnnotate';
import { autoDimensions } from '../autoDims';
import { bomRows, type Annotation, type DimAnnotation, type DrawPick } from '../annotations';
import { newDimension } from '../annotationTools';
import { pickAt, pickOf, type DrawnPart } from '../drawingRefs';
import { points, poly, rect, roundedRect, single, solve, withCircles } from './fixtures';

const { PI } = Math;

/** A plate w × 60 × t from the origin, a Ø20 hole at (50, 30) unless left out. */
const plate = (w: number, t = 10, hole = true) => single([
  { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: hole ? withCircles(rect('a', 0, 0, w, 60), 'h', [[50, 30, 10]]) : rect('a', 0, 0, w, 60) },
  { kind: 'extrude', id: 'f1', name: 'Plate', sketch: 's1', extent: { type: 'one', d: String(t) }, op: 'new' },
]);

const drawing = (init: Partial<DrawingRegion> = {}) => createRegion('drawing', 0, 0, { cad: 'x', hidden: true, dims: false, scale: 1, ...init }) as DrawingRegion;

/** The design built and drawn as the app does it: views from the kernel, topology from the display build. */
async function sheetOf(design: CadDesign, r: DrawingRegion, o: { density?: string; info?: Partial<SheetInfo> } = {}) {
  const { res, numbers } = solve(design, [], o.density);
  const views = (await answer({ op: 'drawing', design, numbers, views: drawingRequests(r) })).value as Record<string, DrawView>;
  const parts = annotationParts(displayFor(design, numbers), design)!;
  const sheet = layoutSheet(r, views, { unit: 'mm', name: 'Part', date: '2026-10-17', overall: false, ...o.info })!;
  return { sheet, parts, res };
}

/** The pick a click at a view point makes (points first, as the tool does). */
function pick(r: DrawingRegion, sheet: Sheet, parts: DrawnPart[], view: string, x: number, y: number, o: { points?: boolean } = {}): DrawPick {
  const pv = sheet.views.find((v) => v.key === view)!;
  const hit = pickAt(viewPicks(r, pv, parts)!.ents, x, y, 0.5, 0.5, o);
  expect(hit, `nothing to pick at ${x}, ${y} on ${view}`).not.toBeNull();
  return pickOf(hit!, parts);
}

const ownLabels = (sheet: Sheet, id: string) => sheet.labels.filter((l) => l.owner === id);

describe('annotations on the sheet', () => {
  it('a width follows the plate from 100 to 120 mm with its text kept centred; a dimension to a hole that goes is flagged where it was', async () => {
    const r = drawing({ views: { front: false, top: true, side: false, iso: false } });
    const a = await sheetOf(plate(100), r);
    const left = pick(r, a.sheet, a.parts, 'top', 0, 0), right = pick(r, a.sheet, a.parts, 'top', 100, 0), centre = pick(r, a.sheet, a.parts, 'top', 50, 30);
    const width = newDimension('w', 'top', [left, right], [50, -15])!;
    const toHole: DimAnnotation = { ...newDimension('x', 'top', [left, centre], [25, -25])!, orient: 'h' };
    const anns: Annotation[] = [width, toHole];
    const placedA = annotateSheet(a.sheet, { ...r, annotations: anns }, { unit: 'mm', parts: a.parts });
    expect(placedA.map((p) => [p.text, p.lost])).toEqual([['100', undefined], ['50', undefined]]);
    // at 1:1 the text sits over the middle of the plate on the paper
    const top = a.sheet.views.find((v) => v.key === 'top')!;
    const mid = (s: Sheet, id: string) => ownLabels(s, id)[0].x + ownLabels(s, id)[0].w! / 2;
    expect(mid(a.sheet, 'w')).toBeCloseTo(top.ox + 50, 6);

    // wider: the same picks measure 120, the text moves to the new middle
    const b = await sheetOf(plate(120), r);
    const placedB = annotateSheet(b.sheet, { ...r, annotations: anns }, { unit: 'mm', parts: b.parts });
    expect(placedB.map((p) => p.text)).toEqual(['120', '50']);
    const topB = b.sheet.views.find((v) => v.key === 'top')!;
    expect(mid(b.sheet, 'w')).toBeCloseTo(topB.ox + 60, 6);

    // no hole: the width stays, the dimension to the hole is lost, drawn where it was in orange
    const c = await sheetOf(plate(100, 10, false), r);
    const placedC = annotateSheet(c.sheet, { ...r, annotations: anns }, { unit: 'mm', parts: c.parts });
    expect(placedC[0].lost).toBeUndefined();
    expect(placedC[1]).toMatchObject({ lost: 'the edge it was on is gone', text: '50' });
    expect(ownLabels(c.sheet, 'x').every((l) => l.warn)).toBe(true);
    expect(c.sheet.inks.filter((i) => i.owner === 'x').every((i) => i.warn)).toBe(true);
    expect(c.sheet.inks.filter((i) => i.owner === 'w').some((i) => i.warn)).toBe(false);
    // the DXF: the lost one in colour 30 on DIM, its text fitted to its width
    const dxf = sheetDxf(c.sheet).split('\n');
    const texts = entities(dxf, 'TEXT');
    const t50 = texts.find((e) => e['1'] === '50')!;
    expect(t50).toMatchObject({ 8: 'DIM', 62: '30', 72: '5' });
    expect(+t50['11'] - +t50['10']).toBeCloseTo(ownLabels(c.sheet, 'x')[0].w!, 6);
    expect(texts.find((e) => e['1'] === '100')!['62']).toBeUndefined();
  });

  it('a section: the corners of its cut faces follow the plate (thickness 10 → 15), the hole cut through its axis is Ø20', async () => {
    const r = drawing({ views: { front: false, top: true, side: false, iso: false }, sections: [{ id: 'sa', letter: 'A', view: 'top', a: { x: -10, y: 30 }, b: { x: 110, y: 30 } }] });
    const a = await sheetOf(plate(100), r);
    const f = frameOfView(r, 'sec:sa')!;
    // the cut corners at x = 0, z = 0 and 10 on the section's paper
    const P = (x: number, y: number, z: number): [number, number] => [x * f.right[0] + y * f.right[1] + z * f.right[2], x * f.up[0] + y * f.up[1] + z * f.up[2]];
    const c0 = pick(r, a.sheet, a.parts, 'sec:sa', ...P(0, 30, 0)), c1 = pick(r, a.sheet, a.parts, 'sec:sa', ...P(0, 30, 10));
    expect([c0.snap, c1.snap].every((s) => s === 'cut0' || s === 'cut1')).toBe(true);
    // the hole's wall, cut through its axis: both outlines on the paper
    const wall = pick(r, a.sheet, a.parts, 'sec:sa', ...P(40, 30, 5), { points: false });
    expect(wall.snap).toBe('cyl');
    const anns: Annotation[] = [
      { ...newDimension('t', 'sec:sa', [c0, c1], [P(0, 30, 5)[0] - 15, 5])!, orient: 'v' },
      { id: 'h', kind: 'dim', view: 'sec:sa', type: 'diameter', a: wall, text: [P(50, 30, 0)[0], 20] },
    ];
    expect(annotateSheet(a.sheet, { ...r, annotations: anns }, { unit: 'mm', parts: a.parts }).map((p) => [p.text, p.lost])).toEqual([['10', undefined], ['Ø20', undefined]]);
    const b = await sheetOf(plate(100, 15), r);
    expect(annotateSheet(b.sheet, { ...r, annotations: anns }, { unit: 'mm', parts: b.parts }).map((p) => [p.text, p.lost])).toEqual([['15', undefined], ['Ø20', undefined]]);
  });

  it('automatic dimensions of a plate: 100, 60 and 10 once each, the hole Ø20, its place 50 and 30 from the edges', async () => {
    const r = drawing({ dims: true });
    const a = await sheetOf(plate(100), r);
    const auto = autoDimensions(r, a.sheet, a.parts);
    const placed = annotateSheet(a.sheet, r, { unit: 'mm', parts: a.parts }, auto);
    const texts = placed.map((p) => `${p.view}:${p.text}`).sort();
    expect(texts).toEqual(['front:10', 'front:100', 'top:30', 'top:50', 'top:60', 'top:Ø20'].sort());
    expect(placed.every((p) => !p.lost && p.auto)).toBe(true);
  });

  it('automatic dimensions of the flange assembly: Ø200 (both sizes square to its axis), 180 high, the bolt circle Ø150 and the callout once', async () => {
    const ws = cadExample();
    const { results } = evaluateWorksheet(ws);
    const asm = ws.regions.find((q) => q.kind === 'cad' && q.name === 'asm') as CadRegion;
    // the example's drawing without its own annotations
    const r0 = { ...(ws.regions.find((q) => q.kind === 'drawing') as DrawingRegion), annotations: [] };
    const design = designOf(asm), numbers = designNumbers((results.get(asm.id) as CadResult).design!);
    const views = (await answer({ op: 'drawing', design, numbers, views: drawingRequests(r0) })).value as Record<string, DrawView>;
    const parts = annotationParts(displayFor(design, numbers), design)!;
    const sheet = layoutSheet(r0, views, { unit: 'mm', name: 'asm', date: '', overall: false })!;
    const params = (results.get(asm.id) as CadResult).design!.params;
    const placed = annotateSheet(sheet, r0, { unit: 'mm', parts, design, params }, autoDimensions(r0, sheet, parts));
    expect(placed.map((p) => `${p.view}:${p.text}`).sort()).toEqual(['front:180', 'front:Ø200', 'top:6× Ø9 ⌴ Ø15 ↧ 4', 'top:Ø150', 'top:Ø51'].sort());
  });
});

describe('angles, radii and arc lengths', () => {
  it('a plate with a corner cut at 45° and rounded corners: 45°, R10 and the quarter arc π/2 · 10 = 15.71', async () => {
    const r = drawing({ views: { front: false, top: true, side: false, iso: false } });
    const cut = single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: poly('a', [[0, 0], [100, 0], [60, 40], [0, 40]]) },
      { kind: 'extrude', id: 'f1', name: 'Plate', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
    ]);
    const a = await sheetOf(cut, r);
    const bottom = pick(r, a.sheet, a.parts, 'top', 50, 0, { points: false }), slant = pick(r, a.sheet, a.parts, 'top', 80, 20, { points: false });
    const angle = newDimension('ang', 'top', [bottom, slant], [80, 6])!;
    expect(angle.type).toBe('angle');
    expect(annotateSheet(a.sheet, { ...r, annotations: [angle] }, { unit: 'mm', parts: a.parts }).map((p) => p.text)).toEqual(['45°']);
    const round = single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: roundedRect('a', 100, 60, 10) },
      { kind: 'extrude', id: 'f1', name: 'Plate', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
    ]);
    const b = await sheetOf(round, r);
    // the corner round at (90, 50): its arc through (90 + 10 cos 45°, 50 + 10 sin 45°)
    const arc = pick(r, b.sheet, b.parts, 'top', 90 + 10 * Math.SQRT1_2, 50 + 10 * Math.SQRT1_2, { points: false });
    const rad = newDimension('rad', 'top', [arc], [110, 70])!;
    expect(rad.type).toBe('radius');
    const len: DimAnnotation = { ...rad, id: 'len', type: 'arc', text: [105, 65] };
    expect(annotateSheet(b.sheet, { ...r, annotations: [rad, len] }, { unit: 'mm', parts: b.parts }).map((p) => [p.text, p.value])).toEqual([
      ['R10', expect.closeTo(10, 9)], ['⌒15.71', expect.closeTo((PI / 2) * 10, 9)],
    ]);
  });
});

describe('the example drawing', () => {
  /** The flange assembly's drawing as the example has it, at a torque T. */
  async function example(T: string) {
    const ws = cadExample();
    const math = ws.regions.find((q) => q.kind === 'math' && q.source.startsWith('T :='));
    if (math?.kind === 'math') math.source = `T := ${T}`;
    const { results } = evaluateWorksheet(ws);
    const asm = ws.regions.find((q) => q.kind === 'cad' && q.name === 'asm') as CadRegion;
    const r = ws.regions.find((q) => q.kind === 'drawing') as DrawingRegion;
    const res = results.get(asm.id) as CadResult;
    const design = designOf(asm), numbers = designNumbers(res.design!);
    const views = (await answer({ op: 'drawing', design, numbers, views: drawingRequests(r) })).value as Record<string, DrawView>;
    const parts = annotationParts(displayFor(design, numbers), design)!;
    // as the app lays it out: the parts list over the title block
    const bom = bomRows(design, { density: asm.density });
    const sheet = layoutSheet(r, views, { unit: 'mm', name: 'asm', date: '', bom, assembly: true, overall: false })!;
    return { sheet, placed: annotateSheet(sheet, r, { unit: 'mm', parts, design, params: res.design!.params, bom }) };
  }

  it('reads its own sizes and follows the torque: T 450 → 900 N·m makes the shaft Ø50 (g6: −9 / −25 µm from 30 up to 50 mm)', async () => {
    const a = await example('450 N*m');
    expect(a.sheet.scale).toBe(0.4);
    expect(a.placed.map((p) => [p.id, p.text, p.lost ?? null])).toEqual([
      ['n_d', 'Ø40 g6 ( −0.009 / −0.025 )', null], ['n_cb', '4', null], ['n_g', 'Perpendicularity Ø0.05 | A', null], ['n_a', 'A', null],
      ['n_r1', 'Ra 0.8', null], ['n_r2', 'Ra 3.2', null], ['n_n', 'General tolerances ISO 2768-mK\nBreak sharp edges 0.3', null],
      ['n_b1', 'Item 1: Flange', null], ['n_b2', 'Item 2: Shaft', null],
    ]);
    // d = ceil((16 T / (π 40 MPa))^(1/3) / 5 mm) 5 mm = 50 mm at 900 N·m; the sheet goes to 1:5
    const b = await example('900 N*m');
    expect(b.sheet.scale).toBe(0.2);
    expect(b.placed.find((p) => p.id === 'n_d')).toMatchObject({ text: 'Ø50 g6 ( −0.009 / −0.025 )', value: 50 });
    // the counterbore is on the larger bolt circle now, outside detail B's fixed circle: flagged, not silently elsewhere
    expect(b.placed.find((p) => p.id === 'n_cb')?.lost).toMatch(/no longer inside detail B/);
    expect(b.placed.filter((p) => p.lost).map((p) => p.id)).toEqual(['n_cb']);
    // placed at 1:2.5, the frame under the Ø keeps its paper distance from the shaft at 1:5
    const label = (s: Sheet, id: string) => s.labels.find((l) => l.owner === id)!;
    const shaftX = (s: Sheet) => s.views.find((v) => v.key === 'front')!.ox;
    expect(label(b.sheet, 'n_d').x - shaftX(b.sheet) - 25 * 0.2).toBeCloseTo(label(a.sheet, 'n_d').x - shaftX(a.sheet) - 20 * 0.4, 6);
  });
});

describe('hole callouts from the hole feature', () => {
  it('tapped, counterbored and countersunk holes picked on the sheet', async () => {
    const design = single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: rect('a', 0, 0, 100, 60) },
      { kind: 'extrude', id: 'f1', name: 'Plate', sketch: 's1', extent: { type: 'one', d: '20' }, op: 'new' },
      { kind: 'sketch', id: 's2', name: 'P', plane: { ref: 'XY', offset: '20' }, sketch: points('p', [[15, 15], [85, 15], [85, 45], [15, 45]]) },
      { kind: 'hole', id: 'h1', name: 'Tapped', sketch: 's2', d: '', depth: '15', style: 'simple', tap: { size: 'M8', depth: '12' }, dir: '-' },
      { kind: 'sketch', id: 's3', name: 'Q', plane: { ref: 'XY', offset: '20' }, sketch: points('q', [[35, 30], [65, 30]]) },
      { kind: 'hole', id: 'h2', name: 'Sunk', sketch: 's3', d: '6.6', depth: '', through: true, style: 'countersink', csD: '13', csAngle: '90 deg', dir: '-' },
      { kind: 'sketch', id: 's4', name: 'R', plane: { ref: 'XY', offset: '20' }, sketch: points('r', [[50, 50]]) },
      { kind: 'hole', id: 'h3', name: 'Bored', sketch: 's4', d: '8.5', depth: '', through: true, style: 'counterbore', cbD: '14', cbDepth: '8', dir: '-' },
    ]);
    const r = drawing({ views: { front: false, top: true, side: false, iso: false } });
    const { sheet, parts, res } = await sheetOf(design, r);
    const at = (x: number, y: number, rr: number) => pick(r, sheet, parts, 'top', x + rr, y, { points: false });
    const anns: Annotation[] = [
      { id: 'c1', kind: 'hole', view: 'top', a: at(15, 15, 3.375), at: [0, 70] },
      { id: 'c2', kind: 'hole', view: 'top', a: at(35, 30, 3.3), at: [0, 80] },
      { id: 'c3', kind: 'hole', view: 'top', a: at(50, 50, 4.25), at: [0, 90] },
    ];
    const placed = annotateSheet(sheet, { ...r, annotations: anns }, { unit: 'mm', parts, design, params: res.design!.params });
    // ISO 262: M8 coarse P = 1.25, its tap drill 8 − 1.25 = 6.75 drilled 15 deep
    expect(placed.map((p) => p.text)).toEqual(['4× M8 – 6H ↧ 12\nØ6.75 ↧ 15', '2× Ø6.6 ⌵ Ø13 × 90°', 'Ø8.5 ⌴ Ø14 ↧ 8']);
    expect(placed.every((p) => !p.lost && !p.error)).toBe(true);
    // the symbols are drawn as lines, the rest as text set to its width
    expect(ownLabels(sheet, 'c3').map((l) => l.text)).toEqual(['Ø8.5', 'Ø14', '8']);
  });
});

describe('parts list and balloons of an assembly', () => {
  it('a plate and four pins of one component: the pins once with quantity 4 and their mass each; one balloon per item', async () => {
    const pin = { id: 'pin', name: 'Pin Ø8×30', density: '7850 kg/m^3', items: [
      { kind: 'sketch' as const, id: 'ps', name: 'S', plane: { ref: 'XY' as const }, sketch: withCircles({ points: [], entities: [], constraints: [] }, 'c', [[0, 0, 4]]) },
      { kind: 'extrude' as const, id: 'pe', name: 'Pin', sketch: 'ps', extent: { type: 'one' as const, d: '30' }, op: 'new' as const },
    ] };
    const plateC = { id: 'pl', name: 'Plate', items: [
      { kind: 'sketch' as const, id: 's1', name: 'S', plane: { ref: 'XY' as const }, sketch: withCircles(rect('a', 0, 0, 100, 60), 'h', [[20, 15, 4], [80, 15, 4], [80, 45, 4], [20, 45, 4]]) },
      { kind: 'extrude' as const, id: 'f1', name: 'Plate', sketch: 's1', extent: { type: 'one' as const, d: '10' }, op: 'new' as const },
    ] };
    const design: CadDesign = {
      version: 2, components: [plateC, pin], joints: [],
      occurrences: [
        { id: 'op', component: 'pl', grounded: true },
        ...[[20, 15], [80, 15], [80, 45], [20, 45]].map(([x, y], i) => ({ id: `pin${i}`, component: 'pin', grounded: true, pos: [x, y, -10] as [number, number, number] })),
      ],
    };
    const ws = emptyWorksheet();
    const cad = createRegion('cad', 20, 400, { name: 'asm', design, density: '2700 kg/m^3' }) as CadRegion;
    ws.regions = [cad];
    const res = evaluateWorksheet(ws).results.get(cad.id) as CadResult;
    const masses = Object.fromEntries(Object.entries(res.design!.components).map(([k, v]) => [k, v?.m]));
    const bom = bomRows(design, { masses, density: cad.density });
    // a pin: π 4² 30 = 1507.96 mm³ of steel, 11.84 g; the plate 100 × 60 × 10 less four Ø8 holes, aluminium: 156.57 g
    expect(bom.map((b) => [b.item, b.name, b.qty, b.material])).toEqual([[1, 'Plate', 1, 'Aluminium'], [2, 'Pin Ø8×30', 4, 'Steel']]);
    expect(bom[1].mass).toBeCloseTo(PI * 16 * 30 * 7850e-9, 9);
    expect(bom[0].mass).toBeCloseTo((60000 - 4 * PI * 16 * 10) * 2700e-9, 9);

    const r = drawing({ views: { front: true, top: true, side: false, iso: false }, bom: { show: true }, titleBlock: { checkedBy: 'A. Checker', sheet: 2, sheets: 3 } });
    const numbers = designNumbers(res.design!);
    const views = (await answer({ op: 'drawing', design, numbers, views: drawingRequests(r) })).value as Record<string, DrawView>;
    const parts = annotationParts(displayFor(design, numbers), design)!;
    const sheet = layoutSheet(r, views, { unit: 'mm', name: 'asm', date: '2026-10-17', mass: res.mass?.m, bom, assembly: true, overall: false })!;
    // the parts list over the title block: item, quantity, name, material, mass each
    const texts = sheet.labels.map((l) => l.text);
    expect(texts).toEqual(expect.arrayContaining(['Item', 'Qty', 'Name', 'Material', 'Mass (kg)', '2', '4', 'Pin Ø8×30', 'Steel', '0.0118', '0.157']));
    // the title block: ISO 7200 fields, the mass of everything drawn, sheet 2 of 3
    expect(texts).toEqual(expect.arrayContaining(['Checked by', 'A. Checker', 'Approved by', 'Legal owner', 'Document type', 'Assembly drawing', 'Drawing no.', 'Sheet', '2/3', '0.204 kg', 'First angle projection']));
    let n = 0;
    const balloons = autoBalloons(r, sheet, parts, bom, 'front', () => `b${++n}`);
    expect(balloons.map((b) => b.kind === 'balloon' && b.occ)).toEqual(['op', 'pin0']);
    const placed = annotateSheet(sheet, { ...r, annotations: balloons }, { unit: 'mm', parts, design, bom });
    expect(placed.map((p) => [p.text, p.lost])).toEqual([['Item 1: Plate', undefined], ['Item 2: Pin Ø8×30', undefined]]);
    expect(ownLabels(sheet, 'b1').map((l) => l.text)).toEqual(['1']);
  });
});

describe('symbols and their layers', () => {
  it('a frame, a datum, a surface symbol, a note and a centre mark on the plate; an automatic centre mark taken away', async () => {
    const r = drawing({ views: { front: true, top: true, side: false, iso: false } });
    const { sheet, parts } = await sheetOf(plate(100), r);
    const bottom = pick(r, sheet, parts, 'front', 30, 0, { points: false }), topEdge = pick(r, sheet, parts, 'front', 30, 10, { points: false });
    const hole = pick(r, sheet, parts, 'top', 60, 30, { points: false });
    const anns: Annotation[] = [
      { id: 'da', kind: 'datum', view: 'front', letter: 'A', at: [10, -15], leader: bottom },
      { id: 'g', kind: 'gdt', view: 'front', char: 'parallelism', tol: 0.02, datums: [{ letter: 'A' }], at: [60, 25], leader: topEdge },
      { id: 's', kind: 'surface', view: 'front', param: 'Ra', value: 1.6, process: 'removal', at: [80, 10], leader: topEdge },
      { id: 'n', kind: 'note', view: 'top', text: 'Deburr\nall edges', at: [110, 70] },
      { id: 'c', kind: 'centre', view: 'top', a: hole, hide: true },
    ];
    const placed = annotateSheet(sheet, { ...r, annotations: anns }, { unit: 'mm', parts });
    expect(placed.map((p) => [p.id, p.text, p.lost ?? null, p.error ?? null])).toEqual([
      ['da', 'A', null, null], ['g', 'Parallelism 0.02 | A', null, null], ['s', 'Ra 1.6', null, null], ['n', 'Deburr\nall edges', null, null], ['c', undefined, null, null],
    ]);
    // the datum: the letter framed, the filled triangle on the bottom edge (its base on y = 0 of the front view)
    const front = sheet.views.find((v) => v.key === 'front')!;
    const tri = sheet.fills.find((q) => q.owner === 'da')!;
    expect(tri.pts.filter((_, i) => i % 2 === 1).filter((y) => Math.abs(y - front.oy) < 1e-9)).toHaveLength(2);
    // frames and symbols on DIM, the note's text on TEXT, two lines 10/7 h apart (ISO 3098)
    expect(sheet.inks.filter((i) => ['da', 'g', 's'].includes(i.owner ?? '')).every((i) => i.layer === 'DIM')).toBe(true);
    const note = ownLabels(sheet, 'n');
    expect(note.map((l) => [l.text, l.layer])).toEqual([['Deburr', 'TEXT'], ['all edges', 'TEXT']]);
    expect(note[0].y - note[1].y).toBeCloseTo((10 / 7) * 3.5, 9);
    // the automatic centre mark of the hole is gone from the top view (the front view's centre line stays)
    const r2 = { ...r, annotations: anns };
    const again = layoutSheet(r2, Object.fromEntries(sheet.views.map((v) => [v.key, v.view])), { unit: 'mm', name: 'Part', date: '', overall: false })!;
    const top = again.views.find((v) => v.key === 'top')!;
    const inTop = (x: number, y: number) => x > top.box.x0 - 5 && x < top.box.x1 + 5 && y > top.box.y0 - 5 && y < top.box.y1 + 5;
    const marks = (s: Sheet) => s.inks.filter((i) => i.layer === 'CENTER' && i.p.k === 'line' && inTop(i.p.x1, i.p.y1) && inTop(i.p.x2, i.p.y2)).length;
    expect(marks(sheet)).toBe(2);
    expect(marks(again)).toBe(0);
  });
});

/** The entities of a type in a DXF's ENTITIES section, as code → value (first occurrence). */
function entities(codes: string[], type: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const start = codes.indexOf('ENTITIES');
  for (let i = start; i < codes.length - 1; i++) {
    if (codes[i].trim() !== '0' || codes[i + 1] !== type) continue;
    const e: Record<string, string> = {};
    for (let k = i + 2; k < codes.length - 1 && codes[k].trim() !== '0'; k += 2) e[codes[k].trim()] ??= codes[k + 1];
    out.push(e);
  }
  return out;
}
