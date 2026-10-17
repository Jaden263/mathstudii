// Pushing overlapping regions apart after an import (a file laid out at the sizes another
// program drew it) without changing which region calculates first: a region pushed down takes
// everything after it in reading order along, so a definition never ends up below its use.
import { hiddenIds, isArea, withContents } from '../model/areas';
import type { AreaRegion, Region } from '../model/types';

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Reading order: top to bottom, left to right within a row (as readingOrder in model/types). */
const byReading = (a: Box, b: Box) => (Math.abs(a.y - b.y) < 4 ? a.x - b.x : a.y - b.y);

/** The downward moves (dy by id, non-zero only) that clear every overlap and keep the reading order. */
export function separateKeepingOrder(boxes: Box[], gap: number, snap: (y: number) => number): Map<string, number> {
  const placed: Box[] = [];
  const moves = new Map<string, number>();
  // how far everything from here on has been pushed: never less than for the regions before
  let shift = 0;
  for (const b of [...boxes].sort(byReading)) {
    let y = b.y + shift;
    for (let changed = true; changed;) {
      changed = false;
      for (const p of placed) {
        if (b.x < p.x + p.w && b.x + b.w > p.x && y < p.y + p.h && y + b.h > p.y) {
          y = Math.max(y, snap(p.y + p.h + gap));
          changed = true;
        }
      }
    }
    shift = y - b.y;
    if (shift) moves.set(b.id, shift);
    placed.push({ ...b, y });
  }
  return moves;
}

/** The moves as store actions, for a worksheet that may have open areas. */
export interface MoveSteps {
  /** Areas to grow first ('areaFit'), so that what is pushed further down stays inside them. */
  fits: { id: string; height: number }[];
  /** Areas to move one by one, outermost first: each takes what is in it along. */
  areas: { id: string; dy: number }[];
  /** Everything else, grouped by how far it moves. */
  others: Map<number, string[]>;
}

/**
 * An area moves with its contents, so a region in one moves by what is left after its
 * innermost area's move; an area whose contents go further grows by that much.
 */
export function moveSteps(regions: Region[], moves: Map<string, number>): MoveSteps {
  const hidden = hiddenIds(regions);
  const open = regions.filter((r): r is AreaRegion => isArea(r) && !r.collapsed && !hidden.has(r.id));
  const contents = new Map(open.map((a) => [a.id, withContents(regions, [a.id])]));
  // the innermost open area each region is in (an area inside another is in its contents)
  const inner = new Map<string, AreaRegion>();
  for (const a of open) {
    for (const id of contents.get(a.id)!) {
      const cur = inner.get(id);
      if (id !== a.id && (!cur || contents.get(cur.id)!.has(a.id))) inner.set(id, a);
    }
  }
  const out: MoveSteps = { fits: [], areas: [], others: new Map() };
  const extra = new Map<string, number>();
  for (const [id, dy] of moves) {
    const a = inner.get(id);
    const d = dy - (a ? moves.get(a.id) ?? 0 : 0);
    if (a && d > 0) extra.set(a.id, Math.max(extra.get(a.id) ?? 0, d));
    if (!d) continue;
    if (contents.has(id)) out.areas.push({ id, dy: d });
    else out.others.set(d, [...(out.others.get(d) ?? []), id]);
  }
  for (const a of open) if (extra.has(a.id)) out.fits.push({ id: a.id, height: a.height + extra.get(a.id)! });
  const top = new Map(open.map((a) => [a.id, a.y]));
  out.areas.sort((p, q) => top.get(p.id)! - top.get(q.id)!);
  return out;
}
