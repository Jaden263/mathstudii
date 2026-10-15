// Beams and plane frames: nodes, members, supports and loads, drawn on the page and
// solved by the direct stiffness method. Plain JSON like the rest of the worksheet.
// Coordinates are in the region's length unit (y up); load values are worksheet
// expressions, so the structure follows the calculation around it.

export type BeamLengthUnit = 'm' | 'cm' | 'mm' | 'ft' | 'in';
export type BeamForceUnit = 'kN' | 'N' | 'MN' | 'kip' | 'lbf';

export const BEAM_LENGTH_UNITS: BeamLengthUnit[] = ['m', 'cm', 'mm', 'ft', 'in'];
export const BEAM_FORCE_UNITS: BeamForceUnit[] = ['kN', 'N', 'MN', 'kip', 'lbf'];

export interface BeamNode {
  id: string;
  x: number;
  y: number;
}

/** Cross-section and material values (worksheet expressions). Bare numbers: GPa, cm², cm⁴, cm³. */
export interface BeamSection {
  /** Profile name for display ("IPE 300"). */
  label?: string;
  E: string;
  A: string;
  I: string;
  /** Elastic section modulus, for bending stress (optional). */
  W?: string;
}

export interface BeamMember {
  id: string;
  a: string;
  b: string;
  /** Overrides the region's default section. */
  section?: BeamSection;
  /** Moment releases (hinges) at the start / end of the member. */
  hingeA?: boolean;
  hingeB?: boolean;
}

export type SupportType = 'pin' | 'roller' | 'fixed';

export interface BeamSupport {
  id: string;
  node: string;
  type: SupportType;
  /**
   * Direction of the support in degrees: 0 = standing on the ground (a roller resists
   * vertical movement), 90 = on a wall to the left, and so on.
   */
  angle: number;
  /** Name in results and the worksheet (A, B, …). */
  label: string;
}

/** Where a load sits: on a node, or a fraction along a member. */
export type LoadAt = { node: string } | { member: string; t: number };

export type BeamLoad =
  /** Point force; angle of the force direction in degrees (−90 = downwards). */
  | { id: string; type: 'force'; at: LoadAt; value: string; angle: number }
  /** Concentrated moment, counter-clockwise positive. */
  | { id: string; type: 'moment'; at: LoadAt; value: string }
  /**
   * Line load from t1 to t2 along a member, q1 → q2 (linear). 'global' acts downwards
   * (gravity, per length of member); 'local' acts perpendicular to the member.
   */
  | { id: string; type: 'line'; member: string; q1: string; q2?: string; t1?: number; t2?: number; dir: 'global' | 'local' };

export type BeamDiagram = 'model' | 'reactions' | 'N' | 'V' | 'M' | 'deflection';
/** A result diagram drawn under the structure. */
export type BeamPanel = 'N' | 'V' | 'M' | 'deflection';
/** Diagrams stacked under the structure (the default), or one at a time drawn on it. */
export type BeamLayout = 'stack' | 'overlay';

export interface BeamView {
  cx: number;
  cy: number;
  /** Pixels per length unit. */
  zoom: number;
}

export interface BeamData {
  nodes: BeamNode[];
  members: BeamMember[];
  supports: BeamSupport[];
  loads: BeamLoad[];
}

/** Common European steel profiles: A [cm²], Iy [cm⁴], Wel,y [cm³]. */
export const PROFILES: { name: string; A: number; I: number; W: number }[] = [
  { name: 'IPE 100', A: 10.3, I: 171, W: 34.2 },
  { name: 'IPE 120', A: 13.2, I: 318, W: 53.0 },
  { name: 'IPE 140', A: 16.4, I: 541, W: 77.3 },
  { name: 'IPE 160', A: 20.1, I: 869, W: 109 },
  { name: 'IPE 180', A: 23.9, I: 1317, W: 146 },
  { name: 'IPE 200', A: 28.5, I: 1943, W: 194 },
  { name: 'IPE 220', A: 33.4, I: 2772, W: 252 },
  { name: 'IPE 240', A: 39.1, I: 3892, W: 324 },
  { name: 'IPE 270', A: 45.9, I: 5790, W: 429 },
  { name: 'IPE 300', A: 53.8, I: 8356, W: 557 },
  { name: 'IPE 330', A: 62.6, I: 11770, W: 713 },
  { name: 'IPE 360', A: 72.7, I: 16270, W: 904 },
  { name: 'IPE 400', A: 84.5, I: 23130, W: 1160 },
  { name: 'IPE 450', A: 98.8, I: 33740, W: 1500 },
  { name: 'IPE 500', A: 116, I: 48200, W: 1930 },
  { name: 'IPE 600', A: 156, I: 92080, W: 3070 },
  { name: 'HEA 200', A: 53.8, I: 3692, W: 389 },
  { name: 'HEA 300', A: 112.5, I: 18260, W: 1260 },
  { name: 'HEB 200', A: 78.1, I: 5696, W: 570 },
  { name: 'HEB 300', A: 149, I: 25170, W: 1680 },
];

