#!/usr/bin/env python3
"""
generate_parts.py — reference part library for vetting the Straightedge quoting engine.

Writes watertight binary STL files (mm) into tools/vet-quotes/parts/ plus a
manifest.json that records, for every part:
  * the analytic truth the mesh was built from (bounding box, volume, surface
    area, hole/slot/pocket counts, cut perimeter) so the harness can grade the
    file parser's estimates,
  * the quote configurations to run (process, material, sub-process,
    thickness, finish),
  * an owner-independent "shop estimate" of the unit price at several
    quantities, built from setup minutes + cycle minutes at the shop rate +
    material + margin, using the feeds/speeds in the fusion-cam-programmer
    skill (Tormach 1100 capped at 5140 RPM, Techno router 18k RPM floor).

Only numpy is required. No CAD application is used: every part is assembled
from 2.5D cells (plate cells with a hole / countersunk hole / slot / pocket
feature), annular discs, turned bodies and one profile extrusion, all with
consistent outward winding, and the mesh is checked for closure before it is
written.

Usage:  python3 tools/vet-quotes/generate_parts.py [--out tools/vet-quotes/parts]
"""
import argparse
import json
import math
import os
import struct
import sys

import numpy as np

# ─────────────────────────────────────────────────────────────────────────────
# Shop constants used for the independent "expected price" estimate.
# These mirror the engine's own assumptions where they are reasonable
# (rates, margin) so the comparison isolates the TIME model, not the rate.
# ─────────────────────────────────────────────────────────────────────────────
SHOP_RATE_PER_HR = 95.0       # same as cncMachineRatePerHour / routerMachineRatePerHour
MARGIN = 0.30                 # same as marginPercent
LB_PER_IN3_TO_G_PER_CM3 = 27.68

MATERIAL_DENSITY_LB_IN3 = {
    "hdpe": 0.035, "uhmw": 0.034, "delrin": 0.051, "nylon": 0.041, "peek": 0.047,
    "ptfe": 0.078, "acrylic": 0.043, "polycarbonate": 0.043, "aluminum": 0.098,
    "brass": 0.308, "abs": 0.0376, "pla": 0.0448, "resin": 0.0426,
}
MATERIAL_PRICE_PER_KG = {  # landed stock cost, same numbers as defaults.js
    "hdpe": 5.5, "uhmw": 7.0, "delrin": 11.0, "nylon": 13.0, "peek": 130.0,
    "ptfe": 28.0, "acrylic": 8.0, "polycarbonate": 10.0, "aluminum": 7.0,
    "brass": 12.0, "abs": 25.0, "pla": 20.0, "resin": 80.0,
}


def material_cost(volume_mm3, mat, waste=1.35):
    """Stock cost for a part: part volume × waste factor × density × $/kg."""
    g = volume_mm3 / 1000.0 * MATERIAL_DENSITY_LB_IN3[mat] * LB_PER_IN3_TO_G_PER_CM3
    return g / 1000.0 * waste * MATERIAL_PRICE_PER_KG[mat]


