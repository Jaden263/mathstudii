// STEP files (ISO 10303-21) read as text, for what the B-rep kernel's reader does not hand
// back in this build (its XCAF reader is not bound): the products with their names and
// colours, the length unit and the assembly with the placement of every instance. The
// geometry itself is read by OpenCascade, one part at a time (occ/stepImport.ts).
//
// An AP203/AP214/AP242 assembly is a tree of PRODUCT_DEFINITIONs joined by
// NEXT_ASSEMBLY_USAGE_OCCURRENCEs; each usage is placed by a CONTEXT_DEPENDENT_SHAPE_REPRESENTATION
// whose relationship carries an ITEM_DEFINED_TRANSFORMATION from a placement in the child's
// representation to one in the parent's. Leaf products are the parts; every path from the
// top to a leaf is an instance.
//
// Entities are indexed in one pass over the text and parsed only when asked for, so a
// file of a few megabytes (mostly points and curves nobody here reads) costs little.
import { m4Frame, m4Inv, m4Mul, norm3, cross3, IDENTITY, type M4, type Vec3 } from './solid';

export type P21 = number | string | null | P21Ref | P21Enum | P21Typed | P21[];
export interface P21Ref { ref: number }
export interface P21Enum { e: string }
export interface P21Typed { t: string; a: P21[] }

/** An entity: one type with its arguments, or a complex one (several types, `( A(…) B(…) )`). */
export interface P21Entity {
  id: number;
  types: string[];
  /** Arguments by type. */
  parts: Record<string, P21[]>;
}

const isRef = (v: P21 | undefined): v is P21Ref => !!v && typeof v === 'object' && 'ref' in v;
const isEnum = (v: P21 | undefined): v is P21Enum => !!v && typeof v === 'object' && 'e' in v;
const isTyped = (v: P21 | undefined): v is P21Typed => !!v && typeof v === 'object' && 't' in v;
const refOf = (v: P21 | undefined) => (isRef(v) ? v.ref : 0);
const refsOf = (v: P21 | undefined) => (Array.isArray(v) ? v.map(refOf).filter(Boolean) : []);
const str = (v: P21 | undefined) => (typeof v === 'string' ? v : '');

