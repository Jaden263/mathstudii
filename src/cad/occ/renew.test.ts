// A renewed B-rep kernel takes over and the old instance goes as a whole: nothing may keep
// it (and its heap, hundreds of MB by the time it is renewed) reachable, not the promise
// the first load came from, nor the caches of what it built.
import v8 from 'node:v8';
import vm from 'node:vm';
import { expect, it } from 'vitest';
import { circles, rect, single, solve, withCircles } from './fixtures';
import { initOcc, occ, occHeapBytes, occStaleBytes, renewOcc } from './kernel';
import { measureDesignOcc } from './build';
import { timelineCache } from './cache';
import { displayFor, kernelCacheBytes } from '../kernel/service';
import type { DesignItem } from '../design';

v8.setFlagsFromString('--expose_gc');
const gc = vm.runInNewContext('gc') as () => void;
const collect = async () => {
  for (let i = 0; i < 4; i++) {
    gc();
    await new Promise((r) => setTimeout(r, 50));
  }
};

const part = (w: number) => single([
  { kind: 'sketch', id: 's0', name: 'S', plane: { ref: 'XY' }, sketch: withCircles(rect('a', 0, 0, w, 60), 'h', [[w / 2, 30, 10]]) },
  { kind: 'extrude', id: 'f0', name: 'Plate', sketch: 's0', extent: { type: 'one', d: '10' }, op: 'new' },
  { kind: 'sketch', id: 's1', name: 'B', plane: { ref: 'XY', offset: '10' }, sketch: circles('b', [[10, 10, 3]]) },
  { kind: 'extrude', id: 'f1', name: 'Bore', sketch: 's1', extent: { type: 'all' }, op: 'cut' },
] as DesignItem[]);

function build(w: number) {
  const d = part(w), n = solve(d).numbers;
  const m = measureDesignOcc(occ()!, d, n);
  expect(displayFor(d, n)?.kernel).toBe('brep');
  return m.bodies.c1[0].mass!.V;
}

it('lets the replaced instance go, the first one included', async () => {
  const v = build(100);
  expect(timelineCache.size).toBeGreaterThan(0);
  expect(kernelCacheBytes()).toBeGreaterThan(0);
  const first = new WeakRef(occ()!.wasmMemory);
  // (in a function of its own: the test must not keep the instance either)
  const renewed = async () => {
    const second = await renewOcc(0)!;
    expect(occ()).toBe(second);
    // the caches let go of what the old instance made
    expect(timelineCache.size).toBe(0);
    expect(kernelCacheBytes()).toBe(0);
    // the new one builds the same part (and a later initOcc gives it, not the first)
    expect(build(100)).toBeCloseTo(v, 6);
    expect(await initOcc()).toBe(second);
    return new WeakRef(second.wasmMemory);
  };
  const secondMem = await renewed();
  await renewOcc(0);
  build(101);
  await collect();
  expect(first.deref()).toBeUndefined();
  expect(secondMem.deref()).toBeUndefined();
  expect(occStaleBytes()).toBe(0);
  expect(occHeapBytes()).toBeGreaterThan(0);
}, 120_000);
