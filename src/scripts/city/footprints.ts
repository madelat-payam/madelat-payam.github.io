// Real extruded building footprints for the hero, one merged mesh per city.
//
// The older hero drew a PCA best-fit rectangle per building and inflated it, so
// precise streets and water could never sit under the massing. This module reads
// the real OSM footprint rings written by tools/build_cities.py (c{i}.footprints.bin),
// extrudes each ring to its own height, and merges every building of a city into a
// single BufferGeometry so the whole skyline is one draw call. Because the rings are
// the same city-centered metres as the ground layers, multiplying by the city's world
// scale (the one cityData exposes) lands the buildings exactly on the roads and water.
//
// The city-to-city change is a center-out sink and rise: the leaving city drops into
// the ground and the arriving one grows up, the middle moving before the edges, with
// the moving top edge softly dithered so it reads as a soft front rather than a hard
// cut. That motion is a vertex-shader height scale plus a thin top-band dissolve,
// injected into a MeshLambertMaterial through onBeforeCompile, so it costs one uniform
// per city per frame and no geometry rebuild. A matching depth material carries the
// same height scale into the shadow map, so a sinking tower's shadow sinks with it.
//
// hero.ts adds the returned object once, calls setColor when the metric, palette, or
// theme changes, and drives setMorph every frame. The buildings stay on the default
// render layer so they feed the GTAO pass; the flat ground layers ride layer 1 and are
// excluded from it (see groundLayers.ts).

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshDepthMaterial,
  MeshLambertMaterial,
  RGBADepthPacking,
  ShapeUtils,
  Vector2,
  type WebGLProgramParametersWithUniforms,
} from 'three';

import { VERTICAL_EXAGGERATION, WORLD_RADIUS } from './cityData';
import { sampleRamp, windowT, type RampName, type ThemeName } from './colormaps';
import { METRICS, type MetricKey } from './metrics';

// Spread of the center-out reveal wave. At 0 the whole city moves in lockstep, a clean
// uniform sink and rise with no radial ring; above 0 the center leads the rim by this
// share of the transition. Set to 0 after the circular reveal read as mechanical on the
// real footprints; legibility now comes from the sequential handoff in setMorph instead.
const U_SPREAD = 0.0;

// Share of each city-to-city gap that a city stands fully formed, at the start and again
// at the end; the rest of the gap eases through the sink and rise. Enough hold that the
// damped scroll index lands on a finished city rather than catching one half grown, but
// not so much that the change snaps past. The lower this is the more of the gap the
// motion spreads over, so the slower and smoother it reads.
const MORPH_HOLD = 0.15;

// Half-width of the crossover where the leaving city is finishing its sink and the
// arriving one is starting to rise. A small overlap keeps a low crossover, both cities
// briefly short, rather than a fully empty street-plan beat, so the change eases through
// the middle instead of blinking to bare ground. Larger blends the two more; too large
// brings back the half-height cross-fade that read as indistinct.
const MORPH_CROSS = 0.1;

// A building counts as settled (crisp, fully opaque) once its height is within this
// of full. Below it the soft top switches on, so the dither only ever touches a
// building that is actively sinking or rising, never a resting skyline.
const REVEAL_CRISP = 0.985;

// The soft top: the fraction of a moving building's height that dithers, and the
// spatial frequency of the dither in world units. FADE_BAND near 0.14 fades only the
// top eighth or so; GRAIN sets how fine the speckle is. Both are tuned against a
// render, so they live here rather than buried in the shader string.
const FADE_BAND = 0.14;
const GRAIN = 42.0;

// A small deterministic wobble on each building's phase, so the moving front is an
// organic band instead of a perfect ring. The box hero learned the same lesson: a
// clean radius front read as mechanical.
const PHASE_JITTER = 0.06;

// The parsed contents of one c{i}.footprints.bin. Field-of-arrays, every array of
// length buildingCount except the concatenated ring coordinates.
interface FootprintData {
  buildingCount: number;
  vertexTotal: number;
  ringLength: Uint32Array;
  xz: Float32Array; // 2 * vertexTotal, city-centered metres, rings open and CCW
  height: Float32Array; // metres
  area: Float32Array; // m^2
  floors: Float32Array;
  cls: Uint8Array;
}

