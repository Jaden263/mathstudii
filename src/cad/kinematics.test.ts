// Assembly kinematics against closed forms: the four-bar linkage by Freudenstein's equation
// (Norton, Design of Machinery, 5th ed., §4.5, eq. 4.8 and 4.10), the slider-crank's
// piston x = r·cos θ + √(l² − r²·sin² θ) (Norton §4.6), gear and rack-and-pinion links,
// limits, the DOFs of the planar, pin-slot and ball joints, and the placements of
// assemblies without loops, which must stay exactly what they were.
import { describe, expect, it } from 'vitest';
import { JOINT_DOFS, type DofKey } from './assembly';
import { jointParams, linkRatio, motionValue } from './assemblyParams';
import { motionResult, runMotion } from './motion';
import { jointFrame, type CadDesign, type CadJoint, type DesignNumbers, type JointType, type Placement } from './design';
import { asBuiltOrigin, kinModel, levenbergMarquardt, motionMatrix, placementsWithout, rankOf, solveKinematics, type KinJoint, type KinModel } from './kinematics';
import type { Unit } from 'mathjs';
import { math } from '../engine/math';
import { IDENTITY, m4Frame, m4Inv, m4Mul, m4Point, m4Pose, m4Rotate, m4Translate, type M4, type Vec3 } from './solid';

const D = Math.PI / 180;
const T = (x: number, y = 0, z = 0) => m4Translate([x, y, z]);

/** A joint between two occurrences (revolute about the frames' Z unless said otherwise). */
function joint(id: string, a: string, b: string, Fa: M4, Fb: M4, o: Partial<KinJoint> = {}): KinJoint {
  return { id, name: id, type: 'revolute', a, b, Fa, Fb, q: { angle: 0, angle2: 0, angle3: 0, offset: 0, x: 0, y: 0 }, free: [], min: {}, max: {}, rest: {}, ...o };
}

const model = (occs: string[], joints: KinJoint[], o: Partial<KinModel> = {}): KinModel => ({
  occs: occs.map((id, i) => ({ id, pose: IDENTITY, ...(i === 0 ? { grounded: true } : {}) })), joints, links: [], size: 200, unit: 'mm', ...o,
});

const angleOf = (M: M4) => Math.atan2(M[1], M[0]);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// ------------------------------------------------------------ four-bar

/**
 * Freudenstein's constants for links a (crank), b (coupler), c (rocker), d (ground):
 * K1·cos θ4 − K2·cos θ2 + K3 = cos(θ2 − θ4).
 */
function freudenstein(a: number, b: number, c: number, d: number) {
  return { K1: d / a, K2: d / c, K3: (a * a - b * b + c * c + d * d) / (2 * a * c) };
}

/** θ4 in closed form (Norton eq. 4.10): the open circuit takes −√, the crossed one +√. */
function theta4(a: number, b: number, c: number, d: number, t2: number, open: boolean): number {
  const { K1, K2, K3 } = freudenstein(a, b, c, d);
  const A = Math.cos(t2) - K1 - K2 * Math.cos(t2) + K3, B = -2 * Math.sin(t2), C = K1 - (K2 + 1) * Math.cos(t2) + K3;
  return 2 * Math.atan2(-B + (open ? -1 : 1) * Math.sqrt(B * B - 4 * A * C), 2 * A);
}

/** θ3 from θ2 and θ4: the coupler runs from the crank pin to the rocker pin. */
function theta3(a: number, c: number, d: number, t2: number, t4: number): number {
  return Math.atan2(c * Math.sin(t4) - a * Math.sin(t2), d + c * Math.cos(t4) - a * Math.cos(t2));
}

/**
 * Ground, crank, coupler and rocker, each drawn along its own X: pins at x = 0 and its
 * length. The crank's angle θ2 is driven; the other three joints are solved, the rocker's
 * pin on the ground closing the loop. `rest`: the configuration it was assembled in.
 */
function fourBar(a: number, b: number, c: number, d: number, t2: number, rest?: { t2?: number; t3: number; t4: number }) {
  const joints = [
    joint('J1', 'ground', 'crank', IDENTITY, IDENTITY, { q: { angle: t2, angle2: 0, angle3: 0, offset: 0, x: 0, y: 0 }, rest: rest?.t2 !== undefined ? { angle: rest.t2 } : {} }),
    joint('J2', 'crank', 'coupler', T(a), IDENTITY, { free: ['angle'], rest: rest ? { angle: rest.t3 - (rest.t2 ?? 0) } : {} }),
    joint('J3', 'coupler', 'rocker', T(b), T(c), { free: ['angle'], rest: rest ? { angle: rest.t4 - rest.t3 } : {} }),
    joint('J4', 'ground', 'rocker', T(d), IDENTITY, { free: ['angle'], rest: rest ? { angle: rest.t4 } : {} }),
  ];
  return model(['ground', 'crank', 'coupler', 'rocker'], joints);
}

/** The open configuration at θ2 (for the rest values). */
function open(a: number, b: number, c: number, d: number, t2: number) {
  const t4 = theta4(a, b, c, d, t2, true);
  return { t2, t3: theta3(a, c, d, t2, t4), t4 };
}

