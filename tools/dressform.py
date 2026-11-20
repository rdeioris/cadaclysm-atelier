"""Atelier dress forms built with the cadaclysm blacksmith kernel, graded from a size chart.

Exact B-rep: the torso is a loft through elliptical sections, the thigh stubs are lofts,
the robotic arms are frustum lofts with sphere joints, the neck cap and stand are extrusions,
all joined into solids. The kernel meshes them; out come STEP (exact) and STL (the collider).
Units mm, Y up, facing +Z, floor at y = 0, centred on x = 0 -- CLO's frame.

Grading: each size has its own bust (chest), waist, hip, neck and shoulder measurements and a
height. The torso's landmark sections are scaled so their ellipse girth equals the chart, the
sections between blend their neighbours' factors, and the torso stretches with height above the
thigh cut. Bigger waists grow more in depth than in width (the belly).

    CADACLYSM_BS_PY=<folder holding cadaclysm_blacksmith.py> \
    CADACLYSM_BLACKSMITH_LIBRARY=.../cadaclysm_blacksmith.dll \
    python tools/dressform.py out_dir --style {form,arms} --body {female,male} --size {XS,S,M,L,XL} \
        [--head] [--name STEM] [--label TEXT] [--forms forms.json] [--forms-only]
"""
import argparse
import math
import os
import struct
import sys
import time

import numpy as np

if not os.environ.get("CADACLYSM_BS_PY"):
    sys.exit("set CADACLYSM_BS_PY to the folder holding the blacksmith kernel's cadaclysm_blacksmith.py")
sys.path.insert(0, os.environ["CADACLYSM_BS_PY"])
from cadaclysm_blacksmith import Frame, Profile, Solid, write_step  # noqa: E402

# Base torso sections (y, half-width a along x, half-depth b along z, z offset of the centre), and
# what each section follows when graded: a mix of the chart's girths (weights sum to 1).
HIP, WAIST, BUST, SHOULDER, NECK = "hip", "waist", "bust", "shoulder", "neck"
FEMALE = [
    ((700, 60, 46, -8), {HIP: 1}), ((750, 130, 96, -8), {HIP: 1}), ((800, 168, 120, -9), {HIP: 1}),
    ((880, 177, 126, -10), {HIP: 1}), ((960, 160, 112, -6), {HIP: .5, WAIST: .5}),
    ((1060, 126, 90, 0), {WAIST: 1}), ((1170, 136, 102, 6), {WAIST: .45, BUST: .55}),
    ((1235, 158, 124, 14), {BUST: 1}), ((1295, 163, 110, 4), {BUST: .6, SHOULDER: .4}),
    ((1350, 168, 92, -6), {SHOULDER: 1}), ((1395, 140, 70, -10), {SHOULDER: .7, NECK: .3}),
    ((1425, 62, 56, -8), {NECK: 1}), ((1480, 52, 52, -4), {NECK: 1}),
]
MALE = [
    ((700, 60, 46, -6), {HIP: 1}), ((750, 132, 96, -6), {HIP: 1}), ((800, 170, 114, -6), {HIP: 1}),
    ((880, 178, 120, -6), {HIP: 1}), ((960, 166, 114, -4), {HIP: .5, WAIST: .5}),
    ((1060, 150, 110, 0), {WAIST: 1}), ((1170, 160, 118, 4), {WAIST: .45, BUST: .55}),
    ((1250, 175, 128, 6), {BUST: 1}), ((1300, 180, 120, 2), {BUST: .6, SHOULDER: .4}),
    ((1360, 186, 100, -4), {SHOULDER: 1}), ((1405, 152, 76, -8), {SHOULDER: .7, NECK: .3}),
    ((1440, 70, 64, -6), {NECK: 1}), ((1490, 60, 58, -4), {NECK: 1}),
]
LANDMARK = {HIP: 3, WAIST: 5, BUST: 7, NECK: 12}   # the section whose girth is the chart's

SIZES = ["XS", "S", "M", "L", "XL"]
# Body measurements in cm (girths; shoulder = across the back, point to point; height in cm).
CHART = {
    "female": {
        "bust":     [80, 86, 92, 100, 108],
        "waist":    [62, 68, 74, 82, 91],
        "hip":      [88, 94, 100, 107, 114],
        "neck":     [32, 33.5, 35, 36.5, 38],
        "shoulder": [37, 38.5, 40, 41.5, 43],
        "height":   [160, 164, 168, 171, 174],
    },
    "male": {
        "bust":     [86, 94, 102, 110, 119],
        "waist":    [72, 80, 88, 97, 107],
        "hip":      [88, 95, 102, 109, 116],
        "neck":     [36, 38, 40, 42, 44],
        "shoulder": [43, 45, 47, 49, 51],
        "height":   [170, 175, 180, 184, 188],
    },
}
THIGH_CUT = 640


