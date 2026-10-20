import { describe, expect, it } from 'vitest';
import { evaluateWorksheet, type BeamResult } from '../engine/evaluator';
import { createRegion, emptyWorksheet, type BeamRegion } from '../model/types';
import { changeUnits, displayUnits, isNumberText, readNumber, tidy } from './units';
import type { BeamData } from './model';
import type { BeamSolution } from './solve';
import { toS } from '../ui/beam/beamGeom';

/** A frame with every kind of number in it: coordinates, loads, springs, a moving load. */
function frame(): BeamData & Partial<BeamRegion> {
  return {
    nodes: [{ id: 'n1', x: 0, y: 0 }, { id: 'n2', x: 4, y: 3 }, { id: 'n3', x: 9, y: 3 }, { id: 'n4', x: 9, y: 0 }],
    members: [{ id: 'm1', a: 'n1', b: 'n2' }, { id: 'm2', a: 'n2', b: 'n3' }, { id: 'm3', a: 'n4', b: 'n3' }],
    supports: [
      { id: 's1', node: 'n1', type: 'pin', angle: 0, label: 'A', k: '5000' },
      { id: 's2', node: 'n4', type: 'fixed', angle: 0, label: 'B', kr: '20000', settle: '5' },
    ],
    loads: [
      { id: 'L1', type: 'line', member: 'm1', q1: '4', dir: 'local' },
      { id: 'L2', type: 'line', member: 'm2', q1: '2', q2: '8', t1: 0.2, t2: 0.7, dir: 'global' },
      // with units of their own, and a variable that is a plain number (it took kN)
      { id: 'L3', type: 'line', member: 'm2', q1: 'q_k', dir: 'global' },
      { id: 'F1', type: 'force', at: { member: 'm1', t: 0.5 }, value: '12', angle: -45 },
      { id: 'F2', type: 'force', at: { node: 'n3' }, value: 'P', angle: 180 },
      { id: 'F3', type: 'force', at: { member: 'm2', t: 0.85 }, value: '3 kN', angle: -90 },
      { id: 'M1', type: 'moment', at: { node: 'n2' }, value: '8' },
    ],
    grid: 0.5,
    view: { cx: 4.5, cy: 1.5, zoom: 50 },
  };
}

function solve(extra: Partial<BeamRegion>) {
  const ws = emptyWorksheet();
  const pre = ['q_k := 3 kN/m', 'P := 5'].map((s, i) => createRegion('math', 20, 20 + 20 * i, { source: s }));
  const beam = createRegion('beam', 20, 100, { name: 'b', ...extra }) as BeamRegion;
  ws.regions = [...pre, beam];
  const res = evaluateWorksheet(ws).results.get(beam.id) as BeamResult;
  return { beam, res };
}

/** Every number of a solution (SI) next to the other's, to a relative `tol`. */
function expectSame(a: BeamSolution, b: BeamSolution, tol = 1e-9) {
  const big = Math.max(...a.members.flatMap((m) => [...m.M, ...m.V, ...m.N].map(Math.abs)), 1);
  const near = (x: number, y: number, scale: number) => expect(Math.abs(x - y)).toBeLessThanOrEqual(tol * scale);
  a.reactions.forEach((r, i) => {
    near(r.Rx, b.reactions[i].Rx, big);
    near(r.Ry, b.reactions[i].Ry, big);
    near(r.M, b.reactions[i].M, big);
  });
  a.members.forEach((m, i) => {
    const n = b.members[i];
    expect(n.s.length).toBe(m.s.length);
    m.M.forEach((v, j) => near(v, n.M[j], big));
    m.V.forEach((v, j) => near(v, n.V[j], big));
    const w = Math.max(...m.dy.map(Math.abs), 1e-12);
    m.dy.forEach((v, j) => near(v, n.dy[j], w));
  });
  near(a.max.M!.value, b.max.M!.value, big);
  near(a.max.w!.value, b.max.w!.value, a.max.w!.value);
}

