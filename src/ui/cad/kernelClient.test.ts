// The UI's kernel requests: one at a time per lane, the newest waiting one wins, and a
// worker that went away fails what it was asked instead of leaving it hanging.
import { describe, expect, it } from 'vitest';
import { NO_KERNEL_NOTICE, type KernelCall, type KernelReply } from '../../cad/kernel/protocol';
import type { CadResult } from '../../cad/evaluate';
import type { BuildResult } from '../../cad/buildResult';
import {
  displayDelay, isSuperseded, kernelHostStopped, kernelNotice, kernelRequest, receiveDisplay, setKernelHost, setKernelWorkerFactory, waitingFor,
} from './kernelClient';

/** A stand-in worker that answers section requests with their offset after `ms`. */
function fakeWorker(ms = 5) {
  const asked: number[] = [];
  const w = {
    postMessage(m: { kernelPort?: MessagePort }) {
      const port = m.kernelPort!;
      port.onmessage = (e: MessageEvent<KernelCall>) => {
        const { rid, req } = e.data;
        if (req.op !== 'section') return;
        asked.push(req.plane.offset);
        setTimeout(() => port.postMessage({ rid, ok: true, value: req.plane.offset, kernel: 'brep' } satisfies KernelReply), ms);
      };
    },
  };
  return { worker: w as unknown as Worker, asked };
}

/** A stand-in for a kernel worker of the CAD window's own: events like a real one, answers if asked to. */
class OwnWorker extends EventTarget {
  terminated = false;
  constructor(private answers: boolean) {
    super();
  }
  postMessage(m: { kernelPort?: MessagePort }) {
    const port = m.kernelPort!;
    port.onmessage = (e: MessageEvent<KernelCall>) => {
      const { rid, req } = e.data;
      if (this.answers && req.op === 'section') port.postMessage({ rid, ok: true, value: req.plane.offset, kernel: 'brep' } satisfies KernelReply);
    };
  }
  terminate() {
    this.terminated = true;
  }
  /** What a worker does when an error escapes it (out of memory, a failed import). */
  crash(message: string) {
    this.dispatchEvent(Object.assign(new Event('error'), { message }));
  }
}

const section = (offset: number) => ({ op: 'section' as const, design: { version: 2 as const, components: [], occurrences: [], joints: [] }, numbers: { sketches: {}, frames: {}, params: {}, errors: {} }, plane: { n: [1, 0, 0] as [number, number, number], offset } });

