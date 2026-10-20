// Units of a beam region, in its toolbar and at the top of its side panel: the length and
// force units of the model (converting the numbers so the structure keeps its size, or
// keeping them), the units the results are shown in, and number fields that take a unit.
import { useEffect, useId, useState, type Dispatch } from 'react';
import type { BeamRegion } from '../../model/types';
import type { BeamResult } from '../../beam/evaluate';
import { BEAM_FORCE_UNITS, BEAM_LENGTH_UNITS } from '../../beam/model';
import { DISPLAY_UNITS, changeUnits, displayUnits, readNumber, type BeamDisplayUnits } from '../../beam/units';
import { loadPref, savePref } from '../../platform/files';
import type { Action } from '../store';

const DISPLAY_LABELS: [keyof BeamDisplayUnits, string][] = [['force', 'Forces'], ['moment', 'Moments'], ['line', 'Line loads'], ['defl', 'Deflection'], ['stress', 'Stress']];

/** Length and force units (converting or keeping the numbers) and the units of the results. */
export function BeamUnitsFields({ region, result, dispatch, onChanged }: {
  region: BeamRegion; result?: BeamResult; dispatch: Dispatch<Action>;
  /** Told what was done (for a short note). */
  onChanged?: (note: string) => void;
}) {
  const [convert, setConvert] = useState<boolean>(() => loadPref('beamConvertUnits', true) ?? true);
  // (the toolbar's and the side panel's radio buttons are separate groups)
  const group = useId();
  useEffect(() => savePref('beamConvertUnits', convert), [convert]);
  // what "auto" means: from the units, and line loads from the force shown
  const auto = displayUnits({ lengthUnit: region.lengthUnit, forceUnit: region.forceUnit, display: { force: region.display?.force } });
  const change = (to: { lengthUnit?: BeamRegion['lengthUnit']; forceUnit?: BeamRegion['forceUnit'] }) => {
    const next = { lengthUnit: to.lengthUnit ?? region.lengthUnit, forceUnit: to.forceUnit ?? region.forceUnit };
    if (next.lengthUnit === region.lengthUnit && next.forceUnit === region.forceUnit) return;
    // one undo step: the units and every number converted with them
    dispatch({ type: 'update', id: region.id, patch: changeUnits(region, next, { convert, bare: result?.bare }) });
    onChanged?.(convert
      ? `Now in ${next.lengthUnit} and ${next.forceUnit}: coordinates, grid and loads converted (Ctrl+Z undoes it)`
      : `Now in ${next.lengthUnit} and ${next.forceUnit}: the numbers mean the new units (Ctrl+Z undoes it)`);
  };
  const setDisplay = (k: keyof BeamDisplayUnits, v: string) => {
    const display = { ...region.display, [k]: v || undefined };
    const empty = Object.values(display).every((x) => !x);
    dispatch({ type: 'update', id: region.id, patch: { display: empty ? undefined : display }, coalesce: `display:${region.id}:${k}` });
  };
  return (
    <div className="bm-units">
      <div className="row2">
        <label className="field" title="Unit of the coordinates, the grid and of lengths typed without a unit"><span>Lengths</span>
          <select aria-label="Length unit" value={region.lengthUnit} onChange={(e) => change({ lengthUnit: e.target.value as BeamRegion['lengthUnit'] })}>
            {BEAM_LENGTH_UNITS.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label className="field" title="Unit of forces typed without a unit (moments: force·length, line loads: force/length)"><span>Forces</span>
          <select aria-label="Force unit" value={region.forceUnit} onChange={(e) => change({ forceUnit: e.target.value as BeamRegion['forceUnit'] })}>
            {BEAM_FORCE_UNITS.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
      </div>
      <div className="bm-units-mode" role="radiogroup" aria-label="When the unit changes">
        <label className="check" title="Coordinates, grid, loads and springs are converted: a 6 m span becomes 6000 mm, 12 kN becomes 12000 N">
          <input type="radio" name={group} checked={convert} onChange={() => setConvert(true)} /> Convert the numbers (same structure)
        </label>
        <label className="check" title="The numbers stay and mean the new unit: a 6 m span becomes 6 mm">
          <input type="radio" name={group} checked={!convert} onChange={() => setConvert(false)} /> Keep the numbers
        </label>
      </div>
      <p className="hint">A bare number is in these units; any field also takes a unit of its own (<code>250 mm</code>, <code>7.5 kN/m</code>, <code>12 kN·m</code>, <code>1.35*q_k</code>), which a change of units leaves alone.</p>
      <div className="bm-units-sub">Results shown in</div>
      <div className="row2 bm-units-display">
        {DISPLAY_LABELS.map(([k, label]) => (
          <label key={k} className="field"><span>{label}</span>
            <select aria-label={`${label} shown in`} value={region.display?.[k] ?? ''} onChange={(e) => setDisplay(k, e.target.value)}>
              <option value="">auto ({auto[k][0]})</option>
              {DISPLAY_UNITS[k].map(([n]) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * A number field in `unit` that also takes a unit of its own or arithmetic (250 mm,
 * 1.5 ft, 2.5 + 1.25, 90°), committed on Enter or when it loses the focus; the unit a
 * bare number is in is shown after it.
 */
export function QtyInput({ value, unit, onCommit, label, show = unit, digits = 6 }: {
  value: number; unit: string; onCommit: (v: number) => void; label: string;
  /** How the unit is written after the field ("°"). */
  show?: string;
  digits?: number;
}) {
  const shown = String(+value.toFixed(digits));
  const [text, setText] = useState(shown);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setText(shown);
    setBad(false);
  }, [shown]);
  const commit = () => {
    if (text.trim() === shown) return;
    const v = readNumber(text, unit);
    if (v === null) {
      setBad(true);
      return;
    }
    setBad(false);
    if (v !== value) onCommit(v);
    else setText(shown);
  };
  return (
    <span className={`bm-qty${bad ? ' bad' : ''}`} title={bad ? `Not a number or a ${unit === 'deg' ? 'n angle' : ' length'}` : `A number in ${show}, or with a unit (${unit === 'deg' ? '0.5 rad' : '250 mm'})`}>
      <input
        className="mono" value={text} aria-label={label} spellCheck={false} aria-invalid={bad || undefined}
        onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') {
            setText(shown);
            setBad(false);
          }
        }}
      />
      <span className="bm-qty-unit">{show}</span>
    </span>
  );
}
