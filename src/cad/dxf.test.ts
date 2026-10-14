import { describe, it, expect } from 'vitest';
import { dxfToSketch, sketchToDxf } from './dxf';
import { findProfiles, profileProperties } from './profile';
import { pointMap, type CadArc, type CadSketch } from './model';

/** DXF text from code/value pairs. */
const dxf = (...pairs: (string | number)[]) => pairs.join('\n') + '\n';

function sample(): CadSketch {
  const pts: [string, number, number][] = [
    ['a', 0, 0], ['b', 100, 0], ['c', 100, 50], ['d', 0, 50], // rectangle
    ['h', 50, 25], // hole centre
    ['ac', 150, 0], ['a1', 150, -10], ['a2', 150, 10], // right half-circle arc
    ['k1', -20, 80], ['k2', 120, 80], // construction line
  ];
  return {
    points: pts.map(([id, x, y]) => ({ id, x, y })),
    entities: [
      { id: 'l1', type: 'line', p1: 'a', p2: 'b' },
      { id: 'l2', type: 'line', p1: 'b', p2: 'c' },
      { id: 'l3', type: 'line', p1: 'c', p2: 'd' },
      { id: 'l4', type: 'line', p1: 'd', p2: 'a' },
      { id: 'o', type: 'circle', c: 'h', r: 10 },
      { id: 'r', type: 'arc', c: 'ac', p1: 'a1', p2: 'a2' },
      { id: 'k', type: 'line', p1: 'k1', p2: 'k2', construction: true },
    ],
    constraints: [],
  };
}

/** Angle of the arc's midpoint, walking CCW from p1 to p2. */
function arcMid(s: CadSketch, e: CadArc) {
  const P = pointMap(s);
  const c = P.get(e.c)!, a = P.get(e.p1)!, b = P.get(e.p2)!;
  const a0 = Math.atan2(a.y - c.y, a.x - c.x);
  let a1 = Math.atan2(b.y - c.y, b.x - c.x);
  while (a1 <= a0) a1 += 2 * Math.PI;
  const r = Math.hypot(a.x - c.x, a.y - c.y);
  return { x: c.x + r * Math.cos((a0 + a1) / 2), y: c.y + r * Math.sin((a0 + a1) / 2), r };
}

