// Input controls on definitions (MathRegion.choices): picking a choice rewrites the definition.
import type { MathChoices } from './types';

/** The definition with the i-th choice's value, or null when the source is not a definition. */
export function pickChoice(source: string, choices: MathChoices, i: number): string | null {
  const m = /^([^\n]*?)\s*(:=|≡)\s*/.exec(source);
  if (!m || i < 0 || i >= choices.values.length) return null;
  return `${m[1]} ${m[2]} ${choices.values[i]}`;
}
