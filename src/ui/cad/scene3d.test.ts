import { describe, expect, it } from 'vitest';
import type { Mesh } from '../../cad/mesh';
import { STANDARD_VIEWS } from './Cad3DView';
import { cameraRay, pickScene, rayTriangle, sceneBounds, worldToScreen, type SceneView, type Vec3 } from './Scene3D';

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
