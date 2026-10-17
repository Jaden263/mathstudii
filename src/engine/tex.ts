// Expression trees → TeX for the "pretty" Mathcad-like display of input.
import type { MathNode } from 'mathjs';
import { math, isUnitName } from './math';
import { parseExpr } from './compile';
import { parseRange, splitTop, type Lhs } from './syntax';
import { escapeText } from './format';
import { specialFunctionTex } from './specialTex';

/** Names defined in the worksheet; these render as variables rather than units. */
export const texCtx = { defined: new Set<string>(), symbolic: false, symbolicUnits: new Set<string>() };

/** In symbolic math only the names read as units there are units. */
const unitHere = (name: string) => !texCtx.symbolic || texCtx.symbolicUnits.has(name);

const GREEK = [
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta', 'iota', 'kappa',
  'lambda', 'mu', 'nu', 'xi', 'omicron', 'rho', 'varrho', 'sigma', 'varsigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi',
  'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega',
];
const GREEK_SET = new Set(GREEK);
const UNICODE_GREEK: Record<string, string> = {
  α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\varepsilon', ζ: '\\zeta', η: '\\eta', θ: '\\theta',
  ι: '\\iota', κ: '\\kappa', λ: '\\lambda', μ: '\\mu', ν: '\\nu', ξ: '\\xi', ο: 'o', π: '\\pi', ρ: '\\rho', σ: '\\sigma',
  ς: '\\varsigma', τ: '\\tau', υ: '\\upsilon', φ: '\\varphi', ϕ: '\\phi', χ: '\\chi', ψ: '\\psi', ω: '\\omega',
  Γ: '\\Gamma', Δ: '\\Delta', Θ: '\\Theta', Λ: '\\Lambda', Ξ: '\\Xi', Π: '\\Pi', Σ: '\\Sigma', Υ: '\\Upsilon',
  Φ: '\\Phi', Ψ: '\\Psi', Ω: '\\Omega', Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N',
  Ο: 'O', Ρ: 'P', Τ: 'T', Χ: 'X',
};

const UNIT_SPECIAL: Record<string, string> = {
  deg: '{}^{\\circ}', degC: '{}^{\\circ}\\mathrm{C}', degF: '{}^{\\circ}\\mathrm{F}', ohm: '\\Omega',
  kohm: '\\mathrm{k}\\Omega', Mohm: '\\mathrm{M}\\Omega',
};

function identTex(part: string, upright = false): string {
  if (GREEK_SET.has(part)) return '\\' + part;
  let out = '';
  for (const ch of part) out += UNICODE_GREEK[ch] ? UNICODE_GREEK[ch] + ' ' : ch === "'" ? '^{\\prime}' : ch;
  out = out.trim();
  const plainLen = [...part].length;
  if (plainLen > 1 && !/\\/.test(out)) return upright ? `\\mathrm{${out}}` : `\\mathit{${out}}`;
  return out;
}

/** Variable name with Mathcad literal subscript: x_max → x_{max}. */
export function nameTex(name: string): string {
  if (name === 'pi') return '\\pi';
  if (name === 'Infinity') return '\\infty';
  if (name === '__I') return 'i';
  if (name === 'e') return 'e';
  const u = name.indexOf('_');
  if (u > 0 && u < name.length - 1) {
    const base = name.slice(0, u);
    const sub = name.slice(u + 1);
    // W_pl_y → W_{pl,y} (the Eurocode way of writing a second subscript)
    const subTex = sub.split('_').filter(Boolean).map((p) => identTex(p, true)).join(',');
    return `${identTex(base)}_{${subTex}}`;
  }
  return identTex(name);
}

function symbolTex(name: string): string {
  if (unitHere(name) && !texCtx.defined.has(name) && isUnitName(name) && !/^(pi|e|i|Infinity)$/.test(name)) {
    if (UNIT_SPECIAL[name]) return UNIT_SPECIAL[name];
    return `\\mathrm{${name.replace(/_/g, '\\_')}}`;
  }
  return nameTex(name);
}

const TRIG = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh', 'coth', 'arcsin', 'arccos', 'arctan', 'exp', 'det', 'max', 'min', 'gcd', 'ln', 'log', 'arg', 'lim', 'sup', 'inf', 'Pr', 'deg', 'dim', 'hom', 'ker']);
const ALIAS: Record<string, string> = { asin: '\\arcsin', acos: '\\arccos', atan: '\\arctan', asinh: '\\operatorname{arsinh}', acosh: '\\operatorname{arcosh}', atanh: '\\operatorname{artanh}' };

type AnyNode = MathNode & Record<string, unknown>;

