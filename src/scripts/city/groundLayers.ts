// The ground under the massing: the road network, the green areas, and the water,
// one set per city, drawn flat on the same plane the blocks stand on. The data is
// written by tools/build_cities.py (the --layers pass) as raw city-centered metres,
// the same frame as the building records, so every layer vertex only has to be
// multiplied by that city's world scale (the one cityData exposes) to land under
// the right blocks.
//
// These are deliberately flat, unlit graphics, not lit geometry. They read as a
// drawing of the ground rather than more scene to light, so they stay quiet under
// the carbon-colored towers instead of competing with them. MeshBasicMaterial
// ignores the lights and still takes the scene fog, so a layer recedes into the
// distance exactly like the massing does.
//
// The whole set hangs off one Object3D. hero.ts adds that object once, calls
// setMorph every frame so the resting city's ground cross-fades with the morph,
// and calls paint on every theme step so the color and the per-theme opacity track
// the background. Gating the layers off (the mobile pass will) is a single guard at
// the hero's call site: never build this, never add it, and nothing else changes.

import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  Uint32BufferAttribute,
} from 'three';

// The layers live on their own render layer so the hero's GTAO pass can skip them.
// GTAO renders the whole scene into a normal/depth buffer to find contacts; a flat
// plane spanning the ground poisons that (a concave water inlet reads as fully
// occluded and turns black). The hero feeds GTAO a camera that stays on layer 0, so
// its buffer sees the massing alone, while the visible camera also draws layer 1.
export const GROUND_RENDER_LAYER = 1;

// Road half-widths in WORLD units, not metres. The roads are schematic: a real
// arterial is only a handful of metres wider than a side street, a difference that
// would vanish at this zoom, so the tiers are drawn at a legible constant width
// instead. Constant in world units means a road reads the same thickness in every
// city regardless of that city's metre-to-world scale, which is what keeps the
// network looking like one consistent system across the morph.
const ROAD_WIDTH = [0.34, 0.2, 0.11]; // tier 0 arterial, 1 connector, 2 local

// Opacity is per theme. On the dark background the ground is quiet, so it sits low
// and lets the carbon towers lead; on paper the same geometry needs more presence
// or it washes out, so every layer is carried heavier. paint() blends between the
// two by the same mix hero uses for the background, so the ground firms up as the
// theme turns to light. Per-tier values also carry the road hierarchy on their own:
// arterials near solid, side streets sunk toward the background.
const ROAD_ALPHA_DARK = [0.95, 0.78, 0.55];
const ROAD_ALPHA_LIGHT = [1.0, 0.9, 0.72];
const GREEN_ALPHA_DARK = [0.82, 0.88]; // lawn, canopy
const GREEN_ALPHA_LIGHT = [0.96, 1.0];
const WATER_ALPHA_DARK = [0.9, 0.86]; // inland, sea
const WATER_ALPHA_LIGHT = [0.98, 0.95];

// Everything lives just above the grid (y = 0.01) and below the massing, stacked
// in thin distinct planes so the coplanar fills never fight for the depth buffer:
// water lowest, then green, then the three road tiers with arterials on top. The
// gaps are tiny; they only have to break the tie.
const Y_WATER = 0.012;
const Y_GREEN = 0.016;
const Y_ROAD = [0.026, 0.023, 0.02]; // arterial highest so it wins at crossings

// Draw order for the transparent layers, low to high, so the painter's order is
// fixed regardless of camera distance: water under green under roads.
const ORDER_WATER = 10;
const ORDER_GREEN = 11;
const ORDER_ROAD = 12;

// A miter that would stretch past this multiple of the half-width at a sharp bend
// is clamped, so a hairpin does not throw a long spike off the corner. Roads rarely
// fold hard enough to hit it; when they do the truncation is a fraction of a world
// unit and invisible.
const MITER_LIMIT = 4;

type ColorKey = 'road' | 'greenLawn' | 'greenCanopy' | 'waterInland' | 'waterSea';

// Theme colors. Dark reads as a basemap under the warm carbon ramp: a blue-grey road
// a step off the navy grid, moss green, and a slate for water, each pitched to sit
// below the towers without disappearing. Light is warm greys and soft sage on paper.
// paint() lerps dark to light with the same mix hero uses for the background.
const DARK_COLORS: Record<ColorKey, number> = {
  road: 0x46536f,
  greenLawn: 0x24402f,
  greenCanopy: 0x2c4f39,
  waterInland: 0x17303f,
  waterSea: 0x122836,
};
const LIGHT_COLORS: Record<ColorKey, number> = {
  road: 0x9a958a,
  greenLawn: 0xccd5b7,
  greenCanopy: 0xbccaa2,
  waterInland: 0xbcd0da,
  waterSea: 0xaec6d2,
};

