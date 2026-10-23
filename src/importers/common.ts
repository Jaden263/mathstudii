// Helpers shared by the Mathcad and SMath importers.
import { PAGE_MARGIN, PAGE_WIDTH, type Region, type Worksheet } from '../model/types';

export interface ImportResult {
  ws: Worksheet;
  warnings: string[];
  format: string;
  /** Results the program saved with the file, to check the recalculated ones against (saved.ts). */
  saved?: SavedResult[];
  /** Worksheets the file references whose definitions it does not keep (to pick and import again). */
  references?: string[];
}

/** A result shown in the file as the source program last calculated it. */
export interface SavedResult {
  regionId: string;
  /** The value as a worksheet expression: numbers with units, [a; b] matrices, "strings". */
  expr: string;
  /** Relative tolerance of the comparison (a value saved rounded to its display). */
  tol?: number;
  /** A matrix saved as the part in view (SMath keeps at most `rows` × `cols` from row `row`, column `col`). */
  window?: { row: number; col: number; rows: number; cols: number };
}

/** Thrown for constructs an importer recognises but cannot convert. */
export class Unsupported extends Error {}

export const RESERVED = new Set(['in', 'to', 'and', 'or', 'not', 'xor', 'mod', 'end', 'if', 'for', 'while', 'return', 'else', 'break', 'continue', 'null', 'undefined', 'true', 'false']);

export const UNIT_MAP: Record<string, string> = {
  '°': 'deg', '°C': 'degC', '°F': 'degF', 'Δ°C': 'K', 'Δ°F': '(5/9 K)', Ω: 'ohm', kΩ: 'kohm', MΩ: 'Mohm',
  yr: 'year', Å: 'angstrom', lbm: 'lb', lb: 'lb', ozm: 'oz', ton: 'ton', tonne: 'tonne', mtonne: 'tonne',
  psf: '(lbf/ft^2)', kgf: 'kgf', '%': '%', rev: 'rev', rpm: 'rpm', L: 'L', liter: 'L', galUK: 'galUK',
  // "in" is a keyword here
  in: 'inch', kph: '(km/hr)', ksi: '(1000 psi)',
};

/**
 * A worksheet identifier: letters, digits and _; never a reserved word. A prime in a name (N', f′c)
 * becomes ʹ (U+0374, a letter), since here x' is a transpose or a derivative.
 */
export function sanitize(name: string): string {
  let s = [...name.replace(/['′]/g, '\u0374')].map((ch) => (/[\p{L}\p{N}_]/u.test(ch) ? ch : '_')).join('').replace(/_+/g, '_').replace(/^_+(?=.)/, '');
  if (!s) s = '_';
  if (/^\d/.test(s)) s = `_${s}`;
  if (RESERVED.has(s)) s += '_';
  return s;
}

export function unitName(name: string): string {
  if (UNIT_MAP[name]) return UNIT_MAP[name];
  // μ / µ prefixes become "u" (μm → um), Ω is ohm (kΩ → kohm)
  return name.replace(/^[μµ]/, 'u').replace(/Ω$/, 'ohm');
}

/** Operator precedence of the linear syntax, for minimal parentheses. */
export const P = { ATOM: 100, POST: 90, POW: 80, NEG: 70, MUL: 60, ADD: 50, CMP: 40, NOT: 35, AND: 30, OR: 20, RANGE: 5 };

export interface Ex {
  s: string;
  p: number;
}

export const wrap = (e: Ex, min: number): string => (e.p < min ? `(${e.s})` : e.s);

export const isNumberLiteral = (s: string) => /^-?[\d.]+(e[+-]?\d+)?$/i.test(s);

export function toBase64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Scale imported positions so the page fits our page width, and keep regions off the edges.
 * Mathcad users park helper calculations far to the right of the printed page: those are
 * moved to the right edge (same height, so the order they calculate in stays) rather than
 * squeezing the whole page into a strip. Returns how many were moved.
 */
export function fitToPage(regions: Region[], pageWidth = 0): number {
  const right = (q: Region) => q.x + ('width' in q ? (q as { width: number }).width : 200);
  const limit = PAGE_WIDTH - PAGE_MARGIN / 2;
  const page = pageWidth || Math.max(...regions.map(right), 0);
  const inPage = regions.filter((q) => q.x < page * 1.05);
  const maxRight = Math.max(...inPage.map(right), 0);
  const sx = maxRight > limit ? limit / maxRight : 1;
  let moved = 0;
  for (const q of regions) {
    if (q.x >= page * 1.05) {
      moved++;
      q.x = Math.round(limit - Math.min(240, ('width' in q ? (q as { width: number }).width : 200) * sx));
    } else q.x = Math.max(8, Math.round(q.x * sx));
    q.y = Math.max(8, Math.round(q.y));
  }
  return moved;
}
