"""Build the compact city-massing data that feeds the 3D hero.

For each city we pull building footprints from OpenStreetMap (Overpass), reduce
every building to an oriented massing block, and write one small binary file
plus a manifest the web loader reads. The block keeps the geometry the hero
needs to draw and morph, and the raw per-building quantities the hero needs to
color by a chosen metric: footprint area, floor count, height, and a coarse
building-class code.

Why raw fields instead of a precomputed color: the color the visitor sees is a
selectable metric (embodied carbon, floor area, or height), each with its own
scale and legend. Baking a single value in would fix that choice at build time.
Emitting the raw quantities lets the client compute any of them, and lets the
carbon coefficients change without re-running Overpass.

Why this shape of data: the hero morphs one city into another by moving a fixed
number of blocks between positions, so every city needs the same block count and
one fixed-size record per block. A flat Float32Array with a known stride is the
whole format. No geometry library and no map calls on the web side.

Shared block count: the morph maps building i in one city to building i in the
next, so all cities are resampled to a single count. That count is the smallest
city's real building count (capped by --n), so resampling only ever THINS a city
and never repeats a building. Repeating a building would place two identical
boxes at the same spot, which reads as overlap; keeping the count at or below
every city's real total avoids it. The run prints each city's real count so a
too-thin extent is easy to spot.

Format decision (one-way door, so stated plainly): the record is nine float32s
in the order below. The web loader reads exactly this order, so a change here is
a change in two files at once. Floats carry the two integer fields (floors,
class) without loss at these magnitudes, which keeps one array type and a
trivial morph blend; a mixed-type record would save a few bytes and cost real
complexity for no gain at this scale.

City identity is deliberately kept out of the shipped data. The manifest and the
binary filenames use neutral slot ids (c0, c1, ...) so no city name appears in
anything the site serves. The real extents live here, in the build tool, for
provenance and so the pipeline stays reproducible.

Run it from anywhere with Python 3.9+ (no third-party packages):

    python build_cities.py                # all cities, default output
    python build_cities.py --city tallinn # just one, by its internal id
    python build_cities.py --n 3000       # raise the per-city cap

Output lands in ../public/data/cities relative to this file. The run reports,
per city, the real building count, the count used, the extent radius, the
tallest block, and the class mix; review those, then commit the files.
"""

import argparse
import json
import math
import os
import struct
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, namedtuple

# Bounding boxes as (south, west, north, east) in degrees, framing the
# recognizable core of each city rather than its whole administrative area. The
# internal id drives the --city selector and the morph order; the slot is what
# ships. Reorder freely; the hero morphs cities in this list order.
CITIES = [
    {"id": "tallinn", "slot": "c0", "bbox": (59.420, 24.720, 59.452, 24.790)},
    {"id": "graz", "slot": "c1", "bbox": (47.055, 15.420, 47.085, 15.462)},
    {"id": "lausanne", "slot": "c2", "bbox": (46.505, 6.600, 46.540, 6.660)},
    {"id": "frankfurt", "slot": "c3", "bbox": (50.100, 8.640, 50.125, 8.685)},
    {"id": "newyork", "slot": "c4", "bbox": (40.700, -74.020, 40.790, -73.960)},
]

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# One fixed record per building. x,z is the centroid in meters (city-centered);
# w,d,angle are the best-fit box; height is meters; area is the true footprint
# polygon area in square meters; floors is a count; cls is the building-class
# code below. The web loader reads exactly this field order.
Block = namedtuple("Block", "x z w d angle height area floors cls")
STRIDE = len(Block._fields)

# Rough level height when a building gives no floor count and no metric height.
METERS_PER_LEVEL = 3.2
DEFAULT_HEIGHT = 8.0
MIN_HEIGHT, MAX_HEIGHT = 3.0, 500.0

