// A drawing sheet laid out on paper: ISO 5457 sizes A4–A0 and frame, an ISO 7200-style
// title block, the standard views in first- or third-angle projection with section and
// detail views beside them, and the line work in ISO 128 line types and widths. Everything
// is in sheet millimetres from the lower left corner (y up), so the SVG on the page and the
// DXF are drawn from the same entities.
import type { DrawingDetail, DrawingRegion, DrawingSection } from '../model/types';
import { scaleText, STANDARD_VIEWS, viewAxes, type ViewSpec } from './drawing';
import { clipToCircle, hatch, hatchStyle, placePrim, primAt, type DrawView, type DrawViewRequest, type Prim } from './drawing2d';
import { add3, dot3, norm3, scale3, type Vec3 } from './solid';

export const SHEET_SIZES = { A0: [1189, 841], A1: [841, 594], A2: [594, 420], A3: [420, 297], A4: [297, 210] } as const;
export type SheetName = keyof typeof SHEET_SIZES;

/** Width and height of the sheet (mm). */
export function sheetSize(r: Pick<DrawingRegion, 'sheet' | 'portrait'>): [number, number] {
  const [w, h] = SHEET_SIZES[r.sheet] ?? SHEET_SIZES.A4;
  return r.portrait ? [h, w] : [w, h];
}

/** The ISO 128-20 line group of a sheet: wide lines 0.5 mm on A4 to A2, 0.7 on A1 and A0; narrow ones half; text heights to match. */
export interface LineGroup {
  wide: number;
  narrow: number;
  /** Height of dimension figures and of view labels (ISO 3098 capitals). */
  dim: number;
  label: number;
}

export function lineGroup(sheet: SheetName): LineGroup {
  return sheet === 'A0' || sheet === 'A1' ? { wide: 0.7, narrow: 0.35, dim: 5, label: 7 } : { wide: 0.5, narrow: 0.25, dim: 3.5, label: 5 };
}

export type Layer = 'VISIBLE' | 'HIDDEN' | 'CENTER' | 'TANGENT' | 'THIN' | 'HATCH' | 'DIM' | 'TEXT' | 'BORDER';
export const LAYERS: Layer[] = ['VISIBLE', 'HIDDEN', 'CENTER', 'TANGENT', 'THIN', 'HATCH', 'DIM', 'TEXT', 'BORDER'];

/**
 * The ISO 128-20 line of a layer: its width and dash pattern (mm; empty: continuous).
 * Dashed (type 02): dashes 12d, gaps 3d; long-dash dotted (type 04): 24d, 3d, a dot of 0.5d, 3d.
 */
export function layerStyle(layer: Layer, g: LineGroup): { width: number; dash: number[] } {
  const n = g.narrow;
  if (layer === 'VISIBLE') return { width: g.wide, dash: [] };
  if (layer === 'BORDER') return { width: 0.7, dash: [] };
  if (layer === 'HIDDEN') return { width: n, dash: [12 * n, 3 * n] };
  if (layer === 'CENTER') return { width: n, dash: [24 * n, 3 * n, 0.5 * n, 3 * n] };
  return { width: n, dash: [] };
}

export interface Ink {
  layer: Layer;
  p: Prim;
}

export interface Label {
  layer: Layer;
  x: number;
  y: number;
  /** Height of the capitals (mm). */
  h: number;
  text: string;
  anchor: 'start' | 'middle' | 'end';
  /** Degrees counter-clockwise. */
  rot?: number;
  bold?: boolean;
  /** Grey (the title block's field names). */
  faint?: boolean;
}

/** A filled polygon (arrowheads). */
export interface Fill {
  layer: Layer;
  pts: number[];
}

export interface PlacedView {
  /** Standard view key, `sec:${id}` or `det:${id}`. */
  key: string;
  kind: 'base' | 'section' | 'detail';
  /** On the paper: x = ox + k·X, y = oy + k·Y for view coordinates X, Y. */
  ox: number;
  oy: number;
  k: number;
  /** Where it lies on the paper. */
  box: { x0: number; y0: number; x1: number; y1: number };
  view: DrawView;
}

export interface Sheet {
  W: number;
  H: number;
  scale: number;
  group: LineGroup;
  frame: { x: number; y: number; w: number; h: number };
  title: { x: number; y: number; w: number; h: number };
  inks: Ink[];
  fills: Fill[];
  labels: Label[];
  views: PlacedView[];
}

