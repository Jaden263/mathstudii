// Symbolic evaluation (→) backed by the nerdamer-prime CAS, loaded lazily
// because it is ~0.5 MB and many worksheets never use it.
import type { MathNode } from 'mathjs';
import { math } from './math';
import { parseExpr } from './compile';
import { splitTop, findEvalEquals } from './syntax';
import type { ScopeLike } from './scope';
import type { FormatOptions } from './format';
import { checkDimensions, hasUnitSymbols, unitNamesIn, unitNode, unitResultTex, valueNode } from './symbolicUnits';

type Nerdamer = ((expr: string) => NerdExpr) & {
  setFunction(name: string, params: string[], body: string): void;
  clearFunctions?(): void;
};
interface NerdExpr {
  toString(): string;
  toTeX(): string;
  evaluate(): NerdExpr;
  text(mode: string, digits?: number): string;
  sub(a: string, b: string): NerdExpr;
  variables(): string[];
}

let cas: Nerdamer | null = null;
let loading: Promise<void> | null = null;

export function casReady(): boolean {
  return cas !== null;
}

export function loadCas(): Promise<void> {
  if (cas) return Promise.resolve();
  if (!loading) {
    loading = import('nerdamer-prime').then((m) => {
      cas = ((m as unknown as { default?: Nerdamer }).default ?? (m as unknown as Nerdamer)) as Nerdamer;
    });
  }
  return loading;
}

export interface SymFunction {
  params: string[];
  body: string;
}

/** Functions whose argument positions ≥ 1 that are plain names are variables, never substituted. */
const VAR_TAKING = new Set(['diff', 'integrate', 'integral', 'defint', 'solve', 'limit', 'laplace', 'ilt', 'sum', 'prod', 'product', 'partfrac', 'coeffs', 'taylor', 'series']);

const RENAME_TO_CAS: Record<string, string> = { log: 'log10', ln: 'log', prod: 'product', nthRoot: 'nthroot' };

export interface SymContext {
  scope: ScopeLike;
  functions: Map<string, SymFunction>;
  /** How numbers with units are shown in results (the worksheet's format). */
  fmt?: FormatOptions;
  /** Names read as units in the expression being evaluated (set by symbolicEval). */
  units?: Set<string>;
}

function boundVariables(node: MathNode): Set<string> {
  const out = new Set<string>();
  node.traverse((n: MathNode) => {
    const any = n as unknown as { type: string; fn?: { name?: string }; args?: MathNode[] };
    if (any.type === 'FunctionNode' && any.fn?.name && VAR_TAKING.has(any.fn.name)) {
      any.args!.slice(1).forEach((a) => {
        if (a.type === 'SymbolNode') out.add((a as unknown as { name: string }).name);
      });
    }
  });
  return out;
}

/** Substitute known numeric values and inline user functions (stays in mathjs syntax). */
function expand(node: MathNode, ctx: SymContext, keep: Set<string>, depth = 0): MathNode {
  if (depth > 20) throw new Error('Function definitions are nested too deeply');
  return node.transform((n: MathNode) => {
    const any = n as unknown as Record<string, unknown>;
    if (n.type === 'SymbolNode') {
      const name = any.name as string;
      if (keep.has(name)) return n;
      if (ctx.units?.has(name)) return unitNode(name);
      if (ctx.scope.has(name)) {
        const v = ctx.scope.get(name);
        if (typeof v === 'number') return new math.ParenthesisNode(new math.ConstantNode(v));
        // a variable defined with a unit (F := 10 kN) brings its value and unit
        const q = valueNode(v);
        if (q) return q;
      }
      return n;
    }
    if (n.type === 'FunctionNode') {
      const fn = any.fn as { name?: string };
      const name = fn.name ?? '';
      if (name === '__d') return new math.ParenthesisNode(expand(primeDerivative(any.args as MathNode[], ctx), ctx, keep, depth + 1));
      const args = (any.args as MathNode[]).map((a) => expand(a, ctx, keep, depth + 1));
      const user = ctx.functions.get(name);
      if (user && !keep.has(name)) {
        if (user.params.length !== args.length) throw new Error(`${name} expects ${user.params.length} arguments`);
        const body = parseExpr(user.body).transform((b: MathNode) => {
          const bn = b as unknown as { type: string; name?: string };
          if (bn.type === 'SymbolNode') {
            const k = user.params.indexOf(bn.name!);
            if (k >= 0) return new math.ParenthesisNode(args[k]);
          }
          return b;
        });
        return new math.ParenthesisNode(expand(body, ctx, keep, depth + 1));
      }
      return new math.FunctionNode(new math.SymbolNode(name), args);
    }
    return n;
  });
}