# Building-class codes. The client maps these to a carbon intensity, so the set
# is deliberately coarse: enough to separate the RIBA archetypes (domestic,
# non-domestic, schools) and a little finer where OSM tags it cheaply. Anything
# untagged or unusual falls to OTHER, which the client prices as domestic. This
# enumeration is a shared contract with cityData.ts and metrics.ts; keep the
# codes stable.
CLASS_OTHER = 0
CLASS_LABELS = {
    0: "other",
    1: "residential_single",
    2: "residential_multi",
    3: "office",
    4: "commercial",
    5: "industrial",
    6: "education",
    7: "civic",
}
BUILDING_CLASS = {
    "house": 1, "detached": 1, "semidetached_house": 1, "terrace": 1, "bungalow": 1,
    "apartments": 2, "residential": 2, "dormitory": 2,
    "office": 3,
    "retail": 4, "commercial": 4, "supermarket": 4, "hotel": 4, "kiosk": 4,
    "industrial": 5, "warehouse": 5, "manufacture": 5, "hangar": 5,
    "school": 6, "kindergarten": 6, "university": 6, "college": 6,
    "hospital": 7, "civic": 7, "public": 7, "government": 7, "church": 7,
    "cathedral": 7, "chapel": 7, "mosque": 7, "temple": 7, "museum": 7,
    "train_station": 7,
}


def overpass_query(bbox):
    south, west, north, east = bbox
    # Ways carry the vast majority of building footprints. "out geom" returns
    # each way's node coordinates inline, so we never resolve node references
    # ourselves. Multipolygon-relation buildings are left out on purpose; they
    # are a small minority and not worth the extra parsing for a massing view.
    return (
        f"[out:json][timeout:180];"
        f'way["building"]({south},{west},{north},{east});'
        f"out geom;"
    )


def fetch(bbox):
    query = overpass_query(bbox)
    body = urllib.parse.urlencode({"data": query}).encode()
    last_error = None
    for endpoint in OVERPASS_ENDPOINTS:
        for attempt in range(3):
            try:
                request = urllib.request.Request(
                    endpoint,
                    data=body,
                    headers={"User-Agent": "madelat-payam-site/1.0 (city hero build)"},
                )
                with urllib.request.urlopen(request, timeout=300) as response:
                    return json.load(response)
            except (urllib.error.URLError, TimeoutError) as error:
                last_error = error
                # Overpass throttles under load; back off before retrying.
                time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"Overpass unreachable for bbox {bbox}: {last_error}")


def parse_buildings(payload):
    for element in payload.get("elements", []):
        geometry = element.get("geometry")
        if not geometry or len(geometry) < 4:
            continue
        coords = [(node["lat"], node["lon"]) for node in geometry]
        yield coords, element.get("tags", {})


def project(lat, lon, lat0, lon0):
    # Local equirectangular projection around the city center. Over a few
    # kilometers the distortion is negligible for a stylized massing, and it
    # avoids a projection dependency. x runs east, z runs north.
    m_per_deg_lat = 111132.0
    m_per_deg_lon = 111320.0 * math.cos(math.radians(lat0))
    x = (lon - lon0) * m_per_deg_lon
    z = (lat - lat0) * m_per_deg_lat
    return x, z


def polygon_area(points):
    area = 0.0
    n = len(points)
    for i in range(n):
        x0, z0 = points[i]
        x1, z1 = points[(i + 1) % n]
        area += x0 * z1 - x1 * z0
    return abs(area) * 0.5


def oriented_box(points):
    # Principal-axis (PCA) fit: find the dominant direction of the footprint
    # vertices, then measure the extent along and across it. This is the
    # best-fit rectangle a human would draw around the plan, cheaply.
    n = len(points)
    cx = sum(p[0] for p in points) / n
    cz = sum(p[1] for p in points) / n
    sxx = sxz = szz = 0.0
    for x, z in points:
        dx, dz = x - cx, z - cz
        sxx += dx * dx
        sxz += dx * dz
        szz += dz * dz
    angle = 0.5 * math.atan2(2 * sxz, sxx - szz)
    ca, sa = math.cos(angle), math.sin(angle)
    min_u = min_v = math.inf
    max_u = max_v = -math.inf
    for x, z in points:
        dx, dz = x - cx, z - cz
        u = dx * ca + dz * sa
        v = -dx * sa + dz * ca
        min_u, max_u = min(min_u, u), max(max_u, u)
        min_v, max_v = min(min_v, v), max(max_v, v)
    width, depth = max_u - min_u, max_v - min_v
    u_mid, v_mid = (min_u + max_u) / 2, (min_v + max_v) / 2
    box_x = cx + u_mid * ca - v_mid * sa
    box_z = cz + u_mid * sa + v_mid * ca
    return box_x, box_z, width, depth, angle


