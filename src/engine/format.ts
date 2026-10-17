// Result values → TeX, following Mathcad's display conventions.
import type { Unit } from 'mathjs';
import { math, isMatrix, isUnit, isComplex } from './math';
import { autoUnit } from './unitCatalog';

export interface FormatOptions {
  precision: number;
  expThreshold: number;
  /** Show results without a requested unit in practical metric units (kN·m, kN/m, MPa …). */
  metric?: boolean;
}

const MAX_ROWS = 40;
const MAX_COLS = 16;

export function numberTex(x: number, o: FormatOptions): string {
  if (Number.isNaN(x)) return '\\mathrm{NaN}';
  if (!Number.isFinite(x)) return x > 0 ? '\\infty' : '-\\infty';
  if (x === 0) return '0';
  const ax = Math.abs(x);
  let exp = Math.floor(Math.log10(ax));
  let fixed = stripZeros(x.toFixed(Math.min(20, o.precision)));
  const looksZero = /^-?0$/.test(fixed);
  if (Math.abs(exp) >= o.expThreshold || looksZero) {
    let mant = x / Math.pow(10, exp);
    let m = stripZeros(mant.toFixed(o.precision));
    if (/^-?10(\.|$)/.test(m)) {
      exp += 1;
      mant /= 10;
      m = stripZeros(mant.toFixed(o.precision));
    }
    return `${m} \\cdot 10^{${exp}}`;
  }
  if (fixed.startsWith('-')) fixed = '-' + group(fixed.slice(1));
  else fixed = group(fixed);
  return fixed;
}

