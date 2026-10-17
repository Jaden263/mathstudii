// Annotations on the sheet: dimensions with their tolerances (ISO 129-1, ISO 286-1,
// ISO 14405-1), notes and hole callouts on leaders (ISO 128-22, ISO 15786), feature control
// frames (ISO 1101), datum feature symbols (ISO 5459), surface texture symbols (ISO 1302 /
// ISO 21920-1), centre marks and the balloons of the parts list (ISO 6433). Each pick is
// found again on the model as built and seen in its view, so values are the model's own
// and the text keeps its place beside its geometry; an annotation that lost its geometry is
// drawn where it was, flagged (the warning colour on the screen, `warn` in the files), and
// says why. Dimensions, tolerances and symbols go on the DIM layer, notes, callouts and
// balloons on TEXT.
import type { DrawingRegion } from '../model/types';
import {
  dimText, fmtSize, gdtLayout, holeCallout, holeCount, holeData, holeOfKey, GDT_INFO,
  type Annotation, type BomRow, type DimAnnotation, type DimText, type DrawPick, type Shape2, type XY,
} from './annotations';
import type { CadDesign, HoleFeature } from './design';
import {
  anchorOn, centreOf, curveDistance, dimensionValue, drawnEntities, drawnParts, followPoint, followText, measureAngle, measureLinear,
  pickOf, resolvePick, viewEntities, viewFrame, viewSnapPoints, type DrawnPart, type LinearMeasure, type Resolved, type ViewEntity, type ViewFrame,
} from './drawingRefs';
import { baseSpec, sectionRequest, toPaper, type BaseKey, type Layer, type PlacedView, type Sheet } from './drawingSheet';
import { circled, dot, gdtSymbol, lineWidth, putText } from './drawingText';
import type { BuildResult } from './buildResult';

const { abs, atan2, cos, sin, hypot, max, min, PI } = Math;

/** What the annotations need of the part beyond the sheet. */
export interface AnnotationContext {
  unit: string;
  /** The drawn occurrences with their named topology; null while no build is there (the annotations are drawn as they were). */
  parts: DrawnPart[] | null;
  design?: CadDesign;
  /** Evaluated parameters of the features (hole callouts). */
  params?: Record<string, Record<string, number>>;
  bom?: BomRow[];
}

/** An annotation as placed on the sheet. */
export interface PlacedAnnotation {
  id: string;
  kind: Annotation['kind'];
  view: string;
  /** Why it lost its geometry (it is drawn where it was, flagged). */
  lost?: string;
  /** A dimension's measured value (part units, angles in radians). */
  value?: number;
  /** What it reads (a dimension, a callout, a balloon's item). */
  text?: string;
  /** A tolerance class not in the tables, a hole not made by a hole feature. */
  error?: string;
  /** Where its text or symbol sits on the paper: what dragging moves. */
  handle?: XY;
  /** Its position (`text` or `at`) as the geometry now has it, view coordinates. */
  pos?: XY;
  /** Its picks' geometry now (a, b, or the leader's as a), where they were found. */
  now?: { a?: Shape2; b?: Shape2 };
  /** Placed by the automatic dimensioning (not stored). */
  auto?: boolean;
}

// ------------------------------------------------------------ the views' geometry

/** The axes of a placed view: a detail's are its parent's. */
export function frameOfView(r: DrawingRegion, key: string): ViewFrame | null {
  if (key.startsWith('det:')) {
    const d = r.details?.find((q) => `det:${q.id}` === key);
    return d && !d.view.startsWith('det:') ? frameOfView(r, d.view) : null;
  }
  if (key.startsWith('sec:')) {
    const s = r.sections?.find((q) => `sec:${q.id}` === key);
    return s ? viewFrame(sectionRequest(r, s)) : null;
  }
  return viewFrame(baseSpec(key as BaseKey, r.projection));
}

/** What a placed view offers to pick: the model entities it draws, and the points of its line work. */
export interface ViewPicks {
  frame: ViewFrame;
  ents: ViewEntity[];
  snaps: XY[];
}

/** Picks worked out per view's line work and build (dragging redraws the sheet often). */
const pickCache = new WeakMap<object, WeakMap<object, Map<string, ViewPicks | null>>>();
const NO_PARTS = {};

/** The entities of a placed view (a detail's within its circle). */
export function viewPicks(r: DrawingRegion, pv: PlacedView, parts: DrawnPart[] | null): ViewPicks | null {
  const frame = frameOfView(r, pv.key);
  if (!frame) return null;
  const det = pv.kind === 'detail' ? r.details?.find((q) => `det:${q.id}` === pv.key) : undefined;
  const key = JSON.stringify([frame, r.hidden, det?.c, det?.r]);
  let byParts = pickCache.get(pv.view);
  if (!byParts) pickCache.set(pv.view, (byParts = new WeakMap()));
  let m = byParts.get(parts ?? NO_PARTS);
  if (!m) byParts.set(parts ?? NO_PARTS, (m = new Map()));
  if (!m.has(key)) m.set(key, computePicks(r, pv, parts, frame, det));
  return m.get(key)!;
}

function computePicks(r: DrawingRegion, pv: PlacedView, parts: DrawnPart[] | null, frame: ViewFrame, d: { c: { x: number; y: number }; r: number } | undefined): ViewPicks {
  const hidden = r.hidden && pv.key !== 'iso' && pv.kind !== 'section';
  let ents = parts ? drawnEntities(viewEntities(parts, frame), pv.view, hidden) : [];
  let snaps = viewSnapPoints(pv.view, hidden);
  if (d) {
    ents = ents.filter((e) => curveDistance(e.shape, d.c.x, d.c.y) <= d.r);
    snaps = snaps.filter(([x, y]) => hypot(x - d.c.x, y - d.c.y) <= d.r);
  }
  return { frame, ents, snaps };
}

/** The drawn parts of a build, for the annotations (null without topology). */
export const annotationParts = (build: BuildResult | null | undefined, design: CadDesign | undefined): DrawnPart[] | null =>
  build && design ? drawnParts(build, design) : null;

