import { describe, expect, it } from 'vitest';
import { createRegion, type BeamRegion } from '../../model/types';
import type { BeamData, BeamLoad } from '../../beam/model';
import { boxPick, labelBox, lineStack, loadShape, pick, pickScene, type LoadShape, type PickScene } from './beamPick';
import { toS, type P2, type Vp } from './beamGeom';

/** A region at zoom 50 px/m around (4, 1). */
function region(d: Partial<BeamData>): { r: BeamRegion; vp: Vp } {
  const r = createRegion('beam', 0, 0, { nodes: [], members: [], supports: [], loads: [], ...d }) as BeamRegion;
  return { r, vp: { view: { cx: 4, cy: 1, zoom: 50 }, width: 560, height: 300 } };
}
const text = (l: BeamLoad) => (l.type === 'line' ? '5 kN/m' : l.type === 'moment' ? '10 kN·m' : '10 kN');
const sceneOf = (r: BeamRegion, vp: Vp, extra: Partial<Parameters<typeof pickScene>[2]> = {}) => pickScene(r, vp, { loads: true, text, ...extra });
const mid = (a: P2, b: P2, t = 0.5): P2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

const beam = (): Partial<BeamData> => ({
  nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 8, y: 0 }],
  members: [{ id: 'm', a: 'a', b: 'b' }],
  supports: [{ id: 'sa', node: 'a', type: 'pin', angle: 0, label: 'A' }, { id: 'sb', node: 'b', type: 'roller', angle: 0, label: 'B' }],
});