function t(n: MathNode): string {
  return n.toTex(TEX_OPTIONS);
}

function argList(args: MathNode[]): string {
  return args.map(t).join(',\\,');
}

/** Function-call parentheses: \mathopen{} avoids the space KaTeX inserts before \left( */
export function call(args: string): string {
  return `\\mathopen{}\\left(${args}\\right)\\mathclose{}`;
}

function isImagParen(n: AnyNode): string | null {
  // (3 * __I) produced by preprocess for imaginary literals
  const inner = (n.type === 'ParenthesisNode' ? n.content : n) as AnyNode;
  if (inner.type === 'OperatorNode' && inner.fn === 'multiply') {
    const [a, b] = inner.args as AnyNode[];
    if (a.type === 'ConstantNode' && b.type === 'SymbolNode' && b.name === '__I') return `${a.value}i`;
  }
  return null;
}

function handler(node: MathNode): string | undefined {
  const out = innerHandler(node);
  // mathjs glues operators like \\cdot directly onto the operand
  return out !== undefined && /^[A-Za-z]/.test(out) ? ' ' + out : out;
}

function innerHandler(node: MathNode): string | undefined {
  const n = node as AnyNode;
  switch (n.type) {
    case 'SymbolNode':
      return symbolTex(n.name as string);
    case 'ConstantNode':
      if (typeof n.value === 'string') return `\\text{“${escapeText(n.value)}”}`;
      if (typeof n.value === 'number') {
        if (!Number.isFinite(n.value)) return Number.isNaN(n.value) ? '\\mathrm{NaN}' : n.value > 0 ? '\\infty' : '-\\infty';
        const s = String(n.value);
        const m = /^(-?[\d.]+)e([+-]?\d+)$/i.exec(s);
        if (m) return `${m[1]}\\cdot 10^{${Number(m[2])}}`;
        return s;
      }
      return undefined;
    case 'ParenthesisNode': {
      const im = isImagParen(n);
      if (im) return im;
      return `\\left(${t(n.content as MathNode)}\\right)`;
    }
    case 'AccessorNode': {
      const idx = n.index as AnyNode;
      if (idx.dotNotation) {
        const prop = ((idx.dimensions as AnyNode[])[0]?.value as string) ?? '';
        return `{${t(n.object as MathNode)}}.{${nameTex(prop)}}`;
      }
      const dims = (idx.dimensions as MathNode[]).map((d) => ((d as AnyNode).type === 'RangeNode' && !(d as AnyNode).start ? ':' : t(d)));
      const obj = t(n.object as MathNode);
      return `{${obj}}_{${dims.join(',')}}`;
    }
    case 'OperatorNode': {
      const im = isImagParen(n);
      if (im) return im;
      const args = n.args as MathNode[];
      if (n.fn === 'ctranspose' || n.fn === 'transpose') return `{${t(args[0])}}^{\\mathrm{T}}`;
      if (n.fn === 'multiply' && n.implicit) {
        const [a, b] = args as AnyNode[];
        if (b.type === 'SymbolNode' && unitHere(b.name as string) && !texCtx.defined.has(b.name as string) && isUnitName(b.name as string)) {
          return `${t(a)}\\,${t(b)}`;
        }
      }
      if (n.fn === 'multiply' && !n.implicit) {
        const [a, b] = args as AnyNode[];
        if (b.type === 'SymbolNode' && b.name === '__I' && a.type === 'ConstantNode') return `${a.value}i`;
      }
      if (n.fn === 'equal') return `${t(args[0])}\\boldsymbol{=}${t(args[1])}`;
      const strip = (x: AnyNode) => (x.type === 'ParenthesisNode' ? (x.content as MathNode) : x);
      if (n.fn === 'pow') {
        const [base, exp] = args as AnyNode[];
        return `{${t(base)}}^{${t(strip(exp))}}`;
      }
      if (n.fn === 'divide') {
        const [num, den] = args as AnyNode[];
        return `\\frac{${t(strip(num))}}{${t(strip(den))}}`;
      }
      return undefined;
    }
    case 'FunctionNode':
      return functionTex(n);
    case 'ArrayNode': {
      const items = n.items as AnyNode[];
      if (items.length && items.every((it) => it.type === 'ArrayNode')) {
        const rows = items.map((row) => (row.items as MathNode[]).map(t).join(' & '));
        return `\\begin{bmatrix} ${rows.join(' \\\\ ')} \\end{bmatrix}`;
      }
      return `\\begin{bmatrix} ${items.map(t).join(' & ')} \\end{bmatrix}`;
    }
    case 'RangeNode':
      return undefined;
    default:
      return undefined;
  }
}