def building_height(tags):
    raw = tags.get("height")
    if raw:
        try:
            return _clamp(float(str(raw).split()[0].replace(",", ".")), MIN_HEIGHT, MAX_HEIGHT)
        except ValueError:
            pass
    levels = tags.get("building:levels")
    if levels:
        try:
            first = str(levels).split(";")[0]
            return _clamp(float(first) * METERS_PER_LEVEL, MIN_HEIGHT, MAX_HEIGHT)
        except ValueError:
            pass
    return DEFAULT_HEIGHT


def building_floors(tags, height):
    # Prefer the stated floor count; fall back to dividing the height by a
    # typical storey. Floors drive gross floor area, so a building always has at
    # least one.
    levels = tags.get("building:levels")
    if levels:
        try:
            return max(1, round(float(str(levels).split(";")[0])))
        except ValueError:
            pass
    return max(1, round(height / METERS_PER_LEVEL))


def building_class(tags):
    return BUILDING_CLASS.get(tags.get("building", ""), CLASS_OTHER)


def _clamp(value, low, high):
    return max(low, min(high, value))


def _spread_bits(value):
    # Interleave a 16-bit integer with zeros so two coordinates combine into a
    # Morton (Z-order) code. Sorting by it keeps spatially close buildings close
    # in the array, which makes the city-to-city morph flow instead of scramble.
    value &= 0xFFFF
    value = (value | (value << 8)) & 0x00FF00FF
    value = (value | (value << 4)) & 0x0F0F0F0F
    value = (value | (value << 2)) & 0x33333333
    value = (value | (value << 1)) & 0x55555555
    return value


def morton(nx, nz):
    xi = int(_clamp(nx, 0.0, 1.0) * 0xFFFF)
    zi = int(_clamp(nz, 0.0, 1.0) * 0xFFFF)
    return _spread_bits(xi) | (_spread_bits(zi) << 1)