// One city's drawable buildings plus what setColor needs to recolor them without
// touching geometry: where each building's vertices live, and its rank in [0,1] for
// every metric.
interface FootprintCity {
  readonly mesh: Mesh;
  // Set this city visible at a transition position. progress runs 0..1 across the
  // gap; out is 1 for the leaving city (sinks) and 0 for the arriving one (rises).
  reveal(progress: number, out: number): void;
  hide(): void;
}

interface CityInternal extends FootprintCity {
  readonly geometry: BufferGeometry;
  readonly uniforms: SinkUniforms;
  readonly vertexOffset: Uint32Array; // buildingCount + 1, first vertex of each building
  readonly ranks: Record<MetricKey, Float32Array>; // per building, in [0,1]
}

export interface FootprintCities {
  // Add to the scene once; nothing else about the buildings is the caller's to own.
  readonly object: Group;
  // Per-city handles, for a caller that wants to drive one city on its own (the
  // preview harness does; the live hero uses setMorph below).
  readonly cities: ReadonlyArray<FootprintCity>;
  // Recolor every city. Cheap enough to do on demand because metric, palette, and
  // theme changes are rare; there is no per-frame color work.
  setColor(metric: MetricKey, ramp: RampName, theme: ThemeName): void;
  // Drive the sink and rise from the damped morph index hero already tracks
  // (0 .. cities-1). Only the leaving and arriving cities draw.
  setMorph(current: number): void;
}

interface SinkUniforms {
  uProgress: { value: number };
  uSpread: { value: number };
  uOut: { value: number };
}

interface BuildOptions {
  // Mobile keeps only the largest-footprint buildings, to cap the triangle count.
  // Omitted on desktop, where every real building is drawn.
  maxBuildings?: number;
}

