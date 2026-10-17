// Annotation text and layout against what the standards write: sizes with tolerances and
// fits (ISO 129-1, ISO 286-1/-2: "Ø20 H7", +0.021 / 0, the limits 20.021 / 20.000),
// feature control frame compartments (ISO 1101 8.1) from the Arial advance widths the
// sheet sets its text by, parts list quantities (ISO 7573), and the dimensions the tools
// make from picks.
import { describe, expect, it } from 'vitest';
import { bomMass, bomRows, devDecimals, dimText, fmtMass, fmtSize, gdtLayout, textWidth, type DrawPick } from './annotations';
import { continueDimension, movedAnnotation, newDimension, nextDatumLetter } from './annotationTools';
import { followText } from './drawingRefs';
import type { CadDesign } from './design';

const pt = (x: number, y: number): DrawPick => ({ snap: 'free', shape: { k: 'point', x, y } });
const line = (x1: number, y1: number, x2: number, y2: number): DrawPick => ({ snap: 'free', shape: { k: 'line', x1, y1, x2, y2 } });

describe('dimension text', () => {
  it('sizes, symmetric and unequal deviations, limits (ISO 129-1: both deviations to the same decimals)', () => {
    expect(dimText(100, 'mm', {})).toEqual({ main: '100' });
    expect(dimText(12.3456, 'mm', {})).toEqual({ main: '12.35' });
    expect(dimText(12, 'mm', { decimals: 2 })).toEqual({ main: '12.00' });
    expect(dimText(20, 'mm', { prefix: 'Ø', tol: { kind: 'sym', t: 0.1 } })).toEqual({ main: 'Ø20 ±0.1' });
    expect(dimText(20, 'mm', { tol: { kind: 'dev', upper: 0.1, lower: -0.05 } })).toEqual({ main: '20', stack: ['+0.10', '−0.05'] });
    expect(dimText(20, 'mm', { tol: { kind: 'dev', upper: 0.2, lower: 0 } })).toEqual({ main: '20', stack: ['+0.2', '0'] });
    expect(dimText(20, 'mm', { tol: { kind: 'limits', upper: 0.021, lower: 0 } })).toEqual({ main: '', stack: ['20.021', '20.000'] });
    // an auxiliary dimension in parentheses
    expect(dimText(35, 'mm', { reference: true })).toEqual({ main: '(35', tail: ')' });
    expect(dimText(35, 'mm', { override: '<> TYP.' })).toEqual({ main: '35 TYP.' });
    // limits entered the wrong way round still put the upper one above
    expect(dimText(20, 'mm', { tol: { kind: 'limits', upper: -0.02, lower: 0.01 } })).toEqual({ main: '', stack: ['20.01', '19.98'] });
  });

  it('angles: the degree sign on the value and on each deviation or limit (ISO 129-1: 30° ±0.5°)', () => {
    expect(dimText(30, 'deg', { sign: '°' })).toEqual({ main: '30°' });
    expect(dimText(30, 'deg', { sign: '°', tol: { kind: 'sym', t: 0.5 } })).toEqual({ main: '30° ±0.5°' });
    expect(dimText(30, 'deg', { sign: '°', tol: { kind: 'dev', upper: 0.5, lower: -0.25 } })).toEqual({ main: '30°', stack: ['+0.50°', '−0.25°'] });
    expect(dimText(30, 'deg', { sign: '°', tol: { kind: 'limits', upper: 0.5, lower: 0 } })).toEqual({ main: '', stack: ['30.5°', '30.0°'] });
  });

  it('ISO 286 fits: "Ø20 H7", with the deviations or limits from ISO 286-2 in parentheses', () => {
    expect(dimText(20, 'mm', { prefix: 'Ø', tol: { kind: 'fit', code: 'H7' } })).toEqual({ main: 'Ø20 H7' });
    // H7 at 20 mm: +21 / 0 µm
    expect(dimText(20, 'mm', { prefix: 'Ø', tol: { kind: 'fit', code: 'H7', show: 'dev' } })).toEqual({ main: 'Ø20 H7 (', stack: ['+0.021', '0'], tail: ')' });
    // g6 at 20 mm: −7 / −20 µm, so the limits 19.993 / 19.980
    expect(dimText(20, 'mm', { prefix: 'Ø', tol: { kind: 'fit', code: 'g6', show: 'limits' } })).toEqual({ main: 'Ø20 g6 (', stack: ['19.993', '19.980'], tail: ')' });
    // f7 at 50 mm: −25 / −50 µm; in a part drawn in centimetres the same in cm
    expect(dimText(5, 'cm', { prefix: 'Ø', tol: { kind: 'fit', code: 'f7', show: 'dev' } })).toEqual({ main: 'Ø5 f7 (', stack: ['−0.0025', '−0.0050'], tail: ')' });
    // js6 at 25 mm: ±6.5 µm (IT6 = 13)
    expect(dimText(25, 'mm', { tol: { kind: 'fit', code: 'js6', show: 'dev' } }).stack).toEqual(['+0.0065', '−0.0065']);
    // a fit of hole and shaft is written as a pair
    expect(dimText(20, 'mm', { prefix: 'Ø', tol: { kind: 'fit', code: 'H7/g6', show: 'dev' } })).toEqual({ main: 'Ø20 H7/g6' });
    expect(dimText(20, 'mm', { tol: { kind: 'fit', code: 'G7' } }).error).toMatch(/not an ISO 286 class/);
    expect(dimText(600, 'mm', { tol: { kind: 'fit', code: 'H7' } }).error).toMatch(/up to 500 mm/);
  });

  it('decimals of deviations: as few as are exact', () => {
    expect(devDecimals([0.1], 'mm')).toBe(1);
    expect(devDecimals([0.1, -0.05], 'mm')).toBe(2);
    expect(devDecimals([0.021, 0], 'mm')).toBe(3);
    expect(devDecimals([0.0065], 'mm')).toBe(4);
    expect(fmtSize(-0.0000001, 'mm')).toBe('0');
    expect(fmtMass(3.32212)).toBe('3.32');
    expect(fmtMass(0.0118)).toBe('0.0118');
  });
});

