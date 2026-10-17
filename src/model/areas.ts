// Collapsible areas (Mathcad "Area"). An area is a title bar at (x, y) over a band of the page
// `height` px tall, and the regions whose top lies inside the band are in it. Collapsing hides
// them and moves everything below up by the band less the bar; expanding moves it back down by
// the same amount, so positions come back exactly. Hidden regions keep the places they have
// when expanded and travel with their area: the expanded worksheet, and so the reading order
// that evaluation follows, is the same whatever is collapsed.
import { GRID, PAGE_MARGIN, readingOrder, type AreaRegion, type Region, type Worksheet } from './types';

/** Height of an area's title bar: all a collapsed area takes on the page. */
export const AREA_BAR = 24;
/** Left edge of new area bars, a little into the margin so they frame the regions. */
export const AREA_X = PAGE_MARGIN - GRID;
/** Space between the last region of an area and its end line. */
export const AREA_PAD = GRID;

export const isArea = (r: Region): r is AreaRegion => r.kind === 'area';

/** Ids of everything collapsed areas hide (the contents of nested areas included). */
export function hiddenIds(regions: Region[]): Set<string> {
  const out = new Set<string>();
  for (const r of regions) if (isArea(r) && r.collapsed) r.hidden?.forEach((id) => out.add(id));
  return out;
}

/** Is the top of r inside the band of the area a? */
const inBand = (a: AreaRegion, r: Region) => r.id !== a.id && r.y > a.y && r.y < a.y + a.height;

/** The regions directly in an area: the visible ones in its band, or those it hides. */
export function areaMembers(regions: Region[], a: AreaRegion, hidden = hiddenIds(regions)): Region[] {
  if (a.collapsed) {
    const ids = new Set(a.hidden ?? []);
    return regions.filter((r) => ids.has(r.id));
  }
  if (hidden.has(a.id)) {
    // an open area inside a collapsed one: its band holds what that one hides with it (the
    // visible regions now at those heights are from further down)
    const owner = regions.find((o): o is AreaRegion => isArea(o) && !!o.collapsed && !!o.hidden?.includes(a.id));
    const pool = new Set(owner?.hidden ?? []);
    return regions.filter((r) => pool.has(r.id) && inBand(a, r));
  }
  return regions.filter((r) => !hidden.has(r.id) && inBand(a, r));
}

/** These regions and everything inside the areas among them, recursively. */
export function withContents(regions: Region[], ids: Iterable<string>): Set<string> {
  const hidden = hiddenIds(regions);
  const byId = new Map(regions.map((r) => [r.id, r]));
  const out = new Set<string>();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    const r = byId.get(id);
    if (r && isArea(r)) for (const m of areaMembers(regions, r, hidden)) stack.push(m.id);
  }
  return out;
}

/** The areas a region is in, outermost first. */
export function areasOf(regions: Region[], id: string): AreaRegion[] {
  const out: AreaRegion[] = [];
  for (const a of regions) {
    if (!isArea(a) || a.id === id) continue;
    if (withContents(regions, [a.id]).has(id)) out.push(a);
  }
  // an area's bar is above the bars of the areas inside it
  return out.sort((p, q) => p.y - q.y);
}

/** The expanded, visible areas whose band holds the height y, and the areas they are in. */
export function areasAt(regions: Region[], y: number): AreaRegion[] {
  const hidden = hiddenIds(regions);
  const out = new Map<string, AreaRegion>();
  for (const a of regions) {
    if (!isArea(a) || a.collapsed || hidden.has(a.id) || !(y > a.y && y < a.y + a.height)) continue;
    out.set(a.id, a);
    for (const o of areasOf(regions, a.id)) out.set(o.id, o);
  }
  return [...out.values()].sort((p, q) => p.y - q.y);
}

/** These ids with what the collapsed areas among them hide, recursively. */
function withHidden(regions: Region[], ids: Iterable<string>): Set<string> {
  const byId = new Map(regions.map((r) => [r.id, r]));
  const out = new Set(ids);
  const stack = [...out];
  while (stack.length) {
    const r = byId.get(stack.pop()!);
    if (!r || !isArea(r) || !r.collapsed) continue;
    for (const h of r.hidden ?? []) {
      if (out.has(h)) continue;
      out.add(h);
      stack.push(h);
    }
  }
  return out;
}

/**
 * Move every visible region whose top is at or below `from` by dy (hidden ones with their
 * area), and change the bands of the areas in `grow` by dy.
 */
function reflow(regions: Region[], from: number, dy: number, grow: Set<string>, skip: Set<string>): Region[] {
  const hidden = hiddenIds(regions);
  const moving = withHidden(regions, regions.filter((r) => !hidden.has(r.id) && !skip.has(r.id) && r.y >= from).map((r) => r.id));
  return regions.map((r) => {
    let q = r;
    if (moving.has(r.id)) q = { ...q, y: q.y + dy };
    // a band round the collapsing one shrinks by exactly what it gives back (so it grows back exactly)
    if (grow.has(r.id) && isArea(q)) q = { ...q, height: Math.max(AREA_BAR, q.height + dy) };
    return q;
  });
}

