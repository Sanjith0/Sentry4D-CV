"""Procedural proxy of the carried cafe chair: geometry, silhouette helpers, texture and GLB.

Local frame: origin on the floor under the centre of the seat, +Y up, +Z = the direction a seated
person faces, metres. The chair is six convex pieces (hexahedra): a thin solid seat panel, a thin
solid backrest panel leaning back from the rear edge of the seat, and four tapered legs splayed
from the seat corners. Solid panels on purpose: the viewer projects the camera pixels onto the
proxy and thin slat geometry would alias against the real slats; the gaps between the slats are
cut by the alpha channel of the texture instead (material alphaMode MASK).

Because every piece is convex, its image is the convex hull of its eight projected corners, which
gives an exact silhouette (`hulls`, `raster`) and an exact, smooth pixel-to-model distance
(`hull_distance`) for the silhouette fits in chair.py.

The GLB carries the same solid as `PIECES`: the two panels and every leg in LEG_SEGMENTS lengths, each
its own node. A camera's matte often has the panels of the carried chair but only part of its thin
legs, so the viewer decides piece by piece whether the footage outline or the proxy is drawn
(register.py measures it, avatar.json `props[].frames.cut`).

Finish: the chair is satin silver metal. The six boxes are flat, so what makes a surface read as metal
is in the material instead (see "surface finish" below): a normal map that rounds the edges of every
slat and of the panels, a shading normal per vertex that makes the square legs round tubes, and the
metallic / roughness factors. The geometry and the NORMAL attribute (what a camera sees of a piece)
are those of the boxes. A second scene, `wireframe`, holds the same chair as a triangle mesh with one
strip per slat, for viewers that draw it as a wireframe.
"""
import io, json, struct
import cv2
import numpy as np
from PIL import Image

from common import project
from gltf_io import FLOAT, U16, _Buf, _pad

# metres / degrees; the values chair.py measures for clip02 replace these defaults
DIMS = {"seat_w": 0.43, "seat_d": 0.42, "seat_h": 0.45, "back_h": 0.82, "back_w": 0.40, "back_tilt": 14.0,
        "leg_front": 0.03, "leg_rear": 0.10, "leg_side": 0.03}
FREE = list(DIMS)                                    # the dimensions fitted to the footage
SEAT_T, BACK_T, LEG_TOP, LEG_FOOT = 0.018, 0.018, 0.024, 0.020     # panels and the metal tube legs
PARTS = ["seat", "back", "leg_fl", "leg_fr", "leg_rl", "leg_rr"]
LEG_SEGMENTS = 6                                     # lengths a leg is cut into (7 cm each)
# what the viewer shows or cuts one by one, in the bit order of avatar.json `cut`; leg pieces run from the seat down
PIECES = PARTS[:2] + [f"{leg}_{j}" for leg in PARTS[2:] for j in range(LEG_SEGMENTS)]
# pieces of one plain colour (the tube legs; the panels are slats with gaps): away from a camera the viewer puts
# only those of its pixels on them that look like that colour. A leg is a few pixels wide and the pose of a
# carried chair is known to 2-3 cm, so some of the pixels that land on it are the trousers behind it.
PLAIN = [p for p in PIECES if p.startswith("leg_")]

# faces of a hexahedron whose corners are indexed a + 2 b + 4 c along right-handed local axes (u, v, w)
_QUADS = {"-w": (0, 2, 3, 1), "+w": (4, 5, 7, 6), "-v": (0, 1, 5, 4), "+v": (2, 6, 7, 3), "-u": (0, 4, 6, 2), "+u": (1, 3, 7, 5)}


def _hexa(p00, p10, p01, p11, q00, q10, q01, q11):
    """Corners a + 2 b + 4 c from the four corners of the c = 0 face (p_ab) and of the c = 1 face (q_ab)."""
    return np.array([p00, p10, p01, p11, q00, q10, q01, q11], float)


