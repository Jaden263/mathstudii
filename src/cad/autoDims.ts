// Automatic dimensions of a drawing ("Automatic dimensions" in the side panel), made from
// the model like the ones placed by hand, so they follow it: every overall size once (the
// width along x on the front view, else the top; the height along z on the front, else the
// side; the depth along y on the top, else the side), a round outline by its diameter
// (which is then both of its sizes), each hole feature's callout once and other round holes
// by their diameter with how many there are, and the holes' places: the diameter of the
// circle they stand on round a centre, else their distances from the view's left and
// bottom edges, each distinct distance once. Smaller sizes stand nearer the view (ISO 129-1).
import type { DrawingRegion } from '../model/types';
import type { Annotation, DimAnnotation, DrawPick, HoleAnnotation, PickSnap, XY } from './annotations';
import { holeOfKey } from './annotations';
import { viewPicks } from './drawingAnnotate';
import { pickOf, type DrawnPart, type ViewEntity } from './drawingRefs';
import type { PlacedView, Sheet } from './drawingSheet';

const { abs, hypot, max, min, SQRT1_2 } = Math;

/** Distance of the first row of dimensions from the view, and between rows (paper mm). */
const FIRST = 10, STEP = 8;

/** The model axis (0 x, 1 y, 2 z) a paper direction of a view runs along, if any. */
const axisOf = (v: [number, number, number]) => [0, 1, 2].find((i) => abs(abs(v[i]) - 1) < 1e-9);

