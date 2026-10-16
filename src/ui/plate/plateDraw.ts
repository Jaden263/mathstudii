// Drawing a plate's results: what each field is and its display unit, nice contour levels,
// the colour of each band (one blue ramp for a magnitude, blue ↔ red with a grey middle
// band for a field of both signs, steps of equal OKLCH lightness on both arms, darkest
// for the largest on a light page and the other way round on a dark one), and the bands
// themselves by marching triangles: each quad is cut into four triangles at its centre
// and every band's part of each triangle joins one path per band.
import type { PlateRegion } from '../../model/types';
import type { FieldKey, PlateFieldSet, PlateResult } from '../../plate/evaluate';
import type { PlateShow } from '../../plate/model';
import { FORCE_N, LENGTH_M, fmt } from '../beam/beamDraw';

export interface FieldInfo {
  id: Exclude<PlateShow, 'model'>;
  /** Strip button and legend title. */
  label: string;
  title: string;
  key: FieldKey;
  kind: 'defl' | 'moment' | 'shear' | 'as' | 'stress';
  /** Which side of the envelope governs. */
  side?: 'max' | 'min';
  needs?: 'rebar' | 'steel';
}

export const FIELDS: FieldInfo[] = [
  { id: 'w', label: 'w', title: 'Deflection, downwards positive', key: 'w', kind: 'defl' },
  { id: 'mx', label: 'mx', title: 'Bending moment m_x (bars along x), sagging positive', key: 'mx', kind: 'moment' },
  { id: 'my', label: 'my', title: 'Bending moment m_y (bars along y), sagging positive', key: 'my', kind: 'moment' },
  { id: 'mxy', label: 'mxy', title: 'Twisting moment m_xy', key: 'mxy', kind: 'moment' },
  { id: 'm1', label: 'm1', title: 'Larger principal moment', key: 'm1', kind: 'moment' },
  { id: 'm2', label: 'm2', title: 'Smaller principal moment', key: 'm2', kind: 'moment', side: 'min' },
  { id: 'vx', label: 'vx', title: 'Shear force v_x per length', key: 'vx', kind: 'shear' },
  { id: 'vy', label: 'vy', title: 'Shear force v_y per length', key: 'vy', kind: 'shear' },
  { id: 'mxb', label: 'mx,b', title: 'Wood–Armer design moment for the bottom bars along x', key: 'mxb', kind: 'moment', needs: 'rebar' },
  { id: 'myb', label: 'my,b', title: 'Wood–Armer design moment for the bottom bars along y', key: 'myb', kind: 'moment', needs: 'rebar' },
  { id: 'mxt', label: 'mx,t', title: 'Wood–Armer design moment for the top bars along x (hogging, negative)', key: 'mxt', kind: 'moment', side: 'min', needs: 'rebar' },
  { id: 'myt', label: 'my,t', title: 'Wood–Armer design moment for the top bars along y (hogging, negative)', key: 'myt', kind: 'moment', side: 'min', needs: 'rebar' },
  { id: 'asxb', label: 'as,x,b', title: 'Required bottom reinforcement along x (EN 1992-1-1)', key: 'asxb', kind: 'as', needs: 'rebar' },
  { id: 'asyb', label: 'as,y,b', title: 'Required bottom reinforcement along y', key: 'asyb', kind: 'as', needs: 'rebar' },
  { id: 'asxt', label: 'as,x,t', title: 'Required top reinforcement along x', key: 'asxt', kind: 'as', needs: 'rebar' },
  { id: 'asyt', label: 'as,y,t', title: 'Required top reinforcement along y', key: 'asyt', kind: 'as', needs: 'rebar' },
  { id: 'sigma', label: 'σv', title: 'Von Mises stress at the faces of a steel plate', key: 'sigma', kind: 'stress', needs: 'steel' },
];

export const fieldInfo = (show: PlateShow) => FIELDS.find((f) => f.id === show);

/** Factor from SI to the display unit, and the unit's name. */
export function displayUnit(r: Pick<PlateRegion, 'forceUnit' | 'lengthUnit'>, kind: FieldInfo['kind']): { k: number; unit: string } {
  const F = FORCE_N[r.forceUnit] ?? 1e3, L = LENGTH_M[r.lengthUnit] ?? 1;
  const metric = r.lengthUnit === 'm' || r.lengthUnit === 'cm' || r.lengthUnit === 'mm';
  switch (kind) {
    case 'defl': return metric ? { k: 1000, unit: 'mm' } : { k: 1 / 0.0254, unit: 'in' };
    // N·m/m: the length cancels, F·L/L per force unit
    case 'moment': return { k: 1 / F, unit: `${r.forceUnit}·${r.lengthUnit}/${r.lengthUnit}` };
    case 'shear': return { k: L / F, unit: `${r.forceUnit}/${r.lengthUnit}` };
    case 'as': return { k: 1e4, unit: 'cm²/m' };
    case 'stress': return { k: 1e-6, unit: 'MPa' };
  }
}