// One material and what paint()/setMorph() need about it: which theme color it
// tracks, and the rest opacity it settles at on each theme when its city is fully
// current. The live opacity is dark-to-light blended, then scaled by the city's
// cross-fade strength.
interface LayerMaterial {
  mat: MeshBasicMaterial;
  key: ColorKey;
  darkAlpha: number;
  lightAlpha: number;
}

interface LayerManifest {
  cities: Array<{
    layers?: {
      roads?: { file: string };
      green?: { file: string };
      water?: { file: string };
    };
  }>;
}

export interface GroundLayers {
  // Add to the scene once; hero owns nothing else about the layers.
  readonly object: Group;
  // Cross-fade the resting city's ground with the morph. current is the damped
  // morph index hero already tracks (0 .. cities-1).
  setMorph(current: number): void;
  // Theme step, mix 0 (dark) .. 1 (light), matching hero's background lerp.
  paint(mix: number): void;
}

export async function buildGroundLayers(baseUrl: string, scales: number[]): Promise<GroundLayers> {
  const root = `${baseUrl}data/cities/`;
  const manifest: LayerManifest = await fetch(`${root}manifest.json`).then((r) => r.json());
  const cities = manifest.cities;

  // Fetch every city's three layer files at once; they are small and independent.
  const buffers = await Promise.all(
    cities.map(async (c, i) => {
      const L = c.layers;
      if (!L) return null;
      const [roads, green, water] = await Promise.all([
        L.roads ? fetch(`${root}${L.roads.file}`).then((r) => r.arrayBuffer()) : null,
        L.green ? fetch(`${root}${L.green.file}`).then((r) => r.arrayBuffer()) : null,
        L.water ? fetch(`${root}${L.water.file}`).then((r) => r.arrayBuffer()) : null,
      ]);
      return { roads, green, water, scale: scales[i] };
    }),
  );

  const object = new Group();
  const cityGroups: Group[] = [];
  const cityMaterials: LayerMaterial[][] = [];

  buffers.forEach((buf) => {
    const group = new Group();
    const mats: LayerMaterial[] = [];
    if (buf) {
      if (buf.water) addWater(group, mats, buf.water, buf.scale);
      if (buf.green) addGreen(group, mats, buf.green, buf.scale);
      if (buf.roads) addRoads(group, mats, buf.roads, buf.scale);
    }
    group.visible = false; // setMorph turns on only the one or two live cities
    object.add(group);
    cityGroups.push(group);
    cityMaterials.push(mats);
  });

  object.traverse((o) => o.layers.set(GROUND_RENDER_LAYER));

  // The live opacity depends on both the theme (paint) and the morph (setMorph), so
  // both are held here and the two writers share one apply pass.
  const strength = new Array<number>(cityGroups.length).fill(0);
  let mix = 0;
  const scratch = new Color();

  function applyOpacity(): void {
    for (let c = 0; c < cityMaterials.length; c++) {
      const s = strength[c];
      for (const m of cityMaterials[c]) {
        m.mat.opacity = (m.darkAlpha + (m.lightAlpha - m.darkAlpha) * mix) * s;
      }
    }
  }

  function paint(next: number): void {
    mix = next;
    for (const mats of cityMaterials) {
      for (const m of mats) {
        scratch.set(DARK_COLORS[m.key]).lerp(TMP_LIGHT[m.key], mix);
        m.mat.color.copy(scratch);
      }
    }
    applyOpacity();
  }

  function setMorph(current: number): void {
    const cityCount = cityGroups.length;
    const seg = Math.max(0, Math.min(cityCount - 2, Math.floor(current)));
    const f = current - seg;
    // Cross-fade in the middle half of the gap, so the ground swaps while the
    // massing wave is mid-flight rather than before it starts or after it ends.
    const rise = smoother(Math.max(0, Math.min(1, (f - 0.25) / 0.5)));
    for (let c = 0; c < cityCount; c++) {
      strength[c] = c === seg ? 1 - rise : c === seg + 1 ? rise : 0;
      cityGroups[c].visible = strength[c] > 0.001;
    }
    applyOpacity();
  }

  return { object, setMorph, paint };
}