// ------------------------------------------------------------ what to ask the kernel for

export type BaseKey = 'front' | 'top' | 'side' | 'iso';
export const BASE_KEYS: BaseKey[] = ['front', 'top', 'side', 'iso'];

/** The view a standard key stands for (the side view is the left one in first angle, the right one in third). */
export function baseSpec(key: BaseKey, projection: DrawingRegion['projection']): ViewSpec {
  return STANDARD_VIEWS[key === 'side' ? (projection === 'first' ? 'left' : 'right') : key];
}

/** The standard views a drawing shows, as kernel requests. */
export function baseRequests(r: DrawingRegion): DrawViewRequest[] {
  return BASE_KEYS.filter((k) => r.views[k]).map((k) => {
    const s = baseSpec(k, r.projection);
    return { key: k, name: s.name, dir: s.dir, up: s.up, hidden: k !== 'iso' && r.hidden };
  });
}

/**
 * The plane and view of a section (ISO 128-44): the plane through the cutting line and
 * the parent's direction of view. A line nearer vertical than horizontal keeps the
 * parent's up along it; a nearer horizontal one turns the parent's depth up the paper, so
 * a cut across a front view is seen as a top view would be. Of the two ways to look, the
 * one that keeps the part upright (and then the one looking down) is taken, unless flipped.
 */
function sectionGeometry(r: DrawingRegion, s: DrawingSection) {
  const parent = viewAxes(baseSpec(s.view, r.projection));
  const lx = s.b.x - s.a.x, ly = s.b.y - s.a.y;
  const l = Math.hypot(lx, ly) || 1;
  const along = norm3(add3(scale3(parent.right, lx / l), scale3(parent.up, ly / l)));
  const look = (sg: number) => {
    // looking along sg·(ly, −lx) on the parent's paper
    const n = norm3(add3(scale3(parent.right, (sg * ly) / l), scale3(parent.up, (-sg * lx) / l)));
    let up: Vec3;
    if (Math.abs(ly) >= Math.abs(lx)) up = dot3(along, parent.up) >= 0 ? along : scale3(along, -1);
    else up = scale3(parent.dir, dot3(n, parent.up) <= 0 ? 1 : -1);
    return { n, up, score: 2 * up[2] - n[2] };
  };
  const a = look(1), b = look(-1);
  const sg = (b.score > a.score + 1e-9 ? -1 : 1) * (s.flip ? -1 : 1);
  return { parent, sg, ...(sg === 1 ? a : b) };
}

export function sectionRequest(r: DrawingRegion, s: DrawingSection): DrawViewRequest {
  const { parent, n, up } = sectionGeometry(r, s);
  const o = add3(scale3(parent.right, s.a.x), scale3(parent.up, s.a.y));
  return { key: `sec:${s.id}`, name: `${s.letter}–${s.letter}`, dir: n, up, hidden: false, cut: o };
}

/** Which way a section's arrows point on its parent: +1 to the right of a → b, −1 to its left. */
export const sectionSide = (r: DrawingRegion, s: DrawingSection) => sectionGeometry(r, s).sg;

/** Every view the drawing needs from the kernel. */
export const drawingRequests = (r: DrawingRegion): DrawViewRequest[] => [...baseRequests(r), ...(r.sections ?? []).map((s) => sectionRequest(r, s))];

/** The next free letter for a section or detail (I, O and Q are left out: they read as figures). */
export function nextLetter(r: DrawingRegion): string {
  const used = new Set([...(r.sections ?? []).map((s) => s.letter), ...(r.details ?? []).map((d) => d.letter)]);
  for (const c of 'ABCDEFGHJKLMNPRSTUVWXYZ') if (!used.has(c)) return c;
  return `Z${used.size}`;
}

/** The largest standard scale (1:1, 1:2, 1:5 … or 2:1, 5:1 …) at which a size fits. */
export const SCALES = [50, 20, 10, 5, 2, 1, 1 / 2, 1 / 2.5, 1 / 5, 1 / 10, 1 / 20, 1 / 25, 1 / 50, 1 / 100, 1 / 200, 1 / 500, 1 / 1000];