def parts(d):
    """The six convex pieces -> (6, 8, 3) corners in the local frame."""
    w, dd, sh = d["seat_w"], d["seat_d"], d["seat_h"]
    zr, zf = -dd / 2, dd / 2
    seat = _hexa([-w / 2, sh - SEAT_T, zr], [w / 2, sh - SEAT_T, zr], [-w / 2, sh, zr], [w / 2, sh, zr],
                 [-w / 2, sh - SEAT_T, zf], [w / 2, sh - SEAT_T, zf], [-w / 2, sh, zf], [w / 2, sh, zf])
    # backrest: u = x, v = up along the panel, w = thickness (towards the front)
    tl = np.radians(d["back_tilt"])
    up = np.array([0.0, np.cos(tl), -np.sin(tl)]); nrm = np.array([0.0, np.sin(tl), np.cos(tl)])
    b0 = np.array([0.0, sh - SEAT_T, zr]); b1 = b0 + up * (d["back_h"] - b0[1]) / up[1]
    bw, ex = d["back_w"] / 2, np.array([1.0, 0, 0])
    back = _hexa(b0 - bw * ex - BACK_T * nrm, b0 + bw * ex - BACK_T * nrm, b1 - bw * ex - BACK_T * nrm, b1 + bw * ex - BACK_T * nrm,
                 b0 - bw * ex, b0 + bw * ex, b1 - bw * ex, b1 + bw * ex)
    out = [seat, back]
    for sz, splay in ((1, d["leg_front"]), (-1, d["leg_rear"])):
        for sx in (-1, 1):
            top = np.array([sx * (w / 2 - LEG_TOP / 2), sh - SEAT_T, sz * (dd / 2 - LEG_TOP / 2)])
            foot = np.array([sx * (w / 2 + d["leg_side"]), 0.0, sz * (dd / 2 + splay)])
            c = []
            for cz in (-1, 1):
                for cen, s in ((foot, LEG_FOOT / 2), (top, LEG_TOP / 2)):
                    for cx in (-1, 1):
                        c.append(cen + [cx * s, 0, cz * s])
            out.append(np.array(c))
    return np.stack(out)


def pieces(d, n=LEG_SEGMENTS):
    """The solid of `parts` as PIECES: both panels, then every leg in n lengths from the seat down
    -> (2 + 4 n, 8, 3) corners in the local frame."""
    c = parts(d)
    out = [c[0], c[1]]
    for leg in c[2:]:
        q = leg.reshape(2, 2, 2, 3)                  # [w, v, u], v = 0 at the foot
        for j in range(n):
            t0, t1 = 1 - (j + 1) / n, 1 - j / n      # this length spans v in [t0, t1]
            lo, hi = q[:, 0] * (1 - t0) + q[:, 1] * t0, q[:, 0] * (1 - t1) + q[:, 1] * t1
            out.append(np.stack([lo, hi], 1).reshape(8, 3))
    return np.stack(out)


