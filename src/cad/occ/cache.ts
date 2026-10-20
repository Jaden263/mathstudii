// Incremental rebuilds. Every step of a component's timeline keeps what it built (its
// OCCT objects live in an arena of their own), filed under a key of everything it
// depends on (keys.ts). A change to one feature rebuilds that feature and the ones after
// it; rolling the timeline marker back and forth, renaming, recolouring or panning a
// sketch rebuilds nothing.
//
// The steps form a tree (a design that is edited back and forth keeps both branches). A
// step's solids are used by the steps after it, so only the ends of branches are evicted,
// least recently used first.
import {
  activeItems, buildInputs, emptyTimeline, findSketch, namedBodies, placeOccurrences, timelineStep,
  type CadDesign, type DesignNumbers, type SolidOps, type TimelineState,
} from '../design';
import { stepKey } from '../keys';
import { Arena } from '../solid';
import type { OccBuiltDesign, OccComponentBuild } from './build';
import { hasSolid, onOccRenewed, type OC } from './kernel';
import { occOps, type OccSolid } from './ops';
import { topologyOcc } from './topology';

interface Step {
  key: string;
  parent: Step | null;
  children: Set<Step>;
  /** The OCCT objects this step made. */
  arena: Arena;
  state: TimelineState<OccSolid>;
  /** Build that used it last. */
  used: number;
}

/**
 * Steps kept across builds: a few branches of a long timeline (each step holds its solids
 * and their tessellation in the WASM heap, which never gives memory back).
 */
const MAX_STEPS = 64;
/**
 * Past this heap size only the steps of the latest build are kept (a fresh kernel takes
 * 100 MB; renewOcc takes over at RENEW_BYTES).
 */
const HEAP_SOFT = 192 * 2 ** 20;

/** The operations' arena: hands everything to the arena of the step being built. */
class StepArena extends Arena {
  target: Arena | null = null;
  /** Anything made outside a step (there should be nothing) is freed after the build. */
  readonly stray = new Arena();
  add<T extends { delete(): void }>(x: T): T {
    return (this.target ?? this.stray).add(x);
  }
  release(x: { delete(): void }) {
    (this.target ?? this.stray).release(x);
  }
  free() {
    this.stray.free();
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A failed component: no bodies, its error. */
export const failedComponent = (id: string, e: unknown): OccComponentBuild => ({ bodies: [], errors: { [id]: msg(e) }, warnings: {}, frames: {}, datums: {}, tools: new Map() });

/** Place the occurrences of a built design, joint origins on geometry found on its bodies. */
export function placeBuilt(oc: OC, design: CadDesign, numbers: DesignNumbers, components: Map<string, OccComponentBuild>) {
  return placeOccurrences(design, numbers, {
    frames: Object.assign({}, ...[...components.values()].map((cb) => cb.frames)),
    bodies: (cid) => (components.get(cid)?.bodies ?? []).filter((b) => hasSolid(oc, b.solid.shape)).map((b) => topologyOcc(oc, b.solid, b.id)),
    datums: (cid) => components.get(cid)?.datums ?? {},
  });
}

export class TimelineCache {
  private oc: OC | null = null;
  private ops: SolidOps<OccSolid> | null = null;
  private sink = new StepArena();
  private steps = new Map<string, Step>();
  private root: Step = TimelineCache.rootStep();
  private tick = 0;
  /** Features run (not found in the cache) so far: what the rebuilds cost. */
  ran = 0;

  constructor(private maxSteps = MAX_STEPS) {}

  private static rootStep(): Step {
    return { key: 'root', parent: null, children: new Set(), arena: new Arena(), state: emptyTimeline<OccSolid>(), used: 0 };
  }

  get size() {
    return this.steps.size;
  }

  /**
   * Build every component (resuming each timeline after its last unchanged step) and place
   * the occurrences. The result belongs to the cache: it stays valid until the next build.
   */
  build(oc: OC, design: CadDesign, numbers: DesignNumbers): OccBuiltDesign {
    // a renewed kernel: the old instance's objects went with it
    if (oc !== this.oc) {
      this.steps.clear();
      this.root = TimelineCache.rootStep();
      this.oc = oc;
      this.ops = occOps(oc, this.sink);
    }
    const tick = ++this.tick;
    const inp = buildInputs(design, numbers);
    const sketches = (id: string) => findSketch(design, id);
    const components = new Map<string, OccComponentBuild>();
    try {
      for (const c of design.components) {
        try {
          let at = this.root;
          for (const item of activeItems(c)) {
            const key = stepKey(at.key, item, numbers, sketches);
            let next = this.steps.get(key);
            if (!next) {
              const arena = new Arena();
              this.sink.target = arena;
              let state: TimelineState<OccSolid>;
              try {
                state = timelineStep(this.ops!, design, inp, at.state, item);
              } catch (e) {
                arena.free();
                throw e;
              } finally {
                this.sink.target = null;
              }
              next = { key, parent: at, children: new Set(), arena, state, used: tick };
              at.children.add(next);
              this.steps.set(key, next);
              if (item.kind !== 'sketch') this.ran++;
            }
            next.used = tick;
            at = next;
          }
          const st = at.state;
          components.set(c.id, { bodies: namedBodies(c, st), errors: st.errors, warnings: st.warnings, frames: st.frames, datums: st.datums, tools: st.tools, sketches: st.sketches, threads: st.threads });
        } catch (e) {
          components.set(c.id, failedComponent(c.id, e));
        }
      }
    } finally {
      this.sink.free();
      this.evict(tick, oc.wasmMemory.buffer.byteLength > HEAP_SOFT ? 0 : this.maxSteps);
    }
    const { placements, errors, warnings, kin } = placeBuilt(oc, design, numbers, components);
    return { oc, arena: this.root.arena, components, placements, errors, warnings, kin, free: () => {} };
  }

  /** Evict the ends of branches not used by build `tick` until at most `keep` steps are left. */
  private evict(tick: number, keep: number) {
    while (this.steps.size > keep) {
      let oldest: Step | null = null;
      for (const s of this.steps.values()) if (!s.children.size && s.used !== tick && (!oldest || s.used < oldest.used)) oldest = s;
      if (!oldest) return;
      this.drop(oldest);
    }
  }

  private drop(s: Step) {
    s.arena.free();
    this.steps.delete(s.key);
    s.parent?.children.delete(s);
  }

  /** Free everything (tests check that nothing is left behind). */
  clear() {
    for (const s of this.steps.values()) s.arena.free();
    this.steps.clear();
    this.root = TimelineCache.rootStep();
  }

  /**
   * Let go of a kernel instance that was replaced: its objects die with its heap, so
   * nothing is freed one by one, and nothing here may keep the old instance reachable.
   */
  forget() {
    this.steps.clear();
    this.root = TimelineCache.rootStep();
    this.sink = new StepArena();
    this.oc = null;
    this.ops = null;
  }
}

/** The cache the worksheet and the kernel requests share (one per worker). */
export const timelineCache = new TimelineCache();
onOccRenewed(() => timelineCache.forget());