/** The smallest standard enlargement of at least `f` times the sheet's scale (a detail's default). */
export function detailScale(sheetScale: number, f = 2): number {
  for (let i = SCALES.length - 1; i >= 0; i--) if (SCALES[i] >= sheetScale * f * (1 - 1e-9)) return SCALES[i];
  return SCALES[0];
}

// ------------------------------------------------------------ layout

const GAP = 20;
const FRAME = { left: 20, other: 10 };
const TITLE = { w: 180, h: 33 };

const hasLines = (v?: DrawView) => !!v && (v.visible.length > 0 || v.hidden.length > 0 || (v.cuts?.length ?? 0) > 0);
const boxW = (v: DrawView) => v.box.x1 - v.box.x0;
const boxH = (v: DrawView) => v.box.y1 - v.box.y0;

interface Extra {
  key: string;
  kind: 'section' | 'detail';
  view: DrawView;
  /** Paper / model for this view (a detail's own, a section's the sheet's). */
  k: (s: number) => number;
  /** Its model box (a detail's: its circle). */
  box: DrawView['box'];
  at?: { x: number; y: number };
  label: string;
  def: DrawingSection | DrawingDetail;
}

/**
 * The sheet of a drawing: views laid out (standard views in their projection grid,
 * sections and details in columns to the right, or where they were dragged), scaled to
 * the largest standard scale that fits unless the drawing has one, and every line, label
 * and arrow on it.
 */