describe('four-bar linkage', () => {
  // a crank-rocker (Grashof: 40 + 120 ≤ 80 + 100): the crank turns all the way round
  const [a, b, c, d] = [40, 120, 80, 100];
  const { K1, K2, K3 } = freudenstein(a, b, c, d);
  const open0 = open(a, b, c, d, 0);

  it('follows Freudenstein’s equation all the way round, on the circuit it was assembled in', () => {
    for (const deg of [0, 30, 40, 90, 150, 200, 270, 330, 359]) {
      const t2 = deg * D;
      const sol = solveKinematics(fourBar(a, b, c, d, t2, open0));
      expect(sol.errors).toEqual({});
      const t4 = angleOf(sol.placements.rocker.matrix);
      // the rocker's pin on the ground is where it was: the loop closed
      expect(m4Point(sol.placements.rocker.matrix, [0, 0, 0]).map((v, i) => v - [d, 0, 0][i]).every((v) => Math.abs(v) < 1e-9)).toBe(true);
      expect(Math.abs(K1 * Math.cos(t4) - K2 * Math.cos(t2) + K3 - Math.cos(t2 - t4))).toBeLessThan(1e-8);
      expect(Math.abs(wrap(t4 - theta4(a, b, c, d, t2, true)))).toBeLessThan(1e-8);
      // the joint's own value is the same angle (its frame on the ground is square to the world)
      expect(Math.abs(wrap(sol.values.J4.angle! - t4))).toBeLessThan(1e-8);
      expect(Math.abs(wrap(angleOf(sol.placements.coupler.matrix) - theta3(a, c, d, t2, t4)))).toBeLessThan(1e-8);
      // planar: one DOF, the crank's, which is driven
      expect(sol.mobility).toBe(0);
    }
  });

  it('stays on the crossed circuit when assembled crossed', () => {
    const t4c = theta4(a, b, c, d, 0, false);
    const crossed = { t3: theta3(a, c, d, 0, t4c), t4: t4c };
    for (const deg of [20, 120, 250]) {
      const t2 = deg * D;
      const sol = solveKinematics(fourBar(a, b, c, d, t2, crossed));
      expect(Math.abs(wrap(angleOf(sol.placements.rocker.matrix) - theta4(a, b, c, d, t2, false)))).toBeLessThan(1e-8);
    }
  });

  it('goes on from the previous frame of a motion', () => {
    let from = solveKinematics(fourBar(a, b, c, d, 0, open0)).values;
    for (let deg = 10; deg <= 360; deg += 10) {
      const sol = solveKinematics(fourBar(a, b, c, d, 0, open0), { drive: { J1: { angle: deg * D } }, from });
      expect(Math.abs(wrap(angleOf(sol.placements.rocker.matrix) - theta4(a, b, c, d, deg * D, true)))).toBeLessThan(1e-8);
      from = sol.values;
    }
  });

  it('stops a non-Grashof linkage where its loop can no longer close, and says so', () => {
    // 80 + 120 > 90 + 100: a triple rocker. Assembled at θ2 = 90°, the crank can go down only
    // until coupler and rocker fold onto each other, |O4 − crank pin| = b − c (cos θ2 = 16500/18000)
    const [A, B, C, Dd] = [90, 120, 80, 100];
    const sol = solveKinematics(fourBar(A, B, C, Dd, 0, open(A, B, C, Dd, 90 * D)));
    expect(sol.warnings.J1).toMatch(/^the angle stops at J1 = [\d.]+°: the loop cannot close beyond/);
    const t2 = sol.values.J1.angle!;
    expect(t2).toBeCloseTo(Math.acos(16500 / 18000), 6);
    const pin: Vec3 = [A * Math.cos(t2), A * Math.sin(t2), 0];
    expect(Math.hypot(pin[0] - Dd, pin[1])).toBeCloseTo(B - C, 5);
    // what is placed still closes (to the solver's tolerance: at a dead point its Jacobian is singular)
    expect(Math.hypot(...m4Point(sol.placements.rocker.matrix, [0, 0, 0]).map((v, i) => v - [Dd, 0, 0][i]))).toBeLessThan(1e-6);
  });

  it('reports a loop that cannot close at all', () => {
    // the coupler is too short to reach: 40 + 30 + 20 < 100
    const sol = solveKinematics(fourBar(40, 30, 20, 100, 0));
    expect(sol.errors.J4).toMatch(/^the loop through J1, J2, J3, J4 cannot close: it stays [\d.]+ mm/);
  });

  it('with nothing solved, a loop that does not fit is reported as before', () => {
    const m = fourBar(a, b, c, d, 0);
    for (const j of m.joints) j.free = [];
    expect(solveKinematics(m).errors.J4).toMatch(/^this joint closes a loop that does not fit — it is ignored \(to let the loop move, set the DOFs it should find to Solved\)$/);
  });

  it('counts what a loop leaves free: a five-bar with one input has two DOFs left', () => {
    // ground pins 100 apart, two cranks of 40 and two couplers of 70: 2 DOF, one driven
    const joints = [
      joint('J1', 'g', 'c1', IDENTITY, IDENTITY, { q: { angle: 60 * D, angle2: 0, angle3: 0, offset: 0, x: 0, y: 0 } }),
      joint('J2', 'c1', 'k1', T(40), IDENTITY, { free: ['angle'], rest: { angle: -30 * D } }),
      joint('J3', 'k1', 'k2', T(70), T(70), { free: ['angle'], rest: { angle: 120 * D } }),
      joint('J4', 'k2', 'c2', IDENTITY, T(40), { free: ['angle'], rest: { angle: 0 } }),
      joint('J5', 'g', 'c2', T(100), IDENTITY, { free: ['angle'], rest: { angle: 120 * D } }),
    ];
    const sol = solveKinematics(model(['g', 'c1', 'k1', 'k2', 'c2'], joints));
    expect(sol.errors).toEqual({});
    expect(sol.mobility).toBe(1);
  });

  it('drives the rocker by hand: the crank that drives the loop is solved instead (Freudenstein solved for θ2)', () => {
    // from θ2 = 40° (θ4 = 57.32°) the rocker is dragged to 100°. Freudenstein's equation in
    // θ2 is A·cos θ2 + B·sin θ2 = C with A = −K2 − cos θ4, B = −sin θ4, C = −(K1 cos θ4 + K3);
    // its root followed by continuation in steps of 1° from θ2 = 40°
    const m = fourBar(a, b, c, d, 40 * D, open0);
    const start = solveKinematics(m);
    const sol = solveKinematics(m, { drive: { J4: { angle: 100 * D } }, from: start.values });
    expect(sol.errors).toEqual({});
    expect(sol.warnings).toEqual({});
    let t2 = 40 * D;
    for (let t4deg = Math.round(start.values.J4.angle! / D); t4deg <= 100; t4deg++) {
      const t4 = t4deg * D, A = -K2 - Math.cos(t4), B = -Math.sin(t4), C = -(K1 * Math.cos(t4) + K3);
      const roots = [1, -1].map((s) => Math.atan2(B, A) + s * Math.acos(C / Math.hypot(A, B)));
      t2 = roots.sort((p, q) => Math.abs(wrap(p - t2)) - Math.abs(wrap(q - t2)))[0];
    }
    expect(sol.values.J4.angle! / D).toBeCloseTo(100, 12);
    expect(Math.abs(wrap(sol.values.J1.angle! - t2))).toBeLessThan(1e-8);
    expect(Math.abs(K1 * Math.cos(100 * D) - K2 * Math.cos(sol.values.J1.angle!) + K3 - Math.cos(sol.values.J1.angle! - 100 * D))).toBeLessThan(1e-8);
    // the crank turns where the solve put it
    expect(Math.abs(wrap(angleOf(sol.placements.crank.matrix) - t2))).toBeLessThan(1e-8);
    // past the rocker's swing (128.68°: crank and coupler folded, Norton §4.4) it stops with a warning
    const far = solveKinematics(m, { drive: { J4: { angle: 150 * D } }, from: start.values });
    expect(far.values.J4.angle! / D).toBeCloseTo(180 - Math.acos((d * d + c * c - (b - a) ** 2) / (2 * d * c)) / D, 4);
    expect(far.warnings.J4).toMatch(/stops at J4 = 128\.68\d*°: the loop cannot close beyond/);
  });

  it('lets a motion study drive the rocker: its track takes the loop over from the crank', () => {
    // θ4 from 70° to 110° in 10 frames; each frame's crank satisfies Freudenstein's equation,
    // on the open circuit the linkage was assembled in
    const m = fourBar(a, b, c, d, 40 * D, open0);
    const sol = solveKinematics(m);
    const kin = { model: m, values: sol.values, parent: sol.parent, mobility: sol.mobility };
    const study = { id: 's', name: 'Rock', duration: 1, steps: 10, tracks: [{ joint: 'J4', dof: 'angle' as const, keys: [{ t: 0, v: '70' }, { t: 1, v: '110' }] }] };
    const frames = runMotion(kin, study, { s: { 'v:0:0': 70 * D, 'v:0:1': 110 * D } });
    expect(frames).toHaveLength(11);
    frames.forEach((f, i) => {
      expect(f.error).toBeUndefined();
      expect(f.warning).toBeUndefined();
      const t4 = (70 + 4 * i) * D, t2 = f.values.J1.angle!;
      expect(f.values.J4.angle!).toBeCloseTo(t4, 12);
      expect(Math.abs(K1 * Math.cos(t4) - K2 * Math.cos(t2) + K3 - Math.cos(t2 - t4))).toBeLessThan(1e-8);
      expect(Math.abs(wrap(theta4(a, b, c, d, t2, true) - t4))).toBeLessThan(1e-8);
    });
  });

  it('moves two linkages of one assembly apart: one stopping at its dead point does not hold the other back', () => {
    // the triple rocker above, driven from 90° down past its stop at acos(16500/18000), and
    // beside it the crank-rocker driven to 200°
    const [A, B, C, Dd] = [90, 120, 80, 100];
    const stuck = fourBar(A, B, C, Dd, 10 * D, open(A, B, C, Dd, 90 * D));
    const free = fourBar(a, b, c, d, 200 * D, open0);
    const rename = (m: KinModel, p: string, at: M4) => m.joints.map((j) => ({
      ...j, id: p + j.id, name: p + j.name, a: j.a === 'ground' ? 'ground' : p + j.a, b: p + j.b, Fa: j.a === 'ground' ? m4Mul(at, j.Fa) : j.Fa,
    }));
    const both = model(['ground', ...['crank', 'coupler', 'rocker'].flatMap((o) => ['X' + o, 'Y' + o])], [...rename(stuck, 'X', IDENTITY), ...rename(free, 'Y', T(0, 500))]);
    const sol = solveKinematics(both);
    expect(sol.errors).toEqual({});
    expect(sol.values.XJ1.angle!).toBeCloseTo(Math.acos(16500 / 18000), 6);
    expect(sol.warnings.XJ1).toMatch(/^the angle stops at XJ1 = [\d.]+°: the loop cannot close beyond/);
    expect(sol.warnings.YJ1).toBeUndefined();
    expect(sol.values.YJ1.angle! / D).toBeCloseTo(200, 12);
    expect(Math.abs(wrap(sol.values.YJ4.angle! - theta4(a, b, c, d, 200 * D, true)))).toBeLessThan(1e-8);
  });
});

