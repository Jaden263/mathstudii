// ISO metric screw threads: the sizes of ISO 262 (selected sizes for screws, bolts and
// nuts, from the general plan of ISO 261), coarse and fine series M1.6–M64, and the
// dimensions of the basic profile of ISO 68-1 (ISO 724):
//
//   H  = √3/2 · P = 0.866025 P        height of the fundamental triangle
//   d2 = d − 3/4 H = d − 0.649519 P   pitch diameter (D2 the same)
//   d1 = d − 5/4 H = d − 1.082532 P   basic minor diameter (D1 of the nut)
//   d3 = d1 − H/6  = d − 1.226869 P   minor diameter of the bolt (ISO 898-1, for A_s)
//   A_s = π/4 · ((d2 + d3)/2)²        tensile stress area (ISO 898-1)
//
// The basic profile has flanks at 60°, a flat of P/8 at the major diameter and of P/4 at
// the minor diameter. Tap drills are d − P (M10: 8.5 mm), the usual workshop rule.
// Sizes are in millimetres.

/** Coarse pitch and fine pitches (ISO 262, first and second choice). */
export const ISO_METRIC: { d: number; coarse: number; fine: number[] }[] = [
  { d: 1.6, coarse: 0.35, fine: [] },
  { d: 2, coarse: 0.4, fine: [] },
  { d: 2.5, coarse: 0.45, fine: [] },
  { d: 3, coarse: 0.5, fine: [] },
  { d: 3.5, coarse: 0.6, fine: [] },
  { d: 4, coarse: 0.7, fine: [] },
  { d: 5, coarse: 0.8, fine: [] },
  { d: 6, coarse: 1, fine: [] },
  { d: 8, coarse: 1.25, fine: [1] },
  { d: 10, coarse: 1.5, fine: [1.25, 1] },
  { d: 12, coarse: 1.75, fine: [1.5, 1.25] },
  { d: 14, coarse: 2, fine: [1.5] },
  { d: 16, coarse: 2, fine: [1.5] },
  { d: 18, coarse: 2.5, fine: [2, 1.5] },
  { d: 20, coarse: 2.5, fine: [2, 1.5] },
  { d: 22, coarse: 2.5, fine: [2, 1.5] },
  { d: 24, coarse: 3, fine: [2] },
  { d: 27, coarse: 3, fine: [2] },
  { d: 30, coarse: 3.5, fine: [2] },
  { d: 33, coarse: 3.5, fine: [2] },
  { d: 36, coarse: 4, fine: [3] },
  { d: 39, coarse: 4, fine: [3] },
  { d: 42, coarse: 4.5, fine: [3] },
  { d: 45, coarse: 4.5, fine: [3] },
  { d: 48, coarse: 5, fine: [3] },
  { d: 52, coarse: 5, fine: [4] },
  { d: 56, coarse: 5.5, fine: [4] },
  { d: 60, coarse: 5.5, fine: [4] },
  { d: 64, coarse: 6, fine: [4] },
];

/** A thread size and its basic dimensions (mm, mm²). */
export interface ThreadSize {
  /** "M12" for the coarse series, "M12x1.25" for a fine one. */
  name: string;
  d: number;
  P: number;
  fine: boolean;
  H: number;
  d2: number;
  d1: number;
  d3: number;
  As: number;
  /** Tap drill: d − P. */
  drill: number;
}

const num = (v: number) => String(+v.toFixed(3));

/** The basic dimensions of M d × P. */
export function threadSize(d: number, P: number, fine = false): ThreadSize {
  const H = (Math.sqrt(3) / 2) * P;
  const d2 = d - (3 / 4) * H;
  const d1 = d - (5 / 4) * H;
  const d3 = d1 - H / 6;
  return {
    name: fine ? `M${num(d)}x${num(P)}` : `M${num(d)}`,
    d, P, fine, H, d2, d1, d3,
    As: (Math.PI / 4) * ((d2 + d3) / 2) ** 2,
    drill: d - P,
  };
}

/** Every size of the table, coarse then fine, by diameter. */
export function threadSizes(): ThreadSize[] {
  return ISO_METRIC.flatMap((r) => [threadSize(r.d, r.coarse), ...r.fine.map((P) => threadSize(r.d, P, true))]);
}

