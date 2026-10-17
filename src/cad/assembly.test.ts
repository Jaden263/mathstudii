// Assembly motion through the worksheet, as the app evaluates it: the four-bar example
// against Freudenstein's equation, its motion study and clearance, interference found at
// a known configuration, rigid groups, explode offsets and the bill of materials; and the
// example worksheets with joints placing exactly as before loops were solved.
import { beforeAll, describe, expect, it } from 'vitest';
import { evaluateWorksheet, type CadResult, type MathResult } from '../engine/evaluator';
import { createRegion, emptyWorksheet, type CadRegion } from '../model/types';
import { EXAMPLES, fourBarDesign } from '../model/examples';
import { designOf, jointFrame, type CadDesign, type CadJoint, type DesignItem, type Placement } from './design';
import { designNumbers } from './keys';
import { bomCsv, bomTable, bomTsv } from './bom';
import { autoExplode, explodeShifts, explodedPlacements } from './explode';
import { motionMatrix } from './kinematics';
import { initKernel, kernel, m4Inv, m4Mul, m4Point, m4Pose, type M4 } from './solid';
import { rect, watchHandles } from './occ/fixtures';
import { buildDesignCached } from './occ/build';
import { occ } from './occ/kernel';
import { clearanceOcc } from './occ/motion';
import { interpolate, joinedPairs, runMotion } from './motion';
import { meshBuildResult } from './buildResult';

beforeAll(async () => {
  await initKernel();
});

const D = Math.PI / 180;

/** The four-bar example's values (Norton's crank-rocker: r1 = 100, r2 = 40, r3 = 120, r4 = 80 mm). */
const FOUR_BAR = [
  'r_1 := 100 mm', 'r_2 := 40 mm', 'r_3 := 120 mm', 'r_4 := 80 mm', 'w_l := 12 mm', 't_l := 5 mm', 't_g := 8 mm', 's_g := 1 mm', 'd_p := 6 mm',
  'd_s := 10 mm', 'r_s := 60 mm', 'φ_s := 140 deg',
];

function evaluate(design: CadDesign, pre: string[], after: string[] = []) {
  const ws = emptyWorksheet();
  const before = pre.map((s, i) => createRegion('math', 20, 20 + 20 * i, { source: s }));
  const cad = createRegion('cad', 20, 600, { name: 'fb', design, density: '7850 kg/m^3' }) as CadRegion;
  const maths = after.map((s, i) => createRegion('math', 20, 900 + 20 * i, { source: s }));
  ws.regions = [...before, cad, ...maths];
  const out = evaluateWorksheet(ws);
  const res = out.results.get(cad.id) as CadResult;
  const math = (i: number) => out.results.get(maths[i].id) as MathResult;
  return { res, math };
}

/** θ4 of the open circuit (Norton eq. 4.10). */
function theta4(r1: number, r2: number, r3: number, r4: number, t2: number) {
  const K1 = r1 / r2, K2 = r1 / r4, K3 = (r2 * r2 - r3 * r3 + r4 * r4 + r1 * r1) / (2 * r2 * r4);
  const A = Math.cos(t2) - K1 - K2 * Math.cos(t2) + K3, B = -2 * Math.sin(t2), C = K1 - (K2 + 1) * Math.cos(t2) + K3;
  return 2 * Math.atan2(-B - Math.sqrt(B * B - 4 * A * C), 2 * A);
}
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