function functionTex(n: AnyNode): string | undefined {
  const fn = n.fn as AnyNode;
  // a function stored on a value, e.g. beam.M(x)
  if (fn.type === 'AccessorNode') return `${t(fn as unknown as MathNode)}\\left(${(n.args as MathNode[]).map(t).join(', ')}\\right)`;
  if (fn.type !== 'SymbolNode') return undefined;
  const name = fn.name as string;
  const args = n.args as MathNode[];
  const a = (i: number) => t(args[i]);
  const isVar = (i: number) => (args[i] as AnyNode)?.type === 'SymbolNode';
  // y''(t), written __d(y, 2, t) by the preprocessor
  if (name === '__d' && args.length >= 3) {
    const k = Number((args[1] as AnyNode).value);
    return `{${a(0)}}${k <= 3 ? "'".repeat(k) : `^{(${k})}`}${call(argList(args.slice(2)))}`;
  }
  if (texCtx.defined.has(name)) return `${nameTex(name)}${call(argList(args))}`;
  const special = specialFunctionTex(name, args.map(t));
  if (special) return special;
  switch (name) {
    case 'sqrt': return `\\sqrt{${a(0)}}`;
    case 'cbrt': return `\\sqrt[3]{${a(0)}}`;
    case 'nthRoot': return `\\sqrt[${a(1)}]{${a(0)}}`;
    case 'abs': return `\\left|${a(0)}\\right|`;
    case 'det': case 'mag': return `\\left|${a(0)}\\right|`;
    case 'norm': return `\\left\\|${a(0)}\\right\\|`;
    case 'floor': return `\\left\\lfloor ${a(0)}\\right\\rfloor`;
    case 'ceil': return `\\left\\lceil ${a(0)}\\right\\rceil`;
    case 'exp': return `e^{${a(0)}}`;
    case 'ln': return `\\ln${call(a(0))}`;
    case 'log': return args.length === 2 ? `\\log_{${a(1)}}${call(a(0))}` : `\\log${call(a(0))}`;
    case 'transpose': return `{${a(0)}}^{\\mathrm{T}}`;
    case 'inv': return `{${a(0)}}^{-1}`;
    case 'cross': return `${a(0)}\\times ${a(1)}`;
    case 'factorial': return `${a(0)}!`;
    case 'gamma': return `\\Gamma${call(a(0))}`;
    case 'conj': return `\\overline{${a(0)}}`;
    case 'if': if (args.length === 3) return `\\begin{cases} ${a(1)} & \\text{if } ${a(0)} \\\\ ${a(2)} & \\text{otherwise} \\end{cases}`; break;
    case 'integral': case 'defint':
      if (args.length === 4) {
        const [f, v, lo, hi] = name === 'defint' ? [0, 3, 1, 2] : [0, 1, 2, 3];
        return `\\int_{${a(lo)}}^{${a(hi)}} ${a(f)}\\,\\mathrm{d}${a(v)}`;
      }
      break;
    case 'integrate':
      if (args.length === 2) return `\\int ${a(0)}\\,\\mathrm{d}${a(1)}`;
      break;
    case 'sum': case 'prod': case 'product': {
      const op = name === 'sum' ? '\\sum' : '\\prod';
      if (args.length === 4 && isVar(1)) return `${op}_{${a(1)}=${a(2)}}^{${a(3)}} ${wrapSum(args[0])}`;
      if (args.length === 2 && isVar(1)) return `${op}_{${a(1)}} ${wrapSum(args[0])}`;
      if (args.length === 1) return `${op} ${a(0)}`;
      break;
    }
    case 'diff': case 'deriv':
      if (args.length >= 2) {
        const ord = args.length === 3 ? a(2) : '';
        const d = ord ? `\\frac{\\mathrm{d}^{${ord}}}{\\mathrm{d}${a(1)}^{${ord}}}` : `\\frac{\\mathrm{d}}{\\mathrm{d}${a(1)}}`;
        return `${d} ${wrapSum(args[0])}`;
      }
      break;
    case 'limit':
      if (args.length >= 3) return `\\lim_{${a(1)}\\to ${a(2)}} ${wrapSum(args[0])}`;
      break;
    case 'laplace': return `\\mathcal{L}\\left\\{${a(0)}\\right\\}`;
    case 'ilt': return `\\mathcal{L}^{-1}\\left\\{${a(0)}\\right\\}`;
  }
  if (ALIAS[name]) return `${ALIAS[name]}${call(argList(args))}`;
  if (TRIG.has(name)) return `\\${name}${call(argList(args))}`;
  if (name in math || name.length > 1) return `\\mathrm{${name.replace(/_/g, '\\_')}}${call(argList(args))}`;
  return `${nameTex(name)}${call(argList(args))}`;
}

