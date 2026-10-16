// The UI's kernel requests: one at a time per lane, the newest waiting one wins, and a
// worker that went away fails what it was asked instead of leaving it hanging.
import { describe, expect, it } from 'vitest';
import type { KernelCall, KernelReply } from '../../cad/kernel/protocol';
import type { CadResult } from '../../cad/evaluate';
import { isSuperseded, kernelHostStopped, kernelRequest, setKernelHost, waitingFor } from './kernelClient';

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
});