describe('feature control frame', () => {
  it('compartments 2h high, the symbol square, the others as wide as their text with h/2 either side (ISO 1101 8.1)', () => {
    const h = 3.5, em = h / 0.72;
    // Arial advances (per 1000 em): Ø 778, 0 556, . 278, 1 556; A 667, B 667, C 722
    const tol = 1.75 + ((778 + 556 + 278 + 556) / 1000) * em + 1.8 * h + 1.75;
    const L = gdtLayout({ tol: 0.1, dia: true, mod: 'M', datums: [{ letter: 'A' }, { letter: 'B' }, { letter: 'C' }] }, h, (v) => String(v));
    expect(L.H).toBe(7);
    expect(L.tolText).toBe('Ø0.1');
    expect(L.widths[0]).toBe(7);
    expect(L.widths[1]).toBeCloseTo(tol, 12);
    expect(L.widths[1]).toBeCloseTo(20.3388889, 6);
    // a datum letter narrower than the frame is high still gets a square compartment; C is wider
    expect(L.widths[2]).toBe(7);
    expect(L.widths[3]).toBe(7);
    expect(L.widths[4]).toBeCloseTo(3.5 + 0.722 * em, 12);
    expect(L.widths.reduce((s, w) => s + w, 0)).toBeCloseTo(48.3486111, 6);
    // flatness 0.05: the symbol and the tolerance only
    expect(gdtLayout({ tol: 0.05 }, h, (v) => String(v)).widths).toHaveLength(2);
    expect(textWidth('M8', 3.5)).toBeCloseTo(((833 + 556) / 1000) * em, 12);
  });
});

describe('parts list', () => {
  it('one item per component in the order they first occur, quantities counting repeated occurrences, hidden ones left out', () => {
    const design: CadDesign = {
      version: 2,
      components: [
        { id: 'p', name: 'Plate', items: [] },
        { id: 'b', name: 'Bolt M8×30', density: '7850 kg/m^3', items: [] },
        { id: 'w', name: 'Washer', density: '2700 kg/m^3', items: [] },
      ],
      occurrences: [
        { id: 'o1', component: 'p', grounded: true },
        ...[1, 2, 3, 4].map((i) => ({ id: `b${i}`, component: 'b' })),
        { id: 'w1', component: 'w' }, { id: 'w2', component: 'w', hidden: true },
      ],
      joints: [],
    };
    const rows = bomRows(design, { masses: { p: 1.2, b: 0.0118 }, density: '7200 kg/m^3', rows: { w: { name: 'Washer 8.4' } } });
    expect(rows.map((r) => [r.item, r.name, r.qty, r.material])).toEqual([[1, 'Plate', 1, 'Cast iron'], [2, 'Bolt M8×30', 4, 'Steel'], [3, 'Washer 8.4', 1, 'Aluminium']]);
    expect(rows[1].mass).toBe(0.0118);
    expect(rows[2].mass).toBeUndefined();
    // the mass of what is listed: each item's times its quantity, and only when every item has one
    expect(bomMass(rows)).toBeUndefined();
    expect(bomMass(rows.slice(0, 2))).toBeCloseTo(1.2 + 4 * 0.0118, 12);
  });
});