const find = (ws: Worksheet, id: string) => ws.regions.find((r): r is AreaRegion => r.id === id && isArea(r));

/** Hide an area's contents behind its title bar; what is below moves up. */
export function collapseArea(ws: Worksheet, id: string): Worksheet {
  const a = find(ws, id);
  const hidden = hiddenIds(ws.regions);
  // an area inside a collapsed one cannot be reached until that one is expanded
  if (!a || a.collapsed || hidden.has(a.id)) return ws;
  const members = areaMembers(ws.regions, a, hidden).map((r) => r.id);
  const outer = new Set(areasOf(ws.regions, a.id).map((o) => o.id));
  const regions = reflow(ws.regions, a.y + a.height, -(a.height - AREA_BAR), outer, new Set([a.id, ...members]))
    .map((r): Region => (r.id === a.id ? { ...(r as AreaRegion), collapsed: true, hidden: members } : r));
  return { ...ws, regions };
}

/** Show an area's contents again; what is below moves back down. */
export function expandArea(ws: Worksheet, id: string): Worksheet {
  const a = find(ws, id);
  if (!a || !a.collapsed || hiddenIds(ws.regions).has(a.id)) return ws;
  const outer = new Set(areasOf(ws.regions, a.id).map((o) => o.id));
  const regions = reflow(ws.regions, a.y + AREA_BAR, a.height - AREA_BAR, outer, new Set([a.id])).map((r) => {
    if (r.id !== a.id) return r;
    const open = { ...(r as AreaRegion) };
    delete open.hidden;
    delete open.collapsed;
    return open;
  });
  return { ...ws, regions };
}

/** Expand the areas that hide a region, outermost first, so it can be seen. */
export function revealRegion(ws: Worksheet, id: string): Worksheet {
  let cur = ws;
  for (const a of areasOf(ws.regions, id)) if (a.collapsed) cur = expandArea(cur, a.id);
  return cur;
}

/** The regions placed as they are with every area expanded. */
export function expandedLayout(ws: Worksheet): Region[] {
  let cur = ws;
  for (let guard = 0; guard < 10000; guard++) {
    const hidden = hiddenIds(cur.regions);
    const next = cur.regions.find((r) => isArea(r) && r.collapsed && !hidden.has(r.id));
    if (!next) break;
    cur = expandArea(cur, next.id);
  }
  return cur.regions;
}

/** Mathcad reading order of the expanded worksheet: the order of evaluation. */
export function evaluationOrder(ws: Worksheet): Region[] {
  if (!ws.regions.some((r) => isArea(r) && r.collapsed)) return readingOrder(ws.regions);
  const byId = new Map(ws.regions.map((r) => [r.id, r]));
  return readingOrder(expandedLayout(ws)).map((r) => byId.get(r.id)!);
}

/** The layout printed: areas with a print setting collapsed or expanded as it asks. */
export function printLayout(ws: Worksheet): Worksheet {
  let cur = ws;
  for (let guard = 0; guard < 10000; guard++) {
    const hidden = hiddenIds(cur.regions);
    const next = cur.regions.find((r): r is AreaRegion => isArea(r) && !hidden.has(r.id) && !!r.print && (r.print === 'collapsed') !== !!r.collapsed);
    if (!next) break;
    cur = next.collapsed ? expandArea(cur, next.id) : collapseArea(cur, next.id);
  }
  return cur;
}

/** Height a region takes on the page: rendered height, a band, or a bar. */
function extent(r: Region, height: (id: string) => number): number {
  if (isArea(r)) return r.collapsed ? AREA_BAR : r.height;
  return height(r.id);
}

/**
 * Put these regions, with any others whose top lies level with them (an area is a band across
 * the page), into the new area `area`. Room is made for its title bar above them and for its
 * end line below; everything under them keeps its layout.
 * @param height rendered height of a region, px
 */
export function groupIntoArea(ws: Worksheet, ids: string[], height: (id: string) => number, area: AreaRegion): Worksheet {
  const hidden = hiddenIds(ws.regions);
  const visible = ws.regions.filter((r) => !hidden.has(r.id));
  const pick = new Set(visible.filter((r) => ids.includes(r.id)).map((r) => r.id));
  if (!pick.size) return ws;
  const set = withContents(ws.regions, pick);
  let top = Math.min(...visible.filter((r) => set.has(r.id)).map((r) => r.y));
  let bottom = Math.max(...visible.filter((r) => set.has(r.id)).map((r) => r.y + extent(r, height)));
  // the band takes in whatever starts beside the selection
  for (let changed = true; changed;) {
    changed = false;
    for (const r of visible) {
      if (set.has(r.id) || r.y < top || r.y >= bottom) continue;
      for (const id of withContents(ws.regions, [r.id])) set.add(id);
      bottom = Math.max(bottom, r.y + extent(r, height));
      changed = true;
    }
  }
  top = Math.max(0, top);
  const outer = new Set(areasAt(ws.regions, top).filter((o) => !set.has(o.id)).map((o) => o.id));
  const bar = AREA_BAR + GRID;
  // room for the bar above the first region, then for the end line under the last
  let regions = reflow(ws.regions, top, bar, outer, new Set());
  regions = reflow(regions, bottom + bar, AREA_PAD + GRID, outer, set);
  // an area round other areas sits a step further out, one inside others a step further in,
  // so the bars read as nested
  const inner = ws.regions.filter((r): r is AreaRegion => isArea(r) && set.has(r.id));
  const out = Math.min(area.x, ...inner.map((r) => r.x - GRID));
  const x = Math.max(GRID, inside(ws.regions, outer, out, inner));
  const made: AreaRegion = { ...area, x, y: top, height: bottom + bar + AREA_PAD - top };
  // drawn first, so it never covers a region
  return nestBands({ ...ws, regions: [made, ...regions] });
}

