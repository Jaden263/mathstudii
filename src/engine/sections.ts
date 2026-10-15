// Steel sections: European rolled I and H sections from their nominal dimensions, and
// hollow sections (CHS, SHS, RHS) of any size. Properties are integrated from the real
// outline (root radii and corner radii included as arcs), so they match the catalogues
// to within rounding, and torsion constants use the usual closed-form expressions.
// Everything here is plain numbers in millimetres (no mathjs), so the page can use it.

export interface SectionProps {
  name: string;
  family: 'I' | 'CHS' | 'RHS';
  /** Dimensions, mm. */
  h: number;
  b: number;
  t_w: number;
  t_f: number;
  r: number;
  /** Area mm², shear area for loads along z (web) mm². */
  A: number;
  A_vz: number;
  /** Second moments mm⁴ (y = strong axis), elastic and plastic moduli mm³, radii of gyration mm. */
  I_y: number;
  I_z: number;
  W_el_y: number;
  W_el_z: number;
  W_pl_y: number;
  W_pl_z: number;
  i_y: number;
  i_z: number;
  /** St Venant torsion constant mm⁴ and warping constant mm⁶. */
  I_t: number;
  I_w: number;
  /** Mass per metre in kg/m (7850 kg/m³). */
  mass: number;
  /** Outer surface per metre, m²/m (painting, fire). */
  surface: number;
}

// h, b, t_w, t_f, r (mm)
type Dims = [number, number, number, number, number];

const IPE: Record<string, Dims> = {
  80: [80, 46, 3.8, 5.2, 5], 100: [100, 55, 4.1, 5.7, 7], 120: [120, 64, 4.4, 6.3, 7], 140: [140, 73, 4.7, 6.9, 7],
  160: [160, 82, 5.0, 7.4, 9], 180: [180, 91, 5.3, 8.0, 9], 200: [200, 100, 5.6, 8.5, 12], 220: [220, 110, 5.9, 9.2, 12],
  240: [240, 120, 6.2, 9.8, 15], 270: [270, 135, 6.6, 10.2, 15], 300: [300, 150, 7.1, 10.7, 15], 330: [330, 160, 7.5, 11.5, 18],
  360: [360, 170, 8.0, 12.7, 18], 400: [400, 180, 8.6, 13.5, 21], 450: [450, 190, 9.4, 14.6, 21], 500: [500, 200, 10.2, 16.0, 21],
  550: [550, 210, 11.1, 17.2, 24], 600: [600, 220, 12.0, 19.0, 24],
};

const HEA: Record<string, Dims> = {
  100: [96, 100, 5, 8, 12], 120: [114, 120, 5, 8, 12], 140: [133, 140, 5.5, 8.5, 12], 160: [152, 160, 6, 9, 15],
  180: [171, 180, 6, 9.5, 15], 200: [190, 200, 6.5, 10, 18], 220: [210, 220, 7, 11, 18], 240: [230, 240, 7.5, 12, 21],
  260: [250, 260, 7.5, 12.5, 24], 280: [270, 280, 8, 13, 24], 300: [290, 300, 8.5, 14, 27], 320: [310, 300, 9, 15.5, 27],
  340: [330, 300, 9.5, 16.5, 27], 360: [350, 300, 10, 17.5, 27], 400: [390, 300, 11, 19, 27], 450: [440, 300, 11.5, 21, 27],
  500: [490, 300, 12, 23, 27], 550: [540, 300, 12.5, 24, 27], 600: [590, 300, 13, 25, 27], 650: [640, 300, 13.5, 26, 27],
  700: [690, 300, 14.5, 27, 27], 800: [790, 300, 15, 28, 30], 900: [890, 300, 16, 30, 30], 1000: [990, 300, 16.5, 31, 30],
};

