// Mathcad-style statement syntax on top of the mathjs expression language.
//
//   x := 3 m              definition
//   f(x, y) := x^2 + y    function definition
//   v[i] := i^2           indexed (element) definition, i may be a range
//   g ≡ 9.81 m/s^2        global definition (evaluated before everything else)
//   i := 0 .. 10          range variable;  t := 0, 0.1 .. 2  (first, second .. last)
//   F =                   numeric evaluation
//   F = kN                evaluation converted to a unit
//   x := 3 m =            define and show the value
//   x^2 - 1 → factor      symbolic evaluation (also "->")
//   f(n) :=               multi-line program (indented body below)

export type Lhs =
  | { kind: 'var'; name: string }
  | { kind: 'func'; name: string; params: string[] }
  | { kind: 'index'; name: string; indices: string[] }
  | { kind: 'destructure'; names: string[] };

export type Statement =
  | { type: 'empty' }
  | { type: 'define'; global: boolean; lhs: Lhs; rhs: string; show: boolean; unit: string }
  | { type: 'program'; global: boolean; lhs: Lhs; body: string[]; show: boolean }
  | { type: 'eval'; expr: string; unit: string }
  | { type: 'symbolic'; expr: string; keywords: string }
  | { type: 'expr'; expr: string };

const OPEN = '([{';
const CLOSE = ')]}';

/** Calls cb(index, depth) for every character outside string literals. */
function scan(src: string, cb: (i: number, depth: number) => boolean | void): void {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch)) depth = Math.max(0, depth - 1);
    else if (cb(i, depth) === true) return;
  }
}

/** Index of the first top-level occurrence of token, or -1. */
export function findTop(src: string, token: string, from = 0): number {
  let found = -1;
  scan(src, (i, depth) => {
    if (i >= from && depth === 0 && src.startsWith(token, i)) {
      found = i;
      return true;
    }
  });
  return found;
}

/** Split on a top-level separator. */
export function splitTop(src: string, sep: string): string[] {
  const parts: string[] = [];
  let last = 0;
  scan(src, (i, depth) => {
    if (depth === 0 && src.startsWith(sep, i)) {
      parts.push(src.slice(last, i));
      last = i + sep.length;
    }
  });
  parts.push(src.slice(last));
  return parts;
}

/** Index of the last top-level single "=" (not part of :=, ==, <=, >=, !=), or -1. */
export function findEvalEquals(src: string): number {
  let found = -1;
  scan(src, (i, depth) => {
    if (depth !== 0 || src[i] !== '=') return;
    const prev = src[i - 1];
    const next = src[i + 1];
    if (prev && ':<>!='.includes(prev)) return;
    if (next === '=') return;
    found = i;
  });
  return found;
}

/** Top-level comparison operator for constraints: returns [lhs, op, rhs] or null. */
export function splitComparison(src: string): [string, string, string] | null {
  const ops = ['<=', '>=', '==', '!=', '≤', '≥', '≠', '<', '>', '='];
  let res: [string, string, string] | null = null;
  scan(src, (i, depth) => {
    if (depth !== 0) return;
    for (const op of ops) {
      if (src.startsWith(op, i)) {
        if (op === '=' && (src[i - 1] === ':' || src[i + 1] === '=')) continue;
        if ((op === '<' || op === '>') && src[i + 1] === '=') continue;
        res = [src.slice(0, i), op, src.slice(i + op.length)];
        return true;
      }
    }
  });
  return res;
}

/**
 * A comparison chain for checks (a ≤ b, 0 < x ≤ 10): terms and the operators between
 * them, or null when the expression is not a comparison. "=" is not a comparison here.
 */
export function splitChain(src: string): { terms: string[]; ops: string[] } | null {
  const ops = ['<=', '>=', '==', '!=', '≤', '≥', '≠', '<', '>'];
  const terms: string[] = [];
  const found: string[] = [];
  let last = 0;
  scan(src, (i, depth) => {
    if (depth !== 0) return;
    for (const op of ops) {
      if (!src.startsWith(op, i)) continue;
      if ((op === '<' || op === '>') && src[i + 1] === '=') continue;
      // a ≤ that is really the second character of "<=" / ">=" / "==" / "!="
      if (i > last && found.length && src.slice(i - 1, i + 1) !== op && '<>=!'.includes(src[i - 1])) continue;
      terms.push(src.slice(last, i));
      found.push(op);
      last = i + op.length;
      return;
    }
  });
  if (!found.length) return null;
  terms.push(src.slice(last));
  if (terms.some((t) => !t.trim())) return null;
  return { terms: terms.map((t) => t.trim()), ops: found };
}

