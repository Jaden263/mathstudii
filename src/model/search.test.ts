import { describe, expect, it } from 'vitest';
import { createRegion, emptyWorksheet, type BeamRegion, type Frame3DRegion, type MathRegion } from './types';
import { findInWorksheet, replaceInRegion } from './search';

describe('find and replace', () => {
  const ws = {
    ...emptyWorksheet(),
    regions: [
      createRegion('math', 0, 0, { source: 'L := 6 m' }),
      createRegion('math', 0, 40, { source: 'M := q*L^2/8 + L_cr*0' }),
      createRegion('text', 0, 80, { markdown: 'Span {{L | m}}, Load' }),
      createRegion('beam', 0, 120, {
        name: 'b', nodes: [{ id: 'L', x: 0, y: 0 }],
        loads: [{ id: 'l1', type: 'line', member: 'm1', q1: 'q*L/L', dir: 'global' }],
      }),
    ],
  };
  const whole = { caseSensitive: true, wholeName: true };

  it('finds whole names only', () => {
    expect(findInWorksheet(ws, 'L', whole).map((h) => h.count)).toEqual([1, 1, 1, 2]);
    expect(findInWorksheet(ws, 'L', { caseSensitive: false, wholeName: false }).reduce((n, h) => n + h.count, 0)).toBeGreaterThan(5);
  });

  it('renames in expressions but leaves ids alone', () => {
    const m = replaceInRegion(ws.regions[1], 'L', 'L_span', whole)!;
    expect((m.region as MathRegion).source).toBe('M := q*L_span^2/8 + L_cr*0');
    const b = replaceInRegion(ws.regions[3], 'L', 'L_span', whole)!;
    const beam = b.region as BeamRegion;
    expect(beam.nodes[0].id).toBe('L');
    expect(beam.loads[0].type === 'line' && beam.loads[0].q1).toBe('q*L_span/L_span');
    expect(b.count).toBe(2);
    expect(replaceInRegion(ws.regions[0], 'zz', 'y', whole)).toBeNull();
  });

  it('renames in a 3-D frame without touching its ids, cases and profiles', () => {
    const f = createRegion('frame3d', 0, 0, {
      name: 'G', nodes: [{ id: 'n1', name: 'A', x: 'G', y: '0', z: '2*G' }],
      members: [{ id: 'm1', name: 'M1', a: 'n1', b: 'n1', section: 'G', relA: ['My'] }],
      sections: [{ id: 'G', name: 'S', profile: 'HEB 200', material: 'S355' }],
      loads: [{ id: 'l', type: 'line', member: 'm1', dir: 'Z', q1: '-G', case: 'G' }],
    }) as Frame3DRegion;
    const out = replaceInRegion(f, 'G', 'g_k', whole)!.region as Frame3DRegion;
    expect(out.nodes[0]).toMatchObject({ x: 'g_k', z: '2*g_k' });
    expect(out.members[0]).toMatchObject({ section: 'G', relA: ['My'] });
    expect(out.sections[0].id).toBe('G');
    expect(out.loads[0]).toMatchObject({ q1: '-g_k', case: 'G' });
    expect(out.name).toBe('g_k');
  });
});
