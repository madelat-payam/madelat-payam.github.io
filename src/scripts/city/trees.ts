// Low-poly tree canopies for the hero, one set of instanced meshes per city,
// revealed with the morph exactly as the footprints are.
//
// The tree data (c{i}.trees.bin, written by tools/build_cities.py) is a struct of
// arrays in the same city-centered metres as the footprints and the ground layers,
// so multiplying x and z by the city's world scale lands every canopy on the right
// street. Each tree is a rounded icosahedron crown on a short tapered trunk, built
// once as unit geometry and placed with a per-instance matrix, so a whole city of
// canopies is three or four InstancedMeshes rather than tens of thousands of objects.
//
// The reveal is the same sink and rise the footprints use. The footprint wave runs
// uniform (U_SPREAD is 0 there), so a city's trees all move together and the motion
// is a single per-city scalar rather than a per-tree phase: setMorph feeds each city
// one uReveal, and a one-line edit to the instanced vertex shader scales the whole
// instance down into the ground from its base. The leaving city's trees sink with its
// towers and the arriving city's rise with them.
//
// The canopies are additive over the flat green ground layer, not a replacement for
// it: the green fill is the lawns and open green, the trees are the wood and the
// mapped street trees standing over it. They ride the ground render layer (layer 1)
// so the hero's GTAO pass skips them, the same exclusion the flat ground layers use;
// twenty thousand instanced crowns have no place in the ambient-occlusion buffer.
//
// hero.ts adds the returned object once, calls setMorph every frame right after the
// footprints, and calls paint on each theme step so the canopy green tracks the
// background the way the ground layers do.

import {
  Color,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  MeshLambertMaterial,
  Object3D,
  type BufferGeometry,
  type WebGLProgramParametersWithUniforms,
} from 'three';

import { VERTICAL_EXAGGERATION } from './cityData';
import { GROUND_RENDER_LAYER } from './groundLayers';

// Crown tessellation. Detail 1 (an eighty-face icosahedron) reads as a rounded
// canopy while still catching the light in flat facets like the massing does; detail
// 0 is more of a cut gem and detail 2 is needlessly smooth for a shape this small on
// screen.
const CROWN_DETAIL = 1;

// The drawn crown radius is capped here even though a few OSM-tagged crowns (Graz
// carries some) reach the 10 m the tool allows. Past four or five metres a lone crown
// reads as a blob rather than a tree and sprawls over its neighbours, so the cap keeps
// the canopy quiet and even across cities. It only touches the handful of oversized
// crowns; the median street tree sits near 3 m and never reaches it.
const CROWN_CAP_M = 4.5;

// The crown is sized honestly from the tree's own crown radius, not from its height:
// the horizontal radius is the real (capped) crown radius and the vertical radius is a
// touch taller, so the canopy reads as a crown rather than a ball. The trunk then makes
// up whatever height is left, so a tall, narrow tree becomes a compact crown on a
// longer trunk instead of an invented, stretched canopy. This keeps the canopy even and
// quiet across a city, since real crown radii vary far less than heights do.
const CROWN_ASPECT = 1.15;

// The trunk reaches up into the crown by this share of the crown's vertical radius, so
// the faceted underside always closes over the top of the trunk and no daylight opens
// between the two. Tuned against a render; a shorter trunk left a visible gap under
// the detail-1 crown.
const TRUNK_OVERLAP = 0.55;

// Trunk radius as a share of the crown radius: thin enough to read as a trunk rather
// than a stump at the size these draw.
const TRUNK_RADIUS_FRAC = 0.12;

// Shrubs (class 3) are the scrub scatter: a low squat crown sitting straight on the
// ground with no trunk, already short from the data's own height. This is how wide
// they draw relative to tall, held under a sphere so they read as bushes, not saplings.
const SHRUB_ASPECT = 0.8;

// These two reveal dials MUST match footprints.ts, or a city's trees would sink and
// rise out of step with its own towers. footprints.ts keeps them private, so they are
// mirrored here on purpose: this renderer stays self-contained, at the cost of two
// numbers that have to be kept in step by hand if the morph is ever retuned there.
const MORPH_HOLD = 0.15;
const MORPH_CROSS = 0.1;

