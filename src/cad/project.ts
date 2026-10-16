// Polylines that are really circles: the mesh kernel's sections and outlines come as
// polygons, and a hole or a shaft should come back into a sketch as a circle.
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
