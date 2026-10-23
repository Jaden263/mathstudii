// Physically based shading of CAD bodies in the 3-D views. Metallic-roughness
// appearances (appearances.ts) are lit by a small studio: a key and a fill light fixed
// to the viewer, and an environment of sky above and floor below the world's horizon
// for reflections and ambient light. Specular is GGX / Cook–Torrance (Smith
// height-correlated visibility, Schlick's Fresnel), diffuse Lambert, the environment's
// specular the split-sum BRDF approximation for mobile (Karis 2014); colours are mixed in
// linear light, tone-mapped with ACES filmic (Narkowicz 2015) and written as sRGB.
//
// The same normals serve two analyses: zebra stripes (horizontal bands reflected in the
// surface, so G0/G1/G2 continuity across an edge shows as broken, kinked or smooth
// stripes) and per-vertex colours (draft and curvature maps, analysis.ts).
import type { Look } from '../../cad/appearances';

export type { Look };

/** What a 3-D view paints its bodies with: their appearances, or zebra stripes. */
export type Shading = { mode: 'pbr' } | { mode: 'zebra'; stripes: number };

export const PBR_VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
attribute vec3 aCol;
uniform mat4 uMvp;
uniform mat3 uRot;
varying vec3 vNrm;
varying vec3 vCol;
void main() {
  vNrm = uRot * aNrm;
  vCol = aCol;
  gl_Position = uMvp * vec4(aPos, 1.0);
}`;

const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec3 uBase;
uniform float uMetal;
uniform float uRough;
uniform float uAlpha;
uniform float uMode;
uniform vec3 uUp;
uniform float uStripes;
varying vec3 vNrm;
varying vec3 vCol;

const float PI = 3.14159265;
// view space: x right, y up, z towards the viewer
const vec3 KEY = vec3(-0.4152, 0.5709, 0.7083);
const vec3 FILL = vec3(0.6262, -0.1818, 0.7581);
const vec3 BOX = vec3(-0.3015, 0.8040, 0.5126);
const float EXPOSURE = 1.0;

float sat(float x) { return clamp(x, 0.0, 1.0); }

float ggx(float NoH, float a) {
  float a2 = a * a;
  float d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

float smithV(float NoV, float NoL, float a) {
  float a2 = a * a;
  float v = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float l = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(v + l, 1e-5);
}

vec3 schlick(float VoH, vec3 f0) {
  return f0 + (1.0 - f0) * pow(1.0 - VoH, 5.0);
}

// the studio along a direction, blurred by roughness: sky over a soft horizon and a grey
// floor (the world's), two upright strip lights either side of the viewer and a softbox
// above its left shoulder (the viewer's), which give round metal its streaks
vec3 studio(vec3 d, float r) {
  float h = dot(d, uUp);
  float w = 0.04 + 0.8 * r;
  vec3 sky = mix(vec3(0.62, 0.65, 0.70), vec3(1.0, 1.0, 1.02), sat(h * 1.2));
  vec3 floor = mix(vec3(0.34, 0.34, 0.35), vec3(0.2, 0.2, 0.21), sat(-h * 1.5));
  vec3 c = mix(floor, sky, smoothstep(-w, w, h));
  float sw = 0.1 + 0.9 * r;
  float strips = smoothstep(sw, 0.0, abs(abs(atan(d.x, d.z)) - 1.05)) * (1.0 - smoothstep(0.8, 0.97, abs(d.y)));
  float box = smoothstep(0.82 - 0.6 * r, 0.97, dot(d, BOX));
  return c + vec3(1.3) * strips * (1.0 - 0.65 * r) + vec3(1.6) * box * (1.0 - 0.7 * r);
}

vec3 irradiance(vec3 n) {
  return mix(vec3(0.16, 0.16, 0.17), vec3(0.56, 0.58, 0.62), 0.5 + 0.5 * dot(n, uUp));
}

vec2 envBRDF(float NoV, float r) {
  vec4 q = r * vec4(-1.0, -0.0275, -0.572, 0.022) + vec4(1.0, 0.0425, 1.04, -0.04);
  float a004 = min(q.x * q.x, exp2(-9.28 * NoV)) * q.x + q.y;
  return vec2(-1.04, 1.04) * a004 + q.zw;
}

vec3 light(vec3 n, vec3 v, vec3 l, float k, vec3 f0, vec3 diff, float a, float NoV) {
  float NoL = sat(dot(n, l));
  if (NoL <= 0.0) return vec3(0.0);
  vec3 h = normalize(l + v);
  vec3 F = schlick(sat(dot(v, h)), f0);
  vec3 spec = ggx(sat(dot(n, h)), a) * smithV(NoV, NoL, a) * F;
  return ((1.0 - F) * diff / PI + spec) * k * NoL;
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec3 n = normalize(vNrm);
  if (!gl_FrontFacing) n = -n;
  vec3 v = vec3(0.0, 0.0, 1.0);
  if (uMode > 1.5) {
    // analysis colours, lit just enough to read the shape
    gl_FragColor = vec4(vCol * (0.55 + 0.45 * sat(dot(n, KEY))), uAlpha);
    return;
  }
  if (uMode > 0.5) {
    // zebra: horizontal bands of light reflected in the surface
    vec3 r = reflect(-v, n);
    float t = uStripes * acos(clamp(r.y, -1.0, 1.0)) / PI;
    float tri = abs(fract(t) - 0.5) * 2.0;
#ifdef DERIVATIVES
    float w = clamp(fwidth(t) * 2.0, 0.002, 0.5);
#else
    float w = 0.04;
#endif
    gl_FragColor = vec4(vec3(0.06 + 0.9 * smoothstep(0.5 - w, 0.5 + w, tri)), 1.0);
    return;
  }
  float NoV = max(dot(n, v), 1e-4);
  float rough = clamp(uRough, 0.045, 1.0);
  float a = rough * rough;
  vec3 f0 = mix(vec3(0.04), uBase, uMetal);
  vec3 diff = uBase * (1.0 - uMetal);
  // the key light in full; the soft fill only diffuse (its highlight would hardly show)
  vec3 c = light(n, v, KEY, 3.4, f0, diff, a, NoV) + diff * (0.8 / PI) * sat(dot(n, FILL));
  vec2 ab = envBRDF(NoV, rough);
  vec3 spec = f0 * ab.x + ab.y;
  c += irradiance(n) * diff * (1.0 - spec) + studio(reflect(-v, n), rough) * spec;
  c = pow(aces(c * EXPOSURE), vec3(1.0 / 2.2));
  // see-through bodies grow opaque where they reflect more (towards grazing angles)
  float alpha = uAlpha < 1.0 ? sat(uAlpha + (1.0 - uAlpha) * (spec.x + spec.y + spec.z) / 3.0) : 1.0;
  gl_FragColor = vec4(c, alpha);
}`;

/** The fragment shader, with smooth zebra stripes where derivatives are available. */
export const pbrFragment = (derivatives: boolean) => (derivatives ? `#extension GL_OES_standard_derivatives : enable\n#define DERIVATIVES\n${FS}` : FS);

/** sRGB 0…1 to linear light. */
export const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export const SHADING_MODE = { pbr: 0, zebra: 1, tint: 2 } as const;

/** A colour without an appearance (profiles, highlights): a satin dielectric. */
export const plainLook = (color: [number, number, number], opacity = 1): Look => ({ color, metal: 0, rough: 0.5, opacity });

/** A look shown in another colour (a highlight): less metal, so the tint shows. */
export function tinted(l: Look, color: [number, number, number], k: number): Look {
  const mix = (a: number, b: number) => a + (b - a) * k;
  return { color: [mix(l.color[0], color[0]), mix(l.color[1], color[1]), mix(l.color[2], color[2])], metal: l.metal * (1 - k), rough: mix(l.rough, 0.5), opacity: l.opacity };
}