/** Decode the escapes of a STEP string: '' (done by the scanner), \X\hh, \X2\…\X0\, \X4\…\X0\, \S\c, \\. */
export function decodeString(s: string): string {
  if (!s.includes('\\')) return s;
  return s
    .replace(/\\X([24])\\([0-9A-Fa-f]*)\\X0\\/g, (_, w: string, hex: string) => {
      const n = w === '2' ? 4 : 8;
      let out = '';
      for (let i = 0; i + n <= hex.length; i += n) out += String.fromCodePoint(parseInt(hex.slice(i, i + n), 16));
      return out;
    })
    .replace(/\\X\\([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\S\\(.)/g, (_, c: string) => String.fromCharCode(c.charCodeAt(0) + 128))
    .replace(/\\\\/g, '\\');
}

/** The entities of a Part 21 file, indexed by id and type, parsed when first asked for. */
export class Part21 {
  private at = new Map<number, [number, number]>();
  private parsed = new Map<number, P21Entity | null>();
  private byType = new Map<string, number[]>();
  /** Ids in the order of the file. */
  readonly order: number[] = [];

  constructor(readonly text: string) {
    const s = text;
    let i = s.indexOf('DATA;');
    if (i < 0) throw new Error('this is not a STEP file (no DATA section)');
    i += 5;
    const n = s.length;
    // where the section ends (searched again only once the entities have gone past it: a
    // string may hold the word)
    let endsec = s.indexOf('ENDSEC;', i);
    while (i < n) {
      // the next entity: #id = …;
      const h = s.indexOf('#', i);
      if (h < 0) break;
      if (endsec >= 0 && endsec < i) endsec = s.indexOf('ENDSEC;', i);
      if (endsec >= 0 && endsec < h) break;
      let j = h + 1, id = 0;
      while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) id = id * 10 + s.charCodeAt(j++) - 48;
      while (j < n && s.charCodeAt(j) <= 32) j++;
      if (s[j] !== '=') {
        i = j;
        continue;
      }
      j++;
      const start = j;
      // to the ';' outside strings and comments
      while (j < n) {
        const c = s[j];
        if (c === "'") {
          j++;
          while (j < n && !(s[j] === "'" && s[j + 1] !== "'")) j += s[j] === "'" ? 2 : 1;
          j++;
        } else if (c === '/' && s[j + 1] === '*') {
          const e = s.indexOf('*/', j + 2);
          j = e < 0 ? n : e + 2;
        } else if (c === ';') break;
        else j++;
      }
      this.at.set(id, [start, j]);
      this.order.push(id);
      for (const t of this.typesAt(start, j)) {
        const l = this.byType.get(t);
        if (l) l.push(id);
        else this.byType.set(t, [id]);
      }
      i = j + 1;
    }
  }

  /** The type names of an entity without parsing its arguments. */
  private typesAt(a: number, b: number): string[] {
    const s = this.text;
    while (a < b && s.charCodeAt(a) <= 32) a++;
    if (s[a] !== '(') {
      const m = /^[A-Za-z_][\w]*/.exec(s.slice(a, Math.min(b, a + 80)));
      return m ? [m[0].toUpperCase()] : [];
    }
    // a complex entity: the names at depth 1
    const out: string[] = [];
    let depth = 0;
    for (let k = a; k < b; k++) {
      const c = s[k];
      if (c === "'") {
        k++;
        while (k < b && !(s[k] === "'" && s[k + 1] !== "'")) k += s[k] === "'" ? 2 : 1;
      } else if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (depth === 1 && /[A-Za-z_]/.test(c)) {
        let e = k;
        while (e < b && /\w/.test(s[e])) e++;
        out.push(s.slice(k, e).toUpperCase());
        k = e - 1;
        // skip its arguments
        let d = 0;
        for (k = e; k < b; k++) {
          if (s[k] === "'") {
            k++;
            while (k < b && !(s[k] === "'" && s[k + 1] !== "'")) k += s[k] === "'" ? 2 : 1;
          } else if (s[k] === '(') d++;
          else if (s[k] === ')' && --d === 0) break;
        }
      }
    }
    return out;
  }

  /** Ids of the entities of a type (complex ones under each of their types). */
  ofType(type: string): number[] {
    return this.byType.get(type) ?? [];
  }

  get(id: number): P21Entity | null {
    if (!id) return null;
    let e = this.parsed.get(id);
    if (e !== undefined) return e;
    const r = this.at.get(id);
    e = r ? parseEntity(id, this.text.slice(r[0], r[1])) : null;
    this.parsed.set(id, e);
    return e;
  }

  /** The arguments of an entity as a given type (null when it is not one). */
  args(id: number, type: string): P21[] | null {
    return this.get(id)?.parts[type] ?? null;
  }

  isA(id: number, ...types: string[]): boolean {
    const e = this.get(id);
    return !!e && types.some((t) => t in e.parts);
  }
}

/** One entity's text after the '=' (simple or complex). */
export function parseEntity(id: number, src: string): P21Entity | null {
  let i = 0;
  const n = src.length;
  const ws = () => {
    for (;;) {
      while (i < n && src.charCodeAt(i) <= 32) i++;
      if (src[i] === '/' && src[i + 1] === '*') {
        const e = src.indexOf('*/', i + 2);
        i = e < 0 ? n : e + 2;
      } else return;
    }
  };
  const name = () => {
    const s = i;
    while (i < n && /[\w-]/.test(src[i])) i++;
    return src.slice(s, i).toUpperCase();
  };
  const value = (): P21 => {
    ws();
    const c = src[i];
    if (c === "'") {
      let out = '';
      i++;
      for (;;) {
        const e = src.indexOf("'", i);
        if (e < 0) {
          out += src.slice(i);
          i = n;
          break;
        }
        out += src.slice(i, e);
        i = e + 1;
        if (src[i] === "'") {
          out += "'";
          i++;
        } else break;
      }
      return decodeString(out);
    }
    if (c === '#') {
      i++;
      const s = i;
      while (i < n && /\d/.test(src[i])) i++;
      return { ref: +src.slice(s, i) };
    }
    if (c === '.') {
      const e = src.indexOf('.', i + 1);
      const v = src.slice(i + 1, e);
      i = e + 1;
      return { e: v.toUpperCase() };
    }
    if (c === '$' || c === '*') {
      i++;
      return null;
    }
    if (c === '(') return list();
    if (c === '"') {
      // binary
      const e = src.indexOf('"', i + 1);
      const v = src.slice(i + 1, e);
      i = e + 1;
      return v;
    }
    if (/[A-Za-z_]/.test(c)) {
      const t = name();
      ws();
      return { t, a: src[i] === '(' ? list() : [] };
    }
    const m = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i, i + 40));
    if (!m) {
      i++;
      return null;
    }
    i += m[0].length;
    return +m[0];
  };
  const list = (): P21[] => {
    const out: P21[] = [];
    i++; // (
    ws();
    if (src[i] === ')') {
      i++;
      return out;
    }
    for (;;) {
      out.push(value());
      ws();
      if (src[i] === ',') {
        i++;
        continue;
      }
      if (src[i] === ')') i++;
      return out;
    }
  };
  ws();
  const parts: Record<string, P21[]> = {};
  const types: string[] = [];
  if (src[i] === '(') {
    i++;
    for (;;) {
      ws();
      if (i >= n || src[i] === ')') break;
      const t = name();
      if (!t) break;
      ws();
      parts[t] = src[i] === '(' ? list() : [];
      types.push(t);
    }
  } else {
    const t = name();
    if (!t) return null;
    ws();
    parts[t] = src[i] === '(' ? list() : [];
    types.push(t);
  }
  return { id, types, parts };
}

