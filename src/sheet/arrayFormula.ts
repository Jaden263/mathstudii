// Which formulas a file must hold as array formulas. This engine calculates every formula as
// Excel 365 does: =SUM(A1:A3*B1:B3) multiplies element by element. Older Excel, LibreOffice,
// and Excel 365 reading a plain formula from a file apply implicit intersection where a range
// meets an operator or a function that takes one value (that formula gives A1*B1, or
// #VALUE!), so such formulas are written as one-cell array formulas, {=SUM(A1:A3*B1:B3)},
// which every version calculates the same way.
import './functions';
import { LIFTED } from './evaluate';
import { parseFormula, type Node } from './formula';

/** Functions whose result is an array whatever their arguments. */
const ALWAYS = new Set(['TRANSPOSE', 'MMULT', 'MINVERSE', 'SEQUENCE', 'LINEST']);
/** Functions that give a range or an array when an argument is one (INDEX(A1:C3, 0, 2), IF(A1:A3 > 0, …)). */
const FOLLOW = new Set(['INDEX', 'OFFSET', 'INDIRECT', 'XLOOKUP', 'ROW', 'COLUMN', 'CHOOSE', 'IF', 'IFERROR', 'IFNA', 'IFS', 'SWITCH']);

/**
 * Does the formula need array evaluation? `multiName` says whether a defined name may stand
 * for more than one cell (by default every name may).
 */
export function needsArrayFormula(src: string, multiName: (name: string) => boolean = () => true): boolean {
  let node: Node;
  try {
    node = parseFormula(src.replace(/^=/, ''));
  } catch {
    return false;
  }
  // can this part give more than one value?
  const multi = (n: Node): boolean => {
    switch (n.t) {
      case 'ref': {
        const a = n.ref.area;
        return !!n.ref.whole || n.ref.sheet2 !== undefined || a.r1 !== a.r2 || a.c1 !== a.c2;
      }
      case 'name': return multiName(n.name);
      case 'arr': return n.rows.length > 1 || (n.rows[0]?.length ?? 0) > 1;
      case 'bin': return n.op === ':' || multi(n.a) || multi(n.b);
      case 'un': case 'pct': return multi(n.a);
      case 'fn': return ALWAYS.has(n.name) || ((LIFTED.has(n.name) || FOLLOW.has(n.name)) && n.args.some(multi));
      default: return false;
    }
  };
  // is a range or array taken where one value is expected?
  const needs = (n: Node): boolean => {
    switch (n.t) {
      case 'bin':
        if (n.op === ':' || n.op === ' ') return needs(n.a) || needs(n.b);
        return multi(n.a) || multi(n.b) || needs(n.a) || needs(n.b);
      case 'un': case 'pct': return multi(n.a) || needs(n.a);
      case 'fn': return ((LIFTED.has(n.name) || n.name === 'IF' || n.name === 'IFERROR' || n.name === 'IFNA') && n.args.some(multi)) || n.args.some(needs);
      default: return false;
    }
  };
  return needs(node);
}
