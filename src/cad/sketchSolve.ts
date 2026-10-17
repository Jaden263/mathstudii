// A sketch solved with known dimension values, as the worksheet and the CAD window see it:
// solved positions, freedom, dimension readouts, profile problems and the section. The
// worksheet evaluates the dimension expressions first (evaluate.ts); a sketch whose
// projected references moved is solved again with the same values while its timeline is
// built (design.ts).
import type { CadResult } from './evaluate';
import { isDimension, sketchSig, type CadSketch } from './model';
import { measure, solveSketch } from './solver';
import { findProfiles, profileProperties, type ProfileRegion, type Vec2 } from './profile';

export interface SketchSolution {
  result: CadResult;
  regions: ProfileRegion[];
  points: Map<string, Vec2>;
  radii: Map<string, number>;
}

/** Solve a sketch with its driving dimensions' values (sketch units, radians); `sig` defaults to the sketch's own. */
export function sketchSolution(sk: CadSketch, values: Map<string, number>, dimErrors: Record<string, string> = {}, sig = sketchSig(sk)): SketchSolution {
  const sol = solveSketch(sk, { values });
  const measured: Record<string, number> = {};
  for (const c of sk.constraints) if (isDimension(c.type)) measured[c.id] = measure(sk, c, sol.points, sol.radii);
  const { regions, issues } = findProfiles(sk, sol.points, sol.radii);
  const result: CadResult = {
    kind: 'cad',
    sig,
    points: Object.fromEntries([...sol.points].map(([id, p]) => [id, [p.x, p.y]])),
    radii: Object.fromEntries(sol.radii),
    ok: sol.ok, dof: sol.dof,
    determined: [...sol.determined], determinedRadii: [...sol.determinedRadii],
    conflicting: sol.conflicting, redundant: sol.redundant,
    values: measured, dimErrors, issues,
  };
  const section = profileProperties(regions);
  if (section) result.section = section;
  return { result, regions, points: sol.points, radii: sol.radii };
}