describe('kernel requests from the UI', () => {
  it('a lane runs one request at a time and sends only the newest waiting one', async () => {
    const { worker, asked } = fakeWorker();
    setKernelHost(() => worker);
    const outcome = (p: Promise<unknown>) => p.then((v) => v, (e) => (isSuperseded(e) ? 'superseded' : e));
    const all = await Promise.all([1, 2, 3, 4].map((o) => outcome(kernelRequest(section(o), 'section'))));
    // 1 was sent at once; 2 and 3 waited and were replaced by 4
    expect(all).toEqual([1, 'superseded', 'superseded', 4]);
    expect(asked).toEqual([1, 4]);
    // requests without a lane all go
    expect(await Promise.all([5, 6].map((o) => kernelRequest(section(o))))).toEqual([5, 6]);
    setKernelHost(null);
  });

  it('a new worker fails what the old one was asked', async () => {
    const a = fakeWorker(50), b = fakeWorker();
    let current = a.worker;
    setKernelHost(() => current);
    const lost = kernelRequest(section(1)).catch((e: Error) => e.message);
    // the calculation was interrupted: a new worker takes the next request
    current = b.worker;
    expect(await kernelRequest(section(2))).toBe(2);
    expect(await lost).toMatch(/interrupted/);
    setKernelHost(null);
  });

  it('a stopped worker fails its requests at once, so its lane takes the next one', async () => {
    // a worker that never answers (it was terminated mid-request)
    const dead = { postMessage() {} } as unknown as Worker;
    const b = fakeWorker();
    let current = dead;
    setKernelHost(() => current);
    const stuck = kernelRequest(section(1), 'section').catch((e: Error) => e.message);
    const next = kernelRequest(section(2), 'section');
    // the calculation is interrupted: nothing else asks the kernel meanwhile
    current = b.worker;
    kernelHostStopped();
    expect(await stuck).toMatch(/interrupted/);
    expect(await next).toBe(2);
    expect(b.asked).toEqual([2]);
    setKernelHost(null);
  });

  it('a worker of our own that crashes fails what it was asked; the next request starts a new one', async () => {
    const made: OwnWorker[] = [];
    setKernelWorkerFactory(() => {
      const w = new OwnWorker(made.length > 0);
      made.push(w);
      return w as unknown as Worker;
    });
    try {
      const lost = kernelRequest(section(1), 'own').catch((e: Error) => e.message);
      const queued = kernelRequest(section(2), 'own');
      made[0].crash('out of memory');
      expect(await lost).toMatch(/^the 3-D kernel stopped \(out of memory\) — it starts again with the next request$/);
      expect(made[0].terminated).toBe(true);
      // the lane went on to the request that waited, on a fresh worker
      expect(await queued).toBe(2);
      expect(await kernelRequest(section(3))).toBe(3);
      expect(made).toHaveLength(2);
    } finally {
      setKernelWorkerFactory(null);
    }
  });

  it('no kernel at all: the same notice whether the worksheet or a CAD window’s own worker found out', () => {
    expect(kernelNotice({ kernelError: 'wasm failed' }, null, false)).toEqual({ notice: NO_KERNEL_NOTICE, noticeShort: 'No 3-D kernel' });
    expect(kernelNotice(undefined, null, true).notice).toBe(NO_KERNEL_NOTICE);
    expect(kernelNotice({ brepError: 'x' }, null, false).noticeShort).toBe('Mesh kernel');
    expect(kernelNotice(undefined, { kernel: 'brep', components: {}, placements: {}, errors: {} }, false)).toEqual({});
  });

  it('a view without display data says what it waits for', () => {
    const res = (extra: Partial<CadResult> = {}) => ({ kind: 'cad', points: {}, radii: {}, ok: true, dof: 0, determined: [], determinedRadii: [], conflicting: [], redundant: [], values: {}, dimErrors: {}, issues: [], ...extra }) as CadResult;
    const up = { missing: false, kernelUp: true };
    // the worksheet is still evaluating, or built without OpenCascade while it loads
    expect(waitingFor(undefined, undefined, up)).toBe('loading');
    expect(waitingFor(res({ needsBrep: true }), 'd1', up)).toBe('loading');
    expect(waitingFor(res({ needsKernel: true }), 'd1', up)).toBe('loading');
    // a CAD window whose own kernel worker has not answered yet: it is loading OpenCascade
    expect(waitingFor(res(), 'd1', { missing: false, kernelUp: false })).toBe('loading');
    expect(waitingFor(res(), 'd1', up)).toBe('rebuilding');
    // nothing could build it: no build is coming
    expect(waitingFor(res(), 'd1', { missing: true, kernelUp: true })).toBe('none');
    expect(waitingFor(res(), undefined, up)).toBe('none');
  });

  it('display data dropped from the cache is asked for at once, not waited for', () => {
    const b = (): BuildResult => ({ kernel: 'brep', components: {}, placements: {}, errors: {} });
    // the cache keeps 24 designs: the 25th that arrives drops the oldest
    for (let i = 0; i < 25; i++) receiveDisplay({ display: [[`k${i}`, b()]] });
    // the calculation worker sent k0 once and will not again; k24 it may still be sending
    expect(displayDelay('k0', true)).toBe(0);
    expect(displayDelay('k24', true)).toBe(1500);
    expect(displayDelay('new', true)).toBe(1500);
    // a CAD window's own worker sends nothing by itself: it is always asked at once
    expect(displayDelay('k24', false)).toBe(0);
    // back in the cache, k0 is no longer missing; k1 was dropped for it
    receiveDisplay({ display: [['k0', b()]] });
    expect(displayDelay('k0', true)).toBe(1500);
    expect(displayDelay('k1', true)).toBe(0);
  });
});