function stripZeros(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

/** Thin-space digit grouping for long integer parts (ISO 80000-1 style). */
function group(s: string): string {
  const [i, f] = s.split('.');
  if (i.length <= 4) return s;
  const g = i.replace(/\B(?=(\d{3})+(?!\d))/g, '\\,');
  return f !== undefined ? `${g}.${f}` : g;
}

export function complexTex(re: number, im: number, o: FormatOptions): string {
  const tiny = 1e-15 * Math.max(Math.abs(re), Math.abs(im));
  if (Math.abs(im) <= tiny) return numberTex(re, o);
  const imAbs = numberTex(Math.abs(im), o);
  const imPart = imAbs === '1' ? 'i' : imAbs + '\\,i';
  if (Math.abs(re) <= tiny) return (im < 0 ? '-' : '') + imPart;
  return `${numberTex(re, o)} ${im < 0 ? '-' : '+'} ${imPart}`;
}

const UNIT_TEX: Record<string, string> = {
  deg: '{}^{\\circ}',
  degC: '{}^{\\circ}\\mathrm{C}',
  degF: '{}^{\\circ}\\mathrm{F}',
  ohm: '\\Omega',
  kohm: '\\mathrm{k}\\Omega',
  Mohm: '\\mathrm{M}\\Omega',
  uohm: '\\mu\\Omega',
  mohm: '\\mathrm{m}\\Omega',
  arcmin: "'",
  arcsec: "''",
};

function unitTokenTex(tok: string): string {
  const m = /^([^^]+)(?:\^(.+))?$/.exec(tok);
  if (!m) return `\\mathrm{${tok}}`;
  let base = UNIT_TEX[m[1]] ?? `\\mathrm{${m[1].replace(/^u(?=[A-Za-z])/, '\\mu ')}}`;
  if (base.startsWith('\\mathrm{\\mu')) base = `\\mu\\mathrm{${m[1].slice(1)}}`;
  const pw = m[2] ? m[2].replace(/[()]/g, '') : '';
  return pw ? `${base}^{${pw}}` : base;
}

/** "kg m / s^2" → TeX */
export function unitStringTex(units: string): string {
  const [numPart, denPart] = units.split(' / ');
  const toks = (s: string) => s.replace(/[()]/g, ' ').trim().split(/\s+/).filter(Boolean).map(unitTokenTex).join('\\cdot ');
  const n = numPart ? toks(numPart) : '1';
  if (!denPart) return n;
  return `\\frac{${n}}{${toks(denPart)}}`;
}

/** Split a unit into display number + display unit string, letting mathjs pick prefix/derived units. */
const ANGLE = 7; // mathjs base dimension of angles

/** The SI number of a quantity whose only dimension is an angle (or none), else the unit. */
function angleFree(u: Unit): number | Unit {
  const d = (u as unknown as { dimensions: number[] }).dimensions;
  if (d.every((x, i) => i === ANGLE || x === 0)) return (u.value as number) ?? 1;
  return u;
}

/**
 * Convert to a display unit, treating angles as plain numbers as Mathcad and SMath do: a 1/s
 * result shows in rad/s, a cm/rad one in cm.
 */
function toLoose(u: Unit, target: string): Unit {
  // 1/s: mathjs wants the unit without the number
  if (/^\s*1\s*\//.test(target)) {
    const t = math.evaluate(target);
    if (isUnit(t)) target = t.formatUnits();
  }
  try {
    return u.to(target);
  } catch (e) {
    const t = math.unit(1, target) as Unit;
    const du = (u as unknown as { dimensions: number[] }).dimensions, dt = (t as unknown as { dimensions: number[] }).dimensions;
    if (!du.every((x, i) => i === ANGLE || Math.abs(x - dt[i]) < 1e-9)) throw e;
    const k = dt[ANGLE] - du[ANGLE];
    return (math.multiply(u, math.pow(math.unit(1, 'rad'), k) as Unit) as Unit).to(target);
  }
}

export function unitParts(u: Unit, target?: string, metric = false): { value: unknown; units: string } {
  if (!target && metric && !(u as unknown as { fixPrefix?: boolean }).fixPrefix) {
    const auto = autoUnit(u);
    if (auto) {
      try {
        return { value: u.toNumeric(auto), units: math.unit(1, auto).formatUnits() };
      } catch {
        /* fall through to mathjs' choice */
      }
    }
  }
  if (target === '%') {
    // a ratio (or an angle, a plain number to Mathcad) shown in percent
    const n = angleFree(u);
    if (typeof n === 'number') return { value: n * 100, units: '%' };
  }
  const disp = target ? toLoose(u, target) : u;
  const s = disp.formatUnits();
  if (!s) return { value: disp.value ?? 1, units: '' };
  if (target || (disp as unknown as { fixPrefix?: boolean }).fixPrefix) {
    return { value: disp.toNumeric(s), units: s };
  }
  // let mathjs choose the best prefix / derived unit, then re-read the unit string
  const str = math.format(disp, { precision: 15 });
  const m = /^\s*(\(.*\)|[-+0-9.eE]+|NaN|-?Infinity)\s+(.*)$/.exec(str);
  const unitsStr = m ? m[2] : s;
  try {
    return { value: disp.toNumeric(unitsStr), units: unitsStr };
  } catch {
    return { value: disp.toNumeric(s), units: s };
  }
}

function scalarTex(v: unknown, o: FormatOptions): string {
  if (typeof v === 'number') return numberTex(v, o);
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (isComplex(v)) return complexTex(v.re, v.im, o);
  if (typeof v === 'string') return `\\text{“${escapeText(v)}”}`;
  if (v === null || v === undefined) return '\\text{(undefined)}';
  if (typeof v === 'function') return '\\text{(function)}';
  return `\\text{${escapeText(String(v))}}`;
}

export function escapeText(s: string): string {
  return s.replace(/[\\{}$&#^_%~]/g, (c) => (c === '\\' ? '\\textbackslash{}' : c === '~' ? '\\textasciitilde{}' : c === '^' ? '\\textasciicircum{}' : '\\' + c));
}

function wrapParens(tex: string): string {
  return /[+-]/.test(tex.replace(/^-/, '').replace(/10\^\{-?\d+\}/g, '')) ? `\\left(${tex}\\right)` : tex;
}

/** Format any engine value as TeX. `target` is an optional unit to convert to. */
export function valueTex(v: unknown, o: FormatOptions, target?: string): string {
  if (isUnit(v)) {
    if (v.value === null) return unitStringTex(v.formatUnits());
    const { value, units } = unitParts(v, target || undefined, o.metric);
    const nt = scalarTex(value, o);
    return units ? `${isComplex(value) ? wrapParens(nt) : nt}\\ ${unitStringTex(units)}` : nt;
  }
  if (target && (typeof v === 'number' || isComplex(v))) {
    // dimensionless value shown in a dimensionless unit, e.g. % or deg
    if (target === '%' && typeof v === 'number') return `${numberTex(v * 100, o)}\\,\\%`;
    let u: Unit;
    try {
      u = math.unit(1, target);
    } catch {
      throw new Error(`"${target}" is not a unit`);
    }
    if (!u.equalBase(math.unit('rad')) && u.dimensions.some((d) => d !== 0)) {
      throw new Error(`Units do not match: the result is dimensionless, not ${target}`);
    }
    const factor = (u.value as number | null) ?? 1;
    if (typeof v === 'number') return `${numberTex(v / factor, o)}\\ ${unitStringTex(u.formatUnits())}`;
  }
  if (isMatrix(v) || Array.isArray(v)) return matrixTex(v, o, target);
  if (isPlainObject(v)) return objectTex(v, o);
  return scalarTex(v, o);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
}

/** Records (e.g. section properties) as a two-column table. */
function objectTex(v: Record<string, unknown>, o: FormatOptions): string {
  const seen = new Set<unknown>();
  const rows = Object.entries(v)
    .filter(([, x]) => {
      // skip ASCII aliases of the same value (θ / theta)
      if (seen.has(x)) return false;
      seen.add(x);
      return true;
    })
    .map(([k, x]) => `\\mathrm{${escapeText(k)}} & ${valueTex(x, o)}`);
  return `\\left\\{\\begin{array}{ll} ${rows.join(' \\\\ ')} \\end{array}\\right.`;
}

function matrixTex(v: unknown, o: FormatOptions, target?: string): string {
  const arr = (isMatrix(v) ? v.toArray() : v) as unknown[];
  let grid: unknown[][];
  if (arr.length === 0) return '\\left[\\;\\right]';
  if (!Array.isArray(arr[0])) grid = arr.map((x) => [x]);
  else grid = arr as unknown[][];
  // factor out a common unit, as Mathcad does
  let common: string | undefined = target || undefined;
  const flat = grid.flat();
  if (!common && flat.length > 0 && flat.every(isUnit)) {
    const first = flat[0] as Unit;
    if (flat.every((u) => (u as Unit).equalBase(first))) {
      const nonZero = (flat as Unit[]).find((u) => (u.value as number) !== 0) ?? first;
      common = unitParts(nonZero, undefined, o.metric).units || undefined;
    }
  }
  const cell = (x: unknown) => {
    if (common && isUnit(x)) {
      try {
        return scalarTex(x.toNumeric(common), o);
      } catch {
        return valueTex(x, o);
      }
    }
    if (isMatrix(x) || Array.isArray(x)) return valueTex(x, o);
    return valueTex(x, o);
  };
  const rows = grid.length;
  const cols = grid[0].length;
  const rIdx = rows > MAX_ROWS ? [...range(0, MAX_ROWS - 2), -1, rows - 1] : range(0, rows);
  const cIdx = cols > MAX_COLS ? [...range(0, MAX_COLS - 2), -1, cols - 1] : range(0, cols);
  const body = rIdx
    .map((r) =>
      cIdx
        .map((c) => (r === -1 ? (c === -1 ? '\\ddots' : '\\vdots') : c === -1 ? '\\cdots' : cell(grid[r][c])))
        .join(' & '),
    )
    .join(' \\\\ ');
  const m = `\\begin{bmatrix} ${body} \\end{bmatrix}`;
  return common ? `${m}\\ ${unitStringTex(common)}` : m;
}

function range(a: number, b: number): number[] {
  return Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
}

/** Plain-text rendering (tooltips, clipboard). */
export function valueText(v: unknown, o: FormatOptions): string {
  try {
    return math.format(v as never, { precision: Math.max(o.precision + 1, 4) });
  } catch {
    return String(v);
  }
}