describe('the four-bar example', () => {
  for (const deg of [0, 40, 135, 250]) {
    it(`puts the rocker where Freudenstein's equation does at θ2 = ${deg}°`, () => {
      const { res, math } = evaluate(fourBarDesign(), [...FOUR_BAR, `θ_2 := ${deg} deg`], ['fb.θ4 = deg', 'fb.Pin_A = deg']);
      expect(res.error).toBeUndefined();
      expect(res.featureError).toBeUndefined();
      const dr = res.design!;
      expect(dr.errors).toEqual({});
      const t4 = dr.kin!.values.j4.angle!;
      expect(Math.abs(wrap(t4 - theta4(100, 40, 120, 80, deg * D)))).toBeLessThan(1e-8);
      // the rocker's body in the assembly: its frame turned by θ4 about the pivot
      const M = dr.placements.or.matrix;
      expect(Math.abs(wrap(Math.atan2(M[1], M[0]) - t4))).toBeLessThan(1e-9);
      expect(math(0).error).toBeUndefined();
      expect(math(0).tex).toContain((((t4 / D) % 360 + 540) % 360 - 180).toFixed(2).replace(/\.?0+$/, '').slice(0, 4));
    });
  }

  it('samples its motion study once round and finds the stop’s clearance', () => {
    const { res, math } = evaluate(fourBarDesign(), [...FOUR_BAR, 'θ_2 := 0 deg'], ['fb.Sweep.c_min = mm', 'fb.Sweep.of.θ4(90 deg) = deg', 'fb.Sweep.t']);
    const m = res.design!.motions!.m1;
    expect(m.t).toHaveLength(181);
    expect(m.error).toBeUndefined();
    // every frame on the open circuit
    m.values.j1.angle!.forEach((t2, i) => expect(Math.abs(wrap(m.values.j4.angle![i] - theta4(100, 40, 120, 80, t2)))).toBeLessThan(1e-7));
    // the rocker swings out to where crank and coupler fold, |B − O2| = r3 − r2 (Norton §4.4):
    // θ4,max = 180° − acos((r1² + r4² − (r3 − r2)²) / (2 r1 r4)); the stop Ø10 at r_s = 60 from
    // the pivot at φ_s = 140° clears the rocker (12 wide) by 60·sin(φ_s − θ4,max) − 5 − 6
    const t4max = Math.PI - Math.acos((100 ** 2 + 80 ** 2 - 80 ** 2) / (2 * 100 * 80));
    const cmin = 60 * Math.sin(140 * D - t4max) - 5 - 6;
    const c = m.clearance!.map((f) => f.d);
    expect(Math.min(...c)).toBeGreaterThan(0);
    // sampled every 2° of the crank: within a hundredth of a millimetre of the extreme
    expect(Math.abs(Math.min(...c) - cmin)).toBeLessThan(0.02);
    expect(math(0).error).toBeUndefined();
    // θ4 at θ2 = 90°, solved exactly (not read off the frames)
    expect(math(1).tex).toContain(`= ${(((theta4(100, 40, 120, 80, 90 * D) / D) % 360) + 360) % 360}`.slice(0, 9));
  });

  it('finds the stop hitting the rocker when it stands closer', () => {
    const { res, math } = evaluate(fourBarDesign(), [...FOUR_BAR.filter((s) => !s.startsWith('φ_s')), 'φ_s := 132 deg', 'θ_2 := 0 deg'], ['fb.Sweep.c_min = mm', 'max(fb.Sweep.V_int) = mm^3']);
    const m = res.design!.motions!.m1;
    const hits = m.clearance!.filter((f) => f.v > 0);
    expect(hits.length).toBeGreaterThan(0);
    for (const f of hits) expect(f.hits).toEqual([['or', 'ost']]);
    expect(math(0).tex).toMatch(/= 0\\ \\mathrm\{mm\}$/);
    expect(math(1).error).toBeUndefined();
  });
});

