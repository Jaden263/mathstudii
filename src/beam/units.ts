// Units of a beam region. Bare numbers in its coordinates, grid and loads are in the
// region's length and force units; expressions with a unit written (5 kN/m, q_k) carry
// their own. Changing a unit converts those bare numbers, so the structure keeps its size
// and its loads (or, if asked, keeps the numbers, which then mean the new unit). The
// results can be shown in units of their own, whatever the region works in.
import type { BeamRegion } from '../model/types';
import { math, isUnit } from '../engine/math';
import { preprocess } from '../engine/syntax';
import type { BeamForceUnit, BeamLengthUnit, BeamLoad, BeamMovingLoad, BeamSupport } from './model';

export const LENGTH_M: Record<string, number> = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 };
export const FORCE_N: Record<string, number> = { kN: 1e3, N: 1, MN: 1e6, kip: 4448.2216152605, lbf: 4.4482216152605 };

const NUMBER = /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i;

/** A plain number written out ("12", "-2.5", "1e3"), not an expression. */
export const isNumberText = (s: string) => NUMBER.test(s);

/** A converted number without the round-off of the conversion (0.30000000000000004 → 0.3). */
export const tidy = (v: number) => +v.toPrecision(15);

/**
 * A number typed into a field that is in `unit` (a length, an angle in deg): plain, with a
 * unit of its own (250 mm, 1.5 ft, 90°) or as arithmetic (2.5 + 1.25). Null when it is none.
 */
export function readNumber(text: string, unit: string): number | null {
  const t = text.trim();
  if (!t) return null;
  if (NUMBER.test(t)) return Number(t);
  try {
    const v: unknown = math.evaluate(preprocess(t));
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (isUnit(v) && v.equalBase(math.unit(1, unit))) {
      const n = tidy(v.toNumeric(unit) as number);
      return Number.isFinite(n) ? n : null;
    }
  } catch {
    /* not a number */
  }
  return null;
}

/** Unit names the worksheet reads ("kN*m", "kN/m"). */
const per = (f: string, l: string) => `${f}/${l}`;
const times = (f: string, l: string) => `${f}*${l}`;

/**
 * The text of a value whose bare numbers are in `unit`, scaled by f: a number is
 * converted; an expression that gave a plain number (it is in `bare`) keeps meaning the
 * old unit, which is written after it; anything with a unit of its own stays as it is.
 */
function scaled<T extends string | undefined>(src: T, f: number, unit: string, bare: Set<string>): T {
  if (src === undefined) return src;
  const s = src.trim();
  if (!s || f === 1) return src;
  if (NUMBER.test(s)) return String(tidy(Number(s) * f)) as T;
  if (bare.has(s)) return `(${s}) ${unit}` as T;
  return src;
}

export interface UnitChange {
  lengthUnit: BeamLengthUnit;
  forceUnit: BeamForceUnit;
}

/**
 * The region in other units. `convert` (the default) rewrites what is stored as bare
 * numbers so the structure, its loads and so its results stay physically the same;
 * otherwise only the units change and the numbers mean the new ones. `bare` lists the
 * expressions that came out as plain numbers (they took the old unit): those are kept
 * meaning the old unit too.
 */
