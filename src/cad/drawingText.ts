// Lettering on the sheet (ISO 3098 type B, upright): each piece of text is set to the
// width its characters have in Arial / Helvetica (annotations.ts), so frames, stacks and
// leaders fit whatever font draws it (SVG textLength, DXF fitted text). The symbols that
// fonts often lack are drawn as lines: the ISO 15786 depth, counterbore and countersink
// symbols, the arc of an arc length, the fifteen characteristics of ISO 1101 and the
// circled modifiers Ⓜ Ⓛ Ⓟ.
import { textWidth } from './annotations';
import type { GdtChar } from './annotations';
import type { Fill, Ink, Label, Layer } from './drawingSheet';

const { cos, sin, PI } = Math;

/** What the lettering is drawn into (a sheet). */
export interface Sink {
  inks: Ink[];
  labels: Label[];
  fills: Fill[];
}

export interface TextStyle {
  layer: Layer;
  anchor?: 'start' | 'middle' | 'end';
  /** Degrees counter-clockwise. */
  rot?: number;
  owner?: string;
  warn?: boolean;
  bold?: boolean;
}

/** Symbols drawn as lines, and their widths in cap heights (with a little room either side). */
const GLYPHS: Record<string, number> = { '↧': 0.9, '⌴': 1.1, '⌵': 1.1, '⌒': 1.2 };

/** Strokes of a symbol in a cell from its left end on the baseline, in cap heights. */
const STROKES: Record<string, number[][]> = {
  // depth: an arrow down onto a bar
  '↧': [[0.45, 1, 0.45, 0], [0.45, 0, 0.25, 0.35], [0.45, 0, 0.65, 0.35], [0.12, 0, 0.78, 0]],
  // counterbore: a square-bottomed cup
  '⌴': [[0.15, 0.75, 0.15, 0.05, 0.95, 0.05, 0.95, 0.75]],
  // countersink: a V
  '⌵': [[0.12, 0.75, 0.55, 0.05, 0.98, 0.75]],
};

/** Pieces of a text: plain runs and drawn symbols. */
function pieces(text: string): string[] {
  const out: string[] = [];
  let run = '';
  for (const ch of text) {
    if (GLYPHS[ch] !== undefined) {
      if (run) out.push(run);
      out.push(ch);
      run = '';
    } else run += ch;
  }
  if (run) out.push(run);
  return out;
}

/** Width (mm) of a text whose capitals are h high, symbols included. */
export function lineWidth(text: string, h: number): number {
  return pieces(text).reduce((w, p) => w + (GLYPHS[p] !== undefined ? GLYPHS[p] * h : textWidth(p, h)), 0);
}

/**
 * A line of text with its baseline through (x, y): plain runs as labels set to their
 * width (spaces at their ends are room, not text, so no font collapses them), symbols as
 * strokes. Returns its width.
 */
export function putText(out: Sink, text: string, x: number, y: number, h: number, st: TextStyle): number {
  const W = lineWidth(text, h);
  const a = ((st.rot ?? 0) * PI) / 180, c = cos(a), s = sin(a);
  const at = (u: number, v: number): [number, number] => [x + u * c - v * s, y + u * s + v * c];
  let u = st.anchor === 'middle' ? -W / 2 : st.anchor === 'end' ? -W : 0;
  const own = { ...(st.owner ? { owner: st.owner } : {}), ...(st.warn ? { warn: true } : {}) };
  for (const p of pieces(text)) {
    if (GLYPHS[p] !== undefined) {
      const strokes = p === '⌒' ? arcStroke() : STROKES[p];
      for (const q of strokes) {
        for (let i = 0; i + 3 < q.length; i += 2) {
          const [x1, y1] = at(u + q[i] * h, q[i + 1] * h), [x2, y2] = at(u + q[i + 2] * h, q[i + 3] * h);
          out.inks.push({ layer: st.layer, p: { k: 'line', x1, y1, x2, y2 }, ...own });
        }
      }
      u += GLYPHS[p] * h;
      continue;
    }
    const lead = p.length - p.trimStart().length, body = p.trim();
    const w0 = textWidth(p.slice(0, lead), h), w = textWidth(body, h);
    if (body) {
      const [lx, ly] = at(u + w0, 0);
      out.labels.push({ layer: st.layer, x: lx, y: ly, h, text: body, anchor: 'start', w, ...(st.rot ? { rot: st.rot } : {}), ...(st.bold ? { bold: true } : {}), ...own });
    }
    u += textWidth(p, h);
  }
  return W;
}

/** The arc over an arc length's value, as a polyline in cap heights. */
function arcStroke(): number[][] {
  const pts: number[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = PI * (0.15 + (0.7 * i) / 12);
    pts.push(0.6 - 0.48 * cos(t), 0.3 + 0.48 * sin(t) - 0.1);
  }
  return [pts];
}

// ------------------------------------------------------------ ISO 1101 symbols

/**
 * The symbol of a geometric characteristic (ISO 1101 Table 2, proportions after ISO 7083)
 * centred at (cx, cy), about 1.2 h across for lettering of cap height h.
 */