export async function buildFootprintCities(
  baseUrl: string,
  scales: number[],
  options: BuildOptions = {},
): Promise<FootprintCities> {
  const root = `${baseUrl}data/cities/`;
  const manifest: Manifest = await fetch(`${root}manifest.json`).then((r) => r.json());

  const datas = await Promise.all(
    manifest.cities.map(async (c, i) => {
      const buffer = await fetch(`${root}${c.footprints.file}`).then((r) => r.arrayBuffer());
      return { data: readFootprints(buffer), scale: scales[i] };
    }),
  );

  const object = new Group();
  const cities: CityInternal[] = datas.map(({ data, scale }) => {
    const kept = selectBuildings(data, options.maxBuildings);
    const built = buildCityGeometry(data, kept, scale);
    const uniforms = makeSinkUniforms();
    const material = makeSinkMaterial(uniforms);
    const mesh = new Mesh(built.geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // The sink is a vertex-shader height scale; the default depth material would keep
    // casting the full-height shadow. This one carries the same scale, so the shadow
    // tracks the building down and back up.
    mesh.customDepthMaterial = makeSinkDepthMaterial(uniforms);
    mesh.visible = false;
    object.add(mesh);

    return {
      mesh,
      geometry: built.geometry,
      uniforms,
      vertexOffset: built.vertexOffset,
      ranks: computeRanks(data, kept),
      reveal(progress: number, out: number): void {
        uniforms.uProgress.value = progress;
        uniforms.uOut.value = out;
        mesh.visible = true;
      },
      hide(): void {
        mesh.visible = false;
      },
    };
  });

  const scratch = new Color();

  function setColor(metric: MetricKey, ramp: RampName, theme: ThemeName): void {
    for (const city of cities) {
      const rank = city.ranks[metric];
      const colors = city.geometry.getAttribute('color') as BufferAttribute;
      const array = colors.array as Float32Array;
      const offset = city.vertexOffset;
      for (let b = 0; b < rank.length; b++) {
        sampleRamp(ramp, windowT(rank[b], theme, ramp), scratch);
        for (let v = offset[b]; v < offset[b + 1]; v++) {
          array[v * 3] = scratch.r;
          array[v * 3 + 1] = scratch.g;
          array[v * 3 + 2] = scratch.b;
        }
      }
      colors.needsUpdate = true;
    }
  }

  function setMorph(current: number): void {
    const seg = Math.max(0, Math.min(cities.length - 2, Math.floor(current)));
    const f = current - seg;
    // Each city holds fully formed for the outer MORPH_HOLD of the gap on either side, so
    // a scroll reads a complete city before it changes; the sink and rise happen only in
    // the middle. The leaving city sinks to its street plan over the first half of that
    // window, then the arriving city rises over the second half. Because the full state is
    // a plateau rather than a single instant, the damped scroll index always lands on a
    // finished city instead of catching one half grown.
    const progLeave = smooth01(MORPH_HOLD, 0.5 + MORPH_CROSS, f);
    const progArrive = smooth01(0.5 - MORPH_CROSS, 1 - MORPH_HOLD, f);
    for (let c = 0; c < cities.length; c++) {
      if (c === seg && progLeave < 1) cities[c].reveal(progLeave, 1);
      else if (c === seg + 1 && progArrive > 0) cities[c].reveal(progArrive, 0);
      else cities[c].hide();
    }
  }

  return { object, cities, setColor, setMorph };
}

// Reference reader for c{i}.footprints.bin, ported from _read_footprints in
// tools/build_cities.py. Little-endian struct of arrays; every byte is consumed.
function readFootprints(buffer: ArrayBuffer): FootprintData {
  const view = new DataView(buffer);
  let off = 0;
  const buildingCount = view.getUint32(off, true); off += 4;
  const vertexTotal = view.getUint32(off, true); off += 4;

  const ringLength = new Uint32Array(buffer, off, buildingCount); off += buildingCount * 4;
  const xz = new Float32Array(buffer, off, vertexTotal * 2); off += vertexTotal * 8;
  const height = new Float32Array(buffer, off, buildingCount); off += buildingCount * 4;
  const area = new Float32Array(buffer, off, buildingCount); off += buildingCount * 4;
  const floors = new Float32Array(buffer, off, buildingCount); off += buildingCount * 4;
  const cls = new Uint8Array(buffer, off, buildingCount); off += buildingCount;

  if (off !== buffer.byteLength) {
    throw new Error(`footprints.bin: read ${off} of ${buffer.byteLength} bytes; format mismatch`);
  }
  return { buildingCount, vertexTotal, ringLength, xz, height, area, floors, cls };
}

// Which buildings to draw, and where each begins in the concatenated ring array.
// Desktop keeps all of them in file order; a maxBuildings cap keeps the largest
// footprints, which are the ones that carry the skyline, and drops the small stock.
interface Selection {
  index: number[]; // building indices to draw
  ringStart: Uint32Array; // first ring vertex of building i in the full xz array
}

function selectBuildings(data: FootprintData, maxBuildings?: number): Selection {
  const ringStart = new Uint32Array(data.buildingCount + 1);
  for (let b = 0; b < data.buildingCount; b++) ringStart[b + 1] = ringStart[b] + data.ringLength[b];

  let index: number[];
  if (maxBuildings && maxBuildings < data.buildingCount) {
    index = Array.from({ length: data.buildingCount }, (_, b) => b)
      .sort((a, b) => data.area[b] - data.area[a])
      .slice(0, maxBuildings);
  } else {
    index = Array.from({ length: data.buildingCount }, (_, b) => b);
  }
  return { index, ringStart };
}

interface BuiltGeometry {
  geometry: BufferGeometry;
  vertexOffset: Uint32Array; // one entry per kept building, plus a final total
}

// Extrude every kept ring into walls and a roof, packed straight into typed arrays
// and merged into one geometry. Working in typed arrays rather than a BufferGeometry
// per building keeps the largest city (New York, ~33k buildings) from thrashing the
// allocator. A ring of n points yields n wall quads (4 vertices each, so the flat
// normals stay crisp) and one triangulated roof cap of n vertices, so 5n vertices and
// up to 9n-6 indices per building.
function buildCityGeometry(data: FootprintData, sel: Selection, scale: number): BuiltGeometry {
  const kept = sel.index;
  let vertexTotal = 0;
  for (const b of kept) vertexTotal += data.ringLength[b];

  const vertexCount = vertexTotal * 5;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3); // filled by setColor
  const aPhase = new Float32Array(vertexCount);
  const aH01 = new Float32Array(vertexCount);
  const indices = new Uint32Array(vertexTotal * 9); // sliced to the real count below
  const vertexOffset = new Uint32Array(kept.length + 1);

  const heightScale = scale * VERTICAL_EXAGGERATION;
  let vptr = 0;
  let iptr = 0;

  kept.forEach((b, slot) => {
    vertexOffset[slot] = vptr;
    const n = data.ringLength[b];
    const start = sel.ringStart[b];
    const h = data.height[b] * heightScale;

    // World ring coordinates, and the centroid that sets this building's place in the
    // center-out wave.
    const rx = new Float32Array(n);
    const rz = new Float32Array(n);
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < n; i++) {
      const x = data.xz[(start + i) * 2] * scale;
      const z = data.xz[(start + i) * 2 + 1] * scale;
      rx[i] = x;
      rz[i] = z;
      cx += x;
      cz += z;
    }
    cx /= n;
    cz /= n;
    const phase = clamp01(Math.hypot(cx, cz) / WORLD_RADIUS + (hash01(b) - 0.5) * PHASE_JITTER);

    // Walls: one quad per edge, four own vertices so each face keeps its own outward
    // normal and the corners stay sharp. The ring is CCW, so (dz, -dx) points out.
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = rx[i];
      const z0 = rz[i];
      const x1 = rx[j];
      const z1 = rz[j];
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz) || 1;
      const nx = dz / len;
      const nz = -dx / len;

      const v = vptr;
      pushVertex(positions, normals, aPhase, aH01, v, x0, 0, z0, nx, 0, nz, phase, 0);
      pushVertex(positions, normals, aPhase, aH01, v + 1, x1, 0, z1, nx, 0, nz, phase, 0);
      pushVertex(positions, normals, aPhase, aH01, v + 2, x1, h, z1, nx, 0, nz, phase, 1);
      pushVertex(positions, normals, aPhase, aH01, v + 3, x0, h, z0, nx, 0, nz, phase, 1);
      vptr += 4;
      // Wound so the outward face is the front face; verified against a render.
      indices[iptr] = v; indices[iptr + 1] = v + 2; indices[iptr + 2] = v + 1;
      indices[iptr + 3] = v; indices[iptr + 4] = v + 3; indices[iptr + 5] = v + 2;
      iptr += 6;
    }

    // Roof: the top ring, triangulated flat. triangulateShape keeps the contour's CCW
    // order, which points a roof face down in world space (y up), so the triangles are
    // emitted reversed to face up.
    const roofBase = vptr;
    const contour = new Array<Vector2>(n);
    for (let i = 0; i < n; i++) {
      contour[i] = new Vector2(rx[i], rz[i]);
      pushVertex(positions, normals, aPhase, aH01, vptr, rx[i], h, rz[i], 0, 1, 0, phase, 1);
      vptr += 1;
    }
    for (const tri of ShapeUtils.triangulateShape(contour, [])) {
      indices[iptr] = roofBase + tri[2];
      indices[iptr + 1] = roofBase + tri[1];
      indices[iptr + 2] = roofBase + tri[0];
      iptr += 3;
    }
  });
  vertexOffset[kept.length] = vptr;

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setAttribute('aPhase', new BufferAttribute(aPhase, 1));
  geometry.setAttribute('aH01', new BufferAttribute(aH01, 1));
  geometry.setIndex(new BufferAttribute(indices.subarray(0, iptr), 1));
  return { geometry, vertexOffset };
}

