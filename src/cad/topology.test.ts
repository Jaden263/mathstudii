// Persistent names and references, without a kernel: unique names for repeated history
// keys, the families that find split and merged entities again, the geometric fallback
// that only finds what has not moved, and sketch planes moved onto their faces.
import { describe, expect, it } from 'vitest';
import type { EdgeInfo, FaceInfo, VertexInfo } from './buildResult';
import {
  baseName, faceAnchor, faceFrame, faceName, faceWords, refTo, resolveRef, sameFamily, uniqueNames, vertexKey,
  type BodyTopology, type EdgeFacts, type TopoRef,
} from './topology';
import { snapPlace, snapsOn } from './snaps';
import type { Frame, Vec3 } from './solid';

const plane = (index: number, key: string, c: Vec3, n: Vec3, area = 100): FaceInfo => ({
  index, key, feature: key.split('/')[0], type: 'plane', area, c, frame: { o: c, u: Math.abs(n[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1], v: [0, 1, 0], n },
});
const line = (index: number, key: string, a: Vec3, b: Vec3, faces: [number, number], v: [number, number] = [-1, -1]): EdgeFacts => ({
  index, key, type: 'line', length: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), line: { a, b }, faces, v,
  mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
});
/** A body of the faces and edges in this order (their indices follow it). */
const body = (id: string, faces: FaceInfo[], edges: EdgeFacts[] = [], vertices: VertexInfo[] = []): BodyTopology => ({
  id, faces: faces.map((f, index) => ({ ...f, index })), edges: edges.map((e, index) => ({ ...e, index })), vertices, box: { min: [0, 0, 0], max: [100, 60, 10] }, named: true,
});
const tidy = (v: Vec3) => v.map((x) => x + 0);

describe('names', () => {
  it('a repeated base gets #1, #2 … by place, a single one stays', () => {
    // two pieces of a top face split by a slot, listed right piece first
    const place = [[80, 30], [20, 30], [50, 5]];
    expect(uniqueNames(['f1/end', 'f1/end', 'f1/side:l0'], (i) => place[i], '#', 1e-9)).toEqual(['f1/end#2', 'f1/end#1', 'f1/side:l0']);
    // equal u within the tolerance: v decides
    expect(uniqueNames(['a', 'a'], (i) => [[1e-12, 9], [0, 2]][i], '#', 1e-9)).toEqual(['a#2', 'a#1']);
  });

  it('merged faces list their keys sorted; vertices their faces, else their edges', () => {
    expect(faceName(['f4/end', 'f1/end', 'f4/end'])).toBe('f1/end+f4/end');
    expect(faceName([])).toBe('?');
    expect(vertexKey(['f1/side:l1', 'f1/end', 'f1/side:l0'], [])).toBe('f1/end|f1/side:l0|f1/side:l1');
    // a vertex on a circle's seam: two faces, so its edges name it
    expect(vertexKey(['f1/end', 'f1/side:k0', 'f1/side:k0'], ['f1/side:k0|f1/side:k0', 'f1/end|f1/side:k0'])).toBe('f1/end|f1/side:k0&f1/side:k0|f1/side:k0');
    expect(baseName('f1/end#2|f1/side:l0~3')).toBe('f1/end|f1/side:l0');
  });

  it('families: split pieces, merges, edges either way round, vertices', () => {
    expect(sameFamily('face', 'f1/end', 'f1/end#2')).toBe(true);
    expect(sameFamily('face', 'f1/end', 'f1/end+f4/end')).toBe(true);
    expect(sameFamily('face', 'f1/end+f4/end', 'f4/end')).toBe(true);
    expect(sameFamily('face', 'f1/end', 'f1/start')).toBe(false);
    expect(sameFamily('edge', 'f1/end|f1/side:l0', 'f1/end#1|f1/side:l0~2')).toBe(true);
    expect(sameFamily('edge', 'f1/end|f1/side:l0', 'f1/side:l0|f1/start')).toBe(false);
    // one face of the pair the same is not the same edge
    expect(sameFamily('edge', 'f1/end|f1/side:l0', 'f1/end|f1/side:l1')).toBe(false);
    expect(sameFamily('vertex', 'f1/end|f1/side:l0|f1/side:l3', 'f1/end#1|f1/side:l0|f1/side:l3')).toBe(true);
    expect(sameFamily('vertex', 'f1/end|f1/side:l0|f1/side:l3', 'f1/end|f1/side:l0|f1/side:l1')).toBe(false);
  });

  it('words for a face', () => {
    const name = (id: string) => ({ f1: 'Extrude1', f2: 'Hole1', f3: 'Pattern1' })[id];
    expect(faceWords('f1/end', name)).toBe('the end face of Extrude1');
    expect(faceWords('f1/end#2', name)).toBe('the end face of Extrude1');
    expect(faceWords('f2/hole1:wall', name)).toBe('the wall of hole 2 of Hole1');
    expect(faceWords('f3.2.f2/hole0:wall', name)).toBe('the wall of hole 1 of Hole1 (copy 2 of Pattern1)');
  });
});