export function gdtSymbol(out: Sink, char: GdtChar, cx: number, cy: number, h: number, layer: Layer, own: { owner?: string; warn?: boolean } = {}) {
  const k = 0.6 * h;
  const P = (u: number, v: number): [number, number] => [cx + u * k, cy + v * k];
  const line = (u1: number, v1: number, u2: number, v2: number) => {
    const [x1, y1] = P(u1, v1), [x2, y2] = P(u2, v2);
    out.inks.push({ layer, p: { k: 'line', x1, y1, x2, y2 }, ...own });
  };
  const circle = (u: number, v: number, r: number, a0 = 0, a1 = 2 * PI) => {
    const [x, y] = P(u, v);
    out.inks.push({ layer, p: { k: 'arc', cx: x, cy: y, r: r * k, a0, a1 }, ...own });
  };
  const arrow = (u: number, v: number, du: number, dv: number) => {
    // a filled head at (u, v) pointing along (du, dv)
    const l = Math.hypot(du, dv), ux = du / l, uy = dv / l, len = 0.45, half = 0.16;
    const pts = [P(u, v), P(u - ux * len - uy * half, v - uy * len + ux * half), P(u - ux * len + uy * half, v - uy * len - ux * half)].flat();
    out.fills.push({ layer, pts, ...own });
  };
  const tan60 = Math.tan(PI / 3);
  switch (char) {
    case 'straightness':
      return line(-1, 0, 1, 0);
    case 'flatness':
      return [[-1, -0.45, 0.55, -0.45], [0.55, -0.45, 1, 0.45], [1, 0.45, -0.55, 0.45], [-0.55, 0.45, -1, -0.45]].forEach((q) => line(q[0], q[1], q[2], q[3]));
    case 'circularity':
      return circle(0, 0, 0.8);
    case 'cylindricity': {
      circle(0, 0, 0.6);
      // two lines at 60°, touching the circle either side
      const nx = -sin(PI / 3), ny = cos(PI / 3), dx = cos(PI / 3), dy = sin(PI / 3);
      for (const g of [1, -1]) line(g * 0.6 * nx - dx * 1.05, g * 0.6 * ny - dy * 1.05, g * 0.6 * nx + dx * 1.05, g * 0.6 * ny + dy * 1.05);
      return;
    }
    case 'lineProfile':
      return circle(0, -0.4, 0.85, 0, PI);
    case 'surfaceProfile':
      circle(0, -0.4, 0.85, 0, PI);
      return line(-0.85, -0.4, 0.85, -0.4);
    case 'parallelism':
      for (const off of [-0.35, 0.35]) line(off - 0.8 / tan60 - 0.1, -0.8, off + 0.8 / tan60 - 0.1, 0.8);
      return;
    case 'perpendicularity':
      line(0, -0.75, 0, 0.85);
      return line(-0.85, -0.75, 0.85, -0.75);
    case 'angularity':
      // two lines at 30°
      line(-0.9, -0.7, 0.95, -0.7);
      return line(-0.9, -0.7, -0.9 + 2 * cos(PI / 6), -0.7 + 2 * sin(PI / 6));
    case 'position':
      circle(0, 0, 0.55);
      line(-0.95, 0, 0.95, 0);
      return line(0, -0.95, 0, 0.95);
    case 'coaxiality':
    case 'concentricity':
      circle(0, 0, 0.85);
      return circle(0, 0, 0.42);
    case 'symmetry':
      line(-1, 0, 1, 0);
      line(-0.6, 0.45, 0.6, 0.45);
      return line(-0.6, -0.45, 0.6, -0.45);
    case 'circularRunout':
      line(-0.65, -0.65, 0.65, 0.65);
      return arrow(0.75, 0.75, 1, 1);
    case 'totalRunout':
      line(-0.95, -0.7, 0.55, -0.7);
      for (const off of [-0.95, -0.25]) {
        line(off, -0.7, off + 1.25, 0.55);
        arrow(off + 1.35, 0.65, 1, 1);
      }
      return;
  }
}

/** A letter in a circle (the modifiers Ⓜ Ⓛ Ⓟ of ISO 1101 and ISO 2692), centred at (cx, cy): its diameter. */
export function circled(out: Sink, letter: string, cx: number, cy: number, h: number, layer: Layer, own: { owner?: string; warn?: boolean } = {}): number {
  const r = 0.75 * h;
  out.inks.push({ layer, p: { k: 'arc', cx, cy, r, a0: 0, a1: 2 * PI }, ...own });
  const hs = 0.8 * h;
  putText(out, letter, cx, cy - hs / 2, hs, { layer, anchor: 'middle', ...own });
  return 2 * r;
}

/** A filled dot of radius r (ISO 128-22: a leader ending within an outline), as triangles a DXF SOLID takes. */
export function dot(out: Sink, x: number, y: number, r: number, layer: Layer, own: { owner?: string; warn?: boolean } = {}) {
  const n = 8;
  for (let i = 0; i < n; i++) {
    const a0 = (2 * PI * i) / n, a1 = (2 * PI * (i + 1)) / n;
    out.fills.push({ layer, pts: [x, y, x + r * cos(a0), y + r * sin(a0), x + r * cos(a1), y + r * sin(a1)], ...own });
  }
}