/** Where an area ends on the page: its end line, or the foot of its bar when collapsed. */
const pageEnd = (a: AreaRegion) => a.y + (a.collapsed ? AREA_BAR : a.height);

/**
 * Bands nest or lie apart, never cross, and nothing starts on a bar it is not under. Collapsing
 * relies on this: what an area holds must not change when something else collapses or opens.
 * - An area whose bar is in another's band but whose end is below that band's end (grouped or
 *   dragged there) is taken in by stretching the outer band down to its end.
 * - A region put on a collapsed bar, or level with a bar, goes to the foot of the bar: on a
 *   collapsed one it would otherwise land inside the band when the area opens.
 */
export function nestBands(ws: Worksheet): Worksheet {
  let regions = ws.regions;
  for (let guard = 0; guard < 1000; guard++) {
    const hidden = hiddenIds(regions);
    const shown = regions.filter((r) => !hidden.has(r.id));
    const bars = shown.filter(isArea);
    let next: Region[] | null = null;
    for (const a of bars) {
      const on = shown.find((r) => r !== a && r.y >= a.y && r.y < a.y + AREA_BAR && (r.y === a.y || !!a.collapsed));
      if (on) {
        const dy = a.y + AREA_BAR - on.y;
        const block = withContents(regions, [on.id]);
        next = regions.map((r) => (block.has(r.id) ? { ...r, y: r.y + dy } : r));
        break;
      }
      if (a.collapsed) continue;
      const q = bars.find((o) => o !== a && o.y > a.y && o.y < pageEnd(a) && pageEnd(o) > pageEnd(a));
      if (q) {
        next = regions.map((r) => (r.id === a.id ? { ...a, height: pageEnd(q) - a.y } : r));
        break;
      }
    }
    if (!next) break;
    regions = next;
  }
  return regions === ws.regions ? ws : { ...ws, regions };
}

/** An empty area at area.y, `area.height` tall; what is below moves down to make room. */
export function insertArea(ws: Worksheet, area: AreaRegion): Worksheet {
  const outer = new Set(areasAt(ws.regions, area.y).map((o) => o.id));
  const regions = reflow(ws.regions, area.y, area.height + GRID, outer, new Set());
  return { ...ws, regions: [{ ...area, x: inside(ws.regions, outer, area.x, []) }, ...regions] };
}

/** x of a bar inside the areas `outer`: a step in from theirs, unless that would not clear the bars inside it. */
function inside(regions: Region[], outer: Set<string>, x: number, inner: AreaRegion[]): number {
  const xs = regions.filter((r) => outer.has(r.id)).map((r) => r.x + GRID);
  if (!xs.length) return x;
  const want = Math.max(x, ...xs);
  return inner.some((r) => r.x <= want) ? x : want;
}

/** Space `height` tall at the height `at`: what is there and below moves down, areas round it grow. */
export function makeRoom(ws: Worksheet, at: number, height: number): Worksheet {
  const outer = new Set(areasAt(ws.regions, at).map((o) => o.id));
  return { ...ws, regions: reflow(ws.regions, at, height, outer, new Set()) };
}

/** Remove an area and keep its contents where they are (expanded). */
export function ungroupArea(ws: Worksheet, id: string): Worksheet {
  const open = expandArea(ws, id);
  return { ...open, regions: open.regions.filter((r) => r.id !== id) };
}

/** Grow an area's band to `height` (its contents got taller); what is below moves down. */
export function fitArea(ws: Worksheet, id: string, height: number): Worksheet {
  const a = find(ws, id);
  if (!a || a.collapsed || height <= a.height || hiddenIds(ws.regions).has(a.id)) return ws;
  const grow = new Set([a.id, ...areasOf(ws.regions, a.id).map((o) => o.id)]);
  return { ...ws, regions: reflow(ws.regions, a.y + a.height, height - a.height, grow, new Set([a.id])) };
}

/** Bottom of an area's contents as rendered (regions, bands of areas inside, bars of collapsed ones). */
export function contentBottom(regions: Region[], a: AreaRegion, height: (id: string) => number): number {
  let bottom = a.y + AREA_BAR;
  for (const r of areaMembers(regions, a)) bottom = Math.max(bottom, r.y + extent(r, height));
  return bottom;
}