export function autoDimensions(r: DrawingRegion, sheet: Sheet, parts: DrawnPart[]): Annotation[] {
  const out: Annotation[] = [];
  /** Model axes already sized, with the size. */
  const covered = new Map<number, number>();
  const views = (['front', 'top', 'side'] as const).map((k) => sheet.views.find((v) => v.key === k)).filter((v): v is PlacedView => !!v);
  const ctx = new Map(views.map((pv) => [pv.key, viewPicks(r, pv, parts)]));
  const pick = (e: ViewEntity, snap: PickSnap): DrawPick => pickOf({ e, snap, x: 0, y: 0 }, parts);
  /** Rows of dimensions used so far on each side of each view. */
  const rows = new Map<string, number>();
  const row = (key: string) => {
    const n = rows.get(key) ?? 0;
    rows.set(key, n + 1);
    return FIRST + n * STEP;
  };

  // ---- holes first: their sizes and places stand nearest the views
  for (const pv of views) {
    const vp = ctx.get(pv.key);
    if (!vp) continue;
    const size = max(pv.view.box.x1 - pv.view.box.x0, pv.view.box.y1 - pv.view.box.y0, 1e-9), tol = size * 1e-6;
    const full = (e: ViewEntity) => e.shape.k === 'circle' && e.shape.a1 - e.shape.a0 > 2 * Math.PI - 1e-9;
    const circles = vp.ents.filter(full).sort((a, b) => a.depth - b.depth);
    // one circle per place and size (a hole's two ends coincide), the nearest
    const seen: ViewEntity[] = [];
    for (const c of circles) {
      const s = c.shape as Extract<ViewEntity['shape'], { k: 'circle' }>;
      if (!seen.some((q) => q.shape.k === 'circle' && hypot(q.shape.cx - s.cx, q.shape.cy - s.cy) < tol && abs(q.shape.r - s.r) < tol)) seen.push(c);
    }
    const holes = seen.filter((c) => c.hole);
    if (!holes.length) continue;
    const C = (e: ViewEntity): XY => (e.shape.k === 'circle' ? [e.shape.cx, e.shape.cy] : [0, 0]);
    const R = (e: ViewEntity) => (e.shape.k === 'circle' ? e.shape.r : 0);
    // groups: the drills of one hole feature, or round holes of one size
    const groups = new Map<string, ViewEntity[]>();
    for (const c of holes) {
      const hk = c.faces.map(holeOfKey).find(Boolean);
      const wall = c.faces.some((k) => /\/hole\d+:wall/.test(k));
      if (hk && !wall) continue; // a counterbore's or countersink's rim: the callout has it
      const key = hk ? `f:${hk.feature}` : `d:${R(c).toPrecision(9)}`;
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    const k = pv.k, mm = (v: number) => v / k;
    const box = pv.view.box;
    const centres: ViewEntity[] = [];
    for (const [key, g] of groups) {
      // the one up and to the right carries the callout or the size, its text out at 45°
      const first = [...g].sort((a, b) => C(b)[0] + C(b)[1] - C(a)[0] - C(a)[1])[0];
      const [cx, cy] = C(first), rr = R(first);
      const at: XY = [cx + (rr + mm(6)) * SQRT1_2, cy + (rr + mm(6)) * SQRT1_2];
      if (key.startsWith('f:')) {
        out.push({ id: `auto:${pv.key}:hole:${key.slice(2)}`, kind: 'hole', view: pv.key, a: pick(first, 'circle'), at: [at[0] + mm(4), at[1] + mm(4)] } satisfies HoleAnnotation);
      } else {
        out.push({ id: `auto:${pv.key}:dia:${key.slice(2)}`, kind: 'dim', view: pv.key, type: 'diameter', a: pick(first, 'circle'), text: [at[0] + mm(8), at[1] + mm(8)], ...(g.length > 1 ? { prefix: `${g.length}×` } : {}) } satisfies DimAnnotation);
      }
      // on a circle round a centre: the pitch circle's diameter places them all
      if (g.length >= 3) {
        const centre = seen.find((c) => !g.includes(c) && (() => {
          const d0 = hypot(C(g[0])[0] - C(c)[0], C(g[0])[1] - C(c)[1]);
          return d0 > tol && g.every((q) => abs(hypot(C(q)[0] - C(c)[0], C(q)[1] - C(c)[1]) - d0) < tol * 10);
        })());
        if (centre) {
          const [px, py] = C(centre), pr = hypot(cx - px, cy - py);
          out.push({ id: `auto:${pv.key}:pcd:${key.slice(2)}`, kind: 'dim', view: pv.key, type: 'pitch', a: pick(first, 'centre'), b: pick(centre, 'centre'), text: [px - (pr + mm(14)) * SQRT1_2, py + (pr + mm(14)) * SQRT1_2] } satisfies DimAnnotation);
          continue;
        }
      }
      centres.push(...g);
    }
    // the others from the left and bottom edges of the view, each distance once; a hole
    // at the middle of a round outline needs none
    const outlineCentre = seen.find((c) => !c.hole && hypot(R(c) * 2 - (box.x1 - box.x0), 0) < tol * 10);
    const placed = centres.filter((c) => !outlineCentre || hypot(C(c)[0] - C(outlineCentre)[0], C(c)[1] - C(outlineCentre)[1]) > tol);
    const edge = (axis: 0 | 1) => extreme(vp.ents, axis, axis === 0 ? box.x0 : box.y0, -1, tol);
    for (const axis of [0, 1] as const) {
      const from = edge(axis);
      if (!from || from.kind === 'cyl') continue;
      const done: number[] = [];
      for (const c of [...placed].sort((a, b) => C(a)[axis] - C(b)[axis])) {
        const v = C(c)[axis] - (axis === 0 ? box.x0 : box.y0);
        if (v < tol || done.some((q) => abs(q - v) < tol)) continue;
        done.push(v);
        const off = mm(row(`${pv.key}:${axis === 0 ? 'below' : 'left'}`));
        const text: XY = axis === 0 ? [(box.x0 + C(c)[0]) / 2, box.y0 - off] : [box.x0 - off, (box.y0 + C(c)[1]) / 2];
        out.push({ id: `auto:${pv.key}:pos${axis}:${done.length}`, kind: 'dim', view: pv.key, type: 'linear', orient: axis === 0 ? 'h' : 'v', a: pick(from.e, from.snap), b: pick(c, 'centre'), text } satisfies DimAnnotation);
      }
    }
  }

  // ---- overall sizes, each model axis once
  const want: [number, ('front' | 'top' | 'side')[]][] = [[0, ['front', 'top']], [2, ['front', 'side']], [1, ['top', 'side']]];
  for (const [A, order] of want) {
    if (covered.has(A)) continue;
    for (const key of order) {
      const pv = views.find((v) => v.key === key), vp = pv && ctx.get(key);
      if (!pv || !vp) continue;
      const pa = [axisOf(vp.frame.right), axisOf(vp.frame.up)];
      const found = pa.indexOf(A);
      if (found < 0) continue;
      const axis = found as 0 | 1;
      const box = pv.view.box, size = max(box.x1 - box.x0, box.y1 - box.y0, 1e-9), tol = size * 1e-6;
      const lo = extreme(vp.ents, axis, axis === 0 ? box.x0 : box.y0, -1, tol), hi = extreme(vp.ents, axis, axis === 0 ? box.x1 : box.y1, 1, tol);
      if (!lo || !hi) continue;
      const k = pv.k, side = axis === 0 ? 'below' : 'right';
      const off = row(`${key}:${side}`) / k;
      const text: XY = axis === 0 ? [(box.x0 + box.x1) / 2, box.y0 - off] : [box.x1 + off, (box.y0 + box.y1) / 2];
      const across = vp.frame.dir.map(abs).indexOf(1);
      if (lo.kind === 'cyl' && hi.kind === 'cyl' && lo.e === hi.e) {
        // a round outline: its diameter is both sizes square to its axis
        out.push({ id: `auto:${key}:overall:${A}`, kind: 'dim', view: key, type: 'diameter', a: pick(lo.e, 'cyl'), text } satisfies DimAnnotation);
        covered.set(A, 0);
        if (across >= 0) covered.set(across, 0);
      } else if (lo.kind === 'circle' && hi.kind === 'circle' && lo.e === hi.e) {
        out.push({ id: `auto:${key}:overall:${A}`, kind: 'dim', view: key, type: 'diameter', a: pick(lo.e, 'circle'), text } satisfies DimAnnotation);
        covered.set(A, 0);
        covered.set(pa[1 - axis]!, 0);
      } else if (lo.kind !== 'cyl' && hi.kind !== 'cyl') {
        out.push({ id: `auto:${key}:overall:${A}`, kind: 'dim', view: key, type: 'linear', orient: axis === 0 ? 'h' : 'v', a: pick(lo.e, lo.snap), b: pick(hi.e, hi.snap), text } satisfies DimAnnotation);
        covered.set(A, 0);
      } else continue;
      break;
    }
  }
  // placed at the views' scales: kept as the drawing's own, they keep their distances on the paper
  return out.map((a) => ({ ...a, k: sheet.views.find((v) => v.key === a.view)!.k }));
}

/**
 * What lies at an extreme of a view along one paper axis (at `at`, `sign` −1 the low end):
 * a line square to the axis there, else a vertex or a section's corner, else a circle's
 * quadrant, else a cylinder's outline.
 */
function extreme(ents: ViewEntity[], axis: 0 | 1, at: number, sign: 1 | -1, tol: number): { e: ViewEntity; snap: PickSnap; kind: 'line' | 'point' | 'circle' | 'cyl' } | null {
  const near = (v: number) => abs(v - at) <= tol * 10;
  const lines = ents.filter((e) => e.shape.k === 'line' && near(axis === 0 ? e.shape.x1 : e.shape.y1) && near(axis === 0 ? e.shape.x2 : e.shape.y2));
  if (lines.length) return { e: lines.sort((a, b) => a.depth - b.depth)[0], snap: 'line', kind: 'line' };
  const pts = ents.filter((e) => e.shape.k === 'point' && near(axis === 0 ? e.shape.x : e.shape.y));
  if (pts.length) {
    const e = pts.sort((a, b) => a.depth - b.depth)[0];
    return { e, snap: e.cut !== undefined ? (`cut${e.cut}` as PickSnap) : 'vertex', kind: 'point' };
  }
  const q: PickSnap = axis === 0 ? (sign < 0 ? 'q2' : 'q0') : sign < 0 ? 'q3' : 'q1';
  const circles = ents.filter((e) => e.shape.k === 'circle' && near((axis === 0 ? e.shape.cx : e.shape.cy) + sign * e.shape.r));
  if (circles.length) return { e: circles.sort((a, b) => b.depth - a.depth).sort((a, b) => (b.shape as { r: number }).r - (a.shape as { r: number }).r)[0], snap: q, kind: 'circle' };
  const cyls = ents.filter((e) => {
    if (e.shape.k !== 'cyl') return false;
    const s = e.shape, l = hypot(s.x2 - s.x1, s.y2 - s.y1) || 1, n = axis === 0 ? abs(s.y2 - s.y1) / l : abs(s.x2 - s.x1) / l;
    // an axis square to the paper axis: its outlines are at the centre ± r
    return n > 1 - 1e-9 && near((axis === 0 ? min(s.x1, s.x2) : min(s.y1, s.y2)) + sign * s.r);
  });
  if (cyls.length) return { e: cyls.sort((a, b) => (b.shape as { r: number }).r - (a.shape as { r: number }).r)[0], snap: 'cyl', kind: 'cyl' };
  return null;
}
