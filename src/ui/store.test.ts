import { describe, expect, it } from 'vitest';
import { createRegion, emptyWorksheet, type AreaRegion, type Frame3DRegion, type MathRegion, type Region, type Worksheet } from '../model/types';
import { initialState, reducer, type Action, type State } from './store';
import { canEdit } from '../model/protect';

const math = (id: string, y: number, source: string, extra: Partial<MathRegion> = {}): MathRegion => ({ ...(createRegion('math', 80, y, { source }) as MathRegion), id, ...extra });

function start(regions: Region[]): State {
  return initialState({ ...emptyWorksheet(), regions });
}
const run = (s: State, ...actions: Action[]) => actions.reduce(reducer, s);
const get = (s: State, id: string) => s.ws.regions.find((r) => r.id === id) as Region | undefined;
const src = (s: State, id: string) => (get(s, id) as MathRegion | undefined)?.source;

describe('locked regions', () => {
  const base = () => start([math('a', 40, 'a := 1', { locked: true }), math('b', 80, 'b := 2')]);

  it('cannot be edited, moved or deleted', () => {
    const s = base();
    expect(run(s, { type: 'update', id: 'a', patch: { source: 'a := 5' } }).ws).toBe(s.ws);
    expect(run(s, { type: 'move', ids: ['a'], dx: 8, dy: 8 }).ws).toBe(s.ws);
    expect(run(s, { type: 'delete', ids: ['a'] }).ws).toBe(s.ws);
    // a mixed selection: only the free region moves or goes
    const moved = run(s, { type: 'move', ids: ['a', 'b'], dx: 0, dy: 16 });
    expect([get(moved, 'a')!.y, get(moved, 'b')!.y]).toEqual([40, 96]);
    const del = run(s, { type: 'delete', ids: ['a', 'b'] });
    expect(del.ws.regions.map((r) => r.id)).toEqual(['a']);
    // the free one still edits
    expect(src(run(s, { type: 'update', id: 'b', patch: { source: 'b := 3' } }), 'b')).toBe('b := 3');
  });

  it('keep their view changes (camera, zoom) but nothing else', () => {
    const f = { ...(createRegion('frame3d', 80, 200) as Frame3DRegion), id: 'f', locked: true };
    const s = start([f]);
    const turned = run(s, { type: 'update', id: 'f', patch: { camera: { ...f.camera, yaw: 10 } }, history: false });
    expect((get(turned, 'f') as Frame3DRegion).camera.yaw).toBe(10);
    expect(run(s, { type: 'update', id: 'f', patch: { name: 'G', camera: { ...f.camera, yaw: 10 } } }).ws).toBe(s.ws);
  });

  it('are not changed by undo or redo, and undo never unlocks', () => {
    let s = base();
    s = run(s, { type: 'lock', ids: ['a'], locked: false });
    s = run(s, { type: 'update', id: 'b', patch: { source: 'b := 3' } });
    s = run(s, { type: 'update', id: 'a', patch: { source: 'a := 9' } });
    s = run(s, { type: 'lock', ids: ['a'], locked: true });
    // lock and unlock are not undo steps
    expect(s.past.length).toBe(2);
    s = run(s, { type: 'undo' });
    // the step undone was a's edit: a is locked, so it stays
    expect([src(s, 'a'), src(s, 'b'), get(s, 'a')!.locked]).toEqual(['a := 9', 'b := 3', true]);
    s = run(s, { type: 'undo' });
    expect([src(s, 'a'), src(s, 'b')]).toEqual(['a := 9', 'b := 2']);
    s = run(s, { type: 'redo' });
    expect(src(s, 'b')).toBe('b := 3');
    expect(get(s, 'a')!.locked).toBe(true);
  });

  it('are not removed by undoing their creation', () => {
    let s = start([]);
    s = run(s, { type: 'add', regions: [math('n', 40, 'n := 1')] }, { type: 'lock', ids: ['n'], locked: true }, { type: 'undo' });
    expect(src(s, 'n')).toBe('n := 1');
  });
});

describe('locked areas', () => {
  const box = (): AreaRegion => ({ ...(createRegion('area', 48, 100, { title: 'Loads' }) as AreaRegion), id: 'A', height: 120 });
  const ws = () => start([math('a', 40, 'a := 1'), box(), math('b', 140, 'b := 2'), math('c', 180, 'c := 3'), math('d', 300, 'd := 4')]);

  it('lock everything inside them', () => {
    const s = run(ws(), { type: 'lock', ids: ['A'], locked: true });
    expect(run(s, { type: 'update', id: 'b', patch: { source: 'b := 5' } }).ws).toBe(s.ws);
    expect(run(s, { type: 'move', ids: ['c'], dx: 0, dy: 8 }).ws).toBe(s.ws);
    expect(run(s, { type: 'move', ids: ['A'], dx: 0, dy: 8 }).ws).toBe(s.ws);
    expect(run(s, { type: 'update', id: 'A', patch: { title: 'X' } }).ws).toBe(s.ws);
    // nothing new goes into a locked area; outside it, it does
    expect(run(s, { type: 'add', regions: [math('n', 160, 'n := 1')] }).ws).toBe(s.ws);
    expect(get(run(s, { type: 'add', regions: [math('n', 260, 'n := 1')] }), 'n')).toBeDefined();
    // regions outside are free
    expect(src(run(s, { type: 'update', id: 'd', patch: { source: 'd := 0' } }), 'd')).toBe('d := 0');
  });

  it('still collapse and expand (layout, not an edit)', () => {
    const s = run(ws(), { type: 'lock', ids: ['A'], locked: true }, { type: 'collapse', id: 'A' });
    expect(get(s, 'd')!.y).toBe(300 - (120 - 24));
    expect(get(run(s, { type: 'expand', id: 'A' }), 'd')!.y).toBe(300);
    // undoing the collapse puts everything back, locked or not
    expect(get(run(s, { type: 'undo' }), 'd')!.y).toBe(300);
  });

  it('move with their contents, unless something inside is locked', () => {
    const moved = run(ws(), { type: 'move', ids: ['A'], dx: 0, dy: 40 });
    expect(['A', 'b', 'c', 'd', 'a'].map((id) => get(moved, id)!.y)).toEqual([140, 180, 220, 300, 40]);
    const s = run(ws(), { type: 'lock', ids: ['c'], locked: true });
    expect(run(s, { type: 'move', ids: ['A'], dx: 0, dy: 40 }).ws).toBe(s.ws);
    expect(run(s, { type: 'delete', ids: ['A'] }).ws).toBe(s.ws);
    // deleting an area deletes what is in it
    expect(run(ws(), { type: 'delete', ids: ['A'] }).ws.regions.map((r) => r.id)).toEqual(['a', 'd']);
  });
});

