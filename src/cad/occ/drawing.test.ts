// Drawing views from OpenCascade's exact hidden-line removal, checked against what a
// draughtsman draws by hand: the outline and hidden lines of a plate with a hole, true
// circles and centre marks, a cylinder's silhouettes at ±R, a hollow cylinder's cut faces
// of (D − d)·L, ISO 6410 cosmetic threads at the ISO 68-1 diameters, and the sheet's DXF.
import { describe, expect, it } from 'vitest';
import { evaluateWorksheet, type CadResult } from '../../engine/evaluator';
import { cadExample } from '../../model/examples';
import { createRegion, type CadRegion, type DrawingRegion } from '../../model/types';
import { designOf, type CadDesign } from '../design';
import { STANDARD_VIEWS } from '../drawing';
import { loopsArea, primLength, type DrawView, type DrawViewRequest, type Prim } from '../drawing2d';
import { baseRequests, layoutSheet, sectionRequest } from '../drawingSheet';
import { sheetDxf } from '../drawingDxf';
import { designKey, designNumbers } from '../keys';
import { answer, drawViewFor } from '../kernel/service';
import { meshBuildResult } from '../buildResult';
import { kernel } from '../solid';
import { circles, points, rect, single, solve, watchHandles, withCircles } from './fixtures';
import { buildDesignCached } from './build';
import { drawViewOcc } from './drawing';
import { occ } from './kernel';

const { PI } = Math;
type Line = Extract<Prim, { k: 'line' }>;
type Arc = Extract<Prim, { k: 'arc' }>;

const req = (key: keyof typeof STANDARD_VIEWS, extra: Partial<DrawViewRequest> = {}): DrawViewRequest => ({
  key, name: STANDARD_VIEWS[key].name, dir: STANDARD_VIEWS[key].dir, up: STANDARD_VIEWS[key].up, hidden: true, ...extra,
});

function view(design: CadDesign, r: DrawViewRequest): DrawView {
  const oc = occ()!;
  const { numbers } = solve(design);
  return drawViewOcc(oc, buildDesignCached(oc, design, numbers), design, r);
}

const lines = (ps: Prim[]) => ps.filter((p): p is Line => p.k === 'line');
const arcs = (ps: Prim[]) => ps.filter((p): p is Arc => p.k === 'arc');
/** Vertical lines at x, their total length. */
const verticalAt = (ps: Prim[], x: number) => lines(ps).filter((l) => Math.abs(l.x1 - x) < 1e-9 && Math.abs(l.x2 - x) < 1e-9).reduce((s, l) => s + primLength(l), 0);

