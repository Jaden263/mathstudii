import { useCallback, useEffect, useRef, useState } from 'react';
import type { Worksheet } from '../model/types';
import type { RegionResult } from '../engine/evaluator';
import type { EvalRequest, EvalResponse } from '../engine/worker';
import { isDisplayMessage, type DisplayMessage } from '../cad/kernel/protocol';
import { kernelHostStopped, receiveDisplay, setKernelHost } from './cad/kernelClient';
import { isExportResponse, type ExportRequest, type ExportResponse } from '../sheet/exportWorker';

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
  const exports = useRef(new Map<number, (r: ExportResponse) => void>());

  const attach = useCallback((w: Worker) => {
    w.onmessage = (e: MessageEvent<EvalResponse | DisplayMessage | ExportResponse>) => {
      // CAD display data follows the results it belongs to
      if (isDisplayMessage(e.data)) return receiveDisplay(e.data);
      if (isExportResponse(e.data)) {
        exports.current.get(e.data.xlsxExport)?.(e.data);
        exports.current.delete(e.data.xlsxExport);
        return;
      }
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
      // the CAD views' kernel requests it was answering fail now instead of waiting forever
      kernelHostStopped('the calculation failed — try again');
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
    for (const done of exports.current.values()) done({ xlsxExport: 0, error: 'The calculation was interrupted' });
    exports.current.clear();
    kernelHostStopped();
    reqId.current++;
    window.clearTimeout(slowTimer.current);
    setState((s) => ({ ...s, busy: false, slow: false, interrupted: true }));
  }, []);

  useEffect(() => {
    if (!auto) return;
    const t = window.setTimeout(calculate, 120);
    return () => window.clearTimeout(t);
  }, [ws, auto, calculate]);

  /** The worksheet's values as an .xlsx file, made by the calculation worker. */
  const exportXlsx = useCallback((doc: Worksheet) => new Promise<Uint8Array>((resolve, reject) => {
    const id = Date.now() + Math.random();
    exports.current.set(id, (r) => (r.bytes ? resolve(r.bytes) : reject(new Error(r.error ?? 'Export failed'))));
    getWorker().postMessage({ xlsxExport: id, ws: doc } satisfies ExportRequest);
  }), [getWorker]);

  useEffect(() => () => workerRef.current?.terminate(), []);
  // the calculation worker also answers the CAD views' kernel requests (set while rendering:
  // the views below ask in their effects, which run before this hook's)
  setKernelHost(getWorker);

  return { ...state, calculate, interrupt, exportXlsx };
}
