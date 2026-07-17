// What the building color can encode, and how each choice turns into a number
// with real units. The hero reads raw per-building fields (footprint area,
// floors, height, class) and asks this module for a value and a normalized
// color position. Keeping the coefficients and scales here, rather than baking
// them into the data, means any of them can change without rebuilding the city
// files.

// Carbon intensity by building class, kgCO2e per m2 of gross floor area.
// Source: RIBA 2030 Climate Challenge, version 2 (2021), business-as-usual
// baselines, which cover whole-life embodied carbon (modules A1-A5, B1-B5,
// C1-C4) on a gross internal area basis. RIBA gives three archetypes: domestic
// 1200, non-domestic 1400, and schools 1000. The eight classes map onto those
// three figures. This is a first-order screening intensity, not a measured
// result; the estimate is labeled as such wherever it is shown.
//
// Class order matches the codes written by tools/build_cities.py:
// 0 other, 1 residential_single, 2 residential_multi, 3 office, 4 commercial,
// 5 industrial, 6 education, 7 civic. Untagged stock (class 0) is priced as
// domestic, the dominant type in the dense cores these cities are sampled from.
export const CLASS_COEFF: readonly number[] = [1200, 1200, 1200, 1400, 1400, 1400, 1000, 1400];

export type MetricKey = 'carbon' | 'floorArea' | 'height';

export interface MetricDef {
  key: MetricKey;
  label: string;
  // A shorter label for the control button, where space is tight; the legend
  // title uses the full label.
  short: string;
  // Unit shown on the legend. The formatter below may still abbreviate large
  // values (kg to t, m2 to thousands), but this is the base unit.
  unit: string;
  scale: 'log' | 'linear';
  note: string;
  // Real-world value for one building from its raw fields.
  value: (area: number, floors: number, height: number, cls: number) => number;
  // Robust color domain: the quantiles of the value distribution that map to
  // the ends of the ramp. Values outside clip to the ends, so a handful of
  // outliers do not flatten everything else. A linear metric starts its domain
  // at zero rather than the low quantile, which keeps the unit reading honest.
  loQuantile: number;
  hiQuantile: number;
}

export const METRICS: readonly MetricDef[] = [
  {
    key: 'carbon',
    label: 'Embodied carbon',
    short: 'Carbon',
    unit: 'kgCO2e',
    scale: 'log',
    note: 'first-order: floor area x RIBA 2030 baseline by type',
    value: (area, floors, _height, cls) => area * floors * CLASS_COEFF[cls],
    loQuantile: 0.02,
    hiQuantile: 0.98,
  },
  {
    key: 'floorArea',
    label: 'Gross floor area',
    short: 'Floor area',
    unit: 'm2',
    scale: 'log',
    note: 'footprint area x floor count, from OSM',
    value: (area, floors) => area * floors,
    loQuantile: 0.02,
    hiQuantile: 0.98,
  },
  {
    key: 'height',
    label: 'Building height',
    short: 'Height',
    unit: 'm',
    scale: 'linear',
    // Height is the one quantity a visitor reads directly, so it stays linear.
    // The domain caps near the 90th percentile so the ordinary stock spreads
    // across the ramp instead of hugging the dark end; the rare towers
    // saturate, which the legend states.
    note: 'from OSM height or floor count',
    value: (_area, _floors, height) => height,
    loQuantile: 0.0,
    hiQuantile: 0.9,
  },
];

export const DEFAULT_METRIC: MetricKey = 'carbon';

export interface Domain {
  lo: number;
  hi: number;
  scale: 'log' | 'linear';
}

// Build a color domain from the values seen across every city, so one legend
// holds for the whole morph. Log metrics snap to the enclosing powers of ten,
// which gives clean decade ticks; the linear metric rounds its top to a tidy
// number.
export function makeDomain(values: number[], def: MetricDef): Domain {
  const lo = quantile(values, def.loQuantile);
  const hi = quantile(values, def.hiQuantile);
  if (def.scale === 'log') {
    const loP = Math.max(1, lo);
    const hiP = Math.max(loP * 10, hi);
    return {
      lo: Math.pow(10, Math.floor(Math.log10(loP))),
      hi: Math.pow(10, Math.ceil(Math.log10(hiP))),
      scale: 'log',
    };
  }
  return { lo: 0, hi: niceCeil(Math.max(hi, 1)), scale: 'linear' };
}

// Map a value to [0,1] along the domain. Out-of-range values clip.
export function normalize(value: number, domain: Domain): number {
  if (domain.scale === 'log') {
    const v = Math.log10(Math.max(value, 1e-9));
    const lo = Math.log10(domain.lo);
    const hi = Math.log10(domain.hi);
    return clamp01((v - lo) / (hi - lo));
  }
  return clamp01((value - domain.lo) / (domain.hi - domain.lo));
}

export interface LegendTick {
  t: number; // position along the ramp, 0..1
  label: string; // formatted value with a compact unit
}

// A few labeled marks for the legend. Log domains tick each decade; linear
// domains tick in quarters.
export function legendTicks(domain: Domain, def: MetricDef): LegendTick[] {
  const ticks: LegendTick[] = [];
  if (domain.scale === 'log') {
    const first = Math.log10(domain.lo);
    const last = Math.log10(domain.hi);
    for (let e = first; e <= last + 1e-9; e++) {
      const value = Math.pow(10, e);
      ticks.push({ t: normalize(value, domain), label: formatValue(value, def) });
    }
  } else {
    for (let i = 0; i <= 4; i++) {
      const value = domain.lo + (domain.hi - domain.lo) * (i / 4);
      ticks.push({ t: i / 4, label: formatValue(value, def) });
    }
  }
  return ticks;
}

// Compact, honest formatting. Carbon rolls kg up to tonnes and kilotonnes;
// floor area rolls m2 up to thousands and millions; height stays in meters.
// Significant figures are held to what a screening estimate can support.
export function formatValue(value: number, def: MetricDef): string {
  if (def.key === 'carbon') {
    if (value >= 1e9) return `${trim(value / 1e9)} MtCO2e`;
    if (value >= 1e6) return `${trim(value / 1e6)} ktCO2e`;
    if (value >= 1e3) return `${trim(value / 1e3)} tCO2e`;
    return `${trim(value)} kgCO2e`;
  }
  if (def.key === 'floorArea') {
    if (value >= 1e6) return `${trim(value / 1e6)}M m2`;
    if (value >= 1e3) return `${trim(value / 1e3)}k m2`;
    return `${trim(value)} m2`;
  }
  return `${trim(value)} m`;
}

function trim(value: number): string {
  if (value >= 100) return String(Math.round(value));
  if (value >= 10) return value.toFixed(0);
  return value.toFixed(1).replace(/\.0$/, '');
}

function niceCeil(value: number): number {
  const exp = Math.pow(10, Math.floor(Math.log10(value)));
  const frac = value / exp;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nice * exp;
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const k = clamp01(q) * (ordered.length - 1);
  const lo = Math.floor(k);
  const hi = Math.ceil(k);
  if (lo === hi) return ordered[lo];
  return ordered[lo] * (hi - k) + ordered[hi] * (k - lo);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