// ------------------------------------------------------------ slider-crank

describe('slider-crank', () => {
  const r = 50, l = 150;
  // the slider's frame: Z along the world X (the line of stroke), X up the world Y
  const alongX = m4Frame([0, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0]);
  const slider = (t: number) => model(['ground', 'crank', 'rod', 'piston'], [
    joint('J1', 'ground', 'crank', IDENTITY, IDENTITY, { q: { angle: t, angle2: 0, angle3: 0, offset: 0, x: 0, y: 0 } }),
    joint('J2', 'crank', 'rod', T(r), IDENTITY, { free: ['angle'] }),
    joint('J3', 'rod', 'piston', T(l), IDENTITY, { free: ['angle'] }),
    joint('P', 'ground', 'piston', alongX, alongX, { type: 'slider', free: ['offset'], rest: { offset: r + l } }),
  ]);

  it('puts the piston at x = r·cos θ + √(l² − r²·sin² θ); the stroke is 2r', () => {
    let lo = Infinity, hi = -Infinity;
    for (let deg = 0; deg < 360; deg += 15) {
      const t = deg * D;
      const sol = solveKinematics(slider(t));
      expect(sol.errors).toEqual({});
      const x = m4Point(sol.placements.piston.matrix, [0, 0, 0])[0];
      expect(Math.abs(x - (r * Math.cos(t) + Math.sqrt(l * l - r * r * Math.sin(t) ** 2)))).toBeLessThan(1e-8);
      expect(Math.abs(sol.values.P.offset! - x)).toBeLessThan(1e-8);
      // the piston does not turn
      expect(Math.abs(angleOf(sol.placements.piston.matrix))).toBeLessThan(1e-9);
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    // top and bottom dead centre at θ = 0 and 180°
    expect(hi - lo).toBeCloseTo(2 * r, 9);
  });
});

// ------------------------------------------------------------ links

describe('motion links', () => {
  it('turns a gear the other way by the ratio of the teeth: θ2 = −z1/z2 · θ1', () => {
    const m = model(['g', 'p', 'w'], [
      joint('G1', 'g', 'p', IDENTITY, IDENTITY, { q: { angle: 30 * D, angle2: 0, angle3: 0, offset: 0, x: 0, y: 0 } }),
      joint('G2', 'g', 'w', T(60), IDENTITY),
    ], { links: [{ id: 'L1', name: 'Gears', a: { joint: 'G1', dof: 'angle' }, b: { joint: 'G2', dof: 'angle' }, ratio: -20 / 40, offset: 0 }] });
    const sol = solveKinematics(m);
    expect(sol.values.G2.angle! / D).toBeCloseTo(-15, 12);
    expect(angleOf(sol.placements.w.matrix) / D).toBeCloseTo(-15, 12);
  });

  it('moves a rack by r·θ of its pinion (the ratio is the pitch radius)', () => {
    const ratio = linkRatio(math.unit(25, 'mm'), 'mm', true, false);
    expect(ratio).toBe(25);
    expect(linkRatio(math.unit(2, 'mm/deg'), 'mm', true, false)).toBeCloseTo(2 * 180 / Math.PI, 9);
    expect(linkRatio(math.unit(25, 'mm'), 'mm', false, true)).toBeCloseTo(1 / 25, 15);
    expect(() => linkRatio(3, 'mm', true, false)).toThrow(/needs a unit/);
    const alongX = m4Frame([0, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0]);
    const m = model(['g', 'pinion', 'rack'], [
      joint('P', 'g', 'pinion', IDENTITY, IDENTITY, { q: { angle: 90 * D, angle2: 0, angle3: 0, offset: 0, x: 0, y: 0 } }),
      joint('R', 'g', 'rack', alongX, alongX, { type: 'slider' }),
    ], { links: [{ id: 'L', name: 'RackPinion', a: { joint: 'P', dof: 'angle' }, b: { joint: 'R', dof: 'offset' }, ratio, offset: 0 }] });
    const x = m4Point(solveKinematics(m).placements.rack.matrix, [0, 0, 0])[0];
    expect(x).toBeCloseTo(25 * Math.PI / 2, 12);
  });

  it('refuses links that go round in a circle', () => {
    const m = model(['g', 'p', 'w'], [joint('A', 'g', 'p', IDENTITY, IDENTITY), joint('B', 'g', 'w', T(60), IDENTITY)], {
      links: [
        { id: 'L1', name: 'L1', a: { joint: 'A', dof: 'angle' }, b: { joint: 'B', dof: 'angle' }, ratio: 2, offset: 0 },
        { id: 'L2', name: 'L2', a: { joint: 'B', dof: 'angle' }, b: { joint: 'A', dof: 'angle' }, ratio: 0.5, offset: 0 },
      ],
    });
    expect(Object.values(solveKinematics(m).errors).join()).toMatch(/round in a circle/);
  });

  it('drives a loop through a link: a gear on the crank of a four-bar', () => {
    // the crank's angle follows a driven gear at −2:1 (a 20-tooth pinion on a 40-tooth crank gear… backwards)
    const [a, b, c, d] = [40, 120, 80, 100];
    const m = fourBar(a, b, c, d, 0, open(a, b, c, d, 0));
    m.occs.push({ id: 'pinion', pose: IDENTITY });
    m.joints.push(joint('P', 'ground', 'pinion', T(0, -60), IDENTITY, { q: { angle: -100 * D, angle2: 0, angle3: 0, offset: 0, x: 0, y: 0 } }));
    m.joints[0].free = ['angle'];
    m.links.push({ id: 'L', name: 'L', a: { joint: 'P', dof: 'angle' }, b: { joint: 'J1', dof: 'angle' }, ratio: -0.5, offset: 0 });
    const sol = solveKinematics(m);
    expect(sol.values.J1.angle! / D).toBeCloseTo(50, 10);
    expect(Math.abs(wrap(angleOf(sol.placements.rocker.matrix) - theta4(a, b, c, d, 50 * D, true)))).toBeLessThan(1e-8);
  });
});

// ------------------------------------------------------------ limits

describe('limits', () => {
  it('stops a driven value at its limit with a warning', () => {
    const m = model(['g', 'arm'], [joint('J', 'g', 'arm', IDENTITY, IDENTITY, { q: { angle: 120 * D, angle2: 0, angle3: 0, offset: 0, x: 0, y: 0 }, max: { angle: 90 * D } })]);
    const sol = solveKinematics(m);
    expect(sol.warnings.J).toBe('the angle 120° is past its limit (max 90°): the joint stops there');
    expect(angleOf(sol.placements.arm.matrix) / D).toBeCloseTo(90, 12);
    expect(sol.values.J.angle! / D).toBeCloseTo(90, 12);
    // a slider below its minimum
    const s = model(['g', 'b'], [joint('S', 'g', 'b', IDENTITY, IDENTITY, { type: 'slider', q: { angle: 0, angle2: 0, angle3: 0, offset: -5, x: 0, y: 0 }, min: { offset: 0 }, max: { offset: 40 } })]);
    const ss = solveKinematics(s);
    expect(ss.warnings.S).toBe('the offset -5 mm is past its limit (min 0 mm): the joint stops there');
    expect(ss.placements.b.matrix[14]).toBe(0);
  });

  it('stops a mechanism where a solved DOF reaches its limit', () => {
    // the slider-crank's piston may not go below x = 130 mm: the crank stops on the way down
    const r = 50, l = 150;
    const alongX = m4Frame([0, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0]);
    const m = model(['ground', 'crank', 'rod', 'piston'], [
      joint('J1', 'ground', 'crank', IDENTITY, IDENTITY, { q: { angle: 150 * D, angle2: 0, angle3: 0, offset: 0, x: 0, y: 0 } }),
      joint('J2', 'crank', 'rod', T(r), IDENTITY, { free: ['angle'] }),
      joint('J3', 'rod', 'piston', T(l), IDENTITY, { free: ['angle'] }),
      joint('P', 'ground', 'piston', alongX, alongX, { type: 'slider', free: ['offset'], rest: { offset: r + l }, min: { offset: 130 } }),
    ]);
    const sol = solveKinematics(m);
    expect(sol.warnings.P).toMatch(/^the offset reaches its limit 130 mm at J1 = [\d.]+°: the mechanism stops there$/);
    expect(sol.warnings.J1).toMatch(/stops at J1 = [\d.]+°: P reaches its limit/);
    expect(sol.values.P.offset).toBeCloseTo(130, 6);
    // where r·cos θ + √(l² − r² sin² θ) = 130
    const t = sol.values.J1.angle!;
    expect(r * Math.cos(t) + Math.sqrt(l * l - (r * Math.sin(t)) ** 2)).toBeCloseTo(130, 6);
  });

  it('says both when a clamped joint then cannot move its loop at all', () => {
    // the crank of a planar four-bar made a ball joint and pitched 20°: the loop cannot close
    // anywhere but where it was assembled (pitch 0), so it stays there; its yaw is clamped too
    const [a, b, c, d] = [40, 120, 80, 100];
    const m = fourBar(a, b, c, d, 40 * D, open(a, b, c, d, 0));
    Object.assign(m.joints[0], { type: 'ball', q: { ...m.joints[0].q, angle2: 20 * D }, max: { angle: 30 * D } });
    const sol = solveKinematics(m);
    expect(sol.errors).toEqual({});
    expect(sol.warnings.J1).toMatch(/^the yaw 40° is past its limit \(max 30°\): the joint stops there; the yaw stops at J1 yaw = 0°, J1 pitch = 0°: the loop cannot close beyond/);
    expect(sol.values.J1).toEqual({ angle: 0, angle2: 0, angle3: 0 });
    expect(Math.abs(wrap(sol.values.J4.angle! - theta4(a, b, c, d, 0, true)))).toBeLessThan(1e-8);
  });
});

// ------------------------------------------------------------ joint types

describe('planar, pin-slot and ball joints', () => {
  const at = (type: JointType, q: Partial<Record<DofKey, number>>) => {
    const m = model(['g', 'b'], [joint('J', 'g', 'b', T(10, 0, 5), IDENTITY, { type, q: { angle: 0, angle2: 0, angle3: 0, offset: 0, x: 0, y: 0, ...q } })]);
    return solveKinematics(m).placements.b.matrix;
  };

  it('reads only the DOFs its type has: a ball joint made a revolute keeps no hidden pitch', () => {
    // bare numbers: degrees for angles, part units for lengths (as the worksheet's values)
    const value = (src: string | undefined, fallback: string, kind: 'L' | 'A') => Number(src?.trim() || fallback) * (kind === 'A' ? D : 1);
    const ball: CadJoint = { id: 'j', name: 'J', type: 'ball', a: { occ: 'a', origin: { kind: 'origin' } }, b: { occ: 'b', origin: { kind: 'origin' } }, angle: '30', offset: '2', angle2: '20', angle3: '10', x: '5' };
    expect(jointParams(ball, value)).toEqual({ angle: 30 * D, offset: 2, angle2: 20 * D, angle3: 10 * D });
    expect(jointParams({ ...ball, type: 'revolute' }, value)).toEqual({ angle: 30 * D, offset: 2 });
    expect(jointParams({ ...ball, type: 'pinslot' }, value)).toEqual({ angle: 30 * D, offset: 2, x: 5 });
  });

  it('planar: slides x, y in the plane and turns about its normal', () => {
    expect(JOINT_DOFS.planar).toEqual(['x', 'y', 'angle']);
    const M = at('planar', { x: 10, y: 20, angle: 30 * D });
    const p = m4Point(M, [1, 0, 0]);
    expect(p[0]).toBeCloseTo(20 + Math.cos(30 * D), 12);
    expect(p[1]).toBeCloseTo(20 + Math.sin(30 * D), 12);
    expect(p[2]).toBeCloseTo(5, 12);
  });

  it('pin-slot: turns about Z and slides along the slot (the parent’s X)', () => {
    expect(JOINT_DOFS.pinslot).toEqual(['angle', 'x']);
    const M = at('pinslot', { x: 15, angle: 90 * D });
    expect(m4Point(M, [0, 0, 0]).map((v) => +v.toFixed(12))).toEqual([25, 0, 5]);
    expect(m4Point(M, [1, 0, 0]).map((v) => +v.toFixed(12))).toEqual([25, 1, 5]);
  });

  it('ball: yaw, pitch and roll (Z–Y′–X″) about a fixed centre', () => {
    const [ps, th, ph] = [30 * D, 20 * D, 10 * D];
    const M = motionMatrix({ angle: ps, angle2: th, angle3: ph });
    // the direction cosine matrix of the 3-2-1 sequence (Diebel 2006, eq. 287; ISO 1151-2)
    const [cps, sps, cth, sth, cph, sph] = [Math.cos(ps), Math.sin(ps), Math.cos(th), Math.sin(th), Math.cos(ph), Math.sin(ph)];
    const R = [
      [cps * cth, cps * sth * sph - sps * cph, cps * sth * cph + sps * sph],
      [sps * cth, sps * sth * sph + cps * cph, sps * sth * cph - cps * sph],
      [-sth, cth * sph, cth * cph],
    ];
    for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) expect(M[4 * k + i]).toBeCloseTo(R[i][k], 14);
    // the centre stays put whatever the angles
    expect(m4Point(at('ball', { angle: ps, angle2: th, angle3: ph }), [0, 0, 0]).map((x) => +x.toFixed(12))).toEqual([10, 0, 5]);
  });

  it('ball joints close a spatial loop; a rod between two balls keeps the spin about its own axis free', () => {
    // a crank turning about Z, a 100 mm rod on balls at both ends, its far end on a fixed point
    const crank = 30, far: Vec3 = [80, 20, 50];
    const m = model(['g', 'crank', 'rod'], [
      joint('C', 'g', 'crank', IDENTITY, IDENTITY, { q: { angle: 40 * D, angle2: 0, angle3: 0, offset: 0, x: 0, y: 0 } }),
      joint('S1', 'crank', 'rod', T(crank), IDENTITY, { type: 'ball', free: ['angle', 'angle2', 'angle3'], rest: { angle2: -30 * D } }),
      joint('S2', 'g', 'rod', T(...far), T(Math.hypot(80 - crank * Math.cos(40 * D), 20 - crank * Math.sin(40 * D), 50)), { type: 'ball', free: ['angle', 'angle2', 'angle3'] }),
    ]);
    const sol = solveKinematics(m);
    expect(sol.errors).toEqual({});
    const end = m4Point(sol.placements.rod.matrix, [Math.hypot(80 - crank * Math.cos(40 * D), 20 - crank * Math.sin(40 * D), 50), 0, 0]);
    expect(Math.hypot(...end.map((v, i) => v - far[i]))).toBeLessThan(1e-8);
    expect(sol.mobility).toBe(1);
  });

  it('a spatial RSSR linkage follows its closure equation P·cos θ4 + Q·sin θ4 = R', () => {
    // input crank a about Z at the origin, output crank c about the world X at O4 = (d, 0, h),
    // coupler b on balls. |B − A| = b with A = a(cos θ2, sin θ2, 0), B = O4 + c(0, cos θ4, sin θ4):
    // P = −2ac·sin θ2, Q = 2hc, R = b² − (d − a cos θ2)² − a² sin² θ2 − h² − c²
    const [a, b, c, d, h] = [10, 93, 70, 60, 10];
    const theta = (t2: number) => {
      const P = -2 * a * c * Math.sin(t2), Q = 2 * h * c, R = b * b - (d - a * Math.cos(t2)) ** 2 - (a * Math.sin(t2)) ** 2 - h * h - c * c;
      return Math.atan2(Q, P) + Math.acos(R / Math.hypot(P, Q));
    };
    const balls = { type: 'ball' as const, free: ['angle', 'angle2', 'angle3'] as DofKey[] };
    const m = model(['g', 'crank', 'rod', 'rocker'], [
      joint('J1', 'g', 'crank', IDENTITY, IDENTITY),
      joint('S1', 'crank', 'rod', T(a), IDENTITY, balls),
      joint('S2', 'rod', 'rocker', T(b), T(c), balls),
      joint('J4', 'g', 'rocker', m4Frame([d, 0, h], [0, 1, 0], [0, 0, 1], [1, 0, 0]), IDENTITY, { free: ['angle'], rest: { angle: theta(0) } }),
    ]);
    let from: Record<string, Partial<Record<DofKey, number>>> | undefined;
    for (let deg = 0; deg <= 360; deg += 30) {
      const sol = solveKinematics(m, { drive: { J1: { angle: deg * D } }, ...(from ? { from } : {}) });
      from = sol.values;
      expect(sol.errors).toEqual({});
      expect(Math.abs(wrap(sol.values.J4.angle! - theta(deg * D)))).toBeLessThan(1e-8);
      // the coupler's spin about its own axis is the one DOF left
      expect(sol.mobility).toBe(1);
    }
  });
});