export function layoutSheet(r: DrawingRegion, views: Record<string, DrawView>, info: { unit: string; name: string; date: string }): Sheet | null {
  const [W, H] = sheetSize(r);
  const group = lineGroup(r.sheet);
  const frame = { x: FRAME.left, y: FRAME.other, w: W - FRAME.left - FRAME.other, h: H - 2 * FRAME.other };
  const title = { x: frame.x + frame.w - TITLE.w, y: frame.y, w: TITLE.w, h: TITLE.h };
  const first = r.projection === 'first';
  // rows from the top: first angle puts the top view under the front and the left view right of it
  const grid: (BaseKey | null)[][] = first ? [['front', 'side'], ['top', 'iso']] : [['top', 'iso'], ['front', 'side']];
  const base = (k: BaseKey | null) => (k && r.views[k] && hasLines(views[k]) ? views[k] : null);
  if (!grid.flat().some((k) => base(k))) return null;

  const extras: Extra[] = [];
  for (const s of r.sections ?? []) {
    const v = views[`sec:${s.id}`];
    if (hasLines(v)) extras.push({ key: `sec:${s.id}`, kind: 'section', view: v, k: (sc) => sc, box: v.box, at: s.at, label: `${s.letter}–${s.letter}`, def: s });
  }
  for (const d of r.details ?? []) {
    const v = views[d.view];
    if (!v || !hasLines(v) || !(d.r > 0) || !(d.scale > 0)) continue;
    extras.push({ key: `det:${d.id}`, kind: 'detail', view: v, k: () => d.scale, box: { x0: d.c.x - d.r, y0: d.c.y - d.r, x1: d.c.x + d.r, y1: d.c.y + d.r }, at: d.at, label: `${d.letter} (${scaleText(d.scale)})`, def: d });
  }

  const top = frame.y + frame.h, bottom = frame.y + title.h;
  const labelRoom = group.label + 6;
  /**
   * Positions of everything at scale s, or null when it does not fit: everything, or (when
   * no scale fits a large detail) the standard views alone, the rest placed as it comes.
   */
  const arrange = (s: number, fit: 'all' | 'base' | 'none') => {
    const colW = [0, 1].map((c) => Math.max(...[0, 1].map((rw) => (base(grid[rw][c]) ? boxW(base(grid[rw][c])!) * s : 0))));
    const rowH = [0, 1].map((rw) => Math.max(...[0, 1].map((c) => (base(grid[rw][c]) ? boxH(base(grid[rw][c])!) * s : 0))));
    const cols = colW.filter((w) => w > 0).length, rows = rowH.filter((h) => h > 0).length;
    // extra views in columns, top down
    const columns: { w: number; h: number; items: { e: Extra; w: number; h: number }[] }[] = [];
    const availH = top - bottom - 2 * GAP;
    for (const e of extras) {
      if (e.at) continue;
      const k = e.k(s), w = (e.box.x1 - e.box.x0) * k, h = (e.box.y1 - e.box.y0) * k + labelRoom;
      let col = columns[columns.length - 1];
      if (!col || (col.h + h + GAP > availH && col.items.length)) columns.push((col = { w: 0, h: -GAP, items: [] }));
      col.items.push({ e, w, h });
      col.w = Math.max(col.w, w);
      col.h += h + GAP;
    }
    const extraW = columns.reduce((a, c) => a + c.w, 0);
    const spareW = frame.w - colW[0] - colW[1] - extraW;
    const spareH = top - bottom - rowH[0] - rowH[1];
    const tallest = Math.max(0, ...columns.map((c) => c.h));
    const baseFits = frame.w - colW[0] - colW[1] >= GAP * (cols + 1) && spareH >= GAP * (rows + 1);
    if (fit === 'base' && !baseFits) return null;
    if (fit === 'all' && (!baseFits || spareW < GAP * (cols + columns.length + 1) || tallest > availH)) return null;
    const used = cols + columns.length;
    // the spare room between the views, up to 40 mm a gap; the block centred in what is left
    const gx = Math.min(Math.max(spareW / (used + 1), 4), 40), gy = Math.min(Math.max(spareH / (rows + 1), 4), 40);
    const y0 = top - Math.max(gy, (spareH - gy * (rows - 1)) / 2);
    const centres = new Map<string, [number, number]>();
    let x = frame.x + Math.max(gx, (spareW - gx * (used - 1)) / 2);
    for (let c = 0; c < 2; c++) {
      if (!colW[c]) continue;
      let y = y0;
      for (let rw = 0; rw < 2; rw++) {
        if (!rowH[rw]) continue;
        const k = grid[rw][c];
        if (k && base(k)) centres.set(k, [x + colW[c] / 2, y - rowH[rw] / 2]);
        y -= rowH[rw] + gy;
      }
      x += colW[c] + gx;
    }
    for (const col of columns) {
      // level with the standard views, as long as the column stays clear of the title block
      let y = Math.max(Math.min(top - GAP, y0 + labelRoom), bottom + GAP + col.h);
      for (const it of col.items) {
        centres.set(it.e.key, [x + col.w / 2, y - labelRoom - (it.h - labelRoom) / 2]);
        y -= it.h + GAP;
      }
      x += col.w + gx;
    }
    return centres;
  };
  let scale = r.scale && r.scale > 0 ? r.scale : 0;
  let centres = scale ? arrange(scale, 'none') : null;
  for (const fit of ['all', 'base'] as const) {
    if (scale) break;
    for (const s of SCALES) if ((centres = arrange(s, fit))) {
      scale = s;
      break;
    }
  }
  if (!scale) centres = arrange((scale = SCALES[SCALES.length - 1]), 'none');

  const sheet: Sheet = { W, H, scale, group, frame, title, inks: [], fills: [], labels: [], views: [] };
  const place = (key: string, kind: PlacedView['kind'], view: DrawView, k: number, box: DrawView['box'], c: [number, number]) => {
    const ox = c[0] - k * (box.x0 + box.x1) / 2, oy = c[1] - k * (box.y0 + box.y1) / 2;
    const pv: PlacedView = { key, kind, ox, oy, k, view, box: { x0: ox + k * box.x0, y0: oy + k * box.y0, x1: ox + k * box.x1, y1: oy + k * box.y1 } };
    sheet.views.push(pv);
    return pv;
  };
  for (const k of BASE_KEYS) {
    const v = base(k), c = centres!.get(k);
    if (v && c) place(k, 'base', v, scale, v.box, c);
  }
  for (const e of extras) {
    const c = e.at ? [e.at.x, e.at.y] as [number, number] : centres!.get(e.key);
    if (c) place(e.key, e.kind, e.view, e.k(scale), e.box, c);
  }

  for (const pv of sheet.views) {
    const e = extras.find((q) => q.key === pv.key);
    if (pv.kind === 'detail') drawDetail(sheet, r, pv, e!.def as DrawingDetail);
    else drawView(sheet, r, pv);
    if (e) sheet.labels.push({ layer: 'TEXT', x: (pv.box.x0 + pv.box.x1) / 2, y: pv.box.y1 + 5, h: group.label, text: e.label, anchor: 'middle' });
    // a cutting line's arrows and letters sit past the view's edges: its dimensions stand further off
    if (pv.kind === 'base' && r.dims && pv.key !== 'iso') dimension(sheet, pv, (r.sections ?? []).some((s) => s.view === pv.key) ? 15 : 8);
  }
  // the cutting lines and detail circles on their parents
  for (const s of r.sections ?? []) {
    const parent = sheet.views.find((v) => v.key === s.view);
    if (parent && sheet.views.some((v) => v.key === `sec:${s.id}`)) cuttingLine(sheet, parent, s, sectionSide(r, s));
  }
  for (const d of r.details ?? []) {
    const parent = sheet.views.find((v) => v.key === d.view);
    if (!parent || !sheet.views.some((v) => v.key === `det:${d.id}`)) continue;
    const c = toPaper(parent, d.c.x, d.c.y), rr = d.r * parent.k;
    sheet.inks.push({ layer: 'THIN', p: { k: 'arc', cx: c[0], cy: c[1], r: rr, a0: 0, a1: 2 * Math.PI } });
    sheet.labels.push({ layer: 'TEXT', x: c[0] + (rr + 2) * Math.SQRT1_2, y: c[1] + (rr + 2) * Math.SQRT1_2, h: group.label, text: d.letter, anchor: 'start' });
  }
  frameAndTitle(sheet, r, info);
  return sheet;
}

