// Mathcad programming blocks: an indentation-structured mini language whose
// expressions are evaluated by mathjs.
//
//   fact(n) :=
//     r ← 1
//     for k ∈ 1 .. n
//       r ← r·k
//     return r
import { compileExpr } from './compile';
import { ChainScope, type ScopeLike } from './scope';
import { parseRange, isIdentifier, splitTop, findEvalEquals } from './syntax';
import { tick, toVector, assignIndex, normalize, engineCtx, int, matrix2D, elementsOf } from './library';
import { math, isUnit, isComplex, isMatrix, joinUnit, splitUnit } from './math';

export type ProgramStmt = Stmt;

/** A condition's lone = compares (if x = 0), as Mathcad's bold equals does; it never assigns. */
function condition(src: string): string {
  let s = src;
  for (let at = findEvalEquals(s); at >= 0; at = findEvalEquals(s)) s = `${s.slice(0, at)}==${s.slice(at + 1)}`;
  return s;
}

/**
 * A local definition's value is an expression, or a program of its own (r ← followed by an
 * indented block, as Mathcad nests a program as an operand): the value of its last line.
 */
type Value = { expr: string; block?: Stmt[] };

type Stmt =
  | ({ k: 'assign'; name: string; index: string[] | null; line: number; column?: boolean; row?: boolean } & Value)
  /** [a; b] ← v: several locals at once from the elements of v */
  | ({ k: 'destructure'; names: string[]; line: number } & Value)
  /** f(x) ← x² : a function local to the program */
  | ({ k: 'localfn'; name: string; params: string[]; line: number } & Value)
  | { k: 'if'; branches: { cond: string | null; body: Stmt[] }[]; line: number }
  | { k: 'for'; v: string; iter: string; body: Stmt[]; line: number }
  | { k: 'while'; cond: string; body: Stmt[]; line: number }
  | { k: 'try'; body: Stmt[]; onError: Stmt[]; line: number }
  | { k: 'return'; expr: string; line: number }
  | { k: 'break'; line: number }
  | { k: 'continue'; line: number }
  | { k: 'expr'; expr: string; line: number };

interface Line { indent: number; text: string; no: number }

