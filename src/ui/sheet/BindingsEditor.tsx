import { ArrowRight, Plus, X } from 'lucide-react';
import type { SpreadsheetRegion } from '../../model/types';
import type { SpreadsheetResult } from '../../sheet/component';
import type { SheetInput, SheetOutput } from '../../sheet/model';
import { Tex } from '../Tex';

interface Props {
  region: SpreadsheetRegion;
  result?: SpreadsheetResult;
  /** The selected cell or range, offered for a new input or output. */
  selection: string;
  set: (patch: Partial<SpreadsheetRegion>, coalesce?: string) => void;
}

/** Inputs (worksheet expression → cells, in a unit) and outputs (cells → a variable, with a unit). */
export function BindingsEditor({ region, result, selection, set }: Props) {
  const setInput = (i: number, patch: Partial<SheetInput>) => set({ inputs: region.inputs.map((b, k) => (k === i ? { ...b, ...patch } : b)) }, `ssin:${region.id}:${i}`);
  const setOutput = (i: number, patch: Partial<SheetOutput>) => set({ outputs: region.outputs.map((b, k) => (k === i ? { ...b, ...patch } : b)) }, `ssout:${region.id}:${i}`);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const line = (r: { tex?: string; error?: string } | undefined) => r && (
    <div className={`ss-binding-res${r.error ? ' has-error' : ''}`}>
      {r.tex && <Tex tex={r.tex} />}
      {r.error && <span className="region-error">{r.error}</span>}
    </div>
  );
  return (
    <div className="ss-bindings" onPointerDown={stop}>
      <div className="ss-bind-head">
        <span title="Worksheet values written into cells before the spreadsheet calculates">Inputs</span>
        <button onClick={() => set({ inputs: [...region.inputs, { expr: '', ref: selection, unit: '' }] })} title={`Write a worksheet expression into ${selection}`}><Plus size={12} /> input → {selection}</button>
      </div>
      {region.inputs.map((b, i) => (
        <div key={`i${i}`} className="ss-bind">
          <div className="ss-bind-row">
            <input value={b.expr} placeholder="expression (L, q·1.35 …)" aria-label={`Input ${i + 1} expression`} spellCheck={false} onChange={(e) => setInput(i, { expr: e.target.value })} />
            <ArrowRight size={12} aria-hidden />
            <input className="ref" value={b.ref} placeholder="B2" aria-label={`Input ${i + 1} cell`} spellCheck={false} onChange={(e) => setInput(i, { ref: e.target.value })} />
            <span className="ss-bind-in">in</span>
            <input className="unit" value={b.unit ?? ''} placeholder="unit" aria-label={`Input ${i + 1} unit`} spellCheck={false} onChange={(e) => setInput(i, { unit: e.target.value })} />
            <button className="ss-bind-x" onClick={() => set({ inputs: region.inputs.filter((_, k) => k !== i) })} aria-label={`Remove input ${i + 1}`}><X size={12} /></button>
          </div>
          {line(result?.inputs[i])}
        </div>
      ))}
      <div className="ss-bind-head">
        <span title="Cells read out as worksheet variables after the spreadsheet calculates">Outputs</span>
        <button onClick={() => set({ outputs: [...region.outputs, { name: '', ref: selection, unit: '' }] })} title={`Define a worksheet variable from ${selection}`}><Plus size={12} /> output ← {selection}</button>
      </div>
      {region.outputs.map((b, i) => (
        <div key={`o${i}`} className="ss-bind">
          <div className="ss-bind-row">
            <input value={b.name} placeholder="variable" aria-label={`Output ${i + 1} name`} spellCheck={false} onChange={(e) => setOutput(i, { name: e.target.value })} />
            <span className="ss-bind-in">:=</span>
            <input className="ref" value={b.ref} placeholder="D1" aria-label={`Output ${i + 1} cell`} spellCheck={false} onChange={(e) => setOutput(i, { ref: e.target.value })} />
            <span className="ss-bind-in">in</span>
            <input className="unit" value={b.unit ?? ''} placeholder="unit" aria-label={`Output ${i + 1} unit`} spellCheck={false} onChange={(e) => setOutput(i, { unit: e.target.value })} />
            <button className="ss-bind-x" onClick={() => set({ outputs: region.outputs.filter((_, k) => k !== i) })} aria-label={`Remove output ${i + 1}`}><X size={12} /></button>
          </div>
          {line(result?.outputs[i])}
        </div>
      ))}
    </div>
  );
}