/** The field shown, for one side of an envelope (or the only solution). */
export function fieldOf(res: PlateResult | undefined, key: FieldKey, side: 'max' | 'min'): ArrayLike<number> | undefined {
  const set: PlateFieldSet | undefined = side === 'min' && res?.lower ? res.lower : res?.fields;
  return set?.[key];
}

// ---------------------------------------------------------------- colours

// blue steps of the reference palette, 100 → 700 (OKLCH L 0.905 → 0.338)
const BLUE = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
// the red arm at the same OKLCH lightness per step, in the hue of the palette's red #e34948
const RED = ['#fad6d2', '#f4c2be', '#f1aea8', '#ea9a93', '#e4857e', '#dd716a', '#d75853', '#c74845', '#b13f3c', '#9e3432', '#892b2a', '#762221', '#621b1a'];
const NEUTRAL = { light: '#f0efec', dark: '#383835' };

/** k steps of a ramp, from near zero to the largest (light → dark on a light page, reversed on a dark one). */
function steps(ramp: string[], k: number, dark: boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i < k; i++) {
    const t = k === 1 ? 1 : i / (k - 1);
    // light page: from step 150 up; dark page: from step 600 down to 100
    const idx = dark ? Math.round(10 - t * 10) : Math.round(1 + t * 11);
    out.push(ramp[Math.min(ramp.length - 1, Math.max(0, idx))]);
  }
  return out;
}

/** A tidy step: 1, 2, 2.5, 5 × 10ⁿ. */
export function niceStep(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), f = v / p;
  return (f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10) * p;
}

export interface Scale {
  /** Band edges, increasing (n + 1 of them for n bands). */
  levels: number[];
  colors: string[];
  diverging: boolean;
}

/**
 * Contour bands for values in [lo, hi] (display units). Both signs (the smaller over 5 %
 * of the larger): bands symmetric about a grey middle band ±s/2; else from 0 or the
 * least value up, one hue.
 */
export function makeScale(lo: number, hi: number, dark: boolean, bands = 10): Scale {
  const big = Math.max(Math.abs(lo), Math.abs(hi));
  if (!(big > 0)) return { levels: [-1, 1], colors: [dark ? NEUTRAL.dark : NEUTRAL.light], diverging: false };
  const diverging = lo < -0.05 * big && hi > 0.05 * big;
  if (diverging) {
    // about eight bands on the longer arm
    const s = niceStep(big / (0.8 * bands));
    const kUp = Math.max(1, Math.ceil(hi / s - 0.5)), kDown = Math.max(1, Math.ceil(-lo / s - 0.5));
    const k = Math.max(kUp, kDown);
    // edges −(kDown + ½)s … −s/2, s/2 … (kUp + ½)s; each arm's steps scaled to the longer arm
    const edges = [...Array.from({ length: kDown + 1 }, (_, i) => -(kDown - i + 0.5) * s), ...Array.from({ length: kUp + 1 }, (_, i) => (i + 0.5) * s)];
    const blue = steps(BLUE, k, dark), red = steps(RED, k, dark);
    const colors = [...Array.from({ length: kDown }, (_, i) => blue[kDown - 1 - i]), dark ? NEUTRAL.dark : NEUTRAL.light, ...red.slice(0, kUp)];
    return { levels: edges, colors, diverging };
  }
  // one sign: from zero (or the least value) to the largest magnitude, negative fields mirrored
  const neg = hi <= 0.05 * big;
  const from = neg ? Math.max(lo, -big) : Math.min(Math.max(lo, 0), hi), to = neg ? Math.min(hi, 0) : hi;
  const span = Math.abs(to - from) || big;
  const s = niceStep(span / bands);
  const a = Math.floor(Math.min(from, to) / s) * s, b = Math.ceil(Math.max(from, to) / s - 1e-9) * s;
  const n = Math.max(1, Math.round((b - a) / s));
  const levels = Array.from({ length: n + 1 }, (_, i) => a + i * s);
  const ramp = steps(BLUE, n, dark);
  return { levels, colors: neg ? ramp.slice().reverse() : ramp, diverging: false };
}

/** The colour of a value. */
export function colorOf(sc: Scale, v: number): string {
  const { levels, colors } = sc;
  if (v <= levels[0]) return colors[0];
  for (let i = 1; i < levels.length; i++) if (v <= levels[i]) return colors[i - 1];
  return colors[colors.length - 1];
}

// ---------------------------------------------------------------- bands

export interface Projector {
  (x: number, y: number): [number, number];
}

/**
 * One SVG path per band: every element cut into four triangles at its centre (a corner
 * field gives each element its own four values; a nodal one is read through its nodes),
 * each triangle clipped to each band it spans.
 */