// ------------------------------------------------------------ a study's results

describe('a motion study in the worksheet', () => {
  it('has no value of a joint at an input the mechanism cannot reach', () => {
    // the triple rocker from 90° down to 0°: it stops at θ2 = acos(16500/18000) ≈ 23.56°
    const [A, B, C, Dd] = [90, 120, 80, 100];
    const m = fourBar(A, B, C, Dd, 90 * D, open(A, B, C, Dd, 90 * D));
    const study = { id: 's', name: 'Swing', duration: 1, steps: 18, tracks: [{ joint: 'J1', dof: 'angle' as const, keys: [{ t: 0, v: '90' }, { t: 1, v: '0' }] }] };
    const params = { s: { 'v:0:0': 90 * D, 'v:0:1': 0 } };
    const sol = solveKinematics(m);
    const kin = { model: m, values: sol.values, parent: sol.parent, mobility: sol.mobility };
    const r = motionResult(kin, study, runMotion(kin, study, params));
    expect(r.warning).toMatch(/stops at J1 = 23\.5\d*°/);
    const of = (motionValue(study, r, kin, 'mm').of as Record<string, (x: unknown) => unknown>).J4;
    // within reach: Freudenstein's θ4 (open circuit) at θ2 = 50°
    const t4 = (of(math.unit(50, 'deg')) as Unit).toNumber('rad');
    expect(Math.abs(wrap(t4 - theta4(A, B, C, Dd, 50 * D, true)))).toBeLessThan(1e-8);
    // past the dead point: an error (a gap in a plot), not the angle where it stopped
    expect(() => of(math.unit(10, 'deg'))).toThrow(/J1: the angle stops at J1 = 23\.5\d*°/);
  });
});

