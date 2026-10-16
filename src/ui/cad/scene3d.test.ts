import { describe, expect, it } from 'vitest';
import type { Mesh } from '../../cad/mesh';
import type { DisplayMesh } from '../../cad/display';
import { STANDARD_VIEWS } from './Cad3DView';
import { cameraRay, pickScene, raySegment, rayTriangle, sceneBounds, worldToScreen, type SceneView, type Vec3 } from './Scene3D';

const close = (a: number[], b: number[], digits = 9) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], digits));
const bounds = { min: [-1, -2, -3] as Vec3, max: [3, 2, 1] as Vec3 }; // centre (1, 0, −1)
const view = (v: { yaw: number; pitch: number }, zoom = 1, pan = { x: 0, y: 0 }): SceneView => ({ ...v, zoom, pan });

/** Axis-aligned box, counter-clockwise from outside, as the CAD meshes are. */
function box(min: Vec3, max: Vec3): Mesh {
  const c = (i: number): Vec3 => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const pos: number[] = [];
  for (const [a, b, cc, d] of quads) for (const i of [a, b, cc, a, cc, d]) pos.push(...c(i));
  return { positions: new Float32Array(pos), normals: new Float32Array(pos.length), edges: new Float32Array(0), bounds: { min, max } };
}

describe('cameraRay', () => {
  // the modeller is Z up: front looks along +Y, top down −Z, right along −X
  it('looks along +Y through the centre in the front view', () => {
    const r = cameraRay(view(STANDARD_VIEWS.front), bounds, 400, 300, 200, 150);
    close(r.dir, [0, 1, 0]);
    close([r.origin[0], r.origin[2]], [1, -1]); // through the centre of the bounds
    expect(r.origin[1]).toBeLessThan(bounds.min[1]); // starts in front of the scene
  });

  it('looks along −Z in the top view, along −X in the right view', () => {
    const t = cameraRay(view(STANDARD_VIEWS.top), bounds, 400, 300, 200, 150);
    close(t.dir, [0, 0, -1]);
    close([t.origin[0], t.origin[1]], [1, 0]);
    close(cameraRay(view(STANDARD_VIEWS.right), bounds, 400, 300, 200, 150).dir, [-1, 0, 0]);
    close(cameraRay(view(STANDARD_VIEWS.iso), bounds, 400, 300, 200, 150).dir, [-1, 1, -1].map((x) => x / Math.sqrt(3)));
  });

  it('maps pixel offsets to world offsets consistently with zoom and pan', () => {
    const r = Math.hypot(4, 4, 4) / 2; // framing sphere radius
    const v = view(STANDARD_VIEWS.front, 2, { x: 0.1, y: -0.2 });
    // 400×300: half the shorter side is 150 px; screen units = zoom · (0.92 q / r + pan)
    const a = cameraRay(v, bounds, 400, 300, 200 + 60, 150 - 30);
    const ux = 60 / 150, uy = 30 / 150;
    close([a.origin[0], a.origin[2]], [1 + (ux / 2 - 0.1) * (r / 0.92), -1 + (uy / 2 + 0.2) * (r / 0.92)]);
    // twice the zoom halves the world step per pixel
    const b0 = cameraRay(view(STANDARD_VIEWS.front, 1), bounds, 400, 300, 200, 150);
    const b1 = cameraRay(view(STANDARD_VIEWS.front, 1), bounds, 400, 300, 230, 150);
    const c0 = cameraRay(view(STANDARD_VIEWS.front, 2), bounds, 400, 300, 200, 150);
    const c1 = cameraRay(view(STANDARD_VIEWS.front, 2), bounds, 400, 300, 230, 150);
    expect(c1.origin[0] - c0.origin[0]).toBeCloseTo((b1.origin[0] - b0.origin[0]) / 2, 12);
  });

  it('is the inverse of worldToScreen in any view', () => {
    for (const v of [view({ yaw: 33, pitch: -20 }, 1.7, { x: 0.2, y: 0.05 }), view(STANDARD_VIEWS.iso, 0.4), view(STANDARD_VIEWS.bottom, 3, { x: -0.3, y: 0.3 })]) {
      const ray = cameraRay(v, bounds, 640, 360, 123, 301);
      for (const t of [0, 1.5, 7]) {
        const p: Vec3 = [0, 1, 2].map((k) => ray.origin[k] + t * ray.dir[k]) as Vec3;
        close(worldToScreen(v, bounds, 640, 360, p), [123, 301], 7);
      }
    }
  });
});