describe('protected worksheet', () => {
  const ws = (): State => start([math('L', 40, 'L := 6 m', { input: true }), math('M', 80, 'M := q L^2/8'), math('q', 120, 'q := 5 kN/m', { input: true })]);
  const prot = (s: State) => run(s, { type: 'protect', protect: { salt: 'ab', hash: 'cd' } });

  it('leaves only the inputs editable', () => {
    const s = prot(ws());
    expect(src(run(s, { type: 'update', id: 'L', patch: { source: 'L := 7 m' } }), 'L')).toBe('L := 7 m');
    expect(run(s, { type: 'update', id: 'M', patch: { source: 'M := 0' } }).ws).toBe(s.ws);
    // inputs edit but do not move or go
    expect(run(s, { type: 'move', ids: ['L'], dx: 8, dy: 0 }).ws).toBe(s.ws);
    expect(run(s, { type: 'delete', ids: ['L', 'M'] }).ws).toBe(s.ws);
    // no pasting, no new regions, no renaming the worksheet, no unlocking or new inputs
    expect(run(s, { type: 'add', regions: [math('n', 400, 'n := 1')] }).ws).toBe(s.ws);
    expect(run(s, { type: 'title', title: 'Mine' }).ws).toBe(s.ws);
    expect(run(s, { type: 'input', ids: ['M'], input: true }).ws).toBe(s.ws);
    expect(run(s, { type: 'lock', ids: ['L'], locked: true }).ws).toBe(s.ws);
    // formats stay; switching automatic calculation is allowed
    expect(run(s, { type: 'settings', patch: { precision: 2 } }).ws).toBe(s.ws);
    expect(run(s, { type: 'settings', patch: { autoCalc: false } }).ws.settings.autoCalc).toBe(false);
    expect(run(s, { type: 'settings', patch: { protect: undefined } }).ws.settings.protect).toBeDefined();
    expect(canEdit(s.ws, get(s, 'q')!)).toBe(true);
    expect(canEdit(s.ws, get(s, 'M')!)).toBe(false);
  });

  it('stays protected through undo, and undo only touches the inputs', () => {
    let s = run(ws(), { type: 'update', id: 'M', patch: { source: 'M := q L^2/10' } });
    s = prot(s);
    s = run(s, { type: 'update', id: 'L', patch: { source: 'L := 8 m' } });
    s = run(s, { type: 'undo' });
    expect(src(s, 'L')).toBe('L := 6 m');
    s = run(s, { type: 'undo' });
    // the edit of M was made before protecting: undo does not reach it now
    expect(src(s, 'M')).toBe('M := q L^2/10');
    expect(s.ws.settings.protect).toEqual({ salt: 'ab', hash: 'cd' });
    // lifting the protection is not an undo step either
    s = run(s, { type: 'protect', protect: null }, { type: 'redo' });
    expect(s.ws.settings.protect).toBeUndefined();
    expect(src(s, 'L')).toBe('L := 6 m');
  });
});

describe('areas through the store', () => {
  it('collapse, expand and group as undo steps', () => {
    let s = start([math('a', 40, 'a := 1'), math('b', 100, 'b := 2'), math('c', 200, 'c := 3')]);
    const area: AreaRegion = { ...(createRegion('area', 48, 0) as AreaRegion), id: 'A' };
    s = run(s, { type: 'group', ids: ['b'], heights: { b: 24 }, area });
    expect(get(s, 'A')).toBeDefined();
    const grouped: Worksheet = s.ws;
    s = run(s, { type: 'collapse', id: 'A' }, { type: 'expand', id: 'A' });
    expect(s.ws).toEqual(grouped);
    s = run(s, { type: 'undo' }, { type: 'undo' }, { type: 'undo' });
    expect(get(s, 'A')).toBeUndefined();
    expect(s.ws.regions.map((r) => r.y)).toEqual([40, 100, 200]);
    // the area's band growing is not an undo step
    s = run(s, { type: 'redo' }, { type: 'areaFit', id: 'A', height: 200 });
    expect(s.past.length).toBe(1);
  });
});