const HEB: Record<string, Dims> = {
  100: [100, 100, 6, 10, 12], 120: [120, 120, 6.5, 11, 12], 140: [140, 140, 7, 12, 12], 160: [160, 160, 8, 13, 15],
  180: [180, 180, 8.5, 14, 15], 200: [200, 200, 9, 15, 18], 220: [220, 220, 9.5, 16, 18], 240: [240, 240, 10, 17, 21],
  260: [260, 260, 10, 17.5, 24], 280: [280, 280, 10.5, 18, 24], 300: [300, 300, 11, 19, 27], 320: [320, 300, 11.5, 20.5, 27],
  340: [340, 300, 12, 21.5, 27], 360: [360, 300, 12.5, 22.5, 27], 400: [400, 300, 13.5, 24, 27], 450: [450, 300, 14, 26, 27],
  500: [500, 300, 14.5, 28, 27], 550: [550, 300, 15, 29, 27], 600: [600, 300, 15.5, 30, 27], 650: [650, 300, 16, 31, 27],
  700: [700, 300, 17, 32, 27], 800: [800, 300, 17.5, 33, 30], 900: [900, 300, 18.5, 35, 30], 1000: [1000, 300, 19, 36, 30],
};

const HEM: Record<string, Dims> = {
  100: [120, 106, 12, 20, 12], 120: [140, 126, 12.5, 21, 12], 140: [160, 146, 13, 22, 12], 160: [180, 166, 14, 23, 15],
  180: [200, 186, 14.5, 24, 15], 200: [220, 206, 15, 25, 18], 220: [240, 226, 15.5, 26, 18], 240: [270, 248, 18, 32, 21],
  260: [290, 268, 18, 32.5, 24], 280: [310, 288, 18.5, 33, 24], 300: [340, 310, 21, 39, 27], 320: [359, 309, 21, 40, 27],
  340: [377, 309, 21, 40, 27], 360: [395, 308, 21, 40, 27], 400: [432, 307, 21, 40, 27], 450: [478, 307, 21, 40, 27],
  500: [524, 306, 21, 40, 27], 550: [572, 306, 21, 40, 27], 600: [620, 305, 21, 40, 27],
};

const FAMILIES: Record<string, Record<string, Dims>> = { IPE, HEA, HEB, HEM };

/** Every rolled section name, for lists ("IPE 80" … "HEM 600"). */
export const ROLLED_SECTIONS: string[] = Object.entries(FAMILIES).flatMap(([f, t]) => Object.keys(t).map((k) => `${f} ${k}`));

// ---------------------------------------------------------------- outline integration

type Pt = [number, number];

/** Quarter arc from angle a0 to a1 (radians) around (cx, cy). */
function arc(cx: number, cy: number, r: number, a0: number, a1: number, n = 24): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

interface Integrals {
  A: number;
  Iy: number;
  Iz: number;
}

/** Area and second moments about the origin of a closed polygon (counter-clockwise positive). */
function integrate(poly: Pt[]): Integrals {
  let A = 0, Iy = 0, Iz = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    const c = x0 * y1 - x1 * y0;
    A += c / 2;
    Iy += (c * (y0 * y0 + y0 * y1 + y1 * y1)) / 12; // about the horizontal axis (bending about y uses z = vertical)
    Iz += (c * (x0 * x0 + x0 * x1 + x1 * x1)) / 12;
  }
  return { A, Iy, Iz };
}

/** First moment of the part of the polygon above the x axis (y > 0), for plastic moduli. */
function firstMomentAbove(poly: Pt[], axis: 'x' | 'y'): number {
  // clip to the half-plane (y ≥ 0, or x ≥ 0 for the other axis), then ∫ y dA
  const get = (p: Pt) => (axis === 'x' ? p[1] : p[0]);
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const dp = get(p), dq = get(q);
    if (dp >= 0) out.push(p);
    if ((dp >= 0) !== (dq >= 0)) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  let S = 0;
  for (let i = 0; i < out.length; i++) {
    const [x0, y0] = out[i], [x1, y1] = out[(i + 1) % out.length];
    const c = x0 * y1 - x1 * y0;
    S += axis === 'x' ? (c * (y0 + y1)) / 6 : (c * (x0 + x1)) / 6;
  }
  return Math.abs(S);
}

