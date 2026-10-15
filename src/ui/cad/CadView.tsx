// A CAD part on the worksheet page: a live preview (drawing, 3-D model, or both).
// Editing happens in the CAD window — double-click, or the Open button.
import { useEffect, useMemo, type Dispatch } from 'react';
import { Box } from 'lucide-react';
import type { CadRegion } from '../../model/types';
import type { RegionResult } from '../../engine/evaluator';
import type { CadResult } from '../../cad/evaluate';
import type { Action } from '../store';
import { useSketchUI } from '../sketch/context';
import { CadCanvas } from './CadCanvas';
import { Scene3D } from './Scene3D';
import { useOpenCad } from './cadWindow';
import { buildScene, useBuilt, useKernel } from './useDesign';
import { designOf, isSketch } from '../../cad/design';

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
  const design = useMemo(() => designOf(region), [region]);
  const K = useKernel();
  const built = useBuilt(region.id, design, res);
  const hasBodies = !!res?.design && Object.values(res.design.bodies).some((b) => b.length);
  const scene = useMemo(
    () => buildScene(region, design, res, built, { active: hasBodies ? '' : design.components[0]?.id ?? '', highlight: new Set(), showPlanes: false, pickProfiles: false, size: 100 }),
    [region, design, res, built, hasBodies],
  );
  // the drawing shows the first sketch of the first component
  const first = design.components[0]?.items.find(isSketch);
  const sketchRegion = useMemo<CadRegion>(() => (first ? { ...region, sketch: first.sketch, viewW: undefined } : region), [region, first]);
  const sketchRes = first ? res?.design?.sketches[first.id] ?? (region.design ? undefined : res) : res;

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
    if (!res.ok) return { cls: 'bad', text: 'A sketch has conflicting constraints' };
    if (res.featureError) return { cls: 'warn', text: res.featureError };
    const errs = Object.keys(res.dimErrors).length;
    if (errs) return { cls: 'bad', text: `${errs} dimension error${errs > 1 ? 's' : ''}` };
    return null;
  })();
  const empty = !design.components.some((c) => c.items.length) && !region.sketch.entities.length;

  return (
    <div className="sketch-region cad-region" style={{ width: region.width }}>
      <div className="cad-body">
        {region.mode !== '3d' && (
          <CadCanvas region={sketchRegion} result={sketchRes} dispatch={region.design ? () => {} : dispatch} width={sketchW} height={region.height} interactive={false} />
        )}
        {region.mode !== '2d' && (
          <div className={`cad-3d${split ? ' split' : ''}`} style={{ pointerEvents: 'none' }}>
            <Scene3D
              width={region.width - (split ? sketchW : 0)} height={region.height} meshes={scene.meshes} lines={scene.lines}
              view={{ yaw: region.view3d.yaw, pitch: region.view3d.pitch, zoom: 1, pan: { x: 0, y: 0 } }} onView={() => {}} viewCube={false} showTriad={false}
              message={!K ? 'Loading the 3-D kernel…' : !scene.meshes.length && !scene.lines.length ? 'Open the part and model it: Sketch, then Extrude' : undefined}
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