def shop_estimate(setup_min, cycle_min, handling_min, mat_cost, tooling=0.0, hand_min=0.0,
                  qtys=(1, 10, 25, 100, 250), band=0.30):
    """Unit price = ((setup/q + cycle + handling + hand) / 60 × rate + material + tooling) / (1 − margin).

    Returns {qty: {"low", "mid", "high"}} with a ±band envelope. No volume
    discount is applied beyond setup amortisation — that is deliberately
    conservative: a real production run gets faster, but the engine's
    volume-discount table (up to −33 %) is one of the things under test.
    """
    out = {}
    for q in qtys:
        minutes = setup_min / q + cycle_min + handling_min + hand_min
        mid = (minutes / 60.0 * SHOP_RATE_PER_HR + mat_cost + tooling) / (1 - MARGIN)
        out[str(q)] = {"low": round(mid * (1 - band), 2), "mid": round(mid, 2), "high": round(mid * (1 + band), 2)}
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Mesh builder
# ─────────────────────────────────────────────────────────────────────────────
class Mesh:
    def __init__(self):
        self.tris = []  # list of (3,3) float arrays, CCW seen from outside

    # — primitives —
    def tri(self, a, b, c):
        self.tris.append(np.array([a, b, c], dtype=float))

    def quad(self, a, b, c, d):
        """a→b→c→d CCW seen from outside."""
        self.tri(a, b, c)
        self.tri(a, c, d)

    def tri2d(self, a, b, c, z, up=True):
        """Horizontal triangle at height z; winding fixed so the normal is ±z."""
        area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        if abs(area) < 1e-12:
            return
        A, B, C = (np.r_[a, z], np.r_[b, z], np.r_[c, z])
        if (area > 0) != up:
            B, C = C, B
        self.tri(A, B, C)

    # — caps —
    def cap_fan(self, loop, z, up=True, center=None):
        """Cap a star-shaped loop (CCW, Nx2) with a fan from its centroid."""
        c = np.mean(loop, axis=0) if center is None else np.asarray(center, float)
        n = len(loop)
        for i in range(n):
            self.tri2d(c, loop[i], loop[(i + 1) % n], z, up)

    def cap_annulus(self, outer, inner, z, up=True, center=None):
        """Cap the ring between two loops that are both star-shaped about `center`.

        Both loops are merged by polar angle (zipper), so the loops may have
        different vertex counts (e.g. a 4-vertex cell rectangle around a
        48-vertex hole). No vertices are added to either loop, so adjacent
        cells stay edge-compatible.
        """
        c = np.mean(inner, axis=0) if center is None else np.asarray(center, float)
        o = np.asarray(outer, float)
        i_ = np.asarray(inner, float)
        ao = np.mod(np.arctan2(o[:, 1] - c[1], o[:, 0] - c[0]), 2 * np.pi)
        ai = np.mod(np.arctan2(i_[:, 1] - c[1], i_[:, 0] - c[0]), 2 * np.pi)
        so, si = np.argsort(ao), np.argsort(ai)
        o, ao = o[so], ao[so]
        i_, ai = i_[si], ai[si]
        No, Ni = len(o), len(i_)
        # Each outer edge takes the inner vertex nearest (in angle) to its
        # mid-angle; the inner chords between two consecutive picks fan from
        # the shared outer vertex. Pairing by nearest angle (instead of a
        # plain merge) keeps every triangle on the outward side of the inner
        # chord it uses, which a merge does not guarantee when the outer loop
        # is coarse (a 4-corner cell) and the inner loop is fine (a hole).
        picks = []
        for k in range(No):
            gap = (ao[(k + 1) % No] - ao[k]) % (2 * np.pi)
            beta = (ao[k] + gap / 2) % (2 * np.pi)
            d = np.abs((ai - beta + np.pi) % (2 * np.pi) - np.pi)
            picks.append(int(np.argmin(d)))
        for k in range(No):
            k1 = (k + 1) % No
            self.tri2d(o[k], o[k1], i_[picks[k]], z, up)
            j = picks[k]
            steps = (picks[k1] - picks[k]) % Ni
            for _ in range(steps):
                self.tri2d(o[k1], i_[j], i_[(j + 1) % Ni], z, up)
                j = (j + 1) % Ni

    def cap_polygon(self, poly, z, up=True):
        """Cap a simple (possibly concave) polygon by ear clipping."""
        for a, b, c in earclip(np.asarray(poly, float)):
            self.tri2d(a, b, c, z, up)

    # — walls —
    def band(self, lower, upper, inward=False):
        """Wall between two loops with the SAME vertex count (lower at smaller z).

        Loops are CCW seen from +z. `inward=False` → outward normals (outer
        wall); `inward=True` → normals point into the loop (hole / pocket wall).
        """
        lo = np.asarray(lower, float)
        up = np.asarray(upper, float)
        n = len(lo)
        for i in range(n):
            j = (i + 1) % n
            if inward:
                self.quad(lo[i], up[i], up[j], lo[j])
            else:
                self.quad(lo[i], lo[j], up[j], up[i])

    def wall_segment(self, p0, p1, z0, z1, outward_dir):
        """Vertical quad along the XY segment p0→p1 between z0 and z1, normal toward outward_dir."""
        a = np.r_[p0, z0]
        b = np.r_[p1, z0]
        c = np.r_[p1, z1]
        d = np.r_[p0, z1]
        n = np.cross(b - a, d - a)
        if np.dot(n[:2], outward_dir) >= 0:
            self.quad(a, b, c, d)
        else:
            self.quad(a, d, c, b)

    # — bookkeeping —
    def write_binary_stl(self, path, name="vet-part"):
        T = np.array(self.tris)  # (n,3,3)
        n = len(T)
        v0, v1, v2 = T[:, 0], T[:, 1], T[:, 2]
        nrm = np.cross(v1 - v0, v2 - v0)
        ln = np.linalg.norm(nrm, axis=1, keepdims=True)
        ln[ln == 0] = 1
        nrm = nrm / ln
        rec = np.zeros(n, dtype=[("n", "<f4", 3), ("v", "<f4", (3, 3)), ("attr", "<u2")])
        rec["n"] = nrm
        rec["v"] = T
        with open(path, "wb") as f:
            f.write(name.encode("ascii")[:80].ljust(80, b"\0"))
            f.write(struct.pack("<I", n))
            f.write(rec.tobytes())

    def stats(self):
        """Signed volume, surface area, closure check (every edge used twice, opposite directions)."""
        T = np.array(self.tris)
        v0, v1, v2 = T[:, 0], T[:, 1], T[:, 2]
        cross = np.cross(v1 - v0, v2 - v0)
        area = 0.5 * np.linalg.norm(cross, axis=1).sum()
        vol = np.einsum("ij,ij->i", v0, np.cross(v1, v2)).sum() / 6.0
        key = np.round(T.reshape(-1, 3), 5)
        _, idx = np.unique(key, axis=0, return_inverse=True)
        idx = idx.reshape(-1, 3)
        edges = {}
        for a, b, c in idx:
            for p, q in ((a, b), (b, c), (c, a)):
                edges[(p, q)] = edges.get((p, q), 0) + 1
        bad = 0
        for (p, q), cnt in edges.items():
            if cnt != 1 or edges.get((q, p), 0) != 1:
                bad += 1
        return {"volume": float(vol), "area": float(area), "triangles": int(len(T)), "open_edges": int(bad)}


# ─────────────────────────────────────────────────────────────────────────────
# 2D loops (all CCW, Nx2)
# ─────────────────────────────────────────────────────────────────────────────
def circle(r, n=48, cx=0.0, cy=0.0):
    t = np.linspace(0, 2 * np.pi, n, endpoint=False)
    return np.c_[cx + r * np.cos(t), cy + r * np.sin(t)]


def rect(w, h, cx=0.0, cy=0.0):
    return np.array([[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]])


def rounded_rect(w, h, r, n_corner=8, cx=0.0, cy=0.0):
    r = min(r, w / 2, h / 2)
    pts = []
    corners = [(w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, np.pi / 2), (-w / 2 + r, -h / 2 + r, np.pi), (w / 2 - r, -h / 2 + r, 1.5 * np.pi)]
    for x, y, a0 in corners:
        for t in np.linspace(a0, a0 + np.pi / 2, n_corner + 1):
            pts.append([x + r * np.cos(t), y + r * np.sin(t)])
    p = np.array(pts)
    p = p[np.r_[True, np.linalg.norm(np.diff(p, axis=0), axis=1) > 1e-9]]
    if np.linalg.norm(p[0] - p[-1]) < 1e-9:
        p = p[:-1]
    return p + [cx, cy]


def stadium(length, width, n=12, cx=0.0, cy=0.0):
    """Slot outline (full-round ends), long axis along X."""
    return rounded_rect(length, width, width / 2, n_corner=n, cx=cx, cy=cy)


def polar_loop(r_of_theta, n=360):
    t = np.linspace(0, 2 * np.pi, n, endpoint=False)
    r = np.array([r_of_theta(tt) for tt in t])
    return np.c_[r * np.cos(t), r * np.sin(t)]


def star_wheel_loop(R, notch_r, notches, n=720):
    """Disc of radius R with `notches` semicircular notches of radius notch_r cut in from the rim."""
    centers = [2 * np.pi * k / notches for k in range(notches)]

    def r_of(th):
        for c in centers:
            d = (th - c + np.pi) % (2 * np.pi) - np.pi
            s = R * math.sin(d)
            if abs(s) < notch_r and abs(d) < math.pi / 2:
                return R * math.cos(d) - math.sqrt(notch_r ** 2 - s ** 2)
        return R
    return polar_loop(r_of, n)


