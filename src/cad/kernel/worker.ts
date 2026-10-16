/// <reference lib="webworker" />
// A kernel worker of its own, for a CAD window that has no worksheet calculation beside
// it: the same requests as the calculation worker answers, on the port it is handed.
import { loadKernel } from '../kernelBrowser';
import { loadOcc } from '../occ/browser';
import { isKernelPortMessage } from './protocol';
import { serveKernel, setKernelLoaders } from './service';

setKernelLoaders(loadOcc, loadKernel);

const ctx = self as unknown as DedicatedWorkerGlobalScope;
ctx.onmessage = (e: MessageEvent) => {
  if (isKernelPortMessage(e.data)) serveKernel(e.data.kernelPort);
};