describe('picking load glyphs', () => {
  it('picks a point load anywhere on its shaft, head and label, before the member under it', () => {
    const { r, vp } = region({ ...beam(), loads: [{ id: 'P', type: 'force', at: { member: 'm', t: 0.5 }, value: '10', angle: -90 }] });
    const sc = sceneOf(r, vp);
    const sh = sc.loads[0].shape as Extract<LoadShape, { kind: 'force' }>;
    const at = toS(vp, { x: 4, y: 0 });
    // the arrow points down onto the beam: tail 44 px above, tip 2 px above
    expect(sh.arrow.from).toEqual({ x: at.x, y: at.y - 44 });
    for (const t of [0, 0.3, 0.6, 0.95, 1]) expect(pick(sc, mid(sh.arrow.from, sh.arrow.to, t))).toEqual({ kind: 'load', id: 'P' });
    // the head is wider than the shaft: a click beside it still counts
    expect(pick(sc, { x: at.x + 4, y: at.y - 6 })).toEqual({ kind: 'load', id: 'P' });
    const lb = labelBox(sh.label);
    expect(pick(sc, { x: (lb.x0 + lb.x1) / 2, y: (lb.y0 + lb.y1) / 2 })).toEqual({ kind: 'load', id: 'P' });
    // the beam away from the load is the member
    expect(pick(sc, toS(vp, { x: 2, y: 0 }))).toEqual({ kind: 'member', id: 'm' });
  });

  it('draws a negative load the other way and picks it there', () => {
    const { r, vp } = region({ ...beam(), loads: [{ id: 'P', type: 'force', at: { member: 'm', t: 0.5 }, value: '-10', angle: -90 }] });
    const sc = sceneOf(r, vp, { vals: { P: [-10e3] } });
    const at = toS(vp, { x: 4, y: 0 });
    // pushing up from below the beam
    expect(pick(sc, { x: at.x, y: at.y + 30 })).toEqual({ kind: 'load', id: 'P' });
    expect(pick(sc, { x: at.x, y: at.y - 30 })).toBeNull();
  });

  it('picks a line load on its band, arrows, outline and label; the member line between arrows stays the member', () => {
    const { r, vp } = region({ ...beam(), loads: [{ id: 'q', type: 'line', member: 'm', q1: '5', dir: 'global' }] });
    const sc = sceneOf(r, vp);
    const sh = sc.loads[0].shape as Extract<LoadShape, { kind: 'line' }>;
    const [p1, top1, top2, p2] = sh.area;
    expect(pick(sc, mid(top1, top2, 0.37))).toEqual({ kind: 'load', id: 'q' }); // the top line
    expect(pick(sc, mid(mid(p1, p2, 0.41), mid(top1, top2, 0.41)))).toEqual({ kind: 'load', id: 'q' }); // inside the band
    expect(pick(sc, mid(sh.arrows[3].from, sh.arrows[3].to, 0.9))).toEqual({ kind: 'load', id: 'q' }); // an arrow head
    const lb = labelBox(sh.label);
    expect(pick(sc, { x: lb.x0 + 10, y: (lb.y0 + lb.y1) / 2 })).toEqual({ kind: 'load', id: 'q' });
    // right on the beam halfway between two arrows: the member
    const between = mid(sh.arrows[3].to, sh.arrows[4].to);
    expect(pick(sc, between)).toEqual({ kind: 'member', id: 'm' });
    // just under the beam: the member, not the load above it
    expect(pick(sc, { x: between.x, y: between.y + 4 })).toEqual({ kind: 'member', id: 'm' });
  });

  it('follows trapezoidal and partial loads', () => {
    const { r, vp } = region({ ...beam(), loads: [{ id: 'q', type: 'line', member: 'm', q1: '2', q2: '8', t1: 0.25, t2: 0.75, dir: 'global' }] });
    const sc = sceneOf(r, vp, { vals: { q: [2e3, 8e3] } });
    const sh = sc.loads[0].shape as Extract<LoadShape, { kind: 'line' }>;
    // the start is a quarter as high as the end
    expect(sh.area[0].y - sh.area[1].y).toBeCloseTo(7.5, 9);
    expect(sh.area[3].y - sh.area[2].y).toBeCloseTo(30, 9);
    // high up at the end is the load; that high at the start, above its label, is empty space
    const end = toS(vp, { x: 6, y: 0 }), start = toS(vp, { x: 2, y: 0 });
    expect(pick(sc, { x: end.x - 3, y: end.y - 25 })).toEqual({ kind: 'load', id: 'q' });
    expect(pick(sc, { x: start.x + 3, y: start.y - 36 })).toBeNull();
    expect(pick(sc, { x: start.x + 3, y: start.y - 18 })).toEqual({ kind: 'load', id: 'q' });
    // outside the stretch it covers: the member
    expect(pick(sc, toS(vp, { x: 1, y: 0 }))).toEqual({ kind: 'member', id: 'm' });
  });

  it('picks stacked loads (G and Q on one span) where each is drawn', () => {
    const loads: BeamLoad[] = [
      { id: 'G', type: 'line', member: 'm', q1: 'g_k', dir: 'global', case: 'G' },
      { id: 'Q', type: 'line', member: 'm', q1: 'q_k', dir: 'global', case: 'Q' },
    ];
    expect(lineStack(loads, 0)).toBe(0);
    expect(lineStack(loads, 1)).toBe(1);
    const { r, vp } = region({ ...beam(), loads });
    const sc = sceneOf(r, vp, { faded: (l) => l.id === 'Q' });
    const g = sc.loads[0].shape as Extract<LoadShape, { kind: 'line' }>, q = sc.loads[1].shape as Extract<LoadShape, { kind: 'line' }>;
    // Q sits a block (30 px) and a gap (16 px) above G
    expect(g.area[0].y - q.area[0].y).toBeCloseTo(46, 9);
    expect(pick(sc, mid(mid(g.area[0], g.area[3], 0.6), mid(g.area[1], g.area[2], 0.6)))).toEqual({ kind: 'load', id: 'G' });
    expect(pick(sc, mid(mid(q.area[0], q.area[3], 0.6), mid(q.area[1], q.area[2], 0.6)))).toEqual({ kind: 'load', id: 'Q' });
    // its top line, and its label (faded: of a case not shown, still pickable)
    expect(pick(sc, mid(q.area[1], q.area[2], 0.5))).toEqual({ kind: 'load', id: 'Q' });
    const lb = labelBox(q.label);
    expect(pick(sc, { x: lb.x0 + 8, y: lb.y0 + 6 })).toEqual({ kind: 'load', id: 'Q' });
  });

  it('picks loads on inclined and vertical members, perpendicular or downwards', () => {
    const { r, vp } = region({
      nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 4, y: 3 }, { id: 'c', x: 4, y: -1 }],
      members: [{ id: 'm1', a: 'a', b: 'b' }, { id: 'm2', a: 'c', b: 'b' }],
      loads: [
        { id: 'loc', type: 'line', member: 'm1', q1: '4', dir: 'local' },
        { id: 'col', type: 'line', member: 'm2', q1: '2', dir: 'local' },
        { id: 'F', type: 'force', at: { member: 'm1', t: 0.75 }, value: '12', angle: -45 },
      ],
    });
    const sc = sceneOf(r, vp);
    const loc = sc.loads[0].shape as Extract<LoadShape, { kind: 'line' }>;
    // perpendicular to the incline: the band's sides are square to the member
    const along = { x: loc.area[3].x - loc.area[0].x, y: loc.area[3].y - loc.area[0].y };
    const side = { x: loc.area[1].x - loc.area[0].x, y: loc.area[1].y - loc.area[0].y };
    expect(along.x * side.x + along.y * side.y).toBeCloseTo(0, 6);
    expect(pick(sc, mid(mid(loc.area[0], loc.area[3], 0.3), mid(loc.area[1], loc.area[2], 0.3)))).toEqual({ kind: 'load', id: 'loc' });
    // the vertical column's load comes from its left (screen) side
    const col = sc.loads[1].shape as Extract<LoadShape, { kind: 'line' }>;
    expect(col.area[1].x).toBeLessThan(col.area[0].x);
    expect(pick(sc, mid(col.area[1], col.area[2], 0.5))).toEqual({ kind: 'load', id: 'col' });
    // the inclined force: along its 45° shaft
    const F = sc.loads[2].shape as Extract<LoadShape, { kind: 'force' }>;
    expect(F.arrow.from.x).toBeLessThan(F.arrow.to.x);
    expect(F.arrow.from.y).toBeLessThan(F.arrow.to.y);
    expect(pick(sc, mid(F.arrow.from, F.arrow.to, 0.2))).toEqual({ kind: 'load', id: 'F' });
  });

  it('picks a small load next to a support, the support and the node apart', () => {
    const { r, vp } = region({ ...beam(), loads: [{ id: 'P', type: 'force', at: { member: 'm', t: 0.02 }, value: '1', angle: -90 }] });
    const sc = sceneOf(r, vp);
    const a = toS(vp, { x: 0, y: 0 });
    const P = (sc.loads[0].shape as Extract<LoadShape, { kind: 'force' }>).arrow;
    expect(Math.abs(P.to.x - a.x)).toBeLessThan(10);
    expect(pick(sc, mid(P.from, P.to, 0.5))).toEqual({ kind: 'load', id: 'P' });
    expect(pick(sc, mid(P.from, P.to, 0.95))).toEqual({ kind: 'load', id: 'P' });
    // the support's triangle under the node, and the node itself
    expect(pick(sc, { x: a.x, y: a.y + 10 })).toEqual({ kind: 'support', id: 'sa' });
    expect(pick(sc, { x: a.x, y: a.y + 1 })).toEqual({ kind: 'node', id: 'a' });
  });

  it('picks a moment on its arc, its node in the middle', () => {
    const { r, vp } = region({ ...beam(), loads: [{ id: 'M', type: 'moment', at: { member: 'm', t: 0.5 }, value: '10' }] });
    const sc = sceneOf(r, vp);
    const c = toS(vp, { x: 4, y: 0 });
    for (const deg of [0, 60, 120, 200, 300]) {
      const a = (deg * Math.PI) / 180;
      expect(pick(sc, { x: c.x + 16 * Math.cos(a), y: c.y - 16 * Math.sin(a) })).toEqual({ kind: 'load', id: 'M' });
    }
    // inside the arc, off the beam
    expect(pick(sc, { x: c.x + 4, y: c.y - 9 })).toEqual({ kind: 'load', id: 'M' });
  });

  it('a load drawn later wins where two glyphs overlap exactly; grips of a selected line load first', () => {
    const loads: BeamLoad[] = [
      { id: 'q', type: 'line', member: 'm', q1: '5', t1: 0.25, t2: 0.75, dir: 'global' },
      { id: 'P', type: 'force', at: { member: 'm', t: 0.5 }, value: '10', angle: -90 },
    ];
    const { r, vp } = region({ ...beam(), loads });
    const sc = sceneOf(r, vp, { grips: new Set(['q']) });
    const at = toS(vp, { x: 4, y: 0 });
    // the point load's arrow runs through the band: the arrow is picked on it, the band beside it
    expect(pick(sc, { x: at.x, y: at.y - 20 })).toEqual({ kind: 'load', id: 'P' });
    expect(pick(sc, { x: at.x + 12, y: at.y - 15 })).toEqual({ kind: 'load', id: 'q' });
    const end = toS(vp, { x: 6, y: 0 });
    expect(pick(sc, { x: end.x + 2, y: end.y })).toEqual({ kind: 'load', id: 'q', grip: 1 });
    // only loads when asked (a double-click edits a value)
    expect(pick(sc, toS(vp, { x: 1, y: 0 }), ['load'])).toBeNull();
  });

  it('leaves out loads that are not drawn, and reactions never block them', () => {
    const { r, vp } = region({ ...beam(), loads: [{ id: 'P', type: 'force', at: { member: 'm', t: 0.5 }, value: '10', angle: -90 }] });
    const hidden = pickScene(r, vp, { loads: false, text });
    expect(hidden.loads).toHaveLength(0);
    expect(pick(hidden, toS(vp, { x: 4, y: 0.5 }))).toBeNull();
  });

  it('shapes match the drawing: a load on a missing member has none', () => {
    const { r, vp } = region({ ...beam() });
    expect(loadShape(r, { id: 'x', type: 'line', member: 'gone', q1: '1', dir: 'global' }, vp, { text: '' })).toBeNull();
  });
});

describe('box selection', () => {
  const scene = (): { sc: PickScene; vp: Vp } => {
    const { r, vp } = region({
      ...beam(),
      loads: [
        { id: 'P', type: 'force', at: { member: 'm', t: 0.5 }, value: '10', angle: -90 },
        { id: 'q', type: 'line', member: 'm', q1: '5', t1: 0.6, t2: 0.9, dir: 'global' },
      ],
    });
    return { sc: sceneOf(r, vp), vp };
  };

  it('left to right takes what lies wholly inside', () => {
    const { sc, vp } = scene();
    const a = toS(vp, { x: 3, y: 2 }), b = toS(vp, { x: 5, y: -0.5 });
    expect(boxPick(sc, a, b)).toEqual(['P']);
  });

  it('right to left takes what it touches', () => {
    const { sc, vp } = scene();
    const a = toS(vp, { x: 5.2, y: 2 }), b = toS(vp, { x: 3.8, y: 0.3 });
    expect(boxPick(sc, a, b).sort()).toEqual(['P', 'q'].sort());
    const c = toS(vp, { x: 4.6, y: 0.2 }), d = toS(vp, { x: 3.5, y: -0.2 });
    expect(boxPick(sc, c, d).sort()).toEqual(['P', 'm']);
  });
});
