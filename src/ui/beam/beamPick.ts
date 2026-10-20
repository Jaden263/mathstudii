// What the beam editor draws, as shapes in drawing coordinates, and what a click there
// picks: the whole visible glyph of a load (arrow shaft and head, the band of a line
// load with its arrows, outline and label, a moment's arc), supports, nodes and members.
// The glyphs are drawn from the same shapes, so what is seen is what is picked.
import type { BeamRegion } from '../../model/types';
import { loadPoint, type BeamData, type BeamLoad } from '../../beam/model';
import { toS, type P2, type Vp } from './beamGeom';

export interface ArrowShape {
  from: P2;
  /** Tip of the head. */
  to: P2;
  head: number;
}

export interface LabelShape {
  x: number;
  /** Baseline. */
  y: number;
  anchor: 'start' | 'end' | 'middle';
  text: string;
}

export type LoadShape =
  | {
    kind: 'line'; id: string;
    /** The band: start and end on the base line, their tops. */
    area: [P2, P2, P2, P2];
    arrows: ArrowShape[];
    /** Where the band starts and ends on its base line (above the member when stacked): the grips. */
    ends: [P2, P2];
    label: LabelShape;
  }
  | { kind: 'force'; id: string; arrow: ArrowShape; label: LabelShape }
  | { kind: 'moment'; id: string; at: P2; r: number; positive: boolean; label: LabelShape };

/** Height of a line load's band, and the gap above it to the next one stacked on it. */
export const LINE_H = 30;
export const STACK_GAP = 16;
/** Length of a point load's arrow. */
export const FORCE_L = 44;
export const MOMENT_R = 16;

const lerp = (a: P2, b: P2, t: number): P2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/**
 * The shape of a load on the drawing. `vals` are its evaluated values (they set the
 * direction of a negative load and the slope of a trapezoid); `stack` is how many line
 * loads below it share its stretch of member.
 */
export function loadShape(d: BeamData, l: BeamLoad, vp: Vp, opts: { vals?: number[]; stack?: number; text: string }): LoadShape | null {
  const vals = opts.vals;
  if (l.type === 'line') {
    const m = d.members.find((q) => q.id === l.member);
    const na = m && d.nodes.find((q) => q.id === m.a), nb = m && d.nodes.find((q) => q.id === m.b);
    if (!na || !nb) return null;
    const a = toS(vp, na), b = toS(vp, nb);
    const t1 = l.t1 ?? 0, t2 = l.t2 ?? 1;
    let p1 = lerp(a, b, t1), p2 = lerp(a, b, t2);
    const q1 = vals?.[0] ?? 1, q2 = vals?.[1] ?? q1;
    const qmax = Math.max(Math.abs(q1), Math.abs(q2), 1e-12);
    // arrows come from above (global) or from the member's left side (local)
    let nx = 0, ny = -1;
    if (l.dir === 'local') {
      const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      nx = (b.y - a.y) / L; ny = -(b.x - a.x) / L; // screen-left of travel = member's +y side
    }
    if (opts.stack) {
      // stacked above the loads below it (each block is LINE_H high plus a gap for its label)
      const off = opts.stack * (LINE_H + STACK_GAP);
      p1 = { x: p1.x + nx * off, y: p1.y + ny * off };
      p2 = { x: p2.x + nx * off, y: p2.y + ny * off };
    }
    const h1 = (LINE_H * q1) / qmax, h2 = (LINE_H * q2) / qmax;
    const top1 = { x: p1.x + nx * h1, y: p1.y + ny * h1 }, top2 = { x: p2.x + nx * h2, y: p2.y + ny * h2 };
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const n = Math.max(2, Math.min(14, Math.round(len / 22) + 1));
    const arrows: ArrowShape[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const base = lerp(p1, p2, t);
      const h = h1 + (h2 - h1) * t;
      if (Math.abs(h) < 4) continue;
      arrows.push({ from: { x: base.x + nx * h, y: base.y + ny * h }, to: base, head: 5 });
    }
    // the label sits at the start of the load, clear of point loads in the middle
    return { kind: 'line', id: l.id, area: [p1, top1, top2, p2], arrows, ends: [p1, p2], label: { x: top1.x + nx * 8, y: top1.y + ny * 8, anchor: 'start', text: opts.text } };
  }
  const p = loadPoint(d, l.at);
  if (!p) return null;
  const s = toS(vp, p);
  if (l.type === 'moment') {
    const M = vals?.[0] ?? 1;
    return { kind: 'moment', id: l.id, at: s, r: MOMENT_R, positive: M >= 0, label: { x: s.x + 19, y: s.y - 16, anchor: 'start', text: opts.text } };
  }
  const P = vals?.[0] ?? 1;
  const ang = ((l.angle + (P < 0 ? 180 : 0)) * Math.PI) / 180;
  const dir = { x: Math.cos(ang), y: -Math.sin(ang) }; // screen
  const from = { x: s.x - dir.x * FORCE_L, y: s.y - dir.y * FORCE_L };
  const vertical = Math.abs(dir.y) > 0.7;
  return {
    kind: 'force', id: l.id,
    arrow: { from, to: { x: s.x - dir.x * 2, y: s.y - dir.y * 2 }, head: 7 },
    label: {
      x: from.x - dir.x * 6 + (vertical ? 6 : 0), y: from.y - dir.y * 6 + (dir.y > 0.7 ? -2 : dir.y < -0.7 ? 10 : 4),
      anchor: vertical ? 'start' : dir.x > 0 ? 'end' : 'start', text: opts.text,
    },
  };
}

