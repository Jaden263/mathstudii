import { describe, it, expect } from 'vitest';
import { separateKeepingOrder, moveSteps, type Box } from './separateOrdered';
import { createRegion, readingOrder, type Region } from '../model/types';

const snap = (v: number) => Math.round(v / 8) * 8;
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

describe('separating regions after an import, keeping the order they calculate in', () => {
  it('a pushed region takes the rest of its row and everything below along', () => {
    // a value definition rendered taller than the other program drew it overlaps the next one;
    // beside that one, a region reads the value (the case of an exported beam's results)
    const boxes: Box[] = [
      { id: 'def1', x: 76, y: 3048, w: 260, h: 40 },
      { id: 'def2', x: 76, y: 3076, w: 260, h: 40 },
      { id: 'use', x: 472, y: 3104, w: 120, h: 30 },
      { id: 'def3', x: 76, y: 3104, w: 260, h: 40 },
      { id: 'next', x: 76, y: 3200, w: 400, h: 30 },
    ];
    const moves = separateKeepingOrder(boxes, 8, snap);
    const after = boxes.map((b) => ({ ...b, y: b.y + (moves.get(b.id) ?? 0) }));
    // nothing overlaps any more
    for (const a of after) for (const b of after) if (a !== b) expect(overlaps(a, b), `${a.id} ${b.id}`).toBe(false);
    // the order is the same: def3 is still before use, which is still before next
    const order = (list: Box[]) => readingOrder(list.map((b) => ({ ...createRegion('math', b.x, b.y), id: b.id }))).map((r) => r.id);
    expect(order(after)).toEqual(order(boxes));
    // the row moved as one
    expect(moves.get('use')).toBe(moves.get('def3'));
    // def2 cleared def1 by the gap: 3048 + 40 + 8 = 3096
    expect(3076 + moves.get('def2')!).toBe(3096);
  });

  it('nothing moves when nothing overlaps', () => {
    expect(separateKeepingOrder([{ id: 'a', x: 0, y: 0, w: 100, h: 20 }, { id: 'b', x: 0, y: 40, w: 100, h: 20 }], 8, snap).size).toBe(0);
  });

  it('a region in an open area moves by what is left after its area moved; the area grows to keep it', () => {
    const area = { ...createRegion('area', 40, 100), id: 'A', height: 200 } as Region;
    const inside = { ...createRegion('math', 80, 150), id: 'C' };
    const below = { ...createRegion('math', 80, 400), id: 'D' };
    const regions = [area, inside, below];
    // the area is pushed 16 px, what is in it 56 px (40 more than the area), what is below 56 px
    const steps = moveSteps(regions, new Map([['A', 16], ['C', 56], ['D', 56]]));
    expect(steps.areas).toEqual([{ id: 'A', dy: 16 }]);
    expect(steps.others.get(40)).toEqual(['C']);
    expect(steps.others.get(56)).toEqual(['D']);
    expect(steps.fits).toEqual([{ id: 'A', height: 240 }]);
  });
});
