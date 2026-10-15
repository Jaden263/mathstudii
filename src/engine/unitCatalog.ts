// Which unit a result is shown in. Without a unit after "=", mathjs picks something
// dimensionally right but often useless to an engineer (a moment as 45 kJ, a line load
// as 3000 kg/s², a unit weight as kg/(m²·s²)). Here every common dimension has a list of
// metric units, and the result is shown in the one that keeps the number readable.
import type { Unit } from 'mathjs';
import { math } from './math';
import { UNIT_SUGGESTIONS, type UnitInfo } from './unitList';

export type { UnitInfo };

interface Family {
  /** Quantity name ("force", "bending moment"). */
  q: string;
  /** Candidates for automatic display, smallest first. */
  auto: string[];
  /** More units offered when choosing a display unit by hand. */
  more?: string[];
}

// dimension vectors in mathjs order: mass, length, time, current, temperature, luminous intensity, amount, angle, bit
const D = (mass: number, length: number, time: number, current = 0, temp = 0, angle = 0): string =>
  [mass, length, time, current, temp, 0, 0, angle, 0].join(',');

const FAMILIES: Record<string, Family> = {
  [D(0, 1, 0)]: { q: 'length', auto: ['mm', 'm', 'km'], more: ['cm', 'dm', 'um'] },
  [D(0, 2, 0)]: { q: 'area', auto: ['mm^2', 'm^2'], more: ['cm^2', 'dm^2', 'ha'] },
  [D(0, 3, 0)]: { q: 'volume, section modulus', auto: ['mm^3', 'cm^3', 'm^3'], more: ['L', 'dm^3'] },
  [D(0, 4, 0)]: { q: 'second moment of area', auto: ['mm^4', 'cm^4', 'm^4'], more: ['dm^4'] },
  [D(0, 6, 0)]: { q: 'warping constant', auto: ['mm^6', 'cm^6', 'm^6'] },
  [D(1, 0, 0)]: { q: 'mass', auto: ['kg', 't'], more: ['gm'] },
  [D(1, 1, -2)]: { q: 'force', auto: ['N', 'kN', 'MN'] },
  [D(1, 2, -2)]: { q: 'moment, torque, energy', auto: ['N m', 'kN m', 'MN m'], more: ['N mm', 'kN mm', 'J', 'kJ', 'kWh'] },
  [D(1, 0, -2)]: { q: 'line load, stiffness', auto: ['N/m', 'kN/m', 'MN/m'], more: ['N/mm', 'kN/mm'] },
  [D(1, -1, -2)]: { q: 'stress, pressure, area load', auto: ['Pa', 'kPa', 'MPa', 'GPa'], more: ['N/mm^2', 'kN/m^2', 'N/m^2', 'kN/cm^2', 'bar'] },
  [D(1, -2, -2)]: { q: 'unit weight, subgrade modulus', auto: ['N/m^3', 'kN/m^3'], more: ['N/mm^3', 'MN/m^3'] },
  [D(1, 3, -2)]: { q: 'bending stiffness EI', auto: ['N m^2', 'kN m^2', 'MN m^2'], more: ['N mm^2', 'kN mm^2'] },
  [D(1, -3, 0)]: { q: 'density', auto: ['kg/m^3'], more: ['t/m^3', 'gm/cm^3'] },
  [D(1, -1, 0)]: { q: 'mass per length', auto: ['kg/m'] },
  [D(1, -2, 0)]: { q: 'mass per area', auto: ['kg/m^2'] },
  [D(1, 2, -3)]: { q: 'power', auto: ['W', 'kW', 'MW'] },
  [D(0, 1, -1)]: { q: 'velocity', auto: ['m/s'], more: ['km/hr', 'mm/s'] },
  [D(0, 1, -2)]: { q: 'acceleration', auto: ['m/s^2'] },
  [D(0, 3, -1)]: { q: 'flow rate', auto: ['m^3/s'], more: ['L/s', 'm^3/hr'] },
  [D(0, 0, -1)]: { q: 'frequency', auto: ['Hz', 'kHz', 'MHz'], more: ['rpm'] },
  [D(1, 2, -2, 0, 0, -1)]: { q: 'rotational stiffness', auto: ['N m/rad', 'kN m/rad', 'MN m/rad'] },
  [D(1, 2, -3, -1)]: { q: 'voltage', auto: ['V', 'kV'], more: ['mV'] },
  [D(0, 0, 0, 1)]: { q: 'current', auto: ['A'], more: ['mA', 'kA'] },
  [D(1, 2, -3, -2)]: { q: 'resistance', auto: ['ohm', 'kohm'] },
};

