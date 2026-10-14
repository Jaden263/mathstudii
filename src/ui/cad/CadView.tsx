// A CAD part on the worksheet page: a live preview (drawing, 3-D model, or both).
// Editing happens in the CAD window — double-click, or the Open button.
import { useEffect, type Dispatch } from 'react';
import { Box } from 'lucide-react';
import type { CadRegion } from '../../model/types';
import type { RegionResult } from '../../engine/evaluator';
import type { CadResult } from '../../cad/evaluate';
import type { Action } from '../store';
import { useSketchUI } from '../sketch/context';
import { CadCanvas } from './CadCanvas';
import { Cad3DView } from './Cad3DView';
import { useCadMesh } from './useCadMesh';
import { useOpenCad } from './cadWindow';

interface Props {
  region: CadRegion;
  result?: RegionResult;
  editing: boolean;
  selected: boolean;
  dispatch: Dispatch<Action>;
  onDone: (moveBelow?: boolean) => void;
}

export function CadView({ region, result, editing, selected, dispatch, onDone }: Props) {
  const { separate } = useSketchUI();
  const openCad = useOpenCad();
  const res = result?.kind === 'cad' ? (result as CadResult) : undefined;
  const split = region.mode === 'split';
  const sketchW = split ? Math.round(region.width * 0.58) : region.width;
  const mesh = useCadMesh(region, res, region.mode !== '2d');

  // "editing" a part on the page means opening its CAD window
  useEffect(() => {
    if (!editing) return;
    openCad(region.id);
    onDone(false);
  }, [editing, openCad, region.id, onDone]);

  const startResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const sheet = (e.currentTarget as HTMLElement).closest('.sheet') as HTMLElement | null;
    const pageZoom = sheet ? sheet.getBoundingClientRect().width / sheet.offsetWidth : 1;
    const start = { x: e.clientX, y: e.clientY, w: region.width, h: region.height, view: region.view };
    const move = (ev: PointerEvent) => {
      const kx = (start.w + (ev.clientX - start.x) / pageZoom) / start.w;
      const ky = (start.h + (ev.clientY - start.y) / pageZoom) / start.h;
      const k = Math.max(200 / start.w, 140 / start.h, Math.max(kx, ky));
      dispatch({
        type: 'update', id: region.id, coalesce: `resize:${region.id}`,
        patch: { width: Math.round(start.w * k), height: Math.round(start.h * k), view: { ...start.view, zoom: start.view.zoom * k } },
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      separate(`resize:${region.id}`);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const status = (() => {
    if (!res) return null;
    if (res.error) return { cls: 'bad', text: res.error };
    if (!res.ok) return { cls: 'bad', text: `${res.conflicting.length} conflicting constraint${res.conflicting.length > 1 ? 's' : ''}` };
    if (res.featureError) return { cls: 'warn', text: res.featureError };
    const errs = Object.keys(res.dimErrors).length;
    if (errs) return { cls: 'bad', text: `${errs} dimension error${errs > 1 ? 's' : ''}` };
    return null;
  })();
  const empty = !region.sketch.entities.length;

  return (
    <div className="sketch-region cad-region" style={{ width: region.width }}>
      <div className="cad-body">
        {region.mode !== '3d' && (
          <CadCanvas region={region} result={res} dispatch={dispatch} width={sketchW} height={region.height} interactive={false} />
        )}
        {region.mode !== '2d' && (
          <div className={`cad-3d${split ? ' split' : ''}`} style={{ pointerEvents: 'none' }}>
            <Cad3DView
              mesh={mesh} width={region.width - (split ? sketchW : 0)} height={region.height}
              yaw={region.view3d.yaw} pitch={region.view3d.pitch} onView={() => {}} unitLabel={region.unit}
              message={region.feature.type === 'none' ? 'Open the part and add Extrude or Revolve' : res?.featureError}
            />
          </div>
        )}
      </div>
      {empty && <div className="cad-empty-hint">Empty part — double-click to open the CAD window</div>}
      {status && <div className={`sk-status cad-status ${status.cls}`}>{status.text}</div>}
      {selected && (
        <>
          <button className="cad-open" onClick={(e) => { e.stopPropagation(); openCad(region.id); }} onPointerDown={(e) => e.stopPropagation()}
            title="Edit the part in the CAD window (or double-click it)">
            <Box size={14} /> Open in CAD
          </button>
          <div className="resize-handle sk-resize" onPointerDown={startResize} title="Drag to resize (the drawing scales with it)" aria-label="Resize CAD region" />
        </>
      )}
    </div>
  );
}
