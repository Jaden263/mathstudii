// What an assembly's motion is made of, as stored in the document: the degrees of freedom
// (DOFs) each joint type has, their limits and whether the assembly solves them, motion
// links between two DOFs, rigid groups, explode offsets and motion studies. Plain JSON
// like the rest of the design; kinematics.ts places the occurrences from it.
import type { JointType } from './design';
import type { Vec3 } from './solid';

/**
 * A joint's values. Every joint has all six, most of them fixed at 0: the motion puts the
 * moving side at (x, y, offset) on the parent's joint frame and turns it about Z by
 * `angle`, then about the turned Y by `angle2` and the turned X by `angle3`.
 */
export type DofKey = 'angle' | 'angle2' | 'angle3' | 'offset' | 'x' | 'y';
export const DOF_KEYS: DofKey[] = ['angle', 'angle2', 'angle3', 'offset', 'x', 'y'];

/** The DOFs a joint type moves by (its other values are fixed offsets). */
export const JOINT_DOFS: Record<JointType, DofKey[]> = {
  rigid: [],
  revolute: ['angle'],
  slider: ['offset'],
  cylindrical: ['angle', 'offset'],
  // turns about Z and slides along the parent's X (the slot)
  pinslot: ['angle', 'x'],
  // slides in the parent's XY plane and turns about its normal
  planar: ['x', 'y', 'angle'],
  // yaw about Z, pitch about the turned Y, roll about the turned X (Z–Y′–X″ as in ISO 1151-2)
  ball: ['angle', 'angle2', 'angle3'],
};

export const JOINT_LABEL: Record<JointType, string> = {
  rigid: 'Rigid', revolute: 'Revolute', slider: 'Slider', cylindrical: 'Cylindrical', pinslot: 'Pin-slot', planar: 'Planar', ball: 'Ball',
};

export const isAngleDof = (k: DofKey) => k === 'angle' || k === 'angle2' || k === 'angle3';

/** What a DOF is called in dialogs and messages. */
export function dofLabel(type: JointType, k: DofKey): string {
  if (type === 'ball') return k === 'angle' ? 'yaw (about Z)' : k === 'angle2' ? 'pitch (about Y′)' : k === 'angle3' ? 'roll (about X″)' : k;
  if (type === 'pinslot' && k === 'x') return 'slide (along X)';
  return { angle: 'angle', angle2: 'pitch', angle3: 'roll', offset: 'offset', x: 'x', y: 'y' }[k];
}

/** A DOF in a sentence: "the angle", "the slide", "the pitch". */
export function dofWord(type: JointType, k: DofKey): string {
  if (k === 'angle') return type === 'ball' ? 'yaw' : 'angle';
  if (k === 'angle2') return 'pitch';
  if (k === 'angle3') return 'roll';
  if (k === 'x') return type === 'pinslot' ? 'slide' : 'x';
  return k;
}

/** One DOF's settings: solved by the assembly instead of driven, its limits and rest value (worksheet expressions). */
export interface JointDof {
  /** The assembly finds the value (a joint in a closed loop); its expression is not used. */
  free?: boolean;
  min?: string;
  max?: string;
  /** Where the DOF starts from (and stays, when nothing else sets a solved one). */
  rest?: string;
}

/** b = ratio · a + offset: one DOF follows another (gears, rack and pinion, a belt). */
export interface MotionLink {
  id: string;
  name: string;
  a: { joint: string; dof: DofKey };
  b: { joint: string; dof: DofKey };
  /**
   * How far b moves per unit of a: a plain number between two angles or two lengths, a
   * length between an angle and a length (per radian: the pinion's pitch radius), or a
   * unit such as mm/deg.
   */
  ratio: string;
  /** Value of b where a is 0 (b's unit); empty: 0. */
  offset?: string;
  suppressed?: boolean;
}

/** Occurrences locked together where they were when grouped. */
export interface RigidGroup {
  id: string;
  name: string;
  occs: string[];
  /** Each member's placement relative to the first member's then (column-major 4×4). */
  rel: Record<string, number[]>;
  suppressed?: boolean;
}

/** How far an occurrence moves out in the exploded view (assembly coordinates). */
export interface ExplodeOffset {
  /** Unit direction. */
  dir: Vec3;
  /** Distance (worksheet expression). */
  d: string;
}

/** A DOF moved through keyframes (times in seconds, values worksheet expressions). */
export interface MotionTrack {
  joint: string;
  dof: DofKey;
  keys: { t: number; v: string }[];
}

export interface MotionStudy {
  id: string;
  name: string;
  /** Length of the study (s). */
  duration: number;
  /** Frames the study is sampled at for its results (the worksheet's table), besides t = 0. */
  steps?: number;
  /** Between keys: straight lines, or smooth (monotone cubic, starting and stopping at rest). */
  interp?: 'linear' | 'smooth';
  tracks: MotionTrack[];
  /** Track the smallest clearance and any interference between occurrences frame by frame. */
  clearance?: boolean;
  /** Leave out the pairs a joint joins directly (a pin in its hole touches by design); default true. */
  skipJoined?: boolean;
}