function pushVertex(
  positions: Float32Array,
  normals: Float32Array,
  aPhase: Float32Array,
  aH01: Float32Array,
  v: number,
  px: number, py: number, pz: number,
  nx: number, ny: number, nz: number,
  phase: number, h01: number,
): void {
  positions[v * 3] = px;
  positions[v * 3 + 1] = py;
  positions[v * 3 + 2] = pz;
  normals[v * 3] = nx;
  normals[v * 3 + 1] = ny;
  normals[v * 3 + 2] = nz;
  aPhase[v] = phase;
  aH01[v] = h01;
}

// Each building's rank in [0,1] within its own city, per metric, computed from the
// footprint file's own fields. cityData ranks the 2400 resampled boxes; the footprints
// keep every building, so the ranks have to be recomputed here to line up one to one
// with the drawn vertices. The rank-within-city choice matches cityData, so a metric
// switch reads the same as the boxed hero did.
function computeRanks(data: FootprintData, sel: Selection): Record<MetricKey, Float32Array> {
  const kept = sel.index;
  const ranks = {} as Record<MetricKey, Float32Array>;
  for (const def of METRICS) {
    const values = new Float64Array(kept.length);
    for (let s = 0; s < kept.length; s++) {
      const b = kept[s];
      values[s] = def.value(data.area[b], data.floors[b], data.height[b], data.cls[b]);
    }
    ranks[def.key] = rankWithinCity(values);
  }
  return ranks;
}

// Fractional rank in [0,1], ties by array order (immaterial for coloring). Mirrors the
// private helper in cityData so the two paths rank the same way.
function rankWithinCity(values: Float64Array): Float32Array {
  const n = values.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b]);
  const t = new Float32Array(n);
  for (let r = 0; r < n; r++) t[order[r]] = n > 1 ? r / (n - 1) : 0;
  return t;
}

