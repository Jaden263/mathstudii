import { describe, it, expect } from 'vitest';
import { insidePolygon, polygonArea, triangulateDomain, type Pt } from './cdt';
import { meshPlate, nodesOnSegment, type PlateMesh } from './mesh';

const area = (m: PlateMesh) => {
  let s = 0;
  for (let e = 0; e < m.quads.length / 4; e++) {
    const p: Pt[] = [0, 1, 2, 3].map((k) => [m.x[m.quads[4 * e + k]], m.y[m.quads[4 * e + k]]]);
    const a = polygonArea(p);
    expect(a).toBeGreaterThan(0);
    s += a;
  }
  return s;
};

function triAngles(x: number[], y: number[], tris: number[]) {
  let min = 180;
  for (let t = 0; t < tris.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const p = tris[t + k], a = tris[t + ((k + 1) % 3)], b = tris[t + ((k + 2) % 3)];
      const ux = x[a] - x[p], uy = y[a] - y[p], vx = x[b] - x[p], vy = y[b] - y[p];
      min = Math.min(min, (Math.acos((ux * vx + uy * vy) / Math.hypot(ux, uy) / Math.hypot(vx, vy)) * 180) / Math.PI);
    }
  }
  return min;
}

describe('constrained Delaunay triangulation', () => {
  const outline: Pt[] = [[0, 0], [6, 0], [6, 4.5], [0, 4.5]];
  const hole: Pt[] = [[2, 1.5], [3, 1.5], [3, 2.5], [2, 2.5]];
  const wall: [Pt, Pt] = [[4, 0.5], [5.5, 4]];

  it('fills the domain with well-shaped triangles no larger than asked, along every constraint', () => {
    const m = triangulateDomain({ outline, openings: [hole], lines: [wall], points: [[1, 1]], size: 0.4 });
    let A = 0, lmax = 0;
    for (let t = 0; t < m.tris.length; t += 3) {
      const p = [0, 1, 2].map((k) => [m.x[m.tris[t + k]], m.y[m.tris[t + k]]] as Pt);
      A += polygonArea(p);
      for (let k = 0; k < 3; k++) lmax = Math.max(lmax, Math.hypot(p[k][0] - p[(k + 1) % 3][0], p[k][1] - p[(k + 1) % 3][1]));
      // nothing inside the opening
      const c: Pt = [(p[0][0] + p[1][0] + p[2][0]) / 3, (p[0][1] + p[1][1] + p[2][1]) / 3];
      expect(insidePolygon(c[0], c[1], hole)).toBe(false);
    }
    expect(A).toBeCloseTo(27 - 1, 9);
    expect(lmax).toBeLessThanOrEqual(0.4 * 1.0001);
    // Ruppert's refinement aims at 25°; away from sharp input angles it gets there
    expect(triAngles(m.x, m.y, m.tris)).toBeGreaterThan(25);
    // the wall is a chain of edges from end to end, and the point is a vertex
    const onWall = m.x.map((_, i) => i).filter((i) => {
      const t = ((m.x[i] - 4) * 1.5 + (m.y[i] - 0.5) * 3.5) / (1.5 ** 2 + 3.5 ** 2);
      return Math.abs((m.x[i] - 4) * 3.5 - (m.y[i] - 0.5) * 1.5) < 1e-9 && t > -1e-9 && t < 1 + 1e-9;
    });
    onWall.sort((a, b) => m.y[a] - m.y[b]);
    for (let i = 0; i + 1 < onWall.length; i++) expect(m.constrained.has(`${Math.min(onWall[i], onWall[i + 1])},${Math.max(onWall[i], onWall[i + 1])}`)).toBe(true);
    expect(m.x.some((x, i) => Math.hypot(x - 1, m.y[i] - 1) < 1e-12)).toBe(true);
  });

  it('copes with a sharp input angle (a 10° wedge) without running away', () => {
    const wedge: Pt[] = [[0, 0], [5, 0], [5 * Math.cos(0.1745), 5 * Math.sin(0.1745)]];
    const m = triangulateDomain({ outline: wedge, openings: [], lines: [], points: [], size: 0.5 });
    expect(m.x.length).toBeLessThan(2000);
    let A = 0;
    for (let t = 0; t < m.tris.length; t += 3) A += polygonArea([0, 1, 2].map((k) => [m.x[m.tris[t + k]], m.y[m.tris[t + k]]] as Pt));
    expect(A).toBeCloseTo(polygonArea(wedge), 9);
  });

  it('a wall crossing an edge at a shallow angle (3°) leaves a sharp corner, not a cloud of slivers', () => {
    // the crossing points are corners of the domain like the input ones: without the
    // concentric shells and Shewchuk's rule there, refinement piled ~70 points within 1e-6 m
    for (const [openings, wall] of [
      [[hole], [[2.95, 1.0], [3.05, 3.0]]],
      [[], [[5.95, 1.0], [6.05, 3.0]]],
    ] as [Pt[][], [Pt, Pt]][]) {
      const m = triangulateDomain({ outline, openings, lines: [wall], points: [], size: 0.4 });
      // ~450 points without the wall; the graded wedge adds about a hundred (1150 before)
      expect(m.x.length).toBeLessThan(650);
      let A = 0, smallest = Infinity;
      for (let t = 0; t < m.tris.length; t += 3) {
        const a = polygonArea([0, 1, 2].map((k) => [m.x[m.tris[t + k]], m.y[m.tris[t + k]]] as Pt));
        A += a;
        smallest = Math.min(smallest, a);
      }
      expect(A).toBeCloseTo(27 - (openings.length ? 1 : 0), 9);
      // the smallest is the corner's own thin triangle (4e-5 m²), not a 1e-13 m² sliver
      expect(smallest).toBeGreaterThan(1e-5);
      const quads = meshPlate({ outline, openings, lines: [wall], points: [], softLines: [], softPoints: [], size: 0.25 });
      expect(area(quads)).toBeCloseTo(27 - (openings.length ? 1 : 0), 9);
    }
  });

  it('meets crossing and touching constraints where they meet', () => {
    const m = triangulateDomain({ outline, openings: [], lines: [[[1, 1], [5, 3]], [[1, 3], [5, 1]], [[3, 0], [3, 2]]], points: [], size: 0.6 });
    // the two diagonals cross at (3, 2), where the third line ends
    expect(m.x.some((x, i) => Math.hypot(x - 3, m.y[i] - 2) < 1e-9)).toBe(true);
  });
});

