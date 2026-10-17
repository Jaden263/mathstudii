// Text in sketches: the outline of one line of text in the bundled KaTeX SansSerif font
// (SIL Open Font License 1.1, src/cad/fonts/OFL.txt), parsed with opentype.js. Each glyph
// contour becomes a closed loop of lines and the font's quadratic Béziers, joined into
// degree-2 B-splines while they run on smoothly (exact in OCCT, polylines for the mesh
// kernel). Counters ('o', 'a', 'e') are loops inside loops, so the profiles' nesting makes
// them holes, as for any sketch.
import opentype from 'opentype.js';
import fontData from './fonts/KaTeX_SansSerif-Regular.ttf?inline';
import type { BSpline } from './curves';
import type { Loop, Seg, Vec2 } from './profile';

let font: opentype.Font | null = null;

/** The font, parsed on first use (the file is bundled, so this never waits). */
export function textFont(): opentype.Font {
  if (font) return font;
  const b64 = fontData.slice(fontData.indexOf(',') + 1);
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  font = opentype.parse(bin.buffer);
  return font;
}

/** Height of the capitals over the font size (0.694 for this font: 'H' is 694 of 1000 units). */
export function capHeight(): number {
  const f = textFont();
  const os2 = f.tables.os2 as { sCapHeight?: number } | undefined;
  return (os2?.sCapHeight ?? f.charToGlyph('H').getBoundingBox().y2) / f.unitsPerEm;
}

/** The characters of `s` the font has no glyph for (they are left out). */
export function missingGlyphs(s: string): string[] {
  const f = textFont();
  return [...new Set([...s].filter((ch) => ch.trim() && f.charToGlyph(ch).index === 0))];
}

type Cmd = opentype.PathCommand;

/** Contours of a string in font units (y up), with kerning: each a start point and its pieces. */
const cache = new Map<string, { start: Vec2; pieces: ({ kind: 'L'; p: Vec2 } | { kind: 'Q'; c: Vec2; p: Vec2 })[] }[]>();

function contours(text: string) {
  let got = cache.get(text);
  if (got) return got;
  const f = textFont();
  const cmds: Cmd[] = f.getPath(text, 0, 0, f.unitsPerEm, { kerning: true }).commands;
  got = [];
  let cur: (typeof got)[number] | null = null;
  // opentype draws for a screen (y down): flip back to the font's y up
  const at = (x: number, y: number): Vec2 => ({ x, y: -y });
  for (const c of cmds) {
    if (c.type === 'M') {
      cur = { start: at(c.x, c.y), pieces: [] };
      got.push(cur);
    } else if (c.type === 'L' && cur) cur.pieces.push({ kind: 'L', p: at(c.x, c.y) });
    else if (c.type === 'Q' && cur) cur.pieces.push({ kind: 'Q', c: at(c.x1, c.y1), p: at(c.x, c.y) });
    else if (c.type === 'C' && cur) {
      // TrueType has none; a cubic is split at its middle into two quadratics (close enough for text)
      const p0 = cur.pieces.length ? cur.pieces[cur.pieces.length - 1].p : cur.start;
      const c1 = at(c.x1, c.y1), c2 = at(c.x2, c.y2), p3 = at(c.x, c.y);
      const m = { x: (p0.x + 3 * c1.x + 3 * c2.x + p3.x) / 8, y: (p0.y + 3 * c1.y + 3 * c2.y + p3.y) / 8 };
      cur.pieces.push({ kind: 'Q', c: { x: (p0.x + 3 * c1.x) / 4, y: (p0.y + 3 * c1.y) / 4 }, p: m }, { kind: 'Q', c: { x: (3 * c2.x + p3.x) / 4, y: (3 * c2.y + p3.y) / 4 }, p: p3 });
    }
  }
  cache.set(text, got);
  return got;
}

/** Advance width of the string (font size 1), for placing and framing text. */
export function textWidth(text: string): number {
  const f = textFont();
  return f.getAdvanceWidth(text, 1, { kerning: true });
}

