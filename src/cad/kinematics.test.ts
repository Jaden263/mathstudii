// Assembly kinematics against closed forms: the four-bar linkage by Freudenstein's equation
// (Norton, Design of Machinery, 5th ed., §4.5, eq. 4.8 and 4.10), the slider-crank's
// piston x = r·cos θ + √(l² − r²·sin² θ) (Norton §4.6), gear and rack-and-pinion links,
// limits, the DOFs of the planar, pin-slot and ball joints, and the placements of
// assemblies without loops, which must stay exactly what they were.
import { describe, expect, it } from 'vitest';
import { JOINT_DOFS, type DofKey } from './assembly';
import { linkRatio } from './assemblyParams';
import { jointFrame, type CadDesign, type CadJoint, type DesignNumbers, type JointType, type Placement } from './design';
import { kinModel, levenbergMarquardt, motionMatrix, motionValues, rankOf, solveKinematics, type KinJoint, type KinModel } from './kinematics';
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
});

// ------------------------------------------------------------ joint types

describe('planar, pin-slot and ball joints', () => {
  const at = (type: JointType, q: Partial<Record<DofKey, number>>) => {
    const m = model(['g', 'b'], [joint('J', 'g', 'b', T(10, 0, 5), IDENTITY, { type, q: { angle: 0, angle2: 0, angle3: 0, offset: 0, x: 0, y: 0, ...q } })]);
    return solveKinematics(m).placements.b.matrix;
  };

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
    const v = motionValues('ball', M);
    expect([v.angle!, v.angle2!, v.angle3!].map((x) => x / D)).toEqual([expect.closeTo(30, 12), expect.closeTo(20, 12), expect.closeTo(10, 12)]);
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
