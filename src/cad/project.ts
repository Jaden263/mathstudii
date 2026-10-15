// Project: turn the outline of existing bodies in a sketch plane into sketch geometry,
// fixed in place, so new profiles can start from the edges of the part. Outlines that
// are circles (holes, shafts) come back as circles; everything else as line chains.
import { cadId, type CadConstraint, type CadEntity, type CadPoint, type CadSketch } from './model';
import type { Vec2 } from './profile';

/** Centre and radius when the loop's vertices lie on one circle. */
export function fitCircle(loop: Vec2[]): { c: Vec2; r: number } | null {
  if (loop.length < 12) return null;
  let x = 0, y = 0;
  for (const p of loop) { x += p.x; y += p.y; }
  const c = { x: x / loop.length, y: y / loop.length };
  const d = loop.map((p) => Math.hypot(p.x - c.x, p.y - c.y));
  const r = d.reduce((a, b) => a + b, 0) / d.length;
  return r > 0 && d.every((q) => Math.abs(q - r) < 2e-3 * r) ? { c, r } : null;
}

export function projectLoops(sk: CadSketch, loops: Vec2[][]): { sketch: CadSketch; ids: string[] } {
  const points: CadPoint[] = [], entities: CadEntity[] = [], constraints: CadConstraint[] = [];
  const fix = (p: CadPoint) => constraints.push({ id: cadId('k'), type: 'fix', refs: [p.id], at: { x: p.x, y: p.y } });
  for (const loop of loops) {
    const circ = fitCircle(loop);
    if (circ) {
      const c: CadPoint = { id: cadId('p'), x: circ.c.x, y: circ.c.y };
      points.push(c);
      fix(c);
      const id = cadId('e');
      entities.push({ id, type: 'circle', c: c.id, r: circ.r });
      constraints.push({ id: cadId('k'), type: 'radius', refs: [id], value: String(+circ.r.toPrecision(9)) });
      continue;
    }
    if (loop.length < 2) continue;
    const ps = loop.map((q) => ({ id: cadId('p'), x: q.x, y: q.y }));
    ps.forEach((p) => { points.push(p); fix(p); });
    ps.forEach((p, i) => entities.push({ id: cadId('e'), type: 'line', p1: p.id, p2: ps[(i + 1) % ps.length].id }));
  }
  return {
    sketch: { points: [...sk.points, ...points], entities: [...sk.entities, ...entities], constraints: [...sk.constraints, ...constraints] },
    ids: entities.map((e) => e.id),
  };
}