// Canopy greens per theme, one per class group, pitched a step brighter and warmer
// than the flat greenCanopy fill in groundLayers.ts so the three-dimensional trees
// read as their own layer over it rather than melting into it. Forest is a touch
// deeper, shrub an olive, so the classes separate without turning noisy.
const CROWN_DARK: Record<CanopyGroup, number> = { street: 0x3f6f4a, forest: 0x335d40, shrub: 0x5a6b39 };
const CROWN_LIGHT: Record<CanopyGroup, number> = { street: 0x93c069, forest: 0x6fa855, shrub: 0xb0bf67 };
const TRUNK_DARK = 0x4a3a2c;
const TRUNK_LIGHT = 0x6b5a49;

// The color groups. Mapped points and sampled rows are both street trees and share a
// color; wood and forest scatter is 'forest'; scrub is 'shrub'.
type CanopyGroup = 'street' | 'forest' | 'shrub';

function groupOf(cls: number): CanopyGroup {
  return cls === 2 ? 'forest' : cls === 3 ? 'shrub' : 'street';
}

// The parsed contents of one c{i}.trees.bin. Struct of arrays, every array of length
// count. Reference layout: uint32 count, then float32 x/z/height/crown, then a uint8
// class byte per tree (0 mapped point, 1 row sample, 2 forest scatter, 3 shrub).
interface TreeData {
  count: number;
  x: Float32Array; // city-centered metres, same frame as footprints and layers
  z: Float32Array;
  height: Float32Array; // metres
  crown: Float32Array; // crown radius, metres
  cls: Uint8Array;
}

// A material plus the two theme colors paint() lerps it between.
interface Paintable {
  mat: MeshLambertMaterial;
  dark: Color;
  light: Color;
}

// One city's canopies. reveal scales every instance from its base by r in [0,1];
// hide drops the whole city when it is neither leaving nor arriving.
interface TreeCity {
  reveal(r: number): void;
  hide(): void;
}

interface CityInternal extends TreeCity {
  readonly uReveal: { value: number };
  readonly meshes: InstancedMesh[];
}

// What buildCity hands back: a city handle plus the materials paint() needs to
// recolor. The materials live on the city that owns them but are gathered into one
// flat list for the theme lerp.
interface CityBuild extends CityInternal {
  readonly paintables: Paintable[];
}

export interface TreeCities {
  // Add to the scene once; hero owns nothing else about the trees.
  readonly object: Group;
  // Per-city handles, for a caller that drives one city on its own (the preview
  // harness does; the live hero uses setMorph).
  readonly cities: ReadonlyArray<TreeCity>;
  // Drive the sink and rise from the same damped morph index the footprints read
  // (0 .. cities-1). Only the leaving and arriving cities draw.
  setMorph(current: number): void;
  // Theme step, mix 0 (dark) .. 1 (light), matching hero's background lerp and the
  // ground layers' paint.
  paint(mix: number): void;
}

interface BuildOptions {
  // Mobile keeps only the first maxTrees in priority order (street trees first, then
  // forest, then shrub), to cap the instance count. Omitted on desktop, where every
  // tree is drawn.
  maxTrees?: number;
}

export async function buildTreeCities(
  baseUrl: string,
  scales: number[],
  options: BuildOptions = {},
): Promise<TreeCities> {
  const root = `${baseUrl}data/cities/`;
  const manifest: Manifest = await fetch(`${root}manifest.json`).then((r) => r.json());

  const datas = await Promise.all(
    manifest.cities.map(async (c, i) => {
      const buffer = await fetch(`${root}${c.trees.file}`).then((r) => r.arrayBuffer());
      return { data: readTrees(buffer), scale: scales[i] };
    }),
  );

  // One unit crown and one unit trunk, shared by every city's InstancedMeshes; the
  // per-instance matrix carries each tree's place and size.
  const crownGeometry = new IcosahedronGeometry(1, CROWN_DETAIL);
  const trunkGeometry = new CylinderGeometry(0.8, 1, 1, 6);
  const dummy = new Object3D();

  const object = new Group();
  const paintables: Paintable[] = [];
  const cities: CityInternal[] = datas.map(({ data, scale }) => {
    const city = buildCity(data, scale, options.maxTrees, crownGeometry, trunkGeometry, dummy);
    for (const mesh of city.meshes) object.add(mesh);
    paintables.push(...city.paintables);
    return city;
  });

  // The whole set rides the ground render layer, so the hero's GTAO clone camera (kept
  // on layer 0) never draws the canopies into its occlusion buffer.
  object.traverse((o) => o.layers.set(GROUND_RENDER_LAYER));

  function setMorph(current: number): void {
    const seg = Math.max(0, Math.min(cities.length - 2, Math.floor(current)));
    const f = current - seg;
    // Same windows as footprints.setMorph: each city holds fully grown for the outer
    // MORPH_HOLD of the gap, the leaving city sinks over the first half and the
    // arriving one rises over the second, with a low crossover in the middle.
    const progLeave = smooth01(MORPH_HOLD, 0.5 + MORPH_CROSS, f);
    const progArrive = smooth01(0.5 - MORPH_CROSS, 1 - MORPH_HOLD, f);
    for (let c = 0; c < cities.length; c++) {
      if (c === seg && progLeave < 1) cities[c].reveal(1 - progLeave);
      else if (c === seg + 1 && progArrive > 0) cities[c].reveal(progArrive);
      else cities[c].hide();
    }
  }

  const scratch = new Color();
  function paint(mix: number): void {
    for (const p of paintables) {
      scratch.copy(p.dark).lerp(p.light, mix);
      p.mat.color.copy(scratch);
    }
  }

  return { object, cities, setMorph, paint };
}