export function parseProgram(src: string[]): Stmt[] {
  const lines: Line[] = src
    .map((l, i) => {
      const m = /^(\s*)(.*)$/.exec(l.replace(/\t/g, '    '))!;
      return { indent: m[1].length, text: m[2].trim(), no: i + 1 };
    })
    .filter((l) => l.text && !l.text.startsWith('//'));
  let pos = 0;

  function block(indent: number): Stmt[] {
    const out: Stmt[] = [];
    while (pos < lines.length && lines[pos].indent >= indent) {
      if (lines[pos].indent > indent) throw new Error(`Line ${lines[pos].no}: unexpected indentation`);
      out.push(statement(indent));
    }
    return out;
  }

  function body(parent: Line): Stmt[] {
    if (pos >= lines.length || lines[pos].indent <= parent.indent) throw new Error(`Line ${parent.no}: expected an indented block`);
    return block(lines[pos].indent);
  }

  function statement(indent: number): Stmt {
    const ln = lines[pos++];
    const t = ln.text.replace(/:$/, '').trim();
    let m: RegExpExecArray | null;
    if ((m = /^if\s+(.+)$/.exec(t))) {
      const branches: { cond: string | null; body: Stmt[] }[] = [{ cond: m[1], body: body(ln) }];
      while (pos < lines.length && lines[pos].indent === indent) {
        const nt = lines[pos].text.replace(/:$/, '').trim();
        const em = /^(?:else\s+if|elif)\s+(.+)$/.exec(nt);
        if (em) {
          const l2 = lines[pos++];
          branches.push({ cond: em[1], body: body(l2) });
        } else if (/^(else|otherwise)$/.test(nt)) {
          const l2 = lines[pos++];
          branches.push({ cond: null, body: body(l2) });
          break;
        } else break;
      }
      return { k: 'if', branches, line: ln.no };
    }
    if ((m = /^for\s+(\S+)\s+(?:in|∈)\s+(.+)$/.exec(t))) {
      if (!isIdentifier(m[1])) throw new Error(`Line ${ln.no}: invalid loop variable`);
      return { k: 'for', v: m[1], iter: m[2], body: body(ln), line: ln.no };
    }
    if ((m = /^while\s+(.+)$/.exec(t))) return { k: 'while', cond: m[1], body: body(ln), line: ln.no };
    if (/^try$/.test(t)) {
      const tb = body(ln);
      let onError: Stmt[] = [];
      if (pos < lines.length && lines[pos].indent === indent && /^on\s*error:?$/.test(lines[pos].text)) {
        const l2 = lines[pos++];
        onError = body(l2);
      }
      return { k: 'try', body: tb, onError, line: ln.no };
    }
    if ((m = /^return\s+(.+)$/.exec(t))) return { k: 'return', expr: m[1], line: ln.no };
    if (t === 'break') return { k: 'break', line: ln.no };
    if (t === 'continue') return { k: 'continue', line: ln.no };
    if (/^(else|otherwise|elif|else\s+if)\b/.test(t)) throw new Error(`Line ${ln.no}: "${t}" without matching if`);
    const arrow = /←|<-/.exec(ln.text);
    if (arrow) {
      const lhs = ln.text.slice(0, arrow.index).trim();
      const expr = ln.text.slice(arrow.index + arrow[0].length).trim();
      // nothing after the arrow: the value is the indented program below
      const value: Value = expr ? { expr } : { expr: '', block: body(ln) };
      const im = /^(\S+?)\s*\[(.*)\]$/.exec(lhs);
      if (im && isIdentifier(im[1])) return { k: 'assign', name: im[1], index: splitTop(im[2], ','), ...value, line: ln.no };
      // Mathcad's column and row assignments M<j> ← v, row(M, i) ← v
      const cm = /^(col|row)\s*\(\s*([^\s,()]+)\s*,(.*)\)$/.exec(lhs);
      if (cm && isIdentifier(cm[2])) return { k: 'assign', name: cm[2], index: [cm[3].trim()], ...value, line: ln.no, ...(cm[1] === 'col' ? { column: true } : { row: true }) };
      const dm = /^\[(.*)\]$/.exec(lhs);
      const names = dm ? dm[1].split(/[;,]/).map((x) => x.trim()) : [];
      if (dm && names.length && names.every(isIdentifier)) return { k: 'destructure', names, ...value, line: ln.no };
      const fm = /^([^\s(]+)\s*\((.*)\)$/.exec(lhs);
      const params = fm ? (fm[2].trim() ? splitTop(fm[2], ',').map((x) => x.trim()) : []) : [];
      if (fm && isIdentifier(fm[1]) && params.every(isIdentifier)) return { k: 'localfn', name: fm[1], params, ...value, line: ln.no };
      if (!isIdentifier(lhs)) throw new Error(`Line ${ln.no}: cannot assign to "${lhs}"`);
      return { k: 'assign', name: lhs, index: null, ...value, line: ln.no };
    }
    return { k: 'expr', expr: ln.text, line: ln.no };
  }

  const stmts = block(lines.length ? lines[0].indent : 0);
  if (pos < lines.length) throw new Error(`Line ${lines[pos].no}: inconsistent indentation`);
  return stmts;
}

class Signal {
  constructor(readonly kind: 'break' | 'continue' | 'return', readonly value?: unknown) {}
}

function truthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (isComplex(v)) return v.re !== 0 || v.im !== 0;
  if (isUnit(v)) return (v.value as number) !== 0;
  if (isMatrix(v)) return toVector(v).every(truthy);
  return !!v;
}

