// 3-D frames (space frames, trusses, grillages) as tables: nodes, members, sections,
// supports and loads. Plain JSON like the rest of the worksheet; every value is a
// worksheet expression, so the structure follows the calculation around it. Bare
// numbers take the region's units (coordinates and positions the length unit, forces
// the force unit; section values cm², cm⁴, cm³; E and G GPa; angles degrees).
import type { BeamCases, BeamForceUnit, BeamLengthUnit } from '../beam/model';
import { beamId, defaultCases } from '../beam/model';

export type { BeamCases as Frame3DCases };

export interface F3Node {
  id: string;
  /** Name in tables and the worksheet (N1, A …). */
  name: string;
  x: string;
  y: string;
  z: string;
}

/** End forces a member end can be released in. */
export const RELEASES = ['N', 'Vy', 'Vz', 'T', 'My', 'Mz'] as const;
export type ReleaseName = (typeof RELEASES)[number];

export interface F3Member {
  id: string;
  name: string;
  a: string;
  b: string;
  /** Section id. */
  section: string;
  /** Rotation of the section about the member axis (bare number: degrees). */
  beta?: string;
  /** Direction local z leans towards, "x, y, z" (global); empty = the default (down for a beam). */
  ref?: string;
  /** End forces released at the start and the end (a hinge: My, Mz). */
  relA?: ReleaseName[];
  relB?: ReleaseName[];
}

export interface F3Section {
  id: string;
  name: string;
  /** Steel profile from the library ("IPE 300", "HEB 200", "CHS 168.3x5", "RHS 200x100x6.3"); absent: the values below. */
  profile?: string;
  A?: string;
  Iy?: string;
  Iz?: string;
  It?: string;
  /** Shear areas for V_y and V_z (shear deformation); empty: from the profile, else 5/6 A. */
  Avy?: string;
  Avz?: string;
  /** Elastic section moduli, for the stress (optional with custom values). */
  Wy?: string;
  Wz?: string;
  /** Material class (S235 … S460, C20/25 …, C24, GL24h …), or 'custom' with E, G and ρ. */
  material: string;
  E?: string;
  G?: string;
  rho?: string;
}

/** Each of the six node unknowns u_x u_y u_z φ_x φ_y φ_z: 'fixed', 'free', or a spring stiffness (expression). */
export type DofSupport = string;

export interface F3Support {
  id: string;
  node: string;
  dofs: DofSupport[];
}

/** A load direction: global X, Y, Z or member axes x, y, z. */
export type F3Dir = 'X' | 'Y' | 'Z' | 'x' | 'y' | 'z';
export const DIRS: F3Dir[] = ['X', 'Y', 'Z', 'x', 'y', 'z'];

export type F3Load =
  /** Forces and moments on a node, global axes. */
  | { id: string; type: 'node'; node: string; Fx?: string; Fy?: string; Fz?: string; Mx?: string; My?: string; Mz?: string; case?: string }
  /** A point force (or moment) along a member at distance `at` from its start. */
  | { id: string; type: 'point'; member: string; at: string; dir: F3Dir; value: string; moment?: boolean; case?: string }
  /**
   * A line load q1 → q2 from `from` to `to` along a member (empty: the whole member), per
   * length of member; `projected` (global directions) per length projected across the
   * load, as snow on a roof slope.
   */
  | { id: string; type: 'line'; member: string; dir: F3Dir; q1: string; q2?: string; from?: string; to?: string; projected?: boolean; case?: string }
  /** Self-weight of every member, ρ g A downwards (−Z), times a factor. */
  | { id: string; type: 'self'; factor?: string; case?: string };

export interface Frame3DData {
  nodes: F3Node[];
  members: F3Member[];
  sections: F3Section[];
  supports: F3Support[];
  loads: F3Load[];
}

