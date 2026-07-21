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

Real footprints: alongside each boxed c{i}.bin the tool writes c{i}.footprints.bin,
the outline of every building that clears the same filters, in city-centered
meters. These are the LoD1 source the hero extrudes to height. Unlike the boxes
they are not resampled to a shared count, because the rebuilt hero no longer morphs
one building onto another; it sinks one city into the ground and raises the next.
The file is a struct of arrays, little-endian like the rest: building count and
vertex total, then one ring length per building, then all x/z pairs (rings
concatenated in building order, stored open and counter-clockwise), then height,
area, floors, and a class byte per building. The manifest gains a "footprints"
object per city, next to "layers".

Ground layers (roads, green areas, water) are a second mode that leaves the
building files alone:

    python build_cities.py --layers roads,green,water
    python build_cities.py --layers water --city newyork  # one layer, one city

Layer runs need the building files and manifest to exist first: each city's
clip window derives from its built massing, by the same core-radius rule the
web loader applies, so the layers cover exactly the ground the hero can see.
Raw Overpass responses are cached under tools/cache, so re-running with other
clip or simplify settings does not refetch; --refetch forces it. Each run also
writes tools/cache/<city>.layers.svg, the layers in plan under the building
centroids, worth an eyeball before committing.

Layer files ship next to the buildings under the same neutral slot names.
c0.roads.bin holds polylines: line count, vertex total, per-line vertex
counts, x/z pairs in meters, then one road-tier byte per line (0 arterial,
1 connector, 2 local). c0.green.bin and c0.water.bin hold triangulated fill
meshes: vertex count, index count, kind split, x/z pairs, triangle indices.
Green splits lawn-like from canopy-like at the kind split; water splits
inland water from sea. Everything is little-endian, like the building format,
and the manifest gains a "layers" object per city.

