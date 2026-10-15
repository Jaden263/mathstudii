// Find and replace across a worksheet: math, text, Python, solve blocks, plots, tables
// and the expressions inside sketches, beams and CAD parts (dimensions, loads, sections).
// With "whole name" a match must not be part of a longer name, which makes Replace all a
// rename: L → L_span changes L and L^2 but not L_cr or Load.
import type { Region, Worksheet } from './types';

export interface SearchOptions {
  /** Match case (default true for names). */
  caseSensitive: boolean;
  /** Only whole names: not inside a longer identifier. */
  wholeName: boolean;
}

/** Fields that hold identifiers, settings or data rather than text the user typed. */
const SKIP = new Set([
  'id', 'kind', 'type', 'src', 'color', 'background', 'lengthUnit', 'forceUnit', 'unit', 'mode', 'layout', 'show', 'panels',
  'plotType', 'textFont', 'style', 'op', 'dir', 'family', 'logo', 'component', 'occ', 'sketch', 'member', 'node', 'refs', 'targets',
  'profiles', 'points', 'a', 'b', 'p1', 'p2', 'center', 'axis', 'axis2', 'plane', 'feature', 'tools', 'target', 'entities', 'ref',
]);

const NAME_CHAR = /[\p{L}\p{N}_']/u;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function searchRegex(query: string, o: SearchOptions): RegExp | null {
  if (!query) return null;
  const body = escapeRe(query);
  const flags = o.caseSensitive ? 'gu' : 'giu';
  return new RegExp(o.wholeName ? `(?<![\\p{L}\\p{N}_'])${body}(?![\\p{L}\\p{N}_'])` : body, flags);
}

/** Call fn for every user string in a region; fn returns the replacement (or the same string). */
function mapStrings(v: unknown, fn: (s: string) => string, key = ''): unknown {
  if (typeof v === 'string') return SKIP.has(key) ? v : fn(v);
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const y = mapStrings(x, fn, key);
      if (y !== x) changed = true;
      return y;
    });
    return changed ? out : v;
  }
  if (v && typeof v === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const y = SKIP.has(k) ? x : mapStrings(x, fn, k);
      if (y !== x) changed = true;
      out[k] = y;
    }
    return changed ? out : v;
  }
  return v;
}

/** Number of matches in each region that has some, in reading order. */
export function findInWorksheet(ws: Worksheet, query: string, o: SearchOptions): { id: string; count: number }[] {
  const re = searchRegex(query, o);
  if (!re) return [];
  const out: { id: string; count: number }[] = [];
  const ordered = [...ws.regions].sort((a, b) => (Math.abs(a.y - b.y) < 4 ? a.x - b.x : a.y - b.y));
  for (const r of ordered) {
    let count = 0;
    mapStrings(r, (s) => {
      count += s.match(re)?.length ?? 0;
      return s;
    });
    if (count) out.push({ id: r.id, count });
  }
  return out;
}

/** The region with every match replaced, or null when nothing matched. */
export function replaceInRegion(r: Region, query: string, replacement: string, o: SearchOptions): { region: Region; count: number } | null {
  const re = searchRegex(query, o);
  if (!re) return null;
  let count = 0;
  const out = mapStrings(r, (s) => s.replace(re, () => {
    count++;
    return replacement;
  })) as Region;
  return count ? { region: out, count } : null;
}

/** Is this a plausible new variable name? */
export function isName(s: string): boolean {
  return /^[\p{L}_][\p{L}\p{N}_']*$/u.test(s) && NAME_CHAR.test(s[0]);
}
