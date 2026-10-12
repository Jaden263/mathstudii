// Helpers shared by the Mathcad and SMath importers.
import { PAGE_MARGIN, PAGE_WIDTH, type Region, type Worksheet } from '../model/types';

export interface ImportResult {
  ws: Worksheet;
  warnings: string[];
  format: string;
}

/** Thrown for constructs an importer recognises but cannot convert. */
export class Unsupported extends Error {}

export const RESERVED = new Set(['in', 'to', 'and', 'or', 'not', 'xor', 'mod', 'end', 'if', 'for', 'while', 'return', 'else', 'break', 'continue']);

export const UNIT_MAP: Record<string, string> = {
  '°': 'deg', '°C': 'degC', '°F': 'degF', 'Δ°C': 'K', 'Δ°F': '(5/9 K)', Ω: 'ohm', kΩ: 'kohm', MΩ: 'Mohm',
  yr: 'year', Å: 'angstrom', lbm: 'lb', lb: 'lb', ozm: 'oz', ton: 'ton', tonne: 'tonne', mtonne: 'tonne',
  psf: '(lbf/ft^2)', kgf: 'kgf', '%': '%', rev: 'rev', rpm: 'rpm', L: 'L', liter: 'L', galUK: 'galUK',
};

/** A worksheet identifier: letters, digits, _ and '; never a reserved word. */
export function sanitize(name: string): string {
  let s = [...name].map((ch) => (/[\p{L}\p{N}_']/u.test(ch) ? ch : '_')).join('').replace(/_+/g, '_').replace(/^_+(?=.)/, '');
  if (!s) s = '_';
  if (/^\d/.test(s)) s = `_${s}`;
  if (RESERVED.has(s)) s += '_';
  return s;
}

export function unitName(name: string): string {
  if (UNIT_MAP[name]) return UNIT_MAP[name];
  // μ / µ prefixes become "u" (μm → um)
  return name.replace(/^[μµ]/, 'u');
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

/** Scale imported positions so everything fits the page width, and keep regions off the edges. */
export function fitToPage(regions: Region[]): void {
  const maxRight = Math.max(...regions.map((q) => q.x + ('width' in q ? (q as { width: number }).width : 200)), 0);
  const limit = PAGE_WIDTH - PAGE_MARGIN / 2;
  const sx = maxRight > limit ? limit / maxRight : 1;
  for (const q of regions) {
    q.x = Math.max(8, Math.round(q.x * sx));
    q.y = Math.max(8, Math.round(q.y));
  }
}