/** Evaluate an iteration source: a Mathcad range "a, b .. c" or any vector expression. */
export function rangeValues(src: string, scope: ScopeLike): unknown[] {
  const r = parseRange(src);
  if (!r) {
    const v = compileExpr(src).evaluate(scope);
    return isMatrix(v) || Array.isArray(v) ? toVector(v) : [v];
  }
  return expandRange(
    compileExpr(r.first).evaluate(scope),
    r.second === null ? null : compileExpr(r.second).evaluate(scope),
    compileExpr(r.last).evaluate(scope),
  );
}

export function expandRange(first: unknown, second: unknown | null, last: unknown): unknown[] {
  const a = splitUnit(first);
  const c = splitUnit(last);
  if (!!a.unit !== !!c.unit || (a.unit && c.unit && !a.unit.equalBase(c.unit))) throw new Error('Range limits must have the same units');
  // without an explicit second value Mathcad steps by 1 (in SI base units)
  const step = second !== null ? splitUnit(second).value - a.value : c.value >= a.value ? 1 : -1;
  if (step === 0) throw new Error('Range step cannot be zero');
  if ((c.value - a.value) / step < 0) throw new Error('Range step goes the wrong way');
  const n = Math.floor((c.value - a.value) / step + 1e-9) + 1;
  if (n > 1e6) throw new Error('Range has more than 1 000 000 values');
  const unit = a.unit ?? c.unit;
  const out: unknown[] = [];
  for (let k = 0; k < n; k++) {
    const v = a.value + k * step;
    out.push(joinUnit(Math.abs(v) < 1e-15 * Math.abs(step) ? 0 : roundish(v), unit));
  }
  return out;
}

function roundish(v: number): number {
  const r = Math.round(v);
  return Math.abs(v - r) < 1e-12 * Math.max(1, Math.abs(v)) ? r : v;
}

/** Set row i of a matrix to a vector (a row or a column of values), growing it as Mathcad does. */
function assignRow(cur: unknown, i: unknown, v: unknown): unknown {
  const k = int(i, 'row') - engineCtx.origin;
  if (k < 0) throw new Error(`Row below ORIGIN (${engineCtx.origin})`);
  const row = toVector(v);
  const rows: unknown[][] = isMatrix(cur) || Array.isArray(cur) ? matrix2D(cur).map((r) => r.slice()) : [];
  const height = Math.max(rows.length, k + 1), width = Math.max(rows[0]?.length ?? 0, row.length);
  const out = Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => (r === k ? (row[c] ?? 0) : rows[r]?.[c] ?? 0)));
  return math.matrix(out as never);
}

/** The value of a local definition: its expression, or its own program's value (a return in it ends that program). */
function valueOf(s: Value, scope: ChainScope): unknown {
  if (!s.block) return normalize(compileExpr(s.expr).evaluate(scope));
  try {
    const v = run(s.block, scope);
    if (v === undefined) throw new Error('Program produced no value');
    return normalize(v);
  } catch (e) {
    if (e instanceof Signal && e.kind === 'return') return normalize(e.value);
    throw e;
  }
}

/** Set column j of a matrix to a vector, growing it (zero-filled) as Mathcad does. */
function assignColumn(cur: unknown, j: unknown, v: unknown): unknown {
  const k = int(j, 'column') - engineCtx.origin;
  if (k < 0) throw new Error(`Column below ORIGIN (${engineCtx.origin})`);
  const col = toVector(v);
  const rows: unknown[][] = isMatrix(cur) || Array.isArray(cur) ? matrix2D(cur).map((r) => r.slice()) : [];
  const height = Math.max(rows.length, col.length), width = Math.max(rows[0]?.length ?? 0, k + 1);
  const out = Array.from({ length: height }, (_, i) => Array.from({ length: width }, (_, c) => (c === k ? (col[i] ?? 0) : rows[i]?.[c] ?? 0)));
  // a first column written into nothing is still a matrix (n×1), not a vector
  return math.matrix(out as never);
}

