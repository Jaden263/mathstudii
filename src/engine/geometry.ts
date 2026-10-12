// Plane geometry for sketches: parametric cross-section templates and exact
// section properties of composite shapes (polygons and circles, with holes).
// Pure numbers in the sketch's length unit; no mathjs here.

export interface Pt {
  x: number;
  y: number;
}

/** A filled area: a polygon (any orientation) or a circle. sign −1 = hole. */
export type Primitive =
  | { kind: 'poly'; pts: Pt[]; sign: 1 | -1 }
  | { kind: 'circle'; c: Pt; r: number; sign: 1 | -1 };

export type SectionTemplate = 'rect' | 'circle' | 'tube' | 'rhs' | 'I' | 'T' | 'C' | 'L';

export interface TemplateInfo {
  label: string;
  /** Parameter names with defaults (in mm) and descriptions. */
  params: { key: string; label: string; default: number }[];
}

export const TEMPLATES: Record<SectionTemplate, TemplateInfo> = {
  rect: { label: 'Rectangle', params: [{ key: 'b', label: 'width b', default: 200 }, { key: 'h', label: 'height h', default: 400 }] },
  circle: { label: 'Circle', params: [{ key: 'd', label: 'diameter d', default: 200 }] },
  tube: { label: 'Circular hollow', params: [{ key: 'd', label: 'outer diameter d', default: 168.3 }, { key: 't', label: 'wall t', default: 8 }] },
  rhs: {
    label: 'Rectangular hollow',
    params: [{ key: 'b', label: 'width b', default: 150 }, { key: 'h', label: 'height h', default: 250 }, { key: 't', label: 'wall t', default: 10 }],
  },
  I: {
    label: 'I / H beam',
    params: [
      { key: 'h', label: 'height h', default: 300 }, { key: 'b', label: 'flange width b', default: 150 },
      { key: 'tw', label: 'web tw', default: 7.1 }, { key: 'tf', label: 'flange tf', default: 10.7 },
    ],
  },
  T: {
    label: 'T section',
    params: [
      { key: 'h', label: 'height h', default: 200 }, { key: 'b', label: 'flange width b', default: 200 },
      { key: 'tw', label: 'web tw', default: 10 }, { key: 'tf', label: 'flange tf', default: 15 },
    ],
  },
  C: {
    label: 'Channel',
    params: [
      { key: 'h', label: 'height h', default: 200 }, { key: 'b', label: 'flange width b', default: 75 },
      { key: 'tw', label: 'web tw', default: 8.5 }, { key: 'tf', label: 'flange tf', default: 11.5 },
    ],
  },
  L: {
    label: 'Angle',
    params: [{ key: 'h', label: 'leg h', default: 100 }, { key: 'b', label: 'leg b', default: 100 }, { key: 't', label: 'thickness t', default: 10 }],
  },
};

const rectPts = (cx: number, cy: number, w: number, h: number): Pt[] => [
  { x: cx - w / 2, y: cy - h / 2 }, { x: cx + w / 2, y: cy - h / 2 },
  { x: cx + w / 2, y: cy + h / 2 }, { x: cx - w / 2, y: cy + h / 2 },
];

function need(p: Record<string, number>, keys: string[]): number[] {
  return keys.map((k) => {
    const v = p[k];
    if (!Number.isFinite(v) || v <= 0) throw new Error(`${k} must be a positive length`);
    return v;
  });
}

/**
 * Template geometry in local coordinates (bounding box centred on the origin).
 * Throws for impossible dimensions, e.g. a wall thicker than half the width.
 */