def ellipse_girth(a, b):
    """Ramanujan's ellipse perimeter."""
    return math.pi * (3 * (a + b) - math.sqrt((3 * a + b) * (a + 3 * b)))


class Grade:
    """The factors that take the base sections to one size of the chart."""

    def __init__(self, body, size):
        base = FEMALE if body == "female" else MALE
        chart = CHART[body]
        i, m = SIZES.index(size), SIZES.index("M")
        self.body, self.size, self.chart = body, size, {k: v[i] for k, v in chart.items()}
        self.f = {}
        for k, idx in LANDMARK.items():
            (_, a, b, _), _w = base[idx]
            self.f[k] = self.chart[k] * 10 / ellipse_girth(a, b)
        # Shoulder width has no girth; grade it against the chart's M.
        self.f[SHOULDER] = chart["shoulder"][i] / chart["shoulder"][m] * self.f[BUST] / (
            chart["bust"][m] * 10 / ellipse_girth(*base[LANDMARK[BUST]][0][1:3]))
        self.h = chart["height"][i] / chart["height"][m]
        # The waist's share of growth goes to depth: b more than a, girth kept.
        wm = chart["waist"][m] * 10 / ellipse_girth(*base[LANDMARK[WAIST]][0][1:3])
        self.belly = (self.f[WAIST] / wm) ** 0.35
        self.sections = []
        for (y, a, b, zc), w in base:
            fa = fb = sum(self.f[k] * v for k, v in w.items())
            wb = w.get(WAIST, 0) * self.belly + (1 - w.get(WAIST, 0))
            fa, fb = fa / math.sqrt(wb), fb * math.sqrt(wb)
            self.sections.append((self.y(y), a * fa, b * fb, zc * fb))

    def y(self, y):
        return THIGH_CUT + (y - THIGH_CUT) * self.h

    def girths(self):
        return {k: ellipse_girth(*self.sections[idx][1:3]) / 10 for k, idx in LANDMARK.items()}


def up_frame(x, y, z):
    """A horizontal section plane at height y: profile x along world X, profile y along -Z,
    built along +Y."""
    return Frame((x, y, z), (1, 0, 0), (0, 0, -1), (0, 1, 0))


def along(origin, d):
    """A plane through origin square to direction d (the build direction)."""
    return Frame.at(tuple(float(c) for c in origin), tuple(float(c) for c in d))


def torso(gr):
    secs = [(Profile.ellipse((0, 0), a, b), up_frame(0, y, zc)) for y, a, b, zc in gr.sections]
    return Solid.loft_through(secs)


def thigh(s, gr):
    """A thigh stub from the flat cut up into the hip, leaning in slightly."""
    k = gr.f[HIP] / Grade(gr.body, "M").f[HIP]
    secs = []
    for y, r, x in [(THIGH_CUT, 74, 96), (720, 86, 92), (800, 96, 86), (860, 92, 78)]:
        secs.append((Profile.ellipse((0, 0), r * k, r * k * 0.96), up_frame(s * x * k, gr.y(y), -6)))
    return Solid.loft_through(secs)


def frustum(a, b, ra, rb):
    a, b = np.asarray(a, float), np.asarray(b, float)
    d = b - a
    return Solid.loft(Profile.circle(ra), along(a, d), Profile.circle(rb), along(b, d))


def ball(c, r):
    return Solid.sphere(r).translate(*map(float, c))


def unit(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v)