/** Outline of a doubly symmetric I section centred on the origin (counter-clockwise). */
function iOutline([h, b, tw, tf, r]: Dims): Pt[] {
  const H = h / 2, B = b / 2, w = tw / 2, yf = H - tf;
  // right half from the bottom flange tip up to the top flange tip, then mirrored
  const right: Pt[] = [
    [B, -H], [B, -yf],
    ...arc(w + r, -yf + r, r, -Math.PI / 2, -Math.PI, 24).map(([x, y]) => [x, y] as Pt),
    ...arc(w + r, yf - r, r, Math.PI, Math.PI / 2, 24),
    [B, yf], [B, H],
  ];
  const left = right.map(([x, y]) => [-x, y] as Pt).reverse();
  return [...right, ...left];
}

function roundedRect(b: number, h: number, r: number): Pt[] {
  const X = b / 2, Y = h / 2;
  if (r <= 0) return [[X, -Y], [X, Y], [-X, Y], [-X, -Y]];
  return [
    ...arc(X - r, -Y + r, r, -Math.PI / 2, 0),
    ...arc(X - r, Y - r, r, 0, Math.PI / 2),
    ...arc(-X + r, Y - r, r, Math.PI / 2, Math.PI),
    ...arc(-X + r, -Y + r, r, Math.PI, 1.5 * Math.PI),
  ];
}

function perimeter(poly: Pt[]): number {
  let p = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    p += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return p;
}

/** Properties of a doubly symmetric outline with an optional hole (both centred). */
function fromOutline(outer: Pt[], inner: Pt[] | null) {
  const o = integrate(outer), i = inner ? integrate(inner) : { A: 0, Iy: 0, Iz: 0 };
  const A = o.A - i.A, Iy = o.Iy - i.Iy, Iz = o.Iz - i.Iz;
  const Spy = firstMomentAbove(outer, 'x') - (inner ? firstMomentAbove(inner, 'x') : 0);
  const Spz = firstMomentAbove(outer, 'y') - (inner ? firstMomentAbove(inner, 'y') : 0);
  return { A, Iy, Iz, Wply: 2 * Spy, Wplz: 2 * Spz };
}

function finish(name: string, family: SectionProps['family'], d: { h: number; b: number; t_w: number; t_f: number; r: number }, p: ReturnType<typeof fromOutline>, extra: { A_vz: number; I_t: number; I_w: number; surface: number }): SectionProps {
  return {
    name, family, ...d,
    A: p.A, A_vz: extra.A_vz, I_y: p.Iy, I_z: p.Iz,
    W_el_y: p.Iy / (d.h / 2), W_el_z: p.Iz / (d.b / 2), W_pl_y: p.Wply, W_pl_z: p.Wplz,
    i_y: Math.sqrt(p.Iy / p.A), i_z: Math.sqrt(p.Iz / p.A),
    I_t: extra.I_t, I_w: extra.I_w, mass: (p.A * 1e-6) * 7850, surface: extra.surface,
  };
}

function iSection(name: string, dims: Dims): SectionProps {
  const [h, b, tw, tf, r] = dims;
  const outline = iOutline(dims);
  const p = fromOutline(outline, null);
  // EN 1993-1-1 6.2.6(3)a: A − 2 b t_f + (t_w + 2r) t_f, at least h_w t_w
  const A_vz = Math.max(p.A - 2 * b * tf + (tw + 2 * r) * tf, (h - 2 * tf) * tw);
  // torsion: thin plates plus the root fillet correction (as in the ArcelorMittal catalogue)
  const alpha = ((r + tw / 2) ** 2 + (r + tf) ** 2 - r * r) / (2 * r + tf);
  const I_t = (2 / 3) * (b - 0.63 * tf) * tf ** 3 + (1 / 3) * (h - 2 * tf) * tw ** 3 + 2 * (tw / tf) * (0.145 + 0.1 * (r / tf)) * alpha ** 4;
  const I_w = (p.Iz * (h - tf) ** 2) / 4;
  const surface = perimeter(outline) / 1000;
  return finish(name, 'I', { h, b, t_w: tw, t_f: tf, r }, p, { A_vz, I_t, I_w, surface });
}

