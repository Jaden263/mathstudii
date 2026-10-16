// Plates and slabs: an outline with openings, a thickness and material, supports along
// its edges, on walls and columns, and loads, solved by finite elements. Plain JSON like
// the rest of the worksheet; every value is a worksheet expression, so the slab follows
// the calculation around it. Bare numbers take the region's units: coordinates the length
// unit, area loads force/length², line loads force/length, forces the force unit; the
// thickness, column sizes, cover and bars mm; E GPa; densities kg/m³.
import type { BeamCases, BeamForceUnit, BeamLengthUnit } from '../beam/model';
import { beamId, defaultCases } from '../beam/model';

export type { BeamCases as PlateCases };

export interface PlatePoint {
  x: string;
  y: string;
}

/** How an outline edge is held: free, simply supported (w = 0), clamped, or on springs. */
export type EdgeSupport = 'free' | 'simple' | 'clamped' | 'spring';
export const EDGE_SUPPORTS: { id: EdgeSupport; label: string }[] = [
  { id: 'free', label: 'Free' },
  { id: 'simple', label: 'Simply supported' },
  { id: 'clamped', label: 'Clamped' },
  { id: 'spring', label: 'Elastic (spring)' },
];

/** The support of the outline edge from corner i to corner i + 1. */
export interface PlateEdge {
  support: EdgeSupport;
  /** Spring per length (bare number force/length²) and against rotation about the edge (force·length/length per rad). */
  k?: string;
  kr?: string;
}

export interface PlateOpening {
  id: string;
  name: string;
  points: PlatePoint[];
}

/** A wall under the plate: a line support inside it, rigid or a spring per length. */
export interface PlateWall {
  id: string;
  name: string;
  a: PlatePoint;
  b: PlatePoint;
  k?: string;
}

/**
 * A column: a point support (rigid, or a spring k), or with a size b × h (or round, Ø b)
 * a column head on an elastic bedding of modulus E/H, the column pressed along its height.
 */
export interface PlateColumn {
  id: string;
  name: string;
  x: string;
  y: string;
  /** Size, bare numbers mm; empty b: a point. */
  b?: string;
  h?: string;
  round?: boolean;
  /** Height for the head's bedding (bare number in the length unit; empty 3 m). */
  H?: string;
  /** A point spring instead of a rigid point (bare number force/length). */
  k?: string;
}

export type PlateLoad =
  /** Over the whole plate, downwards. */
  | { id: string; type: 'area'; q: string; case?: string }
  /** Over a rectangle x1 … x2, y1 … y2. */
  | { id: string; type: 'patch'; q: string; x1: string; y1: string; x2: string; y2: string; case?: string }
  /** Along a line from (x1, y1) to (x2, y2), per length. */
  | { id: string; type: 'line'; q: string; x1: string; y1: string; x2: string; y2: string; case?: string }
  | { id: string; type: 'point'; F: string; x: string; y: string; case?: string }
  /** The plate's own weight ρ g t, times a factor. */
  | { id: string; type: 'self'; factor?: string; case?: string };

export interface PlateData {
  outline: PlatePoint[];
  /** One per outline edge (missing: free). */
  edges: PlateEdge[];
  openings: PlateOpening[];
  walls: PlateWall[];
  columns: PlateColumn[];
  loads: PlateLoad[];
}

/** Reinforcement of a concrete slab (EN 1992-1-1). */
export interface PlateRebar {
  /** B500B …; cover to the outer bars and bar diameter, bare numbers mm. */
  steel: string;
  cover: string;
  bar: string;
  /** Bars along x in the outer layer (default), or along y. */
  outer?: 'x' | 'y';
}

/** A result drawn on the plate. */
export type PlateShow =
  | 'model' | 'w' | 'mx' | 'my' | 'mxy' | 'm1' | 'm2' | 'vx' | 'vy'
  | 'mxb' | 'myb' | 'mxt' | 'myt' | 'asxb' | 'asyb' | 'asxt' | 'asyt' | 'sigma';

export type PlateTab = 'outline' | 'openings' | 'supports' | 'loads' | 'results';

/** Plan view: centre (length unit) and zoom (1 fits the plate). */
export interface PlateView {
  cx?: number;
  cy?: number;
  zoom: number;
}

export const plateId = (prefix: string) => beamId(prefix);

/** Next free name with a prefix: C1, C2 … */
export function nextName(prefix: string, used: { name: string }[]): string {
  const taken = new Set(used.map((q) => q.name));
  for (let k = 1; ; k++) if (!taken.has(`${prefix}${k}`)) return `${prefix}${k}`;
}

/** Name of outline edge i in results and the worksheet. */
export const edgeName = (i: number) => `E${i + 1}`;

const num = (v: number) => String(+v.toPrecision(10));

export function rectangle(a: number, b: number, x0 = 0, y0 = 0): PlatePoint[] {
  return [[x0, y0], [x0 + a, y0], [x0 + a, y0 + b], [x0, y0 + b]].map(([x, y]) => ({ x: num(x), y: num(y) }));
}

