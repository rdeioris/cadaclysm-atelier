"""The weave library: seamless procedural fabric tiles for the 3D cloth.

    python tools/weaves.py            # writes assets/weaves/<name>-{diffuse,normal,roughness}.png + weaves.json
    python tools/weaves.py --check    # regenerates in memory, compares pixels, runs the checks

Every tile is 512 x 512 and generated from the weave's structure alone (the interlacing of warp
and weft, thread profiles, knit loops, fibre noise), with numpy and Pillow and a fixed seed.
No measured or copied data: every value in weaves.json is labelled "(estimated)".

- Periodic by construction: every lattice is a whole number of repeats in 512 px, and every
  noise is an integer-frequency spectrum (an inverse FFT on the 512 grid).
- diffuse: near-white grey, 0.82 + 0.18 * ambient occlusion from the height (sRGB-encoded).
  The fabric colour is the tint; denim's warp is a little greyer than its weft.
- normal: from the height field by periodic central differences, OpenGL convention (+Y green is
  the image's up), RGB = n * 0.5 + 0.5.
- roughness: glTF layout, R 255, G the roughness (yarn tops a little smoother), B 0.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

N = 512
SEED = 20261125
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "weaves"
EST = "(estimated)"

# name: label, tile_mm, roughness, sheen, sheen_roughness -- all (estimated)
WEAVES = {
    "plain": ("Plain weave", [8, 8], 0.75, "#303030", 0.6),
    "twill": ("Twill 2/1", [10, 10], 0.7, "#303030", 0.5),
    "denim": ("Denim (3/1 twill)", [12, 12], 0.85, "#202020", 0.6),
    "jersey": ("Single jersey knit", [8, 8], 0.8, "#505050", 0.4),
    "rib": ("1x1 rib knit", [10, 10], 0.8, "#404040", 0.5),
    "fleece": ("Fleece (brushed)", [20, 20], 0.95, "#707070", 0.3),
    "satin": ("Satin 4/1", [8, 8], 0.35, "#606060", 0.25),
    "canvas": ("Canvas (2/2 basket)", [12, 12], 0.9, "#202020", 0.7),
}

# pixel centres in [0, 1)
_c = (np.arange(N) + 0.5) / N
X, Y = np.meshgrid(_c, _c)  # X across (columns), Y down (rows)


def periodic_noise(rng, lo, hi, aniso=(1.0, 1.0)):
    """Band-limited noise, periodic on the tile: integer frequencies lo..hi (cycles per tile).
    aniso stretches the band per axis (x, y). Zero mean, unit standard deviation."""
    f = np.fft.fftfreq(N, d=1.0 / N)
    fx, fy = np.meshgrid(f, f)
    r = np.hypot(fx * aniso[0], fy * aniso[1])
    band = ((r >= lo) & (r <= hi)).astype(float) / np.maximum(r, 1.0)
    spec = band * (rng.standard_normal((N, N)) + 1j * rng.standard_normal((N, N)))
    n = np.fft.ifft2(spec).real
    return (n - n.mean()) / (n.std() + 1e-12)


def dome(u, width=0.92):
    """A yarn's cross profile over u in [0, 1): a round top, zero at the yarn's flanks."""
    t = (2.0 * u - 1.0) / width
    return np.sqrt(np.clip(1.0 - t * t, 0.0, 1.0))


def crimp(seq, t):
    """Smooth periodic interpolation of a per-thread sequence (values at t = k + 0.5)."""
    n = len(seq)
    s = t - 0.5
    k = np.floor(s).astype(int)
    f = s - k
    w = 0.5 - 0.5 * np.cos(np.pi * f)
    return seq[k % n] * (1 - w) + seq[(k + 1) % n] * w


def woven(rng, matrix, threads, low=0.55, twist=3, fibre=0.05):
    """Height of a woven cloth from its interlacing matrix (matrix[pick][end] = 1 where the warp
    is on top). Warp runs down the image (along Y), weft across (along X). threads is the count
    of ends and picks per tile, a multiple of the repeat. Returns (height, warp_on_top)."""
    m = np.asarray(matrix, dtype=float)
    rep_y, rep_x = m.shape
    assert threads % rep_x == 0 and threads % rep_y == 0
    # half a thread of phase: the wrap seam runs along yarn crowns, not the gaps between yarns
    tx, ty = X * threads + 0.5, Y * threads + 0.5
    i = np.floor(tx).astype(int)
    j = np.floor(ty).astype(int)
    u, v = tx - i, ty - j
    i, j = i % threads, j % threads
    # per end i: its over (1) / under (0) sequence along the picks; per pick j: the weft's
    full = np.tile(m, (threads // rep_y, threads // rep_x))  # [pick, end]
    warp_up = np.empty((N, N))
    weft_up = np.empty((N, N))
    for e in range(threads):
        cols = i == e
        warp_up[cols] = crimp(full[:, e], ty[cols])
    for p in range(threads):
        rows = j == p
        weft_up[rows] = crimp(1.0 - full[p, :], tx[rows])
    # yarn twist: faint slanted striations along each yarn (integer cycles per thread)
    tw_warp = 1 + 0.06 * np.cos(2 * np.pi * (twist * ty + u))
    tw_weft = 1 + 0.06 * np.cos(2 * np.pi * (twist * tx + v))
    hw = dome(u) * (low + (1 - low) * warp_up) * tw_warp
    hf = dome(v) * (low + (1 - low) * weft_up) * tw_weft
    h = np.maximum(hw, hf) + fibre * periodic_noise(rng, 60, 200)
    return h, hw >= hf, i


def twill(over, under, shift=1):
    n = over + under
    return [[1 if (e - shift * p) % n < over else 0 for e in range(n)] for p in range(n)]


def knit_loops(threads_x, threads_y, raised=None, purl=None, phase=(0.26, 0.5)):
    """Single-jersey face: each wale a column of V loops, two tilted legs per loop. Evaluated
    over neighbouring cells too, so the legs cross cell borders and the tile stays periodic.
    raised / purl: per-wale lists for rib (purl wales are sunk, with horizontal bumps)."""
    # a phase so the wrap seam crosses the loops' legs, not the creases between them
    tx, ty = X * threads_x + phase[0], Y * threads_y + phase[1]
    h = np.full((N, N), -0.4)
    aspect = (N / threads_x) / (N / threads_y)  # cell width / height in pixels
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            ci = np.floor(tx).astype(int) + dx
            cj = np.floor(ty).astype(int) + dy
            u = tx - ci  # position in that cell, cell widths
            v = ty - cj
            wale = ci % threads_x
            is_purl = purl[wale] if purl is not None else np.zeros_like(wale, bool)
            for side in (-1, 1):
                # leg centre and tilt: legs meet low at the wale centre, spread at the top (V)
                cx, cy = 0.5 + side * 0.24, 0.52
                ang = -side * np.radians(28)  # image y runs down
                px, py = (u - cx) * aspect, v - cy
                a = px * np.cos(ang) - py * np.sin(ang)  # across the leg
                b = px * np.sin(ang) + py * np.cos(ang)  # along the leg
                r2 = (a / (0.30 * aspect)) ** 2 + (b / 0.68) ** 2
                leg = np.sqrt(np.clip(1 - r2, 0, 1))
                h = np.where(~is_purl, np.maximum(h, leg), h)
            # purl: a horizontal loop head per course
            pa = (u - 0.5) * aspect / (0.55 * aspect)
            pb = (v - 0.5) / 0.42
            bump = 0.55 * np.sqrt(np.clip(1 - pa * pa - pb * pb, 0, 1)) - 0.35
            h = np.where(is_purl, np.maximum(h, bump), h)
    if raised is not None:
        wale = np.floor(tx).astype(int) % threads_x
        uu = tx - np.floor(tx)
        lift = np.where(np.asarray(raised)[wale], 0.35, -0.15) * dome(uu, 1.0)
        h = h + lift
    return h


def build(name):
    rng = np.random.default_rng([SEED, list(WEAVES).index(name)])
    tone = np.ones((N, N))
    depth = 5.0  # height range in pixels, for the normals
    if name == "plain":
        h, _, _ = woven(rng, [[1, 0], [0, 1]], 32)
        depth = 5.0
    elif name == "twill":
        h, _, _ = woven(rng, twill(2, 1), 36, low=0.5)
        depth = 5.0
    elif name == "denim":
        h, warp_top, end = woven(rng, twill(3, 1), 40, low=0.45, fibre=0.07)
        # warp a little greyer than the weft (indigo warp, white weft once tinted), with slubs
        slub = 0.025 * rng.standard_normal(40)
        along = periodic_noise(rng, 2, 10, aniso=(0.15, 1.0))
        warp_tone = 0.87 + slub[end % 40] + 0.02 * along
        tone = np.where(warp_top, warp_tone, 1.0)
        depth = 6.0
    elif name == "satin":
        # 5-end satin, move 2: the warp is on top 4 picks of 5 (long smooth floats)
        m = [[0 if e == (2 * p) % 5 else 1 for e in range(5)] for p in range(5)]
        h, _, _ = woven(rng, m, 60, low=0.75, twist=2, fibre=0.02)
        depth = 2.5
    elif name == "canvas":
        m = [[1 if ((e // 2) + (p // 2)) % 2 == 0 else 0 for e in range(4)] for p in range(4)]
        h, _, _ = woven(rng, m, 40, low=0.5, fibre=0.06)
        depth = 6.0
    elif name == "jersey":
        h = knit_loops(24, 32) + 0.04 * periodic_noise(rng, 60, 200)
        depth = 6.0
    elif name == "rib":
        wales = 24
        raised = [w % 2 == 0 for w in range(wales)]
        purl = np.array([not r for r in raised])
        h = knit_loops(wales, 32, raised=raised, purl=purl) + 0.04 * periodic_noise(rng, 60, 200)
        depth = 7.0
    elif name == "fleece":
        # brushed pile: soft clumps over fine fibres, a faint knit underneath
        clumps = periodic_noise(rng, 8, 40)
        fibres = periodic_noise(rng, 40, 160, aniso=(1.0, 0.6))
        under = knit_loops(40, 52)
        h = 0.55 * clumps + 0.3 * fibres + 0.08 * under
        depth = 3.0
    else:
        raise KeyError(name)

    lo, hi = np.percentile(h, 1), np.percentile(h, 99)
    hn = np.clip((h - lo) / (hi - lo), 0, 1)

    # diffuse: linear grey, then sRGB-encoded (the View samples it sRGB-decoded)
    ao = 0.82 + 0.18 * np.sqrt(hn)
    lin = np.clip(ao * tone, 0, 1)
    diffuse = np.repeat(to_u8(srgb_encode(lin))[..., None], 3, axis=2)

    # normal: periodic central differences of the height in pixels; OpenGL +Y up
    hp = hn * depth
    dhdx = (np.roll(hp, -1, axis=1) - np.roll(hp, 1, axis=1)) * 0.5
    dhdrow = (np.roll(hp, -1, axis=0) - np.roll(hp, 1, axis=0)) * 0.5
    n = np.stack([-dhdx, dhdrow, np.ones_like(hp)], axis=-1)  # dh/dy_up = -dh/drow
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    normal = to_u8(n * 0.5 + 0.5)

    # roughness: glTF R 255, G roughness, B 0; yarn tops a little smoother
    r = WEAVES[name][2] - 0.08 * (hn - hn.mean())
    rough = np.zeros((N, N, 3), np.uint8)
    rough[..., 0] = 255
    rough[..., 1] = to_u8(np.clip(r, 0, 1))
    return {"diffuse": diffuse, "normal": normal, "roughness": rough}


def srgb_encode(x):
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def srgb_decode(c):
    return np.where(c <= 0.04045, c / 12.92, np.power((c + 0.055) / 1.055, 2.4))


def to_u8(x):
    return np.clip(np.round(x * 255.0), 0, 255).astype(np.uint8)


def library():
    return {
        "version": 1,
        "note": "Procedural tiles; every value (estimated).",
        "weaves": {
            name: {
                "label": label,
                "tile_mm": tile,
                "roughness": rough,
                "sheen": sheen,
                "sheen_roughness": sr,
                "estimated": EST,
            }
            for name, (label, tile, rough, sheen, sr) in WEAVES.items()
        },
    }


def seam_ratio(img):
    """Mean |difference| across the wrap seam over the mean between interior neighbours,
    for columns (511 -> 0) and rows (511 -> 0). 1.0 is as smooth as anywhere inside."""
    a = img.astype(float)
    if a.ndim == 2:
        a = a[..., None]
    inner_c = np.abs(np.diff(a, axis=1)).mean()
    inner_r = np.abs(np.diff(a, axis=0)).mean()
    seam_c = np.abs(a[:, 0] - a[:, -1]).mean()
    seam_r = np.abs(a[0, :] - a[-1, :]).mean()
    return seam_c, inner_c, seam_r, inner_r


def check():
    bad = []
    total = 0
    lib = json.loads((OUT / "weaves.json").read_text(encoding="utf-8"))
    if lib != library():
        bad.append("weaves.json differs from the script's values")
    for name, entry in lib["weaves"].items():
        for key in ("label", "tile_mm", "roughness", "sheen", "sheen_roughness"):
            if key not in entry:
                bad.append(f"{name}: no {key}")
        if entry.get("estimated") != EST:
            bad.append(f"{name}: not labelled {EST}")
    if EST not in lib.get("note", ""):
        bad.append(f"note not labelled {EST}")
    for name in WEAVES:
        maps = build(name)
        for kind, want in maps.items():
            path = OUT / f"{name}-{kind}.png"
            total += path.stat().st_size
            im = Image.open(path)
            if im.size != (N, N) or im.mode not in ("RGB", "RGBA"):
                bad.append(f"{path.name}: {im.size} {im.mode}, want 512x512 RGB(A)")
                continue
            got = np.asarray(im.convert("RGB"))
            if not np.array_equal(got, want):
                bad.append(f"{path.name}: pixels differ from a regeneration "
                           f"({int((got != want).any(axis=2).sum())} px)")
            sc, ic, sr, ir = seam_ratio(got)
            worst = max(sc / ic if ic else (0 if sc == 0 else np.inf),
                        sr / ir if ir else (0 if sr == 0 else np.inf))
            print(f"  {path.name:24s} seam/inner cols {sc:6.3f}/{ic:6.3f}  rows {sr:6.3f}/{ir:6.3f}"
                  f"  worst ratio {worst:4.2f}")
            if worst > 1.5:
                bad.append(f"{path.name}: seam {worst:.2f} x the interior")
            if kind == "diffuse":
                lin = srgb_decode(got[..., 0] / 255.0)
                if lin.mean() < 0.85 or lin.min() < 0.6:
                    bad.append(f"{path.name}: linear mean {lin.mean():.3f} min {lin.min():.3f}")
                print(f"  {'':24s} diffuse linear mean {lin.mean():.3f} min {lin.min():.3f}")
            if kind == "normal":
                d = got / 255.0 * 2 - 1
                err = np.abs(np.linalg.norm(d, axis=-1) - 1).max()
                if err > 2 / 255:
                    bad.append(f"{path.name}: normal length off by {err:.4f}")
    print(f"total {total} bytes ({total / 1e6:.2f} MB) in {3 * len(WEAVES)} PNGs")
    if total >= 8e6:
        bad.append(f"total {total} bytes, want < 8 MB")
    for b in bad:
        print("FAIL", b)
    print("check:", "FAIL" if bad else "ok")
    return 0 if not bad else 1


def write():
    OUT.mkdir(parents=True, exist_ok=True)
    total = 0
    for name in WEAVES:
        for kind, img in build(name).items():
            path = OUT / f"{name}-{kind}.png"
            Image.fromarray(img, "RGB").save(path, optimize=True)
            total += path.stat().st_size
            print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size} bytes)")
    (OUT / "weaves.json").write_text(json.dumps(library(), indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {(OUT / 'weaves.json').relative_to(ROOT)}; PNGs {total / 1e6:.2f} MB")


if __name__ == "__main__":
    sys.exit(check() if "--check" in sys.argv[1:] else write())