export const toPaper = (pv: PlacedView, x: number, y: number): [number, number] => [pv.ox + pv.k * x, pv.oy + pv.k * y];
export const toView = (pv: PlacedView, x: number, y: number): [number, number] => [(x - pv.ox) / pv.k, (y - pv.oy) / pv.k];

/** The placed view under a point of the paper (within a few millimetres of its box). */
export function viewAt(sheet: Sheet, x: number, y: number, pad = 3): PlacedView | null {
  let best: PlacedView | null = null, bd = Infinity;
  for (const v of sheet.views) {
    const dx = Math.max(v.box.x0 - pad - x, 0, x - v.box.x1 - pad), dy = Math.max(v.box.y0 - pad - y, 0, y - v.box.y1 - pad);
    const d = Math.hypot(dx, dy);
    if (d === 0) {
      // the nearest centre wins where boxes overlap
      const c = Math.hypot(x - (v.box.x0 + v.box.x1) / 2, y - (v.box.y0 + v.box.y1) / 2);
      if (c < bd) [best, bd] = [v, c];
    }
  }
  return best;
}

/** Points worth snapping a cutting line or a detail circle to: centres, ends and middles of lines (view coordinates). */
export function snapPoints(v: DrawView): [number, number][] {
  const out: [number, number][] = [];
  for (const a of v.axes) if (a.kind === 'mark') out.push([a.x, a.y]);
  for (const p of [...v.visible, ...v.hidden]) {
    if (p.k === 'arc') out.push([p.cx, p.cy]);
    else if (p.k === 'line') out.push([p.x1, p.y1], [p.x2, p.y2], [(p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2]);
  }
  return out;
}

// ------------------------------------------------------------ the line work of a view

/** Margin of centre lines past their outline (ISO 128-24: a few millimetres). */
const AXIS_PAST = 3;

function viewInks(r: DrawingRegion, key: string, v: DrawView, put: (layer: Layer, p: Prim) => void, k: number, hatchSize: number) {
  // cut faces first, under the lines: ISO 128-50 at 45°, the spacing on the paper
  for (const c of v.cuts ?? []) {
    const st = hatchStyle(c.index, Math.min(4, Math.max(1.5, hatchSize / 15)) / k);
    const segs = hatch(c.loops, st.angle, st.spacing);
    for (let i = 0; i + 3 < segs.length; i += 4) put('HATCH', { k: 'line', x1: segs[i], y1: segs[i + 1], x2: segs[i + 2], y2: segs[i + 3] });
  }
  for (const p of v.visible) put('VISIBLE', p);
  if (r.hidden) for (const p of v.hidden) put('HIDDEN', p);
  if (r.tangent !== false) for (const p of v.tangent) put('TANGENT', p);
  for (const p of v.thin) put('THIN', p);
  if (r.noCentres?.includes(key)) return;
  const m = AXIS_PAST / k;
  for (const a of v.axes) {
    if (a.kind === 'mark') {
      put('CENTER', { k: 'line', x1: a.x - a.r - m, y1: a.y, x2: a.x + a.r + m, y2: a.y });
      put('CENTER', { k: 'line', x1: a.x, y1: a.y - a.r - m, x2: a.x, y2: a.y + a.r + m });
    } else {
      const l = Math.hypot(a.x2 - a.x1, a.y2 - a.y1) || 1, ux = (a.x2 - a.x1) / l, uy = (a.y2 - a.y1) / l;
      put('CENTER', { k: 'line', x1: a.x1 - ux * m, y1: a.y1 - uy * m, x2: a.x2 + ux * m, y2: a.y2 + uy * m });
    }
  }
}

function drawView(sheet: Sheet, r: DrawingRegion, pv: PlacedView) {
  const size = Math.min(pv.box.x1 - pv.box.x0, pv.box.y1 - pv.box.y0) || 40;
  viewInks(r, pv.key, pv.view, (layer, p) => sheet.inks.push({ layer, p: placePrim(p, pv.ox, pv.oy, pv.k) }), pv.k, size);
}

/** A detail: the parent's line work inside its circle (clipped exactly), enlarged, and the circle. */
function drawDetail(sheet: Sheet, r: DrawingRegion, pv: PlacedView, d: DrawingDetail) {
  const { x: cx, y: cy } = d.c;
  const put = (layer: Layer, p: Prim) => {
    for (const q of clipToCircle(p, cx, cy, d.r)) sheet.inks.push({ layer, p: placePrim(q, pv.ox, pv.oy, pv.k) });
  };
  // centre lines run 3 mm past their outline on the detail's paper
  viewInks(r, `det:${d.id}`, pv.view, put, pv.k, 2 * d.r * pv.k);
  const c = toPaper(pv, cx, cy);
  sheet.inks.push({ layer: 'THIN', p: { k: 'arc', cx: c[0], cy: c[1], r: d.r * pv.k, a0: 0, a1: 2 * Math.PI } });
}

/**
 * The cutting plane on its parent (ISO 128-44): a narrow long-dash dotted line across the
 * view, wide at its ends, arrows in the direction of viewing and the letter at each.
 */
function cuttingLine(sheet: Sheet, pv: PlacedView, s: DrawingSection, sg: number) {
  const g = sheet.group;
  const a = toPaper(pv, s.a.x, s.a.y), b = toPaper(pv, s.b.x, s.b.y);
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!(l > 0)) return;
  const ux = (b[0] - a[0]) / l, uy = (b[1] - a[1]) / l;
  const nx = sg * uy, ny = -sg * ux;
  // across the view's box and 4 mm on
  let t0 = -Infinity, t1 = Infinity;
  const { x0, y0, x1, y1 } = pv.box;
  for (const [o, d, lo, hi] of [[a[0], ux, x0, x1], [a[1], uy, y0, y1]]) {
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) return;
      continue;
    }
    const p = (lo - o) / d, q = (hi - o) / d;
    t0 = Math.max(t0, Math.min(p, q));
    t1 = Math.min(t1, Math.max(p, q));
  }
  if (!(t1 > t0)) return;
  t0 -= 4;
  t1 += 4;
  const at = (t: number): [number, number] => [a[0] + ux * t, a[1] + uy * t];
  const P = at(t0), Q = at(t1);
  sheet.inks.push({ layer: 'CENTER', p: { k: 'line', x1: P[0], y1: P[1], x2: Q[0], y2: Q[1] } });
  const end = 7;
  for (const [E, sgn] of [[P, 1], [Q, -1]] as const) {
    const F: [number, number] = [E[0] + ux * end * sgn, E[1] + uy * end * sgn];
    sheet.inks.push({ layer: 'VISIBLE', p: { k: 'line', x1: E[0], y1: E[1], x2: F[0], y2: F[1] } });
    // the arrow stands on the wide end, a little in from the outer end
    const B: [number, number] = [E[0] + ux * 2 * sgn, E[1] + uy * 2 * sgn];
    const T: [number, number] = [B[0] + nx * 8, B[1] + ny * 8];
    sheet.inks.push({ layer: 'DIM', p: { k: 'line', x1: B[0], y1: B[1], x2: T[0], y2: T[1] } });
    sheet.fills.push({ layer: 'DIM', pts: arrowHead(T[0], T[1], nx, ny, 4, 0.9) });
    // the letter just past the arrowhead, its middle on the arrow's line
    const off = 1.5 + 0.45 * g.label * (Math.abs(nx) + 0.75 * Math.abs(ny));
    sheet.labels.push({ layer: 'TEXT', x: T[0] + nx * off, y: T[1] + ny * off - g.label / 2, h: g.label, text: s.letter, anchor: 'middle' });
  }
}