describe('sketchToDxf / dxfToSketch round trip', () => {
  const text = sketchToDxf(sample(), 'mm');
  const { sketch, unit, warnings } = dxfToSketch(text);
  const P = pointMap(sketch);

  it('writes R12 sections and the unit', () => {
    expect(text).toContain('$ACADVER\n1\nAC1009');
    expect(text).toContain('$INSUNITS\n70\n4');
    expect(text).toMatch(/LAYER\n2\nCONSTRUCTION/);
    expect(text.trimEnd().endsWith('0\nEOF')).toBe(true);
    expect(unit).toBe('mm');
    expect(warnings).toEqual([]);
  });

  it('keeps entity counts and shares rectangle corners', () => {
    const types = sketch.entities.map((e) => e.type);
    expect(types.filter((t) => t === 'line')).toHaveLength(5);
    expect(types.filter((t) => t === 'circle')).toHaveLength(1);
    expect(types.filter((t) => t === 'arc')).toHaveLength(1);
    expect(sketch.constraints).toEqual([]);
    const rect = sketch.entities.filter((e) => e.type === 'line' && !e.construction);
    const corners = new Set(rect.flatMap((e) => (e.type === 'line' ? [e.p1, e.p2] : [])));
    expect(corners.size).toBe(4);
    // 4 corners + hole centre + 3 arc points + 2 construction ends
    expect(sketch.points).toHaveLength(10);
    const xy = [...corners].map((id) => [P.get(id)!.x, P.get(id)!.y]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    expect(xy).toEqual([[0, 0], [0, 50], [100, 0], [100, 50]]);
  });

  it('preserves construction, circle and arc direction', () => {
    const cons = sketch.entities.filter((e) => e.construction);
    expect(cons).toHaveLength(1);
    expect(cons[0].type).toBe('line');
    const circle = sketch.entities.find((e) => e.type === 'circle')!;
    if (circle.type !== 'circle') throw new Error();
    expect(circle.r).toBeCloseTo(10, 12);
    expect(P.get(circle.c)).toMatchObject({ x: 50, y: 25 });
    const arc = sketch.entities.find((e) => e.type === 'arc') as CadArc;
    expect(P.get(arc.p1)!.x).toBeCloseTo(150, 9);
    expect(P.get(arc.p1)!.y).toBeCloseTo(-10, 9);
    expect(P.get(arc.p2)!.y).toBeCloseTo(10, 9);
    const mid = arcMid(sketch, arc); // CCW from -90° to 90° passes through (160, 0)
    expect(mid.x).toBeCloseTo(160, 9);
    expect(mid.y).toBeCloseTo(0, 9);
  });

  it('imports the rectangle with a hole as one profile region', () => {
    const { regions } = findProfiles(sketch);
    expect(regions).toHaveLength(1);
    expect(regions[0].holes).toHaveLength(1);
    expect(profileProperties(regions)!.A).toBeCloseTo(5000 - Math.PI * 100, 8);
  });

  it('uses solver positions and radii when given', () => {
    const s = sample();
    const out = dxfToSketch(sketchToDxf(s, 'in', new Map([['c', { x: 120, y: 60 }]]), new Map([['o', 12.5]]))).sketch;
    const Q = pointMap(out);
    expect(out.points.some((p) => p.x === 120 && p.y === 60)).toBe(true);
    const circle = out.entities.find((e) => e.type === 'circle');
    expect(circle?.type === 'circle' && circle.r).toBe(12.5);
    expect(Q.size).toBe(10);
  });

  it('writes plain decimals', () => {
    const s: CadSketch = {
      points: [{ id: 'p', x: 1.23456789012345e-7, y: 123456789.123 }, { id: 'q', x: -1e-20, y: 2 / 3 }],
      entities: [{ id: 'l', type: 'line', p1: 'p', p2: 'q' }],
      constraints: [],
    };
    const t = sketchToDxf(s, 'm');
    expect(t).not.toMatch(/\d[eE][-+]?\d/);
    expect(t).toContain('\n10\n0.000000123456789\n');
    expect(t).toContain('\n20\n123456789.1\n');
    expect(t).toContain('\n11\n0\n');
    expect(t).toContain('\n21\n0.6666666667\n');
  });
});

describe('dxfToSketch', () => {
  // 40×20 slot: lines along y = 0 and y = 20, semicircles at both ends (bulge ±1)
  const slot = (verts: [number, number, number][]) =>
    dxf('0', 'SECTION', '2', 'ENTITIES', '0', 'LWPOLYLINE', '8', '0', '90', verts.length, '70', 1,
      ...verts.flatMap(([x, y, b]) => ['10', x, '20', y, ...(b ? ['42', b] : [])]), '0', 'ENDSEC', '0', 'EOF');

  function checkSlot(text: string) {
    const { sketch } = dxfToSketch(text);
    const P = pointMap(sketch);
    const lines = sketch.entities.filter((e) => e.type === 'line');
    const arcs = sketch.entities.filter((e): e is CadArc => e.type === 'arc');
    expect(lines).toHaveLength(2);
    expect(arcs).toHaveLength(2);
    const ends = new Set([...lines.flatMap((e) => (e.type === 'line' ? [e.p1, e.p2] : [])), ...arcs.flatMap((e) => [e.p1, e.p2])]);
    expect(ends.size).toBe(4);
    const mids = arcs.map((a) => ({ c: P.get(a.c)!, ...arcMid(sketch, a) })).sort((p, q) => p.c.x - q.c.x);
    expect(mids[0].c.x).toBeCloseTo(0, 12);
    expect(mids[0].c.y).toBeCloseTo(10, 12);
    expect(mids[0].r).toBeCloseTo(10, 12);
    expect(mids[0].x).toBeCloseTo(-10, 9); // bulges outward
    expect(mids[1].c.x).toBeCloseTo(40, 12);
    expect(mids[1].c.y).toBeCloseTo(10, 12);
    expect(mids[1].x).toBeCloseTo(50, 9);
    const { regions } = findProfiles(sketch);
    expect(regions).toHaveLength(1);
    expect(profileProperties(regions)!.A).toBeCloseTo(800 + Math.PI * 100, 8);
  }

  it('turns LWPOLYLINE bulges into arcs (CCW, bulge 1)', () => {
    checkSlot(slot([[0, 0, 0], [40, 0, 1], [40, 20, 0], [0, 20, 1]]));
  });

  it('keeps arcs CCW for negative bulges', () => {
    checkSlot(slot([[0, 0, -1], [0, 20, 0], [40, 20, -1], [40, 0, 0]]));
  });

  it('finds the centre of a partial bulge arc', () => {
    // quarter circle from (10, 0) to (0, 10) around the origin
    const t = slot([[10, 0, Math.tan(Math.PI / 8)], [0, 10, 0], [0, 0, 0]]);
    const { sketch } = dxfToSketch(t);
    const P = pointMap(sketch);
    const arc = sketch.entities.find((e): e is CadArc => e.type === 'arc')!;
    expect(P.get(arc.c)!.x).toBeCloseTo(0, 12);
    expect(P.get(arc.c)!.y).toBeCloseTo(0, 12);
    expect(P.get(arc.p1)).toMatchObject({ x: 10, y: 0 });
    // the arc centre coincides with the third vertex, so it shares that point
    expect(sketch.points).toHaveLength(3);
    expect(profileProperties(findProfiles(sketch).regions)!.A).toBeCloseTo(25 * Math.PI, 8);
  });

  it('reads old-style POLYLINE / VERTEX / SEQEND', () => {
    const v = (x: number, y: number, b = 0) => ['0', 'VERTEX', '8', '0', '10', x, '20', y, '30', 0, ...(b ? ['42', b] : [])];
    const t = dxf('0', 'SECTION', '2', 'ENTITIES', '0', 'POLYLINE', '8', '0', '66', 1, '70', 1,
      ...v(0, 0), ...v(40, 0, 1), ...v(40, 20), ...v(0, 20, 1), '0', 'SEQEND', '0', 'ENDSEC', '0', 'EOF');
    checkSlot(t);
  });

  it('tolerates CRLF, padded codes and a missing HEADER; reads construction layers', () => {
    const t = ['  0', 'SECTION', '  2', 'ENTITIES', '  0', 'LINE', '  8', 'Construction lines', ' 10', '1.5', ' 20', '2', ' 30', '7', ' 11', '3', ' 21', '4', '  0', 'POINT', '  8', 'GEO', ' 10', '5', ' 20', '6', '  0', 'ENDSEC', '  0', 'EOF', ''].join('\r\n');
    const { sketch, unit, warnings } = dxfToSketch(t);
    expect(unit).toBeNull();
    expect(warnings).toEqual([]);
    expect(sketch.entities.map((e) => [e.type, !!e.construction])).toEqual([['line', true], ['point', false]]);
    expect(sketch.points.map((p) => [p.x, p.y])).toEqual([[1.5, 2], [3, 4], [5, 6]]);
  });

  it('warns once per skipped entity type, with counts', () => {
    const text = (s: string) => ['0', s, '8', '0', '10', 0, '20', 0, '1', 'hello'];
    const t = dxf('0', 'SECTION', '2', 'ENTITIES', ...text('SPLINE'), ...text('TEXT'), ...text('SPLINE'), ...text('SPLINE'),
      '0', 'CIRCLE', '8', '0', '10', 0, '20', 0, '40', 5, '0', 'ENDSEC', '0', 'EOF');
    const { sketch, warnings } = dxfToSketch(t);
    expect(sketch.entities).toHaveLength(1);
    expect(warnings).toEqual(['Skipped 3 SPLINE, 1 TEXT']);
  });

  it('maps $INSUNITS and ignores entities outside ENTITIES', () => {
    const t = (code: number) => dxf('0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015', '9', '$INSUNITS', '70', code, '0', 'ENDSEC',
      '0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '2', 'X', '0', 'CIRCLE', '8', '0', '10', 0, '20', 0, '40', 1, '0', 'ENDBLK', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES', '0', 'ENDSEC', '0', 'EOF');
    expect([1, 4, 5, 6, 2, 0].map((c) => dxfToSketch(t(c)).unit)).toEqual(['in', 'mm', 'cm', 'm', null, null]);
    expect(dxfToSketch(t(4)).sketch.entities).toHaveLength(0);
    for (const u of ['mm', 'cm', 'm', 'in'] as const) expect(dxfToSketch(sketchToDxf(sample(), u)).unit).toBe(u);
  });

  it('reads a full-circle ARC as a circle', () => {
    const t = dxf('0', 'SECTION', '2', 'ENTITIES', '0', 'ARC', '8', '0', '10', 1, '20', 2, '40', 3, '50', 0, '51', 360, '0', 'ENDSEC', '0', 'EOF');
    expect(dxfToSketch(t).sketch.entities.map((e) => e.type)).toEqual(['circle']);
  });

  it('mirrors arcs with a -Z extrusion into world coordinates', () => {
    const t = dxf('0', 'SECTION', '2', 'ENTITIES', '0', 'ARC', '8', '0', '10', 10, '20', 0, '40', 10, '50', 0, '51', 90, '230', -1, '0', 'ENDSEC', '0', 'EOF');
    const { sketch } = dxfToSketch(t);
    const arc = sketch.entities[0] as CadArc;
    const P = pointMap(sketch);
    expect(P.get(arc.c)).toMatchObject({ x: -10, y: 0 });
    const mid = arcMid(sketch, arc); // the quarter from 90° to 180° around (-10, 0)
    expect(mid.x).toBeCloseTo(-10 - 10 * Math.SQRT1_2, 9);
    expect(mid.y).toBeCloseTo(10 * Math.SQRT1_2, 9);
  });
});