// Cache of the light-theme colors as Color objects, so paint() lerps into a scratch
// without allocating a Color per material per frame during a theme transition.
const TMP_LIGHT: Record<ColorKey, Color> = {
  road: new Color(LIGHT_COLORS.road),
  greenLawn: new Color(LIGHT_COLORS.greenLawn),
  greenCanopy: new Color(LIGHT_COLORS.greenCanopy),
  waterInland: new Color(LIGHT_COLORS.waterInland),
  waterSea: new Color(LIGHT_COLORS.waterSea),
};

// roads: uint32 lineCount, uint32 vertexTotal, uint32[lineCount] per-line vertex
// counts, float32[2*vertexTotal] x,z pairs, uint8[lineCount] tier. Split by tier so
// each tier draws at its own width and opacity.
function addRoads(group: Group, mats: LayerMaterial[], buf: ArrayBuffer, scale: number): void {
  const view = new DataView(buf);
  let off = 0;
  const lineCount = view.getUint32(off, true); off += 4;
  const vertexTotal = view.getUint32(off, true); off += 4;
  const counts = new Array<number>(lineCount);
  for (let i = 0; i < lineCount; i++) { counts[i] = view.getUint32(off, true); off += 4; }
  const coords = new Float32Array(buf, off, vertexTotal * 2); off += vertexTotal * 8;
  const tiers = new Uint8Array(buf, off, lineCount);

  // Gather each tier's polylines, scaling metres to world as we go.
  const byTier: number[][][] = [[], [], []];
  let read = 0;
  for (let i = 0; i < lineCount; i++) {
    const n = counts[i];
    const line = new Array<number>(n * 2);
    for (let k = 0; k < n; k++) {
      line[k * 2] = coords[(read + k) * 2] * scale;
      line[k * 2 + 1] = coords[(read + k) * 2 + 1] * scale;
    }
    read += n;
    byTier[tiers[i]].push(line);
  }

  byTier.forEach((lines, tier) => {
    if (lines.length === 0) return;
    const geom = ribbonGeometry(lines, ROAD_WIDTH[tier], Y_ROAD[tier]);
    const mat = layerMaterial(ROAD_ALPHA_DARK[tier]);
    const mesh = new Mesh(geom, mat);
    mesh.renderOrder = ORDER_ROAD + (2 - tier) * 0.1; // arterials last
    group.add(mesh);
    mats.push({ mat, key: 'road', darkAlpha: ROAD_ALPHA_DARK[tier], lightAlpha: ROAD_ALPHA_LIGHT[tier] });
  });
}

// green: uint32 vertCount, uint32 indexCount, uint32 split, float32[2*vertCount] x,z,
// uint32[indexCount] indices. Indices [0,split) are lawn, [split,end) canopy.
function addGreen(group: Group, mats: LayerMaterial[], buf: ArrayBuffer, scale: number): void {
  const { geom, split, indexCount } = fillGeometry(buf, scale, Y_GREEN);
  const lawn = layerMaterial(GREEN_ALPHA_DARK[0]);
  const canopy = layerMaterial(GREEN_ALPHA_DARK[1]);
  geom.addGroup(0, split, 0);
  geom.addGroup(split, indexCount - split, 1);
  const mesh = new Mesh(geom, [lawn, canopy]);
  mesh.renderOrder = ORDER_GREEN;
  group.add(mesh);
  mats.push({ mat: lawn, key: 'greenLawn', darkAlpha: GREEN_ALPHA_DARK[0], lightAlpha: GREEN_ALPHA_LIGHT[0] });
  mats.push({ mat: canopy, key: 'greenCanopy', darkAlpha: GREEN_ALPHA_DARK[1], lightAlpha: GREEN_ALPHA_LIGHT[1] });
}