function wrapSum(n: MathNode): string {
  const s = t(n);
  const any = n as AnyNode;
  return any.type === 'OperatorNode' && (any.fn === 'add' || any.fn === 'subtract') ? `\\left(${s}\\right)` : s;
}

const TEX_OPTIONS = { handler, implicit: 'hide' as const, parenthesis: 'keep' as const };

/** Pretty TeX of an expression string; falls back to monospace text if it does not parse. */
export function exprTex(src: string): string {
  const range = safeRange(src);
  if (range) {
    const parts = [exprTex(range.first)];
    if (range.second) parts.push(exprTex(range.second));
    return `${parts.join(',\\,')}\\,..\\,${exprTex(range.last)}`;
  }
  try {
    return t(parseExpr(src));
  } catch {
    return `\\texttt{${escapeText(src)}}`;
  }
}

function safeRange(src: string) {
  try {
    return parseRange(src);
  } catch {
    return null;
  }
}

export function lhsTex(lhs: Lhs): string {
  switch (lhs.kind) {
    case 'var': return nameTex(lhs.name);
    case 'func': return `${nameTex(lhs.name)}${call(lhs.params.map(nameTex).join(','))}`;
    case 'index': return `{${nameTex(lhs.name)}}_{${lhs.indices.map(exprTex).join(',')}}`;
    case 'destructure': return `\\begin{bmatrix} ${lhs.names.map(nameTex).join(' \\\\ ')} \\end{bmatrix}`;
  }
}

/** Mathcad programming block: vertical bar with nested statements. */
export function programTex(body: string[]): string {
  type Line = { indent: number; text: string };
  const lines: Line[] = body.map((l) => {
    const m = /^(\s*)(.*)$/.exec(l.replace(/\t/g, '    '))!;
    return { indent: m[1].length, text: m[2].trim() };
  });
  let pos = 0;
  const block = (indent: number): string => {
    const rows: string[] = [];
    while (pos < lines.length && lines[pos].indent >= indent) {
      const ln = lines[pos++];
      let row = programLineTex(ln.text);
      if (pos < lines.length && lines[pos].indent > ln.indent) {
        row += ' \\\\ \\quad ' + block(lines[pos].indent);
      }
      rows.push(row);
    }
    return `\\left|\\begin{array}{l} ${rows.join(' \\\\ ')} \\end{array}\\right.`;
  };
  return block(lines.length ? lines[0].indent : 0);
}

function programLineTex(text: string): string {
  const kw = (k: string) => `\\textbf{${k}}\\ `;
  let m: RegExpExecArray | null;
  if ((m = /^(?:else\s+if|elif)\s+(.+?):?$/.exec(text))) return kw('else if') + exprTex(m[1]);
  if ((m = /^if\s+(.+?):?$/.exec(text))) return kw('if') + exprTex(m[1]);
  if (/^(else|otherwise):?$/.test(text)) return kw('else');
  if ((m = /^for\s+(\S+)\s+(?:in|∈)\s+(.+?):?$/.exec(text))) return `${kw('for')}${nameTex(m[1])} \\in ${exprTex(m[2])}`;
  if ((m = /^while\s+(.+?):?$/.exec(text))) return kw('while') + exprTex(m[1]);
  if ((m = /^return\s+(.+)$/.exec(text))) return kw('return') + exprTex(m[1]);
  if (/^(break|continue)$/.test(text)) return `\\textbf{${text}}`;
  if ((m = /^try:?$/.exec(text))) return kw('try');
  if ((m = /^on\s*error:?$/.exec(text))) return kw('on error');
  const arrow = /←|<-/.exec(text);
  if (arrow) {
    const lhs = text.slice(0, arrow.index).trim();
    const rhs = text.slice(arrow.index + arrow[0].length).trim();
    let l: string;
    try {
      l = /\[/.test(lhs) ? exprTex(lhs) : lhs.startsWith('[') ? exprTex(lhs) : nameTex(lhs);
    } catch {
      l = escapeText(lhs);
    }
    return `${l} \\leftarrow ${exprTex(rhs)}`;
  }
  return exprTex(text);
}

/** Split "kw1, arg ; kw2" style keyword lists for the → operator. */
export function keywordsTex(keywords: string): string {
  if (!keywords) return '';
  return splitTop(keywords, ',').map((k) => `\\mathrm{${escapeText(k.trim())}}`).join(',');
}
