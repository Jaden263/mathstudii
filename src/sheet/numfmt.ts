// Number formats: the codes Excel stores in styles.xml and TEXT() takes ("0.00", "#,##0",
// "0%", "0.00E+00", "yyyy-mm-dd", "h:mm", sections "pos;neg;zero;text", literals in quotes).
// Fractions, locales and conditions are not handled: such codes show the number as General.
import { serialParts } from './dates';
import { displayText, generalDisplay, numberText, type Scalar } from './values';

/** Built-in format ids of ECMA-376 §18.8.30 (short dates are shown ISO style). */
export const BUILTIN_FORMATS: Record<number, string> = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: 'yyyy-mm-dd', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss',
  22: 'yyyy-mm-dd h:mm', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@',
};

/** Split at the ";" that separate sections (not inside quotes or after a backslash). */
function sections(code: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"') q = !q;
    if (!q && ch === '\\') { cur += ch + (code[++i] ?? ''); continue; }
    if (!q && ch === ';') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** The code without quoted text, escapes and [Red]-like brackets: what decides its kind. */
const bare = (s: string) => s.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[(?!h\]|hh\]|m\]|mm\]|s\]|ss\])[^\]]*\]/gi, '').replace(/[_*]./g, '');

export function isDateFormat(code: string): boolean {
  const b = bare(sections(code)[0]);
  return !/^general$/i.test(b.trim()) && /[ymdhs]/i.test(b.replace(/E[+-]/gi, ''));
}

/** A value in a cell with this format, as shown. */
export function formatValue(v: Scalar, code: string | undefined, date1904 = false): string {
  if (!code || /^general$/i.test(code.trim()) || typeof v !== 'number') {
    if (typeof v === 'string' && code) {
      const secs = sections(code);
      const textSec = secs.length >= 4 ? secs[3] : secs.find((s) => bare(s).includes('@'));
      if (textSec) return literalize(textSec, (lit) => lit, v);
    }
    return displayText(v);
  }
  return formatNumber(v, code, date1904);
}

