// Screen geometry of the beam editor: model ↔ drawing coordinates, and moving about the
// drawing (wheel and pinch zoom about a point, panning, limits). The drawing is laid out
// in logical pixels; the model is in the region's length unit with y up.
import type { BeamData, BeamView } from '../../beam/model';

export interface Vp {
  view: BeamView;
  width: number;
  height: number;
}

export interface P2 {
  x: number;
  y: number;
}

export const toS = (vp: Vp, p: P2): P2 => ({ x: (p.x - vp.view.cx) * vp.view.zoom + vp.width / 2, y: vp.height / 2 - (p.y - vp.view.cy) * vp.view.zoom });
export const toW = (vp: Vp, s: P2): P2 => ({ x: (s.x - vp.width / 2) / vp.view.zoom + vp.view.cx, y: (vp.height / 2 - s.y) / vp.view.zoom + vp.view.cy });

/** Steps of the zoom buttons and the + / − keys. */
export const ZOOM_STEP = 1.25;

/**
 * Zoom limits for a structure in a drawing `width` wide: from the whole structure in a
 * twentieth of the width to a two-hundredth of it filling the width (with nothing drawn
 * yet: by the grid).
 */
export function zoomLimits(d: BeamData, width: number, grid: number): [number, number] {
  let ext = 0;
  if (d.nodes.length) {
    const xs = d.nodes.map((q) => q.x), ys = d.nodes.map((q) => q.y);
    ext = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  }
  if (!(ext > 0)) ext = grid > 0 ? grid * 10 : 10;
  return [(width * 0.05) / ext, (width * 200) / ext];
}

const clampZoom = (z: number, lim?: [number, number]) => (lim ? Math.min(lim[1], Math.max(lim[0], z)) : z);

/** The view zoomed by `factor` about the drawing point `s`, which stays where it is. */
export function zoomAt(vp: Vp, s: P2, factor: number, lim?: [number, number]): BeamView {
  const w = toW(vp, s);
  const zoom = clampZoom(vp.view.zoom * factor, lim);
  return { ...vp.view, zoom, cx: w.x - (s.x - vp.width / 2) / zoom, cy: w.y - (vp.height / 2 - s.y) / zoom, manual: true };
}

/** The view moved with the pointer by (dx, dy) drawing pixels. */
export function panBy(view: BeamView, dx: number, dy: number): BeamView {
  return { ...view, cx: view.cx - dx / view.zoom, cy: view.cy + dy / view.zoom, manual: true };
}

/**
 * Two fingers: the model point under their midpoint at the start stays under it as they
 * move, and the zoom follows their spread.
 */
export function pinchView(vp: Vp, start: [P2, P2], now: [P2, P2], lim?: [number, number]): BeamView {
  const mid = (p: [P2, P2]) => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 });
  const spread = (p: [P2, P2]) => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1;
  const w = toW(vp, mid(start));
  const c = mid(now);
  const zoom = clampZoom(vp.view.zoom * (spread(now) / spread(start)), lim);
  return { ...vp.view, zoom, cx: w.x - (c.x - vp.width / 2) / zoom, cy: w.y - (vp.height / 2 - c.y) / zoom, manual: true };
}

/** Pixels a wheel event scrolls, whatever its deltaMode (lines, pages). */
export function wheelPixels(e: { deltaY: number; deltaMode: number }): number {
  return e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
}

/**
 * Zoom factor of one wheel event: a mouse notch (100 px) about 22 %; a trackpad pinch,
 * which comes as Ctrl + many small deltas, finer per pixel so it follows the fingers.
 */
export function wheelFactor(e: { deltaY: number; deltaMode: number; ctrlKey: boolean }): number {
  const d = Math.max(-120, Math.min(120, wheelPixels(e)));
  return Math.exp(-d * (e.ctrlKey ? 0.01 : 0.002));
}

/** The smallest of 1, 2, 5, 10, 20 … times `unit` that is at least `x`. */
function niceAtLeast(x: number, unit: number, ok: (v: number) => boolean = () => true): number {
  for (let dec = unit; dec < unit * 1e15; dec *= 10) for (const m of [1, 2, 5]) if (m * dec >= x * (1 - 1e-9) && ok(m * dec)) return m * dec;
  return x;
}

/**
 * Lines of a grid of `step` for the view: every 1st, 2nd, 5th, 10th … line, so that they
 * are at least `minPx` apart, and major lines at round multiples about 4 lines apart.
 */
export function gridLines(vp: Vp, step: number, minPx = 8): { xs: { v: number; major: boolean }[]; ys: { v: number; major: boolean }[]; step: number } | null {
  if (!(step > 0) || !(vp.view.zoom > 0)) return null;
  const s = niceAtLeast(minPx / vp.view.zoom, step);
  const whole = (v: number) => Math.abs(v / s - Math.round(v / s)) < 1e-6;
  const M = niceAtLeast(4 * s, 10 ** Math.floor(Math.log10(s)), whole);
  const tl = toW(vp, { x: 0, y: 0 }), br = toW(vp, { x: vp.width, y: vp.height });
  // no more than a few hundred lines, whatever the view
  if ((br.x - tl.x) / s > 400 || (tl.y - br.y) / s > 400) return null;
  const isMajor = (v: number) => Math.abs(v / M - Math.round(v / M)) < 1e-6;
  const xs: { v: number; major: boolean }[] = [], ys: { v: number; major: boolean }[] = [];
  for (let i = Math.ceil(tl.x / s - 1e-9); i * s <= br.x; i++) xs.push({ v: i * s, major: isMajor(i * s) });
  for (let i = Math.ceil(br.y / s - 1e-9); i * s <= tl.y; i++) ys.push({ v: i * s, major: isMajor(i * s) });
  return { xs, ys, step: s };
}
