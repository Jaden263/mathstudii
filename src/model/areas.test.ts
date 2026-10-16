import { describe, expect, it } from 'vitest';
import { createRegion, emptyWorksheet, readingOrder, type AreaRegion, type MathRegion, type Region, type Worksheet } from './types';
import { AREA_BAR, AREA_PAD, areasOf, collapseArea, evaluationOrder, expandArea, fitArea, groupIntoArea, hiddenIds, insertArea, printLayout, revealRegion, ungroupArea, withContents } from './areas';
import { GRID } from './types';
import { evaluateWorksheet, type MathResult } from '../engine/evaluator';

const math = (id: string, x: number, y: number, source: string): MathRegion => ({ ...(createRegion('math', x, y, { source }) as MathRegion), id });
const area = (id: string, title = id): AreaRegion => ({ ...(createRegion('area', 0, 0, { title }) as AreaRegion), id, x: 48 });

function sheet(regions: Region[]): Worksheet {
  return { ...emptyWorksheet(), regions };
}

const ys = (ws: Worksheet) => Object.fromEntries(ws.regions.map((r) => [r.id, r.y]));
const byId = (ws: Worksheet, id: string) => ws.regions.find((r) => r.id === id)!;

// A small calculation: b, c and d (beside c) go into an area; e and f are below it.
// Every region renders 24 px tall except c, a 200 px tall block.
function calc(): Worksheet {
  return sheet([
    math('a', 80, 40, 'a := 1'),
    math('b', 80, 100, 'b := a + 1'),
    math('c', 80, 140, 'c := 2 b'),
    math('d', 300, 140, 'd := c + 1'),
    math('e', 80, 360, 'e := c + d ='),
    math('f', 80, 500, 'f := e / 2 ='),
  ]);
}
const heights = (id: string) => (id === 'c' ? 200 : 24);
const grouped = () => groupIntoArea(calc(), ['b', 'c'], heights, area('A'));

describe('grouping into an area', () => {
  it('makes room for the bar and the end line, and takes in what lies level with the selection', () => {
    const ws = grouped();
    // band of the selection: top 100, bottom 140 + 200 = 340; d (top 140) is level with it.
    // Everything from y = 100 moves down by the bar and a grid step (24 + 8 = 32), what is
    // under the band (from 340 + 32) a further end-line pad and grid step (8 + 8 = 16).
    expect(ys(ws)).toEqual({ A: 100, a: 40, b: 132, c: 172, d: 172, e: 408, f: 548 });
    const A = byId(ws, 'A') as AreaRegion;
    // band to 8 px under the last region: 340 + 32 + 8 − 100
    expect(A.height).toBe(280);
    expect([...withContents(ws.regions, ['A'])].sort()).toEqual(['A', 'b', 'c', 'd']);
    // the area is drawn first (behind everything)
    expect(ws.regions[0].id).toBe('A');
  });
});

