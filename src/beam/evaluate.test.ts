import { describe, it, expect } from 'vitest';
import { evaluateWorksheet, type BeamResult, type MathResult } from '../engine/evaluator';
import { createRegion, emptyWorksheet, type BeamRegion } from '../model/types';
import { splitMember, removeItems, type BeamData } from './model';

function simpleBeam(): BeamData {
  return {
    nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 6, y: 0 }],
    members: [{ id: 'm', a: 'a', b: 'b' }],
    supports: [{ id: 's1', node: 'a', type: 'pin', angle: 0, label: 'A' }, { id: 's2', node: 'b', type: 'roller', angle: 0, label: 'B' }],
    loads: [
      { id: 'q', type: 'line', member: 'm', q1: 'q', dir: 'global' },
      { id: 'P', type: 'force', at: { member: 'm', t: 0.5 }, value: 'P', angle: -90 },
    ],
  };
}

function run(data: BeamData, lines: string[], extra: Partial<BeamRegion> = {}) {
  const ws = emptyWorksheet();
  const pre = ['q := 10 kN/m', 'P := 20 kN'].map((s, i) => createRegion('math', 20, 20 + 20 * i, { source: s }));
  const beam = createRegion('beam', 20, 100, { name: 'b', ...data, ...extra }) as BeamRegion;
  const maths = lines.map((s, i) => createRegion('math', 20, 500 + 20 * i, { source: s }));
  ws.regions = [...pre, beam, ...maths];
  const out = evaluateWorksheet(ws);
  const tex = (i: number) => {
    const m = out.results.get(maths[i].id) as MathResult;
    expect(m.error, lines[i]).toBeUndefined();
    return m.tex;
  };
  return { res: out.results.get(beam.id) as BeamResult, tex };
}

describe('beam region in a worksheet', () => {
  it('reads loads from the worksheet and exports reactions, extremes and functions', () => {
    const { res, tex } = run(simpleBeam(), ['b.A.Ry = kN', 'b.M_max = kN*m', 'b.M(3 m) = kN*m', 'b.V(1 m) = kN', 'b.w(3 m) = mm', 'b.σ_max = MPa', 'b.L = m']);
    expect(res.error).toBeUndefined();
    // 10 kN/m over 6 m plus 20 kN at midspan: R = 40 kN, M = 45 + 30 = 75 kN·m
    expect(tex(0)).toContain('40');
    expect(tex(1)).toContain('75');
    expect(tex(2)).toContain('75');
    expect(tex(3)).toContain('30'); // 40 − 10·1
    const EI = 210e9 * 8356e-8;
    const w = (5 * 10e3 * 6 ** 4) / (384 * EI) + (20e3 * 6 ** 3) / (48 * EI);
    expect(tex(4)).toContain((-w * 1000).toFixed(4));
    expect(tex(5)).toContain('134.6');
    expect(tex(6)).toContain('6');
  });

  it('reports bad expressions and unstable structures', () => {
    const d = simpleBeam();
    d.loads[1] = { ...d.loads[1], value: '5 m' } as BeamData['loads'][number];
    const bad = run(d, []).res;
    expect(bad.errors.P).toMatch(/units like kN/);
    const mech = simpleBeam();
    mech.supports[0].type = 'roller';
    expect(run(mech, []).res.error).toMatch(/mechanism/);
  });

  it('splits members and keeps loads on the right piece', () => {
    const d = simpleBeam();
    const { data, node } = splitMember(d, 'm', 0.25);
    expect(data.members).toHaveLength(2);
    expect(data.nodes.find((q) => q.id === node)).toMatchObject({ x: 1.5, y: 0 });
    // the line load is split in two, the point load moves to the second piece at the same spot
    expect(data.loads.filter((l) => l.type === 'line')).toHaveLength(2);
    const P = data.loads.find((l) => l.id === 'P')!;
    expect(P.type === 'force' && 'member' in P.at && P.at.t).toBeCloseTo((0.5 - 0.25) / 0.75, 12);
    // same answer after the split
    const a = run(simpleBeam(), ['b.M_max = kN*m']).tex(0);
    const b = run(data, ['b.M_max = kN*m']).tex(0);
    expect(b).toBe(a);
    // removing a node takes its members, supports and loads with it
    const r = removeItems(data, new Set([node]));
    expect(r.members).toHaveLength(0);
    expect(r.loads).toHaveLength(0);
  });
});