describe('changing the units of a beam region', () => {
  it('converts m → mm and kN → N: the structure and its results stay the same', () => {
    const { beam, res } = solve(frame());
    expect(res.error).toBeUndefined();
    expect(res.bare).toContain('P');
    expect(res.bare).not.toContain('q_k');
    const patch = changeUnits(beam, { lengthUnit: 'mm', forceUnit: 'N' }, { bare: res.bare });
    const conv = { ...beam, ...patch };
    // coordinates and grid in mm; loads in N, N·mm, N/mm; springs N/mm and N·mm
    expect(conv.nodes[1]).toMatchObject({ x: 4000, y: 3000 });
    expect(conv.grid).toBe(500);
    const loads = Object.fromEntries(conv.loads.map((l) => [l.id, l]));
    expect(loads.F1).toMatchObject({ value: '12000' });
    expect(loads.M1).toMatchObject({ value: '8000000' });
    expect(loads.L1).toMatchObject({ q1: '4' }); // 4 kN/m = 4 N/mm
    expect(loads.L2).toMatchObject({ q1: '2', q2: '8', t1: 0.2, t2: 0.7 });
    // a unit of its own stays, a plain-number variable says the unit it meant
    expect(loads.L3).toMatchObject({ q1: 'q_k' });
    expect(loads.F3).toMatchObject({ value: '3 kN' });
    expect(loads.F2).toMatchObject({ value: '(P) kN' });
    expect(conv.supports[0].k).toBe('5000'); // kN/m = N/mm
    expect(conv.supports[1].kr).toBe('20000000000');
    // the settlement is in mm whatever the region's units
    expect(conv.supports[1].settle).toBe('5');
    const after = solve({ ...conv, name: 'b' }).res;
    expect(after.error).toBeUndefined();
    expectSame(res.solution!, after.solution!);
  });

  it('converts to feet and kips just as well, and back', () => {
    const { beam, res } = solve(frame());
    const us = { ...beam, ...changeUnits(beam, { lengthUnit: 'ft', forceUnit: 'kip' }, { bare: res.bare }) };
    const r2 = solve(us).res;
    expect(r2.error).toBeUndefined();
    // (feet and kips are not round factors: the numbers are kept to 15 digits)
    expectSame(res.solution!, r2.solution!, 1e-8);
    const back = { ...us, ...changeUnits(us, { lengthUnit: 'm', forceUnit: 'kN' }, { bare: r2.bare }) };
    expect(back.nodes[2]).toMatchObject({ x: 9, y: 3 });
    expect(back.loads.find((l) => l.id === 'F1')).toMatchObject({ value: '12' });
    expectSame(res.solution!, solve(back).res.solution!, 1e-8);
  });

  it('comes back to the same numbers through any units, without round-off piling up', () => {
    const { beam, res } = solve(frame());
    let r: BeamRegion = beam;
    const hops: [BeamRegion['lengthUnit'], BeamRegion['forceUnit']][] = [['mm', 'N'], ['in', 'MN'], ['cm', 'lbf'], ['ft', 'kip'], ['m', 'kN']];
    for (const [lengthUnit, forceUnit] of hops) r = { ...r, ...changeUnits(r, { lengthUnit, forceUnit }, { bare: res.bare }) };
    expect(r.nodes).toEqual(beam.nodes);
    expect(r.grid).toBe(0.5);
    expect(r.loads.find((l) => l.id === 'L2')).toMatchObject({ q1: '2', q2: '8' });
    expect(r.loads.find((l) => l.id === 'M1')).toMatchObject({ value: '8' });
    expect(r.supports[0].k).toBe('5000');
    expect(r.supports[1].kr).toBe('20000');
    expect(tidy(5 / 0.0254)).toBe(196.850393700787);
    expect(tidy(196.850393700787 * 0.0254)).toBe(5);
    expect(tidy(1234.56789012 * 1000)).toBe(1234567.89012);
  });

  it('keeps the picture: the view follows the coordinates', () => {
    const { beam } = solve(frame());
    const conv = { ...beam, ...changeUnits(beam, { lengthUnit: 'cm', forceUnit: 'kN' }) };
    beam.nodes.forEach((q, i) => {
      const a = toS({ view: beam.view, width: 560, height: 300 }, q);
      const b = toS({ view: conv.view, width: 560, height: 300 }, conv.nodes[i]);
      expect(b.x).toBeCloseTo(a.x, 9);
      expect(b.y).toBeCloseTo(a.y, 9);
    });
  });

  it('can keep the numbers instead, which then mean the new unit', () => {
    const { beam } = solve(frame());
    const patch = changeUnits(beam, { lengthUnit: 'mm', forceUnit: 'kN' }, { convert: false });
    expect(patch).toEqual({ lengthUnit: 'mm', forceUnit: 'kN' });
  });

  it('converts moving loads, influence-line sections and the step', () => {
    const r = {
      ...createRegion('beam', 0, 0, frame()),
      traffic: {
        lines: [{ id: 'il', name: 'M1', quantity: 'M' as const, at: { x: 2, y: 1.5 } }],
        loads: [
          { id: 't1', name: 'T', preset: 'train' as const, axles: [{ P: '100', a: '0' }, { P: '100', a: '2' }], q: '10' },
          { id: 't2', name: 'C', preset: 'crane' as const, P: '80', a: '3.5' },
          { id: 't3', name: 'LM1', preset: 'lm1' as const, alphaQ: '1', alphaq: '1', w: '3' },
        ],
        step: '0.25',
      },
    } as BeamRegion;
    const t = changeUnits(r, { lengthUnit: 'mm', forceUnit: 'N' }).traffic!;
    expect(t.step).toBe('250');
    expect(t.lines[0].at).toEqual({ x: 2000, y: 1500 });
    expect(t.loads[0]).toMatchObject({ axles: [{ P: '100000', a: '0' }, { P: '100000', a: '2000' }], q: '10' });
    expect(t.loads[1]).toMatchObject({ P: '80000', a: '3500' });
    // the lane width is in m and the factors are plain numbers
    expect(t.loads[2]).toMatchObject({ alphaQ: '1', alphaq: '1', w: '3' });
  });
});