describe('rayTriangle', () => {
  const a: Vec3 = [0, 0, 0], b: Vec3 = [1, 0, 0], c: Vec3 = [0, 1, 0];
  it('hits from either side and returns the ray parameter', () => {
    expect(rayTriangle([0.2, 0.2, 5], [0, 0, -1], a, b, c)).toBeCloseTo(5, 12);
    expect(rayTriangle([0.2, 0.2, -2], [0, 0, 2], a, b, c)).toBeCloseTo(1, 12);
  });
  it('misses outside the triangle and behind the origin', () => {
    expect(rayTriangle([0.8, 0.8, 5], [0, 0, -1], a, b, c)).toBeNull();
    expect(rayTriangle([-0.1, 0.2, 5], [0, 0, -1], a, b, c)).toBeNull();
    expect(rayTriangle([0.2, 0.2, 5], [0, 0, 1], a, b, c)).toBeNull();
  });
  it('rejects parallel rays and degenerate triangles', () => {
    expect(rayTriangle([0.2, 0.2, 0], [1, 0, 0], a, b, c)).toBeNull();
    expect(rayTriangle([0.2, 0.2, 1], [1, 1, 0], a, b, c)).toBeNull();
    expect(rayTriangle([0.5, 0, 1], [0, 0, -1], a, b, [2, 0, 0])).toBeNull();
  });
});

describe('pickScene', () => {
  const cube = box([-1, -1, -1], [1, 1, 1]);
  it('returns the nearest face with its outward world normal, through the mesh matrix', () => {
    // rotate 90° about Y (x → −z, z → x), then move by (5, 0, 0)
    const m = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 5, 0, 0, 1];
    const meshes = [{ key: 'a', mesh: cube, color: [1, 0, 0] as Vec3 }, { key: 'b', mesh: cube, color: [0, 1, 0] as Vec3, matrix: m }];
    const hb = sceneBounds(meshes)!;
    close(hb.min, [-1, -1, -1]);
    close(hb.max, [6, 1, 1]);
    const front = pickScene({ origin: [5.3, 0.2, 10], dir: [0, 0, -1] }, meshes);
    expect(front.kind).toBe('mesh');
    expect(front.key).toBe('b');
    close(front.point!, [5.3, 0.2, 1]);
    close(front.normal!, [0, 0, 1]);
    const top = pickScene({ origin: [0.1, 10, 0.1], dir: [0, -1, 0] }, meshes);
    expect(top.key).toBe('a');
    close(top.normal!, [0, 1, 0]);
    expect(top.triangle).toBeGreaterThanOrEqual(0);
    expect(pickScene({ origin: [3, 0, 10], dir: [0, 0, -1] }, meshes)).toEqual({ kind: 'none' });
  });

  it('picks a plane only when no body is nearer', () => {
    const meshes = [{ key: 'a', mesh: cube, color: [1, 0, 0] as Vec3 }];
    const planes = [
      { key: 'XY', origin: [0, 0, 0] as Vec3, u: [1, 0, 0] as Vec3, v: [0, 1, 0] as Vec3, size: 3, color: [0, 0, 1] as Vec3 },
      { key: 'front', origin: [0, 0, 2] as Vec3, u: [1, 0, 0] as Vec3, v: [0, 1, 0] as Vec3, size: 0.5, color: [0, 0, 1] as Vec3 },
    ];
    // XY plane runs through the cube: hidden behind its front face
    expect(pickScene({ origin: [0, 0, 10], dir: [0, 0, -1] }, meshes, planes.slice(0, 1)).kind).toBe('mesh');
    // beside the cube the plane is hit
    const side = pickScene({ origin: [2, 2, 10], dir: [0, 0, -1] }, meshes, planes);
    expect(side).toMatchObject({ kind: 'plane', key: 'XY' });
    close(side.point!, [2, 2, 0]);
    close(side.normal!, [0, 0, 1]);
    // a plane in front of the cube wins
    expect(pickScene({ origin: [0.2, 0.2, 10], dir: [0, 0, -1] }, meshes, planes).key).toBe('front');
    // outside the square: not hit
    expect(pickScene({ origin: [3.5, 0, 10], dir: [0, 0, -1] }, meshes, planes).kind).toBe('none');
  });
});