def arm(s, gr):
    """Robotic arm: shoulder ball, upper arm, elbow ball, forearm, wrist ball, mitten hand.
    Lengths follow height, thickness follows the bust girth, the shoulder point the chart."""
    m = Grade(gr.body, "M")
    t = math.sqrt(gr.f[BUST] / m.f[BUST])        # limb girth grows slower than the bust
    L = gr.h
    sh_x = (182 if gr.body == "female" else 196) * gr.f[SHOULDER] / m.f[SHOULDER]
    d = unit([s * math.sin(math.radians(42)), -math.cos(math.radians(42)), 0.08])
    sh = np.array([s * sh_x, gr.y(1352.0), -8.0])
    el = sh + d * 280 * L
    wr = el + d * 245 * L
    return [
        ball(sh, 50 * t),
        frustum(sh + d * 40 * t, el - d * 30 * t, 44 * t, 35 * t),
        ball(el, 38 * t),
        frustum(el + d * 30 * t, wr - d * 22 * t, 33 * t, 26 * t),
        ball(wr, 28 * t),
        hand(wr + d * 18 * t, d, s, L, t),
    ]   # rigid segments; joined into one solid per arm unless --separate-arms


def joined(parts):
    out = parts[0]
    for p in parts[1:]:
        out = out.join(p)
    return out


def hand(w0, d, s, L, t):
    """A mitten: a loft through flattened ellipses, wrist to fingertips, palm toward the body."""
    n = unit(np.cross(d, [0, 0, 1])) if s > 0 else unit(np.cross([0, 0, 1], d))   # palm normal
    wdir = unit(np.cross(n, d))
    secs = []
    for u, half_w, half_t in [(0, 26, 18), (40, 40, 17), (95, 42, 14), (150, 34, 11), (175, 18, 8)]:
        o = w0 + d * u * L
        f = Frame(tuple(o), tuple(wdir), tuple(n), tuple(np.cross(wdir, n)))
        secs.append((Profile.ellipse((0, 0), half_w * t, half_t * t), f))
    return Solid.loft_through(secs)


def neck_cap(gr):
    y, a, _b, _zc = gr.sections[-1]
    cap = Solid.extrude(Profile.circle(a + 4), up_frame(0, y - 1, -4), 9)
    stem = Solid.extrude(Profile.circle(9), up_frame(0, y + 7, -4), 24)
    knob = ball((0, y + 36, -4), 15)
    return cap.join(stem).join(knob)


# The head over the neck: (dy above the neck's top section, half-width a, half-depth b, z
# centre) for the female M, from inside the neck to the crown. The chin section (index 2) sits
# forward; the widest, at eye level (index 4), is 150 mm wide and 190 mm deep; the chin is at
# 1520 and the crown at 1745 (225 mm chin to crown).
HEAD = [
    (-12, 46, 46, -4), (22, 52, 58, 0), (40, 62, 82, 16), (85, 72, 94, 12),
    (150, 75, 95, 4), (205, 70, 90, -2), (245, 50, 66, -6), (265, 17, 22, -8),
]


def head_scale(gr):
    """Heights follow the chart's height; widths the neck girth, gently."""
    m = Grade(gr.body, "M")
    return gr.h, math.sqrt(gr.f[NECK] / m.f[NECK])


def head(gr):
    """An egg-shaped loft with a chin, its first section inside the neck so it joins."""
    y0 = gr.sections[-1][0]
    hy, k = head_scale(gr)
    secs = [(Profile.ellipse((0, 0), a * k, b * k), up_frame(0, y0 + dy * hy, zc * k))
            for dy, a, b, zc in HEAD]
    return Solid.loft_through(secs)


def neck_ring(gr):
    """The neck cap's disc alone: the head carries no stem or knob."""
    y, a, _b, _zc = gr.sections[-1]
    return Solid.extrude(Profile.circle(a + 4), up_frame(0, y - 1, -4), 9)


def landmarks(gr, name, label, with_head):
    """What the app places pieces by: the body's top (the knob's top, as f-M's bounds), the
    shoulder line, each arm's shoulder joint, direction and ball radius, and the head."""
    m = Grade(gr.body, "M")
    t = math.sqrt(gr.f[BUST] / m.f[BUST])
    sh_x = (182 if gr.body == "female" else 196) * gr.f[SHOULDER] / m.f[SHOULDER]
    r3 = lambda v: [round(float(c), 4) for c in v]
    arms = []
    for s, side in ((1, "left"), (-1, "right")):
        d = unit([s * math.sin(math.radians(42)), -math.cos(math.radians(42)), 0.08])
        arms.append({"side": side, "shoulder": r3([s * sh_x, gr.y(1352.0), -8.0]),
                     "dir": [float(c) for c in d], "radius": round(50 * t, 4)})
    y0 = gr.sections[-1][0]
    out = {"name": name, "label": label, "file": name + ".stp", "body_top": round(y0 + 51, 4),
           "hps_y": round(gr.sections[11][0], 4), "arms": arms}
    if with_head:
        hy, k = head_scale(gr)
        top, chin = y0 + HEAD[-1][0] * hy, y0 + HEAD[2][0] * hy
        out["head"] = {"centre": [0.0, round(y0 + HEAD[4][0] * hy, 4), round(HEAD[4][3] * k, 4)],
                       "half": [round(HEAD[4][1] * k, 4), round((top - chin) / 2, 4),
                                round(HEAD[4][2] * k, 4)],
                       "top": round(top, 4), "chin_y": round(chin, 4)}
    return out