function chs(name: string, D: number, t: number): SectionProps {
  if (!(t > 0 && 2 * t < D)) throw new Error(`${name}: the wall must be thinner than half the diameter`);
  // exact values for a ring
  const d = D - 2 * t;
  const I = (Math.PI / 64) * (D ** 4 - d ** 4);
  const exact = { A: (Math.PI / 4) * (D * D - d * d), Iy: I, Iz: I, Wply: (D ** 3 - d ** 3) / 6, Wplz: (D ** 3 - d ** 3) / 6 };
  return finish(name, 'CHS', { h: D, b: D, t_w: t, t_f: t, r: D / 2 }, exact, { A_vz: (2 * exact.A) / Math.PI, I_t: 2 * I, I_w: 0, surface: (Math.PI * D) / 1000 });
}

/** Hot-finished hollow section (EN 10210-2: outer corner radius 1.5 t, inner t). */
function rhs(name: string, h: number, b: number, t: number): SectionProps {
  if (!(t > 0 && 2 * t < Math.min(b, h))) throw new Error(`${name}: the wall must be thinner than half the width`);
  const ro = 1.5 * t, ri = t;
  const outer = roundedRect(b, h, ro), inner = roundedRect(b - 2 * t, h - 2 * t, ri);
  const p = fromOutline(outer, inner);
  // Bredt: I_t = 4 A_h² t / p_h on the mid-line (corner radius (ro + ri)/2), plus the thin-wall term
  const rm = (ro + ri) / 2;
  const hm = h - t, bm = b - t;
  const Ah = hm * bm - (4 - Math.PI) * rm * rm;
  const ph = 2 * (hm + bm) - 2 * (4 - Math.PI) * rm;
  const I_t = (4 * Ah * Ah * t) / ph + (ph * t ** 3) / 3;
  const surface = perimeter(outer) / 1000;
  return finish(name, 'RHS', { h, b, t_w: t, t_f: t, r: ro }, p, { A_vz: (p.A * h) / (b + h), I_t, I_w: 0, surface });
}

const cache = new Map<string, SectionProps>();

/**
 * Properties of a named section: "IPE 300", "HEB200", "HE 200 B", "CHS 168.3x5",
 * "SHS 100x5", "RHS 200x100x6.3". Throws with a helpful message when unknown.
 */
export function sectionProps(name: string): SectionProps {
  const key = name.trim().toUpperCase().replace(/[×*]/g, 'X').replace(/,/g, '.');
  const hit = cache.get(key);
  if (hit) return hit;
  let res: SectionProps | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^(IPE|HEA|HEB|HEM)\s*(\d+)$/.exec(key.replace(/\s+/g, ' ')))) {
    const d = FAMILIES[m[1]][m[2]];
    if (!d) throw new Error(`${m[1]} ${m[2]} is not a standard size (${Object.keys(FAMILIES[m[1]]).join(', ')})`);
    res = iSection(`${m[1]} ${m[2]}`, d);
  } else if ((m = /^HE\s*(\d+)\s*([ABM])$/.exec(key))) {
    return sectionProps(`HE${m[2]} ${m[1]}`);
  } else if ((m = /^CHS\s*([\d.]+)\s*X\s*([\d.]+)$/.exec(key))) {
    res = chs(`CHS ${m[1]}×${m[2]}`, +m[1], +m[2]);
  } else if ((m = /^SHS\s*([\d.]+)\s*X\s*([\d.]+)$/.exec(key))) {
    res = rhs(`SHS ${m[1]}×${m[2]}`, +m[1], +m[1], +m[2]);
  } else if ((m = /^RHS\s*([\d.]+)\s*X\s*([\d.]+)\s*X\s*([\d.]+)$/.exec(key))) {
    res = rhs(`RHS ${m[1]}×${m[2]}×${m[3]}`, +m[1], +m[2], +m[3]);
  }
  if (!res) throw new Error(`Unknown section "${name}". Try "IPE 300", "HEB 200", "HEA 240", "HEM 160", "CHS 168.3x5", "SHS 100x5" or "RHS 200x100x6.3"`);
  cache.set(key, res);
  return res;
}