// ------------------------------------------------------------ the structure

export interface StepPart {
  /** What finds the part again in another version of the file: the product's id, else its name (`#2` … when several share it). */
  key: string;
  name: string;
  /** Its PRODUCT_DEFINITION (the entity the kernel transfers); 0: the whole file as one part. */
  pd: number;
  /** Names of its solids in the order of the file ('' when unnamed). */
  solids: string[];
  /** #rrggbb, from the style of its solid (else of most of its faces). */
  color?: string;
}

export interface StepInstance {
  part: number;
  /** Where it sits in the assembly: the names of the usages from the top, joined by '/'. */
  path: string;
  /** The usage's own name (or the part's with a count). */
  name: string;
  /** Placement in the top assembly, millimetres (column-major). */
  M: M4;
}

export interface StepStructure {
  /** Name of the top product. */
  name: string;
  parts: StepPart[];
  instances: StepInstance[];
  /** Millimetres per length unit of the file. */
  unit: number;
  warnings: string[];
}

const PREFIX: Record<string, number> = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 1e1, DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12 };
const PREDEFINED: Record<string, string> = { red: '#ff0000', green: '#00ff00', blue: '#0000ff', yellow: '#ffff00', magenta: '#ff00ff', cyan: '#00ffff', black: '#000000', white: '#ffffff' };
const SOLIDS = ['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'FACETED_BREP'];
const REPS = ['SHAPE_REPRESENTATION', 'ADVANCED_BREP_SHAPE_REPRESENTATION', 'FACETED_BREP_SHAPE_REPRESENTATION', 'MANIFOLD_SURFACE_SHAPE_REPRESENTATION', 'GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION', 'GEOMETRICALLY_BOUNDED_WIREFRAME_SHAPE_REPRESENTATION', 'REPRESENTATION'];

const hex2 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');

/** Read the products, unit, colours and assembly of a STEP file. */
export function stepStructure(text: string, fileName = 'Part'): StepStructure {
  const f = new Part21(text);
  const warnings: string[] = [];
  // representations by type (complex ones too) and their items
  const repArgs = (id: number) => {
    const e = f.get(id);
    if (!e) return null;
    for (const t of REPS) if (e.parts[t]) return e.parts[t];
    return null;
  };

  // the length unit of a representation context, in millimetres
  const unitCache = new Map<number, number>();
  const lengthUnit = (u: number, depth = 0): number | null => {
    const e = f.get(u);
    if (!e || depth > 4) return null;
    if (e.parts.SI_UNIT) {
      const [prefix, nm] = e.parts.SI_UNIT;
      if (isEnum(nm) && nm.e === 'METRE') return 1000 * (isEnum(prefix) ? PREFIX[prefix.e] ?? 1 : 1);
    }
    if (e.parts.CONVERSION_BASED_UNIT) {
      const m = refOf(e.parts.CONVERSION_BASED_UNIT[1]);
      const me = f.get(m);
      const mw = me?.parts.MEASURE_WITH_UNIT ?? me?.parts.LENGTH_MEASURE_WITH_UNIT;
      if (mw) {
        const v = isTyped(mw[0]) ? (mw[0].a[0] as number) : typeof mw[0] === 'number' ? mw[0] : NaN;
        const base = lengthUnit(refOf(mw[1]), depth + 1);
        if (base && Number.isFinite(v)) return v * base;
      }
    }
    return null;
  };
  const contextUnit = (ctx: number): number => {
    let u = unitCache.get(ctx);
    if (u !== undefined) return u;
    const units = refsOf(f.args(ctx, 'GLOBAL_UNIT_ASSIGNED_CONTEXT')?.[0]);
    u = 1;
    for (const id of units) {
      if (!f.isA(id, 'LENGTH_UNIT')) continue;
      const mm = lengthUnit(id);
      if (mm) u = mm;
    }
    unitCache.set(ctx, u);
    return u;
  };
  const repUnit = (rep: number) => contextUnit(refOf(repArgs(rep)?.[2]));

  // products and their definitions
  const productOf = (pd: number) => {
    const formation = refOf(f.args(pd, 'PRODUCT_DEFINITION')?.[2]);
    const fa = f.args(formation, 'PRODUCT_DEFINITION_FORMATION') ?? f.args(formation, 'PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE');
    const p = f.args(refOf(fa?.[2]), 'PRODUCT');
    return { id: str(p?.[0]).trim(), name: str(p?.[1]).trim() || str(p?.[0]).trim() };
  };
  const pds = [...f.ofType('PRODUCT_DEFINITION'), ...f.ofType('PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS')];

  // the shape of each definition: PRODUCT_DEFINITION_SHAPE → SHAPE_DEFINITION_REPRESENTATION → representation
  const shapeOf = new Map<number, number>(); // PDS → its definition (a PD or a usage)
  for (const id of f.ofType('PRODUCT_DEFINITION_SHAPE')) shapeOf.set(id, refOf(f.args(id, 'PRODUCT_DEFINITION_SHAPE')?.[2]));
  const repsOf = new Map<number, number[]>(); // PD → representations
  for (const id of f.ofType('SHAPE_DEFINITION_REPRESENTATION')) {
    const a = f.args(id, 'SHAPE_DEFINITION_REPRESENTATION');
    const def = shapeOf.get(refOf(a?.[0])), rep = refOf(a?.[1]);
    if (def && rep) repsOf.set(def, [...(repsOf.get(def) ?? []), rep]);
  }
  // representations joined without a transformation (a part's shape representation to its B-rep)
  const linked = new Map<number, number[]>();
  for (const id of f.ofType('REPRESENTATION_RELATIONSHIP')) {
    const e = f.get(id);
    if (!e || e.parts.REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION) continue;
    const a = e.parts.REPRESENTATION_RELATIONSHIP;
    const r1 = refOf(a[2]), r2 = refOf(a[3]);
    if (!r1 || !r2) continue;
    linked.set(r1, [...(linked.get(r1) ?? []), r2]);
    linked.set(r2, [...(linked.get(r2) ?? []), r1]);
  }
  for (const id of f.ofType('SHAPE_REPRESENTATION_RELATIONSHIP')) {
    const e = f.get(id);
    if (!e || e.types.length > 1) continue;
    const a = e.parts.SHAPE_REPRESENTATION_RELATIONSHIP;
    const r1 = refOf(a[2]), r2 = refOf(a[3]);
    if (!r1 || !r2) continue;
    linked.set(r1, [...(linked.get(r1) ?? []), r2]);
    linked.set(r2, [...(linked.get(r2) ?? []), r1]);
  }
  /** Every representation of a definition, through the plain relationships. */
  const allReps = (pd: number) => {
    const seen = new Set<number>();
    const stack = [...(repsOf.get(pd) ?? [])];
    while (stack.length) {
      const r = stack.pop()!;
      if (seen.has(r)) continue;
      seen.add(r);
      stack.push(...(linked.get(r) ?? []));
    }
    return [...seen];
  };
  /** The solids of a definition's representations (mapped items followed into their representations). */
  const solidsOf = (pd: number) => {
    const out: number[] = [];
    const seenRep = new Set<number>();
    const walkRep = (rep: number) => {
      if (seenRep.has(rep)) return;
      seenRep.add(rep);
      for (const it of refsOf(repArgs(rep)?.[1])) {
        if (SOLIDS.some((t) => f.isA(it, t))) out.push(it);
        else if (f.isA(it, 'MAPPED_ITEM')) {
          const map = refOf(f.args(it, 'MAPPED_ITEM')?.[1]);
          const mapped = refOf(f.args(map, 'REPRESENTATION_MAP')?.[1]);
          if (mapped) walkRep(mapped);
        }
      }
    };
    for (const r of allReps(pd)) walkRep(r);
    return out;
  };

  // the assembly: usages from parent to child, placed by their context dependent representations
  interface Usage { id: number; name: string; parent: number; child: number; M: M4 | null }
  const usages: Usage[] = [];
  for (const id of f.ofType('NEXT_ASSEMBLY_USAGE_OCCURRENCE')) {
    const a = f.args(id, 'NEXT_ASSEMBLY_USAGE_OCCURRENCE')!;
    usages.push({ id, name: (str(a[1]) || str(a[0])).trim(), parent: refOf(a[3]), child: refOf(a[4]), M: null });
  }
  const usageById = new Map(usages.map((u) => [u.id, u]));
  const frameOf = (a2p: number, mm: number): M4 | null => {
    const a = f.args(a2p, 'AXIS2_PLACEMENT_3D');
    if (!a) return null;
    const pt = f.args(refOf(a[1]), 'CARTESIAN_POINT')?.[1];
    const xyz = (d: number): Vec3 | null => {
      const v = f.args(d, 'DIRECTION')?.[1];
      return Array.isArray(v) && v.length >= 3 ? norm3(v.slice(0, 3) as Vec3) : null;
    };
    const o = (Array.isArray(pt) ? pt.slice(0, 3).map((x) => (x as number) * mm) : [0, 0, 0]) as Vec3;
    const z = xyz(refOf(a[2])) ?? [0, 0, 1];
    let x = xyz(refOf(a[3])) ?? (Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1]);
    // the x axis made square to z, as AP214 says (the projection of ref_direction)
    const d = x[0] * z[0] + x[1] * z[1] + x[2] * z[2];
    x = norm3([x[0] - d * z[0], x[1] - d * z[1], x[2] - d * z[2]]);
    return m4Frame(o, x, cross3(z, x), z);
  };
  for (const id of f.ofType('CONTEXT_DEPENDENT_SHAPE_REPRESENTATION')) {
    const a = f.args(id, 'CONTEXT_DEPENDENT_SHAPE_REPRESENTATION')!;
    const rel = f.get(refOf(a[0]));
    const usage = usageById.get(shapeOf.get(refOf(a[1])) ?? 0);
    if (!rel || !usage) continue;
    const rr = rel.parts.REPRESENTATION_RELATIONSHIP ?? rel.parts.SHAPE_REPRESENTATION_RELATIONSHIP;
    const tr = rel.parts.REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION;
    if (!rr || !tr) continue;
    const rep1 = refOf(rr[2]), rep2 = refOf(rr[3]);
    const idt = f.args(refOf(tr[0]), 'ITEM_DEFINED_TRANSFORMATION');
    if (!idt) {
      warnings.push(`a placement in the assembly is not an item-defined transformation: ${usage.name || 'an instance'} is placed at the origin`);
      continue;
    }
    // the transformation takes item 1 (in rep 1) onto item 2 (in rep 2); rep 1 is the child's,
    // as the standard has it, but some writers swap them
    const childReps = new Set(allReps(usage.child));
    const swapped = !childReps.has(rep1) && childReps.has(rep2);
    const [inChild, inParent, childRep, parentRep] = swapped ? [refOf(idt[3]), refOf(idt[2]), rep2, rep1] : [refOf(idt[2]), refOf(idt[3]), rep1, rep2];
    const Fc = frameOf(inChild, repUnit(childRep)), Fp = frameOf(inParent, repUnit(parentRep));
    if (Fc && Fp) usage.M = m4Mul(Fp, m4Inv(Fc));
  }

  // parts: the definitions nothing is assembled into
  const parents = new Set(usages.map((u) => u.parent));
  const children = new Set(usages.map((u) => u.child));
  const leaves = pds.filter((pd) => !parents.has(pd));
  const parts: StepPart[] = [];
  const partOf = new Map<number, number>();
  const keys = new Map<string, number>();
  for (const pd of leaves) {
    const solids = solidsOf(pd);
    // a definition without a shape (a document, an empty product) is no part
    if (!solids.length && !allReps(pd).some((r) => refsOf(repArgs(r)?.[1]).some((it) => !f.isA(it, 'AXIS2_PLACEMENT_3D')))) continue;
    const p = productOf(pd);
    const base = p.id || p.name || `Part${parts.length + 1}`;
    const k = (keys.get(base) ?? 0) + 1;
    keys.set(base, k);
    partOf.set(pd, parts.length);
    parts.push({ key: k > 1 ? `${base}#${k}` : base, name: p.name || base, pd, solids: solids.map((s) => str(f.get(s)?.parts[f.get(s)!.types[0]][0]).trim()) });
  }

  // colours: styled items on a part's solids, or on its faces (the most used colour)
  const colourOf = (style: number): string | undefined => {
    const seen = new Set<number>();
    const queue = [style];
    for (let n = 0; queue.length && n < 64; n++) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const e = f.get(id);
      if (!e) continue;
      if (e.parts.COLOUR_RGB) {
        const [, r, g, b] = e.parts.COLOUR_RGB as number[];
        return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
      }
      if (e.parts.DRAUGHTING_PRE_DEFINED_COLOUR) return PREDEFINED[str(e.parts.DRAUGHTING_PRE_DEFINED_COLOUR[0]).toLowerCase()];
      const walk = (v: P21) => {
        if (isRef(v)) queue.push(v.ref);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (isTyped(v)) v.a.forEach(walk);
      };
      for (const args of Object.values(e.parts)) args.forEach(walk);
    }
    return undefined;
  };
  const solidPart = new Map<number, number>();
  parts.forEach((p, i) => solidsOf(p.pd).forEach((s) => solidPart.set(s, i)));
  let facePart: Map<number, number> | null = null;
  const faceToPart = () => {
    if (facePart) return facePart;
    facePart = new Map();
    for (const [s, i] of solidPart) {
      const e = f.get(s)!;
      const shells = e.parts.BREP_WITH_VOIDS ? [refOf(e.parts.BREP_WITH_VOIDS[1]), ...refsOf(e.parts.BREP_WITH_VOIDS[2])] : [refOf(e.parts[e.types[0]][1])];
      for (const sh of shells) {
        const se = f.get(sh);
        for (const fc of refsOf(se?.parts[se.types[0]]?.[1])) facePart.set(fc, i);
      }
    }
    return facePart;
  };
  const solidColour = new Map<number, string>();
  const faceColours = new Map<number, Map<string, number>>();
  for (const id of [...f.ofType('STYLED_ITEM'), ...f.ofType('OVER_RIDING_STYLED_ITEM')]) {
    const e = f.get(id);
    const a = e?.parts.STYLED_ITEM ?? e?.parts.OVER_RIDING_STYLED_ITEM;
    if (!a) continue;
    const item = refOf(a[2]);
    const at = solidPart.get(item);
    if (at === undefined && !f.isA(item, 'ADVANCED_FACE', 'FACE_SURFACE')) continue;
    const c = refsOf(a[1]).map(colourOf).find(Boolean);
    if (!c) continue;
    if (at !== undefined) {
      if (!solidColour.has(at)) solidColour.set(at, c);
      continue;
    }
    const pi = faceToPart().get(item);
    if (pi === undefined) continue;
    const m = faceColours.get(pi) ?? new Map<string, number>();
    m.set(c, (m.get(c) ?? 0) + 1);
    faceColours.set(pi, m);
  }
  parts.forEach((p, i) => {
    const c = solidColour.get(i) ?? [...(faceColours.get(i) ?? new Map<string, number>())].sort((x, y) => y[1] - x[1])[0]?.[0];
    if (c) p.color = c;
  });

  // instances: every path from a top definition down to a part
  const instances: StepInstance[] = [];
  const counts = new Map<number, number>();
  const down = new Map<number, Usage[]>();
  for (const u of usages) down.set(u.parent, [...(down.get(u.parent) ?? []), u]);
  const visit = (pd: number, M: M4, path: string[], depth: number) => {
    if (depth > 32) return;
    const pi = partOf.get(pd);
    if (pi !== undefined) {
      const k = (counts.get(pi) ?? 0) + 1;
      counts.set(pi, k);
      const own = path[path.length - 1];
      instances.push({ part: pi, path: path.join('/') || parts[pi].key, name: own || `${parts[pi].name}:${k}`, M });
      return;
    }
    const kids = down.get(pd) ?? [];
    kids.forEach((u, i) => {
      if (!u.M) warnings.push(`${u.name || 'an instance'} has no placement in the file: it is placed at its parent's origin`);
      visit(u.child, m4Mul(M, u.M ?? IDENTITY), [...path, u.name || `${i + 1}`], depth + 1);
    });
  };
  const tops = pds.filter((pd) => !children.has(pd));
  for (const pd of tops) visit(pd, IDENTITY, [], 0);
  const top = tops.length === 1 ? productOf(tops[0]).name : '';

  // a file of shapes without products (or none the kernel could find): the whole file as one part
  if (!parts.length) {
    parts.push({ key: '', name: fileName, pd: 0, solids: [] });
    instances.push({ part: 0, path: '', name: fileName, M: IDENTITY });
  }
  const anyRep = f.ofType('GLOBAL_UNIT_ASSIGNED_CONTEXT')[0];
  return { name: top || fileName, parts, instances, unit: anyRep ? contextUnit(anyRep) : 1, warnings: [...new Set(warnings)] };
}
