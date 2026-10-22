// What Set as value writes after a drive, checked by building the four-bar example again
// with it: driving the rocker (a solved DOF) writes the crank's angle, and a linkage that
// nothing drives keeps where it was moved to through its solved DOFs' rest values.
import { beforeAll, describe, expect, it } from 'vitest';
import { evaluateWorksheet, type CadResult } from '../../engine/evaluator';
import { createRegion, emptyWorksheet, type CadRegion } from '../../model/types';
import { fourBarDesign } from '../../model/examples';
import type { CadDesign, CadJoint } from '../../cad/design';
import { solveKinematics } from '../../cad/kinematics';
import { initKernel } from '../../cad/solid';
import { drivePatches } from './AssemblyPanels';

beforeAll(async () => {
  await initKernel();
});

const D = Math.PI / 180;
const VALUES = ['r_1 := 100 mm', 'r_2 := 40 mm', 'r_3 := 120 mm', 'r_4 := 80 mm', 'w_l := 12 mm', 't_l := 5 mm', 't_g := 8 mm', 's_g := 1 mm', 'd_p := 6 mm', 'd_s := 10 mm', 'r_s := 60 mm', 'φ_s := 140 deg', 'θ_2 := 40 deg'];

function build(design: CadDesign) {
  const ws = emptyWorksheet();
  const cad = createRegion('cad', 20, 600, { name: 'fb', design }) as CadRegion;
  ws.regions = [...VALUES.map((s, i) => createRegion('math', 20, 20 + 20 * i, { source: s })), cad];
  const dr = (evaluateWorksheet(ws).results.get(cad.id) as CadResult).design!;
  expect(dr.errors).toEqual({});
  return dr;
}

const apply = (design: CadDesign, patches: Record<string, Partial<CadJoint>>): CadDesign => ({ ...design, joints: design.joints.map((j) => (patches[j.id] ? { ...j, ...patches[j.id] } : j)) });

describe('Set as value after a drive', () => {
  it('drives the rocker: the crank’s angle is written, the rocker stays solved and comes out where it was dragged', () => {
    const design = fourBarDesign();
    const dr = build(design);
    const kin = dr.kin!;
    const sol = solveKinematics(kin.model, { drive: { j4: { angle: 100 * D } }, from: kin.values });
    expect(sol.warnings).toEqual({});
    const patches = drivePatches(design, sol.values, kin.values, { joint: 'j4', dof: 'angle' }, 'mm', 200);
    expect(Object.keys(patches)).toEqual(['j1']);
    expect(patches.j1.angle).toMatch(/^1[0-9]{2}\.\d+ deg$/);
    const again = build(apply(design, patches));
    // the angle is written to 10⁻⁴°; the rocker moves less than the crank near here
    expect(Math.abs(again.kin!.values.j4.angle! / D - 100)).toBeLessThan(1e-4);
    expect(again.kin!.values.j1.angle!).toBeCloseTo(sol.values.j1.angle!, 5);
  });

  it('a linkage nothing drives keeps where it was moved to (its solved DOFs’ rest values)', () => {
    // the crank solved too: one DOF left free, it stays where it was assembled
    const design = fourBarDesign();
    design.joints = design.joints.map((j) => (j.id === 'j1' ? { ...j, dofs: { angle: { free: true } } } : j));
    const dr = build(design);
    expect(dr.kin!.mobility).toBe(1);
    const sol = solveKinematics(dr.kin!.model, { drive: { j1: { angle: 90 * D } }, from: dr.kin!.values });
    expect(sol.warnings).toEqual({});
    const patches = drivePatches(design, sol.values, dr.kin!.values, { joint: 'j1', dof: 'angle' }, 'mm', 200);
    // nothing driven to write: the rest values of the solved DOFs that moved (j4 keeps its other settings)
    expect(Object.keys(patches).sort()).toEqual(['j1', 'j2', 'j3', 'j4']);
    expect(patches.j1.dofs?.angle).toEqual({ free: true, rest: '90 deg' });
    expect(patches.j4.dofs?.angle?.free).toBe(true);
    const again = build(apply(design, patches));
    for (const id of ['j1', 'j2', 'j3', 'j4']) expect(Math.abs(again.kin!.values[id].angle! - sol.values[id].angle!)).toBeLessThan(1e-5);
  });
});
