// The sheet-metal model without a kernel: bend allowances and setbacks against hand
// calculations, DIN 6935's correction against its formula, folds that put every piece of
// a strip where its sketch line is, and flat lengths of brackets from their outer legs.
import { describe, expect, it } from 'vitest';
import {
  addFlange, bendAllowance, bendAlongLine, chainMatrix, din6935, findEdge, flatNumbers, innerSetback, outerSetback, plateModel, sheetParams, sheetRuleNumbers, stripModel,
  type FlangeSpec, type SheetModel,
} from './sheetMetal';
import { m4Point, type Frame, type Vec3 } from './solid';
import type { ProfileRegion } from './profile';

const { PI, tan, log10 } = Math;
const near = (v: number, want: number, abs = 1e-9) => expect(Math.abs(v - want)).toBeLessThan(abs);
const XZ: Frame = { o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] };
const XY: Frame = { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };
const t = 2, R = 2, K = 0.44;

/** A w × h rectangle from the origin, its sides l0 (y = 0), l1 (x = w), l2 (y = h), l3 (x = 0). */
function rectRegion(w: number, h: number): ProfileRegion {
  const p = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  return { outer: { segs: p.map((a, i) => ({ kind: 'line' as const, a, b: p[(i + 1) % 4] })), entities: ['l0', 'l1', 'l2', 'l3'] }, holes: [] };
}

const spec = (more: Partial<FlangeSpec> = {}): FlangeSpec => ({
  tag: 'f2/fl', bendTag: 'f2/bend', token: 'f2:x', angle: PI / 2, R, up: true, length: 26, setback: R + t, o1: 0, o2: 0,
  relief: { kind: 'rect', w: t, d: t }, corner: { kind: 'none', size: R + t }, ...more,
});

/** Where a flat point of a piece is in the part. */
const place = (m: SheetModel, chain: string[], p: Vec3) => m4Point(chainMatrix(m, chain), p);

describe('bend allowance and setbacks', () => {
  it('BA = θ·(R + K·t): 90°, R = t = 2, K = 0.44 gives (π/2)·2.88 = 4.5239', () => {
    near(bendAllowance(PI / 2, 2, 0.44, 2), 4.523893421169302, 1e-12);
    near(bendAllowance(PI / 3, 2, 0.44, 2), (PI / 3) * 2.88, 1e-12);
  });

  it('setbacks from the virtual sharps: (R + t)·tan(θ/2) outside, R·tan(θ/2) inside', () => {
    near(outerSetback(PI / 2, 2, 2), 4, 1e-12);
    near(innerSetback(PI / 2, 2), 2, 1e-12);
    near(outerSetback(PI / 3, 2, 2), 4 / Math.sqrt(3), 1e-12);
  });

  it('DIN 6935: k = 0.65 + 0.5·lg(r/s), v for 90°, 60° and a hem', () => {
    // r = s: k = 0.65; 90°: v = (π/2)(r + s/2·k) − 2(r + s) = (π/2)(2.65) − 8
    const d90 = din6935(PI / 2, 2, 2)!;
    near(d90.k, 0.65, 1e-12);
    near(d90.v, (PI / 2) * 2.65 - 8, 1e-12);
    expect(d90.v).toBeCloseTo(-3.8374, 4);
    // r/s = 2: k = 0.65 + 0.5·lg 2 = 0.80103; opening angle 120° (bent 60°): the tan form
    const d60 = din6935(PI / 3, 4, 2)!;
    near(d60.k, 0.65 + 0.5 * log10(2), 1e-12);
    near(d60.v, (PI / 3) * (4 + d60.k) - 2 * 6 * tan(PI / 6), 1e-12);
    // r/s above 5: k = 1, the neutral fibre in the middle
    expect(din6935(PI / 2, 12, 2)!.k).toBe(1);
    // folded flat (opening 0°): the first form
    near(din6935(PI, 1, 2)!.v, PI * (1 + 0.65 + 0.5 * log10(0.5)) - 6, 1e-12);
    // nearly flat (opening over 165°): v ≈ 0
    expect(din6935((10 * PI) / 180, 2, 2)!.v).toBe(0);
    expect(din6935(PI / 2, 0, 2)).toBeNull();
  });
});

describe('rules', () => {
  const value = (src: string | undefined, fallback: string) => +(src?.trim() || fallback).replace(/\s*mm$/, '');
  const ratio = (src: string | undefined, fallback: string) => +(src?.trim() || fallback);

  it('defaults: steel K = 0.44, reliefs t wide and t deep, corner relief R + t', () => {
    const p = sheetRuleNumbers({ t: '2', r: '3' }, value, ratio);
    expect(p).toMatchObject({ t: 2, R: 3, K: 0.44, rw: 2, rd: 2, relief: 0, corner: 0, cs: 5 });
    expect(sheetRuleNumbers({ t: '1.5', r: '1.5', material: 'aluminium' }, value, ratio).K).toBe(0.43);
    expect(sheetRuleNumbers({ t: '1.5', r: '1.5', k: '0.33', material: 'aluminium' }, value, ratio).K).toBe(0.33);
  });

  it('refuses what cannot be bent', () => {
    expect(() => sheetRuleNumbers({ t: '0', r: '2' }, value, ratio)).toThrow(/thickness/);
    expect(() => sheetRuleNumbers({ t: '2', r: '0' }, value, ratio)).toThrow(/radius/);
    expect(() => sheetRuleNumbers({ t: '2', r: '2', k: '1.5' }, value, ratio)).toThrow(/K-factor/);
    expect(() => sheetParams({ t: '2', r: '2' }, { kind: 'edgeflange', id: 'f', name: 'F', edges: [], height: '20', angle: '180' }, (s, f) => (s?.trim() ? (+s * PI) / 180 : +f), ratio)).toThrow(/bend angle/);
  });
});

