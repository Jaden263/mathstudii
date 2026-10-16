// Section outlines: the curves a plane cuts from a solid come back as separate pieces
// (one per B-rep edge); joined end to end they make the closed loops a sketch can
// project.
import type { Vec2 } from './profile';

/**
 * Polylines joined into chains wherever their ends meet within `tol` (either way round).
 * A chain that closes on itself becomes a loop without its repeated end point; chains
 * that stay open are returned as they are.
 */
export function chainLoops(pieces: Vec2[][], tol: number): Vec2[][] {
  const left = pieces.filter((p) => p.length >= 2).map((p) => [...p]);
  const near = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;
  const out: Vec2[][] = [];
  while (left.length) {
    const chain = left.pop()!;
    for (let grown = true; grown && !near(chain[0], chain[chain.length - 1]);) {
      grown = false;
      for (let i = 0; i < left.length; i++) {
        const p = left[i], head = chain[0], tail = chain[chain.length - 1];
        if (near(tail, p[0])) chain.push(...p.slice(1));
        else if (near(tail, p[p.length - 1])) chain.push(...p.slice(0, -1).reverse());
        else if (near(head, p[p.length - 1])) chain.unshift(...p.slice(0, -1));
        else if (near(head, p[0])) chain.unshift(...p.slice(1).reverse());
        else continue;
        left.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (chain.length > 2 && near(chain[0], chain[chain.length - 1])) chain.pop();
    out.push(chain);
  }
  return out;
}
