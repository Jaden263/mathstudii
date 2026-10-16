// The UI's kernel requests: one at a time per lane, the newest waiting one wins, and a
// worker that went away fails what it was asked instead of leaving it hanging.
import { describe, expect, it } from 'vitest';
import type { KernelCall, KernelReply } from '../../cad/kernel/protocol';
import { isSuperseded, kernelRequest, setKernelHost } from './kernelClient';

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
});