describe('numbers typed into unit fields', () => {
  it('takes plain numbers, numbers with a unit and arithmetic', () => {
    expect(isNumberText(' -2.5e3 ')).toBe(true);
    expect(isNumberText('2*3')).toBe(false);
    expect(readNumber('2.5', 'm')).toBe(2.5);
    expect(readNumber('250 mm', 'm')).toBe(0.25);
    expect(readNumber('1.5 ft', 'in')).toBe(18);
    expect(readNumber('2.5 + 1.25', 'm')).toBe(3.75);
    expect(readNumber('90°', 'deg')).toBe(90);
    expect(readNumber('12 kN', 'm')).toBeNull();
    expect(readNumber('nonsense +', 'm')).toBeNull();
    expect(readNumber('', 'm')).toBeNull();
    expect(tidy(0.1 + 0.2)).toBe(0.3);
  });
});

describe('units the results are shown in', () => {
  it('follow the region unless chosen', () => {
    const auto = displayUnits({ lengthUnit: 'm', forceUnit: 'kN' });
    expect(auto).toEqual({ force: ['kN', 1e3], moment: ['kN·m', 1e3], line: ['kN/m', 1e3], defl: ['mm', 1e-3], stress: ['MPa', 1e6] });
    // line loads follow the force shown, per the region's length
    expect(displayUnits({ lengthUnit: 'mm', forceUnit: 'N', display: { force: 'kN' } }).line).toEqual(['kN/mm', 1e6]);
    expect(displayUnits({ lengthUnit: 'mm', forceUnit: 'N', display: { line: 'kN/m' } }).line).toEqual(['kN/m', 1e3]);
    expect(displayUnits({ lengthUnit: 'ft', forceUnit: 'kip' }).defl[0]).toBe('in');
    const own = displayUnits({ lengthUnit: 'm', forceUnit: 'kN', display: { moment: 'N·mm', force: 'N', defl: 'm', stress: 'ksi' } });
    expect(own.moment).toEqual(['N·mm', 1e-3]);
    expect(own.force).toEqual(['N', 1]);
    expect(own.defl).toEqual(['m', 1]);
    expect(own.stress[0]).toBe('ksi');
    // an unknown choice falls back to the automatic one
    expect(displayUnits({ lengthUnit: 'm', forceUnit: 'kN', display: { force: 'furlong' } }).force).toEqual(['kN', 1e3]);
  });
});