def gear_loop(r_root, r_tip, teeth, n_per_tooth=16):
    """Trapezoidal-tooth spur gear outline (good enough to look like a gear to a mesh parser)."""
    pts = []
    pitch = 2 * np.pi / teeth
    for k in range(teeth):
        base = k * pitch
        # fractions of the pitch: root flat, rising flank, tip flat, falling flank
        prof = [(0.00, r_root), (0.25, r_root), (0.35, r_tip), (0.65, r_tip), (0.75, r_root), (1.0, r_root)]
        for (f0, r0), (f1, r1) in zip(prof[:-1], prof[1:]):
            for s in np.linspace(0, 1, max(2, n_per_tooth // 5), endpoint=False):
                f = f0 + (f1 - f0) * s
                r = r0 + (r1 - r0) * s
                pts.append([r * math.cos(base + f * pitch), r * math.sin(base + f * pitch)])
    return np.array(pts)


def perimeter(loop):
    p = np.asarray(loop, float)
    return float(np.linalg.norm(np.roll(p, -1, axis=0) - p, axis=1).sum())


def loop_area(loop):
    p = np.asarray(loop, float)
    x, y = p[:, 0], p[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


# ─────────────────────────────────────────────────────────────────────────────
# Ear clipping for simple polygons (used for the U-profile extrusion only)
# ─────────────────────────────────────────────────────────────────────────────
def earclip(poly):
    pts = [tuple(p) for p in poly]
    if loop_area(poly) < 0:
        pts.reverse()
    idx = list(range(len(pts)))
    tris = []

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    def inside(p, a, b, c):
        return cross(a, b, p) >= -1e-9 and cross(b, c, p) >= -1e-9 and cross(c, a, p) >= -1e-9

    guard = 0
    while len(idx) > 3 and guard < 10000:
        guard += 1
        n = len(idx)
        clipped = False
        for k in range(n):
            i0, i1, i2 = idx[(k - 1) % n], idx[k], idx[(k + 1) % n]
            a, b, c = pts[i0], pts[i1], pts[i2]
            if cross(a, b, c) <= 1e-9:
                continue  # reflex or degenerate
            if any(inside(pts[j], a, b, c) for j in idx if j not in (i0, i1, i2)):
                continue
            tris.append((np.array(a), np.array(b), np.array(c)))
            idx.pop(k)
            clipped = True
            break
        if not clipped:
            raise RuntimeError("earclip: no ear found (polygon not simple?)")
    if len(idx) == 3:
        tris.append(tuple(np.array(pts[i]) for i in idx))
    return tris


# ─────────────────────────────────────────────────────────────────────────────
# Plate-with-features builder (grid of cells; each cell may own ONE feature)
# ─────────────────────────────────────────────────────────────────────────────
def build_plate(W, H, T, xcuts, ycuts, features):
    """Plate W×H×T (origin at the min corner), partitioned by xcuts/ycuts
    (sorted lists including 0 and W / 0 and H). `features` maps (ix, iy) →
    dict(kind=..., loop=Nx2 CCW in plate coords, ...). Returns (Mesh, truth)."""
    m = Mesh()
    truth = {"holes": 0, "slots": 0, "pockets": 0, "countersinks": 0, "cut_perimeter_mm": 2 * (W + H), "removed_mm3": 0.0}
    nx, ny = len(xcuts) - 1, len(ycuts) - 1
    for ix in range(nx):
        for iy in range(ny):
            x0, x1, y0, y1 = xcuts[ix], xcuts[ix + 1], ycuts[iy], ycuts[iy + 1]
            cell = np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], float)
            f = features.get((ix, iy))
            # outer walls on plate boundary
            if iy == 0:
                m.wall_segment(cell[0], cell[1], 0, T, (0, -1))
            if ix == nx - 1:
                m.wall_segment(cell[1], cell[2], 0, T, (1, 0))
            if iy == ny - 1:
                m.wall_segment(cell[2], cell[3], 0, T, (0, 1))
            if ix == 0:
                m.wall_segment(cell[3], cell[0], 0, T, (-1, 0))
            if f is None:
                m.cap_fan(cell, T, up=True)
                m.cap_fan(cell, 0, up=False)
                continue
            loop = np.asarray(f["loop"], float)
            ctr = np.mean(loop, axis=0)
            kind = f["kind"]
            A = abs(loop_area(loop))
            P = perimeter(loop)
            if kind == "hole" or kind == "slot":
                m.cap_annulus(cell, loop, T, up=True, center=ctr)
                m.cap_annulus(cell, loop, 0, up=False, center=ctr)
                m.band(np.c_[loop, np.zeros(len(loop))], np.c_[loop, np.full(len(loop), T)], inward=True)
                truth["holes" if kind == "hole" else "slots"] += 1
                truth["cut_perimeter_mm"] += P
                truth["removed_mm3"] += A * T
            elif kind == "csk":
                # countersink: cone from loop_top (bigger) at z=T down to loop at z=T-depth, then straight bore
                top = np.asarray(f["loop_top"], float)
                d = f["depth"]
                m.cap_annulus(cell, top, T, up=True, center=ctr)
                m.band(np.c_[loop, np.full(len(loop), T - d)], np.c_[top, np.full(len(top), T)], inward=True)
                m.band(np.c_[loop, np.zeros(len(loop))], np.c_[loop, np.full(len(loop), T - d)], inward=True)
                m.cap_annulus(cell, loop, 0, up=False, center=ctr)
                truth["holes"] += 1
                truth["countersinks"] += 1
                truth["cut_perimeter_mm"] += P
                r1, r2 = math.sqrt(A / math.pi), math.sqrt(abs(loop_area(top)) / math.pi)
                truth["removed_mm3"] += A * (T - d) + math.pi * d / 3 * (r1 ** 2 + r1 * r2 + r2 ** 2)
            elif kind == "pocket":
                d = f["depth"]
                m.cap_annulus(cell, loop, T, up=True, center=ctr)
                m.band(np.c_[loop, np.full(len(loop), T - d)], np.c_[loop, np.full(len(loop), T)], inward=True)
                m.cap_fan(loop, T - d, up=True, center=ctr)
                m.cap_fan(cell, 0, up=False)
                truth["pockets"] += 1
                truth["cut_perimeter_mm"] += P
                truth["removed_mm3"] += A * d
            else:
                raise ValueError(kind)
    return m, truth


def build_ring_body(outer, inner, T, chamfer=0.0, via=None):
    """Disc / turned body: outer loop, inner bore loop, thickness T along Z.
    Optional OD chamfer (45°) on both ends when outer is a circle (same N).
    `via` is an optional intermediate loop the caps are zippered through
    (outer→via→inner) so a concave outline (notched disc, gear) never has to
    pair directly with a small bore."""
    m = Mesh()
    outer = np.asarray(outer, float)
    inner = np.asarray(inner, float)
    if chamfer > 0:
        # outer is a circle of radius r centred at 0 → shrink radially by chamfer
        r = np.linalg.norm(outer, axis=1)
        small = outer * ((r - chamfer) / r)[:, None]
        z = lambda v, zz: np.c_[v, np.full(len(v), zz)]
        m.band(z(small, 0), z(outer, chamfer))
        m.band(z(outer, chamfer), z(outer, T - chamfer))
        m.band(z(outer, T - chamfer), z(small, T))
        cap_outer = small
    else:
        z = lambda v, zz: np.c_[v, np.full(len(v), zz)]
        m.band(z(outer, 0), z(outer, T))
        cap_outer = outer
    if inner is not None and len(inner):
        if via is not None:
            m.cap_annulus(cap_outer, via, T, up=True, center=(0, 0))
            m.cap_annulus(cap_outer, via, 0, up=False, center=(0, 0))
            m.cap_annulus(via, inner, T, up=True, center=(0, 0))
            m.cap_annulus(via, inner, 0, up=False, center=(0, 0))
        else:
            m.cap_annulus(cap_outer, inner, T, up=True, center=(0, 0))
            m.cap_annulus(cap_outer, inner, 0, up=False, center=(0, 0))
        m.band(z(inner, 0), z(inner, T), inward=True)
    else:
        m.cap_fan(cap_outer, T, up=True, center=(0, 0))
        m.cap_fan(cap_outer, 0, up=False, center=(0, 0))
    return m


def build_saddle_clamp(W, L, Hh, R, hole_d, n_arc=32):
    """U-block: W (x) × L (y) × Hh (z) with a half-round channel of radius R along Y cut
    into the top, and one vertical through hole in each foot."""
    m = Mesh()
    # feet: x ∈ [-W/2, -R] and [R, W/2], full height, each with one hole
    for sgn in (-1, 1):
        xa, xb = (sgn * R, sgn * W / 2)
        x0, x1 = min(xa, xb), max(xa, xb)
        cell = np.array([[x0, 0], [x1, 0], [x1, L], [x0, L]], float)
        hole = circle(hole_d / 2, 40, cx=(x0 + x1) / 2, cy=L / 2)
        m.cap_annulus(cell, hole, Hh, up=True)
        m.cap_annulus(cell, hole, 0, up=False)
        m.band(np.c_[hole, np.zeros(len(hole))], np.c_[hole, np.full(len(hole), Hh)], inward=True)
        m.wall_segment(cell[0], cell[1], 0, Hh, (0, -1))
        m.wall_segment(cell[2], cell[3], 0, Hh, (0, 1))
        if sgn > 0:
            m.wall_segment(cell[1], cell[2], 0, Hh, (1, 0))
        else:
            m.wall_segment(cell[3], cell[0], 0, Hh, (-1, 0))
    # middle: profile in XZ: (-R,0) → (R,0) → (R,Hh) → arc down into channel → (-R,Hh)
    arc = [(R * math.cos(t), Hh - R * math.sin(t)) for t in np.linspace(0, np.pi, n_arc + 1)]
    prof = [(-R, 0.0), (R, 0.0)] + arc  # arc runs from (R,Hh) to (-R,Hh) via the channel bottom
    prof = np.array(prof, float)
    # front cap (y=0, normal -y) and back cap (y=L, normal +y). Use XZ ear clipping.
    for (a, b, c) in earclip(prof):
        A, B, C = (np.array([a[0], 0.0, a[1]]), np.array([b[0], 0.0, b[1]]), np.array([c[0], 0.0, c[1]]))
        n = np.cross(B - A, C - A)
        if n[1] > 0:
            B, C = C, B
        m.tri(A, B, C)
        A, B, C = (np.array([a[0], L, a[1]]), np.array([b[0], L, b[1]]), np.array([c[0], L, c[1]]))
        n = np.cross(B - A, C - A)
        if n[1] < 0:
            B, C = C, B
        m.tri(A, B, C)
    # walls along profile edges except the two vertical edges at x=±R (internal to the feet)
    np_ = len(prof)
    for i in range(np_):
        p0, p1 = prof[i], prof[(i + 1) % np_]
        if abs(p0[0] - p1[0]) < 1e-9 and abs(abs(p0[0]) - R) < 1e-9:
            continue  # vertical edge at x=±R → shared with a foot, omit
        a = np.array([p0[0], 0.0, p0[1]])
        b = np.array([p1[0], 0.0, p1[1]])
        c = np.array([p1[0], L, p1[1]])
        d = np.array([p0[0], L, p0[1]])
        # outward normal: the bottom edge faces -z; every channel-arc edge faces the
        # channel axis (0, Hh) because the material lies outside the half-round.
        n = np.cross(b - a, d - a)
        mid = (a + b) / 2
        want = np.array([0.0, 0.0, -1.0]) if i == 0 else np.array([0.0 - mid[0], 0.0, Hh - mid[2]])
        if np.dot(n, want) < 0:
            m.quad(a, d, c, b)
        else:
            m.quad(a, b, c, d)
    vol = W * L * Hh - 0.5 * math.pi * R ** 2 * L - 2 * math.pi * (hole_d / 2) ** 2 * Hh
    return m, vol


# ─────────────────────────────────────────────────────────────────────────────
# Part definitions
# ─────────────────────────────────────────────────────────────────────────────
QTYS = (1, 10, 25, 100, 250)


def cfg(process, material, sub="", thickness=None, finish=None, label=None):
    return {"process": process, "materialSlug": material, "subProcess": sub,
            "thicknessMm": thickness, "finishSlug": finish, "label": label or f"{process}:{material}" + (f"@{thickness}" if thickness else "")}


def make_parts():
    parts = []

    # 1. flat plate with hole pattern — 150 × 100 × 6.35 mm, 6 × Ø6.6 through holes
    W, H, T = 150.0, 100.0, 6.35
    xs, ys = [0, 50, 100, 150], [0, 50, 100]
    feats = {(ix, iy): {"kind": "hole", "loop": circle(3.3, 40, cx=xs[ix] + 25, cy=ys[iy] + 25)} for ix in range(3) for iy in range(2)}
    m, truth = build_plate(W, H, T, xs, ys, feats)
    vol = W * H * T - truth["removed_mm3"]
    parts.append(dict(
        id="plate_hole_pattern", mesh=m, bbox=[W, H, T], volume=vol, truth=truth,
        family="flat-sheet", hand_sized=True,
        description='Flat plate 150 × 100 × 1/4" with six Ø6.6 mm (M6 clearance) through holes. The bread-and-butter router part.',
        configs=[cfg("routing", "rt-hdpe", "sheet", 6.35), cfg("routing", "rt-delrin", "sheet", 6.35),
                 cfg("cnc", "cnc-delrin", "milling"), cfg("cnc", "cnc-hdpe", "milling")],
        expected={
            "routing": shop_estimate(15, 1.0, 0.5, material_cost(W * H * T, "hdpe", 1.5)),
            "cnc": shop_estimate(30, 6.0, 1.0, material_cost(W * H * T, "delrin", 1.4)),
        },
        reasoning=("Router: 500 mm profile + 6 holes at ~2,700 mm/min (1/4\" O-flute, 0.006\"/tooth × 18k RPM) ≈ 1 min "
                   "cycle, 15 min nest/setup. Mill: vise, 3/8\" 2-flute at 5,140 RPM, profile + spot/drill 6 holes ≈ 6 min, 30 min setup.")))

    # 2. pocketed tray — 200 × 150 × 19.05 mm, pocket 170 × 120 × 12.7 deep, R6 corners
    W, H, T = 200.0, 150.0, 19.05
    feats = {(0, 0): {"kind": "pocket", "loop": rounded_rect(170, 120, 6, 8, cx=100, cy=75), "depth": 12.7}}
    m, truth = build_plate(W, H, T, [0, W], [0, H], feats)
    vol = W * H * T - truth["removed_mm3"]
    parts.append(dict(
        id="pocketed_tray", mesh=m, bbox=[W, H, T], volume=vol, truth=truth,
        family="pocket-plate", hand_sized=False,
        description='Pocketed tray 200 × 150 × 3/4", one 170 × 120 pocket 1/2" deep with R6 corners (the "disc stack tray" shape the shop runs in HDPE).',
        configs=[cfg("routing", "rt-hdpe", "sheet", 19.1), cfg("cnc", "cnc-hdpe", "milling"), cfg("cnc", "cnc-delrin", "milling")],
        expected={
            "routing": shop_estimate(20, 9.0, 0.5, material_cost(W * H * T, "hdpe", 1.5)),
            "cnc": shop_estimate(30, 14.0, 1.0, material_cost(W * H * T, "hdpe", 1.4)),
        },
        reasoning=("Pocket removes 259 cm³. Router 3/8\" O-flute, 6 mm DOC, 50 % stepover at 3,600 mm/min ≈ 7 min "
                   "roughing + 1.5 min profile = ~9 min. Tormach adaptive in HDPE ≈ 14 cm³/min → ~13 min + profile ≈ 14 min.")))

    # 3. conveyor guide rail — 600 × 25 × 12.7 mm UHMW, 6 countersunk Ø6.6 holes
    W, H, T = 600.0, 25.0, 12.7
    xs = [0, 100, 200, 300, 400, 500, 600]
    feats = {(ix, 0): {"kind": "csk", "loop": circle(3.3, 32, cx=xs[ix] + 50, cy=12.5),
                       "loop_top": circle(6.5, 32, cx=xs[ix] + 50, cy=12.5), "depth": 3.2} for ix in range(6)}
    m, truth = build_plate(W, H, T, xs, [0, H], feats)
    vol = W * H * T - truth["removed_mm3"]
    parts.append(dict(
        id="conveyor_guide_rail", mesh=m, bbox=[W, H, T], volume=vol, truth=truth,
        family="flat-sheet", hand_sized=False,
        description='UHMW conveyor guide rail 600 × 25 × 1/2" with six countersunk Ø6.6 mm holes (flat-head M6). Longer than the Tormach X travel (457 mm).',
        configs=[cfg("routing", "rt-uhmw", "sheet", 12.7), cfg("cnc", "cnc-uhmw", "milling")],
        expected={
            "routing": shop_estimate(15, 2.5, 0.5, material_cost(W * H * T, "uhmw", 1.5)),
            "cnc": shop_estimate(45, 10.0, 2.0, material_cost(W * H * T, "uhmw", 1.4)),
        },
        reasoning=("Router: 1,250 mm profile, 2 passes at 6 mm, 2,700 mm/min ≈ 1 min + 6 csk holes (drill + csk tool change) ≈ 2.5 min. "
                   "Mill: 600 mm exceeds X travel — would need two indexed setups (45 min setup, ~10 min cycle). Should be an RFQ or a router job.")))

    # 4. wear strip — 300 × 40 × 9.5 mm UHMW, 4 slots 25 × 7
    W, H, T = 300.0, 40.0, 9.525
    xs = [0, 75, 150, 225, 300]
    feats = {(ix, 0): {"kind": "slot", "loop": stadium(25, 7, 10, cx=xs[ix] + 37.5, cy=20)} for ix in range(4)}
    m, truth = build_plate(W, H, T, xs, [0, H], feats)
    vol = W * H * T - truth["removed_mm3"]
    parts.append(dict(
        id="wear_strip", mesh=m, bbox=[W, H, T], volume=vol, truth=truth,
        family="flat-sheet", hand_sized=False,
        description='UHMW wear strip 300 × 40 × 3/8" with four 25 × 7 mm adjustment slots.',
        configs=[cfg("routing", "rt-uhmw", "sheet", 9.5), cfg("cnc", "cnc-uhmw", "milling")],
        expected={
            "routing": shop_estimate(15, 1.2, 0.5, material_cost(W * H * T, "uhmw", 1.5)),
            "cnc": shop_estimate(30, 7.0, 1.0, material_cost(W * H * T, "uhmw", 1.4)),
        },
        reasoning="Router: 680 mm profile + 4 slots (≈ 240 mm) in 2 passes at 2,700 mm/min ≈ 0.7 min + handling. Mill: single vise setup, 1/4\" endmill, ~7 min.",
    ))

    # 5. star wheel — Ø150 × 12.7 Delrin, 8 notches R10, bore Ø25
    outer = star_wheel_loop(75, 10, 8, 720)
    bore = circle(12.5, 48)
    m = build_ring_body(outer, bore, 12.7, via=circle(55, 720))
    st = m.stats()
    truth = {"holes": 1, "slots": 0, "pockets": 0, "countersinks": 0, "cut_perimeter_mm": perimeter(outer) + perimeter(bore), "notches": 8}
    parts.append(dict(
        id="star_wheel", mesh=m, bbox=[150, 150, 12.7], volume=st["volume"], truth=truth,
        family="flat-sheet", hand_sized=True,
        description='Star wheel / notched disc Ø150 × 1/2" Delrin, 8 semicircular notches R10, Ø25 bore. A packaging-line timing part.',
        configs=[cfg("routing", "rt-delrin", "sheet", 12.7), cfg("cnc", "cnc-delrin", "milling")],
        expected={
            "routing": shop_estimate(15, 2.0, 0.5, material_cost(150 * 150 * 12.7, "delrin", 1.5)),
            "cnc": shop_estimate(30, 9.0, 1.0, material_cost(150 * 150 * 12.7, "delrin", 1.4)),
        },
        reasoning="Router: ~600 mm profile incl. notches, 3 passes in acetal (medium) at ~2,700 mm/min ≈ 1 min + bore. Mill: fixture plate, 3/8\" endmill, profile + bore ≈ 9 min.",
    ))

    # 6. bracket block — 100 × 60 × 25, pocket 50 × 30 × 10 deep, 4 × Ø5 tap-drill holes through
    W, H, T = 100.0, 60.0, 25.0
    xs, ys = [0, 20, 80, 100], [0, 15, 45, 60]
    feats = {(1, 1): {"kind": "pocket", "loop": rounded_rect(50, 24, 5, 8, cx=50, cy=30), "depth": 10}}
    for ix, iy in ((0, 0), (0, 2), (2, 0), (2, 2)):
        feats[(ix, iy)] = {"kind": "hole", "loop": circle(2.5, 32, cx=(xs[ix] + xs[ix + 1]) / 2, cy=(ys[iy] + ys[iy + 1]) / 2)}
    m, truth = build_plate(W, H, T, xs, ys, feats)
    vol = W * H * T - truth["removed_mm3"]
    parts.append(dict(
        id="bracket_block", mesh=m, bbox=[W, H, T], volume=vol, truth=truth,
        family="machined-block", hand_sized=True,
        description="Machined bracket 100 × 60 × 25 mm: 50 × 24 × 10 pocket (R5) and four Ø5 (M6 tap-drill) through holes, tapped by hand.",
        configs=[cfg("cnc", "cnc-delrin", "milling"), cfg("cnc", "cnc-peek", "milling"), cfg("cnc", "cnc-aluminum-6061", "milling"),
                 cfg("cnc", "cnc-delrin", "milling", finish="cnc-deburr", label="cnc:cnc-delrin+deburr")],
        expected={
            "cnc": shop_estimate(40, 14.0, 1.5, material_cost(W * H * T, "delrin", 1.4), hand_min=4.0),
            "cnc-peek": shop_estimate(40, 18.0, 1.5, material_cost(W * H * T, "peek", 1.4), hand_min=4.0),
            "cnc-aluminum": shop_estimate(40, 22.0, 1.5, material_cost(W * H * T, "aluminum", 1.4), hand_min=5.0),
        },
        reasoning=("One vise setup. Face, pocket 12 cm³ adaptive (3/8\" 2-flute Delrin ≈ 14 cm³/min → ~2 min), finish walls/floor, "
                   "spot + drill 4 holes, chamfer, profile: ~14 min Delrin, ~22 min 6061 (1.5 hp, chip-load limited). Tap 4 × M6 by hand ≈ 4 min. PEEK stock ≈ $45 for this blank."),
    ))

    # 7. saddle clamp — 80 × 50 × 40, R16 channel, 2 × Ø8.5 holes
    m, vol = build_saddle_clamp(80, 50, 40, 16, 8.5)
    truth = {"holes": 2, "slots": 0, "pockets": 0, "countersinks": 0, "channel": "R16 half-round", "cut_perimeter_mm": 2 * (80 + 50) + math.pi * 16 * 1 + 2 * math.pi * 8.5}
    parts.append(dict(
        id="saddle_clamp", mesh=m, bbox=[80, 50, 40], volume=vol, truth=truth,
        family="machined-block", hand_sized=True,
        description="Saddle clamp / U-block 80 × 50 × 40 mm with an R16 half-round channel along its length and two Ø8.5 through bolt holes.",
        configs=[cfg("cnc", "cnc-uhmw", "milling"), cfg("cnc", "cnc-delrin", "milling"), cfg("cnc", "cnc-nylon", "milling")],
        expected={"cnc": shop_estimate(35, 12.0, 1.5, material_cost(80 * 50 * 40, "uhmw", 1.4))},
        reasoning="One vise setup: channel with a ball/bull-nose or stepped adaptive (20 cm³), two drilled holes, profile. ~12 min cycle.",
    ))

    # 8. bushing — Ø40 × 30, bore Ø25, 1 mm chamfers (turned)
    m = build_ring_body(circle(20, 64), circle(12.5, 48), 30, chamfer=1.0)
    st = m.stats()
    truth = {"holes": 1, "slots": 0, "pockets": 0, "countersinks": 0, "cut_perimeter_mm": 0}
    parts.append(dict(
        id="bushing", mesh=m, bbox=[40, 40, 30], volume=st["volume"], truth=truth,
        family="turned", hand_sized=True,
        description="Flanged-less bushing Ø40 × 30 mm, Ø25 bore, 1 mm × 45° chamfers both ends. Manual lathe work.",
        configs=[cfg("cnc", "cnc-delrin", "turning"), cfg("cnc", "cnc-ptfe", "turning"), cfg("cnc", "cnc-brass-360", "turning"),
                 cfg("cnc", "cnc-delrin", "milling", label="cnc:cnc-delrin(milling-for-comparison)")],
        expected={"cnc": shop_estimate(15, 8.0, 1.0, material_cost(math.pi * 20 ** 2 * 30, "delrin", 1.6))},
        reasoning="Manual lathe: chuck Ø40 rod, face, drill Ø24, bore to Ø25, chamfer, part off, flip to chamfer: ~8 min per piece; 15 min setup (tooling, stops).",
    ))

    # 9. roller — Ø50 × 200, bore Ø20 (turned, long)
    m = build_ring_body(circle(25, 64), circle(10, 48), 200, chamfer=1.0)
    st = m.stats()
    parts.append(dict(
        id="roller", mesh=m, bbox=[50, 50, 200], volume=st["volume"], truth=dict(truth),
        family="turned", hand_sized=False,
        description="Conveyor roller Ø50 × 200 mm, Ø20 through bore, chamfered ends. Long turned part — the bore needs a long drill / boring bar.",
        configs=[cfg("cnc", "cnc-uhmw", "turning"), cfg("cnc", "cnc-nylon", "turning"), cfg("cnc", "cnc-delrin", "turning")],
        expected={"cnc": shop_estimate(20, 18.0, 1.5, material_cost(math.pi * 25 ** 2 * 200, "uhmw", 1.5))},
        reasoning="Manual lathe: OD turn 200 mm (two passes), drill Ø20 × 200 deep from both ends (peck), chamfer, face: ~18 min.",
    ))

    # 10. spacer — Ø12 × 6, bore Ø6.5 (small turned)
    m = build_ring_body(circle(6, 48), circle(3.25, 32), 6)
    st = m.stats()
    parts.append(dict(
        id="spacer", mesh=m, bbox=[12, 12, 6], volume=st["volume"], truth=dict(truth),
        family="turned", hand_sized=True,
        description="Spacer Ø12 × 6 mm with Ø6.5 bore. Tiny turned part — minimum-price territory, usually made as a batch from one rod.",
        configs=[cfg("cnc", "cnc-delrin", "turning"), cfg("cnc", "cnc-aluminum-6061", "turning")],
        expected={"cnc": shop_estimate(10, 1.5, 0.3, material_cost(math.pi * 6 ** 2 * 6, "delrin", 2.0))},
        reasoning="Rod in collet: face, drill, part off ≈ 1.5 min each on a manual lathe with a stop; 10 min setup.",
    ))

    # 11. thin-wall housing — 120 × 80 × 40, 2.5 mm walls, 3 mm floor
    W, H, T = 120.0, 80.0, 40.0
    feats = {(0, 0): {"kind": "pocket", "loop": rounded_rect(115, 75, 4, 8, cx=60, cy=40), "depth": 37.0}}
    m, truth = build_plate(W, H, T, [0, W], [0, H], feats)
    vol = W * H * T - truth["removed_mm3"]
    parts.append(dict(
        id="thin_wall_housing", mesh=m, bbox=[W, H, T], volume=vol, truth=truth,
        family="enclosure", hand_sized=True,
        description="Open-top enclosure 120 × 80 × 40 mm, 2.5 mm walls, 3 mm floor. Natural 3D-print part; machining it from solid wastes 90 % of the block.",
        configs=[cfg("cnc", "cnc-delrin", "milling"), cfg("3d-printing", "fdm-abs", "fdm"), cfg("3d-printing", "sla-standard", "sla"), cfg("3d-printing", "fdm-pla", "fdm")],
        expected={
            "cnc": shop_estimate(40, 28.0, 1.5, material_cost(W * H * T, "delrin", 1.4)),
            "3d-printing": shop_estimate(5, 0.0, 10.0, material_cost(vol, "abs", 1.3), tooling=6.0 * 2.0),
        },
        reasoning=("Mill: 345 cm³ pocket, Delrin ≈ 14 cm³/min → 25 min + wall finish ≈ 28 min; thin walls need light passes. "
                   "FDM: ~60 g ABS, ~6 h print at $2/h machine cost (tooling field) + 10 min handling."),
    ))

    # 12. small clip — 20 × 10 × 3 with one Ø3 hole
    W, H, T = 20.0, 10.0, 3.0
    feats = {(0, 0): {"kind": "hole", "loop": circle(1.5, 24, cx=6, cy=5)}}
    m, truth = build_plate(W, H, T, [0, 12, 20], [0, H], feats)
    vol = W * H * T - truth["removed_mm3"]
    parts.append(dict(
        id="small_clip", mesh=m, bbox=[W, H, T], volume=vol, truth=truth,
        family="flat-sheet", hand_sized=True,
        description="Small retainer clip 20 × 10 × 3 mm with a Ø3 hole. Tiny part: minimum price and small-part retention (tabs) matter more than cycle time.",
        configs=[cfg("routing", "rt-delrin", "sheet", 3.2), cfg("cnc", "cnc-delrin", "milling"), cfg("3d-printing", "fdm-pla", "fdm")],
        expected={
            "routing": shop_estimate(15, 0.3, 0.4, material_cost(W * H * T, "delrin", 3.0)),
            "cnc": shop_estimate(25, 2.0, 1.0, material_cost(W * H * T, "delrin", 3.0)),
            "3d-printing": shop_estimate(5, 0.0, 2.0, 0.05, tooling=0.3),
        },
        reasoning="Router: 60 mm profile + hole ≈ 20 s plus de-tab. Mill: too small to hold well; fixture on tape/sacrificial plate, ~2 min.",
    ))

    # 13. gear disc — Ø80 × 10, 24 teeth, Ø12 bore
    outer = gear_loop(36, 40, 24, 20)
    bore = circle(6, 40)
    m = build_ring_body(outer, bore, 10, via=circle(28, len(outer)))
    st = m.stats()
    truth = {"holes": 1, "slots": 0, "pockets": 0, "countersinks": 0, "cut_perimeter_mm": perimeter(outer) + perimeter(bore), "teeth": 24}
    parts.append(dict(
        id="gear_disc", mesh=m, bbox=[80, 80, 10], volume=st["volume"], truth=truth,
        family="flat-sheet", hand_sized=True,
        description="Gear-like disc Ø80 × 10 mm, 24 trapezoidal teeth, Ø12 bore. Lots of short edges — a profile-length stress test.",
        configs=[cfg("routing", "rt-delrin", "sheet", 9.5), cfg("cnc", "cnc-delrin", "milling"), cfg("3d-printing", "fdm-nylon", "fdm")],
        expected={
            "routing": shop_estimate(15, 2.5, 0.5, material_cost(80 * 80 * 10, "delrin", 1.5)),
            "cnc": shop_estimate(30, 10.0, 1.0, material_cost(80 * 80 * 10, "delrin", 1.4)),
            "3d-printing": shop_estimate(5, 0.0, 5.0, material_cost(st["volume"], "abs", 1.3), tooling=3.0),
        },
        reasoning="Router: ~430 mm of toothed profile needs a 1/8\" tool for the root radius → slower feed (~1,500 mm/min), 2 passes ≈ 1 min + bore. Mill: 1/8\" endmill on a fixture plate, ~10 min.",
    ))

    # 14. oversize panel — 2600 × 300 × 12.7 HDPE with 4 holes (longer than the 96" bed)
    W, H, T = 2600.0, 300.0, 12.7
    xs = [0, 650, 1300, 1950, 2600]
    feats = {(ix, 0): {"kind": "hole", "loop": circle(5, 32, cx=xs[ix] + 325, cy=150)} for ix in range(4)}
    m, truth = build_plate(W, H, T, xs, [0, H], feats)
    vol = W * H * T - truth["removed_mm3"]
    parts.append(dict(
        id="oversize_panel", mesh=m, bbox=[W, H, T], volume=vol, truth=truth,
        family="flat-sheet", hand_sized=False, expect_gate=True,
        description='Oversize HDPE panel 2600 × 300 × 1/2" with four Ø10 holes. Longer than the 96" (2438 mm) router bed — must trip the bed-size FAIL and RFQ gate.',
        configs=[cfg("routing", "rt-hdpe", "sheet", 12.7), cfg("cnc", "cnc-hdpe", "milling")],
        expected={"routing": shop_estimate(30, 6.0, 2.0, material_cost(W * H * T, "hdpe", 1.5))},
        reasoning="Not makeable in one piece on either machine; any instant price is a budgetary number and the quote must go to RFQ.",
    ))

    # 15. 20 mm cube — minimum-price case
    W = H = T = 20.0
    m, truth = build_plate(W, H, T, [0, W], [0, H], {})
    parts.append(dict(
        id="cube_20mm", mesh=m, bbox=[W, H, T], volume=W * H * T, truth=truth,
        family="machined-block", hand_sized=True,
        description="20 mm cube. Pure minimum-price / setup-amortisation case; a bandsaw-and-face job.",
        configs=[cfg("cnc", "cnc-delrin", "milling"), cfg("cnc", "cnc-aluminum-6061", "milling"), cfg("routing", "rt-delrin", "sheet", 19.1), cfg("3d-printing", "fdm-pla", "fdm")],
        expected={
            "cnc": shop_estimate(15, 3.0, 0.5, material_cost(W * H * T, "delrin", 2.0)),
            "routing": shop_estimate(15, 0.5, 0.4, material_cost(W * H * T, "delrin", 2.0)),
            "3d-printing": shop_estimate(5, 0.0, 2.0, 0.2, tooling=0.6),
        },
        reasoning="Saw a blank, face six sides in the vise: ~3 min. On the router from 3/4\" plate it is a 20 mm square with tabs — but the model is 20 mm thick, not 19.1.",
    ))

    # 16. drill fixture plate — 250 × 150 × 12.7, 5 × 4 grid of Ø8 holes (20 holes)
    W, H, T = 250.0, 150.0, 12.7
    xs = [0, 50, 100, 150, 200, 250]
    ys = [0, 37.5, 75, 112.5, 150]
    feats = {(ix, iy): {"kind": "hole", "loop": circle(4, 32, cx=xs[ix] + 25, cy=ys[iy] + 18.75)} for ix in range(5) for iy in range(4)}
    m, truth = build_plate(W, H, T, xs, ys, feats)
    vol = W * H * T - truth["removed_mm3"]
    parts.append(dict(
        id="drill_fixture_plate", mesh=m, bbox=[W, H, T], volume=vol, truth=truth,
        family="flat-sheet", hand_sized=False,
        description='Fixture plate 250 × 150 × 1/2" with a 5 × 4 grid of Ø8 holes (20 holes). Tests whether per-hole time scales with hole count.',
        configs=[cfg("routing", "rt-hdpe", "sheet", 12.7), cfg("routing", "rt-acrylic", "sheet", 12.7), cfg("routing", "rt-aluminum-6061", "sheet", 12.7),
                 cfg("cnc", "cnc-delrin", "milling"), cfg("cnc", "cnc-aluminum-6061", "milling")],
        expected={
            "routing": shop_estimate(15, 3.5, 0.5, material_cost(W * H * T, "hdpe", 1.5)),
            "cnc": shop_estimate(30, 12.0, 1.0, material_cost(W * H * T, "delrin", 1.4)),
            "cnc-aluminum": shop_estimate(30, 20.0, 1.0, material_cost(W * H * T, "aluminum", 1.4)),
        },
        reasoning="Router: 800 mm profile (2 passes) + 20 interpolated Ø8 holes (each ~25 mm cut + plunge) ≈ 3.5 min. Mill: spot + drill 20 holes (~20 s each) + profile ≈ 12 min Delrin / 20 min 6061.",
    ))

    # 17. PEEK seal ring — Ø60 × 8, bore Ø45, turned (expensive material, small volume)
    m = build_ring_body(circle(30, 64), circle(22.5, 48), 8, chamfer=0.5)
    st = m.stats()
    parts.append(dict(
        id="seal_ring_peek", mesh=m, bbox=[60, 60, 8], volume=st["volume"], truth={"holes": 1, "slots": 0, "pockets": 0, "countersinks": 0, "cut_perimeter_mm": 0},
        family="turned", hand_sized=True,
        description="Seal / backup ring Ø60 × 8 mm, Ø45 bore. Thin ring from Ø60 PEEK rod: material cost dominates, and a bbox-padded stock model over-counts it.",
        configs=[cfg("cnc", "cnc-peek", "turning"), cfg("cnc", "cnc-delrin", "turning"), cfg("cnc", "cnc-ptfe", "turning")],
        expected={"cnc": shop_estimate(15, 6.0, 1.0, material_cost(math.pi * 30 ** 2 * 10, "peek", 1.3)),
                  "cnc-delrin": shop_estimate(15, 6.0, 1.0, material_cost(math.pi * 30 ** 2 * 10, "delrin", 1.3))},
        reasoning="Lathe: face, drill, bore Ø45, part off at 8 mm + chamfer: ~6 min. PEEK Ø60 rod slice ≈ 10 mm long ≈ 29 g ≈ $3.70 at $130/kg — the ring itself is only 7 cm³.",
    ))

    return parts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "parts"))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    manifest = []
    ok = True
    for p in make_parts():
        m = p.pop("mesh")
        st = m.stats()
        fname = f"{p['id']}.stl"
        m.write_binary_stl(os.path.join(args.out, fname), p["id"])
        vol_err = abs(st["volume"] - p["volume"]) / max(p["volume"], 1e-9)
        closed = st["open_edges"] == 0 and st["volume"] > 0
        flag = "ok " if closed and vol_err < 0.02 else "BAD"
        if not closed:
            ok = False
        print(f"  {flag} {fname:28s} tris={st['triangles']:6d}  vol={st['volume']/1000:9.2f} cm³ (analytic {p['volume']/1000:9.2f})  area={st['area']/100:8.1f} cm²  open_edges={st['open_edges']}")
        p.update({"file": fname, "mesh_volume_mm3": st["volume"], "mesh_area_mm2": st["area"], "triangles": st["triangles"], "closed": closed})
        manifest.append(p)
    with open(os.path.join(args.out, "manifest.json"), "w") as f:
        json.dump({"units": "mm", "quantities": list(QTYS), "shopRatePerHour": SHOP_RATE_PER_HR, "margin": MARGIN, "parts": manifest}, f, indent=1)
    print(f"\n{len(manifest)} parts written to {args.out}  (manifest.json alongside)")
    if not ok:
        print("ERROR: at least one mesh is not closed", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