describe('references', () => {
  // a 100 × 60 × 10 box's top, front and a coplanar face of another feature
  const top = plane(0, 'f1/end', [50, 30, 10], [0, 0, 1], 6000);
  const front = plane(1, 'f1/side:l0', [50, 0, 5], [0, -1, 0], 1000);
  const edge = line(0, 'f1/end|f1/side:l0', [0, 0, 10], [100, 0, 10], [0, 1]);
  const ref = refTo('face', 'f1', top);

  it('by key, wherever the face went', () => {
    const moved = body('f1', [front, { ...top, c: [50, 30, 25], frame: { ...top.frame!, o: [50, 30, 25] } }]);
    expect(resolveRef(ref, [moved])).toEqual({ ok: true, body: 'f1', index: 1, by: 'key' });
  });

  it('a split face: the piece nearest to where it was, a tie to the first name', () => {
    // a slot from x = 55 to 70: the old centroid (50, 30) lies in the left piece
    const left = plane(0, 'f1/end#1', [27.5, 30, 10], [0, 0, 1]), right = plane(0, 'f1/end#2', [85, 30, 10], [0, 0, 1]);
    expect(resolveRef(ref, [body('f1', [left, front, right])])).toMatchObject({ ok: true, index: 0, by: 'family' });
    // a centred slot: both pieces equally far, #1 is taken
    const l2 = plane(0, 'f1/end#2', [80, 30, 10], [0, 0, 1]), r2 = plane(1, 'f1/end#1', [20, 30, 10], [0, 0, 1]);
    expect(resolveRef(ref, [body('f1', [l2, r2])])).toMatchObject({ ok: true, index: 1 });
  });

  it('an edge split in two by a notch: the piece holding its old midpoint', () => {
    const r = refTo('edge', 'f1', edge);
    const a = line(0, 'f1/end|f1/side:l0~1', [0, 0, 10], [70, 0, 10], [0, 1]), b = line(1, 'f1/end|f1/side:l0~2', [80, 0, 10], [100, 0, 10], [0, 1]);
    expect(resolveRef(r, [body('f1', [top, front], [b, a])])).toMatchObject({ ok: true, index: 1, by: 'family' });
  });

  it('by geometry only what has not moved; otherwise lost, never a guess', () => {
    // the mesh kernel has no names: the same face at the same place is found …
    const unnamed = (f: FaceInfo): FaceInfo => ({ ...f, key: '' });
    expect(resolveRef(ref, [body('f1', [unnamed(front), unnamed(top)])])).toMatchObject({ ok: true, index: 1, by: 'geometry' });
    // … but not after it moved, and a coplanar face of another feature is not taken for it
    const higher = { ...unnamed(top), c: [50, 30, 12] as Vec3 };
    expect(resolveRef(ref, [body('f1', [higher])]).ok).toBe(false);
    const other = plane(0, 'f7/end', [20, 30, 10], [0, 0, 1], 400);
    expect(resolveRef(ref, [body('f1', [front, other])]).ok).toBe(false);
    // a face turned over is another face
    expect(resolveRef(ref, [body('f1', [{ ...unnamed(top), frame: { ...top.frame!, n: [0, 0, -1] } }])]).ok).toBe(false);
  });

  it('a body joined into another: its faces are found there', () => {
    const r: TopoRef = { ...ref, body: 'f9' };
    expect(resolveRef(r, [body('f1', [front, top])])).toMatchObject({ ok: true, body: 'f1', index: 1 });
  });

  it('the selection may fall back to the nearest of the same type', () => {
    const near = { ...top, key: '', c: [50, 30, 11] as Vec3 };
    expect(resolveRef({ ...ref, key: '' }, [body('f1', [near])]).ok).toBe(false);
    expect(resolveRef({ ...ref, key: '' }, [body('f1', [near])], { near: 0.05 })).toMatchObject({ ok: true, index: 0 });
  });
});