def resample(blocks, n):
    m = len(blocks)
    if m == 0:
        return []
    if m == n:
        return list(blocks)
    if m > n:
        # Uniform stride across the Morton-sorted list: a spatially even thinning.
        return [blocks[(i * m) // n] for i in range(n)]
    # Fewer buildings than the target: cycle through the real ones so every
    # morph target is a real building rather than a flat filler. main() keeps the
    # target at or below every city's real count, so this branch is a safety net,
    # not the normal path; when it runs it does duplicate buildings.
    return [blocks[i % m] for i in range(n)]


def percentile(values, q):
    if not values:
        return 0.0
    ordered = sorted(values)
    k = _clamp(q, 0.0, 1.0) * (len(ordered) - 1)
    lo = math.floor(k)
    hi = math.ceil(k)
    if lo == hi:
        return ordered[int(k)]
    return ordered[lo] * (hi - k) + ordered[hi] * (k - lo)


def fetch_city(city):
    return extract_blocks(fetch(city["bbox"]), city["bbox"])


def extract_blocks(payload, bbox):
    # Reduce an Overpass payload to Morton-sorted blocks at full resolution. No
    # resampling happens here, so main() can see every city's real count first
    # and choose one shared count that never has to duplicate a building.
    south, west, north, east = bbox
    lat0, lon0 = (south + north) / 2, (west + east) / 2

    footprints = []
    for coords, tags in parse_buildings(payload):
        projected = [project(lat, lon, lat0, lon0) for lat, lon in coords]
        area = polygon_area(projected)
        if area < 8.0:
            continue
        box_x, box_z, width, depth, angle = oriented_box(projected)
        if width < 2.0 or depth < 2.0:
            continue
        height = building_height(tags)
        footprints.append(
            (box_x, box_z, width, depth, angle, height, area,
             building_floors(tags, height), building_class(tags))
        )

    if not footprints:
        raise RuntimeError(f"No usable buildings for bbox {bbox}; check the extent")

    xs = [f[0] for f in footprints]
    zs = [f[1] for f in footprints]
    min_x, max_x = min(xs), max(xs)
    min_z, max_z = min(zs), max(zs)
    span_x = max(max_x - min_x, 1.0)
    span_z = max(max_z - min_z, 1.0)
    footprints.sort(key=lambda f: morton((f[0] - min_x) / span_x, (f[1] - min_z) / span_z))
    return [Block(*f) for f in footprints]


def finalize(blocks, n):
    # Resample to the shared count and describe the result. raw_count is the real
    # building total before resampling; classes is the count per class label, so
    # the sanity check can see the mix that drives the carbon coloring.
    sampled = resample(blocks, n)
    distances = [math.hypot(b.x, b.z) for b in sampled]
    counts = Counter(b.cls for b in sampled)
    stats = {
        "count": len(sampled),
        "raw_count": len(blocks),
        "radius_m": round(percentile(distances, 0.95), 1),
        "maxHeight_m": round(max(b.height for b in sampled), 1),
        "classes": {CLASS_LABELS[c]: counts.get(c, 0) for c in sorted(CLASS_LABELS)},
    }
    return sampled, stats


def pack(blocks):
    buffer = bytearray()
    for b in blocks:
        buffer += struct.pack(
            "<9f", b.x, b.z, b.w, b.d, b.angle, b.height, b.area, float(b.floors), float(b.cls)
        )
    return bytes(buffer)


def main():
    parser = argparse.ArgumentParser(description="Build city massing data for the hero.")
    default_out = os.path.join(os.path.dirname(__file__), "..", "public", "data", "cities")
    parser.add_argument("--out", default=default_out, help="output directory")
    parser.add_argument(
        "--n", type=int, default=2400,
        help="maximum blocks per city; the run lowers this to the smallest city so no building is duplicated",
    )
    parser.add_argument("--city", help="build only this internal city id")
    args = parser.parse_args()

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)

    selected = [c for c in CITIES if not args.city or c["id"] == args.city]
    if not selected:
        raise SystemExit(f"Unknown city '{args.city}'")

    # First pass: fetch and reduce every selected city, keeping full resolution.
    prepared = []
    for city in selected:
        print(f"fetching {city['slot']} ({city['id']}) ...")
        blocks = fetch_city(city)
        print(f"  {len(blocks)} usable buildings")
        prepared.append((city, blocks))

    # One shared block count. Capping at the smallest city means resampling only
    # thins and never repeats a building, so nothing stacks into a false overlap.
    raw_min = min(len(b) for _, b in prepared)
    n = min(args.n, raw_min)
    if n < args.n:
        print(f"note: smallest city has {raw_min} buildings, so n={n} is used for every city to avoid duplicates")

    # Second pass: resample to the shared count, write, and report.
    manifest_cities = []
    for city, blocks in prepared:
        sampled, stats = finalize(blocks, n)
        filename = f"{city['slot']}.bin"
        with open(os.path.join(out_dir, filename), "wb") as handle:
            handle.write(pack(sampled))
        mix = ", ".join(f"{label} {count}" for label, count in stats["classes"].items() if count)
        print(
            f"{city['slot']}: {stats['count']} blocks (of {stats['raw_count']} real), "
            f"radius {stats['radius_m']} m, tallest {stats['maxHeight_m']} m"
        )
        print(f"   class mix: {mix}")
        manifest_cities.append({"slot": city["slot"], "file": filename, **stats})

    # Only rewrite the manifest for a full run, so a single --city rebuild does
    # not drop the other cities from it.
    if not args.city:
        manifest = {
            "n": n,
            "stride": STRIDE,
            "fields": list(Block._fields),
            "classes": CLASS_LABELS,
            "cities": manifest_cities,
        }
        with open(os.path.join(out_dir, "manifest.json"), "w") as handle:
            json.dump(manifest, handle, indent=2)
        print(f"wrote manifest with {len(manifest_cities)} cities to {out_dir}")
    else:
        print("single-city run: manifest left unchanged")


if __name__ == "__main__":
    main()
