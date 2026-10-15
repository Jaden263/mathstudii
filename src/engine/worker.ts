/// <reference lib="webworker" />
// Runs worksheet evaluation off the UI thread so long calculations (or
// accidental infinite loops) never freeze the interface.
import { evaluateWorksheet, type RegionResult } from './evaluator';
import { loadCas } from './symbolic';
import type { Worksheet } from '../model/types';
import { loadKernel } from '../cad/kernelBrowser';

export interface EvalRequest {
  id: number;
  ws: Worksheet;
  /** variable → expression replacing its definition (animation frames) */
  overrides?: Record<string, string>;
  /** Only return results for these regions (keeps animation frames small). */
  only?: string[];
}

export interface EvalResponse {
  id: number;
  results: [string, RegionResult][];
  errorCount: number;
  millis: number;
  /** More results will follow (symbolic engine still loading). */
  partial: boolean;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// CAD parts need the solid kernel (WASM); it loads once, alongside the first evaluation
const kernelReady = loadKernel().catch((e) => console.warn('3-D kernel failed to load', e));

ctx.onmessage = async (e: MessageEvent<EvalRequest>) => {
  const { id, ws, overrides, only } = e.data;
  const post = (out: ReturnType<typeof evaluateWorksheet>, partial: boolean) => {
    let results = [...out.results.entries()];
    if (only) results = results.filter(([rid]) => only.includes(rid));
    const msg: EvalResponse = { id, results, errorCount: out.errorCount, millis: out.millis, partial };
    ctx.postMessage(msg);
  };
  await kernelReady;
  let out = evaluateWorksheet(ws, overrides);
  if (out.needsCas && !only) {
    post(out, true);
    await loadCas();
    out = evaluateWorksheet(ws, overrides);
  }
  post(out, false);
};
