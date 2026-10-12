import { useCallback, useEffect, useRef, useState } from 'react';
import type { Worksheet } from '../model/types';
import type { RegionResult } from '../engine/evaluator';
import type { EvalRequest, EvalResponse } from '../engine/worker';

export interface EvaluationState {
  results: Map<string, RegionResult>;
  busy: boolean;
  /** Calculation has been running long enough to offer an interrupt. */
  slow: boolean;
  errorCount: number;
  millis: number;
  interrupted: boolean;
}

const SLOW_MS = 1200;

function createWorker() {
  return new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' });
}

/** Evaluates the worksheet in a Web Worker whenever it changes (debounced). */
export function useEvaluation(ws: Worksheet, auto: boolean) {
  const [state, setState] = useState<EvaluationState>({
    results: new Map(), busy: false, slow: false, errorCount: 0, millis: 0, interrupted: false,
  });
  const workerRef = useRef<Worker | null>(null);
  const reqId = useRef(0);
  const slowTimer = useRef<number | undefined>(undefined);
  const latest = useRef(ws);
  latest.current = ws;

  const attach = useCallback((w: Worker) => {
    w.onmessage = (e: MessageEvent<EvalResponse>) => {
      const msg = e.data;
      if (msg.id !== reqId.current) return;
      if (!msg.partial) window.clearTimeout(slowTimer.current);
      setState({
        results: new Map(msg.results),
        busy: msg.partial,
        slow: false,
        errorCount: msg.errorCount,
        millis: msg.millis,
        interrupted: false,
      });
    };
    w.onerror = (err) => {
      console.error('Evaluation worker error', err);
      setState((s) => ({ ...s, busy: false, slow: false }));
    };
  }, []);

  const getWorker = useCallback(() => {
    if (!workerRef.current) {
      workerRef.current = createWorker();
      attach(workerRef.current);
    }
    return workerRef.current;
  }, [attach]);

  const calculate = useCallback(() => {
    const id = ++reqId.current;
    const req: EvalRequest = { id, ws: latest.current };
    getWorker().postMessage(req);
    setState((s) => ({ ...s, busy: true }));
    window.clearTimeout(slowTimer.current);
    slowTimer.current = window.setTimeout(() => {
      if (reqId.current === id) setState((s) => (s.busy ? { ...s, slow: true } : s));
    }, SLOW_MS);
  }, [getWorker]);

  const interrupt = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    reqId.current++;
    window.clearTimeout(slowTimer.current);
    setState((s) => ({ ...s, busy: false, slow: false, interrupted: true }));
  }, []);

  useEffect(() => {
    if (!auto) return;
    const t = window.setTimeout(calculate, 120);
    return () => window.clearTimeout(t);
  }, [ws, auto, calculate]);

  useEffect(() => () => workerRef.current?.terminate(), []);

  return { ...state, calculate, interrupt };
}