/** A new region's plate: a 6 m × 4 m slab, simply supported all round, its own weight and an imposed load. */
export function newPlate(): PlateData & { loadCases: BeamCases } {
  return {
    outline: rectangle(6, 4),
    edges: [0, 1, 2, 3].map(() => ({ support: 'simple' as const })),
    openings: [], walls: [], columns: [],
    loads: [
      { id: plateId('l'), type: 'self', case: 'G' },
      { id: plateId('l'), type: 'area', q: '1.5', case: 'G' },
      { id: plateId('l'), type: 'area', q: '3', case: 'Q' },
    ],
    loadCases: defaultCases(),
  };
}

export type PlatePreset = 'simple' | 'flat' | 'circle' | 'lshape' | 'steel';

/**
 * A ready plate to start from (in kN, m and mm, converted to the region's units):
 * - simple: a slab 6 m × 4 m simply supported all round;
 * - flat: a flat slab of 2 × 2 bays of 6 m × 4.5 m on nine columns 400 × 400, free edges;
 * - circle: a circular slab of radius 3 m, simply supported (a 64-gon, meshed as a circle);
 * - lshape: an L-shaped slab on walls along its outside, clamped at the inner corner's edges;
 * - steel: a steel plate 1.2 m × 0.8 m, 20 mm, clamped all round under a pressure.
 */
export function platePreset(kind: PlatePreset, units: { length: BeamLengthUnit; force: BeamForceUnit }): Partial<PlateData> & { loadCases?: BeamCases; thickness?: string; material?: string } {
  const k = { m: 1, cm: 100, mm: 1000, ft: 1 / 0.3048, in: 1 / 0.0254 }[units.length];
  const L = (v: number) => num(v * k);
  const metric = units.force === 'kN' && units.length === 'm';
  const q = (v: number) => (metric ? num(v) : `${num(v)} kN/m^2`);
  const pt = (x: number, y: number): PlatePoint => ({ x: L(x), y: L(y) });
  const base = { openings: [], walls: [], columns: [] };
  const gq = (g: number, qk: number): PlateLoad[] => [
    { id: plateId('l'), type: 'self', case: 'G' },
    { id: plateId('l'), type: 'area', q: q(g), case: 'G' },
    { id: plateId('l'), type: 'area', q: q(qk), case: 'Q' },
  ];
  if (kind === 'simple') {
    return { ...base, outline: [[0, 0], [6, 0], [6, 4], [0, 4]].map(([x, y]) => pt(x, y)), edges: [0, 1, 2, 3].map(() => ({ support: 'simple' })), loads: gq(1.5, 3), loadCases: defaultCases(), thickness: '200', material: 'C30/37' };
  }
  if (kind === 'flat') {
    const columns: PlateColumn[] = [];
    for (const y of [0.2, 4.7, 9.2]) for (const x of [0.2, 6.2, 12.2]) columns.push({ id: plateId('c'), name: `C${columns.length + 1}`, x: L(x), y: L(y), b: '400', h: '400' });
    return { ...base, columns, outline: [[0, 0], [12.4, 0], [12.4, 9.4], [0, 9.4]].map(([x, y]) => pt(x, y)), edges: [0, 1, 2, 3].map(() => ({ support: 'free' })), loads: gq(1.5, 3), loadCases: defaultCases(), thickness: '250', material: 'C30/37' };
  }
  if (kind === 'circle') {
    const n = 64;
    const outline = Array.from({ length: n }, (_, i) => pt(3 + 3 * Math.cos((2 * Math.PI * i) / n), 3 + 3 * Math.sin((2 * Math.PI * i) / n)));
    return { ...base, outline, edges: outline.map(() => ({ support: 'simple' })), loads: gq(1.5, 3), loadCases: defaultCases(), thickness: '200', material: 'C30/37' };
  }
  if (kind === 'lshape') {
    const outline = [[0, 0], [8, 0], [8, 3.5], [4, 3.5], [4, 7], [0, 7]].map(([x, y]) => pt(x, y));
    const edges: PlateEdge[] = ['simple', 'simple', 'clamped', 'clamped', 'simple', 'simple'].map((s) => ({ support: s as EdgeSupport }));
    return { ...base, outline, edges, walls: [{ id: plateId('w'), name: 'W1', a: pt(4, 0), b: pt(4, 2) }], loads: gq(1.5, 3), loadCases: defaultCases(), thickness: '200', material: 'C30/37' };
  }
  return {
    ...base, outline: [[0, 0], [1.2, 0], [1.2, 0.8], [0, 0.8]].map(([x, y]) => pt(x, y)), edges: [0, 1, 2, 3].map(() => ({ support: 'clamped' })),
    loads: [{ id: plateId('l'), type: 'area', q: q(50) }], loadCases: undefined, thickness: '20', material: 'S355',
  };
}

/** Remove items by id (openings, walls, columns, loads), and outline corners by index. */
export function removePlateItems(d: PlateData, ids: Set<string>): Partial<PlateData> {
  return {
    openings: d.openings.filter((o) => !ids.has(o.id)),
    walls: d.walls.filter((w) => !ids.has(w.id)),
    columns: d.columns.filter((c) => !ids.has(c.id)),
    loads: d.loads.filter((l) => !ids.has(l.id)),
  };
}

export { defaultCases };
