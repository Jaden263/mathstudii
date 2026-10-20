// When the calculation worker is stopped to give memory back, and when it is left alone.
import { describe, expect, it } from 'vitest';
import type { WorkerMemory } from '../engine/memoryProtocol';
import { emptyWorksheet, type Region } from '../model/types';
import { BLOATED_OCCT, IDLE_RELEASE_MS, LONG_IDLE_MS, needsOf, nextCheck, releaseReason } from './idleRelease';

const MB = 2 ** 20;
const mem = (m: Partial<WorkerMemory> = {}): WorkerMemory => ({ occt: 0, occtStale: 0, manifold: false, python: 0, cas: false, caches: 0, idleMs: IDLE_RELEASE_MS, busy: false, ...m });
const cad = { cad: true, python: false }, none = { cad: false, python: false }, py = { cad: false, python: true };

describe('idle release of the calculation worker', () => {
  it('lets go of runtimes the worksheet does not use, once idle', () => {
    expect(releaseReason(mem({ python: 30 * MB }), none)).toMatch(/Python/);
    expect(releaseReason(mem({ occt: 100 * MB, manifold: true }), none)).toMatch(/3-D kernels/);
    expect(releaseReason(mem({ manifold: true }), py)).toMatch(/3-D kernels/);
    // not before the worker has been idle a minute, never while it works
    expect(releaseReason(mem({ python: 30 * MB, idleMs: IDLE_RELEASE_MS - 1 }), none)).toBeNull();
    expect(releaseReason(mem({ python: 30 * MB, busy: true }), none)).toBeNull();
    // what the worksheet uses stays
    expect(releaseReason(mem({ python: 30 * MB }), py)).toBeNull();
    expect(releaseReason(mem({ occt: 100 * MB, manifold: true }), cad)).toBeNull();
    // nothing heavy loaded: nothing to do
    expect(releaseReason(mem({ cas: true }), none)).toBeNull();
  });

  it('gives back a B-rep heap that grew, counting replaced instances not collected yet', () => {
    expect(releaseReason(mem({ occt: 200 * MB }), cad)).toBeNull();
    expect(releaseReason(mem({ occt: BLOATED_OCCT + MB }), cad)).toMatch(/grew to 257 MB/);
    expect(releaseReason(mem({ occt: 100 * MB, occtStale: 200 * MB }), cad)).toMatch(/grew/);
    expect(releaseReason(mem({ jsHeap: 500 * MB }), cad)).toMatch(/calculation heap/);
    expect(releaseReason(mem({ python: 600 * MB }), py)).toMatch(/Python's heap grew to 600 MB/);
    expect(releaseReason(mem({ python: 100 * MB }), py)).toBeNull();
  });

  it('after a long idle the kernels go too, but not Python (it takes seconds to start)', () => {
    expect(releaseReason(mem({ occt: 100 * MB, idleMs: LONG_IDLE_MS }), cad)).toMatch(/idle/);
    expect(releaseReason(mem({ occt: 100 * MB, python: 30 * MB, idleMs: LONG_IDLE_MS }), { cad: true, python: true })).toBeNull();
  });

  it('looks again only while something could still be let go', () => {
    expect(nextCheck(mem({ idleMs: 20_000 }), none)).toBe(IDLE_RELEASE_MS - 20_000);
    expect(nextCheck(mem({ busy: true }), none)).toBe(IDLE_RELEASE_MS);
    // a CAD worksheet with a fresh kernel: once more at the long idle mark, then never
    expect(nextCheck(mem({ occt: 100 * MB, idleMs: 2 * IDLE_RELEASE_MS }), cad)).toBe(LONG_IDLE_MS - 2 * IDLE_RELEASE_MS);
    expect(nextCheck(mem({ occt: 100 * MB, python: 30 * MB, idleMs: 2 * IDLE_RELEASE_MS }), { cad: true, python: true })).toBeNull();
    expect(nextCheck(mem({ cas: true, idleMs: 2 * IDLE_RELEASE_MS }), none)).toBeNull();
  });

  it('reads what a worksheet needs from its regions', () => {
    const ws = emptyWorksheet();
    expect(needsOf(ws)).toEqual(none);
    const r = (x: Partial<Region>) => ({ id: Math.random().toString(36), x: 0, y: 0, ...x }) as Region;
    expect(needsOf({ ...ws, regions: [r({ kind: 'python', code: 'x = 1' } as Partial<Region>)] })).toEqual(py);
    // empty or switched-off code runs nothing
    expect(needsOf({ ...ws, regions: [r({ kind: 'python', code: '  ' } as Partial<Region>), r({ kind: 'python', code: 'x = 1', disabled: true } as Partial<Region>)] })).toEqual(none);
    expect(needsOf({ ...ws, regions: [r({ kind: 'cad' } as Partial<Region>)] })).toEqual(cad);
  });
});