// names in any alphabet (Cyrillic, Latin with accents, Greek …), as Mathcad and SMath allow
const IDENT = /^[\p{L}_Ͱ-Ͽ][\p{L}0-9_Ͱ-Ͽ']*$/u;

export function isIdentifier(s: string): boolean {
  return IDENT.test(s.trim());
}

export function parseLhs(text: string): Lhs {
  const s = text.trim();
  if (isIdentifier(s)) return { kind: 'var', name: s };
  let m = /^([^\s([]+)\s*\((.*)\)$/s.exec(s);
  if (m && isIdentifier(m[1])) {
    const params = m[2].trim() === '' ? [] : splitTop(m[2], ',').map((p) => p.trim());
    if (params.every(isIdentifier)) return { kind: 'func', name: m[1], params };
    throw new Error(`Invalid function parameters in "${s}"`);
  }
  m = /^([^\s([]+)\s*\[(.*)\]$/s.exec(s);
  if (m && isIdentifier(m[1])) {
    return { kind: 'index', name: m[1], indices: splitTop(m[2], ',').map((p) => p.trim()) };
  }
  m = /^\[(.*)\]$/s.exec(s);
  if (m) {
    const names = m[1].split(/[;,]/).map((p) => p.trim());
    if (names.length > 0 && names.every(isIdentifier)) return { kind: 'destructure', names };
  }
  throw new Error(`Cannot define "${s}"`);
}

export function parseStatement(source: string): Statement {
  const text = source.replace(/\r/g, '');
  if (!text.trim()) return { type: 'empty' };
  const lines = text.split('\n');
  const first = lines[0].trimEnd();
  // program: first line ends with := or ≡ and the body follows on further lines
  if (lines.length > 1 && /(:=|≡)\s*(=)?\s*$/.test(first)) {
    const global = /≡\s*(=)?\s*$/.test(first);
    const show = /=\s*$/.test(first.replace(/(:=|≡)\s*$/, ''));
    const lhsText = first.replace(/(:=|≡)\s*=?\s*$/, '');
    const body = lines.slice(1).filter((l) => l.trim() !== '');
    return { type: 'program', global, lhs: parseLhs(lhsText), body, show };
  }
  const flat = lines.map((l) => l.trim()).join(' ');
  let p = findTop(flat, ':=');
  let global = false;
  if (p < 0) {
    p = findTop(flat, '≡');
    global = p >= 0;
  }
  if (p >= 0) {
    const lhs = parseLhs(flat.slice(0, p));
    let rhs = flat.slice(p + (global ? 1 : 2));
    let show = false;
    let unit = '';
    const e = findEvalEquals(rhs);
    if (e >= 0) {
      show = true;
      unit = rhs.slice(e + 1).trim();
      rhs = rhs.slice(0, e);
    }
    if (!rhs.trim()) throw new Error('Missing expression after :=');
    return { type: 'define', global, lhs, rhs: rhs.trim(), show, unit };
  }
  for (const arrow of ['→', '->']) {
    const a = findTop(flat, arrow);
    if (a >= 0) {
      return { type: 'symbolic', expr: flat.slice(0, a).trim(), keywords: flat.slice(a + arrow.length).trim() };
    }
  }
  const e = findEvalEquals(flat);
  if (e >= 0) {
    const expr = flat.slice(0, e).trim();
    if (!expr) throw new Error('Missing expression before =');
    return { type: 'eval', expr, unit: flat.slice(e + 1).trim() };
  }
  return { type: 'expr', expr: flat.trim() };
}

/** Is this a Mathcad range "a .. b" or "a, b .. c"? Returns its parts. */
export function parseRange(src: string): { first: string; second: string | null; last: string } | null {
  const p = findTop(src, '..');
  if (p < 0) return null;
  const head = src.slice(0, p);
  const last = src.slice(p + 2).trim();
  const parts = splitTop(head, ',');
  if (parts.length > 2 || !last) throw new Error('Range must be "first .. last" or "first, second .. last"');
  return { first: parts[0].trim(), second: parts.length === 2 ? parts[1].trim() : null, last };
}

const UNICODE: [RegExp, string][] = [
  [/[·⋅]/g, '*'],
  [/×/g, '*'],
  [/÷/g, '/'],
  [/−/g, '-'],
  [/≤/g, '<='],
  [/≥/g, '>='],
  [/≠/g, '!='],
  [/∧/g, ' and '],
  [/∨/g, ' or '],
  [/¬/g, ' not '],
  [/⊕/g, ' xor '],
  // π, Γ(, Σ( and Π( standing alone; inside a name (γ_Σ, x_π) they are letters of it
  [/(?<![\p{L}_])π(?![\p{L}\p{N}_])/gu, 'pi'],
  [/∞/g, 'Infinity'],
  [/√/g, 'sqrt'],
  [/∛/g, 'cbrt'],
  [/²/g, '^2'],
  [/³/g, '^3'],
  [/°/g, ' deg'],
  [/(?<![\p{L}\p{N}_])Γ\s*\(/gu, 'gamma('],
  [/∫/g, 'integral'],
  [/(?<![\p{L}\p{N}_])Σ(?=\s*\()|∑/gu, 'sum'],
  [/(?<![\p{L}\p{N}_])Π\s*\(|∏/gu, 'prod('],
  [/′/g, "'"],
  [/″/g, "''"],
  [/‴/g, "'''"],
];

// y''(t) is the second derivative of y at t (Mathcad prime notation), not a transpose
const PRIME_CALL = /(?<![\p{L}0-9_Ͱ-Ͽ.])([\p{L}_Ͱ-Ͽ][\p{L}0-9_Ͱ-Ͽ]*(?:\.[\p{L}_Ͱ-Ͽ][\p{L}0-9_Ͱ-Ͽ]*)*)('+)\s*\(/gu;

const IMAG = /(?<![\p{L}_\d.])(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)[ij](?![\p{L}0-9_Ͱ-Ͽ])/gu;

/** Translate Mathcad-flavoured input into mathjs syntax (outside string literals). */
export function preprocess(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const q = src.indexOf('"', i);
    const end = q < 0 ? src.length : q;
    out += translate(src.slice(i, end));
    if (q < 0) break;
    let j = q + 1;
    while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
    out += src.slice(q, j + 1);
    i = j + 1;
  }
  return out;
}

function translate(s: string): string {
  for (const [re, rep] of UNICODE) s = s.replace(re, rep);
  s = s.replace(PRIME_CALL, (_, name: string, primes: string) => `__d(${name}, ${primes.length}, `);
  return s.replace(IMAG, '($1 * __I)');
}