/** 100 × 60 × 10 plate from the origin with a Ø20 hole at (50, 30). */
const plate = () => single([
  { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: withCircles(rect('a', 0, 0, 100, 60), 'h', [[50, 30, 10]]) },
  { kind: 'extrude', id: 'f1', name: 'Plate', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
]);

/** A tube along z: outer Ø D, bore Ø d, L long. */
const tube = (D: number, d: number, L: number) => single([
  { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: circles('c', [[0, 0, D / 2], [0, 0, d / 2]]) },
  { kind: 'extrude', id: 'f1', name: 'Tube', sketch: 's1', extent: { type: 'one', d: String(L) }, op: 'new' },
]);

const drawing = (init: Partial<DrawingRegion> = {}) => createRegion('drawing', 0, 0, { cad: 'x', hidden: true, dims: false, ...init }) as DrawingRegion;

describe('exact drawing views', () => {
  it('plate with a hole: the outline, two hidden lines at the hole, a true circle and its centre mark', () => {
    const front = view(plate(), req('front'));
    expect(front.mesh).toBeUndefined();
    // the outline: 2 × 100 + 2 × 10, nothing else visible
    expect(front.visible.every((p) => p.k === 'line')).toBe(true);
    expect(front.visible.reduce((s, p) => s + primLength(p), 0)).toBeCloseTo(220, 9);
    // hidden: the hole's two walls seen side-on, at x = 50 ∓ 10, the plate's thickness long
    expect(front.hidden).toHaveLength(2);
    expect(verticalAt(front.hidden, 40)).toBeCloseTo(10, 9);
    expect(verticalAt(front.hidden, 60)).toBeCloseTo(10, 9);
    // and the hole's axis as a centre line through the plate
    expect(front.axes).toEqual([{ kind: 'line', x1: expect.closeTo(50, 9), y1: expect.closeTo(10, 9), x2: expect.closeTo(50, 9), y2: expect.closeTo(0, 9) }]);
    expect(front.box).toEqual({ x0: expect.closeTo(0, 9), y0: expect.closeTo(0, 9), x1: expect.closeTo(100, 9), y1: expect.closeTo(10, 9) });

    const top = view(plate(), req('top'));
    // a true circle of the hole's radius (the one at the bottom, hidden under it, is merged away)
    const [hole] = arcs(top.visible);
    expect(hole).toMatchObject({ cx: expect.closeTo(50, 12), cy: expect.closeTo(30, 12), r: expect.closeTo(10, 12) });
    expect(hole.a1 - hole.a0).toBeCloseTo(2 * PI, 12);
    expect(top.hidden).toEqual([]);
    expect(top.axes).toEqual([{ kind: 'mark', x: expect.closeTo(50, 9), y: expect.closeTo(30, 9), r: expect.closeTo(10, 9) }]);
  });

  it('a cylinder seen side-on: silhouette lines at ±R and its axis; end-on a circle', () => {
    const pin = single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: circles('c', [[0, 0, 10]]) },
      { kind: 'extrude', id: 'f1', name: 'Pin', sketch: 's1', extent: { type: 'one', d: '30' }, op: 'new' },
    ]);
    for (const k of ['front', 'left'] as const) {
      const v = view(pin, req(k));
      expect(verticalAt(v.visible, 10)).toBeCloseTo(30, 9);
      expect(verticalAt(v.visible, -10)).toBeCloseTo(30, 9);
      expect(v.hidden).toEqual([]);
      expect(v.axes).toHaveLength(1);
      expect(v.axes[0]).toMatchObject({ kind: 'line', x1: expect.closeTo(0, 9), x2: expect.closeTo(0, 9) });
      expect(v.box.x1 - v.box.x0).toBeCloseTo(20, 9);
    }
    const top = view(pin, req('top'));
    expect(arcs(top.visible).map((a) => a.r)).toEqual([expect.closeTo(10, 12)]);
    // an isometric view of the cylinder's end circle is an exact ellipse (minor/major = 1/√3)
    const iso = view(pin, req('iso', { hidden: false }));
    const el = iso.visible.find((p) => p.k === 'ellipse') as Extract<Prim, { k: 'ellipse' }>;
    expect(el.rx).toBeCloseTo(10, 9);
    expect(el.ry / el.rx).toBeCloseTo(1 / Math.sqrt(3), 9);
  });

  it('section of a hollow cylinder along its axis: cut faces of (D − d)·L, the bore beyond drawn', () => {
    const D = 40, d = 24, L = 50;
    const r = drawing({ sections: [{ id: 'A', letter: 'A', view: 'front', a: { x: 0, y: -10 }, b: { x: 0, y: L + 10 } }] });
    const rq = sectionRequest(r, r.sections![0]);
    // a vertical line on the front view, looked along to its right: along +x, as the left view
    expect(rq.dir).toEqual([expect.closeTo(1, 12), expect.closeTo(0, 12), expect.closeTo(0, 12)]);
    expect(rq.up).toEqual([expect.closeTo(0, 12), expect.closeTo(0, 12), expect.closeTo(1, 12)]);
    const v = view(tube(D, d, L), rq);
    expect(v.cuts).toHaveLength(1);
    // two strips (D − d)/2 wide, L long
    expect(loopsArea(v.cuts![0].loops)).toBeCloseTo((D - d) * L, 9);
    // beyond the plane: the outer silhouettes and the far half of the bore, all visible
    for (const x of [-20, -12, 12, 20]) expect(verticalAt(v.visible, x)).toBeCloseTo(L, 9);
    expect(v.hidden).toEqual([]);
    // the axis lies in the cut: a centre line along it
    expect(v.axes).toHaveLength(1);
    // the hatching on the sheet covers the same area: its lines' length × spacing
    const sheet = layoutSheet({ ...r, views: { front: true, top: false, side: false, iso: false } }, { front: view(tube(D, d, L), req('front')), [rq.key]: v }, { unit: 'mm', name: 'Tube', date: '2026-10-17' })!;
    const sec = sheet.views.find((p) => p.key === rq.key)!;
    const hatch = sheet.inks.filter((i) => i.layer === 'HATCH').map((i) => i.p as Line);
    expect(hatch.length).toBeGreaterThan(10);
    // hatching at 45°: the spacing measured square to the lines from two neighbours
    const [h0, h1] = [...hatch].sort((p, q) => (p.y1 - p.x1) - (q.y1 - q.x1));
    const spacing = Math.abs((h1.y1 - h1.x1) - (h0.y1 - h0.x1)) / Math.SQRT2;
    const covered = hatch.reduce((s, p) => s + primLength(p), 0) * spacing / sec.k ** 2;
    expect(Math.abs(covered / ((D - d) * L) - 1)).toBeLessThan(0.05);
  });

  it('assemblies: each body its own cut faces, hatched at different angles', async () => {
    const ws = cadExample();
    const out = evaluateWorksheet(ws);
    const asm = ws.regions.find((q) => q.kind === 'cad' && q.name === 'asm') as CadRegion;
    const design = designOf(asm), numbers = designNumbers((out.results.get(asm.id) as CadResult).design!);
    const r = drawing({ sections: [{ id: 'A', letter: 'A', view: 'front', a: { x: 0, y: -60 }, b: { x: 0, y: 160 } }] });
    const t0 = performance.now();
    const views = (await answer({ op: 'drawing', design, numbers, views: [...baseRequests(r), sectionRequest(r, r.sections![0])] })).value as Record<string, DrawView>;
    const ms = performance.now() - t0;
    console.log(`assembly example: four views and a section in ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(10000);
    const cuts = views['sec:A'].cuts!;
    expect(cuts.map((c) => c.body).sort()).toEqual(['of/ff1', 'os/fs1']);
    // the shaft (Ø d = 40 mm, 180 long) cut along its axis: a 40 × 180 strip
    expect(loopsArea(cuts.find((c) => c.body === 'os/fs1')!.loops)).toBeCloseTo(40 * 180, 6);
    const sheet = layoutSheet({ ...r, sheet: 'A3' }, views, { unit: 'mm', name: 'Asm', date: '' })!;
    expect(sheet.inks.filter((i) => i.layer === 'HATCH').length).toBeGreaterThan(20);
    // cached by design key and view: asked again, nothing is computed
    const t1 = performance.now();
    const again = (await answer({ op: 'drawing', design, numbers, views: baseRequests(r) })).value as Record<string, DrawView>;
    expect(again.front).toBe(views.front);
    expect(performance.now() - t1).toBeLessThan(50);
    expect(designKey(design, numbers)).toBeTruthy();
  });

  it('ISO 6410 cosmetic threads: root lines at d3 on a shaft, a limit line, a ¾ circle seen end-on', () => {
    // a Ø12 × 40 shaft with an M12 thread (P = 1.75: d3 = d − 1.226869 P, ISO 68-1)
    const d3 = 12 - 1.226869 * 1.75;
    const shaft = (length?: string) => single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: circles('c', [[0, 0, 6]]) },
      { kind: 'extrude', id: 'f1', name: 'Shaft', sketch: 's1', extent: { type: 'one', d: '40' }, op: 'new' },
      { kind: 'thread', id: 't1', name: 'Thread', size: 'M12', length, faces: [{ kind: 'face', body: 'f1', key: 'f1/side:ck0', hint: { p: [0, 0, 20], d: [0, 0, 1], type: 'cylinder', r: 6, size: 2 * PI * 6 * 40 } }] },
    ]);
    // 20 long from one end: the root lines are 20 long, and the full thread ends in a wide line across at z = 20
    const front = view(shaft('20'), req('front'));
    const thin = lines(front.thin);
    expect(thin).toHaveLength(2);
    for (const l of thin) {
      expect(Math.abs(l.x1)).toBeCloseTo(d3 / 2, 6);
      expect(Math.abs(l.x2)).toBeCloseTo(d3 / 2, 6);
      expect(primLength(l)).toBeCloseTo(20, 9);
      expect([l.y1, l.y2].some((y) => Math.abs(y - 20) < 1e-9)).toBe(true);
    }
    const limit = lines(front.visible).find((l) => Math.abs(l.y1 - 20) < 1e-9 && Math.abs(l.y2 - 20) < 1e-9)!;
    expect(primLength(limit)).toBeCloseTo(12, 9);
    // threaded all along: no limit line, and from above a ¾ circle at d3 on the end
    const whole = view(shaft(), req('front'));
    expect(lines(whole.thin).map(primLength)).toEqual([expect.closeTo(40, 9), expect.closeTo(40, 9)]);
    expect(lines(whole.visible).some((l) => l.y1 > 1e-6 && l.y1 < 40 - 1e-6 && Math.abs(l.y2 - l.y1) < 1e-9)).toBe(false);
    const top = view(shaft(), req('top'));
    const [c] = arcs(top.thin);
    expect(c.r).toBeCloseTo(d3 / 2, 6);
    expect(c.a1 - c.a0).toBeCloseTo((3 * PI) / 2, 9);
  });

  it('a tapped hole: dashed lines at the major diameter, a ¾ circle at it from above', () => {
    // 40 × 40 × 20 block, an M10 tapped hole through it (tap drill 8.5)
    const block = single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: rect('a', 0, 0, 40, 40) },
      { kind: 'extrude', id: 'f1', name: 'Block', sketch: 's1', extent: { type: 'one', d: '20' }, op: 'new' },
      { kind: 'sketch', id: 's2', name: 'P', plane: { ref: 'XY', offset: '20' }, sketch: points('p', [[20, 20]]) },
      { kind: 'hole', id: 'h1', name: 'Tapped', sketch: 's2', d: '', depth: '', through: true, style: 'simple', tap: { size: 'M10' } },
    ]);
    const front = view(block, req('front'));
    // the drill's walls (Ø8.5) and the thread's root (Ø10), all hidden, through the block
    for (const x of [20 - 4.25, 20 + 4.25, 15, 25]) expect(verticalAt(front.hidden, x)).toBeCloseTo(20, 6);
    expect(front.thin).toEqual([]);
    const top = view(block, req('top'));
    const [c] = arcs(top.thin);
    expect(c).toMatchObject({ cx: expect.closeTo(20, 9), cy: expect.closeTo(20, 9), r: expect.closeTo(5, 9) });
    // a section along the hole shows the root lines narrow and continuous over the cut
    const r = drawing({ sections: [{ id: 'A', letter: 'A', view: 'top', a: { x: -10, y: 20 }, b: { x: 50, y: 20 } }] });
    const sec = view(block, sectionRequest(r, r.sections![0]));
    expect(lines(sec.thin).length).toBe(2);
    expect(loopsArea(sec.cuts![0].loops)).toBeCloseTo(40 * 20 - 8.5 * 20, 6);
  });

  it('cosmetic threads follow a pattern of their feature', () => {
    // three M8 tapped holes, one patterned twice along x (30 apart)
    const block = single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: rect('a', 0, 0, 100, 30) },
      { kind: 'extrude', id: 'f1', name: 'Block', sketch: 's1', extent: { type: 'one', d: '12' }, op: 'new' },
      { kind: 'sketch', id: 's2', name: 'P', plane: { ref: 'XY', offset: '12' }, sketch: points('p', [[20, 15]]) },
      { kind: 'hole', id: 'h1', name: 'Tapped', sketch: 's2', d: '', depth: '8', style: 'simple', tap: { size: 'M8', depth: '6' } },
      { kind: 'pattern', id: 'p1', name: 'Row', of: 'features', refs: ['h1'], type: 'rect', axis: 'X', count: '3', spacing: '30' },
    ]);
    const top = view(block, req('top'));
    expect(arcs(top.thin).map((a) => +a.cx.toFixed(9)).sort((a, b) => a - b)).toEqual([20, 50, 80]);
    for (const a of arcs(top.thin)) expect(a.r).toBeCloseTo(4, 9);
    // seen from the front: the thread 6 deep in an 8 deep hole ends in a (hidden) limit line at z = 12 − 6
    const front = view(block, req('front'));
    const limits = lines(front.hidden).filter((l) => Math.abs(l.y1 - 6) < 1e-9 && Math.abs(l.y2 - 6) < 1e-9);
    expect(limits).toHaveLength(3);
    for (const l of limits) expect(primLength(l)).toBeCloseTo(8, 9);
  });

  it('views and sections leave no OCCT objects behind', () => {
    const oc = occ()!;
    const design = tube(40, 24, 50);
    const { numbers } = solve(design);
    const built = buildDesignCached(oc, design, numbers);
    const r = drawing({ sections: [{ id: 'A', letter: 'A', view: 'front', a: { x: 0, y: -10 }, b: { x: 0, y: 60 } }] });
    const reqs = [...baseRequests(r), sectionRequest(r, r.sections![0])];
    for (const q of reqs) drawViewOcc(oc, built, design, q);
    const watch = watchHandles(oc);
    try {
      for (const q of reqs) drawViewOcc(oc, built, design, q);
      expect(watch.undeleted()).toEqual([]);
    } finally {
      watch.stop();
    }
  });

  it('where OpenCascade is not there the mesh draws the views, a section closed with caps', () => {
    const design = tube(40, 24, 50);
    const { numbers } = solve(design);
    const r = drawing({ sections: [{ id: 'A', letter: 'A', view: 'front', a: { x: 0, y: -10 }, b: { x: 0, y: 60 } }] });
    // what the kernel worker shows when OpenCascade could not load (or failed on the part)
    const shown = meshBuildResult(kernel()!, design, numbers);
    const front = drawViewFor(design, numbers, shown, baseRequests(r)[0]);
    expect(front.mesh).toBe('all');
    // the facets' silhouettes: the outer ones at ±R within the faceting, the bore's hidden
    expect(front.box.x1 - front.box.x0).toBeGreaterThan(39.9);
    expect(front.hidden.length).toBeGreaterThan(0);
    // the planar cut of the facets through the axis: the strips, within the chord error
    const sec = drawViewFor(design, numbers, shown, sectionRequest(r, r.sections![0]));
    expect(Math.abs(loopsArea(sec.cuts![0].loops) / 800 - 1)).toBeLessThan(5e-3);
    // the cap hides the bore's far wall behind the cut: only the facets' lines beyond show
    expect(sec.hidden).toEqual([]);
    expect(sec.visible.length).toBeGreaterThan(4);
  });
});

describe('the sheet as DXF', () => {
  it('true circles and arcs at the sheet scale, layers with ISO lineweights', () => {
    const r = drawing({ sheet: 'A4', dims: true, scale: 1 });
    const views = Object.fromEntries(baseRequests(r).map((q) => [q.key, view(plate(), q)]));
    const sheet = layoutSheet(r, views, { unit: 'mm', name: 'Plate', date: '2026-10-17' })!;
    expect(sheet.scale).toBe(1);
    const dxf = sheetDxf(sheet);
    const codes = dxf.split('\n');
    const entities = (type: string) => {
      const out: Record<string, string>[] = [];
      const start = codes.indexOf('ENTITIES') + 1;
      for (let i = start; i < codes.length - 1; i += 2) {
        if (codes[i].trim() === '0' && codes[i + 1] === type) {
          const e: Record<string, string> = {};
          for (let k = i + 2; k < codes.length - 1 && codes[k].trim() !== '0'; k += 2) e[codes[k].trim()] ??= codes[k + 1];
          out.push(e);
        }
        if (codes[i] === 'ENDSEC' && i > start) break;
      }
      return out;
    };
    expect(codes[codes.indexOf('$ACADVER') + 2]).toBe('AC1015');
    // the hole seen end-on at 1:1: a CIRCLE of radius 10 on VISIBLE
    const circlesOut = entities('CIRCLE');
    expect(circlesOut.some((c) => c['8'] === 'VISIBLE' && Math.abs(+c['40'] - 10) < 1e-9)).toBe(true);
    // the isometric view's hole is an ELLIPSE with a 10 major half-axis, minor/major 1/√3
    expect(entities('ELLIPSE').some((e) => Math.abs(Math.hypot(+e['11'], +e['21']) - 10) < 1e-6 && Math.abs(+e['40'] - 1 / Math.sqrt(3)) < 1e-6)).toBe(true);
    // the hole's walls seen side-on in the front and the side view, 10 long, on HIDDEN
    const hidden = entities('LINE').filter((l) => l['8'] === 'HIDDEN');
    expect(hidden).toHaveLength(4);
    for (const l of hidden) expect(Math.hypot(+l['11'] - +l['10'], +l['21'] - +l['20'])).toBeCloseTo(10, 9);
    // the layer table: HIDDEN dashed at 0.25 mm, VISIBLE continuous at 0.5 mm (line group 0.5 on A4)
    const layer = (name: string) => {
      const i = codes.findIndex((c, k) => c === name && codes[k - 1].trim() === '2' && codes.slice(Math.max(0, k - 12), k).includes('AcDbLayerTableRecord'));
      const rec: Record<string, string> = {};
      for (let k = i + 1; k < codes.length - 1 && codes[k].trim() !== '0'; k += 2) rec[codes[k].trim()] = codes[k + 1];
      return rec;
    };
    expect(layer('HIDDEN')).toMatchObject({ 6: 'DASHED', 370: '25' });
    expect(layer('VISIBLE')).toMatchObject({ 6: 'Continuous', 370: '50' });
    expect(layer('CENTER')).toMatchObject({ 6: 'CENTER', 370: '25' });
    for (const L of ['TANGENT', 'HATCH', 'DIM', 'TEXT', 'BORDER']) expect(layer(L)[6]).toBeDefined();
    // an A0 sheet takes line group 0.7
    const big = sheetDxf(layoutSheet({ ...r, sheet: 'A0' }, views, { unit: 'mm', name: 'Plate', date: '' })!).split('\n');
    const vi = big.findIndex((c, k) => c === 'VISIBLE' && big[k - 1].trim() === '2');
    expect(big.slice(vi, vi + 10)).toContain('70');
  });

  it('a detail view: the parent clipped at its circle, enlarged to its own scale', () => {
    const r = drawing({ scale: 1, views: { front: true, top: false, side: false, iso: false }, details: [{ id: 'B', letter: 'B', view: 'front', c: { x: 40, y: 5 }, r: 4, scale: 5 }] });
    const sheet = layoutSheet(r, { front: view(plate(), req('front')) }, { unit: 'mm', name: 'Plate', date: '' })!;
    const det = sheet.views.find((v) => v.key === 'det:B')!;
    expect(det.k).toBe(5);
    // the hidden line at x = 40 crosses the circle through its centre: 8 long, 40 on the paper
    const inside = (p: Prim) => p.k === 'line' && Math.abs(p.x1 - det.ox - 5 * 40) < 1e-9;
    const hidden = sheet.inks.filter((i) => i.layer === 'HIDDEN' && inside(i.p));
    expect(hidden.reduce((s, i) => s + primLength(i.p), 0)).toBeCloseTo(8 * 5, 9);
    // its label and the circle on the parent with the letter
    expect(sheet.labels.map((l) => l.text)).toEqual(expect.arrayContaining(['B (5:1)', 'B']));
    const front = sheet.views.find((v) => v.key === 'front')!;
    expect(sheet.inks.some((i) => i.layer === 'THIN' && i.p.k === 'arc' && Math.abs(i.p.r - 4 * front.k) < 1e-9)).toBe(true);
  });
});
