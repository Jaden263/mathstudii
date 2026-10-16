import { describe, it, expect } from 'vitest';
import { evaluateWorksheet, type Frame3DResult } from '../../engine/evaluator';
import { createRegion, emptyWorksheet, type Frame3DRegion } from '../../model/types';
import { frame3dResultsTsv } from './frame3dMenu';

describe('3-D frame results as a table', () => {
  it('the envelope takes its minima from the lower side', () => {
    // a 3 m cantilever along X: G = 10 kN down at the tip, W = 25 kN up. 1.35 G hogs the
    // clamp, M_y = −1.35 · 10 · 3 = −40.5 kN·m; G + 1.5 W lifts it, M_y = (37.5 − 10) · 3 = +82.5
    const frame = createRegion('frame3d', 20, 20, {
      name: 'f',
      nodes: [{ id: 'a', name: 'N1', x: '0', y: '0', z: '0' }, { id: 'b', name: 'N2', x: '3', y: '0', z: '0' }],
      members: [{ id: 'm', name: 'M1', a: 'a', b: 'b', section: 's' }],
      sections: [{ id: 's', name: 'S1', profile: 'IPE 300', material: 'S355' }],
      supports: [{ id: 'p', node: 'a', dofs: ['fixed', 'fixed', 'fixed', 'fixed', 'fixed', 'fixed'] }],
      loads: [{ id: 'g', type: 'node', node: 'b', Fz: '-10', case: 'G' }, { id: 'w', type: 'node', node: 'b', Fz: '25', case: 'W' }],
      loadCases: {
        cases: [{ id: 'G', name: 'G' }, { id: 'W', name: 'W' }],
        combos: [{ id: 'c1', name: 'C1', kind: 'ULS', factors: { G: '1.35' } }, { id: 'c2', name: 'C2', kind: 'ULS', factors: { G: '1', W: '1.5' } }],
        view: 'envelope',
      },
    }) as Frame3DRegion;
    const ws = emptyWorksheet();
    ws.regions = [frame];
    const res = evaluateWorksheet(ws).results.get(frame.id) as Frame3DResult;
    expect(res.view).toBe('envelope');
    const rows = frame3dResultsTsv(frame, res)!.split(/\r?\n/).map((l) => l.split('\t'));
    const head = rows.find((r) => r[0] === 'Member')!, m1 = rows.find((r) => r[0] === 'M1')!;
    expect(Number(m1[head.indexOf('My max')])).toBeCloseTo(82.5, 6);
    expect(Number(m1[head.indexOf('My min')])).toBeCloseTo(-40.5, 6);
    // the clamp's R_z: 13.5 kN (C1) and −27.5 kN (C2), on rows of their own
    const rz = (tag: string) => Number(rows.find((r) => r[0] === `N1 ${tag}`)![3]);
    expect(rz('max')).toBeCloseTo(13.5, 6);
    expect(rz('min')).toBeCloseTo(-27.5, 6);
  });
});