def samples(d, n=15):
    """Points spread over the pieces (n x n on the mid-surface of a panel, n along the axis of a leg;
    the count does not depend on the dimensions) -> (m, 3) local, (m,) part index."""
    P, I = [], []
    t, mid = (np.arange(n) + 0.5) / n, np.array([0.5])
    for i, c in enumerate(parts(d)):
        c = c.reshape(2, 2, 2, 3)                    # [w, v, u]
        ax = {"seat": (t, mid, t), "back": (mid, t, t)}.get(PARTS[i], (mid, np.linspace(0, 1, n), mid))
        gw, gv, gu = np.meshgrid(*ax, indexing="ij")
        pts = sum(np.where(a, gw, 1 - gw)[..., None] * np.where(b, gv, 1 - gv)[..., None] * np.where(e, gu, 1 - gu)[..., None] * c[a, b, e]
                  for a in (0, 1) for b in (0, 1) for e in (0, 1))
        P.append(pts.reshape(-1, 3)); I.append(np.full(pts.size // 3, i))
    return np.concatenate(P), np.concatenate(I)


def hulls(cam, X):
    """Image outline of every piece: X (6, 8, 3) corners in fit coordinates -> list of (m, 2) convex polygons."""
    px, _ = project(cam, X)
    return [cv2.convexHull(p.astype(np.float32)).reshape(-1, 2).astype(np.float64) for p in px]


def raster(polys, shape, origin=(0, 0)):
    """Union of the convex polygons as a uint8 0/1 image of `shape` whose pixel (0, 0) is `origin`."""
    img = np.zeros(shape, np.uint8)
    for p in polys:
        cv2.fillConvexPoly(img, np.round((p - np.asarray(origin, float)) * 8).astype(np.int32), 1, lineType=cv2.LINE_8, shift=3)
    return img


def hull_distance(pts, polys):
    """Distance (px) from points (n, 2) to the union of the convex polygons; 0 inside."""
    best = np.full(len(pts), np.inf)
    for p in polys:
        a, b = p, np.roll(p, -1, 0)
        e = b - a
        L2 = np.maximum((e ** 2).sum(1), 1e-9)
        r = pts[:, None] - a[None]
        cr = e[None, :, 0] * r[..., 1] - e[None, :, 1] * r[..., 0]
        inside = (cr >= 0).all(1) | (cr <= 0).all(1)
        t = np.clip((r * e[None]).sum(-1) / L2[None], 0, 1)
        dist = np.linalg.norm(r - t[..., None] * e[None], axis=-1).min(1)
        best = np.minimum(best, np.where(inside, 0.0, dist))
    return best


# ---------------------------------------------------------------- texture + GLB
TEX = 512
_TILES = {"seat_top": (0, 0, 256, 256), "seat_bottom": (256, 0, 512, 256), "back_front": (0, 256, 256, 488),
          "back_rear": (256, 256, 512, 488), "edge": (0, 492, 256, 512), "leg": (256, 492, 512, 512)}
_PAD = 6                                             # texels kept clear of a tile border (mip-map bleed)


# slats of a panel tile, as fractions of the tile: gaps across the width, x margin, first and last row of the
# slatted part, share of a pitch that is gap, corner radius, round the top corners only
_SLATS = {"seat": (9, 0.12, 0.16, 0.90, 0.36, 0.10, False),      # rows: rear (top of the tile) -> front
          "back": (12, 0.13, 0.12, 0.80, 0.36, 0.12, True)}      # rows: top of the backrest -> seat


def _panel_alpha(h, w, slots, x_margin, y0, y1, gap, radius, round_top_only):
    """Alpha of one panel tile: 1 = material. `slots` gaps across the width between rows y0..y1
    (fractions of the tile, row 0 = the far edge: backrest top / seat rear) and rounded corners."""
    a = np.ones((h, w), np.float32)
    ys = (np.arange(h) + 0.5) / h
    xs = (np.arange(w) + 0.5) / w
    phase = (ys - y0) / (y1 - y0) * slots
    in_gap = (phase >= 0) & (phase < slots) & ((phase % 1.0) > 1 - gap)
    a[np.ix_(in_gap, (xs > x_margin) & (xs < 1 - x_margin))] = 0
    r = radius
    for cy in ([r] if round_top_only else [r, 1 - r]):
        for cx in (r, 1 - r):
            yy, xx = np.meshgrid(ys, xs, indexing="ij")
            corner = ((yy < r) if cy == r else (yy > 1 - r)) & ((xx < r) if cx == r else (xx > 1 - r))
            a[corner & ((yy - cy) ** 2 + (xx - cx) ** 2 > r * r)] = 0
    return a


def texture(rgb, metal, dark=0.85):
    """RGBA texture (TEX x TEX): the measured colour `rgb` of the slatted panels with a faint slat
    shading and darker undersides, the gaps between the slats in alpha, and the measured colour
    `metal` of the legs. Tiles as in _TILES. What lies between the tiles is opaque and has the colour of
    the tile next to it: a leg is a few pixels wide on screen and is drawn from a small mip level, which
    mixes its narrow tile with whatever surrounds it (black, transparent texels there darken and thin the legs)."""
    rgb, metal = np.asarray(rgb, np.float32), np.asarray(metal, np.float32)
    img = np.ones((TEX, TEX, 4), np.float32)
    img[..., :3] = rgb
    img[_TILES["leg"][1] - 4:, _TILES["leg"][0]:, :3] = metal
    for name, (x0, y0, x1, y1) in _TILES.items():
        h, w = y1 - y0, x1 - x0
        tile = np.ones((h, w, 4), np.float32)
        tile[..., :3] = metal if name == "leg" else rgb * (dark if name in ("seat_bottom", "back_rear") else 1.0)
        a = _panel_alpha(h, w, *_SLATS[name[:4]]) if name[:4] in _SLATS else np.ones((h, w), np.float32)
        if name.startswith(("seat", "back")):        # each slat a little darker towards its lower edge
            soft = cv2.GaussianBlur(a, (0, 0), 2.0)
            tile[..., :3] *= (0.86 + 0.14 * soft)[..., None]
        tile[..., 3] = a
        img[y0:y1, x0:x1] = tile
    return np.clip(np.round(img * [1, 1, 1, 255]), 0, 255).astype(np.uint8)


# ---------------------------------------------------------------- surface finish
# What a glTF viewer lights the chair as: satin aluminium. The Sentry4D viewer draws the measured colour unlit
# and adds a sheen whose strength and width follow these two factors (AvatarLayer.tsx, "metal").
METALLIC, ROUGHNESS = 1.0, 0.45
# Rounded edges of the slats and of the panel rims, in texels (1.8 mm): the normal leans EDGE_TILT degrees
# outwards at an edge and is upright EDGE_TEXELS in; a slat is also crowned by CROWN_TILT degrees at its edge,
# falling to nothing at its middle (CROWN_TEXELS = half its width), so a highlight travels across it.
EDGE_TEXELS, EDGE_TILT, CROWN_TEXELS, CROWN_TILT = 3.5, 50.0, 6.5, 11.0
# A pressed sheet is never dead flat: the shading normal of a panel leans this many degrees outwards at each
# of its sides (nothing at its middle), so what it mirrors changes gently across it.
PANEL_CROWN = 6.0


def normal_map():
    """Tangent-space normal map (TEX x TEX, RGB) for the tiles of `texture`, glTF convention: +X along u,
    +Y against v (up the image), +Z out of the surface. Flat everywhere except near an edge of the material
    of a panel tile (a gap between slats, the rim of the panel), where the normal leans towards that edge."""
    img = np.zeros((TEX, TEX, 3), np.float32)
    img[..., 2] = 1
    for name, (x0, y0, x1, y1) in _TILES.items():
        if name[:4] not in _SLATS:
            continue
        h, w = y1 - y0, x1 - x0
        solid = np.zeros((h, w), np.uint8)
        solid[_PAD:h - _PAD, _PAD:w - _PAD] = _panel_alpha(h, w, *_SLATS[name[:4]])[_PAD:h - _PAD, _PAD:w - _PAD] > 0.5   # the panel ends at the pad
        dist = cv2.GaussianBlur(cv2.distanceTransform(solid, cv2.DIST_L2, 5), (0, 0), 0.8)
        gy, gx = np.gradient(dist)                   # points away from the nearest edge
        g = np.hypot(gx, gy)
        d = np.maximum(dist - 0.5, 0)
        tilt = np.radians(EDGE_TILT * np.clip(1 - d / EDGE_TEXELS, 0, 1) ** 2 + CROWN_TILT * np.clip(1 - d / CROWN_TEXELS, 0, 1))
        lean = np.where((g > 0.05) & (solid > 0), np.sin(tilt) / np.maximum(g, 1e-6), 0)
        img[y0:y1, x0:x1, 0] = -gx * lean
        img[y0:y1, x0:x1, 1] = gy * lean             # v runs down the image, +Y up it
        img[y0:y1, x0:x1, 2] = np.sqrt(np.maximum(1 - (gx * lean) ** 2 - (gy * lean) ** 2, 0))
    return np.clip(np.round((img * 0.5 + 0.5) * 255), 0, 255).astype(np.uint8)


def _tile_uv(name, s, t):
    """(s, t) in [0, 1]^2 of a tile (t = 0 at its top row) -> glTF uv."""
    x0, y0, x1, y1 = _TILES[name]
    return np.stack([(x0 + _PAD + s * (x1 - x0 - 2 * _PAD)) / TEX, (y0 + _PAD + t * (y1 - y0 - 2 * _PAD)) / TEX], -1)


def meshes(d):
    """Render meshes, one per piece of PIECES -> list of (name, v (n, 3), normals, uv (glTF, origin
    top-left), faces (m, 3), shading normals). The normals are those of the flat faces (the geometry a
    camera sees). The shading normals are what the surface finish is lit with: on the two large faces of a
    panel leaning PANEL_CROWN outwards towards its sides, on its rim the same as the normals, and on a leg,
    which stands for a round tube, pointing straight out from its axis."""
    panel = {("seat", "+v"): "seat_top", ("seat", "-v"): "seat_bottom", ("back", "+w"): "back_front", ("back", "-w"): "back_rear"}
    out = []
    for name, c in zip(PIECES, pieces(d)):
        V, N, UV, F, S = [], [], [], [], []
        ends = c.reshape(2, 2, 2, 3).mean((0, 2))    # centres of the v = 0 and v = 1 faces: the axis of a leg
        axis = (ends[1] - ends[0]) / np.linalg.norm(ends[1] - ends[0])
        for side, q in _QUADS.items():
            p = c[list(q)]
            n = np.cross(p[1] - p[0], p[3] - p[0]); n /= np.linalg.norm(n)
            tile = panel.get((name, side))
            if tile is None:
                uv = _tile_uv("leg" if name.startswith("leg") else "edge", np.array([0.2, 0.8, 0.8, 0.2]), np.array([0.2, 0.2, 0.8, 0.8]))
            elif name == "seat":                     # s across the width, t from the rear edge to the front
                uv = _tile_uv(tile, (p[:, 0] - c[:, 0].min()) / np.ptp(c[:, 0]), (p[:, 2] - c[:, 2].min()) / np.ptp(c[:, 2]))
            else:                                    # s across the width, t from the top of the backrest down
                uv = _tile_uv(tile, (p[:, 0] - c[:, 0].min()) / np.ptp(c[:, 0]), (c[:, 1].max() - p[:, 1]) / np.ptp(c[:, 1]))
            b = len(V) * 4
            V.append(p); N.append(np.tile(n, (4, 1))); UV.append(uv); F += [[b, b + 1, b + 2], [b, b + 2, b + 3]]
            if tile is None:
                S.append(np.tile(n, (4, 1)))
            else:                                    # a corner leans along both sides of the face that meet in it
                r = p - p.mean(0)
                lean = sum(np.outer(np.sign(r @ e), e / np.linalg.norm(e)) for e in (p[1] - p[0], p[3] - p[0]))
                sh = n + np.tan(np.radians(PANEL_CROWN)) * lean
                S.append(sh / np.linalg.norm(sh, axis=1, keepdims=True))
        v, n = np.concatenate(V), np.concatenate(N)
        if name.startswith("leg"):
            r = v - ends[0]
            r -= np.outer(r @ axis, axis)
            shade = r / np.linalg.norm(r, axis=1, keepdims=True)
        else:
            shade = np.concatenate(S)
        out.append((name, v, n, np.concatenate(UV), np.array(F), shade))
    return out


WIRE_CELL = 0.045                                    # m: longest edge of a wireframe cell along a slat


def _wire_grid(corner, rows, cols, skip):
    """Triangles of a grid on a bilinear patch: corner (2, 2, 3) indexed [t, s], `rows` / `cols` the grid
    lines (fractions), skip(i, j) True for the cells left out. Diagonals alternate from cell to cell."""
    T, S = np.meshgrid(rows, cols, indexing="ij")
    v = ((1 - T) * (1 - S))[..., None] * corner[0, 0] + ((1 - T) * S)[..., None] * corner[0, 1] + (T * (1 - S))[..., None] * corner[1, 0] + (T * S)[..., None] * corner[1, 1]
    n, f = len(cols), []
    for i in range(len(rows) - 1):
        for j in range(n - 1):
            if skip(i, j):
                continue
            a, b, c, e = i * n + j, i * n + j + 1, (i + 1) * n + j + 1, (i + 1) * n + j
            f += [[a, b, c], [a, c, e]] if (i + j) % 2 == 0 else [[a, b, e], [b, c, e]]
    return v.reshape(-1, 3), np.array(f)


def wire(d):
    """The chair as one triangle mesh for a wireframe drawing -> v (n, 3), faces (m, 3): each panel as its
    middle surface with the gaps between its slats left open (one strip of cells per slat, the cells
    WIRE_CELL long), each leg as a four-sided tube in LEG_SEGMENTS lengths. Vertices no face uses are dropped."""
    c = parts(d)
    V, F, base = [], [], 0
    for name, tile in (("seat", "seat_top"), ("back", "back_front")):
        q = c[PARTS.index(name)].reshape(2, 2, 2, 3)             # [w, v, u]
        slots, x_margin, y0, y1, gap, _, _ = _SLATS[name]
        tx0, ty0, tx1, ty1 = _TILES[tile]
        frac_s = lambda f: np.clip((f * (tx1 - tx0) - _PAD) / (tx1 - tx0 - 2 * _PAD), 0, 1)      # tile fraction -> across the panel
        frac_t = lambda f: np.clip((f * (ty1 - ty0) - _PAD) / (ty1 - ty0 - 2 * _PAD), 0, 1)      # ... -> down the tile's rows
        if name == "seat":                           # t: rear -> front (w), s: across (u); middle of the thickness (v)
            mid = q.mean(1)                          # [w, u]
            corner, long_t = mid, np.linalg.norm(mid[1, 0] - mid[0, 0])
        else:                                        # t: top of the backrest -> seat (v reversed), s: across (u); middle of the thickness (w)
            mid = q.mean(0)[::-1]                    # [v from the top, u]
            corner, long_t = mid, np.linalg.norm(mid[1, 0] - mid[0, 0])
        long_s = np.linalg.norm(corner[0, 1] - corner[0, 0])
        rows, gaps = [0.0], set()
        for j in range(slots):                       # slat j, then gap j
            g0, g1 = frac_t(y0 + (j + 1 - gap) / slots * (y1 - y0)), frac_t(y0 + (j + 1) / slots * (y1 - y0))
            rows += [g0, g1]
            gaps.add(len(rows) - 2)                  # the band between the last two lines
        rows.append(1.0)
        fine, is_gap = [rows[0]], []                 # bands wider than a cell (the rails above and below the slats) in equal parts
        for i in range(len(rows) - 1):
            n = 1 if i in gaps else max(1, int(np.ceil((rows[i + 1] - rows[i]) * long_t / WIRE_CELL - 1e-9)))
            fine += list(np.linspace(rows[i], rows[i + 1], n + 1)[1:])
            is_gap += [i in gaps] * n
        s0, s1 = frac_s(x_margin), frac_s(1 - x_margin)
        n = max(1, int(np.ceil((s1 - s0) * long_s / WIRE_CELL - 1e-9)))
        cols = [0.0] + list(np.linspace(s0, s1, n + 1)) + [1.0]
        v, f = _wire_grid(corner, np.array(fine), np.array(cols), lambda i, j: is_gap[i] and 1 <= j <= n)
        V.append(v); F.append(f + base); base += len(v)
    for leg in c[2:]:
        q = leg.reshape(2, 2, 2, 3)                  # [w, v, u], v = 0 at the foot
        ring = lambda t: (q[:, 0] * (1 - t) + q[:, 1] * t)[[0, 0, 1, 1], [0, 1, 1, 0]]          # four corners in order round the tube
        v = np.concatenate([ring(t) for t in np.linspace(0, 1, LEG_SEGMENTS + 1)])
        f = []
        for i in range(LEG_SEGMENTS):
            for j in range(4):
                a, b = i * 4 + j, i * 4 + (j + 1) % 4
                f += [[a, b, b + 4], [a, b + 4, a + 4]] if (i + j) % 2 == 0 else [[a, b, a + 4], [b, b + 4, a + 4]]
        f += [[0, 1, 2], [0, 2, 3]]                  # the foot
        V.append(v); F.append(np.array(f) + base); base += len(v)
    v, f = np.concatenate(V), np.concatenate(F)
    used = np.unique(f)
    remap = np.full(len(v), -1); remap[used] = np.arange(len(used))
    return v[used], remap[f]


def write_glb(path, d, rgb, metal, extras=None):
    """Static GLB. Scene 0: a root node `chair` whose children are the pieces of PIECES (node name = piece
    name), one material for all of them (RGBA colour PNG, normal map, satin metal, alphaMode MASK, double
    sided); every piece also has its shading normals as `_SHADE_NORMAL`. Scene 1 (`wireframe`): the node
    `wire`, the same chair as the triangle mesh of `wire`, positions only. Returns the vertex and triangle
    counts of scene 0."""
    png, npng = io.BytesIO(), io.BytesIO()
    Image.fromarray(texture(rgb, metal), "RGBA").save(png, format="PNG", optimize=True)
    Image.fromarray(normal_map(), "RGB").save(npng, format="PNG", optimize=True)
    b = _Buf()
    nodes, mesh_defs, nv, nf = [{"name": "chair", "children": []}], [], 0, 0
    for name, v, n, uv, f, shade in meshes(d):
        prim = {"attributes": {"POSITION": b.accessor(v.astype(np.float32), FLOAT, "VEC3", target=34962, minmax=True),
                               "NORMAL": b.accessor(n.astype(np.float32), FLOAT, "VEC3", target=34962),
                               "TEXCOORD_0": b.accessor(uv.astype(np.float32), FLOAT, "VEC2", target=34962),
                               "_SHADE_NORMAL": b.accessor(shade.astype(np.float32), FLOAT, "VEC3", target=34962)},
                "indices": b.accessor(f.reshape(-1).astype(np.uint16), U16, "SCALAR", target=34963), "material": 0}
        nodes[0]["children"].append(len(nodes))
        nodes.append({"name": name, "mesh": len(mesh_defs)})
        mesh_defs.append({"primitives": [prim]})
        nv, nf = nv + len(v), nf + len(f)
    wv, wf = wire(d)
    nodes.append({"name": "wire", "mesh": len(mesh_defs), "extras": {"role": "wireframe"}})
    mesh_defs.append({"primitives": [{"attributes": {"POSITION": b.accessor(wv.astype(np.float32), FLOAT, "VEC3", target=34962, minmax=True)},
                                      "indices": b.accessor(wf.reshape(-1).astype(np.uint16), U16, "SCALAR", target=34963)}]})
    gltf = {"asset": {"version": "2.0", "generator": "Sentry4D avatar pipeline (experiments/reconstruction/avatar/chair.py)"},
            "scene": 0, "scenes": [{"nodes": [0]}, {"name": "wireframe", "nodes": [len(nodes) - 1]}], "nodes": nodes, "meshes": mesh_defs,
            "materials": [{"name": "chair", "alphaMode": "MASK", "alphaCutoff": 0.5, "doubleSided": True,
                           "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": METALLIC, "roughnessFactor": ROUGHNESS},
                           "normalTexture": {"index": 1}}],
            "images": [{"bufferView": b.view(png.getvalue()), "mimeType": "image/png", "name": "chair"},
                       {"bufferView": b.view(npng.getvalue()), "mimeType": "image/png", "name": "chair-normal"}],
            "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}],
            "textures": [{"sampler": 0, "source": 0}, {"sampler": 0, "source": 1}]}
    if extras:
        gltf["scenes"][0]["extras"] = extras
    gltf["bufferViews"], gltf["accessors"] = b.views, b.accessors
    gltf["buffers"] = [{"byteLength": len(b.data)}]
    js = _pad(json.dumps(gltf, separators=(",", ":")).encode(), b" ")
    with open(path, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(b.data)))
        fh.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        fh.write(struct.pack("<II", len(b.data), 0x004E4942) + bytes(b.data))
    return nv, nf
