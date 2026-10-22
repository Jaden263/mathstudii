// A flat pattern out of the program: DXF for laser, punch and plasma cutting, SVG, and the
// flat view of a drawing. DXF is R12 (AC1009), which every cutting program reads, at 1:1 in
// the part's unit: the outer contour on layer OUTER, the cut-outs on INNER, the bend lines
// on BEND (DASHED) with their notes ("UP 90° R2") as TEXT on BEND_NOTES, so a cutting
// program can leave the bends out by layer. Arcs and circles stay true ARCs and CIRCLEs.
import type { DrawView, Prim } from './drawing2d';
import { primAt, primsBox } from './drawing2d';
import { primPath } from './drawingSheet';
import { bendNote, type FlatPattern } from './sheetMetal';

const UNIT_CODE: Record<string, number> = { in: 1, mm: 4, cm: 5, m: 6 };
const MM: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4 };
const DEG = 180 / Math.PI;

/** Up to 10 significant digits as a plain decimal (some readers reject exponents). */
function num(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const r = +v.toPrecision(10);
  let s = String(r);
  if (s.includes('e')) s = Math.abs(r) < 1 ? r.toFixed(12).replace(/\.?0+$/, '') : r.toFixed(0);
  return s === '-0' ? '0' : s;
}

/** Degrees in [0, 360). */
const deg = (a: number) => {
  const d = (((a * DEG) % 360) + 360) % 360;
  return d >= 360 - 1e-10 ? 0 : d;
};

/** A length for notes: 2 decimals at most. */
export const fmtLen = (v: number) => `${+v.toFixed(2)}`;

/** The text of a bend note, ASCII for R12 (the degree sign as %%d). */
const asciiNote = (s: string) => s.replace(/°/g, '%%d');

/** The height of note text: 3.5 mm in the part's unit, smaller on small blanks. */
function noteHeight(fp: FlatPattern, unit: string) {
  const b = fp.numbers.box, size = Math.max(b.x1 - b.x0, b.y1 - b.y0);
  return Math.min(3.5 / (MM[unit] ?? 1), size / 25);
}

export function flatDxf(fp: FlatPattern, unit: string): string {
  const out: string[] = [];
  const g = (code: number, value: string | number) => out.push(String(code), typeof value === 'number' ? num(value) : value);
  const xy = (code: number, x: number, y: number) => {
    g(code, x);
    g(code + 10, y);
    g(code + 20, 0);
  };
  const b = fp.numbers.box;
  const mm = MM[unit] ?? 1;
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, UNIT_CODE[unit] ?? 4);
  g(9, '$EXTMIN'); xy(10, b.x0, b.y0);
  g(9, '$EXTMAX'); xy(10, b.x1, b.y1);
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES');
  // dashes of 6 mm and gaps of 3 mm, in the part's unit
  const dash = 6 / mm, gap = 3 / mm;
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 2);
  g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, 0);
  g(0, 'LTYPE'); g(2, 'DASHED'); g(70, 0); g(3, '__ __ __'); g(72, 65); g(73, 2); g(40, dash + gap); g(49, dash); g(49, -gap);
  g(0, 'ENDTAB');
  const layers: [string, number, string][] = [['0', 7, 'CONTINUOUS'], ['OUTER', 7, 'CONTINUOUS'], ['INNER', 4, 'CONTINUOUS'], ['BEND', 1, 'DASHED'], ['BEND_NOTES', 3, 'CONTINUOUS']];
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.length);
  for (const [name, colour, lt] of layers) {
    g(0, 'LAYER'); g(2, name); g(70, 0); g(62, colour); g(6, lt);
  }
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'STYLE'); g(70, 1);
  g(0, 'STYLE'); g(2, 'STANDARD'); g(70, 0); g(40, 0); g(41, 1); g(50, 0); g(71, 0); g(42, 2.5); g(3, 'txt'); g(4, '');
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  const put = (layer: string, p: Prim) => {
    switch (p.k) {
      case 'line':
        g(0, 'LINE'); g(8, layer); xy(10, p.x1, p.y1); xy(11, p.x2, p.y2);
        return;
      case 'arc':
        if (p.a1 - p.a0 >= 2 * Math.PI - 1e-9) {
          g(0, 'CIRCLE'); g(8, layer); xy(10, p.cx, p.cy); g(40, p.r);
        } else {
          g(0, 'ARC'); g(8, layer); xy(10, p.cx, p.cy); g(40, p.r); g(50, deg(p.a0)); g(51, deg(p.a1));
        }
        return;
      default: {
        // R12 has no ellipse: a fine polyline (B-splines come as one already)
        const pts: number[] = [];
        if (p.k === 'poly') pts.push(...p.pts);
        else for (let i = 0; i <= 96; i++) pts.push(...primAt(p, i / 96));
        g(0, 'POLYLINE'); g(8, layer); g(66, 1); xy(10, 0, 0); g(70, 0);
        for (let i = 0; i + 1 < pts.length; i += 2) {
          g(0, 'VERTEX'); g(8, layer); xy(10, pts[i], pts[i + 1]);
        }
        g(0, 'SEQEND'); g(8, layer);
      }
    }
  };
  for (const loop of fp.outer) for (const p of loop) put('OUTER', p);
  for (const loop of fp.inner) for (const p of loop) put('INNER', p);
  const h = noteHeight(fp, unit);
  for (const bd of fp.numbers.bends) {
    put('BEND', { k: 'line', x1: bd.a.x, y1: bd.a.y, x2: bd.b.x, y2: bd.b.y });
    const n = note(bd.a, bd.b, h);
    g(0, 'TEXT'); g(8, 'BEND_NOTES'); xy(10, n.x, n.y); g(40, h); g(1, asciiNote(bendNote(bd, fmtLen))); g(50, n.rot); g(72, 1); xy(11, n.x, n.y);
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\n') + '\n';
}

