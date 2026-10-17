// What the drawing's annotation tools make of the picks: a dimension of the right kind
// from one or two picks and where its text was put (a circle's diameter, an arc's radius,
// a line's length, the distance between two picks, the angle between two lines), the next
// one of a chain or a baseline, an annotation moved (its picks' geometry taken as it is
// now, so it keeps its place from there), and how the side panel names each.
import { GDT_INFO, type Annotation, type DimAnnotation, type DrawPick, type Shape2, type XY } from './annotations';
import { centreOf, inferOrient, measureAngle, measureLinear } from './drawingRefs';

const { hypot, sign } = Math;

/**
 * A dimension from the picks and the place of its text, or null when they make none (a
 * lone point). Two parallel lines, or a line and a point, are measured square to the
 * line; two points (a circle counts as its centre) horizontally, vertically or aligned
 * as the text's place says.
 */
export function newDimension(id: string, view: string, picks: DrawPick[], text: XY): DimAnnotation | null {
  const [a, b] = picks;
  if (!a) return null;
  const base = { id, kind: 'dim' as const, view, text, a };
  if (!b) {
    const s = a.shape;
    if (s.k === 'circle') return { ...base, type: s.a1 - s.a0 >= 2 * Math.PI - 1e-9 ? 'diameter' : 'radius' };
    if (s.k === 'cyl') return { ...base, type: 'diameter' };
    if (s.k === 'line') return { ...base, type: 'linear', orient: inferOrient([s.x1, s.y1], [s.x2, s.y2], text) };
    return null;
  }
  if (a.shape.k === 'line' && b.shape.k === 'line' && measureAngle(a.shape, b.shape, text)) return { ...base, b, type: 'angle' };
  const pa = centreOf(a.shape), pb = centreOf(b.shape);
  if (pa && pb) {
    if (hypot(pb[0] - pa[0], pb[1] - pa[1]) < 1e-12) return null;
    return { ...base, b, type: 'linear', orient: inferOrient(pa, pb, text) };
  }
  return measureLinear(a.shape, b.shape, undefined, text) ? { ...base, b, type: 'linear' } : null;
}

/**
 * The next dimension of a chain (from the last one's second pick) or a baseline (from the
 * first one's first pick, its line `step` further out), on the same line as `prev`.
 */
export function continueDimension(id: string, mode: 'chain' | 'baseline', first: DimAnnotation, prev: DimAnnotation, pick: DrawPick, step: number): DimAnnotation | null {
  const from = mode === 'chain' ? prev.b : first.a;
  if (!from || prev.type !== 'linear') return null;
  const m0 = measureLinear(prev.a.shape, prev.b?.shape, prev.orient, prev.text);
  const m = measureLinear(from.shape, pick.shape, prev.orient, prev.text);
  if (!m0 || !m) return null;
  const n: XY = [-m0.u[1], m0.u[0]];
  const along = (p: XY) => p[0] * n[0] + p[1] * n[1];
  // the dimension line where the last one's is, a step further out for a baseline
  const out = sign(along(prev.text) - along(m0.p1)) || 1;
  const c = along(prev.text) + (mode === 'baseline' ? out * step : 0);
  const mid: XY = [(m.p1[0] + m.p2[0]) / 2, (m.p1[1] + m.p2[1]) / 2];
  const text: XY = [mid[0] + n[0] * (c - along(mid)), mid[1] + n[1] * (c - along(mid))];
  return { id, kind: 'dim', view: prev.view, type: 'linear', ...(prev.orient ? { orient: prev.orient } : {}), ...(prev.k ? { k: prev.k } : {}), a: from, b: pick, text };
}

/** Picks with their geometry taken as it is now (where it was found). */
const refreshed = (p: DrawPick, s?: Shape2): DrawPick => (s ? { ...p, shape: s } : p);

/**
 * An annotation dragged by `d` (view units) from where it is drawn (`pos`, its position as
 * the geometry now has it), its picks' geometry brought up to date with `now`, and the
 * view's scale now (`k`) taken as its own.
 */
export function movedAnnotation(a0: Annotation, d: XY, pos?: XY, now?: { a?: Shape2; b?: Shape2 }, k?: number): Annotation {
  const to = (p: XY): XY => [p[0] + d[0], p[1] + d[1]];
  const a = k ? { ...a0, k } : a0;
  switch (a.kind) {
    case 'dim':
      return { ...a, text: to(pos ?? a.text), a: refreshed(a.a, now?.a), ...(a.b ? { b: refreshed(a.b, now?.b) } : {}) };
    case 'note':
      return { ...a, at: to(pos ?? a.at), ...(a.leader ? { leader: refreshed(a.leader, now?.a) } : {}) };
    case 'gdt':
      return a.dim ? a : { ...a, at: to(pos ?? a.at), ...(a.leader ? { leader: refreshed(a.leader, now?.a) } : {}) };
    case 'surface':
      return { ...a, at: to(pos ?? a.at), ...(a.leader ? { leader: refreshed(a.leader, now?.a) } : {}) };
    case 'datum':
      return { ...a, at: to(pos ?? a.at), leader: refreshed(a.leader, now?.a) };
    case 'hole':
    case 'balloon':
      return { ...a, at: to(pos ?? a.at), a: refreshed(a.a, now?.a) };
    case 'centre':
      return a;
  }
}

/** The next free datum letter (I, O and Q are left out, as for views). */
export function nextDatumLetter(list: Annotation[] = []): string {
  const used = new Set(list.flatMap((a) => (a.kind === 'datum' ? [a.letter.trim()] : [])));
  for (const c of 'ABCDEFGHJKLMNPRSTUVWXYZ') if (!used.has(c)) return c;
  return `Z${used.size}`;
}

const DIM_NAME: Record<DimAnnotation['type'], string> = { linear: 'Length', radius: 'Radius', diameter: 'Diameter', angle: 'Angle', arc: 'Arc length', pitch: 'Pitch circle' };

/** How the side panel names an annotation (with what it reads, when it is drawn). */
export function annotationName(a: Annotation, reads?: string): string {
  switch (a.kind) {
    case 'dim':
      return `${DIM_NAME[a.type]}${reads ? ` ${reads}` : ''}`;
    case 'note':
      return `Note: ${a.text.split('\n')[0]}`;
    case 'hole':
      return `Hole: ${reads?.split('\n')[0] ?? ''}`;
    case 'gdt':
      return `${GDT_INFO[a.char].name} ${a.dia ? 'Ø' : ''}${a.tol}`;
    case 'datum':
      return `Datum ${a.letter}`;
    case 'surface':
      return `Surface ${a.param} ${a.value}`;
    case 'centre':
      return a.hide ? 'Centre mark taken away' : 'Centre mark';
    case 'balloon':
      return `Balloon${reads ? `: ${reads}` : ''}`;
  }
}