/** y''(t) (written __d(y, 2, t)) of a function defined above → diff(y(t), t, 2). */
function primeDerivative(args: MathNode[], ctx: SymContext): MathNode {
  const [f, k, arg] = args as (MathNode & { name?: string; value?: number })[];
  const name = f.name ?? '?';
  const marks = '′'.repeat(Number(k.value) || 1);
  const user = ctx.functions.get(name);
  if (!user || user.params.length !== 1) {
    throw new Error(`${name}${marks}: ${name} is not a function of one variable defined above — define ${name}(t) := … to differentiate it symbolically`);
  }
  if (arg.type !== 'SymbolNode') throw new Error(`${name}${marks}( ) needs a variable in symbolic math, like ${name}${marks}(t)`);
  return new math.FunctionNode(new math.SymbolNode('diff'), [new math.FunctionNode(new math.SymbolNode(name), [arg]), arg, new math.ConstantNode(Number(k.value))]);
}

const GREEK_NAMES: Record<string, string> = {
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', ζ: 'zeta', η: 'eta', θ: 'theta', ι: 'iota', κ: 'kappa',
  λ: 'lambda', μ: 'mu', ν: 'nu', ξ: 'xi', ο: 'omicron', π: 'pi', ρ: 'rho', σ: 'sigma', ς: 'sigma', τ: 'tau', υ: 'upsilon',
  φ: 'phi', ϕ: 'phi', χ: 'chi', ψ: 'psi', ω: 'omega', Γ: 'Gamma', Δ: 'Delta', Θ: 'Theta', Λ: 'Lambda', Ξ: 'Xi', Π: 'Pi',
  Σ: 'Sigma', Υ: 'Upsilon', Φ: 'Phi', Ψ: 'Psi', Ω: 'Omega',
};

/** nerdamer only accepts ASCII identifiers. */
function asciiName(name: string): string {
  if (/^[\x00-\x7F]*$/.test(name)) return name;
  return [...name].map((ch) => GREEK_NAMES[ch] ?? (/[\x00-\x7F]/.test(ch) ? ch : `u${ch.codePointAt(0)}`)).join('');
}

/** Functions nerdamer knows that mathjs does not. */
const CAS_ONLY = new Set(['integrate', 'defint', 'ilt', 'laplace', 'partfrac', 'coeffs', 'limit', 'product', 'nthroot', 'integral']);

/** Map Mathcad/mathjs function names onto nerdamer's. */
function rename(node: MathNode): MathNode {
  return node.transform((n: MathNode) => {
    const any = n as unknown as Record<string, unknown>;
    if (n.type === 'SymbolNode') {
      if (any.name === '__I') return new math.SymbolNode('i');
      const a = asciiName(any.name as string);
      return a === any.name ? n : new math.SymbolNode(a);
    }
    if (n.type !== 'FunctionNode') return n;
    const name = (any.fn as { name?: string }).name ?? '';
    const args = (any.args as MathNode[]).map(rename);
    if (!(name in math) && !CAS_ONLY.has(name) && args.length === 1) {
      // s(s + 1) with an unknown name is a product, as in Mathcad
      return new math.OperatorNode('*', 'multiply', [new math.SymbolNode(asciiName(name)), new math.ParenthesisNode(args[0])]);
    }
    if (name === 'integral' && args.length === 4) {
      return new math.FunctionNode(new math.SymbolNode('defint'), [args[0], args[2], args[3], args[1]]);
    }
    if (name === 'integral' && args.length === 2) return new math.FunctionNode(new math.SymbolNode('integrate'), args);
    return new math.FunctionNode(new math.SymbolNode(RENAME_TO_CAS[name] ?? asciiName(name)), args);
  });
}

function toCas(node: MathNode, ctx: SymContext, keep: Set<string>): string {
  const expanded = expand(node, ctx, keep);
  // units: like is added to like (2 m + 3 s is an error, not a sum of two symbols)
  if (ctx.units?.size || hasUnitSymbols(expanded.toString())) checkDimensions(expanded);
  return rename(expanded)
    .toString({ implicit: 'show', parenthesis: 'auto' })
    .replace(/\s*==\s*/g, '=')
    .replace(/\bdeg\b/g, '(pi/180)');
}