// ------------------------------------------------------------ as built

describe('as-built joints', () => {
  it('hold the parts where they stand: a revolute at 0 reproduces the placement, then turns about the picked axis', () => {
    const A = m4Pose([10, 20, 5], [0, 0, 30]), B = m4Pose([60, -10, 15], [20, 10, 75]);
    // picked on B: a point with Z along B's own X
    const F = m4Frame([3, 4, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0]);
    const far = asBuiltOrigin(A, B, F);
    const design: CadDesign = {
      version: 2, components: [{ id: 'c', name: 'C', items: [] }],
      occurrences: [{ id: 'a', component: 'c', grounded: true, pos: [10, 20, 5], rot: [0, 0, 30] }, { id: 'b', component: 'c' }],
      joints: [{ id: 'j', name: 'J', type: 'revolute', a: { occ: 'a', origin: far }, b: { occ: 'b', origin: { kind: 'origin' } }, angle: '0', offset: '0' }],
    };
    const numbers: DesignNumbers = { sketches: {}, frames: {}, params: { j: { angle: 0, offset: 0 } }, errors: {} };
    const frames = new Map([['j', { Fa: jointFrame(numbers, far), Fb: F }]]);
    const at0 = solveKinematics(kinModel(design, numbers, frames)).placements.b.matrix;
    at0.forEach((v, i) => expect(v).toBeCloseTo(B[i], 12));
    // turned 90°: the picked point stays, B's X axis (the joint's Z) stays
    numbers.params.j.angle = 90 * D;
    const at90 = solveKinematics(kinModel(design, numbers, frames)).placements.b.matrix;
    const p0 = m4Point(B, [3, 4, 0]), p1 = m4Point(at90, [3, 4, 0]);
    p0.forEach((v, i) => expect(p1[i]).toBeCloseTo(v, 12));
    const x0 = m4Point(B, [13, 4, 0]), x1 = m4Point(at90, [13, 4, 0]);
    x0.forEach((v, i) => expect(x1[i]).toBeCloseTo(v, 12));
  });

  it('leave a free part where it stands, not where the new joint at the component origins would pull it', () => {
    // a part typed 200 along X and turned 30°, joined to the ground at both origins: the joint
    // as first made pulls it onto the ground's origin; as built from the placements without it, it stays
    const pose = m4Pose([200, 0, 0], [0, 0, 30]);
    const m: KinModel = { occs: [{ id: 'g', pose: IDENTITY, grounded: true }, { id: 'f', pose }], joints: [joint('J', 'g', 'f', IDENTITY, IDENTITY, { type: 'rigid' })], links: [], size: 200 };
    expect(solveKinematics(m).placements.f.matrix[12]).toBeCloseTo(0, 12);
    const P = placementsWithout(m, 'J');
    expect(P.f.by).toBe('free');
    // picked on f: a point 10 along its own X, Z up
    const F = m4Translate([10, 0, 0]);
    const far = asBuiltOrigin(P.g.matrix, P.f.matrix, F);
    m.joints[0] = joint('J', 'g', 'f', jointFrame({ sketches: {}, frames: {}, params: {}, errors: {} }, far), F, { type: 'rigid' });
    solveKinematics(m).placements.f.matrix.forEach((v, i) => expect(v).toBeCloseTo(pose[i], 12));
  });

  it('lock a mechanism: a rigid one from the ground to the coupler fits, and the crank then cannot turn', () => {
    const [a, b, c, d] = [40, 120, 80, 100];
    const m = fourBar(a, b, c, d, 40 * D, open(a, b, c, d, 40 * D));
    const free = solveKinematics(m);
    const Mc = free.placements.coupler.matrix;
    m.joints.push(joint('L', 'ground', 'coupler', jointFrame({ sketches: {}, frames: {}, params: {}, errors: {} }, asBuiltOrigin(IDENTITY, Mc, IDENTITY)), IDENTITY, { type: 'rigid' }));
    const held = solveKinematics(m);
    expect(held.errors).toEqual({});
    expect(held.mobility).toBe(0);
    held.placements.coupler.matrix.forEach((v, i) => expect(v).toBeCloseTo(Mc[i], 9));
    // driven on, it stops where it stands: no movement at all is possible
    const on = solveKinematics(m, { drive: { J1: { angle: 60 * D } }, from: held.values });
    expect(on.warnings.J1).toMatch(/^the angle stops at J1 = 40°: the loop cannot close beyond/);
    on.placements.coupler.matrix.forEach((v, i) => expect(v).toBeCloseTo(Mc[i], 6));
  });
});