// ------------------------------------------------------------ distances

export function segDist(p: P2, a: P2, b: P2): number {
  const L2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / L2)) : 0;
  return Math.hypot(p.x - (a.x + (b.x - a.x) * t), p.y - (a.y + (b.y - a.y) * t));
}

/** Inside a polygon (even-odd; on the edge counts). */
export function inPolygon(p: P2, poly: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (segDist(p, a, b) < 1e-9) return true;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Text box of a label (11 px semibold: about 6.4 px a character). */
export function labelBox(l: LabelShape): { x0: number; y0: number; x1: number; y1: number } {
  const w = l.text.length * 6.4 + 2;
  const x0 = l.anchor === 'start' ? l.x : l.anchor === 'end' ? l.x - w : l.x - w / 2;
  return { x0, y0: l.y - 10, x1: x0 + w, y1: l.y + 3 };
}

function boxDist(p: P2, b: { x0: number; y0: number; x1: number; y1: number }): number {
  return Math.hypot(Math.max(b.x0 - p.x, 0, p.x - b.x1), Math.max(b.y0 - p.y, 0, p.y - b.y1));
}

/**
 * How far a point is from the drawn glyph: from its strokes (arrows, outline, arc), from
 * its label, and whether it is inside a filled part (a band, a moment's disc).
 */
export function loadDistance(sh: LoadShape, p: P2): { stroke: number; label: number; body: boolean } {
  // (no text: the label is not drawn)
  const label = sh.label.text ? boxDist(p, labelBox(sh.label)) : Infinity;
  if (sh.kind === 'force') return { stroke: segDist(p, sh.arrow.from, sh.arrow.to), label, body: false };
  if (sh.kind === 'moment') {
    const r = Math.hypot(p.x - sh.at.x, p.y - sh.at.y);
    return { stroke: Math.abs(r - sh.r), label, body: r < sh.r };
  }
  const [p1, top1, top2, p2] = sh.area;
  let stroke = Math.min(segDist(p, top1, top2), segDist(p, p1, top1), segDist(p, p2, top2));
  for (const a of sh.arrows) stroke = Math.min(stroke, segDist(p, a.from, a.to));
  return { stroke, label, body: inPolygon(p, sh.area) };
}

// ------------------------------------------------------------ picking

export interface PickScene {
  nodes: { id: string; s: P2 }[];
  members: { id: string; a: P2; b: P2 }[];
  supports: { id: string; s: P2; angle: number; type: 'pin' | 'roller' | 'fixed'; spring?: boolean; label: LabelShape }[];
  /** In drawing order (later ones lie on top). */
  loads: { shape: LoadShape; faded?: boolean }[];
  /** Line loads whose ends can be dragged (the selected ones). */
  grips?: Set<string>;
}

export type Pick =
  | { kind: 'node' | 'member' | 'support'; id: string }
  | { kind: 'load'; id: string; grip?: 0 | 1 };

/** Pointer tolerance around strokes, in drawing pixels. */
export const PICK_TOL = 8;
/** A filled part of a glyph (a band, a moment's disc) loses to a stroke this close. */
const BODY = 4;
/** A member under a load glyph loses to it unless the click is right on the member's line. */
const MEMBER_BIAS = 2;
/** The strokes of a line load (its many arrows) lose to a point load's arrow just as near. */
const LINE_BIAS = 1;
/** A label's box (estimated, with the space between letters) loses to strokes just by it. */
const LABEL_BIAS = 2;
/** A load of another case (drawn faded) loses to one that acts. */
const FADED_BIAS = 1.5;
const NODE_R = 3;

/** Local coordinates of a support glyph (drawn translated to its node and turned by its angle). */
function supportLocal(sp: PickScene['supports'][number], p: P2): P2 {
  const a = (sp.angle * Math.PI) / 180, dx = p.x - sp.s.x, dy = p.y - sp.s.y;
  return { x: Math.cos(a) * dx - Math.sin(a) * dy, y: Math.sin(a) * dx + Math.cos(a) * dy };
}

/** The extent of a support glyph in its own coordinates. */
function supportBox(sp: PickScene['supports'][number]) {
  const depth = sp.spring ? (sp.type === 'fixed' ? 37 : 43) : sp.type === 'fixed' ? 7 : sp.type === 'roller' ? 27 : 20;
  return { x0: -14, y0: sp.type === 'fixed' ? -3 : 0, x1: 14, y1: depth };
}

/**
 * What a click at drawing point `p` picks: the glyph nearest under it, loads before the
 * member beneath them, a node when right on it; `kinds` limits what can be picked.
 */
export function pick(scene: PickScene, p: P2, kinds?: Pick['kind'][]): Pick | null {
  const want = (k: Pick['kind']) => !kinds || kinds.includes(k);
  let best: { h: Pick; score: number } | null = null;
  // later items lie on top: they win a tie
  const consider = (h: Pick, score: number) => {
    if (!best || score <= best.score) best = { h, score };
  };
  if (want('member')) {
    for (const m of scene.members) {
      const d = segDist(p, m.a, m.b);
      if (d <= PICK_TOL) consider({ kind: 'member', id: m.id }, d + MEMBER_BIAS);
    }
  }
  if (want('support')) {
    for (const sp of scene.supports) {
      const d = Math.min(boxDist(supportLocal(sp, p), supportBox(sp)), boxDist(p, labelBox(sp.label)));
      if (d <= PICK_TOL / 2) consider({ kind: 'support', id: sp.id }, d + 1);
    }
  }
  if (want('load')) {
    for (const { shape, faded } of scene.loads) {
      const bias = faded ? FADED_BIAS : 0;
      const { stroke, label, body } = loadDistance(shape, p);
      const score = Math.min(
        stroke <= PICK_TOL ? stroke + (shape.kind === 'line' ? LINE_BIAS : 0) : Infinity,
        label <= PICK_TOL / 2 ? label + LABEL_BIAS : Infinity,
        body ? BODY : Infinity,
      );
      if (score < Infinity) consider({ kind: 'load', id: shape.id }, score + bias);
    }
  }
  if (want('node')) {
    for (const q of scene.nodes) {
      const d = Math.hypot(p.x - q.s.x, p.y - q.s.y);
      if (d <= PICK_TOL) consider({ kind: 'node', id: q.id }, Math.max(0, d - NODE_R) - 1);
    }
  }
  // the grips of a selected line load come before anything
  if (want('load') && scene.grips?.size) {
    for (const { shape } of scene.loads) {
      if (shape.kind !== 'line' || !scene.grips.has(shape.id)) continue;
      shape.ends.forEach((e, i) => {
        const d = Math.hypot(p.x - e.x, p.y - e.y);
        if (d <= 7) consider({ kind: 'load', id: shape.id, grip: i as 0 | 1 }, d - 10);
      });
    }
  }
  return best ? (best as { h: Pick }).h : null;
}

// ------------------------------------------------------------ box selection

/** Points and segments that stand for an item in a box selection. */
function outline(scene: PickScene): { id: string; pts: P2[]; segs: [P2, P2][] }[] {
  const out: { id: string; pts: P2[]; segs: [P2, P2][] }[] = [];
  for (const q of scene.nodes) out.push({ id: q.id, pts: [q.s], segs: [] });
  for (const m of scene.members) out.push({ id: m.id, pts: [m.a, m.b], segs: [[m.a, m.b]] });
  for (const sp of scene.supports) {
    const b = supportBox(sp), a = (sp.angle * Math.PI) / 180;
    // back from the glyph's own coordinates to the drawing
    const g = (x: number, y: number): P2 => ({ x: sp.s.x + Math.cos(a) * x + Math.sin(a) * y, y: sp.s.y - Math.sin(a) * x + Math.cos(a) * y });
    const c = [g(b.x0, b.y0), g(b.x1, b.y0), g(b.x1, b.y1), g(b.x0, b.y1)];
    out.push({ id: sp.id, pts: c, segs: c.map((q, i) => [q, c[(i + 1) % 4]] as [P2, P2]) });
  }
  for (const { shape: sh } of scene.loads) {
    if (sh.kind === 'force') out.push({ id: sh.id, pts: [sh.arrow.from, sh.arrow.to], segs: [[sh.arrow.from, sh.arrow.to]] });
    else if (sh.kind === 'moment') {
      const pts = Array.from({ length: 8 }, (_, i) => ({ x: sh.at.x + sh.r * Math.cos((i * Math.PI) / 4), y: sh.at.y + sh.r * Math.sin((i * Math.PI) / 4) }));
      out.push({ id: sh.id, pts, segs: pts.map((q, i) => [q, pts[(i + 1) % 8]] as [P2, P2]) });
    } else {
      const pts = [...sh.area];
      out.push({ id: sh.id, pts, segs: pts.map((q, i) => [q, pts[(i + 1) % 4]] as [P2, P2]) });
    }
  }
  return out;
}

function segmentsCross(a: P2, b: P2, c: P2, d: P2): boolean {
  const o = (p: P2, q: P2, r: P2) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

/**
 * Items in a box dragged from `a` to `b`: left to right, those wholly inside (a window);
 * right to left, those it touches (crossing), as in CAD.
 */
export function boxPick(scene: PickScene, a: P2, b: P2): string[] {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  const inside = (p: P2) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
  const box: P2[] = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const crossing = b.x < a.x;
  return outline(scene).filter((it) => {
    if (!crossing) return it.pts.every(inside);
    if (it.pts.some(inside)) return true;
    return it.segs.some(([p, q]) => box.some((r, i) => segmentsCross(p, q, r, box[(i + 1) % 4])));
  }).map((it) => it.id);
}

/** How many earlier line loads overlap this one on the same member (it is drawn above them). */
export function lineStack(loads: BeamLoad[], i: number): number {
  const l = loads[i];
  if (l.type !== 'line') return 0;
  const a = l.t1 ?? 0, b = l.t2 ?? 1;
  let n = 0;
  for (let k = 0; k < i; k++) {
    const q = loads[k];
    if (q.type === 'line' && q.member === l.member && (q.t1 ?? 0) < b - 1e-9 && (q.t2 ?? 1) > a + 1e-9) n++;
  }
  return n;
}

/** The scene of a beam region for picking (loads only when they are drawn). */
export function pickScene(r: BeamRegion, vp: Vp, opts: {
  loads: boolean; vals?: Record<string, number[]>; text: (l: BeamLoad) => string; faded?: (l: BeamLoad) => boolean; grips?: Set<string>;
}): PickScene {
  const d: BeamData = { nodes: r.nodes, members: r.members, supports: r.supports, loads: r.loads };
  const N = new Map(r.nodes.map((q) => [q.id, q]));
  const scene: PickScene = { nodes: [], members: [], supports: [], loads: [], grips: opts.grips };
  for (const q of r.nodes) scene.nodes.push({ id: q.id, s: toS(vp, q) });
  for (const m of r.members) {
    const a = N.get(m.a), b = N.get(m.b);
    if (a && b) scene.members.push({ id: m.id, a: toS(vp, a), b: toS(vp, b) });
  }
  for (const sp of r.supports) {
    const q = N.get(sp.node);
    if (!q) continue;
    const c = toS(vp, q), a = (sp.angle * Math.PI) / 180;
    scene.supports.push({
      id: sp.id, s: c, angle: sp.angle, type: sp.type, spring: !!sp.k?.trim(),
      label: { x: c.x - Math.cos(a) * 16 + Math.sin(a) * 30, y: c.y + Math.sin(a) * 16 + Math.cos(a) * 30 + 4, anchor: 'middle', text: sp.label },
    });
  }
  if (opts.loads) {
    r.loads.forEach((l, i) => {
      const shape = loadShape(d, l, vp, { vals: opts.vals?.[l.id], stack: lineStack(r.loads, i), text: opts.text(l) });
      if (shape) scene.loads.push({ shape, faded: opts.faded?.(l) });
    });
  }
  return scene;
}
