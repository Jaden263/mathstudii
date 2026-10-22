// Icons of the sheet-metal tools, drawn like lucide's (24 × 24, 2 px round strokes) so
// they sit with the others in the ribbon and the timeline.
import type { ReactNode } from 'react';

function Icon({ size = 20, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/** A plate on a sketch profile, its edge turned up. */
export const FlangeIcon = ({ size }: { size?: number }) => (
  <Icon size={size}><path d="M3 18h11a4 4 0 0 0 4-4V4" /><path d="M3 21h11a7 7 0 0 0 7-7V4" /><path d="M3 18v3M18 4h3" /></Icon>
);

/** A flange standing on an edge of the sheet. */
export const EdgeFlangeIcon = ({ size }: { size?: number }) => (
  <Icon size={size}><path d="M2 20h10l4-4V4" /><path d="M2 17h9l2-2V4" opacity={0.55} /><path d="M13 4h3" /></Icon>
);

/** An edge folded back on itself. */
export const HemIcon = ({ size }: { size?: number }) => (
  <Icon size={size}><path d="M3 15h13a3 3 0 0 0 0-6H8" /><path d="M3 19h13a7 7 0 0 0 0-14H8" /></Icon>
);

/** A sheet bent along a line. */
export const BendIcon = ({ size }: { size?: number }) => (
  <Icon size={size}><path d="M2 18h9l9-9" /><path d="M11 18v-6" strokeDasharray="2 2" /></Icon>
);

/** The flat blank, its bend lines dashed. */
export const FlatIcon = ({ size }: { size?: number }) => (
  <Icon size={size}><rect x="3" y="5" width="18" height="14" rx="1" /><path d="M9 5v14M15 5v14" strokeDasharray="2 2" /></Icon>
);

/** The rules: thickness and radius. */
export const RulesIcon = ({ size }: { size?: number }) => (
  <Icon size={size}><path d="M4 7h16M4 11h16" /><path d="M4 16h7a4 4 0 0 0 4-4" /><path d="M17 15l3 3-3 3" /></Icon>
);