// ------------------------------------------------------------ the solver itself

describe('Levenberg–Marquardt', () => {
  it('solves Rosenbrock’s banana as residuals (10(y − x²), 1 − x) from (−1.2, 1)', () => {
    const { x } = levenbergMarquardt(([p, q]) => [10 * (q - p * p), 1 - p], [-1.2, 1]);
    expect(x[0]).toBeCloseTo(1, 10);
    expect(x[1]).toBeCloseTo(1, 10);
  });

  it('ranks matrices', () => {
    expect(rankOf([[1, 2, 3], [2, 4, 6], [0, 1, 1]])).toBe(2);
    expect(rankOf([[1, 0], [0, 1e-12]])).toBe(1);
  });
});

// ------------------------------------------------------------ assemblies without loops: as before

/** The placement as it was before loops were solved (verbatim, for the comparison). */
function placeBefore(design: CadDesign, numbers: DesignNumbers, frames: Map<string, { Fa: M4; Fb: M4 }>) {
  const placements: Record<string, Placement> = {};
  const errors: Record<string, string> = {};
  const occ = design.occurrences;
  const pose = (o: (typeof occ)[number]) => m4Pose(o.pos, o.rot);
  for (const o of occ) if (o.grounded) placements[o.id] = { matrix: pose(o), by: 'ground' };
  if (!Object.keys(placements).length && occ.length) placements[occ[0].id] = { matrix: pose(occ[0]), by: 'ground' };
  const live = design.joints.filter((j) => !j.suppressed);
  const motion = (j: CadJoint, angle: number, offset: number) => {
    let M = m4Mul(m4Translate([0, 0, offset]), m4Rotate([0, 0, 0], [0, 0, 1], angle));
    if (j.flip) M = m4Mul(M, m4Rotate([0, 0, 0], [1, 0, 0], Math.PI));
    return M;
  };
  const fr = new Map([...frames].map(([id, f]) => {
    const j = live.find((q) => q.id === id)!, p = numbers.params[id] ?? {};
    return [id, { ...f, M: motion(j, p.angle ?? 0, p.offset ?? 0) }];
  }));
  const done = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const j of live) {
      const f = fr.get(j.id);
      if (!f || done.has(j.id)) continue;
      const A = placements[j.a.occ], B = placements[j.b.occ];
      if (A && B) {
        done.add(j.id);
        const want = m4Mul(m4Mul(m4Mul(A.matrix, f.Fa), f.M), m4Inv(f.Fb));
        const err = Math.max(...want.map((v, k) => Math.abs(v - B.matrix[k]) / (k >= 12 ? 1 + Math.abs(v) : 1)));
        if (err > 1e-6) errors[j.id] = 'this joint closes a loop that does not fit — it is ignored';
        continue;
      }
      if (A) placements[j.b.occ] = { matrix: m4Mul(m4Mul(m4Mul(A.matrix, f.Fa), f.M), m4Inv(f.Fb)), by: 'joint' };
      else if (B) placements[j.a.occ] = { matrix: m4Mul(m4Mul(m4Mul(B.matrix, f.Fb), m4Inv(f.M)), m4Inv(f.Fa)), by: 'joint' };
      else continue;
      done.add(j.id);
      progress = true;
    }
  }
  for (const o of occ) placements[o.id] ??= { matrix: pose(o), by: 'free' };
  return { placements, errors };
}

