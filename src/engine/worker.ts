/// <reference lib="webworker" />
// Runs worksheet evaluation off the UI thread so long calculations (or
// accidental infinite loops) never freeze the interface.
import { evaluateWorksheet, type RegionResult } from './evaluator';
import { loadCas } from './symbolic';
import type { Worksheet } from '../model/types';

export interface EvalRequest {
  id: number;
  ws: Worksheet;
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

ctx.onmessage = async (e: MessageEvent<EvalRequest>) => {
  const { id, ws } = e.data;
  const post = (out: ReturnType<typeof evaluateWorksheet>, partial: boolean) => {
    const msg: EvalResponse = { id, results: [...out.results.entries()], errorCount: out.errorCount, millis: out.millis, partial };
    ctx.postMessage(msg);
  };
  let out = evaluateWorksheet(ws);
  if (out.needsCas) {
    post(out, true);
    await loadCas();
    out = evaluateWorksheet(ws);
  }
  post(out, false);
};