export function changeUnits(r: BeamRegion, to: UnitChange, opts: { convert?: boolean; bare?: Iterable<string> } = {}): Partial<BeamRegion> {
  const patch: Partial<BeamRegion> = { lengthUnit: to.lengthUnit, forceUnit: to.forceUnit };
  if (opts.convert === false) return patch;
  const fL = (LENGTH_M[r.lengthUnit] ?? 1) / (LENGTH_M[to.lengthUnit] ?? 1);
  const fF = (FORCE_N[r.forceUnit] ?? 1) / (FORCE_N[to.forceUnit] ?? 1);
  if (fL === 1 && fF === 1) return patch;
  const bare = new Set([...(opts.bare ?? [])].map((s) => s.trim()));
  const F = r.forceUnit, L = r.lengthUnit;
  const len = (v: number) => tidy(v * fL);
  const force = <T extends string | undefined>(s: T) => scaled(s, fF, F, bare);
  const moment = <T extends string | undefined>(s: T) => scaled(s, fF * fL, times(F, L), bare);
  const line = <T extends string | undefined>(s: T) => scaled(s, fF / fL, per(F, L), bare);
  const length = <T extends string | undefined>(s: T) => scaled(s, fL, L, bare);

  patch.nodes = r.nodes.map((q) => ({ ...q, x: len(q.x), y: len(q.y) }));
  patch.grid = len(r.grid);
  // the same picture: the view keeps its place and its scale
  patch.view = { ...r.view, cx: len(r.view.cx), cy: len(r.view.cy), zoom: r.view.zoom / fL };
  patch.loads = r.loads.map((l): BeamLoad => {
    if (l.type === 'force') return { ...l, value: force(l.value) };
    if (l.type === 'moment') return { ...l, value: moment(l.value) };
    return { ...l, q1: line(l.q1), ...(l.q2 !== undefined ? { q2: line(l.q2) } : {}) };
  });
  // springs: force per length and force·length per radian; the settlement is in mm whatever the units
  patch.supports = r.supports.map((s): BeamSupport => ({
    ...s,
    ...(s.k !== undefined ? { k: line(s.k) } : {}),
    ...(s.kr !== undefined ? { kr: moment(s.kr) } : {}),
  }));
  const tr = r.traffic;
  if (tr) {
    patch.traffic = {
      ...tr,
      ...(tr.step !== undefined ? { step: length(tr.step) } : {}),
      lines: tr.lines.map((il) => (il.at ? { ...il, at: { x: len(il.at.x), y: len(il.at.y) } } : il)),
      // the lane width of LM1 is in m and its factors are plain numbers
      loads: tr.loads.map((m): BeamMovingLoad => ({
        ...m,
        ...(m.P !== undefined ? { P: force(m.P) } : {}),
        ...(m.a !== undefined ? { a: length(m.a) } : {}),
        ...(m.q !== undefined ? { q: line(m.q) } : {}),
        ...(m.axles ? { axles: m.axles.map((ax, i) => ({ P: force(ax.P), a: i === 0 ? ax.a : length(ax.a) })) } : {}),
      })),
    };
  }
  return patch;
}

// ------------------------------------------------------------ units of the results

/** Units the results are shown in (absent: the region's own, deflection in mm or in, stress in MPa). */
export interface BeamDisplayUnits {
  force?: string;
  moment?: string;
  /** Line loads (absent: the force shown per the region's length unit). */
  line?: string;
  defl?: string;
  stress?: string;
}

/** Units offered for each kind of result, with their size in SI (N, N·m, m, Pa). */
export const DISPLAY_UNITS: Record<keyof BeamDisplayUnits, [string, number][]> = {
  force: [['kN', 1e3], ['N', 1], ['MN', 1e6], ['kip', FORCE_N.kip], ['lbf', FORCE_N.lbf]],
  moment: [['kN·m', 1e3], ['N·m', 1], ['N·mm', 1e-3], ['kN·cm', 10], ['MN·m', 1e6], ['kip·ft', FORCE_N.kip * 0.3048], ['kip·in', FORCE_N.kip * 0.0254], ['lbf·ft', FORCE_N.lbf * 0.3048], ['lbf·in', FORCE_N.lbf * 0.0254]],
  line: [['kN/m', 1e3], ['N/m', 1], ['N/mm', 1e3], ['kN/mm', 1e6], ['kip/ft', FORCE_N.kip / 0.3048], ['kip/in', FORCE_N.kip / 0.0254], ['lbf/ft', FORCE_N.lbf / 0.3048], ['lbf/in', FORCE_N.lbf / 0.0254]],
  defl: [['mm', 1e-3], ['cm', 1e-2], ['m', 1], ['in', 0.0254], ['ft', 0.3048]],
  stress: [['MPa', 1e6], ['kPa', 1e3], ['GPa', 1e9], ['ksi', 6894757.293168], ['psi', 6894.757293168]],
};

export interface ResolvedUnits {
  /** Unit name and its size in SI, per kind of result. */
  force: [string, number];
  moment: [string, number];
  line: [string, number];
  defl: [string, number];
  stress: [string, number];
}

/** The units results are shown in: the region's choice, else from its length and force units. */
export function displayUnits(r: { lengthUnit: string; forceUnit: string; display?: BeamDisplayUnits }): ResolvedUnits {
  const F = FORCE_N[r.forceUnit] ?? 1e3, L = LENGTH_M[r.lengthUnit] ?? 1;
  const metric = r.lengthUnit === 'm' || r.lengthUnit === 'cm' || r.lengthUnit === 'mm';
  const pick = (k: keyof BeamDisplayUnits, auto: [string, number]): [string, number] => DISPLAY_UNITS[k].find(([n]) => n === r.display?.[k]) ?? auto;
  const force = pick('force', [r.forceUnit, F]);
  return {
    force,
    moment: pick('moment', [`${r.forceUnit}·${r.lengthUnit}`, F * L]),
    line: pick('line', [`${force[0]}/${r.lengthUnit}`, force[1] / L]),
    defl: pick('defl', metric ? ['mm', 1e-3] : ['in', 0.0254]),
    stress: pick('stress', ['MPa', 1e6]),
  };
}
