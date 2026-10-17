// Areas under random editing: whatever a user does (group, insert, drag, collapse, ungroup,
// delete, contents growing), collapsing and expanding must give the layout back exactly, never
// change what an area holds and never change the order of evaluation.
import { describe, expect, it } from 'vitest';
import { createRegion, emptyWorksheet, type AreaRegion, type MathRegion, type Region, type Worksheet } from '../model/types';
import { collapseArea, evaluationOrder, expandArea, expandedLayout, hiddenIds, isArea, withContents } from '../model/areas';
import { initialState, reducer, type Action, type State } from './store';

// a small linear congruential generator (Park–Miller), so every run makes the same worksheets
function generator(seed: number) {
  let s = seed;
  const next = () => (s = (s * 16807) % 2147483647) / 2147483647;
  return { next, pick: <T,>(a: T[]) => a[Math.floor(next() * a.length)] };
}

const HEIGHTS = [24, 24, 40, 120];

function randomSheet(g: ReturnType<typeof generator>, heights: Map<string, number>): Worksheet {
  const regions: Region[] = [];
  let y = 40;
  const n = 4 + Math.floor(g.next() * 10);
  for (let i = 0; i < n; i++) {
    const id = `r${i}`;
    const h = g.pick(HEIGHTS);
    heights.set(id, h);
    // some regions sit beside the one before (an area is a band across the page)
    const beside = i > 0 && g.next() < 0.3;
    const at = beside ? { x: 300, y: regions[regions.length - 1].y } : { x: 80, y };
    regions.push({ ...(createRegion('math', at.x, at.y, { source: `${id} := 1` }) as MathRegion), id });
    if (!beside) y += h + g.pick([8, 16, 40]);
  }
  return { ...emptyWorksheet(), regions };
}

const layout = (regions: Region[]) => JSON.stringify(regions.map((r) => [r.id, r.x, r.y, isArea(r) ? r.height : 0]).sort());
const order = (ws: Worksheet) => evaluationOrder(ws).map((r) => r.id).join();
const holdings = (ws: Worksheet) => {
  const open = expandedLayout(ws);
  return JSON.stringify(open.filter(isArea).map((a) => [a.id, [...withContents(open, [a.id])].sort()]).sort());
};

describe('areas under random editing', () => {
  it('round-trip, keep their contents and the order of evaluation', () => {
    let checked = 0;
    for (let trial = 0; trial < 400; trial++) {
      const g = generator(trial + 7);
      const heights = new Map<string, number>();
      let s: State = initialState(randomSheet(g, heights));
      const steps: string[] = [];
      for (let k = 0; k < 12; k++) {
        const hidden = hiddenIds(s.ws.regions);
        const vis = s.ws.regions.filter((r) => !hidden.has(r.id));
        if (!vis.length) break;
        const areas = vis.filter(isArea);
        const roll = g.next();
        let a: Action | null = null;
        if (roll < 0.35) {
          const ids = vis.filter(() => g.next() < 0.3).map((r) => r.id);
          if (ids.length) a = { type: 'group', ids, heights: Object.fromEntries(heights), area: { ...(createRegion('area', 40, 0) as AreaRegion), id: `A${k}` } };
        } else if (roll < 0.5) {
          const y = Math.max(0, g.pick(vis).y + g.pick([-8, 0, 4, 16]));
          a = { type: 'insertArea', area: { ...(createRegion('area', 40, y) as AreaRegion), id: `I${k}`, height: 96 } };
        } else if (roll < 0.75) {
          a = { type: 'move', ids: [g.pick(vis).id], dx: 0, dy: g.pick([-200, -80, -40, -8, 8, 40, 80, 200]) };
        } else if (roll < 0.8 && areas.length) {
          a = { type: 'ungroup', id: g.pick(areas).id };
        } else if (roll < 0.85) {
          a = { type: 'delete', ids: [g.pick(vis).id] };
        } else if (roll < 0.9) {
          const open = areas.filter((q) => !q.collapsed);
          if (open.length) {
            const q = g.pick(open);
            a = { type: 'areaFit', id: q.id, height: q.height + g.pick([8, 40]) };
          }
        } else if (areas.length) {
          const q = g.pick(areas);
          a = { type: q.collapsed ? 'expand' : 'collapse', id: q.id };
        }
        if (!a) continue;
        steps.push(JSON.stringify({ ...a, heights: undefined, area: undefined }));
        s = reducer(s, a);
      }
      const ws = s.ws;
      const ids = ws.regions.filter(isArea).map((q) => q.id);
      if (!ids.length) continue;
      checked++;
      const why = `trial ${trial}: ${steps.join(' ')}`;
      // collapsing then expanding (or the other way round) any area on the page changes nothing
      const hidden = hiddenIds(ws.regions);
      for (const id of ids) {
        if (hidden.has(id)) continue;
        const q = ws.regions.find((r) => r.id === id) as AreaRegion;
        const twice = q.collapsed ? collapseArea(expandArea(ws, id), id) : expandArea(collapseArea(ws, id), id);
        expect(layout(twice.regions), `${why} | toggle ${id}`).toBe(layout(ws.regions));
      }
      // any sequence of collapsing and expanding: the same expanded layout, contents and order
      const base = layout(expandedLayout(ws)), held = holdings(ws), ord = order(ws);
      let cur = ws;
      for (let k = 0; k < 14; k++) {
        const id = g.pick(ids);
        const q = cur.regions.find((r) => r.id === id) as AreaRegion;
        cur = q.collapsed ? expandArea(cur, id) : collapseArea(cur, id);
        expect(order(cur), why).toBe(ord);
      }
      expect(layout(expandedLayout(cur)), why).toBe(base);
      expect(holdings(cur), why).toBe(held);
    }
    // most trials end with areas to check
    expect(checked).toBeGreaterThan(300);
  });
});