/** Bound variables of an expression and its keywords (never substituted, never units). */
function keptNames(node: MathNode, kws: string[]): Set<string> {
  const keep = boundVariables(node);
  // variables named in keyword arguments are never substituted
  kws.slice(1).forEach((k) => {
    const name = k.split('=')[0].trim();
    if (/^[A-Za-z_Ͱ-Ͽ][\wͰ-Ͽ]*$/.test(name)) keep.add(name);
  });
  return keep;
}

function unitScope(ctx: SymContext) {
  return { isDefined: (n: string) => ctx.scope.has(n) || ctx.functions.has(n), value: (n: string) => ctx.scope.get(n) };
}

/** Names that are units in `expr → keywords` (for showing the input). */
export function symbolicUnitNames(exprSrc: string, keywords: string, ctx: SymContext): Set<string> {
  try {
    const eq = findEvalEquals(exprSrc);
    const node = parseExpr(eq >= 0 ? `${exprSrc.slice(0, eq)}==${exprSrc.slice(eq + 1)}` : exprSrc);
    const kws = keywords ? splitTop(keywords, ',').map((k) => k.trim()).filter(Boolean) : [];
    return unitNamesIn(node, unitScope(ctx), keptNames(node, kws));
  } catch {
    return new Set();
  }
}

function texOut(e: { toTeX(): string }): string {
  return e
    .toTeX()
    .replace(/vmatrix/g, 'bmatrix')
    .replace(/\\cr/g, '\\\\')
    .replace(/\\mathrm\{log\}/g, '\\ln')
    .replace(/\\mathrm\{(sin|cos|tan|sinh|cosh|tanh|exp)\}/g, '\\$1');
}

/** Evaluate `expr → keywords` symbolically. Returns TeX of the result. */
export function symbolicEval(exprSrc: string, keywords: string, ctx: SymContext): string {
  if (!cas) throw new Error('Loading the symbolic engine…');
  const nerd = cas;
  // Mathcad allows "x^2 = 4 → solve, x": treat a single top-level = as an equation
  let src = exprSrc;
  const eq = findEvalEquals(src);
  if (eq >= 0) src = `${src.slice(0, eq)}==${src.slice(eq + 1)}`;
  const node = parseExpr(src);
  const kws = keywords ? splitTop(keywords, ',').map((k) => k.trim()).filter(Boolean) : [];
  const kw = kws[0]?.toLowerCase() ?? '';
  const keep = keptNames(node, kws);
  ctx = { ...ctx, units: unitNamesIn(node, unitScope(ctx), keep) };
  let e = toCas(node, ctx, keep);
  const improper = improperIntegral(node, ctx, keep, nerd);
  if (improper !== null) e = improper;
  const arg = (i: number, fallback?: string) => {
    const v = kws[i];
    if (v === undefined) {
      if (fallback === undefined) throw new Error(`Keyword "${kw}" needs more arguments`);
      return fallback;
    }
    const vn = parseExpr(v);
    return toCas(vn, { ...ctx, units: unitNamesIn(vn, unitScope(ctx), keep) }, keep);
  };
  const guessVar = () => {
    const syms = new Set<string>();
    node.traverse((n: MathNode) => {
      if (n.type === 'SymbolNode') {
        const name = (n as unknown as { name: string }).name;
        if (!(name in math) && !ctx.scope.has(name) && !ctx.units?.has(name)) syms.add(name);
      }
    });
    return syms.has('x') ? 'x' : [...syms][0] ?? 'x';
  };
  // a result with units: each unit part shown the way "=" shows quantities
  const done = (r: NerdExpr, reshape?: string): string => {
    const str = r.toString();
    if (!hasUnitSymbols(str)) return texOut(r);
    return unitResultTex(nerd, str, { fmt: ctx.fmt ?? { precision: 4, expThreshold: 6, metric: true }, reshape, texOut });
  };
  switch (kw) {
    case '':
      return done(nerd(e));
    case 'simplify':
      return done(nerd(`simplify(${e})`), 'simplify');
    case 'expand':
      return done(nerd(`expand(${e})`), 'expand');
    case 'factor':
      return done(nerd(`factor(${e})`), 'factor');
    case 'solve': {
      const v = arg(1, guessVar());
      return done(nerd(`solve(${e}, ${v})`));
    }
    case 'float': {
      const digits = Number(kws[1] ?? 10);
      const txt = nerd(e).evaluate().text('decimals', digits);
      return done(nerd(txt));
    }
    case 'substitute': {
      let r = nerd(e);
      for (const s of kws.slice(1)) {
        const [a, b] = s.split('=');
        if (b === undefined) throw new Error('substitute, x = value');
        const bn = parseExpr(b);
        r = r.sub(a.trim(), toCas(bn, { ...ctx, units: unitNamesIn(bn, unitScope(ctx), keep) }, keep));
      }
      return done(nerd(`simplify(${r.toString()})`));
    }
    case 'coeffs':
      return done(nerd(`coeffs(${e}, ${arg(1, guessVar())})`));
    case 'collect':
      return done(nerd(`expand(${e})`), 'expand');
    case 'partfrac':
    case 'parfrac':
      return done(nerd(`partfrac(${e}, ${arg(1, guessVar())})`));
    case 'laplace':
      return done(nerd(`laplace(${e}, ${arg(1, 't')}, ${arg(2, 's')})`));
    case 'invlaplace':
    case 'ilt':
      return done(nerd(`ilt(${e}, ${arg(1, 's')}, ${arg(2, 't')})`));
    case 'series':
    case 'taylor': {
      const v = arg(1, guessVar());
      let a = '0';
      let order = 6;
      if (kws[2] !== undefined) {
        const p = kws[2].split('=');
        if (p.length === 2) a = toCas(parseExpr(p[1]), ctx, keep);
        else order = Number(kws[2]);
      }
      if (kws[3] !== undefined) order = Number(kws[3]);
      if (kws[1]?.includes('=')) {
        const [vv, aa] = kws[1].split('=');
        return done(taylor(nerd, e, vv.trim(), toCas(parseExpr(aa), ctx, keep), order));
      }
      return done(taylor(nerd, e, v, a, order));
    }
    case 'diff':
      return done(nerd(`diff(${e}, ${arg(1, guessVar())})`));
    case 'integrate':
      return done(nerd(`integrate(${e}, ${arg(1, guessVar())})`));
    default:
      throw new Error(`Unknown symbolic keyword "${kws[0]}"`);
  }
}