def write_forms(path, entry):
    """Merge one form into forms.json by name, the list kept sorted by name."""
    import json
    forms = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            forms = json.load(f)["forms"]
    forms = sorted([f for f in forms if f["name"] != entry["name"]] + [entry], key=lambda f: f["name"])
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"forms": forms}, f, indent=1)
        f.write("\n")


def stand():
    pole = Solid.extrude(Profile.circle(13), up_frame(0, 10, -6), THIGH_CUT + 110)
    collar = Solid.extrude(Profile.circle(22), up_frame(0, THIGH_CUT - 42, -6), 44)
    base = Solid.extrude(Profile.rect(300, 300), up_frame(0, 0, -6), 12)
    return [base.join(pole).join(collar)]


def write_stl(path, solids, tol):
    tris = []
    for s in solids:
        pos, _nrm, idx = s.mesh(tolerance=tol)
        p = np.asarray(pos, np.float64).reshape(-1, 3)
        tris.append(p[np.asarray(idx).reshape(-1, 3)])
    t = np.concatenate(tris).astype(np.float32)
    n = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-30)
    rec = np.zeros(len(t), dtype=[("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")])
    rec["n"], rec["v"] = n, t
    with open(path, "wb") as f:
        f.write(b"cadaclysm blacksmith dress form".ljust(80, b" "))
        f.write(struct.pack("<I", len(t)))
        f.write(rec.tobytes())
    return len(t)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out_dir")
    ap.add_argument("--style", choices=["form", "arms"], default="arms")
    ap.add_argument("--body", choices=["female", "male"], default="female")
    ap.add_argument("--size", choices=SIZES, default="M")
    ap.add_argument("--tolerance", type=float, default=0.4)
    ap.add_argument("--separate-arms", action="store_true",
                    help="keep each arm segment its own solid (kernels before the sphere-loft join fix)")
    ap.add_argument("--head", action="store_true", help="a head on the neck (an egg loft with a chin)")
    ap.add_argument("--name", help="the file stem (default <body>-<size>-<style>[-head])")
    ap.add_argument("--label", help="the name the app shows (default the stem)")
    ap.add_argument("--forms", help="merge this form's landmarks into this forms.json")
    ap.add_argument("--forms-only", action="store_true", help="write the landmarks only: no STEP, no STL")
    o = ap.parse_args()
    gr = Grade(o.body, o.size)
    name = o.name or f"{o.body[0]}-{o.size}-{o.style}" + ("-head" if o.head else "")
    if o.forms:
        write_forms(o.forms, landmarks(gr, name, o.label or name, o.head))
        print(f"{o.forms}: {name}")
    if o.forms_only:
        return
    t0 = time.time()
    form = torso(gr)
    for s in (1, -1):
        form = form.join(thigh(s, gr))
    solids = [form]
    if o.head:
        form = form.join(neck_ring(gr))
        try:
            solids = [form.join(head(gr))]
        except Exception as e:     # the kernel refused the loft-to-loft join: the head as its own solid
            print(f"head not joined ({e}); written as its own solid")
            solids = [form, head(gr)]
    else:
        solids = [form.join(neck_cap(gr))]
    if o.style == "arms":
        for s in (1, -1):
            parts = arm(s, gr)
            solids += parts if o.separate_arms else [joined(parts)]
    solids += stand()
    os.makedirs(o.out_dir, exist_ok=True)
    write_step(os.path.join(o.out_dir, name + ".stp"), solids)
    n = write_stl(os.path.join(o.out_dir, name + ".stl"), solids, o.tolerance)
    g = gr.girths()
    print(f"{name}: bust {g[BUST]:.1f} waist {g[WAIST]:.1f} hip {g[HIP]:.1f} neck {g[NECK]:.1f} cm, "
          f"{len(solids)} solids, {n} triangles, {time.time() - t0:.1f} s")


if __name__ == "__main__":
    main()