export function templatePrimitives(t: SectionTemplate, p: Record<string, number>): Primitive[] {
  switch (t) {
    case 'rect': {
      const [b, h] = need(p, ['b', 'h']);
      return [{ kind: 'poly', pts: rectPts(0, 0, b, h), sign: 1 }];
    }
    case 'circle': {
      const [d] = need(p, ['d']);
      return [{ kind: 'circle', c: { x: 0, y: 0 }, r: d / 2, sign: 1 }];
    }
    case 'tube': {
      const [d, tt] = need(p, ['d', 't']);
      if (2 * tt >= d) throw new Error('wall t must be less than d/2');
      return [
        { kind: 'circle', c: { x: 0, y: 0 }, r: d / 2, sign: 1 },
        { kind: 'circle', c: { x: 0, y: 0 }, r: d / 2 - tt, sign: -1 },
      ];
    }
    case 'rhs': {
      const [b, h, tt] = need(p, ['b', 'h', 't']);
      if (2 * tt >= Math.min(b, h)) throw new Error('wall t must be less than half of b and h');
      return [
        { kind: 'poly', pts: rectPts(0, 0, b, h), sign: 1 },
        { kind: 'poly', pts: rectPts(0, 0, b - 2 * tt, h - 2 * tt), sign: -1 },
      ];
    }
    case 'I': {
      const [h, b, tw, tf] = need(p, ['h', 'b', 'tw', 'tf']);
      if (2 * tf >= h || tw >= b) throw new Error('flanges/web too thick for the section size');
      const H = h / 2, B = b / 2, W = tw / 2, F = H - tf;
      return [{
        kind: 'poly', sign: 1,
        pts: [
          { x: -B, y: -H }, { x: B, y: -H }, { x: B, y: -F }, { x: W, y: -F }, { x: W, y: F }, { x: B, y: F },
          { x: B, y: H }, { x: -B, y: H }, { x: -B, y: F }, { x: -W, y: F }, { x: -W, y: -F }, { x: -B, y: -F },
        ],
      }];
    }
    case 'T': {
      const [h, b, tw, tf] = need(p, ['h', 'b', 'tw', 'tf']);
      if (tf >= h || tw >= b) throw new Error('flange/web too thick for the section size');
      const H = h / 2, B = b / 2, W = tw / 2, F = H - tf;
      return [{
        kind: 'poly', sign: 1,
        pts: [{ x: -W, y: -H }, { x: W, y: -H }, { x: W, y: F }, { x: B, y: F }, { x: B, y: H }, { x: -B, y: H }, { x: -B, y: F }, { x: -W, y: F }],
      }];
    }
    case 'C': {
      const [h, b, tw, tf] = need(p, ['h', 'b', 'tw', 'tf']);
      if (2 * tf >= h || tw >= b) throw new Error('flanges/web too thick for the section size');
      const H = h / 2, B = b / 2, F = H - tf;
      return [{
        kind: 'poly', sign: 1,
        pts: [{ x: -B, y: -H }, { x: B, y: -H }, { x: B, y: -F }, { x: -B + tw, y: -F }, { x: -B + tw, y: F }, { x: B, y: F }, { x: B, y: H }, { x: -B, y: H }],
      }];
    }
    case 'L': {
      const [h, b, tt] = need(p, ['h', 'b', 't']);
      if (tt >= Math.min(h, b)) throw new Error('thickness t must be less than both legs');
      const H = h / 2, B = b / 2;
      return [{
        kind: 'poly', sign: 1,
        pts: [{ x: -B, y: -H }, { x: B, y: -H }, { x: B, y: -H + tt }, { x: -B + tt, y: -H + tt }, { x: -B + tt, y: H }, { x: -B, y: H }],
      }];
    }
  }
}