/** A closed arrowhead with its tip at (x, y) pointing along (ux, uy). */
function arrowHead(x: number, y: number, ux: number, uy: number, len: number, half: number): number[] {
  const l = Math.hypot(ux, uy) || 1;
  ux /= l;
  uy /= l;
  return [x, y, x - ux * len - uy * half, y - uy * len + ux * half, x - ux * len + uy * half, y - uy * len - ux * half];
}

const fmt = (v: number) => `${+v.toFixed(v >= 100 ? 1 : 2)}`;

/** Overall sizes of a standard view (ISO 129-1: arrowheads of 15°, figures above the dimension line). */
function dimension(sheet: Sheet, pv: PlacedView, off: number) {
  const g = sheet.group, { x0, y0, x1, y1 } = pv.box, v = pv.view.box;
  const line = (ax: number, ay: number, bx: number, by: number) => sheet.inks.push({ layer: 'DIM', p: { k: 'line', x1: ax, y1: ay, x2: bx, y2: by } });
  const len = 2.5, half = len * Math.tan((15 * Math.PI) / 180);
  // width, below the view
  const yd = y0 - off;
  line(x0, y0 - 1, x0, yd - 2);
  line(x1, y0 - 1, x1, yd - 2);
  line(x0, yd, x1, yd);
  sheet.fills.push({ layer: 'DIM', pts: arrowHead(x0, yd, -1, 0, len, half) }, { layer: 'DIM', pts: arrowHead(x1, yd, 1, 0, len, half) });
  sheet.labels.push({ layer: 'DIM', x: (x0 + x1) / 2, y: yd + 1, h: g.dim, text: fmt(v.x1 - v.x0), anchor: 'middle' });
  // height, to the right
  const xd = x1 + off;
  line(x1 + 1, y0, xd + 2, y0);
  line(x1 + 1, y1, xd + 2, y1);
  line(xd, y0, xd, y1);
  sheet.fills.push({ layer: 'DIM', pts: arrowHead(xd, y0, 0, -1, len, half) }, { layer: 'DIM', pts: arrowHead(xd, y1, 0, 1, len, half) });
  sheet.labels.push({ layer: 'DIM', x: xd - 1, y: (y0 + y1) / 2, h: g.dim, text: fmt(v.y1 - v.y0), anchor: 'middle', rot: 90 });
}