/**
 * A unit cube as a display mesh: one face per side (triangles in face runs), its twelve
 * edges as segments, the edge along +X at y = z = 1 being edge 0.
 */
function cubeDisplay(): DisplayMesh {
  const c = (i: number): Vec3 => [i & 1 ? 1 : 0, i & 2 ? 1 : 0, i & 4 ? 1 : 0];
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const positions = new Float32Array(Array.from({ length: 8 }, (_, i) => c(i)).flat());
  const indices = new Uint32Array(quads.flatMap(([a, b, cc, d]) => [a, b, cc, a, cc, d]));
  const edges: [number, number][] = [[6, 7], [0, 1], [2, 3], [4, 5], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  return {
    positions, normals: new Float32Array(24), indices,
    faceStart: new Uint32Array([0, 2, 4, 6, 8, 10, 12]), faceOf: new Uint32Array([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]),
    lines: new Float32Array(edges.flatMap(([a, b]) => [...c(a), ...c(b)])), edgeStart: new Uint32Array(edges.map((_, i) => i).concat(12)),
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  };
}

describe('picking faces and edges of display meshes', () => {
  const sm = { key: 'b:o1:f1', mesh: cubeDisplay(), color: [1, 1, 1] as Vec3 };
  // looking down −Z onto the top face (z = 1, face 1)
  const down = (x: number, y: number) => ({ origin: [x, y, 5] as Vec3, dir: [0, 0, -1] as Vec3 });

  it('names the face of the triangle hit', () => {
    const hit = pickScene(down(0.3, 0.4), [sm], [], 0.02);
    expect(hit.face).toBe(1);
    expect(hit.edge).toBeUndefined();
    expect(hit.point![2]).toBeCloseTo(1, 6);
  });

  it('an edge within the tolerance wins over the face, one further out does not', () => {
    // 0.01 from the top edge at y = 1 (edge 0), seen from above
    const near = pickScene(down(0.5, 0.99), [sm], [], 0.02);
    expect(near.edge).toBe(0);
    expect(near.face).toBe(1);
    expect(pickScene(down(0.5, 0.95), [sm], [], 0.02).edge).toBeUndefined();
    // without a tolerance edges are not picked at all
    expect(pickScene(down(0.5, 0.99), [sm]).edge).toBeUndefined();
  });

  it('an edge behind the face hit is not picked', () => {
    // the bottom edge under y = 1 (edge 2, z = 0) lies right under the ray, behind the top face
    const hit = pickScene(down(0.5, 1.005), [sm], [], 0.02);
    // the top edge (z = 1) is the nearer of the two within reach
    expect(hit.edge).toBe(0);
    const side = pickScene({ origin: [0.5, 5, 0.995], dir: [0, -1, 0] }, [sm], [], 0.02);
    // along −Y just under the top: the far edge at y = 0 hides behind the face at y = 1
    expect(side.face).toBe(3);
    expect(side.edge).toBe(0);
  });

  it('closest approach of a ray and a segment', () => {
    // ray along −Z through (0.5, 0.2); segment along X at y = 0, z = 0: 0.2 apart, 5 along
    const r = raySegment([0.5, 0.2, 5], [0, 0, -1], [0, 0, 0, 1, 0, 0], 0);
    expect(r!.dist).toBeCloseTo(0.2, 12);
    expect(r!.t).toBeCloseTo(5, 12);
    // past the segment's end: the distance to the end point
    expect(raySegment([2, 0, 5], [0, 0, -1], [0, 0, 0, 1, 0, 0], 0)!.dist).toBeCloseTo(1, 12);
  });
});
