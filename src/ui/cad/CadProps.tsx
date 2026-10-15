// The worksheet's side panel for a CAD part: its name and units, the material, what
// the worksheet can read from it, and the totals. Modelling happens in the CAD window.
import type { Dispatch } from 'react';
import { Box } from 'lucide-react';
import type { CadRegion } from '../../model/types';
import type { CadResult } from '../../cad/evaluate';
import { CAD_UNITS, MATERIALS, type CadUnit } from '../../cad/model';
import { designOf, identifier, isSketch } from '../../cad/design';
import type { Action } from '../store';
import { LazyInput } from '../sketch/SketchProps';
import { useOpenCad } from './cadWindow';
import { MassTable } from './SketchPanel';

export function CadProps({ region, result, dispatch }: { region: CadRegion; result?: CadResult; dispatch: Dispatch<Action> }) {
  const openCad = useOpenCad();
  const set = (patch: Partial<CadRegion>, key = 'cad') => dispatch({ type: 'update', id: region.id, patch, coalesce: `${key}:${region.id}` });
  const material = MATERIALS.find((m) => m.density === region.density.trim());
  const name = region.name.trim() || 'part';
  const design = designOf(region);
  const comps = design.components;
  const firstSketch = comps[0]?.items.find(isSketch);
  return (
    <div className="props">
      <h3 className="sub">CAD part</h3>
      <button className="btn" onClick={() => openCad(region.id)}><Box size={14} /> Open in CAD</button>
      <label className="field">
        <span>Variable for the part's properties</span>
        <LazyInput label="Variable name" value={region.name} placeholder="e.g. part" onCommit={(v) => set({ name: v.trim() }, 'name')} />
      </label>
      <p className="hint">
        The math below can use <code>{name}.V</code>, <code>{name}.m</code>, <code>{name}.Imz</code>, <code>{name}.Lx</code>
        {firstSketch ? <>, the first sketch's section (<code>{name}.A</code>, <code>{name}.Ix</code>)</> : null}
        {comps.length > 1 ? <>, each component (<code>{name}.{identifier(comps[1].name)}.m</code>)</> : null}
        {' '}and every named dimension (<code>{name}.d1</code>).
      </p>
      <div className="row2">
        <label className="field">
          <span>Units</span>
          <select value={region.unit} onChange={(e) => set({ unit: e.target.value as CadUnit })}>
            {CAD_UNITS.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Material</span>
          <select value={material ? material.density : region.density.trim() ? 'custom' : 'none'} onChange={(e) => {
            const v = e.target.value;
            if (v === 'none') set({ density: '' });
            else if (v !== 'custom') set({ density: v });
          }}>
            {MATERIALS.map((x) => <option key={x.name} value={x.density}>{x.name}</option>)}
            <option value="custom">Custom density</option>
            <option value="none">No mass</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span>On the page</span>
        <select value={region.mode} onChange={(e) => set({ mode: e.target.value as CadRegion['mode'] })}>
          <option value="3d">3-D model</option>
          <option value="2d">Drawing of the first sketch</option>
          <option value="split">Both</option>
        </select>
      </label>
      <label className="field">
        <span>Density</span>
        <LazyInput label="Density" value={region.density} placeholder="kg/m^3" onCommit={(v) => set({ density: v.trim() }, 'density')} />
      </label>
      {result?.error && <div className="region-error">{result.error}</div>}
      {result?.featureError && <div className="region-error">{result.featureError}</div>}
      <h3 className="sub">Design</h3>
      <p className="hint">
        {comps.length} component{comps.length > 1 ? 's' : ''}, {design.occurrences.length} occurrence{design.occurrences.length > 1 ? 's' : ''}, {design.joints.length} joint{design.joints.length === 1 ? '' : 's'}
        {result ? ` · ${result.dof === 0 ? 'sketches fully defined' : `${result.dof} DOF free in the sketches`}` : ''}
      </p>
      <MassTable m={result?.mass} unit={region.unit} />
    </div>
  );
}