describe('folds', () => {
  it('an L strip from outer legs a = 30 (down) and b = 50 on XZ: every piece where its sketch line is', () => {
    const m = stripModel('f1', { pts: [{ x: 0, y: 30 }, { x: 0, y: 0 }, { x: 50, y: 0 }], ids: ['l0', 'l1'], sketch: XZ, flip: false, width: [0, 40], t, R, K });
    const [w1, w2] = m.flanges;
    expect(m.bends).toHaveLength(1);
    expect(m.bends[0].up).toBe(true);
    // the flat: (a − t − R) + BA + (b − t − R)
    const fn = flatNumbers(m);
    near(fn.box.x1 - fn.box.x0, (30 - t - R) + bendAllowance(PI / 2, R, K, t) + (50 - t - R), 1e-12);
    near(fn.box.y1 - fn.box.y0, 40, 1e-12);
    // face A of the first piece starts at (0, 0, 30) and runs down; the second ends at (50, 0, 0)
    const close = (p: Vec3, q: Vec3) => expect(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])).toBeLessThan(1e-9);
    close(place(m, w1.chain, [0, 0, 0]), [0, 0, 30]);
    close(place(m, w1.chain, [30 - 4, 0, 0]), [0, 0, 4]);
    close(place(m, w2.chain, [fn.box.x1, 0, 0]), [50, 0, 0]);
    // its face B is t inside the L; the width runs along the sketch normal, −y (flat y −40 … 0, kept right-handed)
    close(place(m, w2.chain, [fn.box.x1, 0, t]), [50, 0, 2]);
    expect([fn.box.y0, fn.box.y1]).toEqual([-40, 0]);
    close(place(m, w2.chain, [fn.box.x1, -40, 0]), [50, -40, 0]);
  });

  it('a 60° bend: the flat parts shorter by (R + t)·tan 30° each', () => {
    const c = Math.cos(PI / 3), s = Math.sin(PI / 3);
    const m = stripModel('f1', { pts: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50 + 30 * c, y: 30 * s }], ids: ['l0', 'l1'], sketch: XZ, flip: false, width: [0, 20], t, R, K });
    const fn = flatNumbers(m);
    near(fn.box.x1, 50 + 30 - 2 * (R + t) * tan(PI / 6) + bendAllowance(PI / 3, R, K, t), 1e-12);
    near(fn.bends[0].angle, 60, 1e-12);
    const end = place(m, m.flanges[1].chain, [fn.box.x1, 0, 0]);
    near(end[0], 50 + 30 * c, 1e-9);
    near(end[2], 30 * s, 1e-9);
  });

  it('turning away from the material bends down, the setback then R·tan(θ/2) on the sketch line', () => {
    const m = stripModel('f1', { pts: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: -30 }], ids: ['l0', 'l1'], sketch: XZ, flip: false, width: [0, 20], t, R, K });
    expect(m.bends[0].up).toBe(false);
    near(flatNumbers(m).box.x1, 80 - 2 * R + bendAllowance(PI / 2, R, K, t), 1e-12);
  });

  it('refuses a line too short for the bends at its ends', () => {
    expect(() => stripModel('f1', { pts: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 30 }], ids: ['l0', 'l1'], sketch: XZ, flip: false, width: [0, 20], t, R, K })).toThrow(/too short/);
  });
});

describe('edge flanges on the model', () => {
  const plate = () => plateModel('f1', rectRegion(50, 40), XY, false, t, K);

  it('an L from a plate a = 50 and a flange b = 30 on its edge (Inside, outer legs): the same flat as the strip', () => {
    const m = plate();
    const hit = findEdge(m, [50, 0, t], [50, 40, t])!;
    expect(hit).toMatchObject({ flange: 0, seg: 1, face: 'B' });
    const out = addFlange(m, hit, spec());
    const fn = flatNumbers(out.model);
    near(fn.box.x1 - fn.box.x0, (50 - t - R) + bendAllowance(PI / 2, R, K, t) + (30 - t - R), 1e-12);
    // the parent loses the band the bend takes back, 4 × 40
    expect(out.removed).toHaveLength(1);
    // the flange's outer face is flush with the edge, its far edge 30 above face A
    const far = place(out.model, out.flange.chain, [50 - 4 + bendAllowance(PI / 2, R, K, t) + 26, 20, 0]);
    near(far[0], 50, 1e-9);
    near(far[2], 30, 1e-9);
  });

  it('offsets leave reliefs t wide beside the bend; the flat loses them', () => {
    const m = plate();
    const out = addFlange(m, findEdge(m, [50, 0, t], [50, 40, t])!, spec({ setback: 0, o1: 10, o2: 10 }));
    expect(out.removed).toHaveLength(2);
    const fn = flatNumbers(out.model);
    near(fn.area, 50 * 40 - 2 * (t * t) + 20 * bendAllowance(PI / 2, R, K, t) + 20 * 26, 1e-9);
    near(out.bend.s0, 10, 1e-12);
    near(out.bend.s1, 30, 1e-12);
  });

  it('a bend along a line keeps the flat as it was', () => {
    const m = plate();
    const done = bendAlongLine(m, [25, -5, t], [25, 45, t], { tag: 'f3/fl', bendTag: 'f3/bend', angle: PI / 2, R, normal: [0, 0, 1], placement: 'centre', flip: false });
    const fn = flatNumbers(done.model);
    near(fn.area, 2000, 1e-9);
    near(fn.box.x1 - fn.box.x0, 50, 1e-12);
    near(fn.bends[0].a.x, 25, 1e-12);
    expect(done.bend.up).toBe(true);
  });
});