/**
 * A designation read: "M12" (coarse), "M12x1.25", "M12×1.25", "m 12 x 1,25". Throws for
 * sizes and pitches that are not in ISO 262, saying which are.
 */
export function parseThread(text: string): ThreadSize {
  const m = /^\s*M\s*(\d+(?:[.,]\d+)?)\s*(?:[x×*]\s*(\d+(?:[.,]\d+)?))?\s*$/i.exec(text);
  if (!m) throw new Error(`“${text.trim()}” is not a metric thread: write it as M12 or M12x1.25`);
  const d = Number(m[1].replace(',', '.'));
  const row = ISO_METRIC.find((r) => Math.abs(r.d - d) < 1e-9);
  if (!row) throw new Error(`M${num(d)} is not an ISO 262 size (M1.6 to M64)`);
  if (!m[2]) return threadSize(row.d, row.coarse);
  const P = Number(m[2].replace(',', '.'));
  if (Math.abs(P - row.coarse) < 1e-9) return threadSize(row.d, row.coarse);
  if (row.fine.some((q) => Math.abs(q - P) < 1e-9)) return threadSize(row.d, P, true);
  throw new Error(`M${num(d)}×${num(P)} is not an ISO 262 size: M${num(d)} has the coarse pitch ${num(row.coarse)} mm${row.fine.length ? ` and the fine ${row.fine.map(num).join(', ')} mm` : ''}`);
}

/**
 * The size that fits a cylinder of diameter D (mm): an external thread whose major diameter
 * it is, or an internal one whose tap drill (or minor diameter) the hole is. Coarse pitches
 * first; null when none is within 2 % (external) or between D1 and the major diameter.
 */
export function threadFor(D: number, internal: boolean): ThreadSize | null {
  const sizes = threadSizes();
  if (!internal) return sizes.find((s) => Math.abs(s.d - D) <= 0.02 * s.d) ?? null;
  // a hole between the minor diameter and the major one takes the thread, the one drilled
  // nearest to its tap drill first
  const fits = sizes.filter((s) => D >= s.d1 - 0.02 * s.d && D < s.d).sort((a, b) => Math.abs(a.drill - D) - Math.abs(b.drill - D) || +a.fine - +b.fine);
  return fits[0] ?? null;
}

/**
 * Width of the groove between the teeth of the basic profile at radius r (mm, from the
 * axis): for a bolt, P/4 at the minor diameter d1 widening by 2 tan 30° per mm outwards
 * (7P/8 at the major diameter); for a nut, P/8 at the major diameter widening inwards
 * (3P/4 at D1).
 */
export function grooveWidth(s: ThreadSize, r: number, internal: boolean): number {
  const t30 = Math.tan(Math.PI / 6);
  return internal ? s.P / 8 + 2 * (s.d / 2 - r) * t30 : s.P / 4 + 2 * (r - s.d1 / 2) * t30;
}

/**
 * Cross-section area a thread takes away per unit length along its axis, between radii r0
 * and r1: (2π/P) ∫ r w(r) dr, w the groove width (a screw-shaped groove of section A at
 * radius r removes 2π r A per turn of pitch P). Exact: w is linear in r.
 */
export function grooveArea(s: ThreadSize, r0: number, r1: number, internal: boolean): number {
  // ∫ r (α + β r) dr with w = α + β r
  const w0 = grooveWidth(s, 0, internal), beta = (grooveWidth(s, 1, internal) - w0);
  const F = (r: number) => (w0 * r * r) / 2 + (beta * r ** 3) / 3;
  return ((2 * Math.PI) / s.P) * (F(r1) - F(r0));
}

/** Millimetres in one part unit. */
export const MM_PER: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4 };

/** A size in part units (its lengths divided by the millimetres in one unit, A_s by their square). */
export function threadIn(s: ThreadSize, unit = 'mm'): ThreadSize {
  const k = 1 / (MM_PER[unit] ?? 1);
  if (k === 1) return s;
  return { ...s, d: s.d * k, P: s.P * k, H: s.H * k, d2: s.d2 * k, d1: s.d1 * k, d3: s.d3 * k, As: s.As * k * k, drill: s.drill * k };
}
