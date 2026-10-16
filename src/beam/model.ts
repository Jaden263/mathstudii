// Beams and plane frames: nodes, members, supports and loads, drawn on the page and
// solved by the direct stiffness method. Plain JSON like the rest of the worksheet.
// Coordinates are in the region's length unit (y up); load values are worksheet
// expressions, so the structure follows the calculation around it.
import { ROLLED_SECTIONS, sectionProps } from '../engine/sections';

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
  /** Material family, for the shear modulus (ν = 0.3 steel, 0.2 concrete; timber: G_mean). Absent = steel. */
  material?: BeamMaterial;
  /** Concrete or timber class E (and G) came from ("C30/37", "C24", "GL24h"). */
  grade?: string;
  /** Shear modulus (expression, bare number GPa); empty = from E and the material. */
  G?: string;
  /** How the shear area A_v follows from the section; absent = the profile's, else 5/6 A. */
  shear?: BeamShearArea;
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
  /** Part of the load path (deck) the moving loads travel on. */
  deck?: boolean;
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
  /** Spring along the support axis (worksheet expression; bare number in force/length unit). Empty = rigid. */
  k?: string;
  /** Rotational spring of a fixed support (bare number in force·length per rad). Empty = rigid. */
  kr?: string;
  /** Settlement along the support axis, into the support (bare number in mm). */
  settle?: string;
}

/** Where a load sits: on a node, or a fraction along a member. */
export type LoadAt = { node: string } | { member: string; t: number };

/** A load case: G (permanent), Q (imposed), W (wind) … */
export interface BeamLoadCase {
  id: string;
  /** Short name used in combinations and the worksheet ("G"). */
  name: string;
  /** Description ("Permanent"). */
  label?: string;
}

/** A load combination: a factor (worksheet expression) per load case. */
export interface BeamCombo {
  id: string;
  /** "ULS", "SLS" … (worksheet name: b.combos.ULS). */
  name: string;
  factors: Record<string, string>;
  /** Ultimate (strength) or serviceability (deflection). */
  kind: 'ULS' | 'SLS';
}

/** What a beam with load cases shows: one case, one combination, or the envelope. */
export type BeamShow = string;

export type BeamLoad =
  /** Point force; angle of the force direction in degrees (−90 = downwards). */
  | { id: string; type: 'force'; at: LoadAt; value: string; angle: number; case?: string }
  /** Concentrated moment, counter-clockwise positive. */
  | { id: string; type: 'moment'; at: LoadAt; value: string; case?: string }
  /**
   * Line load from t1 to t2 along a member, q1 → q2 (linear). 'global' acts downwards
   * (gravity, per length of member); 'local' acts perpendicular to the member.
   */
  | { id: string; type: 'line'; member: string; q1: string; q2?: string; t1?: number; t2?: number; dir: 'global' | 'local'; case?: string };

export type BeamDiagram = 'model' | 'reactions' | 'N' | 'V' | 'M' | 'deflection' | 'mode';
/** A result diagram drawn under the structure ('mode': the buckling mode). */
export type BeamPanel = 'N' | 'V' | 'M' | 'deflection' | 'mode';
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

/** Load cases and combinations of a beam (absent = every load in one case). */
export interface BeamCases {
  cases: BeamLoadCase[];
  combos: BeamCombo[];
  /** Case id, combination id or 'envelope'. */
  view?: string;
}

/** The usual start: permanent and imposed loads, EN 1990 (6.10) and characteristic SLS. */
export function defaultCases(): BeamCases {
  return {
    cases: [{ id: 'G', name: 'G', label: 'Permanent' }, { id: 'Q', name: 'Q', label: 'Imposed' }],
    combos: [
      { id: 'uls', name: 'ULS', kind: 'ULS', factors: { G: '1.35', Q: '1.5' } },
      { id: 'sls', name: 'SLS', kind: 'SLS', factors: { G: '1', Q: '1' } },
    ],
    view: 'uls',
  };
}

/** The case a load belongs to (loads without one are in the first case). */
export function loadCase(l: { case?: string }, c: BeamCases): string {
  return l.case && c.cases.some((q) => q.id === l.case) ? l.case : c.cases[0]?.id ?? '';
}

/** European rolled profiles from the section library: A [cm²], Iy [cm⁴], Wel,y [cm³]. */
export const PROFILES: { name: string; A: number; I: number; W: number }[] = ROLLED_SECTIONS.map((name) => {
  const p = sectionProps(name);
  const r = (v: number) => Number(v.toPrecision(4));
  return { name, A: r(p.A / 100), I: r(p.I_y / 1e4), W: r(p.W_el_y / 1e3) };
});

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