// ------------------------------------------------------------ frame and title block

function frameAndTitle(sheet: Sheet, r: DrawingRegion, info: { unit: string; name: string; date: string }) {
  const { frame: f, title: t } = sheet;
  const line = (layer: Layer, ax: number, ay: number, bx: number, by: number) => sheet.inks.push({ layer, p: { k: 'line', x1: ax, y1: ay, x2: bx, y2: by } });
  const rect = (layer: Layer, x: number, y: number, w: number, h: number) => {
    line(layer, x, y, x + w, y);
    line(layer, x + w, y, x + w, y + h);
    line(layer, x + w, y + h, x, y + h);
    line(layer, x, y + h, x, y);
  };
  rect('BORDER', f.x, f.y, f.w, f.h);
  line('BORDER', t.x, t.y, t.x, t.y + t.h);
  line('BORDER', t.x, t.y + t.h, t.x + t.w, t.y + t.h);
  // field name, value, x and row from the top, width
  const cells: [string, string, number, number, number][] = [
    ['Title', r.title?.trim() || info.name, 0, 0, 110],
    ['Part no.', r.partNo ?? '', 110, 0, 70],
    ['Material', r.material ?? '', 0, 1, 70],
    ['Scale', scaleText(sheet.scale), 70, 1, 25],
    ['Units', info.unit, 95, 1, 15],
    ['Drawn', r.drawnBy ?? '', 0, 2, 70],
    ['Date', r.date?.trim() || info.date, 70, 2, 40],
  ];
  const rowH = t.h / 3;
  for (const [label, value, x, row, w] of cells) {
    const y = t.y + t.h - (row + 1) * rowH;
    rect('THIN', t.x + x, y, w, rowH);
    sheet.labels.push({ layer: 'TEXT', x: t.x + x + 1.5, y: y + rowH - 3.2, h: 1.6, text: label, anchor: 'start', faint: true });
    if (value) sheet.labels.push({ layer: 'TEXT', x: t.x + x + 1.5, y: y + 2.2, h: label === 'Title' ? 3.5 : 2.5, text: value, anchor: 'start', bold: label === 'Title' });
  }
  projectionSymbol(sheet, t.x + 110, t.y, 70, 2 * rowH, r.projection === 'first');
}