/** Energy and power units: a [M L² T⁻²] result built from these is energy, not a moment. */
const ENERGY_UNITS = new Set(['J', 'Wh', 'W', 'cal', 'kcal', 'BTU', 'eV', 'erg', 'hp']);

export function dimsOf(u: Unit): number[] {
  return [...(u as unknown as { dimensions: number[] }).dimensions];
}

const factorCache = new Map<string, number | null>();
function factor(unit: string): number | null {
  if (!factorCache.has(unit)) {
    try {
      factorCache.set(unit, math.unit(1, unit).value as number);
    } catch {
      factorCache.set(unit, null);
    }
  }
  return factorCache.get(unit)!;
}

type UnitParts = { units: { unit: { name: string; base: { key: string } } }[] };

function bases(u: Unit): Set<string> {
  return new Set((u as unknown as UnitParts).units.map((x) => x.unit.base.key));
}

function names(u: Unit): string[] {
  return (u as unknown as UnitParts).units.map((x) => x.unit.name);
}

/** Pick the largest candidate that keeps |value| ≥ 1 (the smallest for tiny values). */
function pick(si: number, list: string[]): string {
  if (si === 0 || !Number.isFinite(si)) return list[Math.min(1, list.length - 1)];
  let best = list[0];
  for (const c of list) {
    const f = factor(c);
    if (f && Math.abs(si) / f >= 1 - 1e-9) best = c;
  }
  return best;
}

/**
 * The metric unit to show this value in, or null to leave the choice to mathjs
 * (dimensions without a family, dimensionless values, complex values).
 */
export function autoUnit(u: Unit): string | null {
  const si = u.value as unknown;
  if (typeof si !== 'number') return null;
  const key = dimsOf(u).join(',');
  const fam = FAMILIES[key];
  if (!fam) return null;
  const b = bases(u);
  if (key === D(1, 2, -2) && names(u).some((x) => ENERGY_UNITS.has(x))) return pick(si, ['J', 'kJ', 'MJ', 'GJ']);
  if (key === D(1, -1, -2) && !b.has('PRESSURE') && Math.abs(si) < 1e6) {
    // loads built from forces and lengths read better as kN/m² than kPa
    return pick(si, ['N/m^2', 'kN/m^2']);
  }
  return pick(si, fam.auto);
}

/** Units a value of these dimensions can be shown in (for menus and suggestions). */
export function compatibleUnits(dims: number[]): UnitInfo[] {
  const fam = FAMILIES[dims.join(',')];
  if (!fam) return [];
  const seen = new Set<string>();
  const out: UnitInfo[] = [];
  for (const u of [...fam.auto, ...(fam.more ?? [])]) {
    if (seen.has(u) || factor(u) === null) continue;
    seen.add(u);
    out.push({ u, name: fam.q });
  }
  return out;
}

/** Name of the quantity with these dimensions, if it is a common one. */
export function quantityName(dims: number[]): string | null {
  return FAMILIES[dims.join(',')]?.q ?? null;
}

// ---------------------------------------------------------------- did you mean

function distance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)] as number[]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

/** The closest known name (variable, function or unit) to a misspelt one, if any is close. */
export function closestName(word: string, names: Iterable<string>): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  const limit = word.length <= 3 ? 1 : 2;
  const lower = word.toLowerCase();
  for (const n of names) {
    if (n === word || n.length < 1) continue;
    // a different case only ("kn" → "kN") is the most likely typo; then a missing ending
    // ("sqr" → "sqrt"), then the same first letter
    const raw = n.toLowerCase() === lower ? 0.5 : word.length === 1 ? Infinity : distance(word, n);
    if (raw > limit) continue;
    const d = raw - (n.startsWith(word) || word.endsWith(n) ? 0.3 : 0) - (n[0] === word[0] ? 0.1 : 0);
    if (d < bestD || (d === bestD && best !== null && n.length < best.length)) {
      best = n;
      bestD = d;
    }
  }
  return best;
}

const SIMPLE_UNITS = UNIT_SUGGESTIONS.map((x) => x.u).filter((u) => /^[A-Za-z]+$/.test(u));

/** Unit names worth suggesting as a correction. */
export function unitNames(): string[] {
  return SIMPLE_UNITS;
}