export function bandPaths(mesh: { x: ArrayLike<number>; y: ArrayLike<number>; quads: ArrayLike<number> }, field: ArrayLike<number>, perCorner: boolean, k: number, sc: Scale, P: Projector): string[] {
  const out: string[][] = sc.colors.map(() => []);
  const { levels } = sc, nb = sc.colors.length;
  const tri = (ax: number, ay: number, av: number, bx: number, by: number, bv: number, cx: number, cy: number, cv: number) => {
    const lo = Math.min(av, bv, cv), hi = Math.max(av, bv, cv);
    let b0 = 0;
    while (b0 < nb - 1 && levels[b0 + 1] <= lo) b0++;
    for (let b = b0; b < nb; b++) {
      const l0 = b === 0 ? -Infinity : levels[b], l1 = b === nb - 1 ? Infinity : levels[b + 1];
      if (l0 > hi) break;
      let poly: [number, number, number][] = [[ax, ay, av], [bx, by, bv], [cx, cy, cv]];
      if (lo < l0) poly = clip(poly, l0, 1);
      if (hi > l1) poly = clip(poly, l1, -1);
      if (poly.length < 3) continue;
      out[b].push(`M${poly.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}Z`);
    }
  };
  const q = mesh.quads, ne = q.length / 4;
  for (let e = 0; e < ne; e++) {
    const p: [number, number][] = [], v: number[] = [];
    for (let c = 0; c < 4; c++) {
      const n = q[4 * e + c];
      p.push(P(mesh.x[n], mesh.y[n]));
      v.push(k * (perCorner ? field[4 * e + c] : field[n]));
    }
    const cx = (p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4, cy = (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4, cv = (v[0] + v[1] + v[2] + v[3]) / 4;
    for (let c = 0; c < 4; c++) {
      const d = (c + 1) % 4;
      tri(p[c][0], p[c][1], v[c], p[d][0], p[d][1], v[d], cx, cy, cv);
    }
  }
  return out.map((parts) => parts.join(''));
}

/** Keep the part of a polygon where sign · (v − level) ≥ 0. */
function clip(poly: [number, number, number][], level: number, sign: 1 | -1): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const fa = sign * (a[2] - level), fb = sign * (b[2] - level);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, level]);
    }
  }
  return out;
}

/** The zero line of a field of both signs (marching triangles at 0). */
export function zeroLine(mesh: { x: ArrayLike<number>; y: ArrayLike<number>; quads: ArrayLike<number> }, field: ArrayLike<number>, perCorner: boolean, P: Projector): string {
  const parts: string[] = [];
  const q = mesh.quads, ne = q.length / 4;
  for (let e = 0; e < ne; e++) {
    const p: [number, number][] = [], v: number[] = [];
    for (let c = 0; c < 4; c++) {
      const n = q[4 * e + c];
      p.push(P(mesh.x[n], mesh.y[n]));
      v.push(perCorner ? field[4 * e + c] : field[n]);
    }
    const g: [number, number] = [(p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4, (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4], gv = (v[0] + v[1] + v[2] + v[3]) / 4;
    for (let c = 0; c < 4; c++) {
      const d = (c + 1) % 4;
      const pts: [number, number][] = [];
      const tri: [[number, number], number][] = [[p[c], v[c]], [p[d], v[d]], [g, gv]];
      for (let i = 0; i < 3; i++) {
        const [pa, va] = tri[i], [pb, vb] = tri[(i + 1) % 3];
        if ((va > 0) !== (vb > 0)) {
          const t = va / (va - vb);
          pts.push([pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t]);
        }
      }
      if (pts.length === 2) parts.push(`M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}L${pts[1][0].toFixed(1)} ${pts[1][1].toFixed(1)}`);
    }
  }
  return parts.join('');
}

/** Where a field is largest and least: the position (corner fields at their corner's node) and value. */
export function extremesOf(mesh: { x: ArrayLike<number>; y: ArrayLike<number>; quads: ArrayLike<number> }, field: ArrayLike<number>, perCorner: boolean) {
  let hi = -Infinity, lo = Infinity, ih = 0, il = 0;
  for (let i = 0; i < field.length; i++) {
    if (field[i] > hi) { hi = field[i]; ih = i; }
    if (field[i] < lo) { lo = field[i]; il = i; }
  }
  const at = (i: number): [number, number] => {
    const n = perCorner ? mesh.quads[i] : i;
    return [mesh.x[n], mesh.y[n]];
  };
  return { max: { v: hi, at: at(ih) }, min: { v: lo, at: at(il) } };
}

/** Mesh edges, each once, as one path. */
export function meshPath(mesh: { x: ArrayLike<number>; y: ArrayLike<number>; quads: ArrayLike<number> }, P: Projector): string {
  const seen = new Set<number>(), parts: string[] = [];
  const nn = mesh.x.length, q = mesh.quads;
  for (let e = 0; e < q.length / 4; e++) {
    for (let c = 0; c < 4; c++) {
      const a = q[4 * e + c], b = q[4 * e + ((c + 1) % 4)];
      const key = Math.min(a, b) * nn + Math.max(a, b);
      if (seen.has(key)) continue;
      seen.add(key);
      const [x1, y1] = P(mesh.x[a], mesh.y[a]), [x2, y2] = P(mesh.x[b], mesh.y[b]);
      parts.push(`M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`);
    }
  }
  return parts.join('');
}

/** A legend label: fmt, with −0 shown as 0. */
export const levelText = (v: number) => (Math.abs(v) < 1e-12 ? '0' : fmt(v));