/** Rotate (degrees, counter-clockwise) and translate primitives. */
export function placePrimitives(prims: Primitive[], at: Pt, rotDeg: number): Primitive[] {
  const a = (rotDeg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const tf = (p: Pt): Pt => ({ x: at.x + p.x * c - p.y * s, y: at.y + p.x * s + p.y * c });
  return prims.map((q) => (q.kind === 'poly' ? { ...q, pts: q.pts.map(tf) } : { ...q, c: tf(q.c) }));
}

export interface SectionProps {
  A: number;
  xc: number;
  yc: number;
  /** Second moments about centroidal axes parallel to x and y. */
  Ix: number;
  Iy: number;
  Ixy: number;
  /** Principal moments (I1 ≥ I2) and the angle of the I1 axis from x, degrees. */
  I1: number;
  I2: number;
  theta: number;
  /** Polar moment about the centroid (Ix + Iy). */
  J: number;
  /** Elastic section moduli to the extreme fibres (minimum of both sides). */
  Wx: number;
  Wy: number;
  rx: number;
  ry: number;
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

/** Exact properties of a composite area (Green's theorem for polygons, closed form for circles). */
export function sectionProperties(prims: Primitive[]): SectionProps | null {
  let A = 0, Qx = 0, Qy = 0, Ixx = 0, Iyy = 0, Ixy = 0;
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const p of prims) {
    if (p.kind === 'circle') {
      const a = Math.PI * p.r * p.r;
      const i0 = (Math.PI * p.r ** 4) / 4;
      A += p.sign * a;
      Qx += p.sign * a * p.c.y;
      Qy += p.sign * a * p.c.x;
      Ixx += p.sign * (i0 + a * p.c.y ** 2);
      Iyy += p.sign * (i0 + a * p.c.x ** 2);
      Ixy += p.sign * a * p.c.x * p.c.y;
      if (p.sign > 0) {
        xmin = Math.min(xmin, p.c.x - p.r); xmax = Math.max(xmax, p.c.x + p.r);
        ymin = Math.min(ymin, p.c.y - p.r); ymax = Math.max(ymax, p.c.y + p.r);
      }
      continue;
    }
    const pts = p.pts;
    if (pts.length < 3) continue;
    let a = 0, qx = 0, qy = 0, ixx = 0, iyy = 0, ixy = 0;
    for (let i = 0; i < pts.length; i++) {
      const { x: x0, y: y0 } = pts[i];
      const { x: x1, y: y1 } = pts[(i + 1) % pts.length];
      const cr = x0 * y1 - x1 * y0;
      a += cr / 2;
      qy += ((x0 + x1) * cr) / 6;
      qx += ((y0 + y1) * cr) / 6;
      ixx += ((y0 * y0 + y0 * y1 + y1 * y1) * cr) / 12;
      iyy += ((x0 * x0 + x0 * x1 + x1 * x1) * cr) / 12;
      ixy += ((x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * cr) / 24;
    }
    // orientation-independent: a clockwise outline gives negative values
    const o = a < 0 ? -1 : 1;
    const k = o * p.sign;
    A += k * a; Qx += k * qx; Qy += k * qy; Ixx += k * ixx; Iyy += k * iyy; Ixy += k * ixy;
    if (p.sign > 0) {
      for (const q of pts) {
        xmin = Math.min(xmin, q.x); xmax = Math.max(xmax, q.x);
        ymin = Math.min(ymin, q.y); ymax = Math.max(ymax, q.y);
      }
    }
  }
  if (!(A > 1e-12 * Math.max(1, Math.abs(Ixx)))) return null;
  const xc = Qy / A, yc = Qx / A;
  const Ix = Ixx - A * yc * yc;
  const Iy = Iyy - A * xc * xc;
  const Ixyc = Ixy - A * xc * yc;
  const avg = (Ix + Iy) / 2;
  const R = Math.hypot((Ix - Iy) / 2, Ixyc);
  const theta = (0.5 * Math.atan2(-2 * Ixyc, Ix - Iy) * 180) / Math.PI;
  const clean = (v: number) => (Math.abs(v) < 1e-9 * (Math.abs(Ix) + Math.abs(Iy)) ? 0 : v);
  return {
    A, xc: cleanCoord(xc, xmax - xmin), yc: cleanCoord(yc, ymax - ymin),
    Ix, Iy, Ixy: clean(Ixyc), I1: avg + R, I2: avg - R, theta: clean(theta), J: Ix + Iy,
    Wx: Ix / Math.max(ymax - yc, yc - ymin), Wy: Iy / Math.max(xmax - xc, xc - xmin),
    rx: Math.sqrt(Ix / A), ry: Math.sqrt(Iy / A), xmin, xmax, ymin, ymax,
  };
}

function cleanCoord(v: number, span: number) {
  return Math.abs(v) < 1e-12 * Math.max(1, span) ? 0 : v;
}

/** Polygon outline of a circle for drawing. */
export function circlePts(c: Pt, r: number, n = 72): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
  });
}