describe('sketch planes on faces', () => {
  // a sketch made on the top of a 10 high block: origin projected from the component origin
  const stored: Frame = { o: [0, 0, 10], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };

  it('the base extruded taller carries the sketch up', () => {
    const f = faceFrame(stored, plane(0, 'f1/end', [50, 30, 25], [0, 0, 1]))!;
    expect(f.o).toEqual([0, 0, 25]);
    expect(f.u).toEqual([1, 0, 0]);
    expect(f.n).toEqual([0, 0, 1]);
  });

  it('a wider base leaves it where it was', () => {
    // the face's centroid moved from x = 50 to 75: the sketch origin does not
    expect(faceFrame(stored, plane(0, 'f1/end', [75, 30, 10], [0, 0, 1]))!.o).toEqual([0, 0, 10]);
  });

  it('a face tilted 30° about x: the normal from the face, u and the origin projected onto it', () => {
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    const n: Vec3 = [0, -s, c];
    const f = faceFrame(stored, { ...plane(0, 'f1/end', [0, 0, 10], n), frame: { o: [0, 0, 10], u: [1, 0, 0], v: [0, c, s], n } })!;
    expect(f.n).toEqual(n);
    expect(f.u[0]).toBeCloseTo(1, 15);
    // v = n × u stays in the face: perpendicular to n, unit, right-handed
    expect(f.v[0] * n[0] + f.v[1] * n[1] + f.v[2] * n[2]).toBeCloseTo(0, 15);
    expect(f.v[1]).toBeCloseTo(c, 15);
    expect(f.o[2]).toBeCloseTo(10, 12);
  });

  it('an anchored origin moves with its anchor: the face slid 50 along x', () => {
    const f = faceFrame(stored, plane(0, 'f1/end', [100, 30, 10], [0, 0, 1]), { from: [0, 0, 10], to: [50, 0, 10] })!;
    expect(f.o).toEqual([50, 0, 10]);
    expect(f.u).toEqual([1, 0, 0]);
  });

  it('a face turned 90° about x: the anchored frame turns rigidly with it', () => {
    // R = rotation about x by −90°: (x, y, z) → (x, z, −y); the stored origin 5 off its anchor
    const off: Frame = { ...stored, o: [5, 0, 10] };
    const f = faceFrame(off, { ...plane(0, 'f1/end', [50, 10, -30], [0, 1, 0]), frame: { o: [50, 10, -30], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] } }, { from: [0, 0, 10], to: [0, 10, 0] })!;
    // o = to + R(o − from) = (0, 10, 0) + (5, 0, 0); u = R(1, 0, 0); v = R(0, 1, 0) = (0, 0, −1)
    expect(tidy(f.o)).toEqual([5, 10, 0]);
    expect(tidy(f.u)).toEqual([1, 0, 0]);
    expect(tidy(f.v)).toEqual([0, 0, -1]);
  });

  it('the anchor of a sketch origin: a vertex or circle centre of the face at that point, else none', () => {
    // the top of a 100 × 60 × 10 box: its edge along y = 0 runs from corner 0 to corner 1
    const top = plane(0, 'f1/end', [50, 30, 10], [0, 0, 1], 6000), front = plane(1, 'f1/side:l0', [50, 0, 5], [0, -1, 0], 1000);
    const corners: VertexInfo[] = [
      { index: 0, key: 'f1/end|f1/side:l0|f1/side:l3', p: [0, 0, 10], edges: [0] },
      { index: 1, key: 'f1/end|f1/side:l0|f1/side:l1', p: [100, 0, 10], edges: [0] },
    ];
    const b = body('f1', [top, front], [line(0, 'f1/end|f1/side:l0', [0, 0, 10], [100, 0, 10], [0, 1], [0, 1])], corners);
    expect(faceAnchor(b, b.faces[0], [0, 0, 10])).toEqual({ ref: refTo('vertex', 'f1', corners[0]), at: [0, 0, 10] });
    expect(faceAnchor(b, b.faces[0], [5, 5, 10])).toBeUndefined();
    // a disc's top: the centre of its rim
    const disc = body('f1', [plane(0, 'f1/end', [0, 0, 10], [0, 0, 1], 400 * Math.PI)], [{
      index: 0, key: 'f1/end|f1/side:k0', type: 'circle', length: 40 * Math.PI, circle: { c: [0, 0, 10], axis: [0, 0, 1], r: 20 }, faces: [0, 1], mid: [-20, 0, 10], v: [0, 0],
    }]);
    expect(faceAnchor(disc, disc.faces[0], [0, 0, 10])?.ref.key).toBe('f1/end|f1/side:k0');
  });

  it('a face that is no longer flat gives no plane', () => {
    expect(faceFrame(stored, { index: 0, key: 'f1/end', feature: 'f1', type: 'cylinder', area: 1, c: [0, 0, 0], axis: { p: [0, 0, 0], d: [0, 0, 1] }, radius: 5 })).toBeNull();
  });
});