// Build one city's canopies: partition the kept trees by color group, then pack each
// group into an InstancedMesh of crowns, plus one InstancedMesh of trunks for the
// trees that carry one (everything but shrubs). All of a city's meshes share one
// uReveal, so the whole city sinks and rises together.
function buildCity(
  data: TreeData,
  scale: number,
  maxTrees: number | undefined,
  crownGeometry: BufferGeometry,
  trunkGeometry: BufferGeometry,
  dummy: Object3D,
): CityBuild {
  const kept = selectTrees(data, maxTrees);
  const groups: Record<CanopyGroup, number[]> = { street: [], forest: [], shrub: [] };
  for (const i of kept) groups[groupOf(data.cls[i])].push(i);

  const uReveal = { value: 1 };
  const meshes: InstancedMesh[] = [];
  const paintables: Paintable[] = [];

  (['street', 'forest', 'shrub'] as CanopyGroup[]).forEach((g) => {
    const idx = groups[g];
    if (idx.length === 0) return;
    const mat = makeCanopyMaterial(CROWN_DARK[g], uReveal);
    const mesh = new InstancedMesh(crownGeometry, mat, idx.length);
    // Only two cities ever draw at once and each sits at the origin when it does, so
    // there is nothing to gain from culling a whole city's crowns and something to
    // lose: the unit geometry's bounds would cull them wrongly.
    mesh.frustumCulled = false;
    mesh.visible = false;
    idx.forEach((i, k) => {
      const s = crownShape(data.height[i], data.crown[i], scale, g === 'shrub');
      dummy.position.set(data.x[i] * scale, s.centerY, data.z[i] * scale);
      dummy.scale.set(s.Rh, s.Rv, s.Rh);
      dummy.updateMatrix();
      mesh.setMatrixAt(k, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    meshes.push(mesh);
    paintables.push({ mat, dark: new Color(CROWN_DARK[g]), light: new Color(CROWN_LIGHT[g]) });
  });

  const trunkIdx = [...groups.street, ...groups.forest];
  if (trunkIdx.length > 0) {
    const mat = makeCanopyMaterial(TRUNK_DARK, uReveal);
    const mesh = new InstancedMesh(trunkGeometry, mat, trunkIdx.length);
    mesh.frustumCulled = false;
    mesh.visible = false;
    trunkIdx.forEach((i, k) => {
      const s = crownShape(data.height[i], data.crown[i], scale, false);
      const t = trunkOf(s);
      dummy.position.set(data.x[i] * scale, t.trunkTop / 2, data.z[i] * scale);
      dummy.scale.set(t.trunkR, t.trunkTop, t.trunkR);
      dummy.updateMatrix();
      mesh.setMatrixAt(k, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    meshes.push(mesh);
    paintables.push({ mat, dark: new Color(TRUNK_DARK), light: new Color(TRUNK_LIGHT) });
  }

  return {
    meshes,
    uReveal,
    paintables,
    reveal(r: number): void {
      uReveal.value = r;
      for (const m of meshes) m.visible = true;
    },
    hide(): void {
      for (const m of meshes) m.visible = false;
    },
  };
}

interface CrownShape {
  Rh: number; // horizontal radius, world units
  Rv: number; // vertical radius, world units
  centerY: number; // crown centre height, world units
  top: number; // canopy top height, world units
}

// The crown ellipsoid for one tree. Horizontal radius is the real crown radius, capped;
// vertical radius is a touch taller for a crown-like profile; the crown centre sits so
// its top reaches the tree's height, and the trunk fills the rest. A short tree whose
// crown is nearly as large as itself would otherwise sink the crown into the ground, so
// the centre is floored to keep the crown resting on the plate. A shrub is a squat crown
// sitting straight on the ground.
function crownShape(heightM: number, crownM: number, scale: number, shrub: boolean): CrownShape {
  const top = heightM * scale * VERTICAL_EXAGGERATION;
  if (shrub) {
    const Rh = crownM * scale;
    const Rv = Math.min(0.5 * top, Rh * SHRUB_ASPECT);
    return { Rh, Rv, centerY: Rv, top };
  }
  const Rh = Math.min(crownM, CROWN_CAP_M) * scale;
  const Rv = Rh * CROWN_ASPECT;
  return { Rh, Rv, centerY: Math.max(top - Rv, Rv), top };
}

interface Trunk {
  trunkTop: number;
  trunkR: number;
}

// The trunk rises from the ground to just inside the crown, so the crown closes over
// it with no gap; a floor keeps a stub under a crown that would otherwise reach the
// ground on a very short tree.
function trunkOf(s: CrownShape): Trunk {
  const trunkTop = Math.max(s.centerY - TRUNK_OVERLAP * s.Rv, s.top * 0.06);
  return { trunkTop, trunkR: TRUNK_RADIUS_FRAC * s.Rh };
}

// Which trees to draw, in priority order. Desktop keeps them all; a maxTrees cap keeps
// the mapped street trees first (the real, dominant signal), then the forest scatter,
// then the shrub scatter, so a phone sheds the filler before the substance.
function selectTrees(data: TreeData, maxTrees?: number): number[] {
  const street: number[] = [];
  const forest: number[] = [];
  const shrub: number[] = [];
  for (let i = 0; i < data.count; i++) {
    const g = groupOf(data.cls[i]);
    (g === 'forest' ? forest : g === 'shrub' ? shrub : street).push(i);
  }
  const ordered = street.concat(forest, shrub);
  return maxTrees && maxTrees < ordered.length ? ordered.slice(0, maxTrees) : ordered;
}

// The beauty material: a flat-shaded Lambert surface whose only edit is the reveal.
// The scale is applied to mvPosition.y after the instance matrix, so it moves the
// whole instance (crown height and its centre offset alike) down to the ground at
// uReveal 0 and back to full at 1. onBeforeCompile edits the stock chunk rather than
// replacing the program, so three's lighting and fog are untouched, and every tree
// material shares one program through the cache key.
function makeCanopyMaterial(color: number, uReveal: { value: number }): MeshLambertMaterial {
  const material = new MeshLambertMaterial({ color, flatShading: true });
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uReveal = uReveal;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uReveal;')
      .replace(
        'mvPosition = modelViewMatrix * mvPosition;',
        'mvPosition.y *= uReveal;\n\tmvPosition = modelViewMatrix * mvPosition;',
      );
  };
  material.customProgramCacheKey = () => 'tree-reveal';
  return material;
}

// Reference reader for c{i}.trees.bin, mirroring _read_trees in tools/build_cities.py.
// Little-endian struct of arrays; every byte is consumed. Bytes = 4 + 17 * count.
function readTrees(buffer: ArrayBuffer): TreeData {
  const view = new DataView(buffer);
  const count = view.getUint32(0, true);
  let off = 4;
  const x = new Float32Array(buffer, off, count); off += count * 4;
  const z = new Float32Array(buffer, off, count); off += count * 4;
  const height = new Float32Array(buffer, off, count); off += count * 4;
  const crown = new Float32Array(buffer, off, count); off += count * 4;
  const cls = new Uint8Array(buffer, off, count); off += count;
  if (off !== buffer.byteLength) {
    throw new Error(`trees.bin: read ${off} of ${buffer.byteLength} bytes; format mismatch`);
  }
  return { count, x, z, height, crown, cls };
}

interface Manifest {
  cities: Array<{ trees: { file: string } }>;
}

// Smootherstep from edge0 to edge1, the same easing footprints.ts uses for the reveal,
// so the trees ride the identical curve.
function smooth01(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * t * (t * (t * 6 - 15) + 10);
}