describe('collapse and expand', () => {
  it('moves what is below up by the band less the bar, and back exactly', () => {
    const open = grouped();
    const shut = collapseArea(open, 'A');
    const s = 280 - AREA_BAR;
    expect(ys(shut)).toEqual({ ...ys(open), e: 408 - s, f: 548 - s });
    expect((byId(shut, 'A') as AreaRegion).hidden?.sort()).toEqual(['b', 'c', 'd']);
    expect([...hiddenIds(shut.regions)].sort()).toEqual(['b', 'c', 'd']);
    // regions below keep their layout relative to each other
    expect(byId(shut, 'f').y - byId(shut, 'e').y).toBe(140);
    const again = expandArea(shut, 'A');
    expect(again).toEqual(open);
  });

  it('keeps the evaluation order of the expanded worksheet', () => {
    const open = grouped();
    const shut = collapseArea(open, 'A');
    // read naively, e (moved up to 152) would come before c and d (hidden at 172)
    expect(readingOrder(shut.regions).map((r) => r.id).indexOf('e')).toBeLessThan(readingOrder(shut.regions).map((r) => r.id).indexOf('c'));
    expect(evaluationOrder(shut).map((r) => r.id)).toEqual(evaluationOrder(open).map((r) => r.id));
    expect(evaluationOrder(shut).map((r) => r.id)).toEqual(['a', 'A', 'b', 'c', 'd', 'e', 'f']);
    // a = 1, b = 2, c = 4, d = 5, e = 9, f = 4.5 with the area open or shut
    const tex = (ws: Worksheet, id: string) => (evaluateWorksheet(ws).results.get(id) as MathResult);
    for (const ws of [open, shut]) {
      expect(tex(ws, 'e').error).toBeUndefined();
      expect(tex(ws, 'e').tex).toMatch(/= 9$/);
      expect(tex(ws, 'f').tex).toMatch(/= 4.5$/);
    }
  });

  it('round-trips nested areas', () => {
    // inner area around c and d, then an outer one around b and the inner area
    const inner = groupIntoArea(calc(), ['c'], heights, area('I'));
    const both = groupIntoArea(inner, ['b', 'I'], (id) => (id === 'c' ? 200 : 24), area('O'));
    expect(areasOf(both.regions, 'c').map((a) => a.id)).toEqual(['O', 'I']);
    const I = byId(both, 'I') as AreaRegion, O = byId(both, 'O') as AreaRegion;
    // the outer band holds the inner one, its bar a grid step further out
    expect(O.y).toBeLessThan(I.y);
    expect(O.x).toBe(I.x - GRID);
    expect(O.y + O.height).toBeGreaterThanOrEqual(I.y + I.height);
    const s1 = collapseArea(both, 'I');
    // the outer band shrinks by what the inner area gives back
    expect((byId(s1, 'O') as AreaRegion).height).toBe(O.height - (I.height - AREA_BAR));
    const s2 = collapseArea(s1, 'O');
    // expanding an area hidden inside a collapsed one does nothing
    expect(expandArea(s2, 'I')).toBe(s2);
    expect(expandArea(expandArea(s2, 'O'), 'I')).toEqual(both);
    // revealing c opens the outer area, then the inner one
    expect(revealRegion(s2, 'c')).toEqual(both);
  });

  it('keeps the contents of an open area inside a collapsed one apart from what moves up', () => {
    const inner = groupIntoArea(calc(), ['c'], heights, area('I'));
    const both = groupIntoArea(inner, ['b', 'I'], heights, area('O'));
    const shut = collapseArea(both, 'O');
    // e and f moved up into the heights where I's band was: they are not in I
    const I = byId(shut, 'I') as AreaRegion;
    expect(byId(shut, 'e').y).toBeLessThan(I.y + I.height);
    expect([...withContents(shut.regions, ['I'])].sort()).toEqual(['I', 'c', 'd']);
    expect([...withContents(shut.regions, ['O'])].sort()).toEqual(['I', 'O', 'b', 'c', 'd']);
    expect(areasOf(shut.regions, 'e')).toEqual([]);
  });

  it('round-trips two areas one under the other in any order', () => {
    const ws0 = sheet([
      math('p', 80, 40, 'p := 1'), math('q', 80, 80, 'q := 2'),
      math('r', 80, 200, 'r := 3'), math('t', 80, 240, 't := 4'), math('u', 80, 400, 'u := p + r ='),
    ]);
    const h = () => 24;
    const one = groupIntoArea(ws0, ['p', 'q'], h, area('P'));
    const two = groupIntoArea(one, ['r', 't'], h, area('R'));
    const shut = collapseArea(collapseArea(two, 'P'), 'R');
    expect(expandArea(expandArea(shut, 'P'), 'R')).toEqual(two);
    expect(expandArea(expandArea(shut, 'R'), 'P')).toEqual(two);
    // the lower area's hidden regions travel with its bar when the upper one opens
    const rShut = collapseArea(two, 'R');
    const pShut = collapseArea(rShut, 'P');
    const s = (byId(two, 'P') as AreaRegion).height - AREA_BAR;
    expect(byId(pShut, 'r').y).toBe(byId(rShut, 'r').y - s);
  });

  it('ungroups in place', () => {
    const shut = collapseArea(grouped(), 'A');
    const out = ungroupArea(shut, 'A');
    expect(out.regions.some((r) => r.id === 'A')).toBe(false);
    expect(ys(out)).toEqual(Object.fromEntries(Object.entries(ys(grouped())).filter(([k]) => k !== 'A')));
  });
});

describe('band size', () => {
  it('grows an area when its contents grow, pushing the rest down', () => {
    const inner = groupIntoArea(calc(), ['c'], heights, area('I'));
    const both = groupIntoArea(inner, ['b', 'I'], heights, area('O'));
    const I = byId(both, 'I') as AreaRegion;
    const grown = fitArea(both, 'I', I.height + 40);
    expect((byId(grown, 'I') as AreaRegion).height).toBe(I.height + 40);
    expect((byId(grown, 'O') as AreaRegion).height).toBe((byId(both, 'O') as AreaRegion).height + 40);
    expect(byId(grown, 'e').y).toBe(byId(both, 'e').y + 40);
    expect(byId(grown, 'c').y).toBe(byId(both, 'c').y);
    // never shrinks
    expect(fitArea(both, 'I', 10)).toBe(both);
  });

  it('inserts an empty area that pushes what is below down', () => {
    const ws = insertArea(calc(), { ...area('N'), y: 320, height: 96 });
    expect(byId(ws, 'e').y).toBe(360 + 96 + GRID);
    expect(byId(ws, 'c').y).toBe(140);
    expect(withContents(ws.regions, ['N']).size).toBe(1);
  });
});

describe('printing', () => {
  it('prints areas collapsed or expanded as each asks', () => {
    const open = grouped();
    const printShut = { ...open, regions: open.regions.map((r) => (r.id === 'A' ? { ...r, print: 'collapsed' as const } : r)) };
    expect(ys(printLayout(printShut))).toEqual(ys(collapseArea(printShut, 'A')));
    const shut = collapseArea(open, 'A');
    const printOpen = { ...shut, regions: shut.regions.map((r) => (r.id === 'A' ? { ...r, print: 'expanded' as const } : r)) };
    expect(ys(printLayout(printOpen))).toEqual(ys(open));
    // as on screen
    expect(printLayout(shut)).toBe(shut);
  });
});

describe('end line', () => {
  it('leaves the region under an area outside its band', () => {
    const ws = grouped();
    const A = byId(ws, 'A') as AreaRegion;
    expect(byId(ws, 'e').y).toBeGreaterThanOrEqual(A.y + A.height + AREA_PAD);
  });
});