describe('interference at a known configuration', () => {
  // a 10 mm cube slides along X on a rail towards a 10 mm wall standing at x = 30…40
  const design = (): CadDesign => ({
    version: 2,
    components: [
      { id: 'cr', name: 'Rail', items: [{ kind: 'sketch', id: 'sr', name: 'S', plane: { ref: 'XY' }, sketch: rect('r', 0, 50, 60, 60) }, { kind: 'extrude', id: 'fr', name: 'E', sketch: 'sr', extent: { type: 'one', d: '10' }, op: 'new' }] },
      { id: 'cb', name: 'Block', items: [{ kind: 'sketch', id: 'sb', name: 'S', plane: { ref: 'XY' }, sketch: rect('b', 0, 0, 10, 10) }, { kind: 'extrude', id: 'fb', name: 'E', sketch: 'sb', extent: { type: 'one', d: '10' }, op: 'new' }] },
      { id: 'cw', name: 'Wall', items: [{ kind: 'sketch', id: 'sw', name: 'S', plane: { ref: 'XY' }, sketch: rect('w', 30, 0, 40, 10) }, { kind: 'extrude', id: 'fw', name: 'E', sketch: 'sw', extent: { type: 'one', d: '10' }, op: 'new' }] },
    ],
    occurrences: [{ id: 'or', component: 'cr', grounded: true }, { id: 'ob', component: 'cb' }, { id: 'ow', component: 'cw', grounded: true }],
    joints: [{
      id: 'js', name: 'Slide', type: 'slider', angle: '0', offset: 's',
      // the slide along X: Z of both frames along the world X
      a: { occ: 'or', origin: { kind: 'frame', o: [0, 0, 0], z: [1, 0, 0], x: [0, 1, 0] } }, b: { occ: 'ob', origin: { kind: 'frame', o: [0, 0, 0], z: [1, 0, 0], x: [0, 1, 0] } },
    }],
    motions: [{ id: 'mp', name: 'Push', duration: 1, steps: 5, clearance: true, tracks: [{ joint: 'js', dof: 'offset', keys: [{ t: 0, v: '0 mm' }, { t: 1, v: '25 mm' }] }] }],
  });

  it('measures the gap 20 − s until the cube meets the wall, then the shared volume 100·(s − 20) mm³', () => {
    const { res, math } = evaluate(design(), ['s := 0 mm'], ['fb.Push.c_min = mm', 'fb.Push.V_int', 'fb.Push.table']);
    const cl = res.design!.motions!.mp.clearance!;
    const s = [0, 5, 10, 15, 20, 25];
    cl.forEach((f, i) => {
      expect(f.d).toBeCloseTo(Math.max(0, 20 - s[i]), 9);
      expect(f.v).toBeCloseTo(Math.max(0, s[i] - 20) * 100, 6);
    });
    expect(cl[5].hits).toEqual([['ob', 'ow']]);
    // the rail the cube slides on is joined to it: left out
    expect(cl.every((f) => !f.pair || f.pair.join() !== 'ob,or')).toBe(true);
    expect(math(0).tex).toMatch(/= 0\\ \\mathrm\{mm\}$/);
    expect(math(1).error).toBeUndefined();
    expect(math(2).error).toBeUndefined();
  });
});

describe('clearance on the exact shapes', () => {
  it('deletes every OCCT object it makes', () => {
    const d = fourBarDesign();
    const { res } = evaluate(d, [...FOUR_BAR.filter((s) => !s.startsWith('φ_s')), 'φ_s := 132 deg', 'θ_2 := 0 deg']);
    const dr = res.design!, oc = occ()!;
    const built = buildDesignCached(oc, d, designNumbers(dr));
    const frames = runMotion(dr.kin!, { ...d.motions![0], steps: 12 }, dr.params);
    const watch = watchHandles(oc);
    try {
      const c = clearanceOcc(oc, built, d, frames, joinedPairs(dr.kin!));
      expect(c).toHaveLength(13);
      expect(watch.undeleted()).toEqual([]);
    } finally {
      watch.stop();
    }
  });
});

describe('rigid groups', () => {
  it('locks occurrences where they were: the second goes along with the first', () => {
    const bar = (id: string): DesignItem[] => [{ kind: 'sketch', id: `s${id}`, name: 'S', plane: { ref: 'XY' }, sketch: rect(id, 0, 0, 20, 5) }, { kind: 'extrude', id: `f${id}`, name: 'E', sketch: `s${id}`, extent: { type: 'one', d: '5' }, op: 'new' }];
    const rel = m4Mul(m4Inv(m4Pose([0, 0, 0])), m4Pose([30, 0, 0], [0, 0, 90]));
    const design: CadDesign = {
      version: 2,
      components: [{ id: 'g', name: 'G', items: bar('g') }, { id: 'p', name: 'P', items: bar('p') }, { id: 'q', name: 'Q', items: bar('q') }],
      occurrences: [{ id: 'og', component: 'g', grounded: true }, { id: 'op', component: 'p' }, { id: 'oq', component: 'q', pos: [500, 500, 0] }],
      joints: [{ id: 'j', name: 'Turn', type: 'revolute', a: { occ: 'og', origin: { kind: 'origin' } }, b: { occ: 'op', origin: { kind: 'origin' } }, angle: 'φ', offset: '0' }],
      groups: [{ id: 'gr', name: 'Group1', occs: ['op', 'oq'], rel: { oq: rel } }],
    };
    const { res } = evaluate(design, ['φ := 90 deg']);
    expect(res.design!.errors).toEqual({});
    const P = res.design!.placements;
    // Q stays 30 along P's X, turned a quarter: with P turned 90°, at (0, 30)
    expect(m4Point(P.oq.matrix, [0, 0, 0]).map((v) => +v.toFixed(9))).toEqual([0, 30, 0]);
    expect(P.oq.by).toBe('joint');
  });
});

