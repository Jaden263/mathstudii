import { describe, expect, it } from 'vitest';
import type { BeamData } from '../../beam/model';
import { gridLines, panBy, pinchView, toS, toW, wheelFactor, zoomAt, zoomLimits, type Vp } from './beamGeom';
import { beamKey, type KeyInput } from './beamKeys';
import { regionOwnsKey, regionsToDelete } from '../sheetKeys';

const vp: Vp = { view: { cx: 3, cy: 0.5, zoom: 60 }, width: 560, height: 300 };

describe('zooming and panning the beam drawing', () => {
  it('zooms about the pointer: the model point under it stays under it', () => {
    for (const s of [{ x: 100, y: 80 }, { x: 500, y: 250 }, { x: 280, y: 150 }]) {
      const w = toW(vp, s);
      for (const f of [1.25, 0.5, 3]) {
        const v = zoomAt(vp, s, f);
        expect(v.zoom).toBeCloseTo(60 * f, 9);
        const back = toS({ ...vp, view: v }, w);
        expect(back.x).toBeCloseTo(s.x, 9);
        expect(back.y).toBeCloseTo(s.y, 9);
        expect(v.manual).toBe(true);
      }
    }
  });

  it('keeps the zoom within its limits (the point still stays put)', () => {
    const lim: [number, number] = [10, 100];
    const s = { x: 400, y: 100 };
    const v = zoomAt(vp, s, 10, lim);
    expect(v.zoom).toBe(100);
    const back = toS({ ...vp, view: v }, toW(vp, s));
    expect(back.x).toBeCloseTo(s.x, 9);
    expect(zoomAt(vp, s, 0.001, lim).zoom).toBe(10);
  });

  it('limits follow the size of the structure, whatever the length unit', () => {
    const d = (k: number): BeamData => ({ nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 8 * k, y: 0 }], members: [], supports: [], loads: [] });
    const [lo, hi] = zoomLimits(d(1), 560, 0.5);
    // the whole beam a twentieth of the width at the least, a 200th of it the whole width at the most
    expect(8 * lo).toBeCloseTo(28, 9);
    expect(8 * hi).toBeCloseTo(560 * 200, 6);
    const [lo2] = zoomLimits(d(1000), 560, 500);
    expect(lo2 * 1000).toBeCloseTo(lo, 9);
    // nothing drawn yet: by the grid
    expect(zoomLimits({ nodes: [], members: [], supports: [], loads: [] }, 560, 0.5)[0]).toBeCloseTo(28 / 5, 9);
  });

  it('pans with the pointer', () => {
    const v = panBy(vp.view, 30, -12);
    const p = toS({ ...vp, view: v }, toW(vp, { x: 100, y: 100 }));
    expect(p.x).toBeCloseTo(130, 9);
    expect(p.y).toBeCloseTo(88, 9);
  });

  it('pinches: the point between the fingers follows them, the zoom their spread', () => {
    const start: [{ x: number; y: number }, { x: number; y: number }] = [{ x: 200, y: 150 }, { x: 300, y: 150 }];
    const now: [{ x: number; y: number }, { x: number; y: number }] = [{ x: 160, y: 120 }, { x: 360, y: 120 }];
    const v = pinchView(vp, start, now);
    expect(v.zoom).toBeCloseTo(120, 9);
    const w = toW(vp, { x: 250, y: 150 });
    const p = toS({ ...vp, view: v }, w);
    expect(p.x).toBeCloseTo(260, 9);
    expect(p.y).toBeCloseTo(120, 9);
  });

  it('turns wheel events into zoom factors: a notch about 20 %, a pinch finer, never wild', () => {
    expect(wheelFactor({ deltaY: -100, deltaMode: 0, ctrlKey: false })).toBeCloseTo(Math.exp(0.2), 9);
    expect(wheelFactor({ deltaY: 100, deltaMode: 0, ctrlKey: false })).toBeLessThan(1);
    // lines: 3 lines = 48 px
    expect(wheelFactor({ deltaY: -3, deltaMode: 1, ctrlKey: false })).toBeCloseTo(Math.exp(0.096), 9);
    // a pinch comes as Ctrl + small deltas
    expect(wheelFactor({ deltaY: -5, deltaMode: 0, ctrlKey: true })).toBeCloseTo(Math.exp(0.05), 9);
    expect(wheelFactor({ deltaY: -5000, deltaMode: 0, ctrlKey: false })).toBeCloseTo(Math.exp(0.24), 9);
  });

  it('thins the grid out when zoomed out, with round major lines', () => {
    const fine = gridLines(vp, 0.5)!;
    expect(fine.step).toBe(0.5);
    expect(fine.xs.length).toBeGreaterThan(10);
    expect(fine.xs.filter((x) => x.major).every((x) => Math.abs(x.v / 2 - Math.round(x.v / 2)) < 1e-9)).toBe(true);
    const far = gridLines({ ...vp, view: { ...vp.view, zoom: 2 } }, 0.5)!;
    // 0.5 m at 2 px/m is 1 px: every 10th line (5 m = 10 px) is drawn
    expect(far.step).toBe(5);
    for (let i = 1; i < far.xs.length; i++) expect((far.xs[i].v - far.xs[i - 1].v) * 2).toBeGreaterThanOrEqual(8);
    expect(gridLines(vp, 0)).toBeNull();
  });
});