describe('plate meshes', () => {
  it('a rectangle gets a grid with lines through openings, walls and columns', () => {
    const m = meshPlate({
      outline: [[0, 0], [6, 0], [6, 4.5], [0, 4.5]], openings: [[[4, 1], [5.2, 1], [5.2, 2], [4, 2]]],
      lines: [[[3, 0], [3, 4.5]]], points: [[1.55, 2.25]], softLines: [], softPoints: [], size: 0.5,
    });
    expect(m.structured).toBe(true);
    expect(m.minAngle).toBeCloseTo(90, 9);
    expect(area(m)).toBeCloseTo(27 - 1.2, 9);
    expect(m.x.some((x, i) => x === 1.55 && m.y[i] === 2.25)).toBe(true);
    expect(nodesOnSegment(m, [3, 0], [3, 4.5], 1e-9).length).toBeGreaterThan(9);
  });

  it('any other outline: triangles split into well-shaped quads of about the size asked', () => {
    const L: Pt[] = [[0, 0], [8, 0], [8, 3], [3, 3], [3, 6], [0, 6]];
    const h = 0.3;
    const m = meshPlate({ outline: L, openings: [[[1, 1], [2, 1], [1.5, 2]]], lines: [], points: [], softLines: [], softPoints: [], size: h });
    expect(m.structured).toBe(false);
    const A = 8 * 3 + 3 * 3 - 0.5;
    expect(area(m)).toBeCloseTo(A, 6);
    // mean side h (±15 %), every quad convex with corners between 30° and 150°
    expect(Math.sqrt(A / (m.quads.length / 4))).toBeGreaterThan(0.8 * h);
    expect(Math.sqrt(A / (m.quads.length / 4))).toBeLessThan(1.15 * h);
    expect(m.minAngle).toBeGreaterThan(30);
    expect(m.maxAngle).toBeLessThan(150);
  });

  it('a polygon standing for a circle has its boundary nodes on the circle', () => {
    const n = 48, r = 2;
    const circle: Pt[] = Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)]);
    const m = meshPlate({ outline: circle, openings: [], lines: [], points: [], softLines: [], softPoints: [], size: 0.1 });
    let moved = 0;
    for (let i = 0; i < m.x.length; i++) {
      if (Number.isNaN(m.chord![2 * i])) continue;
      moved++;
      // the cubic between two vertices stays within 1e-5 r of the circle, its tangent ⊥ the radius
      expect(Math.abs(Math.hypot(m.x[i], m.y[i]) - r)).toBeLessThan(1e-5 * r);
      expect(Math.abs(m.tangent![2 * i] * m.x[i] + m.tangent![2 * i + 1] * m.y[i]) / r).toBeLessThan(1e-4);
    }
    expect(moved).toBeGreaterThan(n);
    // an octagon is a polygon: its corners turn by 45°, nothing moves
    const oct = meshPlate({ outline: circle.filter((_, i) => i % 6 === 0), openings: [], lines: [], points: [], softLines: [], softPoints: [], size: 0.2 });
    expect(oct.chord).toBeUndefined();
  });
});
