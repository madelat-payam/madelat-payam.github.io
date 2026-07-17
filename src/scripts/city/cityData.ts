// Loads the massing data written by tools/build_cities.py and turns it into two
// things the hero needs: world-unit geometry to draw and morph, and, for each
// selectable metric, a per-building color position with a documented legend.
//
// Every city arrives as one Float32Array with the same stride, so a morph
// between two cities is a straight field-by-field blend of the geometry and of
// the chosen metric's color position.

import {
  METRICS,
  makeDomain,
  type MetricKey,
  type MetricDef,
  type Domain,
} from './metrics';

// Raw record layout, matching the Python Block field order.
export const RAW_STRIDE = 9;
const R_X = 0, R_Z = 1, R_W = 2, R_D = 3, R_ANGLE = 4, R_HEIGHT = 5, R_AREA = 6, R_FLOORS = 7, R_CLASS = 8;

// World geometry the hero draws: position, box, angle, and a display height.
export const GEOM_STRIDE = 6;

// Footprints are scaled so each city's extent fills roughly the same ground
// radius, which keeps the morph framed. Height shares that SAME metres-to-world
// scale, so every building keeps its real proportions instead of turning into a
// needle; a single uniform vertical exaggeration then lifts the whole skyline
// for legibility, the same trick relief maps use. Footprints get a small gain so
// blocks read as massing. These shape the drawing only; the metrics use the raw
// values. Earlier this compressed height by an exponent on its own scale, which
// looked fine on the small synthetic sample but turned the real, kilometres-wide
// cities into thin spikes once the footprint scale shrank and the height did not.
export const WORLD_RADIUS = 26;
// Scale each city so the quantile of its buildings given here fills the frame.
// Using a core quantile rather than the full 95th-percentile extent zooms into
// the dense center, so a kilometers-wide real city reads as a full skyline
// rather than a sparse scatter, with the outskirts falling away into the fog.
export const CORE_QUANTILE = 0.8;
export const VERTICAL_EXAGGERATION = 3.0;
export const FOOTPRINT_GAIN = 1.6;

interface CityMeta {
  slot: string;
  file: string;
  count: number;
  radius_m: number;
  maxHeight_m: number;
}

interface Manifest {
  n: number;
  stride: number;
  fields: string[];
  classes: Record<string, string>;
  cities: CityMeta[];
}

export interface MetricInfo {
  def: MetricDef;
  domain: Domain;
}

export interface CityData {
  // One geometry array per city, already in world units, stride GEOM_STRIDE.
  geom: Float32Array[];
  // Per metric, one array per city of color positions in [0,1], aligned to geom.
  metricT: Record<MetricKey, Float32Array[]>;
  // Per metric, the domain and legend ticks that describe those positions.
  metrics: Record<MetricKey, MetricInfo>;
  count: number;
}

export async function loadCities(base: string): Promise<CityData> {
  const root = `${base}data/cities/`;
  const manifest: Manifest = await fetch(`${root}manifest.json`).then((r) => r.json());
  if (manifest.stride !== RAW_STRIDE) {
    throw new Error(`city data stride ${manifest.stride}, expected ${RAW_STRIDE}; rebuild with tools/build_cities.py`);
  }

  const buffers = await Promise.all(
    manifest.cities.map((c) => fetch(`${root}${c.file}`).then((r) => r.arrayBuffer())),
  );
  const raws = buffers.map((buffer) => new Float32Array(buffer));

  const geom = raws.map((raw) => toGeometry(raw));
  const { metricT, metrics } = buildMetrics(raws);

  return { geom, metricT, metrics, count: manifest.n };
}

function toGeometry(raw: Float32Array): Float32Array {
  const n = raw.length / RAW_STRIDE;
  const scale = WORLD_RADIUS / coreRadius(raw, n, CORE_QUANTILE);
  const blockScale = scale * FOOTPRINT_GAIN;
  const out = new Float32Array(n * GEOM_STRIDE);
  for (let i = 0; i < n; i++) {
    const r = i * RAW_STRIDE;
    const g = i * GEOM_STRIDE;
    out[g] = raw[r + R_X] * scale;
    out[g + 1] = raw[r + R_Z] * scale;
    out[g + 2] = raw[r + R_W] * blockScale;
    out[g + 3] = raw[r + R_D] * blockScale;
    out[g + 4] = raw[r + R_ANGLE];
    // Same scale as the footprint, times a uniform lift: proportions stay real.
    out[g + 5] = raw[r + R_HEIGHT] * scale * VERTICAL_EXAGGERATION;
  }
  return out;
}

// The distance from the city center below which the given quantile of buildings
// falls. Used as the ground radius that fills the frame, so the dense center
// sets the zoom instead of a handful of far outliers.
function coreRadius(raw: Float32Array, n: number, q: number): number {
  const distances = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = i * RAW_STRIDE;
    distances[i] = Math.hypot(raw[r + R_X], raw[r + R_Z]);
  }
  distances.sort();
  const k = Math.max(0, Math.min(n - 1, Math.round(q * (n - 1))));
  return Math.max(distances[k], 1);
}

// For every metric, compute each building's real value, fix one color domain
// across all cities so a single legend holds through the morph, then store the
// normalized position per building. Values are computed once here rather than
// per frame; switching metric in the hero is then just picking an array.
function buildMetrics(raws: Float32Array[]): {
  metricT: Record<MetricKey, Float32Array[]>;
  metrics: Record<MetricKey, MetricInfo>;
} {
  const metricT = {} as Record<MetricKey, Float32Array[]>;
  const metrics = {} as Record<MetricKey, MetricInfo>;

  for (const def of METRICS) {
    // Color by rank within each city, so every scene spans the full ramp and
    // neighboring buildings separate clearly even where the metric values
    // cluster. Each building's rank blends across the morph like any other
    // field. The value domain is kept for reference and future use.
    metricT[def.key] = raws.map((raw) => rankWithinCity(cityValues(raw, def)));
    const all: number[] = [];
    for (const raw of raws) for (const v of cityValues(raw, def)) all.push(v);
    metrics[def.key] = { def, domain: makeDomain(all, def) };
  }

  return { metricT, metrics };
}

// Fractional rank in [0,1] of each value among its own city. Ties resolve by
// array order, which is immaterial for coloring.
function rankWithinCity(values: number[]): Float32Array {
  const n = values.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b]);
  const t = new Float32Array(n);
  for (let r = 0; r < n; r++) t[order[r]] = n > 1 ? r / (n - 1) : 0;
  return t;
}

function cityValues(raw: Float32Array, def: MetricDef): number[] {
  const n = raw.length / RAW_STRIDE;
  const values = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const r = i * RAW_STRIDE;
    values[i] = def.value(raw[r + R_AREA], raw[r + R_FLOORS], raw[r + R_HEIGHT], Math.round(raw[r + R_CLASS]));
  }
  return values;
}