describe('keys of the beam editor', () => {
  const k = (key: string, extra: Partial<KeyInput> = {}): KeyInput => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra });

  it('deletes with Delete and Backspace, steps back with Escape', () => {
    expect(beamKey(k('Delete'))).toEqual({ kind: 'delete' });
    expect(beamKey(k('Backspace'))).toEqual({ kind: 'delete' });
    expect(beamKey(k('Escape'))).toEqual({ kind: 'escape' });
  });

  it('zooms with + − and fits with 0, without clashing with the tool letters', () => {
    expect(beamKey(k('+'))).toEqual({ kind: 'zoom', dir: 1 });
    expect(beamKey(k('='))).toEqual({ kind: 'zoom', dir: 1 });
    expect(beamKey(k('-'))).toEqual({ kind: 'zoom', dir: -1 });
    expect(beamKey(k('0'))).toEqual({ kind: 'fit' });
    // F stays the force tool
    expect(beamKey(k('f'))).toEqual({ kind: 'tool', tool: 'force' });
    expect(beamKey(k('V', { shiftKey: true }))).toEqual({ kind: 'tool', tool: 'select' });
    expect(beamKey(k('ArrowLeft'))).toEqual({ kind: 'pan', dx: 40, dy: 0 });
    expect(beamKey(k('ArrowDown', { shiftKey: true }))).toEqual({ kind: 'pan', dx: 0, dy: -160 });
    expect(beamKey(k(' '))).toEqual({ kind: 'space' });
  });

  it('leaves Ctrl keys to the worksheet (undo, redo, save, page zoom) but Ctrl+A', () => {
    expect(beamKey(k('z', { ctrlKey: true }))).toEqual({ kind: 'pass' });
    expect(beamKey(k('Z', { metaKey: true, shiftKey: true }))).toEqual({ kind: 'pass' });
    expect(beamKey(k('y', { ctrlKey: true }))).toEqual({ kind: 'pass' });
    expect(beamKey(k('+', { ctrlKey: true }))).toEqual({ kind: 'pass' });
    expect(beamKey(k('a', { ctrlKey: true }))).toEqual({ kind: 'selectAll' });
    expect(beamKey(k('k'))).toEqual({ kind: 'none' });
  });

  it('a beam\'s Delete never reaches the worksheet as "delete the region"', () => {
    const inBeam = { closest: (sel: string) => (sel === '[data-region-id="b1"]' ? {} : null) };
    // in the drawing the editor has it (and the worksheet leaves keys of the region being edited alone)
    expect(regionOwnsKey({ key: 'Delete', ctrlKey: false, metaKey: false, defaultPrevented: false, target: inBeam as unknown as EventTarget }, 'b1')).toBe(true);
    // from the side panel the editor takes it in the capture phase (preventDefault)
    expect(regionOwnsKey({ key: 'Delete', ctrlKey: false, metaKey: false, defaultPrevented: true, target: null }, 'b1')).toBe(true);
    // and whatever happens, Delete does not remove the region being edited
    expect(regionsToDelete(new Set(['b1']), 'b1')).toEqual([]);
    expect(regionsToDelete(new Set(['b1', 'm2']), 'b1')).toEqual(['m2']);
    expect(regionsToDelete(new Set(['b1']), null)).toEqual(['b1']);
  });
});
