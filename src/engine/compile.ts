import type { MathNode, EvalFunction } from 'mathjs';
import { math } from './math';
import { preprocess } from './syntax';

// Functions whose Mathcad meaning differs from mathjs, renamed at the AST level
// so mathjs internals that depend on the originals keep working.
export const RENAME: Record<string, string> = {
  log: 'mcLog',
  ln: 'mcLn',
  sum: 'mcSum',
  prod: 'mcProd',
  product: 'mcProd',
  stdev: 'mcStdevP',
  Stdev: 'mcStdevS',
  var: 'mcVarP',
  Var: 'mcVarS',
  sort: 'mcSort',
  transpose: 'mcTranspose',
  diff: 'mcDiff',
  range: 'mcRange',
  row: 'mcRow',
  lsolve: 'mcLsolve',
  matrix: 'mcMatrix',
  corr: 'mcCorr',
  fft: 'mcFft',
  ifft: 'mcIfft',
  concat: 'mcConcat',
  // mathjs keeps "error" for itself
  error: 'mcError',
  // Mathcad's max(A, B, c …): over every element of every argument
  max: 'mcMax',
  min: 'mcMin',
};

/**
 * Library functions a worksheet variable of the same name may shadow (Ai, Si, beta …):
 * calls go through __call so that "Ai (x + 1)" still multiplies when Ai is a value.
 */
export const SHADOWABLE = new Set<string>();

/** Functions whose second argument is a bound (dummy) variable. */
export const BINDERS = new Set(['integral', 'sum', 'prod', 'product', 'diff', 'deriv', 'root', 'mcSum', 'mcProd', 'mcDiff']);

const parseCache = new Map<string, MathNode>();
const compileCache = new Map<string, EvalFunction>();
/** Entries each cache keeps: the expressions of a few worksheets (the oldest go first). */
const CACHED = 2000;

function remember<T>(cache: Map<string, T>, key: string, v: T) {
  if (cache.size >= CACHED) cache.delete(cache.keys().next().value!);
  cache.set(key, v);
}

/** Parse user text (after Mathcad→mathjs translation) without engine transforms. Used for display. */
export function parseExpr(src: string): MathNode {
  const pre = preprocess(src);
  let node = parseCache.get(pre);
  if (!node) {
    node = math.parse(pre);
    remember(parseCache, pre, node);
  }
  return node;
}

let unitFunctions: Set<string> | null = null;
/**
 * Names that are both a function and a unit: min, sec, pF, pt, qt … Called they are the
 * function; written as a value they are the unit (5 min, 1800 sec, 10 pF), as in Mathcad.
 */
function isUnitFunction(name: string): boolean {
  if (!unitFunctions) {
    unitFunctions = new Set(Object.keys(math).filter((k) => {
      if (typeof (math as unknown as Record<string, unknown>)[k] !== 'function') return false;
      try {
        return math.Unit.isValuelessUnit(k);
      } catch {
        return false;
      }
    }));
  }
  return unitFunctions.has(name);
}

/** Engine transforms: renames, ORIGIN-aware indexing, transpose semantics. */
export function transformForEval(node: MathNode): MathNode {
  return node.transform((n: MathNode) => {
    const any = n as unknown as Record<string, unknown>;
    if (n.type === 'SymbolNode' && isUnitFunction(any.name as string)) {
      // a worksheet variable of that name still wins (looked up when evaluated)
      return new math.FunctionNode(new math.SymbolNode('__unitName'), [new math.ConstantNode(any.name as string)]);
    }
    if (n.type === 'FunctionNode') {
      const fn = any.fn as MathNode & { name?: string };
      const name = fn.type === 'SymbolNode' ? fn.name! : '';
      const args = (any.args as MathNode[]).map((a) => transformForEval(a));
      if (name && RENAME[name]) {
        return new math.FunctionNode(new math.SymbolNode(RENAME[name]), args);
      }
      if (fn.type === 'SymbolNode' && (!(name in math) || SHADOWABLE.has(name))) {
        // user names: f(x) calls a function, but s(s + 1) multiplies when s is a value (Mathcad semantics)
        return new math.FunctionNode(new math.SymbolNode('__call'), [new math.ConstantNode(name), fn, ...args]);
      }
      return new math.FunctionNode(fn.type === 'SymbolNode' ? fn : transformForEval(fn), args);
    }
    if (n.type === 'AccessorNode') {
      const index = any.index as { dotNotation: boolean; dimensions: MathNode[] };
      if (index.dotNotation) return n;
      const obj = transformForEval(any.object as MathNode);
      const dims = index.dimensions.map((d) => {
        const dn = d as unknown as { type: string; start?: MathNode; end?: MathNode; step?: MathNode };
        if (dn.type === 'RangeNode' && !dn.start && !dn.end) return new math.ConstantNode('__ALL__');
        if (dn.type === 'SymbolNode' && (d as unknown as { name: string }).name === ':') return new math.ConstantNode('__ALL__');
        return transformForEval(d);
      });
      return new math.FunctionNode(new math.SymbolNode('__idx'), [obj, ...dims]);
    }
    if (n.type === 'ArrayNode') {
      // Mathcad: [1, 2, 3] is a row vector, [1; 2; 3] a column vector; an element that is an
      // array makes a nested array (__matrix)
      const items = any.items as MathNode[];
      const row = (xs: MathNode[]) => new math.FunctionNode(new math.SymbolNode('__row'), xs.map(transformForEval));
      if (items.length && items.every((it) => it.type === 'ArrayNode')) {
        return new math.FunctionNode(new math.SymbolNode('__matrix'), items.map((it) => row((it as unknown as { items: MathNode[] }).items)));
      }
      return new math.FunctionNode(new math.SymbolNode('__matrix'), [row(items)]);
    }
    if (n.type === 'OperatorNode') {
      const fn = any.fn as string;
      if (fn === 'ctranspose' || fn === 'transpose') {
        return new math.FunctionNode(new math.SymbolNode('mcTranspose'), (any.args as MathNode[]).map(transformForEval));
      }
      const compound = offsetCompound(n);
      if (compound) return compound;
    }
    return n;
  });
}

