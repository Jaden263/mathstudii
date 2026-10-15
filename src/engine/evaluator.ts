// Worksheet evaluation in Mathcad reading order (top→bottom, left→right),
// with global definitions (≡) evaluated first.
import type { Unit } from 'mathjs';
import type { MathRegion, PlotRegion, SketchRegion, CadRegion, BeamRegion, SolveRegion, TableRegion, TextRegion, Worksheet } from '../model/types';
import { readingOrder } from '../model/types';
import { math, isMatrix, isUnit, isComplex, splitUnit, joinUnit } from './math';
import { ChainScope, snapshot, type ScopeLike } from './scope';
import { compileExpr, parseExpr, freeSymbols } from './compile';
import { parseStatement, parseRange, splitComparison, findTop, findEvalEquals, parseLhs, isIdentifier, splitTop, type Statement, type Lhs } from './syntax';
import { engineCtx, toVector, vec, assignIndex, normalize } from './library';
import { parseProgram, runProgram, expandRange } from './program';
import { valueTex, unitParts, type FormatOptions } from './format';
import { exprTex, lhsTex, programTex, texCtx, keywordsTex } from './tex';
import { symbolicEval, casReady, type SymFunction } from './symbolic';
import * as N from './numeric';
import { evaluateSketch, type SketchResult } from './sketchEval';
import { solveCad, cadValue, type CadResult } from '../cad/evaluate';
import { solveBeam, beamValue, type BeamResult } from '../beam/evaluate';

export type { SketchResult, CadResult, BeamResult };

export interface MathResult {
  kind: 'math';
  tex: string;
  error?: string;
  /** True while waiting for the symbolic engine to load. */
  pending?: boolean;
}

export interface PlotSeries {
  xs: number[];
  ys: number[];
  label: string;
  style: string;
  color?: string;
}

export interface PlotResult {
  kind: 'plot';
  series: PlotSeries[];
  surface?: { xs: number[]; ys: number[]; z: number[][] };
  xLabel: string;
  yLabel: string;
  /** Axis limits evaluated by the engine (in axis units); null = automatic. */
  limits?: { xmin: number | null; xmax: number | null; ymin: number | null; ymax: number | null };
  error?: string;
}

export interface SolveResult {
  kind: 'solve';
  guesses: { tex: string; error?: string }[];
  constraints: { tex: string; error?: string }[];
  solver: { tex: string; error?: string };
  error?: string;
}

export interface TableResult {
  kind: 'table';
  error?: string;
}

export interface TextResult {
  kind: 'text';
  values: Record<string, { tex?: string; error?: string }>;
}

export type RegionResult = MathResult | PlotResult | SolveResult | TableResult | TextResult | SketchResult | CadResult | BeamResult;

export interface EvaluationOutput {
  results: Map<string, RegionResult>;
  needsCas: boolean;
  errorCount: number;
  millis: number;
}

const BUILTIN_SCOPE: [string, string][] = [['g', '9.80665 m/s^2']];