// ------------------------------------------------------------ drawing

type V2 = XY;
const add = (a: V2, b: V2, k = 1): V2 => [a[0] + b[0] * k, a[1] + b[1] * k];
const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const dotp = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
const unitv = (a: V2): V2 => {
  const l = hypot(a[0], a[1]);
  return l > 1e-12 ? [a[0] / l, a[1] / l] : [1, 0];
};
const perp = (a: V2): V2 => [-a[1], a[0]];
const deg = (a: number) => (a * 180) / PI;

/** Angle of text along a direction, turned so it reads from below or from the right (ISO 129-1 method 1). */
function readable(u: V2): number {
  let a = atan2(u[1], u[0]);
  if (a > PI / 2 + 1e-9) a -= PI;
  if (a <= -PI / 2 + 1e-9) a += PI;
  return a;
}

/** The next smaller ISO 3098 height (deviations stacked after a size). */
const smaller = (h: number) => (h >= 7 ? 5 : h >= 5 ? 3.5 : h >= 3.5 ? 2.5 : 1.8);

/** Line work of one annotation, flagged when it lost its geometry. */
class Pen {
  readonly own: { owner: string; warn?: boolean };
  /** Arrowheads: closed, filled, 15° either side (ISO 129-1), 2.5 mm long beside 3.5 mm figures. */
  readonly al: number;
  constructor(readonly sheet: Sheet, owner: string, warn: boolean, readonly h: number) {
    this.own = warn ? { owner, warn } : { owner };
    this.al = (h * 5) / 7;
  }
  line(layer: Layer, a: V2, b: V2) {
    if (hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) return;
    this.sheet.inks.push({ layer, p: { k: 'line', x1: a[0], y1: a[1], x2: b[0], y2: b[1] }, ...this.own });
  }
  arc(layer: Layer, c: V2, r: number, a0: number, a1: number) {
    this.sheet.inks.push({ layer, p: { k: 'arc', cx: c[0], cy: c[1], r, a0, a1 }, ...this.own });
  }
  rect(layer: Layer, x: number, y: number, w: number, h: number) {
    this.line(layer, [x, y], [x + w, y]);
    this.line(layer, [x + w, y], [x + w, y + h]);
    this.line(layer, [x + w, y + h], [x, y + h]);
    this.line(layer, [x, y + h], [x, y]);
  }
  /** An arrowhead with its tip at `tip`, pointing along `d`. */
  arrow(tip: V2, d: V2, layer: Layer = 'DIM') {
    const u = unitv(d), n = perp(u), half = this.al * Math.tan((15 * PI) / 180);
    const b = add(tip, u, -this.al);
    this.sheet.fills.push({ layer, pts: [tip[0], tip[1], b[0] + n[0] * half, b[1] + n[1] * half, b[0] - n[0] * half, b[1] - n[1] * half], ...this.own });
  }
  dot(p: V2, layer: Layer = 'DIM') {
    dot(this.sheet, p[0], p[1], 0.25 * this.h, layer, this.own);
  }
  text(layer: Layer, x: number, y: number, s: string, o: { h?: number; anchor?: 'start' | 'middle' | 'end'; rot?: number } = {}): number {
    return putText(this.sheet, s, x, y, o.h ?? this.h, { layer, anchor: o.anchor ?? 'start', rot: o.rot, ...this.own });
  }
}

/** Gap between a feature and its extension line, and how far that runs past the dimension line (ISO 129-1). */
const GAP = 1, OVER = 2;

/** Where a dimension's text sits: its baseline's middle, its direction and size, for frames placed under it. */
interface TextBox {
  c: V2;
  rot: number;
  w: number;
  h: number;
}

/**
 * The text of a dimension along a direction: the size, its deviations or limits stacked in
 * the next smaller height, what closes it; framed when theoretically exact. (x, y) is the
 * baseline's middle; returns the width and how far the stack reaches under the baseline.
 */