/** TEXT(value, format) and the cell display of numbers. */
export function formatNumber(x: number, code: string, date1904 = false): string {
  const secs = sections(code);
  let sec = secs[0];
  let val = x;
  // a negative section shows the magnitude (its own minus sign, brackets … are literals)
  if (x < 0 && secs.length >= 2 && secs[1] !== '') { sec = secs[1]; val = -x; }
  else if (x === 0 && secs.length >= 3) sec = secs[2];
  const b = bare(sec);
  if (/^\s*general\s*$/i.test(b)) return generalDisplay(val);
  if (isDateFormat(sec)) return formatDate(val, sec, date1904);
  if (!/[0#?]/.test(b)) return literalize(sec, (lit) => lit, numberText(val));
  if (/[0#?]\s*\/\s*([0#?]|\d)/.test(b)) return formatFraction(val, sec);
  return formatDigits(val, sec);
}

/** Copy the literal parts of a section, calling `fill` for the placeholder run. */
function literalize(sec: string, keep: (lit: string) => string, text: string): string {
  let out = '';
  for (let i = 0; i < sec.length; i++) {
    const ch = sec[i];
    if (ch === '"') { const j = sec.indexOf('"', i + 1); out += sec.slice(i + 1, j < 0 ? undefined : j); i = j < 0 ? sec.length : j; }
    else if (ch === '\\') out += sec[++i] ?? '';
    else if (ch === '[') { const j = sec.indexOf(']', i); i = j < 0 ? sec.length : j; }
    else if (ch === '_') { out += ' '; i++; }
    else if (ch === '*') i++;
    else if (ch === '@') out += text;
    else if (/^general/i.test(sec.slice(i))) { out += text; i += 6; }
    else out += keep(ch);
  }
  return out;
}

function formatDigits(x: number, sec: string): string {
  // the placeholder run: digit placeholders with . , and an exponent; the rest is literal
  const b = sec.replace(/"[^"]*"|\\.|\[[^\]]*\]|[_*]./g, (m) => '\u0000'.repeat(m.length));
  const first = b.search(/[0#?]/);
  let end = first;
  while (end < b.length) {
    if (/[0#?.,]/.test(b[end])) end++;
    else if (/[Ee]/.test(b[end]) && /[+-]/.test(b[end + 1] ?? '')) end += 2;
    else break;
  }
  const run = sec.slice(first, end);
  const pct = (b.match(/%/g) ?? []).length;
  let v = Math.abs(x) * Math.pow(100, pct);
  const expM = /[Ee]([+-])([0#?]+)/.exec(run);
  let mantissa = expM ? run.slice(0, expM.index) : run;
  // commas after the last digit placeholder scale by 1000 each
  const scale = /,+$/.exec(mantissa);
  if (scale) {
    mantissa = mantissa.slice(0, scale.index);
    if (!expM) v /= Math.pow(1000, scale[0].length);
  }
  const [intPat, decPat] = mantissa.split('.');
  const decPlaces = (decPat?.match(/[0#?]/g) ?? []).length;
  const minDec = (decPat?.match(/0/g) ?? []).length;
  const minInt = (intPat.match(/0/g) ?? []).length;
  let exp = 0;
  if (expM && v !== 0) {
    // engineering formats (##0.0E+0) keep the exponent a multiple of the integer width
    const step = Math.max(1, (intPat.match(/[0#?]/g) ?? []).length);
    const lead = step > 1 ? 1 : Math.max(1, minInt);
    exp = Math.floor(Math.log10(v));
    exp = step > 1 ? Math.floor(exp / step) * step : exp - (lead - 1);
    v /= Math.pow(10, exp);
    const limit = Math.pow(10, step > 1 ? step : lead);
    if (Number(roundHalfUp(v, decPlaces)) >= limit) { v /= Math.pow(10, step); exp += step; }
  }
  let [ip, dp = ''] = roundHalfUp(v, decPlaces).split('.');
  while (dp.length > minDec && dp.endsWith('0')) dp = dp.slice(0, -1);
  if (ip === '0' && minInt === 0) ip = '';
  ip = ip.padStart(minInt, '0');
  if (intPat.includes(',')) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let num = decPat !== undefined ? `${ip}.${dp}` : ip;
  if (expM) num += `E${exp < 0 ? '-' : expM[1] === '+' ? '+' : ''}${String(Math.abs(exp)).padStart(expM[2].length, '0')}`;
  return literalize(sec.slice(0, first), (c) => c, '') + (x < 0 ? '-' : '') + num + literalize(sec.slice(end), (c) => c, '');
}

/**
 * Fractions: "# ?/?" (3.5 → 3 1/2), "?/??" (improper), "# ?/8" (eighths). The fraction is
 * the closest one whose denominator has as many digits as the placeholders.
 */
function formatFraction(x: number, sec: string): string {
  const m = /^(.*?)(?:([#0?,]+)(\s+))?([#0?]+)(\s*\/\s*)([#0?]+|\d+)(.*)$/.exec(sec);
  if (!m) return generalDisplay(x);
  const [, pre, intPat, gap, numPat, slash, denPat, post] = m;
  const ax = Math.abs(x);
  let ip = intPat ? Math.floor(ax) : 0;
  const frac = ax - ip;
  let num: number, den: number;
  if (/^\d+$/.test(denPat)) {
    den = Number(denPat);
    num = Math.round(frac * den);
  } else {
    [num, den] = closestFraction(frac, Math.pow(10, denPat.length) - 1);
  }
  if (intPat && num === den) { ip += 1; num = 0; }
  const pad = (n: number, pat: string) => String(n).padStart(pat.length, pat.includes('0') ? '0' : ' ');
  const intText = intPat ? (ip === 0 && !intPat.includes('0') ? '' : String(ip)) : '';
  const fracText = num === 0 && intPat ? ' '.repeat(numPat.length + slash.length + denPat.length) : `${pad(num, numPat)}${slash}${/^\d+$/.test(denPat) ? denPat : String(den).padEnd(denPat.length, ' ')}`;
  const body = intText ? `${intText}${gap}${fracText}` : fracText;
  return literalize(pre, (c) => c, '') + (x < 0 ? '-' : '') + body + literalize(post, (c) => c, '');
}

/** The fraction p/q closest to x (0 ≤ x < 1, or any x ≥ 0) with q ≤ maxDen (continued fractions). */
function closestFraction(x: number, maxDen: number): [number, number] {
  let [p0, q0, p1, q1] = [0, 1, 1, 0];
  let v = x;
  for (let i = 0; i < 64; i++) {
    const a = Math.floor(v);
    const p2 = a * p1 + p0, q2 = a * q1 + q0;
    if (q2 > maxDen) {
      // the best semiconvergent below the limit, if it is closer
      const k = Math.floor((maxDen - q0) / q1);
      const ps = k * p1 + p0, qs = k * q1 + q0;
      return Math.abs(ps / qs - x) < Math.abs(p1 / q1 - x) ? [ps, qs] : [p1, q1];
    }
    [p0, q0, p1, q1] = [p1, q1, p2, q2];
    if (Math.abs(v - a) < 1e-12) break;
    v = 1 / (v - a);
  }
  return [p1, q1];
}

/** x.toFixed(d) with halves rounded away from zero on the decimal digits (1.005 → 1.01). */
function roundHalfUp(x: number, d: number): string {
  const n = Number(Math.round(Number(`${Number(x.toPrecision(15))}e${d}`)) + `e-${d}`);
  return n.toFixed(d);
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatDate(x: number, sec: string, date1904: boolean): string {
  // tokens: literal runs and date/time codes
  const toks: { code?: string; lit?: string }[] = [];
  for (let i = 0; i < sec.length; i++) {
    const ch = sec[i];
    if (ch === '"') { const j = sec.indexOf('"', i + 1); toks.push({ lit: sec.slice(i + 1, j < 0 ? undefined : j) }); i = j < 0 ? sec.length : j; continue; }
    if (ch === '\\') { toks.push({ lit: sec[++i] ?? '' }); continue; }
    if (ch === '_') { toks.push({ lit: ' ' }); i++; continue; }
    if (ch === '*') { i++; continue; }
    if (ch === '[') {
      const j = sec.indexOf(']', i);
      const inner = sec.slice(i + 1, j);
      if (/^(h+|m+|s+)$/i.test(inner)) toks.push({ code: `[${inner.toLowerCase()}]` });
      i = j < 0 ? sec.length : j;
      continue;
    }
    const ampm = /^(AM\/PM|A\/P)/i.exec(sec.slice(i));
    // a/p keeps its case (2 p, 2 P); am/pm is always AM or PM
    if (ampm) { toks.push({ code: ampm[1].length === 3 ? (ampm[1][0] === 'a' ? 'a/p' : 'A/P') : 'AM/PM' }); i += ampm[1].length - 1; continue; }
    const run = /^(y+|m+|d+|h+|s+|0+)/i.exec(sec.slice(i));
    if (run && (run[1][0] !== '0' || toks.at(-1)?.lit === '.')) { toks.push({ code: run[1].toLowerCase() }); i += run[1].length - 1; continue; }
    toks.push({ lit: ch });
  }
  // seconds are rounded to the fraction digits shown (6.009 s as s.00 is 6.01), not cut
  const frac = Math.min(3, Math.max(0, ...toks.filter((t) => t.code && /^0+$/.test(t.code)).map((t) => t.code!.length)));
  const step = Math.pow(10, 3 - frac);
  const days = Math.floor(x);
  const p = serialParts(days + (Math.round(((x - days) * 86400000) / step) * step) / 86400000, date1904);
  const has12 = toks.some((t) => t.code === 'AM/PM' || t.code === 'A/P' || t.code === 'a/p');
  // "m" after an hour or before a second is minutes
  const codes = toks.map((t, i) => {
    if (!t.code || !/^m{1,2}$/.test(t.code)) return t.code;
    const prev = toks.slice(0, i).reverse().find((q) => q.code);
    const next = toks.slice(i + 1).find((q) => q.code);
    return prev?.code?.match(/^(h+|\[h+\])$/) || next?.code?.match(/^(s+|\[s+\])$/) ? (t.code === 'm' ? 'n' : 'nn') : t.code;
  });
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  const totalSec = Math.round(x * 86400);
  return toks.map((t, i) => {
    if (t.lit !== undefined) return t.lit;
    const c = codes[i]!;
    switch (c) {
      case 'y': case 'yy': return pad(p.y % 100, 2);
      case 'yyy': case 'yyyy': return pad(p.y, 4);
      case 'm': return String(p.m);
      case 'mm': return pad(p.m, 2);
      case 'mmm': return MONTH_NAMES[p.m - 1].slice(0, 3);
      case 'mmmmm': return MONTH_NAMES[p.m - 1][0];
      case 'mmmm': return MONTH_NAMES[p.m - 1];
      case 'd': return String(p.d);
      case 'dd': return pad(p.d, 2);
      case 'ddd': return DAY_NAMES[p.wd].slice(0, 3);
      case 'dddd': return DAY_NAMES[p.wd];
      case 'h': return String(has12 ? ((p.hh + 11) % 12) + 1 : p.hh);
      case 'hh': return pad(has12 ? ((p.hh + 11) % 12) + 1 : p.hh, 2);
      case 'n': return String(p.mm);
      case 'nn': return pad(p.mm, 2);
      case 's': return String(p.ss);
      case 'ss': return pad(p.ss, 2);
      case '[h]': case '[hh]': return pad(Math.floor(totalSec / 3600), c.length - 2);
      case '[m]': case '[mm]': return pad(Math.floor(totalSec / 60), c.length - 2);
      case '[s]': case '[ss]': return pad(totalSec, c.length - 2);
      case 'AM/PM': return p.hh < 12 ? 'AM' : 'PM';
      case 'A/P': return p.hh < 12 ? 'A' : 'P';
      case 'a/p': return p.hh < 12 ? 'a' : 'p';
      default:
        if (/^0+$/.test(c)) return pad(Math.round(p.ms / Math.pow(10, 3 - Math.min(3, c.length))), Math.min(3, c.length));
        return c;
    }
  }).join('');
}