/** How the frame is analysed. Absent: first order, Euler–Bernoulli members, no buckling. */
export interface Frame3DAnalysis {
  shear?: boolean;
  secondOrder?: boolean;
  buckling?: boolean;
  /** Buckling mode drawn (0 = the lowest). */
  mode?: number;
}

/** Orbit camera: yaw about Z and pitch, degrees; zoom 1 fits the frame; pan in fractions of the view. */
export interface Frame3DCamera {
  yaw: number;
  pitch: number;
  zoom: number;
  panX: number;
  panY: number;
}

export type Frame3DShow = 'model' | 'deformed' | 'N' | 'Vy' | 'Vz' | 'T' | 'My' | 'Mz' | 'mode';
export const FORCE_SHOWS: Frame3DShow[] = ['N', 'Vy', 'Vz', 'T', 'My', 'Mz'];

export type Frame3DTab = 'nodes' | 'members' | 'sections' | 'supports' | 'loads' | 'results';

export const DEFAULT_CAMERA: Frame3DCamera = { yaw: -35, pitch: 25, zoom: 1, panX: 0, panY: 0 };

export const frameId = (prefix: string) => beamId(prefix);

/** Next free name with a prefix: N1, N2 … */
export function nextName(prefix: string, used: { name: string }[]): string {
  const taken = new Set(used.map((q) => q.name));
  for (let k = 1; ; k++) if (!taken.has(`${prefix}${k}`)) return `${prefix}${k}`;
}

export const SUPPORT_PRESETS: { id: string; label: string; dofs: DofSupport[] }[] = [
  { id: 'fixed', label: 'Fixed', dofs: ['fixed', 'fixed', 'fixed', 'fixed', 'fixed', 'fixed'] },
  { id: 'pinned', label: 'Pinned', dofs: ['fixed', 'fixed', 'fixed', 'free', 'free', 'free'] },
  { id: 'pinnedZ', label: 'Pinned, no twist', dofs: ['fixed', 'fixed', 'fixed', 'free', 'free', 'fixed'] },
  { id: 'rollerZ', label: 'Roller (Z)', dofs: ['free', 'free', 'fixed', 'free', 'free', 'free'] },
  { id: 'rollerXZ', label: 'Roller (X, Z)', dofs: ['fixed', 'free', 'fixed', 'free', 'free', 'free'] },
  { id: 'rollerYZ', label: 'Roller (Y, Z)', dofs: ['free', 'fixed', 'fixed', 'free', 'free', 'free'] },
];

export const RELEASE_PRESETS: { id: string; label: string; rel: ReleaseName[] }[] = [
  { id: 'none', label: 'Rigid', rel: [] },
  { id: 'hinge', label: 'Hinge (My, Mz)', rel: ['My', 'Mz'] },
  { id: 'hingeY', label: 'Hinge about y (My)', rel: ['My'] },
  { id: 'hingeZ', label: 'Hinge about z (Mz)', rel: ['Mz'] },
  { id: 'pin', label: 'Ball joint (T, My, Mz)', rel: ['T', 'My', 'Mz'] },
];

export const releaseText = (rel?: ReleaseName[]) => (rel?.length ? rel.join(' ') : '—');

export function emptyFrame(): Frame3DData {
  return { nodes: [], members: [], sections: [], supports: [], loads: [] };
}

/** A new region's frame: nothing yet, but a section to give the first members. */
export function newFrame(): Frame3DData {
  return { ...emptyFrame(), sections: [{ id: frameId('s'), name: 'S1', profile: 'IPE 300', material: 'S355' }] };
}

// ---------------------------------------------------------------- presets

const num = (v: number) => String(+v.toPrecision(10));

