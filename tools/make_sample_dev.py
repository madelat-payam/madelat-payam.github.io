"""Sandbox-only generator of a synthetic four-city sample in the real format.

Not part of the website and not committed. It fabricates four distinct dense
layouts so the Three.js engine can be developed and previewed before the real
Overpass pipeline runs. It reuses the real pipeline's Block, Morton sort,
resample, and pack, so the bytes match production shape exactly, including the
raw fields the client colors by (area, floors, class).
"""

import json
import math
import os
import random

import build_cities as bc

OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "public", "data", "cities"))
N = 3000

# Rough class mixes per city so the color metrics have something to separate:
# the European cores lean residential with some commercial and civic, the last
# city leans office and commercial. Values are (class_code, weight).
RESIDENTIAL_MIX = [(1, 3), (2, 4), (4, 2), (7, 1), (0, 2)]
DOWNTOWN_MIX = [(3, 4), (4, 3), (2, 2), (7, 1), (5, 1)]


def pick_class(rng, mix):
    codes, weights = zip(*mix)
    return rng.choices(codes, weights=weights, k=1)[0]


def finalize(raw):
    blocks = []
    for x, z, w, d, angle, height, area, floors, cls in raw:
        blocks.append(bc.Block(x, z, w, d, angle, height, area, floors, cls))

    xs = [b.x for b in blocks]
    zs = [b.z for b in blocks]
    min_x, max_x = min(xs), max(xs)
    min_z, max_z = min(zs), max(zs)
    span_x = max(max_x - min_x, 1.0)
    span_z = max(max_z - min_z, 1.0)
    blocks.sort(key=lambda b: bc.morton((b.x - min_x) / span_x, (b.z - min_z) / span_z))
    blocks = bc.resample(blocks, N)

    distances = [math.hypot(b.x, b.z) for b in blocks]
    stats = {
        "count": len(blocks),
        "radius_m": round(bc.percentile(distances, 0.95), 1),
        "maxHeight_m": round(max(b.height for b in blocks), 1),
    }
    return blocks, stats


def record(rng, x, z, w, d, angle, height, mix):
    floors = max(1, round(height / bc.METERS_PER_LEVEL))
    return (x, z, w, d, angle, height, w * d, floors, pick_class(rng, mix))


def gen_tallinn(rng):
    out = []
    for _ in range(N):
        r = abs(rng.gauss(0, 1)) * 300
        a = rng.uniform(0, 2 * math.pi)
        x, z = r * math.cos(a), r * math.sin(a)
        w, d = rng.uniform(12, 28), rng.uniform(12, 28)
        ang = rng.uniform(0, math.pi)
        core = max(0.0, 1 - r / 620)
        height = rng.uniform(6, 15) + core * rng.uniform(0, 30)
        out.append(record(rng, x, z, w, d, ang, height, RESIDENTIAL_MIX))
    return out


def gen_graz(rng):
    out = []
    step, half = 30, 28
    cells = [(i, j) for i in range(-half, half) for j in range(-half, half)]
    rng.shuffle(cells)
    for i, j in cells[:N]:
        x = i * step + rng.uniform(-4, 4)
        z = j * step + rng.uniform(-4, 4)
        w, d = rng.uniform(18, 38), rng.uniform(18, 32)
        ang = 0.0 if rng.random() < 0.85 else rng.uniform(0, math.pi)
        core = max(0.0, 1 - math.hypot(x, z) / 680)
        height = rng.uniform(9, 19) + core * rng.uniform(0, 22)
        out.append(record(rng, x, z, w, d, ang, height, RESIDENTIAL_MIX))
    return out


def gen_lausanne(rng):
    out = []
    while len(out) < N:
        x = rng.uniform(-680, 680)
        z = rng.uniform(-420, 620)
        if z < -320:
            continue
        w, d = rng.uniform(14, 30), rng.uniform(14, 26)
        ang = rng.uniform(-0.4, 0.4)
        slope = (z + 420) / 1040
        height = rng.uniform(8, 16) + (1 - slope) * rng.uniform(0, 28)
        out.append(record(rng, x, z, w, d, ang, height, RESIDENTIAL_MIX))
    return out


def gen_newyork(rng):
    out = []
    while len(out) < N:
        x = round(rng.uniform(-380, 380) / 24) * 24
        z = round(rng.uniform(-900, 900) / 70) * 70 + rng.uniform(-6, 6)
        if -110 < x < 110 and 120 < z < 640:  # a Central Park style void
            continue
        w, d = rng.uniform(16, 30), rng.uniform(22, 46)
        core = max(0.0, 1 - math.hypot(x, z * 0.4) / 620)
        height = rng.uniform(22, 60) + core * rng.uniform(0, 140)
        if rng.random() < 0.18:
            height += rng.uniform(90, 320) * (0.4 + core)
        out.append(record(rng, x, z, w, d, 0.0, min(height, 430), DOWNTOWN_MIX))
    return out


CITIES = [
    ("c0", gen_tallinn),
    ("c1", gen_graz),
    ("c2", gen_lausanne),
    ("c3", gen_newyork),
]


def main():
    os.makedirs(OUT, exist_ok=True)
    rng = random.Random(7)
    cities_meta = []
    for slot, gen in CITIES:
        blocks, stats = finalize(gen(rng))
        with open(os.path.join(OUT, f"{slot}.bin"), "wb") as handle:
            handle.write(bc.pack(blocks))
        cities_meta.append({"slot": slot, "file": f"{slot}.bin", **stats})
        print(f"{slot}: {stats}")

    manifest = {
        "n": N,
        "stride": bc.STRIDE,
        "fields": list(bc.Block._fields),
        "classes": bc.CLASS_LABELS,
        "note": "SYNTHETIC development sample, replaced by real Overpass data",
        "cities": cities_meta,
    }
    with open(os.path.join(OUT, "manifest.json"), "w") as handle:
        json.dump(manifest, handle, indent=2)
    print("wrote manifest")


if __name__ == "__main__":
    main()
