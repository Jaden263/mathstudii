// What an import report adds once the imported worksheet has calculated: the functions it calls
// that neither the worksheet nor mathstudii defines. Mathcad worksheets call functions of add-ins
// (user DLLs such as CoolProp or REFPROP) and of referenced worksheets; their results cannot be
// calculated here, and the report says which ones and where they come from when that is known.
import type { Region } from '../model/types';

/** Add-ins (Mathcad user DLLs) known by the names of their functions. */
const ADD_INS: [RegExp, string][] = [
  [/^(PropsSI|Props1SI|HAPropsSI|PhaseSI|get_fluid_param_string|get_global_param_string|set_reference_state|FluidProp|FluidProp1|HAProp|FluidPropsParams)$/, 'CoolProp'],
  [/^rp_/, 'REFPROP'],
  [/^if97_/, 'IAPWS-IF97 (CoolProp)'],
  [/^hr_/, 'libhydrocalc'],
  [/^(netefi|cstest\d*|vbtest\d*|cpptest|cppecho)$/, 'NetEFI'],
];

export interface MissingFunction {
  name: string;
  /** Regions whose own calculation stops at it. */
  regions: number;
  /** The add-in it belongs to, when its name tells. */
  addIn?: string;
}

/**
 * Functions called in the worksheet that are not defined (the evaluation's “… is not defined”
 * on a region that calls the name), most used first.
 */
export function missingFunctions(regions: Region[], results: Map<string, unknown>): MissingFunction[] {
  const count = new Map<string, number>();
  for (const r of regions) {
    const res = results.get(r.id) as { error?: string; solver?: { error?: string } } | undefined;
    const error = res?.error ?? res?.solver?.error;
    const m = error ? /"([^"]+)" is not defined/.exec(error) : null;
    if (!m) continue;
    const name = m[1];
    const src = r.kind === 'math' ? r.source : r.kind === 'solve' ? `${r.guesses}\n${r.constraints}\n${r.solver}` : '';
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}\\s*\\(`, 'u').test(src)) continue;
    count.set(name, (count.get(name) ?? 0) + 1);
  }
  return [...count.entries()]
    .map(([name, n]) => ({ name, regions: n, ...(ADD_INS.find(([re]) => re.test(name)) ? { addIn: ADD_INS.find(([re]) => re.test(name))![1] } : {}) }))
    .sort((a, b) => b.regions - a.regions || a.name.localeCompare(b.name));
}

/** The report's sentence about them: grouped by add-in, the others named as they are. */
export function missingFunctionsText(list: MissingFunction[]): string {
  if (!list.length) return '';
  const byAddIn = new Map<string, string[]>();
  for (const f of list) byAddIn.set(f.addIn ?? '', [...(byAddIn.get(f.addIn ?? '') ?? []), f.name]);
  const parts = [...byAddIn.entries()].map(([addIn, names]) => {
    const shown = names.length > 8 ? `${names.slice(0, 8).join(', ')} and ${names.length - 8} more` : names.join(', ');
    return addIn ? `${shown} (from the ${addIn} add-in, a program library Mathcad loads, which does not run here)` : `${shown} (not Mathcad built-ins: from an add-in, a referenced worksheet or a region that was not imported)`;
  });
  return `It calls functions that neither it nor mathstudii defines: ${parts.join('; ')}. What uses them does not calculate.`;
}