describe('assemblies saved before loops were solved', () => {
  const frame = (o: Vec3, z: Vec3, x?: Vec3) => ({ kind: 'frame' as const, o, z, ...(x ? { x } : {}) });
  const j = (id: string, type: JointType, a: [string, ReturnType<typeof frame>], b: [string, ReturnType<typeof frame>], angle: number, offset: number, flip?: boolean): CadJoint =>
    ({ id, name: id, type, a: { occ: a[0], origin: a[1] }, b: { occ: b[0], origin: b[1] }, angle: `${angle}`, offset: `${offset}`, ...(flip ? { flip } : {}) });
  const designs: CadDesign[] = [
    // a chain of every old joint type, with flips, a free occurrence and a joint between two free ones
    {
      version: 2, components: [{ id: 'c', name: 'C', items: [] }],
      occurrences: [
        { id: 'o1', component: 'c', grounded: true, pos: [5, -3, 2], rot: [10, 20, 30] },
        { id: 'o2', component: 'c', pos: [100, 0, 0] }, { id: 'o3', component: 'c' }, { id: 'o4', component: 'c', rot: [0, 0, 45] },
        { id: 'o5', component: 'c', pos: [1, 2, 3] }, { id: 'o6', component: 'c', pos: [7, 7, 7] }, { id: 'o7', component: 'c' },
      ],
      joints: [
        j('j3', 'cylindrical', ['o3', frame([1, 2, 3], [0, 1, 1])], ['o4', frame([-4, 0, 2], [1, 0, 0], [0, 1, 0])], 33, 7, true),
        j('j1', 'revolute', ['o1', frame([10, 0, 0], [0, 0, 1])], ['o2', frame([0, 5, 0], [1, 1, 0])], 47, 3),
        j('j2', 'slider', ['o2', frame([3, 3, 3], [0, 0, 1])], ['o3', frame([0, 0, 0], [0, 1, 0])], 12, -9),
        j('j4', 'rigid', ['o4', frame([2, 0, 0], [0, 0, 1])], ['o5', frame([0, 0, 1], [0, 0, -1])], 90, 0, true),
        j('j5', 'revolute', ['o6', frame([0, 0, 0], [0, 0, 1])], ['o7', frame([0, 0, 0], [0, 0, 1])], 10, 0),
      ],
    },
    // a loop that fits (two joints between the same pair, consistent) and one that does not
    {
      version: 2, components: [{ id: 'c', name: 'C', items: [] }],
      occurrences: [{ id: 'g', component: 'c', grounded: true }, { id: 'a', component: 'c' }, { id: 'b', component: 'c', grounded: true, pos: [50, 0, 0] }],
      joints: [
        j('k1', 'revolute', ['g', frame([0, 0, 0], [0, 0, 1])], ['a', frame([0, 0, 0], [0, 0, 1])], 30, 0),
        j('k2', 'rigid', ['g', frame([0, 0, 0], [0, 0, 1])], ['a', frame([0, 0, 0], [0, 0, 1])], 30, 0),
        j('k3', 'revolute', ['a', frame([20, 0, 0], [0, 0, 1])], ['b', frame([0, 0, 0], [0, 0, 1])], 0, 0),
      ],
    },
  ];
  for (const [i, design] of designs.entries()) {
    it(`places design ${i + 1} exactly as before`, () => {
      const params: DesignNumbers['params'] = {};
      for (const jt of design.joints) params[jt.id] = { angle: Number(jt.angle) * D, offset: Number(jt.offset) };
      const numbers: DesignNumbers = { sketches: {}, frames: {}, params, errors: {}, unit: 'mm' };
      const frames = new Map(design.joints.map((jt) => [jt.id, { Fa: jointFrame(numbers, jt.a.origin), Fb: jointFrame(numbers, jt.b.origin) }]));
      const before = placeBefore(design, numbers, frames);
      const now = solveKinematics(kinModel(design, numbers, frames));
      // bit for bit: the same products in the same order
      expect(now.placements).toEqual(before.placements);
      expect(Object.keys(now.errors)).toEqual(Object.keys(before.errors));
      for (const id of Object.keys(before.errors)) expect(now.errors[id]).toMatch(/^this joint closes a loop that does not fit — it is ignored/);
    });
  }
});