function builder(lengthUnit: BeamLengthUnit) {
  const d: Frame3DData = emptyFrame();
  const k = { m: 1, cm: 100, mm: 1000, ft: 1 / 0.3048, in: 1 / 0.0254 }[lengthUnit];
  const node = (x: number, y: number, z: number) => {
    const n: F3Node = { id: frameId('n'), name: `N${d.nodes.length + 1}`, x: num(x * k), y: num(y * k), z: num(z * k) };
    d.nodes.push(n);
    return n.id;
  };
  const section = (name: string, profile: string, material = 'S355') => {
    const s: F3Section = { id: frameId('s'), name, profile, material };
    d.sections.push(s);
    return s.id;
  };
  const member = (a: string, b: string, sec: string, extra: Partial<F3Member> = {}) => {
    const m: F3Member = { id: frameId('m'), name: `M${d.members.length + 1}`, a, b, section: sec, ...extra };
    d.members.push(m);
    return m.id;
  };
  const support = (nodeId: string, preset: string) => d.supports.push({ id: frameId('p'), node: nodeId, dofs: [...SUPPORT_PRESETS.find((p) => p.id === preset)!.dofs] });
  return { d, node, section, member, support };
}

/** Cases G, Q and W (wind), with EN 1990 (6.10) combinations: leading imposed, leading wind, and the characteristic SLS. */
export function windCases(): BeamCases {
  const lc = defaultCases();
  lc.cases.push({ id: 'W', name: 'W', label: 'Wind' });
  lc.combos = [
    { id: 'uls1', name: 'ULS1', kind: 'ULS', factors: { G: '1.35', Q: '1.5', W: '0.9' } },
    { id: 'uls2', name: 'ULS2', kind: 'ULS', factors: { G: '1.35', Q: '1.05', W: '1.5' } },
    { id: 'sls', name: 'SLS', kind: 'SLS', factors: { G: '1', Q: '1', W: '0.6' } },
  ];
  lc.view = 'uls1';
  return lc;
}

export type Frame3DPreset = 'portal' | 'truss' | 'grillage';

/**
 * A ready structure to start from (in kN and m, converted to the region's units):
 * - portal: a one-storey steel frame, 2 × 1 bays of 6 m × 5 m, 4.5 m high, fixed feet,
 *   roof loads on the beams and wind on the windward columns;
 * - truss: a square lattice tower, 2 m wide and 6 m high in three panels, pin-jointed,
 *   with a load and a horizontal pull at the top;
 * - grillage: a floor grid 3 × 3 bays of 4 m, simply supported round its edge, uniformly loaded.
 */