describe('explode', () => {
  it('moves each occurrence out by its offset plus its parent’s, and auto-explodes along the joint axes', () => {
    const design = fourBarDesign();
    design.occurrences = design.occurrences.map((o) => (o.id === 'ok' ? { ...o, explode: { dir: [0, 0, 1], d: '20 mm' } } : o.id === 'ob' ? { ...o, explode: { dir: [0, 0, 1], d: '10 mm' } } : o));
    const { res } = evaluate(design, [...FOUR_BAR, 'θ_2 := 30 deg']);
    const dr = res.design!;
    const shifts = explodeShifts(design, dr.kin!.parent, dr.params);
    // the coupler hangs on the crank: 10 of its own and the crank's 20
    expect(shifts.ok).toEqual([0, 0, 20]);
    expect(shifts.ob).toEqual([0, 0, 30]);
    // the rocker hangs on the coupler (the loop's last joint is the closing one)
    expect(shifts.or).toEqual([0, 0, 30]);
    expect(shifts.og).toEqual([0, 0, 0]);
    const ex = explodedPlacements(dr.placements, explodeShifts(design, dr.kin!.parent, dr.params, 0.5));
    expect(ex.ob.matrix[14] - dr.placements.ob.matrix[14]).toBeCloseTo(15, 12);
    // auto: along the pins' Z, away from what each hangs on, apart by a fifth of their sizes along it
    const build = meshBuildResult(kernel()!, design, designNumbers(dr));
    const auto = autoExplode(design, build, dr.kin!);
    expect(Object.keys(auto).sort()).toEqual(['ob', 'ok', 'or', 'ost']);
    expect(auto.ok.dir).toEqual([0, 0, 1]);
    // the crank (5 thick, 1 above the ground's 8): half sizes 2.5 + 4 = 6.5, centres 7.5 apart,
    // so 1.2·6.5 − 7.5 = 0.3 would do; at least a fifth of 6.5
    expect(Number(auto.ok.d)).toBeCloseTo(1.3, 9);
  });
});

describe('bill of materials', () => {
  it('counts repeated occurrences and adds their masses', () => {
    const design = fourBarDesign();
    design.occurrences.push({ id: 'ok2', component: 'k', pos: [0, -200, 0] });
    const t = bomTable(design, { g: 0.2, k: 0.0185, b: 0.05, r: 0.035, st: 0.003 }, '7850 kg/m^3');
    expect(t.rows.map((r) => [r.name, r.qty])).toEqual([['Ground', 1], ['Crank', 2], ['Coupler', 1], ['Rocker', 1], ['Stop', 1]]);
    expect(t.rows[0].material).toBe('Steel');
    expect(t.total).toBeCloseTo(0.2 + 2 * 0.0185 + 0.05 + 0.035 + 0.003, 12);
    expect(bomTsv(t).split('\n')[0]).toBe('Item\tComponent\tQty\tMaterial\tMass each [kg]\tMass [kg]');
    expect(bomTsv(t).split('\n')[2]).toBe('2\tCrank\t2\tSteel\t0.0185\t0.037');
    expect(bomCsv(t).split('\n')[2]).toBe('2,Crank,2,Steel,0.0185,0.037');
  });
});