/** Where a bend's note sits: centred just beside its line, reading from the left or from below. */
function note(a: { x: number; y: number }, b: { x: number; y: number }, h: number) {
  let rot = Math.atan2(b.y - a.y, b.x - a.x) * DEG;
  if (rot > 90 + 1e-9) rot -= 180;
  else if (rot <= -90 + 1e-9) rot += 180;
  const r = rot / DEG;
  // up from the line, square to it
  return { x: (a.x + b.x) / 2 - Math.sin(r) * h * 0.6, y: (a.y + b.y) / 2 + Math.cos(r) * h * 0.6, rot };
}

/** The flat pattern as SVG at true size (millimetres on the page), its bend lines dashed with their notes. */
export function flatSvg(fp: FlatPattern, unit: string): string {
  const b = fp.numbers.box;
  const mm = MM[unit] ?? 1;
  const pad = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.05 + 2 / mm;
  const x0 = b.x0 - pad, y0 = b.y0 - pad, w = b.x1 - b.x0 + 2 * pad, hgt = b.y1 - b.y0 + 2 * pad;
  // the paper's y runs down: mirror about the middle of the box
  const H = y0 + (y0 + hgt);
  const path = (loops: Prim[][]) => loops.map((l) => l.map((p) => primPath(p, H)).join('')).join('');
  const f = (v: number) => `${Math.round(v * 1000) / 1000}`;
  const h = noteHeight(fp, unit);
  const sw = 0.25 / mm;
  const bends = fp.numbers.bends.map((bd) => {
    const n = note(bd.a, bd.b, h);
    return `<path d="${primPath({ k: 'line', x1: bd.a.x, y1: bd.a.y, x2: bd.b.x, y2: bd.b.y }, H)}" stroke-dasharray="${f(6 / mm)} ${f(3 / mm)}"/>`
      + `<text x="${f(n.x)}" y="${f(H - n.y)}" font-size="${f(h)}" text-anchor="middle" transform="rotate(${f(-n.rot)} ${f(n.x)} ${f(H - n.y)})">${bendNote(bd, fmtLen)}</text>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${f(w * mm)}mm" height="${f(hgt * mm)}mm" viewBox="${f(x0)} ${f(y0)} ${f(w)} ${f(hgt)}">`
    + `<g fill="none" stroke="#000" stroke-width="${f(sw * 2)}"><path d="${path(fp.outer)}"/></g>`
    + `<g fill="none" stroke="#0a7ea4" stroke-width="${f(sw * 2)}"><path d="${path(fp.inner)}"/></g>`
    + `<g fill="none" stroke="#c0392b" stroke-width="${f(sw)}" font-family="sans-serif">${bends.replace(/<text /g, '<text fill="#c0392b" stroke="none" ')}</g>`
    + '</svg>\n';
}

/** The flat pattern as a drawing view: its contours as visible lines, centre marks on round holes, bend lines and their notes. */
export function flatView(fp: FlatPattern, name: string): DrawView {
  const visible = [...fp.outer.flat(), ...fp.inner.flat()];
  const bends: Prim[] = fp.numbers.bends.map((b) => ({ k: 'line', x1: b.a.x, y1: b.a.y, x2: b.b.x, y2: b.b.y }));
  const notes = fp.numbers.bends.map((b) => ({ ...note(b.a, b.b, 0), text: bendNote(b, fmtLen) }));
  // a round hole (one circle, or arcs of one circle round it) gets its centre mark
  const axes = fp.inner.flatMap((loop) => {
    const c = loop[0];
    if (c?.k !== 'arc') return [];
    const same = loop.every((p) => p.k === 'arc' && Math.hypot(p.cx - c.cx, p.cy - c.cy) <= 1e-9 * (1 + c.r) && Math.abs(p.r - c.r) <= 1e-9 * c.r);
    const turn = loop.reduce((s, p) => s + (p.k === 'arc' ? p.a1 - p.a0 : 0), 0);
    return same && turn > 2 * Math.PI - 1e-6 ? [{ kind: 'mark' as const, x: c.cx, y: c.cy, r: c.r }] : [];
  });
  return { name, visible, hidden: [], tangent: [], thin: [], axes, box: primsBox(visible, bends), bends, notes };
}
