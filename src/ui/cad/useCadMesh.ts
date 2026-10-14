import { useMemo } from 'react';
import type { CadRegion } from '../../model/types';
import type { CadResult } from '../../cad/evaluate';
import { revolveAxis } from '../../cad/evaluate';
import { sketchSig } from '../../cad/model';
import { findProfiles } from '../../cad/profile';
import { withSolution } from '../../cad/edit';
import { extrudeMesh, revolveMesh, type Mesh } from '../../cad/mesh';

/** Triangle mesh of a part's solid, from the worksheet's solved geometry. */
export function useCadMesh(region: CadRegion, result: CadResult | undefined, enabled: boolean): Mesh | null {
  return useMemo(() => {
    if (!enabled || !result?.mass) return null;
    const sk = result.sig === sketchSig(region.sketch) ? withSolution(region.sketch, result.points, result.radii) : region.sketch;
    const { regions } = findProfiles(sk);
    const f = region.feature;
    try {
      if (f.type === 'extrude' && result.depth) return extrudeMesh(regions, result.depth, f.symmetric);
      if (f.type === 'revolve' && result.angle) {
        const P = new Map(sk.points.map((p) => [p.id, { x: p.x, y: p.y }]));
        const axis = revolveAxis(sk, f, P);
        return axis ? revolveMesh(regions, axis, result.angle) : null;
      }
    } catch {
      return null;
    }
    return null;
  }, [enabled, result, region.sketch, region.feature]);
}