describe('what the tools make of picks', () => {
  it('a circle its diameter, an arc its radius, a line its length, two points by where the text goes, two lines their angle', () => {
    const circle: DrawPick = { snap: 'circle', shape: { k: 'circle', cx: 0, cy: 0, r: 5, a0: 0, a1: 2 * Math.PI } };
    const arc: DrawPick = { snap: 'circle', shape: { k: 'circle', cx: 0, cy: 0, r: 5, a0: 0, a1: Math.PI / 2 } };
    expect(newDimension('d', 'top', [circle], [10, 10])?.type).toBe('diameter');
    expect(newDimension('d', 'top', [arc], [10, 10])?.type).toBe('radius');
    expect(newDimension('d', 'top', [line(0, 0, 50, 0)], [25, -10])).toMatchObject({ type: 'linear', orient: 'h' });
    // two points: above them horizontal, beside them vertical, between them aligned
    expect(newDimension('d', 'top', [pt(0, 0), pt(40, 30)], [20, 50])?.orient).toBe('h');
    expect(newDimension('d', 'top', [pt(0, 0), pt(40, 30)], [60, 15])?.orient).toBe('v');
    expect(newDimension('d', 'top', [pt(0, 0), pt(40, 30)], [18, 16])?.orient).toBe('aligned');
    expect(newDimension('d', 'top', [line(0, 0, 50, 0), line(0, 0, 30, 30)], [30, 10])?.type).toBe('angle');
    expect(newDimension('d', 'top', [line(0, 0, 50, 0), line(0, 10, 50, 10)], [60, 5])).toMatchObject({ type: 'linear' });
    expect(newDimension('d', 'top', [pt(1, 1)], [5, 5])).toBeNull();
  });

  it('a chain dimensions each point from the last on one line; a baseline each from the first, a row further out', () => {
    const first = newDimension('d1', 'front', [pt(0, 0), pt(20, 0)], [10, -10])!;
    expect(first.orient).toBe('h');
    const c2 = continueDimension('d2', 'chain', first, first, pt(50, 5), 8)!;
    expect(c2).toMatchObject({ a: first.b, orient: 'h', text: [35, -10] });
    const b2 = continueDimension('d2', 'baseline', first, first, pt(50, 5), 8)!;
    // from the first point, its line 8 further below (away from the part)
    expect(b2).toMatchObject({ a: first.a, text: [25, -18] });
    const b3 = continueDimension('d3', 'baseline', first, b2, pt(70, 0), 8)!;
    expect(b3.text).toEqual([35, -26]);
  });

  it('text keeps its place: centred on a width that grows, and its distance outside the part', () => {
    const d = newDimension('w', 'top', [pt(0, 0), pt(100, 0)], [50, -15])!;
    const t = followText(d, { a: d.a.shape, b: d.b!.shape }, { a: { k: 'point', x: 0, y: 5 }, b: { k: 'point', x: 120, y: 5 } });
    expect(t[0]).toBeCloseTo(60, 12);
    expect(t[1]).toBeCloseTo(-10, 12);
    // past the end it keeps its distance past the end
    const out = { ...d, text: [110, -15] as [number, number] };
    expect(followText(out, { a: d.a.shape, b: d.b!.shape }, { a: { k: 'point', x: 0, y: 0 }, b: { k: 'point', x: 120, y: 0 } })[0]).toBeCloseTo(130, 12);
    // a diameter's text keeps its angle and its distance outside the circle
    const dia = newDimension('c', 'top', [{ snap: 'circle', shape: { k: 'circle', cx: 0, cy: 0, r: 10, a0: 0, a1: 2 * Math.PI } }], [20, 0])!;
    const td = followText(dia, { a: dia.a.shape }, { a: { k: 'circle', cx: 5, cy: 0, r: 15, a0: 0, a1: 2 * Math.PI } });
    expect(td).toEqual([30, 0]);
    // at half the scale (1:1 placed, drawn at 1:2) it stays 15 mm off the part on the paper: 30 units in the view
    expect(followText(d, { a: d.a.shape, b: d.b!.shape }, { a: d.a.shape, b: d.b!.shape }, 2)).toEqual([50, -30]);
    // dragging takes the geometry as it is now
    const moved = movedAnnotation(d, [0, -5], t, { a: { k: 'point', x: 0, y: 5 }, b: { k: 'point', x: 120, y: 5 } });
    expect(moved).toMatchObject({ text: [60, -15], a: { shape: { x: 0, y: 5 } }, b: { shape: { x: 120 } } });
    expect(nextDatumLetter([{ id: 'x', kind: 'datum', view: 'top', letter: 'A', at: [0, 0], leader: pt(0, 0) }])).toBe('B');
  });
});