/** nerdamer's defint does not take limits at ±∞; do F(b) − F(a) with limits ourselves. */
function improperIntegral(node: MathNode, ctx: SymContext, keep: Set<string>, nerd: Nerdamer): string | null {
  const any = node as unknown as { type: string; fn?: { name?: string }; args?: MathNode[] };
  if (any.type !== 'FunctionNode' || any.fn?.name !== 'integral' || any.args?.length !== 4) return null;
  const [f, v, a, b] = any.args;
  if (v.type !== 'SymbolNode') return null;
  const isInf = (n: MathNode) => /Infinity/.test(n.toString());
  if (!isInf(a) && !isInf(b)) return null;
  const vn = asciiName((v as unknown as { name: string }).name);
  const F = nerd(`integrate(${toCas(f, ctx, keep)}, ${vn})`).toString();
  if (/integrate\(/.test(F)) return null;
  const at = (bound: MathNode) => {
    const bs = toCas(bound, ctx, keep);
    return isInf(bound) ? nerd(`limit(${F}, ${vn}, ${bs})`).toString() : nerd(F).sub(vn, `(${bs})`).toString();
  };
  return nerd(`simplify((${at(b)}) - (${at(a)}))`).toString();
}

function taylor(nerd: Nerdamer, e: string, v: string, a: string, order: number): NerdExpr {
  if (!Number.isInteger(order) || order < 1 || order > 20) throw new Error('series order must be an integer 1..20');
  let term = e;
  const parts: string[] = [];
  let fact = 1;
  for (let k = 0; k < order; k++) {
    if (k > 0) {
      term = nerd(`diff(${term}, ${v})`).toString();
      fact *= k;
    }
    const c = nerd(term).sub(v, `(${a})`).toString();
    if (c !== '0') parts.push(`(${c})/${fact}*(${v}-(${a}))^${k}`);
  }
  return nerd(`expand(${parts.join('+') || '0'})`);
}