describe('joint snap points', () => {
  // a plate's top with a Ø20 hole rim at (50, 30): faces top (0) and hole wall (1)
  const top = plane(0, 'f1/end', [50, 30, 10], [0, 0, 1], 6000 - 100 * Math.PI);
  const wall: FaceInfo = { index: 1, key: 'f1/side:k0', feature: 'f1', type: 'cylinder', area: 200 * Math.PI, c: [50, 30, 5], axis: { p: [50, 30, 0], d: [0, 0, -1] }, radius: 10 };
  const rim: EdgeInfo = { index: 0, key: 'f1/end|f1/side:k0', type: 'circle', length: 20 * Math.PI, circle: { c: [50, 30, 10], axis: [0, 0, -1], r: 10 }, faces: [0, 1], mid: [40, 30, 10], v: [0, 0], points: new Float32Array(0) };
  const seamV: VertexInfo = { index: 0, key: 'f1/end|f1/side:k0&f1/side:k0|f1/side:k0', p: [60, 30, 10], edges: [0] };
  const plate = { ...body('f1', [top, wall], [rim], [seamV]), mesh: undefined } as unknown as BodyTopology;

  it('a flat face offers its centroid and the centres of its circles, Z out of the face', () => {
    const snaps = snapsOn(plate, { face: 0 }, (v) => `${v} mm`);
    const c = snaps.find((s) => s.snap === 'centre')!;
    expect(c.o).toEqual([50, 30, 10]);
    // the circle's own axis points down; the snap turns it out of the top face
    expect(tidy(c.z)).toEqual([0, 0, 1]);
    expect(c.label).toBe('centre of the ⌀20 mm circle');
    expect(snaps.find((s) => s.snap === 'centroid')!.z).toEqual([0, 0, 1]);
  });

  it('a hole rim offers its centre, not the vertex where its parameter starts', () => {
    expect(snapsOn(plate, { edge: 0 }).map((s) => s.snap)).toEqual(['centre']);
    expect(snapsOn(plate, { face: 0 }).some((s) => s.snap === 'vertex')).toBe(false);
  });

  it('a cylinder offers its axis at its middle', () => {
    const a = snapsOn(plate, { face: 1 }).find((s) => s.snap === 'axis')!;
    expect(a.o).toEqual([50, 30, 5]);
  });

  it('a snap follows its circle when the hole moves and keeps the side of its Z axis', () => {
    const c = snapsOn(plate, { face: 0 }).find((s) => s.snap === 'centre')!;
    // the hole 15 further along x and Ø30: the rim's name is the same
    const moved = { ...plate, edges: [{ ...rim, circle: { c: [65, 30, 10] as Vec3, axis: [0, 0, 1] as Vec3, r: 15 } }] };
    const at = snapPlace(c, [moved])!;
    expect(at.o).toEqual([65, 30, 10]);
    expect(tidy(at.z)).toEqual([0, 0, 1]);
    // the hole gone: lost (the plate's outline edges are not taken for it)
    expect(snapPlace(c, [{ ...plate, faces: [top], edges: [line(0, 'f1/end|f1/side:l0', [0, 0, 10], [100, 0, 10], [0, 0])] }])).toBeNull();
  });
});