function dimLabel(pen: Pen, t: DimText, at: V2, rot: number, basic: boolean, anchor: 'start' | 'middle' | 'end' = 'middle'): { w: number } {
  const h = pen.h, hs = smaller(h);
  const wm = lineWidth(t.main, h), ws = t.stack ? max(lineWidth(t.stack[0], hs), lineWidth(t.stack[1], hs)) : 0, wt = t.tail ? lineWidth(t.tail, h) : 0;
  const g1 = t.stack && t.main ? 0.25 * h : 0, g2 = t.stack && t.tail ? 0.1 * h : 0;
  const W = wm + g1 + ws + g2 + wt;
  const c = cos(rot), s = sin(rot);
  const P = (u: number, v: number): V2 => [at[0] + u * c - v * s, at[1] + u * s + v * c];
  const u0 = anchor === 'middle' ? -W / 2 : anchor === 'end' ? -W : 0;
  const r = deg(rot);
  if (t.main) pen.text('DIM', ...P(u0, 0), t.main, { rot: r });
  if (t.stack) {
    // the two values centred on the size's middle height
    const span = 2 * hs + 0.3 * hs, low = h / 2 - span / 2;
    pen.text('DIM', ...P(u0 + wm + g1, low + hs + 0.3 * hs), t.stack[0], { h: hs, rot: r });
    pen.text('DIM', ...P(u0 + wm + g1, low), t.stack[1], { h: hs, rot: r });
  }
  if (t.tail) pen.text('DIM', ...P(u0 + wm + g1 + ws + g2, 0), t.tail, { rot: r });
  if (basic) {
    const p = 0.3 * h, x0 = u0 - p, x1 = u0 + W + p, y0 = -p, y1 = h + p;
    const q = [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
    for (let i = 0; i < 4; i++) pen.line('DIM', q[i], q[(i + 1) % 4]);
  }
  return { w: W };
}

/** How high the text stands off its dimension line: clear of the line, and of the stack's lower value. */
const standOff = (t: DimText, h: number) => GAP + (t.stack ? max(0, (2.3 * smaller(h)) / 2 - h / 2) : 0);

/** A linear dimension: extension lines, the dimension line through the text, arrowheads in or out, the text above. */
function drawLinear(pen: Pen, pv: PlacedView, m: LinearMeasure, T: V2, t: DimText, basic: boolean): TextBox {
  const P1 = toPaper(pv, ...m.p1), P2 = toPaper(pv, ...m.p2), Tp = toPaper(pv, ...T);
  const U = m.u, N = perp(U);
  const s1 = dotp(sub(Tp, P1), N), s2 = dotp(sub(Tp, P2), N);
  let D1 = add(P1, N, s1), D2 = add(P2, N, s2);
  for (const [P, s] of [[P1, s1], [P2, s2]] as const) {
    if (abs(s) <= GAP + 0.2) continue;
    const g = Math.sign(s);
    pen.line('DIM', add(P, N, g * GAP), add(P, N, s + g * OVER));
  }
  if (dotp(sub(D2, D1), U) < 0) [D1, D2] = [D2, D1];
  const L = hypot(D2[0] - D1[0], D2[1] - D1[1]);
  const rot = readable(U), R: V2 = [cos(rot), sin(rot)], up = perp(R);
  const W = dimWidth(t, pen.h);
  const along = dotp(sub(Tp, D1), U);
  // the dimension line runs under the text wherever the text was put
  const lo = min(0, along - W / 2 - 0.5), hi = max(L, along + W / 2 + 0.5);
  const inside = L >= 2 * pen.al + 1.5;
  if (inside) {
    pen.line('DIM', add(D1, U, lo), add(D1, U, hi));
    pen.arrow(D1, [-U[0], -U[1]]);
    pen.arrow(D2, U);
  } else {
    // too short for arrows inside: from outside, pointing in
    pen.line('DIM', add(D1, U, min(lo, -2 * pen.al)), add(D1, U, max(hi, L + 2 * pen.al)));
    pen.arrow(D1, U);
    pen.arrow(D2, [-U[0], -U[1]]);
  }
  const base = add(add(D1, U, along), up, standOff(t, pen.h));
  dimLabel(pen, t, base, rot, basic);
  return { c: base, rot, w: W, h: pen.h };
}

const dimWidth = (t: DimText, h: number) => {
  const hs = smaller(h);
  return lineWidth(t.main, h) + (t.stack ? (t.main ? 0.25 * h : 0) + max(lineWidth(t.stack[0], hs), lineWidth(t.stack[1], hs)) : 0) + (t.tail ? (t.stack ? 0.1 * h : 0) + lineWidth(t.tail, h) : 0);
};

/**
 * A radius or diameter of a circle or arc: through the centre, the arrowheads inside on
 * the circle; with the text outside, the line runs on to a short horizontal shoulder
 * under it (ISO 129-1).
 */
function drawRound(pen: Pen, pv: PlacedView, s: Extract<Shape2, { k: 'circle' }>, type: 'radius' | 'diameter', T: V2, t: DimText, basic: boolean): TextBox {
  const C = toPaper(pv, s.cx, s.cy), R = s.r * pv.k, Tp = toPaper(pv, ...T);
  // on an arc, the line meets the arc
  const a = anchorOn(s, T);
  const d = unitv(sub(toPaper(pv, ...a.at), C));
  const A1 = add(C, d, R), A2 = add(C, d, -R);
  const W = dimWidth(t, pen.h);
  const outside = hypot(Tp[0] - C[0], Tp[1] - C[1]) > R + 0.5;
  if (outside) {
    // the leader to the shoulder, which runs away from the circle under the text
    const S = add(C, d, max(R + pen.al + 1, dotp(sub(Tp, C), d)));
    const sx = d[0] >= -1e-9 ? 1 : -1;
    pen.line('DIM', type === 'diameter' ? A2 : C, S);
    pen.line('DIM', S, [S[0] + sx * (W + 1), S[1]]);
    pen.arrow(A1, d);
    if (type === 'diameter') pen.arrow(A2, [-d[0], -d[1]]);
    const base: V2 = [S[0] + sx * (W / 2 + 0.5), S[1] + standOff(t, pen.h)];
    dimLabel(pen, t, base, 0, basic);
    return { c: base, rot: 0, w: W, h: pen.h };
  }
  pen.line('DIM', type === 'diameter' ? A2 : C, A1);
  pen.arrow(A1, d);
  if (type === 'diameter') pen.arrow(A2, [-d[0], -d[1]]);
  const rot = readable(d), up = perp([cos(rot), sin(rot)]);
  const base = add(add(C, d, dotp(sub(Tp, C), d)), up, standOff(t, pen.h));
  dimLabel(pen, t, base, rot, basic);
  return { c: base, rot, w: W, h: pen.h };
}

/** An arc length: a dimension arc concentric with the edge, extension lines along the radii, the arc symbol before the value. */
function drawArcLength(pen: Pen, pv: PlacedView, s: Extract<Shape2, { k: 'circle' }>, T: V2, t: DimText, basic: boolean): TextBox {
  const C = toPaper(pv, s.cx, s.cy), R = s.r * pv.k, Tp = toPaper(pv, ...T);
  const Rd = max(R + 2 * GAP, hypot(Tp[0] - C[0], Tp[1] - C[1]));
  const e = (a: number): V2 => [cos(a), sin(a)];
  for (const a of [s.a0, s.a1]) pen.line('DIM', add(C, e(a), R + GAP), add(C, e(a), Rd + OVER));
  pen.arc('DIM', C, Rd, s.a0, s.a1);
  pen.arrow(add(C, e(s.a0), Rd), [sin(s.a0), -cos(s.a0)]);
  pen.arrow(add(C, e(s.a1), Rd), [-sin(s.a1), cos(s.a1)]);
  const mid = (s.a0 + s.a1) / 2, rot = readable(perp(e(mid)));
  const up = perp([cos(rot), sin(rot)]);
  // above the arc, read along it
  const base = add(add(C, e(mid), Rd), up, dotp(up, e(mid)) >= 0 ? standOff(t, pen.h) : -standOff(t, pen.h) - pen.h);
  dimLabel(pen, t, base, rot, basic);
  return { c: base, rot, w: dimWidth(t, pen.h), h: pen.h };
}

/** An angle between two lines: an arc about their crossing through the text, extension lines out to it, the figure upright. */
function drawAngle(pen: Pen, pv: PlacedView, a: Extract<Shape2, { k: 'line' }>, b: Extract<Shape2, { k: 'line' }>, m: { V: XY; r1: XY; r2: XY; value: number; flip?: boolean }, T: V2, t: DimText, basic: boolean): TextBox {
  const V = toPaper(pv, ...m.V), Tp = toPaper(pv, ...T);
  const Rd = max(4 * pen.al, hypot(Tp[0] - V[0], Tp[1] - V[1]));
  const start = m.flip ? m.r2 : m.r1;
  const a1 = atan2(start[1], start[0]), a2 = a1 + m.value;
  // each line from its nearest end out (or in) to the arc
  for (const [ln, r] of [[a, m.r1], [b, m.r2]] as const) {
    const ts = [[ln.x1, ln.y1], [ln.x2, ln.y2]].map(([x, y]) => dotp(sub(toPaper(pv, x, y), V), r));
    const t0 = min(...ts), t1 = max(...ts);
    if (Rd > t1 + GAP) pen.line('DIM', add(V, r, max(0, t1) + GAP), add(V, r, Rd + OVER));
    else if (Rd < t0 - GAP) pen.line('DIM', add(V, r, t0 - GAP), add(V, r, Rd - OVER));
  }
  pen.arc('DIM', V, Rd, a1, a2);
  const e = (q: number): V2 => [cos(q), sin(q)];
  if (Rd * m.value >= 2 * pen.al + 1) {
    pen.arrow(add(V, e(a1), Rd), [sin(a1), -cos(a1)]);
    pen.arrow(add(V, e(a2), Rd), [-sin(a2), cos(a2)]);
  } else {
    pen.arrow(add(V, e(a1), Rd), [-sin(a1), cos(a1)]);
    pen.arrow(add(V, e(a2), Rd), [sin(a2), -cos(a2)]);
  }
  const mid = (a1 + a2) / 2, W = dimWidth(t, pen.h);
  // upright, just outside the arc's middle
  const reach = Rd + GAP + abs(cos(mid)) * (W / 2) + abs(sin(mid)) * (pen.h / 2);
  const c = add(V, e(mid), reach);
  const base: V2 = [c[0], c[1] - pen.h / 2];
  dimLabel(pen, t, base, 0, basic);
  return { c: base, rot: 0, w: W, h: pen.h };
}

// ------------------------------------------------------------ leaders

/** Where a leader starts at a block of text: the end of a short shoulder at the side facing its target. */
function shoulder(block: { x: number; y: number; w: number; h: number }, target: V2): { from: V2; end: V2 } {
  const right = target[0] > block.x + block.w / 2;
  const y = block.y + block.h / 2;
  const from: V2 = right ? [block.x + block.w + 1, y] : [block.x - 1, y];
  return { from, end: [from[0] + (right ? 2.5 : -2.5), y] };
}

/** A leader from a point to its target, ending in an arrowhead (on an outline) or a dot (on a part, ISO 6433). */
function leader(pen: Pen, from: V2, to: V2, end: 'arrow' | 'dot', layer: Layer = 'DIM') {
  pen.line(layer, from, to);
  if (end === 'arrow') pen.arrow(to, sub(to, from), layer);
  else pen.dot(to, layer);
}

/** Lines of text one under the other, ISO 3098 spacing (10/7 h baseline to baseline); the first baseline from (x, y). */
function textBlock(pen: Pen, layer: Layer, x: number, y: number, lines: string[]): { x: number; y: number; w: number; h: number } {
  const step = (10 / 7) * pen.h;
  let w = 0;
  lines.forEach((l, i) => {
    w = max(w, pen.text(layer, x, y - i * step, l));
  });
  const bottom = y - (lines.length - 1) * step;
  return { x, y: bottom, w, h: y + pen.h - bottom };
}

// ------------------------------------------------------------ the sheet

/** Where an annotation's picks are now (or were), and whether any is lost. */
interface Picked {
  a: Resolved & { ok: true };
  b?: Resolved & { ok: true };
  lost?: string;
}

/**
 * Draw a drawing's annotations onto its sheet (with the automatic ones in `auto`); what
 * each became comes back, for the side panel and for picking them on the paper.
 */
export function annotateSheet(sheet: Sheet, r: DrawingRegion, ctx: AnnotationContext, auto: Annotation[] = []): PlacedAnnotation[] {
  const out: PlacedAnnotation[] = [];
  const picks = new Map<string, ViewPicks | null>();
  const picksOf = (pv: PlacedView) => {
    if (!picks.has(pv.key)) picks.set(pv.key, viewPicks(r, pv, ctx.parts));
    return picks.get(pv.key)!;
  };
  const h = sheet.group.dim;
  const boxes = new Map<string, TextBox & { D?: { end: V2; u: V2 } }>();
  const all = [...(r.annotations ?? []), ...auto];
  // dimensions first: frames and datums may sit on them
  const order = [...all].sort((p, q) => +(p.kind !== 'dim') - +(q.kind !== 'dim'));
  for (const a of order) {
    const placed: PlacedAnnotation = { id: a.id, kind: a.kind, view: a.view, ...(a.id.startsWith('auto:') ? { auto: true } : {}) };
    out.push(placed);
    const pv = sheet.views.find((v) => v.key === a.view);
    if (!pv) {
      placed.lost = 'its view is not on the sheet';
      continue;
    }
    const vp = picksOf(pv);
    const det = pv.kind === 'detail' ? r.details?.find((q) => `det:${q.id}` === pv.key) : undefined;
    // a pick found again, or where it was (flagged) when it is gone (or, on a detail, out of its circle)
    const find = (p: DrawPick): Resolved => {
      if (!ctx.parts || !vp) return { ok: true, shape: p.shape };
      const f = resolvePick(p, ctx.parts, vp.frame, vp.snaps);
      if (f.ok && det && curveDistance(f.shape, det.c.x, det.c.y) > det.r * (1 + 1e-9)) return { ok: false, why: `it is no longer inside detail ${det.letter}’s circle` };
      return f;
    };
    // its distances from its geometry stay the same on the paper when the view's scale changes
    const ratio = a.k && a.k > 0 ? a.k / pv.k : 1;
    const resolve = (pa: DrawPick, pb?: DrawPick): Picked => {
      const ra = find(pa), rb = pb && find(pb);
      const lost = !ra.ok ? ra.why : rb && !rb.ok ? rb.why : undefined;
      return {
        a: ra.ok ? ra : { ok: true, shape: pa.shape },
        ...(pb ? { b: rb && rb.ok ? rb : { ok: true as const, shape: pb.shape } } : {}),
        ...(lost ? { lost } : {}),
      };
    };
    const fmt = (v: number) => fmtSize(v, ctx.unit, a.kind === 'dim' ? a.decimals ?? r.decimals : r.decimals);
    // tolerance zones and roughness values are written as given, never rounded to the drawing's decimals
    const exact = (v: number) => String(+v.toFixed(6)).replace('-', '−');
    switch (a.kind) {
      case 'dim': {
        const pk = resolve(a.a, a.b);
        const was = { a: a.a.shape, ...(a.b ? { b: a.b.shape } : {}) }, now = { a: pk.a.shape, ...(pk.b ? { b: pk.b.shape } : {}) };
        const T = followText(a, was, pk.lost ? was : now, ratio);
        const d: DimAnnotation = { ...a, text: T };
        const iso = pv.key === 'iso';
        let value = dimensionValue(d, pk.a, pk.b, iso);
        let lost = pk.lost;
        if (value === null && !lost) {
          lost = 'what it measured no longer makes this dimension';
          value = dimensionValue(a, { shape: a.a.shape }, a.b && { shape: a.b.shape });
        }
        const pen = new Pen(sheet, a.id, !!lost, h);
        const shown = value ?? NaN;
        const sym = a.type === 'diameter' || a.type === 'pitch' ? 'Ø' : a.type === 'radius' ? 'R' : a.type === 'arc' ? '⌒' : '';
        const prefix = [a.prefix?.trim(), sym].filter(Boolean).join(a.prefix?.trim() && sym ? ' ' : '');
        const t = a.type === 'angle'
          ? dimText(deg(shown), 'deg', { prefix, suffix: `°${a.suffix ?? ''}`, decimals: a.decimals, tol: a.tol?.kind === 'fit' ? undefined : a.tol, override: a.override, reference: a.reference })
          : dimText(shown, ctx.unit, { prefix, suffix: a.suffix, decimals: a.decimals ?? r.decimals, tol: a.tol, override: a.override, reference: a.reference });
        Object.assign(placed, { ...(lost ? { lost } : {}), ...(value !== null ? { value } : {}), text: [t.main, ...(t.stack ? [t.stack.join(' / ')] : []), t.tail ?? ''].join(' ').trim(), ...(t.error ? { error: t.error } : {}) });
        const g = lost ? was : now;
        let box: TextBox | null = null;
        let D: { end: V2; u: V2 } | undefined;
        if (a.type === 'linear' || (a.type === 'diameter' && g.a.k === 'cyl')) {
          const m = measureLinear(g.a, g.b, a.type === 'diameter' ? undefined : a.orient, T);
          if (m) {
            box = drawLinear(pen, pv, m, T, t, !!a.basic);
            const P2 = toPaper(pv, ...m.p2), N = perp(m.u), s = dotp(sub(toPaper(pv, ...T), P2), N);
            D = { end: add(P2, N, s), u: m.u };
          }
        } else if ((a.type === 'radius' || a.type === 'diameter') && g.a.k === 'circle') box = drawRound(pen, pv, g.a, a.type, T, t, !!a.basic);
        else if (a.type === 'arc' && g.a.k === 'circle') box = drawArcLength(pen, pv, g.a, T, t, !!a.basic);
        else if (a.type === 'angle' && g.a.k === 'line' && g.b?.k === 'line') {
          const m = measureAngle(g.a, g.b, T);
          if (m) box = drawAngle(pen, pv, g.a, g.b, m, T, t, !!a.basic);
        } else if (a.type === 'pitch') {
          const p = centreOf(g.a), c = g.b && centreOf(g.b);
          if (p && c) {
            const R = hypot(p[0] - c[0], p[1] - c[1]);
            pen.arc('CENTER', toPaper(pv, ...c), R * pv.k, 0, 2 * PI);
            box = drawRound(pen, pv, { k: 'circle', cx: c[0], cy: c[1], r: R, a0: 0, a1: 2 * PI }, 'diameter', T, t, !!a.basic);
          }
        }
        if (box) {
          boxes.set(a.id, { ...box, ...(D ? { D } : {}) });
          placed.handle = box.c;
        } else if (!placed.lost) placed.lost = 'what it measured no longer makes this dimension';
        placed.pos = T;
        if (!pk.lost) placed.now = now;
        break;
      }
      case 'note':
      case 'hole': {
        const pk = a.kind === 'hole' || a.leader ? resolve(a.kind === 'hole' ? a.a : a.leader!) : null;
        const src = a.kind === 'hole' ? a.a : a.leader;
        const at = pk && src ? followPoint(src.shape, pk.lost ? src.shape : pk.a.shape, a.at, ratio) : a.at;
        let lines: string[];
        if (a.kind === 'note') lines = a.text.split('\n');
        else {
          const c = calloutText(a.a, pk!, ctx, fmt, a.cls);
          if (c.error) placed.error = c.error;
          lines = (a.override?.trim() ? a.override.replace(/<>/g, c.text) : c.text).split('\n');
        }
        const pen = new Pen(sheet, a.id, !!pk?.lost, h);
        const P = toPaper(pv, ...at);
        const block = textBlock(pen, 'TEXT', P[0], P[1], lines);
        if (pk) {
          const target = toPaper(pv, ...anchorOn(pk.a.shape, at).at);
          const sh = shoulder(block, target);
          pen.line('TEXT', sh.from, sh.end);
          leader(pen, sh.end, target, 'arrow', 'TEXT');
        }
        Object.assign(placed, { handle: P, pos: at, text: lines.join('\n'), ...(pk?.lost ? { lost: pk.lost } : {}), ...(pk && !pk.lost ? { now: { a: pk.a.shape } } : {}) });
        break;
      }
      case 'gdt': {
        const host = a.dim ? boxes.get(a.dim) : undefined;
        const pk = !a.dim && a.leader ? resolve(a.leader) : null;
        const at = pk && a.leader ? followPoint(a.leader.shape, pk.lost ? a.leader.shape : pk.a.shape, a.at, ratio) : a.at;
        const lost = pk?.lost ?? (a.dim && !host ? 'the dimension it belongs to is gone' : undefined);
        const pen = new Pen(sheet, a.id, !!lost, h);
        const L = gdtLayout(a, h, exact);
        const W = L.widths.reduce((s, w) => s + w, 0);
        // under its dimension's figures, or where it was put
        let x0: number, y: number;
        if (host) {
          const c = add(host.c, perp([cos(host.rot), sin(host.rot)]), -(GAP + L.H / 2 + 0.5));
          [x0, y] = [c[0] - W / 2, c[1]];
        } else [x0, y] = toPaper(pv, ...at);
        drawFrame(pen, a, L, x0, y);
        if (pk) {
          const target = toPaper(pv, ...anchorOn(pk.a.shape, at).at);
          const from: V2 = target[0] < x0 ? [x0, y] : target[0] > x0 + W ? [x0 + W, y] : [x0 + L.H / 2, target[1] < y ? y - L.H / 2 : y + L.H / 2];
          leader(pen, from, target, 'arrow');
        }
        Object.assign(placed, { handle: [x0, y] as V2, pos: at, text: `${GDT_INFO[a.char].name} ${L.tolText}${a.mod ?? ''}${L.datumTexts.length ? ` | ${L.datumTexts.join(' | ')}` : ''}`, ...(lost ? { lost } : {}), ...(pk && !pk.lost ? { now: { a: pk.a.shape } } : {}) });
        if (GDT_INFO[a.char].datum === 'required' && !L.datumTexts.length) placed.error = `${GDT_INFO[a.char].name} needs a datum (ISO 1101)`;
        if (GDT_INFO[a.char].datum === 'none' && L.datumTexts.length) placed.error = `${GDT_INFO[a.char].name} is a form tolerance: it takes no datum (ISO 1101)`;
        break;
      }
      case 'datum': {
        const host = a.dim ? boxes.get(a.dim) : undefined;
        const pk = !host ? resolve(a.leader) : null;
        const at = pk ? followPoint(a.leader.shape, pk.lost ? a.leader.shape : pk.a.shape, a.at, ratio) : a.at;
        const lost = pk?.lost ?? (a.dim && !host ? 'the dimension it belongs to is gone' : undefined);
        const pen = new Pen(sheet, a.id, !!lost, h);
        const F = toPaper(pv, ...at), H = 2 * h;
        // the letter in a square frame (ISO 5459)
        pen.rect('DIM', F[0] - H / 2, F[1] - H / 2, H, H);
        pen.text('DIM', F[0], F[1] - h / 2, a.letter.trim() || '?', { anchor: 'middle' });
        // the filled triangle on the feature, or on the end of its dimension line
        let foot: V2, along: V2, out: V2;
        if (host?.D) {
          foot = add(host.D.end, host.D.u, pen.al + 0.8 * h);
          along = perp(host.D.u);
          out = host.D.u;
        } else {
          const an = anchorOn((pk?.a ?? { shape: a.leader.shape }).shape, at);
          foot = toPaper(pv, ...an.at);
          const s = (pk?.a ?? { shape: a.leader.shape }).shape;
          along = s.k === 'line' ? unitv([s.x2 - s.x1, s.y2 - s.y1]) : s.k === 'cyl' ? unitv([s.x2 - s.x1, s.y2 - s.y1]) : s.k === 'circle' ? perp(unitv(sub(foot, toPaper(pv, s.cx, s.cy)))) : [1, 0];
          out = perp(along);
          if (dotp(sub(F, foot), out) < 0) out = [-out[0], -out[1]];
        }
        const side = 0.8 * h, ht = side * 0.866;
        const apex = add(foot, out, ht);
        pen.sheet.fills.push({ layer: 'DIM', pts: [...add(foot, along, side / 2), ...add(foot, along, -side / 2), ...apex], ...pen.own });
        // the leader from the triangle to the nearer side of the frame
        const d = sub(apex, F);
        const edge: V2 = abs(d[0]) > abs(d[1]) ? [F[0] + Math.sign(d[0]) * H / 2, F[1]] : [F[0], F[1] + Math.sign(d[1]) * H / 2];
        pen.line('DIM', apex, edge);
        Object.assign(placed, { handle: F, pos: at, text: a.letter, ...(lost ? { lost } : {}), ...(pk && !pk.lost ? { now: { a: pk.a.shape } } : {}) });
        break;
      }
      case 'surface': {
        const pk = a.leader ? resolve(a.leader) : null;
        const at = pk && a.leader ? followPoint(a.leader.shape, pk.lost ? a.leader.shape : pk.a.shape, a.at, ratio) : a.at;
        const pen = new Pen(sheet, a.id, !!pk?.lost, h);
        const S = toPaper(pv, ...at);
        let tip = S;
        if (pk) {
          const target = toPaper(pv, ...anchorOn(pk.a.shape, at).at);
          if (hypot(target[0] - S[0], target[1] - S[1]) > 2) {
            // on a leader: the symbol stands on a short reference line at its end
            pen.line('DIM', [S[0] - 1, S[1]], [S[0] + 0.9 * h * 3, S[1]]);
            leader(pen, S, target, 'arrow');
          } else tip = target;
        }
        surfaceSymbol(pen, a, tip, exact);
        Object.assign(placed, { handle: S, pos: at, text: `${a.param} ${exact(a.value)}`, ...(pk?.lost ? { lost: pk.lost } : {}), ...(pk && !pk.lost ? { now: { a: pk.a.shape } } : {}) });
        break;
      }
      case 'centre': {
        if (a.hide) {
          placed.handle = toPaper(pv, ...(centreOf(a.a.shape) ?? [0, 0]));
          break;
        }
        const pk = resolve(a.a);
        const s = pk.a.shape;
        const pen = new Pen(sheet, a.id, !!pk.lost, h);
        if (s.k === 'circle') {
          const C = toPaper(pv, s.cx, s.cy), R = s.r * pv.k + (a.ext ?? 3);
          pen.line('CENTER', [C[0] - R, C[1]], [C[0] + R, C[1]]);
          pen.line('CENTER', [C[0], C[1] - R], [C[0], C[1] + R]);
          placed.handle = C;
        } else if (!pk.lost) placed.lost = 'a centre mark needs a circle or an arc';
        if (pk.lost) placed.lost = pk.lost;
        break;
      }
      case 'balloon': {
        const pk = resolve(a.a);
        const at = followPoint(a.a.shape, pk.lost ? a.a.shape : pk.a.shape, a.at, ratio);
        const comp = ctx.parts?.find((p) => p.occ === a.occ)?.component ?? ctx.design?.occurrences.find((o) => o.id === a.occ)?.component;
        const row = ctx.bom?.find((b) => b.component === comp);
        const lost = pk.lost ?? (row ? undefined : 'its part is not in the parts list');
        const pen = new Pen(sheet, a.id, !!lost, h);
        const hb = sheet.group.label, rb = 0.9 * hb + 0.5;
        const C = toPaper(pv, ...at), target = toPaper(pv, ...anchorOn(pk.a.shape, at).at);
        pen.arc('TEXT', C, rb, 0, 2 * PI);
        pen.text('TEXT', C[0], C[1] - hb / 2, row ? String(row.item) : '?', { h: hb, anchor: 'middle' });
        const dir = unitv(sub(target, C));
        leader(pen, add(C, dir, rb), target, 'dot', 'TEXT');
        Object.assign(placed, { handle: C, pos: at, text: row ? `Item ${row.item}: ${row.name}` : '?', ...(lost ? { lost } : {}), ...(!pk.lost ? { now: { a: pk.a.shape } } : {}) });
        break;
      }
    }
  }
  return out;
}

/** A feature control frame (ISO 1101 8.1): compartments 2h high, the symbol, the tolerance with Ø and modifier, the datums. */
function drawFrame(pen: Pen, a: Extract<Annotation, { kind: 'gdt' }>, L: ReturnType<typeof gdtLayout>, x0: number, y: number) {
  const h = pen.h, H = L.H, W = L.widths.reduce((s, w) => s + w, 0);
  pen.rect('DIM', x0, y - H / 2, W, H);
  let x = x0;
  L.widths.forEach((w, i) => {
    if (i) pen.line('DIM', [x, y - H / 2], [x, y + H / 2]);
    x += w;
  });
  gdtSymbol(pen.sheet, a.char, x0 + H / 2, y, h, 'DIM', pen.own);
  const tx = x0 + H + h / 2;
  const tw = pen.text('DIM', tx, y - h / 2, L.tolText);
  if (a.mod) circled(pen.sheet, a.mod, tx + tw + 0.3 * h + 0.75 * h, y, h, 'DIM', pen.own);
  x = x0 + L.widths[0] + L.widths[1];
  (a.datums ?? []).filter((d) => d.letter.trim()).slice(0, 3).forEach((d, i) => {
    const w = L.widths[2 + i];
    const lw = lineWidth(L.datumTexts[i], h), mw = d.mod ? 1.8 * h : 0;
    const start = x + (w - lw - mw) / 2;
    pen.text('DIM', start, y - h / 2, L.datumTexts[i]);
    if (d.mod) circled(pen.sheet, d.mod, start + lw + 0.3 * h + 0.75 * h, y, h, 'DIM', pen.own);
    x += w;
  });
}

/**
 * A surface texture symbol (ISO 1302, ISO 21920-1) with its point at `tip`: the legs at 60°
 * (1.4 h and 3 h high), the bar of a material-removing process or the circle of one that
 * removes none, the line over the requirement ("Ra 1.6"), the method above it and the lay
 * beside the long leg.
 */
function surfaceSymbol(pen: Pen, a: Extract<Annotation, { kind: 'surface' }>, tip: V2, fmt: (v: number) => string) {
  const h = pen.h, H1 = 1.4 * h, H2 = 3 * h, c60 = cos(PI / 3), s60 = sin(PI / 3);
  const short = add(tip, [-c60, s60], H1 / s60), long = add(tip, [c60, s60], H2 / s60);
  pen.line('DIM', tip, short);
  pen.line('DIM', tip, long);
  if (a.process === 'removal') pen.line('DIM', short, add(tip, [c60, s60], H1 / s60));
  if (a.process === 'noremoval') pen.arc('DIM', add(tip, [0, 1], (2 * H1) / 3), H1 / 3, 0, 2 * PI);
  const req = `${a.param} ${fmt(a.value)}`;
  const w = lineWidth(req, h);
  const method = a.method?.trim() ?? '';
  const top = max(w, method ? lineWidth(method, h) : 0) + 0.6 * h;
  pen.line('DIM', long, add(long, [1, 0], top));
  // the requirement under the line (position a), the method over it (c), the lay beside the long leg (d)
  pen.text('DIM', long[0] + 0.3 * h, long[1] - h - 0.5, req);
  if (method) pen.text('DIM', long[0] + 0.3 * h, long[1] + 0.6, method);
  if (a.lay) pen.text('DIM', tip[0] + H1 / Math.tan(PI / 3) + 0.4 * h, tip[1] + 0.25 * h, a.lay);
}

/**
 * A hole callout from the hole feature that made the picked hole: how many the part has,
 * the drill or thread, counterbore or countersink and depths. A round hole made otherwise
 * (an extruded cut) gives its diameter alone.
 */
function calloutText(p: DrawPick, pk: Picked, ctx: AnnotationContext, fmt: (v: number) => string, cls?: string): { text: string; error?: string } {
  const s = pk.a.shape;
  const r = s.k === 'circle' || s.k === 'cyl' ? s.r : undefined;
  const plain = r !== undefined ? `Ø${fmt(2 * r)}` : '?';
  const part = ctx.parts?.find((q) => q.occ === p.occ);
  const keys = pk.a.e?.faces ?? [];
  const hole = keys.map(holeOfKey).find(Boolean);
  if (!hole || !part || !ctx.design) return { text: plain, ...(part && !hole ? { error: 'not made by a hole feature: its diameter alone' } : {}) };
  const comp = ctx.design.components.find((c) => c.id === part.component);
  const item = comp?.items.find((i) => i.id === hole.feature);
  const data = item?.kind === 'hole' ? holeData(item as HoleFeature, ctx.params?.[item.id]) : null;
  if (!data) return { text: plain, error: 'its hole feature did not build' };
  const n = holeCount(hole.feature, part.bodies.flatMap((b) => b.faces.map((f) => f.key)));
  return { text: holeCallout(data, n, fmt, cls ?? '6H') };
}

// ------------------------------------------------------------ picking them on the paper

/** The annotation drawn nearest a point of the paper (sheet mm), within `tol`: its lines, symbols or text. */
export function annotationAt(sheet: Sheet, x: number, y: number, tol = 1.5): string | null {
  let best: string | null = null, bd = tol;
  const seg = (ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    return hypot(x - ax - t * dx, y - ay - t * dy);
  };
  for (const i of sheet.inks) {
    if (!i.owner) continue;
    const p = i.p;
    let d = Infinity;
    if (p.k === 'line') d = seg(p.x1, p.y1, p.x2, p.y2);
    else if (p.k === 'arc') {
      const a = atan2(y - p.cy, x - p.cx), span = p.a1 - p.a0;
      if (span >= 2 * PI - 1e-9 || ((((a - p.a0) % (2 * PI)) + 2 * PI) % (2 * PI)) <= span) d = abs(hypot(x - p.cx, y - p.cy) - p.r);
    }
    if (d < bd) [best, bd] = [i.owner, d];
  }
  for (const l of sheet.labels) {
    if (!l.owner) continue;
    const a = (-(l.rot ?? 0) * PI) / 180, dx = x - l.x, dy = y - l.y;
    const u = dx * cos(a) - dy * sin(a), v = dx * sin(a) + dy * cos(a);
    const w = l.w ?? lineWidth(l.text, l.h), u0 = l.anchor === 'middle' ? -w / 2 : l.anchor === 'end' ? -w : 0;
    if (u >= u0 - 0.5 && u <= u0 + w + 0.5 && v >= -0.4 * l.h && v <= 1.15 * l.h) return l.owner;
  }
  for (const f of sheet.fills) {
    if (!f.owner) continue;
    let cx = 0, cy = 0;
    const n = f.pts.length / 2;
    for (let i = 0; i < n; i++) [cx, cy] = [cx + f.pts[2 * i] / n, cy + f.pts[2 * i + 1] / n];
    const d = hypot(x - cx, y - cy) - 0.5;
    if (d < bd) [best, bd] = [f.owner, d];
  }
  return best;
}

// ------------------------------------------------------------ balloons for the parts list

/**
 * Balloons for every item of the parts list drawn in a view that has none there yet
 * (ISO 6433): each on the middle of an edge of its part's first occurrence, the edge
 * farthest out from the view's middle, the balloons in a column either side of the view
 * at least a balloon and a gap apart.
 */
export function autoBalloons(r: DrawingRegion, sheet: Sheet, parts: DrawnPart[], bom: BomRow[], viewKey: string, newId: () => string): Annotation[] {
  const pv = sheet.views.find((v) => v.key === viewKey);
  const vp = pv && viewPicks(r, pv, parts);
  if (!pv || !vp) return [];
  const have = new Set((r.annotations ?? []).flatMap((a) => (a.kind === 'balloon' && a.view === viewKey ? [parts.find((p) => p.occ === a.occ)?.component] : [])));
  const box = pv.view.box, mid: XY = [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2];
  const rb = (0.9 * sheet.group.label + 0.5) / pv.k, gap = 2 / pv.k, off = 12 / pv.k;
  const items: { row: BomRow; occ: string; e: ViewEntity; p: XY }[] = [];
  for (const row of bom) {
    if (have.has(row.component)) continue;
    const occ = parts.find((p) => p.component === row.component)?.occ;
    const lines = vp.ents.filter((e) => e.occ === occ && e.shape.k === 'line');
    if (!occ || !lines.length) continue;
    const at = (e: ViewEntity): XY => (e.shape.k === 'line' ? [(e.shape.x1 + e.shape.x2) / 2, (e.shape.y1 + e.shape.y2) / 2] : [0, 0]);
    const e = lines.reduce((b, q) => (hypot(at(q)[0] - mid[0], at(q)[1] - mid[1]) - 1e-9 * q.depth > hypot(at(b)[0] - mid[0], at(b)[1] - mid[1]) - 1e-9 * b.depth ? q : b));
    items.push({ row, occ, e, p: at(e) });
  }
  const out: Annotation[] = [];
  for (const side of [-1, 1]) {
    const col = items.filter((it) => (it.p[0] >= mid[0] ? 1 : -1) === side).sort((a, b) => b.p[1] - a.p[1]);
    let y = Infinity;
    for (const it of col) {
      y = min(y - 2 * rb - gap, it.p[1] + off / 2);
      const x = side > 0 ? box.x1 + off : box.x0 - off;
      out.push({ id: newId(), kind: 'balloon', view: viewKey, occ: it.occ, a: pickOfMid(it.e, parts), at: [x, y] });
    }
  }
  return out;
}

const pickOfMid = (e: ViewEntity, parts: DrawnPart[]): DrawPick => pickOf({ e, snap: 'mid', x: 0, y: 0 }, parts);