describe('motion study interpolation', () => {
  it('is linear, or eases in and out without overshooting a key (hand-calculated)', () => {
    expect(interpolate([0, 1], [0, 1], 0.25, false)).toBe(0.25);
    // two keys: the smoothstep 3s² − 2s³
    expect(interpolate([0, 1], [0, 1], 0.25, true)).toBeCloseTo(0.15625, 15);
    // keys (0, 0), (1, 1), (2, 3): the slope at the middle key is the weighted harmonic mean
    // of the secants 1 and 2: (3 + 3) / (3/1 + 3/2) = 4/3, zero at the ends; at t = 1.5
    // h00·1 + h10·(4/3) + h01·3 = 0.5 + 0.125·4/3 + 1.5 = 13/6
    expect(interpolate([0, 1, 2], [0, 1, 3], 1.5, true)).toBeCloseTo(13 / 6, 14);
    // a flat stretch stays flat (monotone)
    for (const t of [1.1, 1.5, 1.9]) expect(interpolate([0, 1, 2], [0, 10, 10], t, true)).toBeCloseTo(10, 12);
    // held before the first key and after the last
    expect(interpolate([1, 2], [5, 7], 0, true)).toBe(5);
    expect(interpolate([1, 2], [5, 7], 3, false)).toBe(7);
  });
});

// ------------------------------------------------------------ old documents

/** Placement as it was before loops were solved (copied from the version before). */
function placeBefore(design: CadDesign, params: Record<string, Record<string, number>>, frames: Map<string, { Fa: M4; Fb: M4 }>): Record<string, Placement> {
  const placements: Record<string, Placement> = {};
  const occ = design.occurrences;
  for (const o of occ) if (o.grounded) placements[o.id] = { matrix: m4Pose(o.pos, o.rot), by: 'ground' };
  if (!Object.keys(placements).length && occ.length) placements[occ[0].id] = { matrix: m4Pose(occ[0].pos, occ[0].rot), by: 'ground' };
  const live = design.joints.filter((j) => !j.suppressed);
  const done = new Set<string>();
  let progress = true;
  const M = (j: CadJoint) => motionMatrix({ angle: params[j.id]?.angle ?? 0, offset: params[j.id]?.offset ?? 0 }, j.flip);
  while (progress) {
    progress = false;
    for (const j of live) {
      const f = frames.get(j.id);
      if (!f || done.has(j.id)) continue;
      const A = placements[j.a.occ], B = placements[j.b.occ];
      if (A && B) {
        done.add(j.id);
        continue;
      }
      if (A) placements[j.b.occ] = { matrix: m4Mul(m4Mul(m4Mul(A.matrix, f.Fa), M(j)), m4Inv(f.Fb)), by: 'joint' };
      else if (B) placements[j.a.occ] = { matrix: m4Mul(m4Mul(m4Mul(B.matrix, f.Fb), m4Inv(M(j))), m4Inv(f.Fa)), by: 'joint' };
      else continue;
      done.add(j.id);
      progress = true;
    }
  }
  for (const o of occ) placements[o.id] ??= { matrix: m4Pose(o.pos, o.rot), by: 'free' };
  return placements;
}

describe('the example worksheets with joints', () => {
  for (const ex of EXAMPLES) {
    const ws = ex.make();
    const parts = ws.regions.filter((r): r is CadRegion => r.kind === 'cad' && designOf(r).joints.length > 0 && !designOf(r).joints.some((j) => j.dofs));
    if (!parts.length) continue;
    it(`${ex.name}: places its occurrences exactly as before`, () => {
      const out = evaluateWorksheet(ws);
      for (const r of parts) {
        const dr = (out.results.get(r.id) as CadResult).design!;
        const design = designOf(r);
        const numbers = designNumbers(dr);
        // joint origins on sketch points: the sketch planes as built
        const frames = new Map(design.joints.map((j) => [j.id, { Fa: jointFrame(numbers, j.a.origin, undefined, dr.frames), Fb: jointFrame(numbers, j.b.origin, undefined, dr.frames) }]));
        expect(dr.placements).toEqual(placeBefore(design, numbers.params, frames));
      }
    });
  }
});