/** ISO 5456-2 projection symbol: a truncated cone seen from the side and from its small end. */
function projectionSymbol(sheet: Sheet, x: number, y: number, w: number, h: number, first: boolean) {
  const line = (layer: Layer, ax: number, ay: number, bx: number, by: number) => sheet.inks.push({ layer, p: { k: 'line', x1: ax, y1: ay, x2: bx, y2: by } });
  sheet.labels.push({ layer: 'TEXT', x: x + 1.5, y: y + h - 3.2, h: 1.6, text: first ? 'First angle projection' : 'Third angle projection', anchor: 'start', faint: true });
  const cy = y + h / 2 - 1.5;
  const cone = first ? x + w / 2 - 14 : x + w / 2 + 4, end = first ? x + w / 2 + 10 : x + w / 2 - 8;
  // the cone's small end on the left in both: first angle draws its end view right of it, third left
  line('THIN', cone, cy - 3, cone + 9, cy - 5);
  line('THIN', cone + 9, cy - 5, cone + 9, cy + 5);
  line('THIN', cone + 9, cy + 5, cone, cy + 3);
  line('THIN', cone, cy + 3, cone, cy - 3);
  for (const rr of [5, 3]) sheet.inks.push({ layer: 'THIN', p: { k: 'arc', cx: end, cy, r: rr, a0: 0, a1: 2 * Math.PI } });
  line('CENTER', Math.min(cone, end - 5) - 2, cy, Math.max(cone + 9, end + 5) + 2, cy);
  line('CENTER', end, cy - 7, end, cy + 7);
}

// ------------------------------------------------------------ paths

/** SVG path data of a primitive on a sheet H high (SVG's y runs down). */
export function primPath(p: Prim, H: number): string {
  const f = (v: number) => (Math.round(v * 1000) / 1000).toString();
  const X = (x: number) => f(x), Y = (y: number) => f(H - y);
  switch (p.k) {
    case 'line':
      return `M${X(p.x1)} ${Y(p.y1)}L${X(p.x2)} ${Y(p.y2)}`;
    case 'poly': {
      let d = '';
      for (let i = 0; i + 1 < p.pts.length; i += 2) d += `${i ? 'L' : 'M'}${X(p.pts[i])} ${Y(p.pts[i + 1])}`;
      return d;
    }
    case 'arc':
    case 'ellipse': {
      // counter-clockwise on the paper is sweep 0 once y is turned down; halves for a whole turn
      const span = p.k === 'arc' ? p.a1 - p.a0 : p.t1 - p.t0;
      const rx = p.k === 'arc' ? p.r : p.rx, ry = p.k === 'arc' ? p.r : p.ry, rot = p.k === 'arc' ? 0 : (-p.rot * 180) / Math.PI;
      const parts = span > Math.PI * 1.999 ? 2 : 1;
      let d = '';
      for (let i = 0; i < parts; i++) {
        const s0 = i / parts, s1 = (i + 1) / parts;
        const [ax, ay] = primAt(p, s0), [bx, by] = primAt(p, s1);
        if (!i) d += `M${X(ax)} ${Y(ay)}`;
        d += `A${f(rx)} ${f(ry)} ${f(rot)} ${span / parts > Math.PI ? 1 : 0} 0 ${X(bx)} ${Y(by)}`;
      }
      return d;
    }
  }
}

/** A point on the paper of a view in 3-D: where the drawing's model point sits (for tests and tools). */
export function projectPoint(spec: ViewSpec, q: Vec3): [number, number] {
  const { right, up } = viewAxes(spec);
  return [dot3(q, right), dot3(q, up)];
}

