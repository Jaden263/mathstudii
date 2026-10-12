// Symbolic evaluation (→) backed by the nerdamer-prime CAS, loaded lazily
// because it is ~0.5 MB and many worksheets never use it.
import type { MathNode } from 'mathjs';
import { math } from './math';
import { parseExpr } from './compile';
import { splitTop, findEvalEquals } from './syntax';
import type { ScopeLike } from './scope';

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
      if (ctx.scope.has(name)) {
        const v = ctx.scope.get(name);
        if (typeof v === 'number') return new math.ParenthesisNode(new math.ConstantNode(v));
      }
      return n;
    }
    if (n.type === 'FunctionNode') {
      const fn = any.fn as { name?: string };
      const name = fn.name ?? '';
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
  return rename(expand(node, ctx, keep))
    .toString({ implicit: 'show', parenthesis: 'auto' })
    .replace(/\s*==\s*/g, '=')
    .replace(/\bdeg\b/g, '(pi/180)');
}

function texOut(e: NerdExpr): string {
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
  const keep = boundVariables(node);
  // variables named in keyword arguments are never substituted
  kws.slice(1).forEach((k) => {
    const name = k.split('=')[0].trim();
    if (/^[A-Za-z_Ͱ-Ͽ][\wͰ-Ͽ]*$/.test(name)) keep.add(name);
  });
  let e = toCas(node, ctx, keep);
  const improper = improperIntegral(node, ctx, keep, nerd);
  if (improper !== null) e = improper;
  const arg = (i: number, fallback?: string) => {
    const v = kws[i];
    if (v === undefined) {
      if (fallback === undefined) throw new Error(`Keyword "${kw}" needs more arguments`);
      return fallback;
    }
    return toCas(parseExpr(v), ctx, keep);
  };
  const guessVar = () => {
    const syms = new Set<string>();
    node.traverse((n: MathNode) => {
      if (n.type === 'SymbolNode') {
        const name = (n as unknown as { name: string }).name;
        if (!(name in math) && !ctx.scope.has(name)) syms.add(name);
      }
    });
    return syms.has('x') ? 'x' : [...syms][0] ?? 'x';
  };
  switch (kw) {
    case '':
      return texOut(nerd(e));
    case 'simplify':
      return texOut(nerd(`simplify(${e})`));
    case 'expand':
      return texOut(nerd(`expand(${e})`));
    case 'factor':
      return texOut(nerd(`factor(${e})`));
    case 'solve': {
      const v = arg(1, guessVar());
      return texOut(nerd(`solve(${e}, ${v})`));
    }
    case 'float': {
      const digits = Number(kws[1] ?? 10);
      const txt = nerd(e).evaluate().text('decimals', digits);
      return texOut(nerd(txt));
    }
    case 'substitute': {
      let r = nerd(e);
      for (const s of kws.slice(1)) {
        const [a, b] = s.split('=');
        if (b === undefined) throw new Error('substitute, x = value');
        r = r.sub(a.trim(), toCas(parseExpr(b), ctx, keep));
      }
      return texOut(nerd(`simplify(${r.toString()})`));
    }
    case 'coeffs':
      return texOut(nerd(`coeffs(${e}, ${arg(1, guessVar())})`));
    case 'collect':
      return texOut(nerd(`expand(${e})`));
    case 'partfrac':
    case 'parfrac':
      return texOut(nerd(`partfrac(${e}, ${arg(1, guessVar())})`));
    case 'laplace':
      return texOut(nerd(`laplace(${e}, ${arg(1, 't')}, ${arg(2, 's')})`));
    case 'invlaplace':
    case 'ilt':
      return texOut(nerd(`ilt(${e}, ${arg(1, 's')}, ${arg(2, 't')})`));
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
        return taylor(nerd, e, vv.trim(), toCas(parseExpr(aa), ctx, keep), order);
      }
      return taylor(nerd, e, v, a, order);
    }
    case 'diff':
      return texOut(nerd(`diff(${e}, ${arg(1, guessVar())})`));
    case 'integrate':
      return texOut(nerd(`integrate(${e}, ${arg(1, guessVar())})`));
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

function taylor(nerd: Nerdamer, e: string, v: string, a: string, order: number): string {
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
  return texOut(nerd(`expand(${parts.join('+') || '0'})`));
}
