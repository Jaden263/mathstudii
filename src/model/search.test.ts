import { describe, expect, it } from 'vitest';
import { createRegion, emptyWorksheet, type BeamRegion, type MathRegion } from './types';
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
});
