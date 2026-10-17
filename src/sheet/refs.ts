// A1 references: "B7", "$A$1", "A1:C10", "A:A", "3:3", "'My sheet'!B2". Rows and columns
// are 0-based inside the engine and 1-based / lettered in the notation.

export const MAX_ROWS = 1048576;
export const MAX_COLS = 16384;

/** 0 → "A", 25 → "Z", 26 → "AA". */
export function colName(c: number): string {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** "A" → 0, "AA" → 26; -1 when it is not a column. */
export function colIndex(s: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(s)) return -1;
  let n = 0;
  for (const ch of s.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1 < MAX_COLS ? n - 1 : -1;
}

export const cellName = (r: number, c: number) => `${colName(c)}${r + 1}`;

/** A rectangle of cells, inclusive; absolute flags only matter when a formula is copied. */
export interface Area {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface CellAddr {
  r: number;
  c: number;
}

/** "B7" → { r: 6, c: 1 } (dollars allowed); null otherwise. */
export function parseCell(s: string): CellAddr | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(s.trim());
  if (!m) return null;
  const c = colIndex(m[1]), r = Number(m[2]) - 1;
  return c >= 0 && r >= 0 && r < MAX_ROWS ? { r, c } : null;
}

/** A sheet name as written in a formula: quoted when it is not a plain word. */
export function quoteSheet(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !parseCell(name) && !/^R\d*C\d*$/i.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

export interface RangeRef extends Area {
  sheet?: string;
}

/**
 * "A1", "A1:C3", "A:B", "2:5", optionally "Sheet!…" or "'Sheet name'!…".
 * Returns null for anything else (names are resolved by the caller).
 */
export function parseRange(text: string): RangeRef | null {
  let s = text.trim();
  let sheet: string | undefined;
  const q = /^'((?:[^']|'')+)'!/.exec(s) ?? /^([^'!:\s]+)!/.exec(s);
  if (q) {
    sheet = q[1].replace(/''/g, "'");
    s = s.slice(q[0].length);
  }
  const [a, b = a, extra] = s.split(':');
  if (extra !== undefined) return null;
  const p1 = parseCell(a), p2 = parseCell(b);
  if (p1 && p2) return { sheet, r1: Math.min(p1.r, p2.r), c1: Math.min(p1.c, p2.c), r2: Math.max(p1.r, p2.r), c2: Math.max(p1.c, p2.c) };
  if (b !== a || s.includes(':')) {
    const ca = colIndex(a.replace(/\$/g, '')), cb = colIndex(b.replace(/\$/g, ''));
    if (ca >= 0 && cb >= 0) return { sheet, r1: 0, c1: Math.min(ca, cb), r2: MAX_ROWS - 1, c2: Math.max(ca, cb) };
    const ra = /^\$?\d+$/.test(a) ? Number(a.replace('$', '')) - 1 : -1, rb = /^\$?\d+$/.test(b) ? Number(b.replace('$', '')) - 1 : -1;
    if (ra >= 0 && rb >= 0) return { sheet, r1: Math.min(ra, rb), c1: 0, r2: Math.max(ra, rb), c2: MAX_COLS - 1 };
  }
  return null;
}

/** "A1:C3" (or "A1" for one cell). */
export function areaName(a: Area): string {
  return a.r1 === a.r2 && a.c1 === a.c2 ? cellName(a.r1, a.c1) : `${cellName(a.r1, a.c1)}:${cellName(a.r2, a.c2)}`;
}

export const areaRows = (a: Area) => a.r2 - a.r1 + 1;
export const areaCols = (a: Area) => a.c2 - a.c1 + 1;
export const inArea = (a: Area, r: number, c: number) => r >= a.r1 && r <= a.r2 && c >= a.c1 && c <= a.c2;
export const overlaps = (a: Area, b: Area) => a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2;

/** Cell key in maps: row-major, fits a double exactly for every Excel cell. */
export const key = (r: number, c: number) => r * MAX_COLS + c;
export const keyRow = (k: number) => Math.floor(k / MAX_COLS);
export const keyCol = (k: number) => k % MAX_COLS;