export function framePreset(kind: Frame3DPreset, units: { length: BeamLengthUnit; force: BeamForceUnit }): Frame3DData & { loadCases?: BeamCases } {
  const { d, node, section, member, support } = builder(units.length);
  const kN = (v: number) => (units.force === 'kN' ? num(v) : `${num(v)} kN`);
  const kNm = (v: number) => (units.force === 'kN' && units.length === 'm' ? num(v) : `${num(v)} kN/m`);
  const lineLoad = (m: string, dir: F3Dir, q: number, c?: string) => d.loads.push({ id: frameId('l'), type: 'line', member: m, dir, q1: kNm(q), ...(c ? { case: c } : {}) });
  if (kind === 'portal') {
    const xs = [0, 6, 12], ys = [0, 5], h = 4.5;
    const col = section('Column', 'HEB 200'), bx = section('Beam X', 'IPE 300'), by = section('Beam Y', 'IPE 240');
    const base = new Map<string, string>(), top = new Map<string, string>();
    for (const y of ys) for (const x of xs) {
      const b = node(x, y, 0), t = node(x, y, h);
      base.set(`${x},${y}`, b);
      top.set(`${x},${y}`, t);
      support(b, 'fixed');
      member(b, t, col);
    }
    for (const y of ys) for (let i = 0; i + 1 < xs.length; i++) {
      const m = member(top.get(`${xs[i]},${y}`)!, top.get(`${xs[i + 1]},${y}`)!, bx);
      lineLoad(m, 'Z', -6, 'G');
      lineLoad(m, 'Z', -7.5, 'Q');
    }
    for (const x of xs) member(top.get(`${x},0`)!, top.get(`${x},5`)!, by);
    d.loads.push({ id: frameId('l'), type: 'self', case: 'G' });
    // wind on the windward wall (x = 0): 0.8 kN/m² over half a bay each side
    for (const y of ys) {
      const c = d.members.find((m) => m.a === base.get(`0,${y}`))!;
      lineLoad(c.id, 'X', 0.8 * 2.5, 'W');
    }
    return { ...d, loadCases: windCases() };
  }
  if (kind === 'truss') {
    const w = 2, levels = [0, 2, 4, 6];
    const leg = section('Leg', 'CHS 114.3x5'), brace = section('Brace', 'CHS 60.3x4');
    const pin = { relA: ['T', 'My', 'Mz'] as ReleaseName[], relB: ['My', 'Mz'] as ReleaseName[] };
    const corner = [[0, 0], [w, 0], [w, w], [0, w]];
    const rings = levels.map((z) => corner.map(([x, y]) => node(x, y, z)));
    rings[0].forEach((n) => support(n, 'pinned'));
    for (let k = 0; k + 1 < rings.length; k++) {
      for (let c = 0; c < 4; c++) {
        const c2 = (c + 1) % 4;
        member(rings[k][c], rings[k + 1][c], leg, pin);
        member(rings[k + 1][c], rings[k + 1][c2], brace, pin);
        // one diagonal per face, alternating
        member((k + c) % 2 ? rings[k][c] : rings[k][c2], (k + c) % 2 ? rings[k + 1][c2] : rings[k + 1][c], brace, pin);
      }
      // a plan diagonal in each ring holds its square
      member(rings[k + 1][0], rings[k + 1][2], brace, pin);
    }
    for (const n of rings[rings.length - 1]) d.loads.push({ id: frameId('l'), type: 'node', node: n, Fx: kN(5), Fz: kN(-20) });
    d.loads.push({ id: frameId('l'), type: 'self' });
    return d;
  }
  // grillage
  const a = 4, nb = 3;
  const girder = section('Girder', 'IPE 360');
  const grid: string[][] = [];
  for (let j = 0; j <= nb; j++) {
    grid.push([]);
    for (let i = 0; i <= nb; i++) grid[j].push(node(i * a, j * a, 0));
  }
  for (let j = 0; j <= nb; j++) for (let i = 0; i <= nb; i++) {
    const edge = i === 0 || j === 0 || i === nb || j === nb;
    if (!edge) continue;
    // vertical support round the edge; one corner and its neighbour hold the grid in its plane
    support(grid[j][i], i === 0 && j === 0 ? 'pinned' : i === nb && j === 0 ? 'rollerYZ' : 'rollerZ');
  }
  for (let j = 0; j <= nb; j++) for (let i = 0; i < nb; i++) lineLoad(member(grid[j][i], grid[j][i + 1], girder), 'Z', -10);
  for (let i = 0; i <= nb; i++) for (let j = 0; j < nb; j++) lineLoad(member(grid[j][i], grid[j + 1][i], girder), 'Z', -10);
  d.loads.push({ id: frameId('l'), type: 'self' });
  return d;
}

/** Remove items by id, and whatever lost its anchor (members on removed nodes, loads on removed members …). */
export function removeFrameItems(d: Frame3DData, ids: Set<string>): Frame3DData {
  const nodes = d.nodes.filter((n) => !ids.has(n.id));
  const alive = new Set(nodes.map((n) => n.id));
  const members = d.members.filter((m) => !ids.has(m.id) && alive.has(m.a) && alive.has(m.b));
  const mem = new Set(members.map((m) => m.id));
  const sections = d.sections.filter((s) => !ids.has(s.id));
  const supports = d.supports.filter((s) => !ids.has(s.id) && alive.has(s.node));
  const loads = d.loads.filter((l) => {
    if (ids.has(l.id)) return false;
    if (l.type === 'node') return alive.has(l.node);
    if (l.type === 'self') return true;
    return mem.has(l.member);
  });
  return { nodes, members, sections, supports, loads };
}