export function friendlyError(e: unknown): string {
  let msg = e instanceof Error ? e.message : String(e);
  let m: RegExpExecArray | null;
  if ((m = /^Undefined symbol (\S+)/.exec(msg))) return `"${m[1]}" is not defined`;
  if ((m = /^Undefined function (\S+)/.exec(msg))) return `Function "${m[1]}" is not defined`;
  if (/Units do not match/.test(msg)) return 'Units do not match';
  if ((m = /Unexpected type of argument in function (\w+) \(expected: (\w+), actual: (\w+)/.exec(msg))) {
    const [, fn, exp, act] = m;
    if ((exp === 'Unit' && act === 'number') || (exp === 'number' && act === 'Unit')) return `Units do not match (in ${fn.replace(/Scalar$/, '')})`;
    return `Wrong argument type in ${fn}: expected ${exp}, got ${act}`;
  }
  msg = msg.replace(/^Error: /, '');
  return msg;
}

class Evaluator {
  readonly results = new Map<string, RegionResult>();
  readonly global: ChainScope;
  /** Range variables: name → the vector object currently bound in scope. */
  readonly ranges = new Map<string, unknown>();
  readonly symFunctions = new Map<string, SymFunction>();
  needsCas = false;
  readonly fmt: FormatOptions;
  /** SMath semantics: function bodies read variables when called, not when defined. */
  readonly bindAtCall: boolean;

  /**
   * @param overrides variable → expression that replaces its top-level definition
   *        (used to animate sketches by sweeping a variable)
   */
  constructor(readonly ws: Worksheet, readonly overrides: Record<string, string> = {}) {
    this.fmt = { precision: ws.settings.precision, expThreshold: ws.settings.expThreshold };
    this.bindAtCall = ws.settings.lateBinding === true;
    const base = new Map<string, unknown>();
    for (const [k, v] of BUILTIN_SCOPE) base.set(k, math.evaluate(v));
    this.global = new ChainScope(base);
  }

  run(): void {
    engineCtx.origin = this.ws.settings.origin;
    engineCtx.tol = this.ws.settings.tol;
    engineCtx.iterationBudget = 1e8;
    engineCtx.deadline = performance.now() + 20000;
    math.Unit.setUnitSystem(this.ws.settings.unitSystem ?? 'si');
    texCtx.defined = new Set(this.global.keys());
    const ordered = readingOrder(this.ws.regions).filter((r) => !r.disabled);
    // pass 1: global definitions
    for (const r of ordered) {
      if (r.kind !== 'math') continue;
      let st: Statement;
      try {
        st = parseStatement(r.source);
      } catch {
        continue;
      }
      if ((st.type === 'define' || st.type === 'program') && st.global) this.evaluateMath(r, st);
    }
    // pass 2: everything else in reading order
    for (const r of ordered) {
      if (this.results.has(r.id)) continue;
      switch (r.kind) {
        case 'math': this.evaluateMath(r); break;
        case 'plot': this.results.set(r.id, this.evaluatePlot(r)); break;
        case 'solve': this.results.set(r.id, this.evaluateSolve(r)); break;
        case 'table': this.results.set(r.id, this.evaluateTable(r)); break;
        case 'sketch': this.results.set(r.id, this.evaluateSketchRegion(r)); break;
        case 'cad': this.results.set(r.id, this.evaluateCadRegion(r)); break;
        case 'beam': this.results.set(r.id, this.evaluateBeamRegion(r)); break;
        case 'text': this.results.set(r.id, this.evaluateText(r)); break;
        default: break;
      }
    }
    for (const r of this.ws.regions) {
      if (r.disabled && r.kind === 'math') this.results.set(r.id, { kind: 'math', tex: this.inputTex(r.source) });
    }
  }

  private inputTex(source: string): string {
    try {
      const st = parseStatement(source);
      return this.statementTex(st, null);
    } catch {
      return `\\texttt{${source.replace(/[\\{}$&#^_%~]/g, (c) => '\\' + c)}}`;
    }
  }

  // ------------------------------------------------------------ expressions

  private isRange(name: string, scope: ScopeLike): boolean {
    return this.ranges.has(name) && scope.get(name) === this.ranges.get(name);
  }

  /** Evaluate with implicit iteration over range variables (Mathcad semantics). */
  evalWithRanges(src: string, scope: ScopeLike): unknown {
    const node = parseExpr(src);
    const rv = [...freeSymbols(node)].filter((n) => this.isRange(n, scope));
    const compiled = compileExpr(src);
    if (rv.length === 0) return normalize(compiled.evaluate(scope));
    if (rv.length > 2) throw new Error('Expressions can iterate over at most two range variables');
    const local = new ChainScope(scope);
    const a = toVector(scope.get(rv[0]));
    if (rv.length === 1) {
      return vec(a.map((x) => {
        local.set(rv[0], x);
        return normalize(compiled.evaluate(local));
      }));
    }
    const b = toVector(scope.get(rv[1]));
    return math.matrix(a.map((x) => b.map((y) => {
      local.set(rv[0], x);
      local.set(rv[1], y);
      return normalize(compiled.evaluate(local));
    })) as never);
  }

  // ------------------------------------------------------------ math regions

  private statementTex(st: Statement, value: unknown, unitTarget?: string): string {
    const res = (v: unknown, unit: string) => valueTex(v, this.fmt, unit || unitTarget || undefined);
    switch (st.type) {
      case 'empty':
        return '';
      case 'define': {
        const op = st.global ? '\\equiv' : '\\coloneqq';
        const params = st.lhs.kind === 'func' ? st.lhs.params : [];
        const added = params.filter((p) => !texCtx.defined.has(p));
        added.forEach((p) => texCtx.defined.add(p));
        const rhs = exprTex(st.rhs);
        added.forEach((p) => texCtx.defined.delete(p));
        const shown = st.show && value !== null && value !== undefined && typeof value !== 'function' ? ` = ${res(value, st.unit)}` : '';
        return `${lhsTex(st.lhs)} ${op} ${rhs}${shown}`;
      }
      case 'program': {
        const op = st.global ? '\\equiv' : '\\coloneqq';
        const params = st.lhs.kind === 'func' ? st.lhs.params : [];
        const added = params.filter((p) => !texCtx.defined.has(p));
        added.forEach((p) => texCtx.defined.add(p));
        const body = programTex(st.body);
        added.forEach((p) => texCtx.defined.delete(p));
        const shown = st.show && value !== null && value !== undefined && typeof value !== 'function' ? ` = ${res(value, '')}` : '';
        return `${lhsTex(st.lhs)} ${op} ${body}${shown}`;
      }
      case 'eval': {
        const left = exprTex(st.expr);
        if (value === null || value === undefined) return `${left} = {\\color{#d33}\\blacksquare}`;
        if (typeof value === 'function') return `${left} = \\mathrm{function}`;
        return `${left} = ${res(value, st.unit)}`;
      }
      case 'symbolic': {
        const eq = findEvalEquals(st.expr);
        // in symbolic math every letter is a variable, never a unit
        texCtx.symbolic = true;
        let left: string;
        try {
          left = eq >= 0 ? `${exprTex(st.expr.slice(0, eq))} = ${exprTex(st.expr.slice(eq + 1))}` : exprTex(st.expr);
        } finally {
          texCtx.symbolic = false;
        }
        const kw = keywordsTex(st.keywords);
        const arrow = kw ? `\\xrightarrow{${kw}}` : '\\rightarrow';
        return `${left} ${arrow} ${value === null || value === undefined ? '{\\color{#d33}\\blacksquare}' : String(value)}`;
      }
      case 'expr':
        return exprTex(st.expr);
    }
  }

  evaluateMath(r: MathRegion, pre?: Statement): void {
    let st: Statement;
    try {
      st = pre ?? parseStatement(r.source);
    } catch (e) {
      this.results.set(r.id, { kind: 'math', tex: '', error: friendlyError(e) });
      return;
    }
    const scope = this.global;
    let value: unknown = null;
    try {
      switch (st.type) {
        case 'empty':
          break;
        case 'define':
          value = this.define(st.lhs, st.rhs, scope);
          break;
        case 'program':
          value = this.defineProgram(st.lhs, st.body, scope);
          break;
        case 'eval':
          value = this.evalWithRanges(st.expr, scope);
          // validate requested unit
          if (st.unit) valueTex(value, this.fmt, st.unit);
          break;
        case 'symbolic':
          if (!casReady()) {
            this.needsCas = true;
            this.results.set(r.id, { kind: 'math', tex: this.statementTex(st, null), pending: true });
            return;
          }
          value = symbolicEval(st.expr, st.keywords, { scope, functions: this.symFunctions });
          break;
        case 'expr':
          // validate syntax only
          parseExpr(st.expr);
          break;
      }
      this.results.set(r.id, { kind: 'math', tex: this.statementTex(st, value) });
    } catch (e) {
      let tex: string;
      try {
        tex = this.statementTex(st, null);
      } catch {
        tex = '';
      }
      this.results.set(r.id, { kind: 'math', tex, error: friendlyError(e) });
    } finally {
      this.updateDefined();
    }
  }

  private updateDefined() {
    texCtx.defined = new Set(this.global.keys());
  }

  /** Perform a definition; returns the value for optional display. */
  define(lhs: Lhs, rhs: string, scope: ChainScope): unknown {
    switch (lhs.kind) {
      case 'var': {
        const range = parseRange(rhs);
        if (range) {
          const values = expandRange(
            this.evalWithRanges(range.first, scope),
            range.second === null ? null : this.evalWithRanges(range.second, scope),
            this.evalWithRanges(range.last, scope),
          );
          const v = vec(values);
          scope.set(lhs.name, v);
          this.ranges.set(lhs.name, v);
          return v;
        }
        const override = scope === this.global ? this.overrides[lhs.name] : undefined;
        const v = this.evalWithRanges(override ?? rhs, scope);
        scope.set(lhs.name, v);
        this.ranges.delete(lhs.name);
        return v;
      }
      case 'func': {
        const { name, params } = lhs;
        this.symFunctions.set(name, { params, body: rhs });
        const compiled = compileExpr(rhs);
        const snap = this.bindAtCall ? scope : snapshot(scope);
        const fn = (...args: unknown[]) => {
          if (args.length !== params.length) throw new Error(`${name} expects ${params.length} argument${params.length === 1 ? '' : 's'}`);
          const local = new ChainScope(snap);
          params.forEach((p, i) => local.set(p, args[i]));
          return normalize(compiled.evaluate(local));
        };
        snap.set(name, fn);
        scope.set(name, fn);
        this.ranges.delete(name);
        return fn;
      }
      case 'index': {
        const { name, indices } = lhs;
        const nodes = [...indices, rhs].map((s) => parseExpr(s));
        const syms = new Set<string>();
        nodes.forEach((n) => freeSymbols(n, syms));
        const rv = [...syms].filter((n) => this.isRange(n, scope));
        if (rv.length > 2) throw new Error('At most two range variables are allowed in an element definition');
        const cIdx = indices.map((s) => compileExpr(s));
        const cRhs = compileExpr(rhs);
        let cur: unknown = scope.local.has(name) || scope.has(name) ? scope.get(name) : undefined;
        if (typeof cur === 'function' || (!isMatrix(cur) && !Array.isArray(cur))) cur = undefined;
        const local = new ChainScope(scope);
        const assignOnce = () => {
          const idx = cIdx.map((c) => c.evaluate(local));
          cur = assignIndex(cur, idx, normalize(cRhs.evaluate(local)));
        };
        if (rv.length === 0) assignOnce();
        else if (rv.length === 1) {
          for (const x of toVector(scope.get(rv[0]))) {
            local.set(rv[0], x);
            assignOnce();
          }
        } else {
          for (const x of toVector(scope.get(rv[0]))) {
            for (const y of toVector(scope.get(rv[1]))) {
              local.set(rv[0], x);
              local.set(rv[1], y);
              assignOnce();
            }
          }
        }
        const v = normalize(cur);
        scope.set(name, v);
        this.ranges.delete(name);
        return v;
      }
      case 'destructure': {
        const v = this.evalWithRanges(rhs, scope);
        const items = toVector(v);
        if (items.length !== lhs.names.length) throw new Error(`Expected ${lhs.names.length} values, got ${items.length}`);
        lhs.names.forEach((n, i) => {
          scope.set(n, items[i]);
          this.ranges.delete(n);
        });
        return v;
      }
    }
  }

  defineProgram(lhs: Lhs, body: string[], scope: ChainScope): unknown {
    const stmts = parseProgram(body);
    if (lhs.kind === 'var') {
      const v = runProgram(stmts, scope, {});
      scope.set(lhs.name, v);
      this.ranges.delete(lhs.name);
      return v;
    }
    if (lhs.kind === 'func') {
      const { name, params } = lhs;
      const snap = this.bindAtCall ? scope : snapshot(scope);
      const fn = (...args: unknown[]) => {
        if (args.length !== params.length) throw new Error(`${name} expects ${params.length} argument${params.length === 1 ? '' : 's'}`);
        const locals: Record<string, unknown> = {};
        params.forEach((p, i) => (locals[p] = args[i]));
        return runProgram(stmts, snap, locals);
      };
      snap.set(name, fn);
      scope.set(name, fn);
      this.symFunctions.delete(name);
      return fn;
    }
    if (lhs.kind === 'destructure') {
      const v = runProgram(stmts, scope, {});
      const items = toVector(v);
      if (items.length !== lhs.names.length) throw new Error(`Expected ${lhs.names.length} values, got ${items.length}`);
      lhs.names.forEach((n, i) => scope.set(n, items[i]));
      return v;
    }
    throw new Error('A program can define a variable or a function');
  }

  // ------------------------------------------------------------ solve blocks

  evaluateSolve(r: SolveRegion): SolveResult {
    const out: SolveResult = { kind: 'solve', guesses: [], constraints: [], solver: { tex: '' } };
    const local = new ChainScope(this.global);
    const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const g of lines(r.guesses)) {
      try {
        const st = parseStatement(g);
        if (st.type !== 'define' || st.lhs.kind !== 'var') throw new Error('Guess values must be definitions like x := 1 m');
        const v = this.define(st.lhs, st.rhs, local);
        texCtx.defined.add(st.lhs.name);
        out.guesses.push({ tex: this.statementTex(st, v) });
      } catch (e) {
        out.guesses.push({ tex: exprTex(g), error: friendlyError(e) });
      }
    }
    type Constraint = { lhs: ReturnType<typeof compileExpr>; rhs: ReturnType<typeof compileExpr>; op: string };
    const cons: Constraint[] = [];
    for (const c of lines(r.constraints)) {
      const parts = splitComparison(c);
      if (!parts) {
        out.constraints.push({ tex: exprTex(c), error: 'A constraint needs =, <, >, ≤ or ≥' });
        continue;
      }
      const [l, op, rr] = parts;
      const opTex: Record<string, string> = { '=': '\\boldsymbol{=}', '==': '\\boldsymbol{=}', '<': '<', '>': '>', '<=': '\\le', '>=': '\\ge', '≤': '\\le', '≥': '\\ge', '!=': '\\ne', '≠': '\\ne' };
      try {
        cons.push({ lhs: compileExpr(l), rhs: compileExpr(rr), op });
        out.constraints.push({ tex: `${exprTex(l)} ${opTex[op] ?? op} ${exprTex(rr)}` });
      } catch (e) {
        out.constraints.push({ tex: exprTex(c), error: friendlyError(e) });
      }
    }
    const solverSrc = r.solver.trim();
    try {
      const { tex, value } = this.runSolver(solverSrc, local, cons);
      out.solver = { tex: tex(value) };
    } catch (e) {
      out.solver = { tex: this.solverTexFallback(solverSrc), error: friendlyError(e) };
    }
    this.updateDefined();
    return out;
  }

  private solverTexFallback(src: string): string {
    try {
      return this.inputTex(src);
    } catch {
      return exprTex(src);
    }
  }

  private runSolver(src: string, local: ChainScope, cons: { lhs: ReturnType<typeof compileExpr>; rhs: ReturnType<typeof compileExpr>; op: string }[]) {
    if (!src) throw new Error('Add a solver call, e.g. x := find(x)');
    let lhs: Lhs | null = null;
    let rest = src;
    const p = findTop(src, ':=');
    if (p >= 0) {
      lhs = parseLhs(src.slice(0, p));
      rest = src.slice(p + 2);
    }
    let unit = '';
    let show = false;
    const e = findEvalEquals(rest);
    if (e >= 0) {
      show = true;
      unit = rest.slice(e + 1).trim();
      rest = rest.slice(0, e);
    }
    if (!lhs) show = true;
    const m = /^\s*(find|minerr|minimize|maximize)\s*\((.*)\)\s*$/s.exec(rest);
    if (!m) throw new Error('Solver must be find(…), minerr(…), minimize(f, …) or maximize(f, …)');
    const fn = m[1];
    const args = splitTop(m[2], ',').map((a) => a.trim()).filter(Boolean);
    let objective: ((...a: unknown[]) => unknown) | null = null;
    if (fn === 'minimize' || fn === 'maximize') {
      const fname = args.shift();
      const f = fname ? local.get(fname) : undefined;
      if (typeof f !== 'function') throw new Error(`${fn}: first argument must be a function defined above`);
      objective = f as (...a: unknown[]) => unknown;
    }
    if (args.length === 0 || !args.every(isIdentifier)) throw new Error(`${fn}: list the unknowns, e.g. ${fn}(x, y)`);
    const units: (Unit | null)[] = [];
    const x0 = args.map((name) => {
      if (!local.has(name)) throw new Error(`No guess value for "${name}"`);
      const s = splitUnit(local.get(name));
      units.push(s.unit);
      return s.value;
    });
    const setUnknowns = (xs: number[]) => args.forEach((n, i) => local.set(n, joinUnit(xs[i], units[i])));
    // residual scales from the initial guess keep mixed-unit systems well conditioned
    setUnknowns(x0);
    const scales = cons.map((c) => {
      try {
        const a = Math.abs(splitUnit(c.lhs.evaluate(local)).value);
        const b = Math.abs(splitUnit(c.rhs.evaluate(local)).value);
        return Math.max(a, b) || 1;
      } catch {
        return 1;
      }
    });
    const residuals = (xs: number[]): number[] => {
      setUnknowns(xs);
      return cons.map((c, i) => {
        const l = c.lhs.evaluate(local);
        const rr = c.rhs.evaluate(local);
        const d = splitUnit(math.subtract(l as never, rr as never)).value / scales[i];
        switch (c.op) {
          case '<': case '<=': case '≤': return Math.max(0, d);
          case '>': case '>=': case '≥': return Math.max(0, -d);
          default: return d;
        }
      });
    };
    let xs: number[];
    if (objective) {
      const sign = fn === 'maximize' ? -1 : 1;
      const obj = objective;
      const f0 = Math.abs(splitUnit(obj(...args.map((n) => local.get(n)))).value) || 1;
      let penalty = 1e2;
      xs = x0;
      for (let round = 0; round < 6; round++) {
        const mu = penalty;
        xs = N.nelderMead((v) => {
          const res = cons.length ? residuals(v) : [];
          setUnknowns(v);
          const val = splitUnit(obj(...args.map((n) => local.get(n)))).value;
          return (sign * val) / f0 + mu * res.reduce((s, x) => s + x * x, 0);
        }, xs, 4000);
        penalty *= 100;
        if (!cons.length) break;
      }
      if (cons.length) {
        const bad = residuals(xs).some((x) => Math.abs(x) > 1e-5);
        if (bad) throw new Error('Could not satisfy all constraints');
      }
    } else {
      if (cons.length === 0) throw new Error('Add at least one constraint');
      const res = N.levenbergMarquardt(residuals, x0, { maxIter: 1000 });
      xs = res.x;
      if (fn === 'find') {
        const worst = Math.max(...residuals(xs).map(Math.abs));
        if (!(worst < Math.max(1e-7, Math.sqrt(engineCtx.tol)))) {
          throw new Error('No solution found. Try other guess values, or use minerr for a best fit');
        }
      }
    }
    const values = xs.map((x, i) => joinUnit(Math.abs(x) < 1e-14 ? 0 : x, units[i]));
    const value = values.length === 1 ? values[0] : vec(values);
    if (lhs) {
      if (lhs.kind === 'var') {
        this.global.set(lhs.name, value);
        this.ranges.delete(lhs.name);
      } else if (lhs.kind === 'destructure') {
        if (lhs.names.length !== values.length) throw new Error(`Expected ${values.length} names on the left`);
        lhs.names.forEach((n, i) => this.global.set(n, values[i]));
      } else throw new Error('Assign the solution to a variable or [a; b] list');
    }
    this.updateDefined();
    const callTex = `\\mathrm{${fn}}\\left(${args.map((a) => exprTex(a)).join(',')}\\right)`;
    const tex = (v: unknown) => {
      const shown = show ? ` = ${valueTex(v, this.fmt, unit || undefined)}` : '';
      return lhs ? `${lhsTex(lhs)} \\coloneqq ${callTex}${shown}` : `${callTex}${shown}`;
    };
    return { tex, value };
  }

  // ------------------------------------------------------------ tables

  evaluateTable(r: TableRegion): TableResult {
    try {
      if (!isIdentifier(r.name)) throw new Error('Table needs a valid variable name');
      const units = r.units.map((u) => (u.trim() ? math.evaluate(u.trim()) : null));
      const rows = r.cells
        .filter((row) => row.some((c) => c.trim() !== ''))
        .map((row) =>
          row.map((c, j) => {
            const t = c.trim();
            let v: unknown = t === '' ? 0 : compileExpr(t).evaluate(this.global);
            if (units[j]) v = math.multiply(v as never, units[j] as never);
            return v;
          }),
        );
      if (rows.length === 0) throw new Error('Table is empty');
      const value = normalize(math.matrix(rows as never));
      this.global.set(r.name, value);
      this.ranges.delete(r.name);
      this.updateDefined();
      return { kind: 'table' };
    } catch (e) {
      return { kind: 'table', error: friendlyError(e) };
    }
  }

  // ------------------------------------------------------------ sketches

  evaluateSketchRegion(r: SketchRegion): SketchResult {
    try {
      const { result, value } = evaluateSketch(r, (src) => compileExpr(src).evaluate(this.global));
      const name = r.name.trim();
      if (name && value) {
        if (!isIdentifier(name)) throw new Error(`"${name}" is not a valid variable name`);
        this.global.set(name, value);
        this.ranges.delete(name);
        this.updateDefined();
      }
      return result;
    } catch (e) {
      return { kind: 'sketch', resolved: {}, errors: {}, error: friendlyError(e) };
    }
  }

  // ------------------------------------------------------------ CAD parts

  evaluateCadRegion(r: CadRegion): CadResult {
    let res: CadResult;
    try {
      res = solveCad(r, (src) => compileExpr(src).evaluate(this.global)).result;
    } catch (e) {
      return { kind: 'cad', points: {}, radii: {}, ok: false, dof: 0, determined: [], determinedRadii: [], conflicting: [], redundant: [], values: {}, dimErrors: {}, issues: [], error: friendlyError(e) };
    }
    const name = r.name.trim();
    if (name) {
      if (!isIdentifier(name)) res.error = `"${name}" is not a valid variable name`;
      else {
        this.global.set(name, cadValue(r, res));
        this.ranges.delete(name);
        this.updateDefined();
      }
    }
    return res;
  }

  // ------------------------------------------------------------ beams and frames

  evaluateBeamRegion(r: BeamRegion): BeamResult {
    let res: BeamResult;
    try {
      res = solveBeam(r, (src) => compileExpr(src).evaluate(this.global));
    } catch (e) {
      return { kind: 'beam', values: {}, errors: {}, error: friendlyError(e) };
    }
    const name = r.name.trim();
    if (name && res.solution) {
      if (!isIdentifier(name)) res.error = `"${name}" is not a valid variable name`;
      else {
        this.global.set(name, beamValue(r, res));
        this.ranges.delete(name);
        this.updateDefined();
      }
    }
    return res;
  }

  // ------------------------------------------------------------ text with live values

  evaluateText(r: TextRegion): TextResult {
    const values: TextResult['values'] = {};
    const re = /\{\{([^}]+)\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(r.markdown))) {
      const raw = m[1];
      const [expr, unit] = raw.split('|').map((s) => s.trim());
      try {
        const v = this.evalWithRanges(expr, this.global);
        values[raw] = { tex: valueTex(v, this.fmt, unit || undefined) };
      } catch (e) {
        values[raw] = { error: friendlyError(e) };
      }
    }
    return { kind: 'text', values };
  }

  // ------------------------------------------------------------ plots

  evaluatePlot(r: PlotRegion): PlotResult {
    const out: PlotResult = { kind: 'plot', series: [], xLabel: '', yLabel: '' };
    try {
      if (r.plotType === 'surface' || r.plotType === 'contour') {
        out.surface = this.surfaceData(r);
        out.xLabel = 'x';
        out.yLabel = 'y';
        return out;
      }
      const xUnitInfo: { unit?: string } = { unit: r.xUnit.trim() || undefined };
      const yUnitInfo: { unit?: string } = { unit: r.yUnit.trim() || undefined };
      const traces = r.traces.filter((t) => t.y.trim());
      if (traces.length === 0) throw new Error('Add a y-axis expression');
      for (const t of traces) {
        const xSrc = (t.xExpr || r.xExpr).trim();
        if (!xSrc) throw new Error('Add an x-axis expression');
        let sampled: { xv: unknown[]; yv: unknown[] };
        try {
          sampled = this.sampleTrace(xSrc, t.y.trim(), r);
        } catch (e) {
          throw new Error(`${t.y.trim()}: ${friendlyError(e)}`);
        }
        const { xv, yv } = sampled;
        const xs = this.toAxis(xv, xUnitInfo);
        const ys = this.toAxis(yv, yUnitInfo);
        out.series.push({ xs, ys, label: t.y.trim(), style: t.style, color: t.color });
      }
      const label = (srcs: string[], u?: string) => srcs.join(', ') + (u ? ` [${u}]` : '');
      const lim = (src: string, info: { unit?: string }) => {
        if (!src.trim()) return null;
        try {
          const v = this.toAxis([compileExpr(src).evaluate(this.global)], info)[0];
          return Number.isFinite(v) ? v : null;
        } catch {
          return null;
        }
      };
      out.limits = { xmin: lim(r.xmin, xUnitInfo), xmax: lim(r.xmax, xUnitInfo), ymin: lim(r.ymin, yUnitInfo), ymax: lim(r.ymax, yUnitInfo) };
      out.xLabel = label([...new Set(traces.map((t) => (t.xExpr || r.xExpr).trim()))], xUnitInfo.unit);
      out.yLabel = label(traces.map((t) => t.y.trim()), yUnitInfo.unit);
    } catch (e) {
      out.error = friendlyError(e);
    }
    return out;
  }

  private sampleTrace(xSrc: string, ySrc: string, r: PlotRegion): { xv: unknown[]; yv: unknown[] } {
    const scope = this.global;
    const yNode = parseExpr(ySrc);
    const ySyms = freeSymbols(yNode);
    if (isIdentifier(xSrc)) {
      const name = xSrc;
      const val = scope.has(name) ? scope.get(name) : undefined;
      const local = new ChainScope(scope);
      const yc = compileExpr(ySrc);
      if (isMatrix(val) || Array.isArray(val)) {
        const xs = toVector(val);
        if (ySyms.has(name)) {
          let firstError: unknown = null;
          const yv = xs.map((x) => {
            local.set(name, x);
            try {
              const y = yc.evaluate(local);
              return isMatrix(y) ? NaN : y;
            } catch (e) {
              firstError ??= e;
              return NaN;
            }
          });
          if (firstError && yv.every((y) => typeof y === 'number' && Number.isNaN(y))) throw firstError;
          return { xv: xs, yv };
        }
        const y = this.evalWithRanges(ySrc, scope);
        return { xv: xs, yv: isMatrix(y) || Array.isArray(y) ? toVector(y) : xs.map(() => y) };
      }
      if (ySyms.has(name) || val === undefined || typeof val === 'number' || isUnit(val)) {
        // QuickPlot: sample the x variable across the axis limits
        const lo = r.xmin.trim() ? compileExpr(r.xmin).evaluate(scope) : -10;
        const hi = r.xmax.trim() ? compileExpr(r.xmax).evaluate(scope) : 10;
        const a = splitUnit(lo), b = splitUnit(hi);
        const unit = a.unit ?? b.unit;
        const n = 600;
        const xs: unknown[] = [];
        const ys: unknown[] = [];
        let firstError: unknown = null;
        for (let k = 0; k <= n; k++) {
          const xvNum = r.logX && a.value > 0 && b.value > 0
            ? Math.exp(Math.log(a.value) + ((Math.log(b.value) - Math.log(a.value)) * k) / n)
            : a.value + ((b.value - a.value) * k) / n;
          const xq = joinUnit(xvNum, unit);
          local.set(name, xq);
          xs.push(xq);
          try {
            const y = yc.evaluate(local);
            ys.push(isMatrix(y) ? NaN : y);
          } catch (e) {
            firstError ??= e;
            ys.push(NaN);
          }
        }
        // a trace that fails everywhere is an error, not an empty line
        if (firstError && ys.every((y) => typeof y === 'number' && Number.isNaN(y))) throw firstError;
        return { xv: xs, yv: ys };
      }
    }
    const xval = this.evalWithRanges(xSrc, scope);
    const yval = this.evalWithRanges(ySrc, scope);
    const xs = isMatrix(xval) || Array.isArray(xval) ? toVector(xval) : [xval];
    const ys = isMatrix(yval) || Array.isArray(yval) ? toVector(yval) : xs.map(() => yval);
    if (xs.length !== ys.length) throw new Error(`x has ${xs.length} values but y has ${ys.length}`);
    return { xv: xs, yv: ys };
  }

  /** Convert values to axis numbers; picks a display unit from the first value if none is given. */
  private toAxis(vals: unknown[], info: { unit?: string }): number[] {
    if (!info.unit) {
      const first = vals.find((v) => isUnit(v) && Number.isFinite(splitUnit(v).value) && splitUnit(v).value !== 0) as Unit | undefined;
      if (first) info.unit = unitParts(first).units || undefined;
    }
    return vals.map((v) => {
      try {
        if (typeof v === 'number') return v;
        if (typeof v === 'boolean') return v ? 1 : 0;
        if (isComplex(v)) return Math.abs(v.im) < 1e-12 * Math.max(1, Math.abs(v.re)) ? v.re : NaN;
        if (isUnit(v)) return info.unit ? (v.toNumeric(info.unit) as number) : splitUnit(v).value;
        return NaN;
      } catch {
        return NaN;
      }
    });
  }

  private surfaceData(r: PlotRegion) {
    const src = r.z.trim();
    if (!src) throw new Error('Add a z expression: a matrix, a function f, or an expression in x and y');
    const scope = this.global;
    const v = isIdentifier(src) && scope.has(src) ? scope.get(src) : undefined;
    if (isMatrix(v)) {
      const z = (v.toArray() as unknown[][]).map((row) => (Array.isArray(row) ? row : [row]).map((c) => splitUnit(c).value));
      return { xs: z.map((_, i) => i + engineCtx.origin), ys: z[0].map((_, j) => j + engineCtx.origin), z };
    }
    const num = (s: string, d: number) => (s.trim() ? splitUnit(compileExpr(s).evaluate(scope)).value : d);
    const x0 = num(r.xmin, -5), x1 = num(r.xmax, 5), y0 = num(r.ymin, -5), y1 = num(r.ymax, 5);
    const n = 41;
    const xs = Array.from({ length: n }, (_, i) => x0 + ((x1 - x0) * i) / (n - 1));
    const ys = Array.from({ length: n }, (_, j) => y0 + ((y1 - y0) * j) / (n - 1));
    const local = new ChainScope(scope);
    const f = typeof v === 'function' ? (v as (a: number, b: number) => unknown) : null;
    const c = f ? null : compileExpr(src);
    const z = xs.map((x) => ys.map((y) => {
      try {
        if (f) return splitUnit(f(x, y)).value;
        local.set('x', x);
        local.set('y', y);
        return splitUnit(c!.evaluate(local)).value;
      } catch {
        return NaN;
      }
    }));
    return { xs, ys, z };
  }
}

export function evaluateWorksheet(ws: Worksheet, overrides?: Record<string, string>): EvaluationOutput {
  const t0 = performance.now();
  const ev = new Evaluator(ws, overrides);
  ev.run();
  let errorCount = 0;
  for (const r of ev.results.values()) {
    if ('error' in r && r.error) errorCount++;
    if (r.kind === 'solve' && (r.solver.error || r.guesses.some((g) => g.error) || r.constraints.some((c) => c.error))) errorCount++;
  }
  return { results: ev.results, needsCas: ev.needsCas, errorCount, millis: performance.now() - t0 };
}