function makeSinkUniforms(): SinkUniforms {
  return { uProgress: { value: 0 }, uSpread: { value: U_SPREAD }, uOut: { value: 1 } };
}

// The beauty material: a lit Lambert surface colored by the baked vertex ramp, with the
// sink and rise and the soft top spliced into its shader. onBeforeCompile edits the
// stock chunks rather than replacing the whole program, so the material keeps three's
// lighting, fog, and shadow code untouched.
function makeSinkMaterial(uniforms: SinkUniforms): MeshLambertMaterial {
  const material = new MeshLambertMaterial({ vertexColors: true });
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uProgress = uniforms.uProgress;
    shader.uniforms.uSpread = uniforms.uSpread;
    shader.uniforms.uOut = uniforms.uOut;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SINK_VERTEX_HEAD}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${SINK_VERTEX_BODY}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SOFT_TOP_FRAGMENT_HEAD}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${SOFT_TOP_FRAGMENT_BODY}`);
  };
  // All city materials share one program; only their uniforms differ.
  material.customProgramCacheKey = () => 'footprint-sink';
  return material;
}

// The depth twin: only the height scale, so the shadow map matches the sunk geometry.
// It skips the soft-top dissolve, whose band is too thin to matter in a shadow.
function makeSinkDepthMaterial(uniforms: SinkUniforms): MeshDepthMaterial {
  const material = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uProgress = uniforms.uProgress;
    shader.uniforms.uSpread = uniforms.uSpread;
    shader.uniforms.uOut = uniforms.uOut;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SINK_VERTEX_HEAD}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${SINK_HEIGHT_ONLY}`);
  };
  material.customProgramCacheKey = () => 'footprint-sink-depth';
  return material;
}

const SINK_VERTEX_HEAD = `
uniform float uProgress;
uniform float uSpread;
uniform float uOut;
attribute float aPhase;
attribute float aH01;
varying float vH01;
varying float vActive;
varying vec3 vGrain;
`;

// The center-out reveal: a building's local progress lp opens as the wave passes its
// phase; the leaving city uses 1 - lp so it closes instead. transformed.y is the height
// above the ground base, so scaling it grows the building from the plate or sinks it
// into it. vActive is 0 while settled, so the soft top only touches a moving building.
const SINK_VERTEX_BODY = `
float lp = clamp((uProgress - aPhase * uSpread) / max(1.0 - uSpread, 0.001), 0.0, 1.0);
float reveal = mix(lp, 1.0 - lp, uOut);
transformed.y *= reveal;
vH01 = aH01;
vActive = 1.0 - smoothstep(${REVEAL_CRISP.toFixed(3)}, 1.0, reveal);
vGrain = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

const SINK_HEIGHT_ONLY = `
float lp = clamp((uProgress - aPhase * uSpread) / max(1.0 - uSpread, 0.001), 0.0, 1.0);
float reveal = mix(lp, 1.0 - lp, uOut);
transformed.y *= reveal;
`;

const SOFT_TOP_FRAGMENT_HEAD = `
varying float vH01;
varying float vActive;
varying vec3 vGrain;
float fp_hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
`;

// A hashed discard over the top band. topFade is 1 below the band and falls to 0 at the
// very top; while the building moves (vActive -> 1) the top fragments drop out with a
// stable world-space grain, so the edge erodes softly. A settled building never enters
// the branch, so its roof stays solid. Discard rather than blend keeps depth honest and
// avoids any transparency sort.
const SOFT_TOP_FRAGMENT_BODY = `
float topFade = smoothstep(1.0, 1.0 - ${FADE_BAND.toFixed(3)}, vH01);
float fade = mix(1.0, topFade, vActive);
if (fade < 0.999 && fp_hash13(vGrain * ${GRAIN.toFixed(1)}) > fade) discard;
`;

interface Manifest {
  cities: Array<{ footprints: { file: string } }>;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// Smootherstep from edge0 to edge1: 0 below, 1 above, eased between with zero first and
// second derivative at both ends, so the sink and rise ease in and out without a corner
// and without a visible change of pace at the start or the finish.
function smooth01(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// Stable per-building value in [0,1) for the phase wobble; the usual sine hash, matching
// hero.ts, so the two paths scatter alike.
function hash01(i: number): number {
  const x = Math.sin(i * 127.1) * 43758.5453;
  return x - Math.floor(x);
}