export const DEFAULT_SECTION: BeamSection = { label: 'IPE 300', E: '210 GPa', A: '53.8 cm^2', I: '8356 cm^4', W: '557 cm^3' };

export function profileSection(name: string, E = '210 GPa'): BeamSection | null {
  const p = PROFILES.find((q) => q.name === name);
  return p ? { label: p.name, E, A: `${p.A} cm^2`, I: `${p.I} cm^4`, W: `${p.W} cm^3` } : null;
}

let n = 0;
export function beamId(prefix: string): string {
  n = (n + 1) % 1e6;
  return prefix + Date.now().toString(36).slice(-4) + n.toString(36) + Math.random().toString(36).slice(2, 4);
}

/** Next free support label: A, B, … Z, A1, … */
export function nextLabel(supports: BeamSupport[]): string {
  const used = new Set(supports.map((s) => s.label));
  for (let k = 0; ; k++) {
    const l = String.fromCharCode(65 + (k % 26)) + (k >= 26 ? String(Math.floor(k / 26)) : '');
    if (!used.has(l)) return l;
  }
}

export const nodeMap = (d: BeamData) => new Map(d.nodes.map((q) => [q.id, q]));

/** Point at fraction t along a member. */
export function memberPoint(d: BeamData, m: BeamMember, t: number): { x: number; y: number } {
  const N = nodeMap(d);
  const a = N.get(m.a)!, b = N.get(m.b)!;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function loadPoint(d: BeamData, at: LoadAt): { x: number; y: number } | null {
  if ('node' in at) {
    const q = d.nodes.find((p) => p.id === at.node);
    return q ? { x: q.x, y: q.y } : null;
  }
  const m = d.members.find((q) => q.id === at.member);
  return m ? memberPoint(d, m, at.t) : null;
}

/**
 * Remove members, supports, loads and nodes by id; then whatever lost its anchor
 * (loads on removed members, supports on removed nodes) and nodes nothing uses.
 */
export function removeItems(d: BeamData, ids: Set<string>): BeamData {
  const members = d.members.filter((m) => !ids.has(m.id) && !ids.has(m.a) && !ids.has(m.b));
  const used = new Set(members.flatMap((m) => [m.a, m.b]));
  const nodes = d.nodes.filter((q) => used.has(q.id) && !ids.has(q.id));
  const alive = new Set([...nodes.map((q) => q.id), ...members.map((m) => m.id)]);
  const supports = d.supports.filter((s) => !ids.has(s.id) && alive.has(s.node));
  const loads = d.loads.filter((l) => {
    if (ids.has(l.id)) return false;
    if (l.type === 'line') return alive.has(l.member);
    return 'node' in l.at ? alive.has(l.at.node) : alive.has(l.at.member);
  });
  return { nodes, members, supports, loads };
}

/**
 * Split a member at fraction t, returning the new node id. Loads on the member move to
 * the piece they sit on (line loads are split too).
 */
export function splitMember(d: BeamData, memberId: string, t: number): { data: BeamData; node: string } {
  const m = d.members.find((q) => q.id === memberId)!;
  const p = memberPoint(d, m, t);
  const node: BeamNode = { id: beamId('n'), x: p.x, y: p.y };
  const m1: BeamMember = { ...m, id: beamId('m'), b: node.id, hingeB: undefined };
  const m2: BeamMember = { ...m, id: beamId('m'), a: node.id, hingeA: undefined };
  const loads: BeamLoad[] = [];
  for (const l of d.loads) {
    if (l.type === 'line' && l.member === m.id) {
      const t1 = l.t1 ?? 0, t2 = l.t2 ?? 1;
      const q1 = l.q1, q2 = l.q2 ?? l.q1;
      // value at t by linear interpolation, as an expression
      const qt = q1 === q2 ? q1 : `(${q1}) + ((${q2}) - (${q1})) * ${+((t - t1) / (t2 - t1)).toPrecision(12)}`;
      if (t2 <= t) loads.push({ ...l, member: m1.id, t1: t1 / t, t2: t2 / t });
      else if (t1 >= t) loads.push({ ...l, member: m2.id, t1: (t1 - t) / (1 - t), t2: (t2 - t) / (1 - t) });
      else {
        loads.push({ ...l, id: beamId('l'), member: m1.id, t1: t1 / t, t2: 1, q2: qt, q1 });
        loads.push({ ...l, id: beamId('l'), member: m2.id, t1: 0, t2: (t2 - t) / (1 - t), q1: qt, q2 });
      }
    } else if (l.type !== 'line' && 'member' in l.at && l.at.member === m.id) {
      const lt = l.at.t;
      loads.push({ ...l, at: lt <= t ? { member: m1.id, t: lt / t } : { member: m2.id, t: (lt - t) / (1 - t) } } as BeamLoad);
    } else loads.push(l);
  }
  return {
    data: { nodes: [...d.nodes, node], members: d.members.flatMap((q) => (q.id === m.id ? [m1, m2] : [q])), supports: d.supports, loads },
    node: node.id,
  };
}
