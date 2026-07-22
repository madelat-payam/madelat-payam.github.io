import { Color } from 'three';

import { type MetricKey } from './metrics';

// Color ramps for the building metric. These four perceptually-uniform maps
// (magma, inferno, turbo, viridis) are sampled from matplotlib so contrast is
// even across the range; each is stored as [position, [r, g, b]] stops.
type Stops = Array<[number, [number, number, number]]>;

const RAMPS = {
  magma: [
    [0.0, [0.001, 0.0, 0.014]],
    [0.0625, [0.04, 0.031, 0.134]],
    [0.125, [0.113, 0.065, 0.277]],
    [0.1875, [0.212, 0.062, 0.419]],
    [0.25, [0.317, 0.072, 0.485]],
    [0.3125, [0.415, 0.11, 0.505]],
    [0.375, [0.513, 0.148, 0.508]],
    [0.4375, [0.614, 0.182, 0.499]],
    [0.5, [0.716, 0.215, 0.475]],
    [0.5625, [0.817, 0.256, 0.436]],
    [0.625, [0.904, 0.32, 0.388]],
    [0.6875, [0.961, 0.418, 0.36]],
    [0.75, [0.987, 0.536, 0.382]],
    [0.8125, [0.996, 0.654, 0.446]],
    [0.875, [0.997, 0.77, 0.535]],
    [0.9375, [0.992, 0.884, 0.64]],
    [1.0, [0.987, 0.991, 0.75]],
  ] as Stops,
  inferno: [
    [0.0, [0.001, 0.0, 0.014]],
    [0.0625, [0.042, 0.028, 0.141]],
    [0.125, [0.129, 0.047, 0.291]],
    [0.1875, [0.238, 0.037, 0.396]],
    [0.25, [0.342, 0.062, 0.429]],
    [0.3125, [0.441, 0.099, 0.432]],
    [0.375, [0.541, 0.135, 0.415]],
    [0.4375, [0.64, 0.171, 0.381]],
    [0.5, [0.736, 0.216, 0.33]],
    [0.5625, [0.822, 0.275, 0.266]],
    [0.625, [0.894, 0.353, 0.194]],
    [0.6875, [0.947, 0.449, 0.115]],
    [0.75, [0.978, 0.558, 0.035]],
    [0.8125, [0.988, 0.675, 0.065]],
    [0.875, [0.975, 0.798, 0.206]],
    [0.9375, [0.948, 0.917, 0.411]],
    [1.0, [0.988, 0.998, 0.645]],
  ] as Stops,
  turbo: [
    [0.0, [0.19, 0.072, 0.232]],
    [0.0625, [0.251, 0.252, 0.634]],
    [0.125, [0.276, 0.421, 0.891]],
    [0.1875, [0.259, 0.58, 0.999]],
    [0.25, [0.158, 0.736, 0.923]],
    [0.3125, [0.093, 0.866, 0.762]],
    [0.375, [0.197, 0.949, 0.595]],
    [0.4375, [0.428, 0.994, 0.386]],
    [0.5, [0.644, 0.99, 0.234]],
    [0.5625, [0.805, 0.925, 0.205]],
    [0.625, [0.933, 0.812, 0.227]],
    [0.6875, [0.993, 0.674, 0.203]],
    [0.75, [0.984, 0.493, 0.128]],
    [0.8125, [0.921, 0.315, 0.055]],
    [0.875, [0.816, 0.185, 0.018]],
    [0.9375, [0.664, 0.084, 0.004]],
    [1.0, [0.48, 0.016, 0.011]],
  ] as Stops,
  viridis: [
    [0.0, [0.267, 0.005, 0.329]],
    [0.0625, [0.282, 0.095, 0.417]],
    [0.125, [0.279, 0.175, 0.483]],
    [0.1875, [0.259, 0.252, 0.525]],
    [0.25, [0.23, 0.322, 0.546]],
    [0.3125, [0.199, 0.388, 0.555]],
    [0.375, [0.173, 0.449, 0.558]],
    [0.4375, [0.149, 0.508, 0.557]],
    [0.5, [0.128, 0.567, 0.551]],
    [0.5625, [0.121, 0.626, 0.533]],
    [0.625, [0.158, 0.684, 0.502]],
    [0.6875, [0.246, 0.739, 0.452]],
    [0.75, [0.369, 0.789, 0.383]],
    [0.8125, [0.516, 0.831, 0.294]],
    [0.875, [0.678, 0.864, 0.19]],
    [0.9375, [0.846, 0.887, 0.1]],
    [1.0, [0.993, 0.906, 0.144]],
  ] as Stops,
  // Green through yellow to red, low to high: the intuitive impact scale for embodied
  // carbon, where green reads as the lighter footprint and red as the heavier. Unlike
  // the four perceptual maps above, this one is meaningful only across its full range,
  // so it is exempt from the per-theme window (see FULL_RANGE). Ranking is within a city,
  // so the color reads as relative, lower to higher, exactly as the legend says. The
  // stops are bright and warm-balanced: green holds the low third, then the ramp climbs
  // through yellow and orange to red across the upper half, so the warm end is not a thin
  // top slice. Brightened over the first balance, which read too green and too dark on
  // the ink-navy background.
  impact: [
    [0.0, [0.235, 0.808, 0.451]],
    [0.35, [0.545, 0.851, 0.353]],
    [0.58, [0.949, 0.851, 0.310]],
    [0.76, [0.984, 0.616, 0.235]],
    [1.0, [0.945, 0.310, 0.243]],
  ] as Stops,
};