The sea needs a word. OSM has no sea polygons, only directed coastline ways,
so the water build stitches coastline fragments, clips them to the window,
and closes them along its boundary. Which side is sea is not taken on faith:
both closures are tested against the city's own buildings (buildings stand on
land) and the orientation that agrees is kept. Multipolygon inner rings, the
ponds in parks and islands in lakes, are skipped on purpose; the hero draws
water above green, which keeps the picture right at massing abstraction.
"""

import argparse
import http.client
import json
import math
import os
import struct
import time
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

# The real-footprint record for c{i}.footprints.bin: the cleaned outline ring in
# city-centered meters (open, counter-clockwise) plus the same per-building
# quantities the box carries. Variable length because of the ring, so the writer
# packs a struct of arrays rather than a fixed stride (see pack_footprints).
Footprint = namedtuple("Footprint", "ring height area floors cls")

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

# Ground layers. The road set is the vehicular street grid, the fabric that
# makes a city read as a city at massing scale; service ways, footpaths, and
# cycleways stay out because at 480 blocks per scene they read as noise, not
# streets. The tier survives into the file so the hero can draw arteries and
# local streets differently without a refetch.
LAYER_NAMES = ("roads", "green", "water")
ROAD_TIER = {
    "motorway": 0, "motorway_link": 0, "trunk": 0, "trunk_link": 0,
    "primary": 0, "primary_link": 0,
    "secondary": 1, "secondary_link": 1, "tertiary": 1, "tertiary_link": 1,
    "residential": 2, "unclassified": 2, "living_street": 2,
}

# Green kinds: 0 lawn-like, 1 canopy-like. Stored as an index split in the
# mesh so the hero can tint canopy darker than lawn; drawing all of it in one
# green also works and costs nothing.
GREEN_LANDUSE = {"grass": 0, "meadow": 0, "recreation_ground": 0, "forest": 1}
GREEN_NATURAL = {"grassland": 0, "wood": 1, "scrub": 1}

# Water kinds: 0 inland polygons (rivers, lakes, docks), 1 sea assembled from
# the coastline.
WATER_INLAND, WATER_SEA = 0, 1

# The clip window is a square of CLIP_MULT core radii, intersected with the
# fetch bbox. Past about 2.2 core radii everything sits beyond the fog's far
# plane from every tour camera, so 2.6 leaves margin for the view orbit
# without shipping a whole metro area.
CLIP_MULT = 2.6
SIMPLIFY_ROADS_M = 2.0
SIMPLIFY_AREAS_M = 3.0
MIN_AREA_M2 = 300.0
# Keep in sync with CORE_QUANTILE in src/scripts/city/cityData.ts: the clip
# window has to follow the same world scale the client will derive.
CORE_QUANTILE = 0.8


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


def fetch_payload(query, what):
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
            except (OSError, http.client.HTTPException) as error:
                last_error = error
                # Overpass throttles under load and sometimes drops the connection
                # mid-response (RemoteDisconnected); both surface here, not just as a
                # URLError. Back off before retrying, then fall to the next endpoint.
                time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"Overpass unreachable for {what}: {last_error}")


def fetch(bbox):
    return fetch_payload(overpass_query(bbox), f"bbox {bbox}")


def layer_query(layer, bbox):
    south, west, north, east = bbox
    b = f"({south},{west},{north},{east})"
    if layer == "roads":
        classes = "|".join(sorted(ROAD_TIER))
        return f'[out:json][timeout:300];way["highway"~"^({classes})$"]{b};out geom;'
    if layer == "green":
        # Ways AND relations: the big parks are usually multipolygon relations,
        # and skipping them would lose exactly the areas worth drawing.
        return (
            f"[out:json][timeout:300];("
            f'way["leisure"="park"]{b};relation["leisure"="park"]{b};'
            f'way["landuse"~"^(grass|forest|meadow|recreation_ground)$"]{b};'
            f'relation["landuse"~"^(grass|forest|meadow|recreation_ground)$"]{b};'
            f'way["natural"~"^(wood|scrub|grassland)$"]{b};'
            f'relation["natural"~"^(wood|scrub|grassland)$"]{b};'
            f");out geom;"
        )
    # Water polygons plus the raw coastline; the sea is assembled from the
    # coastline in build_water, because OSM carries no sea polygons.
    return (
        f"[out:json][timeout:300];("
        f'way["natural"="water"]{b};relation["natural"="water"]{b};'
        f'way["waterway"~"^(riverbank|dock)$"]{b};relation["waterway"="riverbank"]{b};'
        f'way["natural"="coastline"]{b};'
        f");out geom;"
    )


def fetch_layer(city, layer, cache_dir, refetch):
    # The raw response is cached so clip and simplify settings can change
    # without another round trip to Overpass. Returns (payload, was_cached).
    path = os.path.join(cache_dir, f"{city['id']}.{layer}.json")
    if not refetch and os.path.exists(path):
        with open(path) as handle:
            return json.load(handle), True
    payload = fetch_payload(layer_query(layer, city["bbox"]), f"{city['slot']} {layer}")
    os.makedirs(cache_dir, exist_ok=True)
    with open(path, "w") as handle:
        json.dump(payload, handle)
    return payload, False


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


def fetch_city(city, cache_dir, refetch):
    # Cache the raw building payload the way the layers do, so retuning the export
    # never pulls the same city from Overpass twice. --refetch forces a fresh pull.
    path = os.path.join(cache_dir, f"{city['id']}.buildings.json")
    if not refetch and os.path.exists(path):
        with open(path) as handle:
            payload = json.load(handle)
        cached = True
    else:
        payload = fetch(city["bbox"])
        os.makedirs(cache_dir, exist_ok=True)
        with open(path, "w") as handle:
            json.dump(payload, handle)
        cached = False
    blocks, footprints = extract_blocks(payload, city["bbox"])
    return blocks, footprints, cached


def extract_blocks(payload, bbox):
    # Reduce an Overpass payload to Morton-sorted blocks, and collect the real
    # footprint outlines in the same pass. Both keep every building that clears the
    # filters, so main() sees each city's real count before choosing one shared box
    # count. The boxes feed the legacy morph file; the rings feed the extruded hero.
    south, west, north, east = bbox
    lat0, lon0 = (south + north) / 2, (west + east) / 2

    boxes = []
    footprints = []
    for coords, tags in parse_buildings(payload):
        projected = [project(lat, lon, lat0, lon0) for lat, lon in coords]
        area = polygon_area(projected)
        if area < 8.0:
            continue
        box_x, box_z, width, depth, angle = oriented_box(projected)
        if width < 2.0 or depth < 2.0:
            continue
        ring = footprint_ring(projected)
        if ring is None:
            continue
        height = building_height(tags)
        floors = building_floors(tags, height)
        cls = building_class(tags)
        boxes.append((box_x, box_z, width, depth, angle, height, area, floors, cls))
        footprints.append(Footprint(ring, height, area, floors, cls))

    if not boxes:
        raise RuntimeError(f"No usable buildings for bbox {bbox}; check the extent")

    xs = [b[0] for b in boxes]
    zs = [b[1] for b in boxes]
    min_x, max_x = min(xs), max(xs)
    min_z, max_z = min(zs), max(zs)
    span_x = max(max_x - min_x, 1.0)
    span_z = max(max_z - min_z, 1.0)
    boxes.sort(key=lambda b: morton((b[0] - min_x) / span_x, (b[1] - min_z) / span_z))
    return [Block(*b) for b in boxes], footprints


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


def pack_footprints(footprints):
    # Struct of arrays, little-endian: building and vertex counts, then a ring
    # length per building, then every x/z pair (rings concatenated in building
    # order), then height, area, floors, and a class byte per building. Nothing is
    # interleaved, so the web loader slices each array straight out by the counts.
    building_count = len(footprints)
    vertex_total = sum(len(f.ring) for f in footprints)
    out = bytearray()
    out += struct.pack("<II", building_count, vertex_total)
    out += struct.pack(f"<{building_count}I", *(len(f.ring) for f in footprints))
    for f in footprints:
        flat = []
        for x, z in f.ring:
            flat.extend((x, z))
        out += struct.pack(f"<{len(flat)}f", *flat)
    out += struct.pack(f"<{building_count}f", *(f.height for f in footprints))
    out += struct.pack(f"<{building_count}f", *(f.area for f in footprints))
    out += struct.pack(f"<{building_count}f", *(float(f.floors) for f in footprints))
    out += struct.pack(f"<{building_count}B", *(f.cls for f in footprints))
    return bytes(out)


# Plane geometry for the ground layers. Everything below works on (x, z)
# tuples in city-centered meters, the same frame as the building blocks.

def dedupe(points, closed=False, eps=0.01):
    out = []
    for p in points:
        if not out or abs(p[0] - out[-1][0]) > eps or abs(p[1] - out[-1][1]) > eps:
            out.append(p)
    if closed and len(out) > 1 and abs(out[0][0] - out[-1][0]) <= eps and abs(out[0][1] - out[-1][1]) <= eps:
        out.pop()
    return out


def signed_area(ring):
    a = 0.0
    for i in range(len(ring)):
        x0, z0 = ring[i]
        x1, z1 = ring[(i + 1) % len(ring)]
        a += x0 * z1 - x1 * z0
    return a * 0.5


def footprint_ring(points):
    # Clean a projected outline into the ring the hero extrudes: drop the closing
    # duplicate and any repeated neighbors, then force counter-clockwise winding so
    # the extruded walls face outward. None if too little is left to form a face.
    ring = dedupe(points, closed=True)
    if len(ring) < 3:
        return None
    if signed_area(ring) < 0:
        ring.reverse()
    return ring


def simplify_polyline(points, tol):
    # Douglas-Peucker with an explicit stack; coastline chains can run to tens
    # of thousands of points, past the recursion limit.
    if len(points) < 3 or tol <= 0:
        return list(points)
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        ax, az = points[a]
        dx, dz = points[b][0] - ax, points[b][1] - az
        seg2 = dx * dx + dz * dz
        worst, wi = -1.0, -1
        for i in range(a + 1, b):
            px, pz = points[i][0] - ax, points[i][1] - az
            if seg2 == 0:
                d2 = px * px + pz * pz
            else:
                t = (px * dx + pz * dz) / seg2
                t = 0.0 if t < 0 else (1.0 if t > 1 else t)
                d2 = (px - t * dx) ** 2 + (pz - t * dz) ** 2
            if d2 > worst:
                worst, wi = d2, i
        if worst > tol * tol:
            keep[wi] = True
            stack.append((a, wi))
            stack.append((wi, b))
    return [p for p, k in zip(points, keep) if k]


def simplify_ring(ring, tol):
    # DP needs fixed endpoints, which a ring lacks; anchor it at point 0 and at
    # the point farthest from it, simplify the two halves, and rejoin.
    if len(ring) < 5 or tol <= 0:
        return list(ring)
    p0 = ring[0]
    far = max(range(1, len(ring)), key=lambda i: (ring[i][0] - p0[0]) ** 2 + (ring[i][1] - p0[1]) ** 2)
    a = simplify_polyline(ring[:far + 1], tol)
    b = simplify_polyline(ring[far:] + [p0], tol)
    return a[:-1] + b[:-1]


def _clip_segment(p, q, rect):
    # Liang-Barsky. Returns the clipped segment or None; crossing points land
    # exactly on the rectangle boundary, which the sea closure relies on.
    x0, z0 = p
    dx, dz = q[0] - x0, q[1] - z0
    t0, t1 = 0.0, 1.0
    for pk, qk in ((-dx, x0 - rect[0]), (dx, rect[2] - x0), (-dz, z0 - rect[1]), (dz, rect[3] - z0)):
        if pk == 0:
            if qk < 0:
                return None
            continue
        r = qk / pk
        if pk < 0:
            if r > t1:
                return None
            if r > t0:
                t0 = r
        else:
            if r < t0:
                return None
            if r < t1:
                t1 = r
    return (x0 + t0 * dx, z0 + t0 * dz), (x0 + t1 * dx, z0 + t1 * dz)


def clip_polyline(points, rect):
    # Clip to the rectangle, splitting into the runs that remain inside.
    runs, run = [], []
    for i in range(len(points) - 1):
        seg = _clip_segment(points[i], points[i + 1], rect)
        if seg is None:
            if len(run) > 1:
                runs.append(run)
            run = []
            continue
        a, b = seg
        if not run:
            run = [a]
        elif abs(run[-1][0] - a[0]) > 0.01 or abs(run[-1][1] - a[1]) > 0.01:
            if len(run) > 1:
                runs.append(run)
            run = [a]
        run.append(b)
    if len(run) > 1:
        runs.append(run)
    return runs


def clip_ring(ring, rect):
    # Sutherland-Hodgman against the four half-planes. Lobes that a concave
    # ring pushes outside come back joined by zero-width runs along the clip
    # edge; those sit on the window boundary, in the fog, and fill correctly,
    # so they are left as they are.
    def inside(p, edge, val):
        if edge == 0:
            return p[0] >= val
        if edge == 1:
            return p[0] <= val
        if edge == 2:
            return p[1] >= val
        return p[1] <= val

    def crossing(a, b, edge, val):
        if edge < 2:
            t = (val - a[0]) / (b[0] - a[0])
            return (val, a[1] + t * (b[1] - a[1]))
        t = (val - a[1]) / (b[1] - a[1])
        return (a[0] + t * (b[0] - a[0]), val)

    out = list(ring)
    for edge, val in ((0, rect[0]), (1, rect[2]), (2, rect[1]), (3, rect[3])):
        if not out:
            return []
        kept, prev = [], out[-1]
        for cur in out:
            if inside(cur, edge, val):
                if not inside(prev, edge, val):
                    kept.append(crossing(prev, cur, edge, val))
                kept.append(cur)
            elif inside(prev, edge, val):
                kept.append(crossing(prev, cur, edge, val))
            prev = cur
        out = kept
    return dedupe(out, closed=True)


def _in_tri(p, a, b, c):
    # Strictly inside a counterclockwise triangle; points on the edge do not
    # count, so shared boundary vertices cannot block an ear.
    e = 1e-9
    return ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) > e
            and (c[0] - b[0]) * (p[1] - b[1]) - (c[1] - b[1]) * (p[0] - b[0]) > e
            and (a[0] - c[0]) * (p[1] - c[1]) - (a[1] - c[1]) * (p[0] - c[0]) > e)


def triangulate(ring):
    # Ear clipping. Accepts either winding; emits triples of indices into the
    # ring, wound counterclockwise in the x-east/z-north plane. Collinear
    # vertices are digested without emitting their zero-area ear, which also
    # absorbs the duplicate-ish points a boundary clip leaves behind. Returns
    # None when no ear fits, which in practice means self-intersecting data;
    # the caller drops the ring and reports it.
    if len(ring) < 3:
        return []
    idx = list(range(len(ring)))
    if signed_area(ring) < 0:
        idx.reverse()

    def cross_at(k):
        a, b, c = ring[idx[k - 1]], ring[idx[k]], ring[idx[(k + 1) % len(idx)]]
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    tris = []
    k = 0
    stalled = 0
    while len(idx) > 3:
        if stalled > len(idx):
            return None
        cr = cross_at(k)
        if cr < -1e-9:
            k = (k + 1) % len(idx)
            stalled += 1
            continue
        if cr <= 1e-9:
            idx.pop(k)
            k %= len(idx)
            stalled = 0
            continue
        tri = (idx[k - 1], idx[k], idx[(k + 1) % len(idx)])
        a, b, c = ring[tri[0]], ring[tri[1]], ring[tri[2]]
        if any(_in_tri(ring[j], a, b, c) for j in idx if j not in tri):
            k = (k + 1) % len(idx)
            stalled += 1
            continue
        tris.append(tri)
        idx.pop(k)
        k %= len(idx)
        stalled = 0
    if abs(cross_at(0)) > 1e-9:
        tris.append((idx[-1], idx[0], idx[1]))
    return tris


def join_paths(paths, eps=0.5):
    # Join fragments end to end into rings where they close. OSM relation
    # members and coastline ways arrive unordered and arbitrarily directed;
    # endpoints match on a rounded grid, coarse enough to absorb projection
    # float noise, fine enough not to bridge real gaps. Fragment direction
    # follows the seed fragment, so a consistently directed coastline keeps
    # its direction through the join.
    def k_of(p):
        return (round(p[0] / eps), round(p[1] / eps))

    rings, open_frags = [], []
    for f in paths:
        if len(f) < 2:
            continue
        if len(f) >= 4 and k_of(f[0]) == k_of(f[-1]):
            rings.append(list(f[:-1]))
        else:
            open_frags.append(list(f))

    ends = {}
    for i, f in enumerate(open_frags):
        ends.setdefault(k_of(f[0]), []).append(i)
        ends.setdefault(k_of(f[-1]), []).append(i)
    used = [False] * len(open_frags)

    def take(key):
        for i in ends.get(key, ()):
            if not used[i]:
                return i
        return None

    chains = []
    for s, f in enumerate(open_frags):
        if used[s]:
            continue
        used[s] = True
        chain = list(f)
        for at_tail in (True, False):
            while k_of(chain[0]) != k_of(chain[-1]):
                end = chain[-1] if at_tail else chain[0]
                j = take(k_of(end))
                if j is None:
                    break
                used[j] = True
                nxt = open_frags[j]
                if at_tail:
                    if k_of(nxt[0]) != k_of(end):
                        nxt = nxt[::-1]
                    chain.extend(nxt[1:])
                else:
                    if k_of(nxt[-1]) != k_of(end):
                        nxt = nxt[::-1]
                    chain[:0] = nxt[:-1]
        if len(chain) >= 4 and k_of(chain[0]) == k_of(chain[-1]):
            rings.append(chain[:-1])
        else:
            chains.append(chain)
    return rings, chains


# Sea assembly. A clipped coastline chain starts and ends on the window
# boundary; walking the boundary from each exit to the next entry, corners
# included, closes the water into rings. Whether to walk clockwise or
# counterclockwise depends on the coastline's direction convention, and
# build_water settles that empirically rather than by convention: it tries
# both and keeps the closure that leaves the city's buildings on land.

def _near_boundary(p, rect, eps=0.5):
    return (abs(p[0] - rect[0]) <= eps or abs(p[0] - rect[2]) <= eps
            or abs(p[1] - rect[1]) <= eps or abs(p[1] - rect[3]) <= eps)


def _snap_rect(p, rect):
    x = min(max(p[0], rect[0]), rect[2])
    z = min(max(p[1], rect[1]), rect[3])
    d = (abs(x - rect[0]), abs(x - rect[2]), abs(z - rect[1]), abs(z - rect[3]))
    edge = d.index(min(d))
    if edge == 0:
        x = rect[0]
    elif edge == 1:
        x = rect[2]
    elif edge == 2:
        z = rect[1]
    else:
        z = rect[3]
    return (x, z)


def _rect_t(p, rect, eps=0.02):
    # Perimeter position, clockwise in plan from the top-left corner.
    xmin, zmin, xmax, zmax = rect
    px, pz = xmax - xmin, zmax - zmin
    x, z = p
    if abs(z - zmax) <= eps:
        return x - xmin
    if abs(x - xmax) <= eps:
        return px + (zmax - z)
    if abs(z - zmin) <= eps:
        return px + pz + (xmax - x)
    return 2 * px + pz + (z - zmin)


def close_sea(chains, rect, cw):
    xmin, zmin, xmax, zmax = rect
    px, pz = xmax - xmin, zmax - zmin
    per = 2 * (px + pz)
    corners = ((0.0, (xmin, zmax)), (px, (xmax, zmax)),
               (px + pz, (xmax, zmin)), (2 * px + pz, (xmin, zmin)))
    entries = sorted((_rect_t(c[0], rect), i) for i, c in enumerate(chains))

    def next_entry(t):
        if cw:
            for te, i in entries:
                if te > t + 1e-6:
                    return te, i
            return entries[0]
        for te, i in reversed(entries):
            if te < t - 1e-6:
                return te, i
        return entries[-1]

    def corners_between(t0, t1):
        span = (t1 - t0) % per if cw else (t0 - t1) % per
        if span <= 1e-6:
            span = per
        passed = []
        for tc, p in corners:
            d = (tc - t0) % per if cw else (t0 - tc) % per
            if 1e-6 < d < span - 1e-6:
                passed.append((d, p))
        passed.sort()
        return [p for _, p in passed]

    used = [False] * len(chains)
    rings = []
    for s in range(len(chains)):
        if used[s]:
            continue
        ring = []
        i = s
        while True:
            used[i] = True
            ring.extend(chains[i])
            t_in, j = next_entry(_rect_t(chains[i][-1], rect))
            ring.extend(corners_between(_rect_t(chains[i][-1], rect), t_in))
            if j == s or used[j]:
                break
            i = j
        ring = dedupe(ring, closed=True)
        if len(ring) >= 3 and abs(signed_area(ring)) > 1.0:
            rings.append(ring)
    return rings


def _ring_boxes(rings):
    boxes = []
    for ring in rings:
        xs = [p[0] for p in ring]
        zs = [p[1] for p in ring]
        boxes.append((min(xs), min(zs), max(xs), max(zs)))
    return boxes


def buildings_in_rings(centroids, rings):
    # Fraction of building centroids inside any of the rings, even-odd rule.
    # This is the ground truth for the sea orientation: near zero when the
    # closure is right, near one when it drowned the city.
    if not rings or not centroids:
        return 0.0
    boxes = _ring_boxes(rings)
    hits = 0
    for x, z in centroids:
        inside = False
        for ring, (bx0, bz0, bx1, bz1) in zip(rings, boxes):
            if x < bx0 or x > bx1 or z < bz0 or z > bz1:
                continue
            j = len(ring) - 1
            for i in range(len(ring)):
                xi, zi = ring[i]
                xj, zj = ring[j]
                if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi) + xi:
                    inside = not inside
                j = i
        if inside:
            hits += 1
    return hits / len(centroids)


def _green_kind(tags):
    if tags.get("leisure") == "park":
        return 0
    if tags.get("landuse") in GREEN_LANDUSE:
        return GREEN_LANDUSE[tags["landuse"]]
    if tags.get("natural") in GREEN_NATURAL:
        return GREEN_NATURAL[tags["natural"]]
    return None


def _water_kind(tags):
    if tags.get("natural") == "water" or tags.get("waterway") in ("riverbank", "dock"):
        return WATER_INLAND
    return None


def _area_rings(payload, lat0, lon0, kind_fn, report):
    # Closed ways become rings directly; relations get their outer members
    # joined. Inner rings are skipped by design (see the module docstring).
    for element in payload.get("elements", []):
        kind = kind_fn(element.get("tags", {}))
        if kind is None:
            continue
        if element.get("type") == "way":
            geometry = element.get("geometry")
            if not geometry or len(geometry) < 4:
                continue
            pts = [project(g["lat"], g["lon"], lat0, lon0) for g in geometry]
            if abs(pts[0][0] - pts[-1][0]) > 0.5 or abs(pts[0][1] - pts[-1][1]) > 0.5:
                report["open ways"] += 1
                continue
            yield dedupe(pts, closed=True), kind
        elif element.get("type") == "relation":
            outers = []
            for member in element.get("members", ()):
                if member.get("type") != "way" or not member.get("geometry"):
                    continue
                if member.get("role") == "inner":
                    report["inners skipped"] += 1
                    continue
                outers.append([project(g["lat"], g["lon"], lat0, lon0) for g in member["geometry"]])
            rings, leftovers = join_paths(outers)
            report["unclosed outers"] += len(leftovers)
            for ring in rings:
                yield ring, kind


def _clipped_area_rings(payload, lat0, lon0, kind_fn, rect, tol, min_area, report):
    out = []
    for ring, kind in _area_rings(payload, lat0, lon0, kind_fn, report):
        ring = clip_ring(ring, rect)
        if len(ring) < 3:
            continue
        ring = dedupe(simplify_ring(ring, tol), closed=True)
        if len(ring) < 3:
            continue
        if abs(signed_area(ring)) < min_area:
            report["below min area"] += 1
            continue
        out.append((ring, kind))
    return out


def build_roads(payload, lat0, lon0, rect, tol):
    lines, tiers = [], []
    report = Counter()
    for element in payload.get("elements", []):
        if element.get("type") != "way" or not element.get("geometry"):
            continue
        tags = element.get("tags", {})
        tier = ROAD_TIER.get(tags.get("highway", ""))
        if tier is None:
            continue
        # A tunnel drawn on the ground would stripe the river above it; bridges
        # stay, because a bridge over the water is exactly what should draw.
        if tags.get("tunnel") not in (None, "no"):
            report["tunnels skipped"] += 1
            continue
        pts = [project(g["lat"], g["lon"], lat0, lon0) for g in element["geometry"]]
        for run in clip_polyline(pts, rect):
            run = simplify_polyline(dedupe(run), tol)
            if len(run) >= 2:
                lines.append(run)
                tiers.append(tier)
    return lines, tiers, report


def build_green(payload, lat0, lon0, rect, tol, min_area):
    report = Counter()
    rings = _clipped_area_rings(payload, lat0, lon0, _green_kind, rect, tol, min_area, report)
    lawn = [r for r, kind in rings if kind == 0]
    canopy = [r for r, kind in rings if kind == 1]
    return [lawn, canopy], report


def build_water(payload, lat0, lon0, rect, tol, min_area, centroids):
    report = Counter()
    inland = [r for r, _ in _clipped_area_rings(
        payload, lat0, lon0, _water_kind, rect, tol, min_area, report)]

    coast = []
    for element in payload.get("elements", []):
        if (element.get("type") == "way" and element.get("geometry")
                and element.get("tags", {}).get("natural") == "coastline"):
            coast.append([project(g["lat"], g["lon"], lat0, lon0) for g in element["geometry"]])

    sea, orientation, drowned = [], "none", 0.0
    if coast:
        closed, open_chains = join_paths(coast)
        # A closed coastline ring inside the window is an island; none of the
        # five extents has one, so it is reported rather than carved out.
        report["coast islands skipped"] += len(closed)
        chains = []
        for chain in open_chains:
            for run in clip_polyline(chain, rect):
                run = simplify_polyline(dedupe(run), tol)
                if len(run) < 2:
                    continue
                if not (_near_boundary(run[0], rect) and _near_boundary(run[-1], rect)):
                    # A loose end inside the window is an OSM data gap; it
                    # cannot take part in a boundary closure.
                    report["loose coast chains"] += 1
                    continue
                run[0] = _snap_rect(run[0], rect)
                run[-1] = _snap_rect(run[-1], rect)
                chains.append(run)
        if chains:
            candidates = []
            for cw in (True, False):
                rings = close_sea(chains, rect, cw)
                candidates.append((buildings_in_rings(centroids, rings), cw, rings))
            candidates.sort(key=lambda c: c[0])
            drowned, cw, sea = candidates[0]
            orientation = "cw" if cw else "ccw"
    return [inland, sea], orientation, drowned, report


def mesh_from_rings(groups):
    # One shared vertex/index buffer; splits record where each group's indices
    # end so the client can style the groups apart. Triangle order is reversed
    # relative to the plane's counterclockwise: our z axis runs north, and in
    # three.js's y-up frame the reversed order is what faces the camera from
    # above. Returns the area put into triangles versus the area of the rings,
    # a conservation check on the triangulation.
    verts, indices, splits = [], [], []
    dropped = 0
    ring_area = 0.0
    tri_area = 0.0
    for rings in groups:
        for ring in rings:
            tris = triangulate(ring)
            if tris is None:
                dropped += 1
                continue
            base = len(verts)
            verts.extend(ring)
            ring_area += abs(signed_area(ring))
            for a, b, c in tris:
                indices.extend((base + a, base + c, base + b))
                tri_area += abs((ring[b][0] - ring[a][0]) * (ring[c][1] - ring[a][1])
                                - (ring[b][1] - ring[a][1]) * (ring[c][0] - ring[a][0])) * 0.5
        splits.append(len(indices))
    return verts, indices, splits, dropped, ring_area, tri_area


def pack_roads(lines, tiers):
    counts = [len(line) for line in lines]
    total = sum(counts)
    buffer = bytearray(struct.pack("<2I", len(lines), total))
    if counts:
        buffer += struct.pack(f"<{len(counts)}I", *counts)
        flat = []
        for line in lines:
            for x, z in line:
                flat.extend((x, z))
        buffer += struct.pack(f"<{2 * total}f", *flat)
        buffer += struct.pack(f"<{len(tiers)}B", *tiers)
    return bytes(buffer)


def pack_mesh(verts, indices, split):
    buffer = bytearray(struct.pack("<3I", len(verts), len(indices), split))
    if verts:
        flat = []
        for x, z in verts:
            flat.extend((x, z))
        buffer += struct.pack(f"<{len(flat)}f", *flat)
    if indices:
        buffer += struct.pack(f"<{len(indices)}I", *indices)
    return bytes(buffer)


def read_centroids(path):
    with open(path, "rb") as handle:
        data = handle.read()
    n = len(data) // (4 * STRIDE)
    values = struct.unpack(f"<{n * STRIDE}f", data)
    return [(values[i * STRIDE], values[i * STRIDE + 1]) for i in range(n)]


def core_radius(centroids, q=CORE_QUANTILE):
    # Mirror of coreRadius in cityData.ts, including its rounding, so the clip
    # window follows the exact world scale the client derives from this file.
    ds = sorted(math.hypot(x, z) for x, z in centroids)
    k = min(len(ds) - 1, max(0, int(q * (len(ds) - 1) + 0.5)))
    return max(ds[k], 1.0)


def clip_rect(bbox, core_r, mult):
    south, west, north, east = bbox
    lat0, lon0 = (south + north) / 2, (west + east) / 2
    xw, zs = project(south, west, lat0, lon0)
    xe, zn = project(north, east, lat0, lon0)
    half = mult * core_r
    return (max(xw, -half), max(zs, -half), min(xe, half), min(zn, half))


def write_debug_svg(path, rect, drawn, centroids):
    # The layers in plan under the building centroids: a ten-second visual
    # audit before committing. Lives in the cache, never shipped.
    xmin, zmin, xmax, zmax = rect
    w, h = xmax - xmin, zmax - zmin
    dot = max(2.0, w / 500)
    road_w = (dot * 3, dot * 2, dot)

    def pt(p):
        return f"{p[0] - xmin:.1f},{zmax - p[1]:.1f}"

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.0f} {h:.0f}">',
        f'<rect width="{w:.0f}" height="{h:.0f}" fill="#f5f3ee"/>',
    ]
    fills = {("green", 0): "#c2d4a8", ("green", 1): "#9cb587",
             ("water", 0): "#a9c7dc", ("water", 1): "#93b9d4"}
    for key in ("green", "water"):
        for ring, kind in drawn.get(key, ()):
            points = " ".join(pt(p) for p in ring)
            parts.append(f'<polygon points="{points}" fill="{fills[(key, kind)]}"/>')
    for line, tier in drawn.get("roads", ()):
        points = " ".join(pt(p) for p in line)
        parts.append(f'<polyline points="{points}" fill="none" stroke="#7a7468" '
                     f'stroke-width="{road_w[tier]:.1f}"/>')
    for x, z in centroids:
        parts.append(f'<circle cx="{x - xmin:.1f}" cy="{zmax - z:.1f}" r="{dot:.1f}" '
                     f'fill="#2b2b2b" fill-opacity="0.45"/>')
    parts.append("</svg>")
    with open(path, "w") as handle:
        handle.write("\n".join(parts))


def _report_str(report):
    return ", ".join(f"{count} {label}" for label, count in sorted(report.items()) if count)


def run_layers(args, cities, out_dir):
    layers = [name.strip() for name in args.layers.split(",") if name.strip()]
    unknown = [name for name in layers if name not in LAYER_NAMES]
    if unknown:
        raise SystemExit(f"unknown layer(s): {', '.join(unknown)}; choose from {', '.join(LAYER_NAMES)}")

    manifest_path = os.path.join(out_dir, "manifest.json")
    if not os.path.exists(manifest_path):
        raise SystemExit("manifest.json not found; run the buildings build first")
    with open(manifest_path) as handle:
        manifest = json.load(handle)
    by_slot = {entry["slot"]: entry for entry in manifest["cities"]}
    cache_dir = os.path.abspath(args.cache_dir)

    for city in cities:
        slot = city["slot"]
        bin_path = os.path.join(out_dir, f"{slot}.bin")
        if slot not in by_slot or not os.path.exists(bin_path):
            raise SystemExit(f"{slot} has no built massing; run the buildings build first")
        centroids = read_centroids(bin_path)
        core = core_radius(centroids)
        rect = clip_rect(city["bbox"], core, args.clip_mult)
        south, west, north, east = city["bbox"]
        lat0, lon0 = (south + north) / 2, (west + east) / 2
        print(f"{slot} ({city['id']}): core radius {core:.0f} m, "
              f"clip window {rect[2] - rect[0]:.0f} x {rect[3] - rect[1]:.0f} m")

        drawn = {}
        entries = {}
        for layer in layers:
            payload, cached = fetch_layer(city, layer, cache_dir, args.refetch)
            if not cached:
                time.sleep(1.5)  # politeness toward the public Overpass servers
            src = "cache" if cached else "overpass"

            if layer == "roads":
                lines, tiers, report = build_roads(payload, lat0, lon0, rect, args.simplify_roads)
                data = pack_roads(lines, tiers)
                drawn["roads"] = list(zip(lines, tiers))
                entries["roads"] = {
                    "file": f"{slot}.roads.bin", "lines": len(lines),
                    "vertices": sum(len(line) for line in lines), "bytes": len(data),
                }
                note = _report_str(report)
                print(f"  roads ({src}): {len(lines)} lines, "
                      f"{entries['roads']['vertices']} pts, {len(data) / 1024:.0f} KB"
                      + (f" ({note})" if note else ""))
            elif layer == "green":
                groups, report = build_green(payload, lat0, lon0, rect,
                                             args.simplify_areas, args.min_area)
                verts, indices, splits, dropped, ra, ta = mesh_from_rings(groups)
                if dropped:
                    report["failed triangulations"] += dropped
                data = pack_mesh(verts, indices, splits[0])
                drawn["green"] = [(r, k) for k, rings in enumerate(groups) for r in rings]
                entries["green"] = {
                    "file": f"{slot}.green.bin", "vertices": len(verts),
                    "triangles": len(indices) // 3, "split": splits[0], "bytes": len(data),
                }
                note = _report_str(report)
                print(f"  green ({src}): {sum(len(g) for g in groups)} areas, "
                      f"{len(indices) // 3} tris, {len(data) / 1024:.0f} KB"
                      + (f" ({note})" if note else ""))
                if ra > 0 and abs(ta / ra - 1) > 0.01:
                    print(f"  green WARNING: triangulated area is {ta / ra:.3f} of ring area")
            else:
                groups, orientation, drowned, report = build_water(
                    payload, lat0, lon0, rect, args.simplify_areas, args.min_area, centroids)
                verts, indices, splits, dropped, ra, ta = mesh_from_rings(groups)
                if dropped:
                    report["failed triangulations"] += dropped
                data = pack_mesh(verts, indices, splits[0])
                drawn["water"] = ([(r, WATER_INLAND) for r in groups[0]]
                                  + [(r, WATER_SEA) for r in groups[1]])
                entries["water"] = {
                    "file": f"{slot}.water.bin", "vertices": len(verts),
                    "triangles": len(indices) // 3, "split": splits[0],
                    "sea_rings": len(groups[1]), "orientation": orientation,
                    "bytes": len(data),
                }
                note = _report_str(report)
                print(f"  water ({src}): {len(groups[0])} inland, {len(groups[1])} sea rings "
                      f"({orientation}), {len(indices) // 3} tris, {len(data) / 1024:.0f} KB"
                      + (f" ({note})" if note else ""))
                if ra > 0 and abs(ta / ra - 1) > 0.01:
                    print(f"  water WARNING: triangulated area is {ta / ra:.3f} of ring area")
                if drowned > 0.02:
                    print(f"  water WARNING: {drowned:.1%} of buildings fall inside water; "
                          f"check the debug overlay before committing")

            with open(os.path.join(out_dir, entries[layer]["file"]), "wb") as handle:
                handle.write(data)

        # Manifest and overlay written per city, so an interrupted run leaves
        # every finished city complete.
        by_slot[slot].setdefault("layers", {}).update(entries)
        with open(manifest_path, "w") as handle:
            json.dump(manifest, handle, indent=2)
        svg_path = os.path.join(cache_dir, f"{city['id']}.layers.svg")
        os.makedirs(cache_dir, exist_ok=True)
        write_debug_svg(svg_path, rect, drawn, centroids)
        print(f"  debug overlay: {svg_path}")


def _read_footprints(data):
    # Walk c{i}.footprints.bin back into (rings, heights, areas, floors, classes),
    # the same order the web loader will. Kept here as the reference reader and the
    # check that the writer consumes exactly the bytes it wrote.
    off = 0
    building_count, vertex_total = struct.unpack_from("<II", data, off)
    off += 8
    ring_lengths = struct.unpack_from(f"<{building_count}I", data, off)
    off += 4 * building_count
    if sum(ring_lengths) != vertex_total:
        raise ValueError(f"ring lengths sum to {sum(ring_lengths)}, header says {vertex_total}")
    coords = struct.unpack_from(f"<{2 * vertex_total}f", data, off)
    off += 8 * vertex_total
    heights = struct.unpack_from(f"<{building_count}f", data, off)
    off += 4 * building_count
    areas = struct.unpack_from(f"<{building_count}f", data, off)
    off += 4 * building_count
    floors = struct.unpack_from(f"<{building_count}f", data, off)
    off += 4 * building_count
    classes = struct.unpack_from(f"<{building_count}B", data, off)
    off += building_count
    if off != len(data):
        raise ValueError(f"consumed {off} of {len(data)} bytes")

    rings = []
    at = 0
    for length in ring_lengths:
        rings.append([(coords[at + 2 * k], coords[at + 2 * k + 1]) for k in range(length)])
        at += 2 * length
    return rings, heights, areas, floors, classes


def _self_test():
    # Pack a hand-built city through the writer and read it back, no network. The
    # cases exercise the three things that can silently corrupt a ring: a clockwise
    # winding (must come back counter-clockwise), a doubled vertex (must dedupe),
    # and a building under the filters (must be dropped).
    def to_geometry(lat0, lon0, ring_m):
        # Inverse of project(), so the synthetic meters land back where we put them.
        cos_lat = math.cos(math.radians(lat0))
        return [{"lat": lat0 + z / 111132.0, "lon": lon0 + x / (111320.0 * cos_lat)}
                for x, z in ring_m]

    lat0, lon0 = 59.436, 24.755  # anywhere; the projection cancels out
    rect = [(-6, -4), (6, -4), (6, 4), (-6, 4), (-6, -4)]           # ccw, 12 x 8 m
    ell = [(0, 0), (0, 10), (0, 10), (6, 10), (6, 6), (10, 6), (10, 0), (0, 0)]  # cw, doubled point
    sliver = [(0, 0), (1, 0), (1, 0.2), (0, 0.2), (0, 0)]           # 0.2 m2, dropped
    payload = {"elements": [
        {"tags": {"building": "apartments", "building:levels": "5"},
         "geometry": to_geometry(lat0, lon0, rect)},
        {"tags": {"building": "office", "height": "24"},
         "geometry": to_geometry(lat0, lon0, ell)},
        {"tags": {"building": "yes"},
         "geometry": to_geometry(lat0, lon0, sliver)},
    ]}
    bbox = (lat0 - 0.01, lon0 - 0.01, lat0 + 0.01, lon0 + 0.01)

    blocks, footprints = extract_blocks(payload, bbox)
    data = pack_footprints(footprints)
    rings, heights, areas, floors, classes = _read_footprints(data)

    assert len(footprints) == 2, f"expected 2 kept buildings, got {len(footprints)}"
    assert len(blocks) == len(footprints), "boxes and footprints fell out of lockstep"
    for src, ring in zip(footprints, rings):
        assert len(src.ring) == len(ring), "ring length changed across the file"
        for (sx, sz), (rx, rz) in zip(src.ring, ring):
            assert abs(sx - rx) < 1e-3 and abs(sz - rz) < 1e-3, "ring coordinates moved"
        assert signed_area(ring) > 0, "ring came back clockwise"
    assert sorted(len(r) for r in rings) == [4, 6], "dedupe did not collapse the doubled vertex"
    print(f"self-test ok: {len(footprints)} buildings, {sum(len(r) for r in rings)} vertices, "
          f"{len(data)} bytes, every byte consumed, winding and dedupe correct")


def main():
    parser = argparse.ArgumentParser(description="Build city massing data for the hero.")
    default_out = os.path.join(os.path.dirname(__file__), "..", "public", "data", "cities")
    parser.add_argument("--out", default=default_out, help="output directory")
    parser.add_argument(
        "--n", type=int, default=2400,
        help="maximum blocks per city; the run lowers this to the smallest city so no building is duplicated",
    )
    parser.add_argument("--city", help="build only this internal city id")
    parser.add_argument(
        "--layers",
        help="comma list from roads,green,water: fetch ground layers instead of buildings",
    )
    parser.add_argument("--clip-mult", type=float, default=CLIP_MULT,
                        help="layer clip window as a multiple of the city core radius")
    parser.add_argument("--simplify-roads", type=float, default=SIMPLIFY_ROADS_M,
                        help="road simplification tolerance in meters")
    parser.add_argument("--simplify-areas", type=float, default=SIMPLIFY_AREAS_M,
                        help="area simplification tolerance in meters")
    parser.add_argument("--min-area", type=float, default=MIN_AREA_M2,
                        help="smallest kept green or water area in square meters")
    parser.add_argument("--cache-dir",
                        default=os.path.join(os.path.dirname(__file__), "cache"),
                        help="directory for raw Overpass responses and debug overlays")
    parser.add_argument("--refetch", action="store_true",
                        help="ignore cached Overpass responses")
    parser.add_argument("--self-test", action="store_true",
                        help="pack a synthetic city through the footprint writer, read it back, and exit")
    args = parser.parse_args()

    if args.self_test:
        _self_test()
        return

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)

    selected = [c for c in CITIES if not args.city or c["id"] == args.city]
    if not selected:
        raise SystemExit(f"Unknown city '{args.city}'")

    if args.layers:
        run_layers(args, selected, out_dir)
        return

    cache_dir = os.path.abspath(args.cache_dir)

    # First pass: fetch (or load from cache) and reduce every selected city,
    # keeping full resolution for both the boxes and the real footprints.
    prepared = []
    for city in selected:
        print(f"fetching {city['slot']} ({city['id']}) ...")
        blocks, footprints, cached = fetch_city(city, cache_dir, args.refetch)
        if not cached:
            time.sleep(1.5)  # politeness toward the public Overpass servers
        print(f"  {len(blocks)} usable buildings ({'cache' if cached else 'overpass'})")
        prepared.append((city, blocks, footprints))

    # One shared block count for the boxes. Capping at the smallest city means
    # resampling only thins and never repeats a building, so nothing stacks into a
    # false overlap. The footprints are never resampled; each city keeps them all.
    raw_min = min(len(b) for _, b, _ in prepared)
    n = min(args.n, raw_min)
    if n < args.n:
        print(f"note: smallest city has {raw_min} buildings, so n={n} is used for every city to avoid duplicates")

    # Second pass: resample the boxes, write both files per city, and report.
    built = {}
    for city, blocks, footprints in prepared:
        sampled, stats = finalize(blocks, n)
        box_name = f"{city['slot']}.bin"
        with open(os.path.join(out_dir, box_name), "wb") as handle:
            handle.write(pack(sampled))

        fp_data = pack_footprints(footprints)
        fp_name = f"{city['slot']}.footprints.bin"
        with open(os.path.join(out_dir, fp_name), "wb") as handle:
            handle.write(fp_data)
        fp_block = {
            "file": fp_name,
            "buildings": len(footprints),
            "vertices": sum(len(f.ring) for f in footprints),
            "bytes": len(fp_data),
        }

        mix = ", ".join(f"{label} {count}" for label, count in stats["classes"].items() if count)
        print(
            f"{city['slot']}: {stats['count']} blocks (of {stats['raw_count']} real), "
            f"radius {stats['radius_m']} m, tallest {stats['maxHeight_m']} m"
        )
        print(f"   footprints: {fp_block['buildings']} buildings, "
              f"{fp_block['vertices']} vertices, {len(fp_data) / 1024:.0f} KB")
        print(f"   class mix: {mix}")
        built[city["slot"]] = ({"slot": city["slot"], "file": box_name, **stats}, fp_block)

    # Merge into the existing manifest rather than authoring it fresh, so a rebuild
    # keeps each city's ground-layer block (roads, green, water); the buildings pass
    # never touches those files. A full run rewrites every selected city's entry in
    # list order; a single --city run updates only that city and leaves the rest,
    # the same in-place edit the layers build makes.
    manifest_path = os.path.join(out_dir, "manifest.json")
    if os.path.exists(manifest_path):
        with open(manifest_path) as handle:
            manifest = json.load(handle)
    else:
        manifest = {"n": n, "stride": STRIDE, "fields": list(Block._fields),
                    "classes": CLASS_LABELS, "cities": []}

    manifest["stride"] = STRIDE
    manifest["fields"] = list(Block._fields)
    manifest["classes"] = CLASS_LABELS
    # n scopes the boxes only. A single city cannot know the shared count the other
    # four were written with, so it leaves the top-level n as it found it.
    if not args.city:
        manifest["n"] = n

    entries = {entry["slot"]: entry for entry in manifest["cities"]}
    for slot, (stats_entry, fp_block) in built.items():
        entry = dict(entries.get(slot, {}))  # keep an existing layers block if present
        entry.update(stats_entry)
        entry["footprints"] = fp_block
        entries[slot] = entry

    if args.city:
        order = [entry["slot"] for entry in manifest["cities"]]
        for slot in built:
            if slot not in order:
                order.append(slot)
    else:
        order = [city["slot"] for city in selected]
    manifest["cities"] = [entries[slot] for slot in order]

    with open(manifest_path, "w") as handle:
        json.dump(manifest, handle, indent=2)
    if args.city:
        print(f"updated {args.city} in {manifest_path}")
    else:
        print(f"wrote manifest with {len(manifest['cities'])} cities to {out_dir}")


if __name__ == "__main__":
    main()