/** A unit whose zero is not absolute zero (°C, °F): alone it is a temperature. */
function isOffsetUnit(name: string): boolean {
  try {
    return math.Unit.isValuelessUnit(name) && new math.Unit(null as never, name).units.some((u) => (u.unit as unknown as { offset: number }).offset !== 0);
  } catch {
    return false;
  }
}

/** Units only (W, m^2, kg/s …), no numbers or worksheet names. */
function isUnitExpr(n: MathNode): boolean {
  const any = n as unknown as Record<string, unknown>;
  if (n.type === 'SymbolNode') return math.Unit.isValuelessUnit(any.name as string);
  if (n.type === 'ParenthesisNode') return isUnitExpr(any.content as MathNode);
  if (n.type !== 'OperatorNode') return false;
  const [a, b] = any.args as MathNode[];
  if (any.fn === 'pow') return isUnitExpr(a) && b.type === 'ConstantNode';
  return (any.fn === 'multiply' || any.fn === 'divide') && !!b && isUnitExpr(a) && isUnitExpr(b);
}

/**
 * 23 °C/W is a number with the compound unit °C/W, where °C is a difference (23 K/W), as a
 * thermal resistance is meant; only a temperature written alone (20 °C) is absolute. The
 * parser reads it as (23 °C)/W, which would make it 296.15 K/W, so the unit is regrouped.
 */
function offsetCompound(n: MathNode): MathNode | null {
  const any = n as unknown as Record<string, unknown>;
  if (any.fn !== 'divide' && any.fn !== 'multiply') return null;
  const [left, right] = any.args as MathNode[];
  if (!right || left.type !== 'OperatorNode' || !isUnitExpr(right)) return null;
  const l = left as unknown as { fn: string; args: MathNode[] };
  if (l.fn !== 'multiply' || l.args.length !== 2) return null;
  const [num, unit] = l.args;
  if (num.type !== 'ConstantNode' || unit.type !== 'SymbolNode' || !isOffsetUnit((unit as unknown as { name: string }).name)) return null;
  const grouped = new math.OperatorNode(any.op as never, any.fn as never, [unit, transformForEval(right)]);
  return new math.OperatorNode('*', 'multiply', [num, new math.ParenthesisNode(grouped)]);
}

/** Parse, transform and compile an expression (cached). */
export function compileExpr(src: string): EvalFunction {
  let c = compileCache.get(src);
  if (!c) {
    c = transformForEval(parseExpr(src)).compile();
    remember(compileCache, src, c);
  }
  return c;
}

const nodeCompileCache = new WeakMap<MathNode, EvalFunction>();

/** Compile an already-transformed node (e.g. an argument passed to a rawArgs function). */
export function compileNode(node: MathNode): EvalFunction {
  let c = nodeCompileCache.get(node);
  if (!c) {
    c = node.compile();
    nodeCompileCache.set(node, c);
  }
  return c;
}

/** Free symbols of an expression, honouring bound variables of integral/sum/… */
export function freeSymbols(node: MathNode, out = new Set<string>(), bound = new Set<string>()): Set<string> {
  const any = node as unknown as Record<string, unknown>;
  switch (node.type) {
    case 'SymbolNode': {
      const name = any.name as string;
      if (!bound.has(name)) out.add(name);
      return out;
    }
    case 'FunctionNode': {
      const fn = any.fn as MathNode & { name?: string };
      const args = any.args as MathNode[];
      const name = fn.type === 'SymbolNode' ? fn.name! : '';
      if (fn.type !== 'SymbolNode') freeSymbols(fn, out, bound);
      else if (!bound.has(name) && !(name in math)) out.add(name);
      if (BINDERS.has(name) && args.length >= 2 && args[1].type === 'SymbolNode') {
        const v = (args[1] as unknown as { name: string }).name;
        const inner = new Set(bound);
        inner.add(v);
        freeSymbols(args[0], out, inner);
        args.slice(2).forEach((a) => freeSymbols(a, out, bound));
        return out;
      }
      args.forEach((a) => freeSymbols(a, out, bound));
      return out;
    }
    case 'FunctionAssignmentNode': {
      const inner = new Set(bound);
      (any.params as string[]).forEach((p) => inner.add(p));
      return freeSymbols(any.expr as MathNode, out, inner);
    }
    default:
      node.forEach((child: MathNode) => freeSymbols(child, out, bound));
      return out;
  }
}