/** Run statements; the value is that of the last one that gave one (an if none of whose branches ran gives none). */
function run(stmts: Stmt[], scope: ChainScope): unknown {
  let last: unknown = undefined;
  for (const s of stmts) {
    try {
      const v = exec(s, scope);
      if (v !== undefined) last = v;
    } catch (e) {
      if (e instanceof Signal) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(/^Line \d+:/.test(msg) ? msg : `Line ${s.line}: ${msg}`);
    }
  }
  return last;
}

function exec(s: Stmt, scope: ChainScope): unknown {
  tick();
  switch (s.k) {
    case 'assign': {
      const v = valueOf(s, scope);
      if (s.index) {
        const idx = s.index.map((i) => compileExpr(i).evaluate(scope));
        const cur = scope.local.has(s.name) ? scope.local.get(s.name) : undefined;
        scope.set(s.name, s.column ? assignColumn(cur, idx[0], v) : s.row ? assignRow(cur, idx[0], v) : assignIndex(cur, idx, v));
      } else scope.set(s.name, v);
      return v;
    }
    case 'destructure': {
      const v = valueOf(s, scope);
      const items = elementsOf(v);
      if (items.length !== s.names.length) throw new Error(`Expected ${s.names.length} values, got ${items.length}`);
      s.names.forEach((n, i) => scope.set(n, normalize(items[i])));
      return v;
    }
    case 'localfn': {
      const { name, params } = s;
      const fn = (...args: unknown[]) => {
        if (args.length !== params.length) throw new Error(`${name} expects ${params.length} argument${params.length === 1 ? '' : 's'}`);
        const local = new ChainScope(scope);
        params.forEach((p, i) => local.set(p, normalize(args[i])));
        return valueOf(s, local);
      };
      scope.set(name, fn);
      return fn;
    }
    case 'expr':
      return compileExpr(s.expr).evaluate(scope);
    case 'return':
      throw new Signal('return', compileExpr(s.expr).evaluate(scope));
    case 'break':
      throw new Signal('break');
    case 'continue':
      throw new Signal('continue');
    case 'if':
      for (const b of s.branches) {
        if (b.cond === null || truthy(compileExpr(condition(b.cond)).evaluate(scope))) return run(b.body, scope);
      }
      return undefined;
    case 'for': {
      let last: unknown;
      for (const v of rangeValues(s.iter, scope)) {
        scope.set(s.v, v);
        try {
          last = run(s.body, scope);
        } catch (e) {
          if (e instanceof Signal && e.kind === 'break') break;
          if (e instanceof Signal && e.kind === 'continue') continue;
          throw e;
        }
      }
      return last;
    }
    case 'while': {
      let last: unknown;
      while (truthy(compileExpr(condition(s.cond)).evaluate(scope))) {
        try {
          last = run(s.body, scope);
        } catch (e) {
          if (e instanceof Signal && e.kind === 'break') break;
          if (e instanceof Signal && e.kind === 'continue') continue;
          throw e;
        }
      }
      return last;
    }
    case 'try':
      try {
        return run(s.body, scope);
      } catch (e) {
        if (e instanceof Signal) throw e;
        scope.set('error', e instanceof Error ? e.message : String(e));
        return run(s.onError, scope);
      }
  }
}

/** Run a program body with the given local variables; returns the program's value. */
export function runProgram(stmts: Stmt[], parent: ScopeLike, locals: Record<string, unknown>): unknown {
  const scope = new ChainScope(parent, locals);
  try {
    const v = run(stmts, scope);
    if (v === undefined) throw new Error('Program produced no value');
    return normalize(v);
  } catch (e) {
    if (e instanceof Signal) {
      if (e.kind === 'return') return normalize(e.value);
      throw new Error(`"${e.kind}" outside of a loop`);
    }
    throw e;
  }
}

export type { Stmt };