// water: same layout as green. Indices [0,split) are inland, [split,end) sea. Cities
// with no coastline carry split == indexCount, so the sea group is empty and draws
// nothing.
function addWater(group: Group, mats: LayerMaterial[], buf: ArrayBuffer, scale: number): void {
  const { geom, split, indexCount } = fillGeometry(buf, scale, Y_WATER);
  const inland = layerMaterial(WATER_ALPHA_DARK[0]);
  const sea = layerMaterial(WATER_ALPHA_DARK[1]);
  geom.addGroup(0, split, 0);
  geom.addGroup(split, indexCount - split, 1);
  const mesh = new Mesh(geom, [inland, sea]);
  mesh.renderOrder = ORDER_WATER;
  group.add(mesh);
  mats.push({ mat: inland, key: 'waterInland', darkAlpha: WATER_ALPHA_DARK[0], lightAlpha: WATER_ALPHA_LIGHT[0] });
  mats.push({ mat: sea, key: 'waterSea', darkAlpha: WATER_ALPHA_DARK[1], lightAlpha: WATER_ALPHA_LIGHT[1] });
}

function fillGeometry(buf: ArrayBuffer, scale: number, y: number): { geom: BufferGeometry; split: number; indexCount: number } {
  const view = new DataView(buf);
  const vertCount = view.getUint32(0, true);
  const indexCount = view.getUint32(4, true);
  const split = view.getUint32(8, true);
  const coords = new Float32Array(buf, 12, vertCount * 2);
  const indices = new Uint32Array(buf, 12 + vertCount * 8, indexCount);

  const positions = new Float32Array(vertCount * 3);
  for (let i = 0; i < vertCount; i++) {
    positions[i * 3] = coords[i * 2] * scale;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = coords[i * 2 + 1] * scale;
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geom.setIndex(new Uint32BufferAttribute(indices, 1));
  return { geom, split, indexCount };
}

// Turn a set of scaled polylines into one flat ribbon mesh at height y. Each vertex
// gets a miter offset so the band keeps a constant width through bends without gaps,
// clamped at MITER_LIMIT so a sharp corner does not spike. The ribbon lies in the
// ground plane and is drawn double-sided, so a grazing camera never sees through it.
function ribbonGeometry(lines: number[][], width: number, y: number): BufferGeometry {
  const half = width / 2;
  const positions: number[] = [];
  const indices: number[] = [];

  for (const line of lines) {
    const m = line.length / 2;
    if (m < 2) continue;
    const base = positions.length / 3;

    for (let i = 0; i < m; i++) {
      const px = line[i * 2];
      const pz = line[i * 2 + 1];
      let nx: number;
      let nz: number;
      let reach = half;

      if (i === 0) {
        [nx, nz] = leftNormal(line, 0, 1);
      } else if (i === m - 1) {
        [nx, nz] = leftNormal(line, m - 2, m - 1);
      } else {
        const [ax, az] = leftNormal(line, i - 1, i);
        const [bx, bz] = leftNormal(line, i, i + 1);
        let mx = ax + bx;
        let mz = az + bz;
        const ml = Math.hypot(mx, mz);
        if (ml < 1e-6) {
          // near a full fold: fall back to the outgoing normal, no miter.
          nx = bx; nz = bz;
        } else {
          mx /= ml; mz /= ml;
          const cosHalf = mx * bx + mz * bz;
          reach = half / Math.max(cosHalf, 1 / MITER_LIMIT);
          nx = mx; nz = mz;
        }
      }

      positions.push(px + nx * reach, y, pz + nz * reach);
      positions.push(px - nx * reach, y, pz - nz * reach);
    }

    for (let i = 0; i < m - 1; i++) {
      const a = base + i * 2;
      const b = base + i * 2 + 1;
      const c = base + (i + 1) * 2;
      const d = base + (i + 1) * 2 + 1;
      indices.push(a, b, d, a, d, c);
    }
  }

  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  return geom;
}

// Unit left-hand normal of the segment from point p to point q in the XZ plane.
function leftNormal(line: number[], p: number, q: number): [number, number] {
  const dx = line[q * 2] - line[p * 2];
  const dz = line[q * 2 + 1] - line[p * 2 + 1];
  const len = Math.hypot(dx, dz) || 1;
  return [-dz / len, dx / len];
}

function layerMaterial(opacity: number): MeshBasicMaterial {
  return new MeshBasicMaterial({
    transparent: true,
    opacity,
    // The layers stack by their own tiny y offsets and render order, so they must
    // not write depth (coplanar fills would fight) but must still test it, so the
    // massing occludes the ground behind it.
    depthWrite: false,
    side: DoubleSide,
  });
}

// Perlin's smootherstep, matching hero.ts, so the ground cross-fade shares the
// easing of the morph it rides on.
function smoother(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}