export type BeamMaterial = 'steel' | 'concrete' | 'timber';

/** The shear area A_v of a section, for shear deformation (EN 1993-1-1 6.2.6(3) for steel). */
export type BeamShearArea =
  /** From A: solid rectangle 5/6 A, solid circle 0.9 A, circular hollow section 2A/π. */
  | { kind: 'rect' | 'circle' | 'chs' }
  /** Rectangular hollow section, load along the depth h: A h / (b + h). Bare numbers mm. */
  | { kind: 'rhs'; h: string; b: string }
  /** Welded I or box: the webs, h_w t_w. Bare numbers mm. */
  | { kind: 'welded'; hw: string; tw: string }
  /** A value (expression, bare number cm²). */
  | { kind: 'value'; Av: string };

/** How a beam region is analysed. Absent: first order, Euler–Bernoulli members, no buckling. */
export interface BeamAnalysis {
  /** Timoshenko members: shear deformation from G and the shear area A_v. */
  shear?: boolean;
  /** Second order: equilibrium on the deformed structure (P-Δ and P-δ). */
  secondOrder?: boolean;
  /** Linear buckling: α_cr and the buckling modes of each combination. */
  buckling?: boolean;
  /** Buckling mode drawn (0 = the lowest). */
  mode?: number;
}

/** What an influence line is of: a support reaction, or a force or the deflection at a section. */
export type InfluenceQuantity = 'Ry' | 'Rx' | 'Mr' | 'V' | 'M' | 'N' | 'w';

export interface BeamInfluenceLine {
  id: string;
  /** Name in the worksheet: b.IL.M1(x). */
  name: string;
  quantity: InfluenceQuantity;
  /** Support id (Ry, Rx, Mr). */
  support?: string;
  /** Section (V, M, N, w): a point on a member, in the length unit, and the member it was picked on. */
  at?: { x: number; y: number };
  member?: string;
  /** At a joint: the member to the left of the point (default: the one to its right). */
  left?: boolean;
}

/**
 * A moving load: a preset, or an axle train with a uniform load. Values are worksheet
 * expressions; bare numbers take the region's force and length units.
 */
export interface BeamMovingLoad {
  id: string;
  /** Name in combinations and the worksheet (b.moving.LM1). */
  name: string;
  preset: 'point' | 'lm1' | 'crane' | 'train';
  /** Point load, or each crane wheel. */
  P?: string;
  /** Crane wheel spacing. */
  a?: string;
  /** Load Model 1 (EN 1991-2 4.3.2), one notional lane: adjustment factors and the lane width (bare number m). */
  alphaQ?: string;
  alphaq?: string;
  w?: string;
  /** Train: axle loads with the spacing to the axle before (the first spacing is unused). */
  axles?: { P: string; a: string }[];
  /** Train: uniform load, put only where it is adverse. */
  q?: string;
  /** Both ways (default), or only towards +x / −x. */
  dir?: 'both' | 'forward' | 'backward';
}

/** Influence lines and moving loads of a beam region. */
export interface BeamTraffic {
  lines: BeamInfluenceLine[];
  loads: BeamMovingLoad[];
  /** Spacing of the load positions (expression; bare number in the length unit); empty = automatic. */
  step?: string;
  /** Id of the moving load whose envelope is shown, instead of the loads, case or combination. */
  view?: string;
  /** Hide the influence-line panels. */
  hideLines?: boolean;
}

/** EN 1991-2 Table 4.2, lane 1: tandem axle load Q₁k and uniform load q₁k. */
export const LM1 = { Q: 300, q: 9, spacing: 1.2 };

/**
 * A new moving load. Its values are meant in kN and m: bare numbers in a region that
 * works in those units, else with the unit written (80 kN at 3.5 mm would be one load).
 */
export function movingLoad(preset: BeamMovingLoad['preset'], name: string, units?: { force: BeamForceUnit; length: BeamLengthUnit }): BeamMovingLoad {
  const id = beamId('t');
  const kN = (v: number) => (!units || units.force === 'kN' ? String(v) : `${v} kN`);
  const m = (v: number) => (!units || units.length === 'm' ? String(v) : `${v} m`);
  switch (preset) {
    case 'point': return { id, name, preset, P: kN(100) };
    case 'lm1': return { id, name, preset, alphaQ: '1', alphaq: '1', w: '3' };
    case 'crane': return { id, name, preset, P: kN(80), a: m(3.5) };
    case 'train': return { id, name, preset, axles: [{ P: kN(100), a: '0' }, { P: kN(100), a: m(2) }], q: '' };
  }
}
