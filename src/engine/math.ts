import { create, all, type MathJsInstance, type Unit } from 'mathjs';

/** The single mathjs instance used by the engine. */
export const math: MathJsInstance = create(all, { number: 'number', precision: 64 });

// Names may be written in any alphabet (Длина, Höhe), as in Mathcad and SMath; mathjs itself
// takes Latin and Greek letters only.
{
  const parse = math.parse as unknown as { isAlpha: (c: string, prev: string, next: string) => boolean };
  const latinOrGreek = parse.isAlpha;
  parse.isAlpha = (c, prev, next) => latinOrGreek(c, prev, next) || /^\p{L}$/u.test(c);
}

// Units engineers expect that mathjs lacks. Mathcad spells gram "gm" because
// "g" is the standard acceleration of gravity.
const extraUnits: Record<string, string> = {
  gm: '1 g',
  mph: '1 mile/hour',
  kph: '1 km/hour',
  kmh: '1 km/hour',
  knot: '1852 m/hour',
  rev: '1 cycle',
  rpm: '1 cycle/minute',
  ksi: '1000 psi',
  kipf: '1 kip',
  tonf: '2000 lbf',
  cal: '4.184 J',
  kcal: '4184 J',
  mmHg: '133.322387415 Pa',
  inHg: '3386.389 Pa',
  mbar: '100 Pa',
  ha: '10000 m^2',
  are: '100 m^2',
  dyn: '1e-5 N',
  erg: '1e-7 J',
  St: '1e-4 m^2/s',
  cSt: '1e-6 m^2/s',
  P: '0.1 Pa s',
  cP: '0.001 Pa s',
  Mach: '340.29 m/s',
  pcf: '1 lb/ft^3',
  slug: '14.59390294 kg',
  galUK: '4.54609 L',
  // how engineers write moments
  Nm: '1 N m',
  kNm: '1 kN m',
  MNm: '1 MN m',
  Nmm: '1 N mm',
  kNmm: '1 kN mm',
};

// The 2022 SI prefixes ronto/quecto/ronna/quetta make typos valid: "rm" would be a
// ronto-metre (1e-27 m) and "kN/rm" a silently absurd number. Nobody calculates in them.
{
  const prefixes = (math.Unit as unknown as { PREFIXES: Record<string, Record<string, unknown>> }).PREFIXES;
  for (const table of Object.values(prefixes)) for (const p of ['r', 'q', 'R', 'Q', 'ronto', 'quecto', 'ronna', 'quetta']) delete table[p];
}
for (const [name, def] of Object.entries(extraUnits)) {
  try {
    if (!math.Unit.isValuelessUnit(name)) math.createUnit(name, def);
  } catch (e) {
    // a definition mathjs cannot parse is a bug in this table, not something to hide
    if (!math.Unit.isValuelessUnit(name)) console.warn(`Could not define unit ${name}: ${(e as Error).message}`);
  }
}

// mathjs' default 'auto' unit system learns from every parsed unit string, which
// makes result display depend on history. A fixed system keeps output deterministic.
math.Unit.setUnitSystem('si');

/** Names that are units (and are not shadowed by a user definition). */
export function isUnitName(name: string): boolean {
  try {
    return math.Unit.isValuelessUnit(name);
  } catch {
    return false;
  }
}

export function isUnit(v: unknown): v is Unit {
  return !!v && typeof v === 'object' && (v as { isUnit?: boolean }).isUnit === true;
}

export function isMatrix(v: unknown): v is import('mathjs').Matrix {
  return !!v && typeof v === 'object' && (v as { isMatrix?: boolean }).isMatrix === true;
}

export function isComplex(v: unknown): v is import('mathjs').Complex {
  return !!v && typeof v === 'object' && (v as { isComplex?: boolean }).isComplex === true;
}

/**
 * Split a physical quantity into its SI magnitude and a "unit template" (the
 * same unit with SI value 1), so numerical algorithms can work on plain numbers
 * and re-attach dimensions afterwards.
 */
export function splitUnit(v: unknown): { value: number; unit: Unit | null } {
  if (typeof v === 'number') return { value: v, unit: null };
  if (typeof v === 'boolean') return { value: v ? 1 : 0, unit: null };
  if (isUnit(v)) {
    if (v.value === null) return { value: 1, unit: withValue(v, 1) };
    const val = v.value as unknown;
    if (typeof val !== 'number') throw new Error('Complex-valued quantities are not supported here');
    return { value: val, unit: withValue(v, 1) };
  }
  if (isMatrix(v) || Array.isArray(v)) {
    const flat = math.flatten(isMatrix(v) ? v.toArray() : v) as unknown[];
    if (flat.length === 1) return splitUnit(flat[0]);
  }
  if (isComplex(v)) {
    if (Math.abs(v.im) < 1e-14 * Math.max(1, Math.abs(v.re))) return { value: v.re, unit: null };
    throw new Error('Expected a real value, got a complex number');
  }
  throw new Error('Expected a scalar value');
}

function withValue(u: Unit, value: number): Unit {
  const c = u.clone();
  (c as unknown as { value: number }).value = value;
  return c;
}

/** value (SI) with the unit of a template from splitUnit, without unit arithmetic (fast). */
export function quantity(value: number, unit: Unit | null): number | Unit {
  return unit ? withValue(unit, value) : value;
}

export function joinUnit(value: number, unit: Unit | null): number | Unit {
  if (!unit) return value;
  return math.multiply(value, unit) as Unit;
}

/** Numeric value of a scalar in SI (dimensionless numbers pass through). */
export function toSINumber(v: unknown): number {
  return splitUnit(v).value;
}