export type RampName = keyof typeof RAMPS;
// The palettes offered in the picker. impact is left out on purpose: it is the carbon
// default (see defaultRamp), not a general-purpose colorway a visitor picks for height
// or floor area, where a good/bad reading would be meaningless.
export const RAMP_NAMES: RampName[] = ['magma', 'inferno', 'turbo', 'viridis'];
export type ThemeName = 'dark' | 'light';

// Default palette per theme: a warm, luminous ramp on the dark background and a
// deep, calm ramp on the light one. The visitor can still switch; picking one
// pins it across theme changes.
export const THEME_DEFAULT_RAMP: Record<ThemeName, RampName> = {
  dark: 'inferno',
  light: 'viridis',
};

// A metric can override the theme default with a ramp that carries its own meaning.
// Carbon uses the green-to-red impact scale on both themes, since its reading is about
// impact, not about matching the background. Metrics not listed fall back to the theme
// default, and a visitor's explicit pick overrides either.
const METRIC_DEFAULT_RAMP: Partial<Record<MetricKey, RampName>> = {
  carbon: 'impact',
};

export function defaultRamp(metric: MetricKey, theme: ThemeName): RampName {
  return METRIC_DEFAULT_RAMP[metric] ?? THEME_DEFAULT_RAMP[theme];
}

// A sequential ramp runs dark to light, so its dark end disappears on a dark
// background and its light end disappears on a light one. Each theme therefore
// samples only the sub-range that stays legible against its background. The
// mapping stays monotonic, so order and meaning are preserved, and the legend
// uses the same window so its colors match the buildings.
const THEME_WINDOW: Record<ThemeName, [number, number]> = {
  // Every ramp here begins in the same dark purple, so two themes that both
  // start at their low end look alike. Each window skips that shared purple so
  // the themes read as distinct colorways: the dark default (inferno) becomes a
  // warm red-to-yellow, the light default (viridis) a cool blue-to-green. The
  // light window also drops the pale high end, which would wash out on paper.
  dark: [0.45, 1.0],
  light: [0.3, 0.85],
};

// Ramps whose meaning depends on seeing their whole range, so the per-theme window is
// skipped for them. A diverging good-to-bad scale windowed to a sub-range would drop one
// of its ends, which is the opposite of the point.
const FULL_RANGE: Set<RampName> = new Set<RampName>(['impact']);

export function windowT(t: number, theme: ThemeName, ramp?: RampName): number {
  if (ramp && FULL_RANGE.has(ramp)) return t;
  const [lo, hi] = THEME_WINDOW[theme];
  return lo + t * (hi - lo);
}

// A CSS linear-gradient for the legend bar and the palette swatches, sampled
// through the active theme's window so the swatch a visitor reads matches the
// colors on the buildings. left is low, right is high.
export function rampCss(name: RampName, theme: ThemeName): string {
  const steps = 10;
  const color = new Color();
  const stops: string[] = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    sampleRamp(name, windowT(t, theme, name), color);
    const r = Math.round(color.r * 255);
    const g = Math.round(color.g * 255);
    const b = Math.round(color.b * 255);
    stops.push(`rgb(${r}, ${g}, ${b}) ${Math.round(t * 100)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

export function sampleRamp(name: RampName, t: number, target: Color): Color {
  const stops = RAMPS[name];
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, c0] = stops[i];
    const [p1, c1] = stops[i + 1];
    if (clamped <= p1) {
      const k = (clamped - p0) / (p1 - p0);
      return target.setRGB(
        c0[0] + (c1[0] - c0[0]) * k,
        c0[1] + (c1[1] - c0[1]) * k,
        c0[2] + (c1[2] - c0[2]) * k,
      );
    }
  }
  const last = stops[stops.length - 1][1];
  return target.setRGB(last[0], last[1], last[2]);
}