/**
 * The outline of a single line of text as closed loops (sketch coordinates): the baseline
 * starts at `at` and runs at `angle` degrees, `size` is the font size (capitals are
 * capHeight() of it). Every segment is tagged with the text entity `id`.
 */
export function textLoops(text: string, size: number, angle: number, at: Vec2, id: string): Loop[] {
  if (!text || !(size > 0)) return [];
  const f = textFont();
  const s = size / f.unitsPerEm, a = (angle * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const T = (p: Vec2): Vec2 => ({ x: at.x + s * (p.x * ca - p.y * sa), y: at.y + s * (p.x * sa + p.y * ca) });
  const tiny = 1e-9 * f.unitsPerEm;
  const out: Loop[] = [];
  for (const c of contours(text)) {
    // the contour's points in sketch coordinates, each computed once so pieces meet exactly
    const segs: Seg[] = [];
    let run: Vec2[] | null = null;
    const flush = () => {
      if (run && run.length >= 3) segs.push(quadRun(run));
      run = null;
    };
    let last = c.start, lastS = T(c.start);
    const pieces = [...c.pieces];
    const end = pieces.length ? pieces[pieces.length - 1].p : c.start;
    if (Math.hypot(end.x - c.start.x, end.y - c.start.y) > tiny) pieces.push({ kind: 'L', p: c.start });
    for (let i = 0; i < pieces.length; i++) {
      const pc = pieces[i];
      const closing = i === pieces.length - 1;
      if (Math.hypot(pc.p.x - last.x, pc.p.y - last.y) <= tiny && pc.kind === 'L') continue;
      const pS = closing ? T(c.start) : T(pc.p);
      if (pc.kind === 'L') {
        flush();
        segs.push({ kind: 'line', a: lastS, b: pS });
      } else {
        const cS = T(pc.c);
        // a quadratic run goes on while the curve turns smoothly at the joint
        if (run && !smooth(run[run.length - 2], lastS, cS)) flush();
        if (!run) run = [lastS];
        run.push(cS, pS);
      }
      last = pc.p;
      lastS = pS;
    }
    flush();
    // the closing piece ends exactly where the contour starts
    if (segs.length) out.push({ segs, entities: segs.map(() => id) });
  }
  return out.filter((l) => Math.abs(loopArea(l)) > 0);
}

/** Tangent directions into and out of the joint b agree. */
function smooth(a: Vec2, b: Vec2, c: Vec2): boolean {
  const u = { x: b.x - a.x, y: b.y - a.y }, v = { x: c.x - b.x, y: c.y - b.y };
  const lu = Math.hypot(u.x, u.y), lv = Math.hypot(v.x, v.y);
  if (!(lu > 0 && lv > 0)) return false;
  return (u.x * v.x + u.y * v.y) / (lu * lv) > Math.cos(1e-3) && Math.abs(u.x * v.y - u.y * v.x) / (lu * lv) < 1e-3;
}

/** Quadratic Béziers end to end (start, control, end, control, end …) as one degree-2 B-spline. */
function quadRun(pts: Vec2[]): Seg {
  const k = (pts.length - 1) / 2;
  const knots = [0, 0, 0];
  for (let i = 1; i < k; i++) knots.push(i, i);
  knots.push(k, k, k);
  const s: BSpline = { deg: 2, poles: pts, knots };
  return { kind: 'bspline', ...s };
}

/** Signed area of a loop's control polygon (a rough check that it encloses something). */
function loopArea(l: Loop): number {
  let a = 0;
  for (const s of l.segs) {
    const pts = s.kind === 'line' ? [s.a, s.b] : s.kind === 'bspline' ? s.poles : [];
    for (let i = 0; i + 1 < pts.length; i++) a += pts[i].x * pts[i + 1].y - pts[i + 1].x * pts[i].y;
  }
  return a / 2;
}
