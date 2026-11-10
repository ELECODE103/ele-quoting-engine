#!/usr/bin/env python3
"""
generate_dxf_twins.py — STEP twins of the DXF parts in tools/vet-quotes/parts.

Each DXF part written by generate_dxf_parts.js has a STEP plate with the same
profile extruded to the thickness it is quoted at. run_vetting.js uploads both
and checks that the routed price of the DXF is within 2 % of the STEP's — the
DXF path must not price a part differently from the solid it describes.

Requires cadquery (pip install cadquery). The .step files are committed;
re-run this only when a profile in generate_dxf_parts.js changes (keep the
two files in step — the dimensions below mirror that script).

Usage: python3 tools/vet-quotes/generate_dxf_twins.py [--out tools/vet-quotes/parts]
"""
import argparse
import os

import cadquery as cq

ap = argparse.ArgumentParser()
ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "parts"))
OUT = ap.parse_args().out


def write(name, shape):
    path = os.path.join(OUT, name + ".step")
    cq.exporters.export(shape, path, exportType="STEP")
    print("wrote", path)


# 1. dxf_plate_holes — 150 x 100 plate, six D6.6 holes, 6.35 thick
p = cq.Workplane("XY").rect(150, 100).extrude(6.35)
p = p.faces(">Z").workplane().pushPoints([(x, y) for x in (-50, 0, 50) for y in (-25, 25)]).hole(6.6)
write("dxf_plate_holes", p)

# 2. dxf_slotted_guide — 200 x 80 with R10 corners, 60 x 12 slot, two D8.5 holes, 12.7 thick
g = cq.Workplane("XY").rect(200, 80).extrude(12.7).edges("|Z").fillet(10)
g = g.faces(">Z").workplane().slot2D(60, 12).cutThruAll()
g = g.faces(">Z").workplane().pushPoints([(-75, 0), (75, 0)]).hole(8.5)
write("dxf_slotted_guide", g)

# 3. dxf_bracket_window — L bracket 160 x 120 (legs 50 and 60 wide) with a square 30 x 30
#    window and two D9 holes, 9.5 thick. Sharp inside corners: needs the 1/8" tool.
b = (cq.Workplane("XY").polyline([(0, 0), (160, 0), (160, 50), (60, 50), (60, 120), (0, 120)]).close().extrude(9.5))
b = b.faces(">Z").workplane(origin=(30, 85, 0)).rect(30, 30).cutThruAll()
b = b.faces(">Z").workplane(origin=(0, 0, 0)).pushPoints([(30, 25), (130, 25)]).hole(9)
write("dxf_bracket_window", b)

# 4. dxf_inch_guard — 6 x 4 in panel, four D0.25 in holes 0.5 in from the corners, 1/4" thick (drawn in inches in the DXF)
i = 25.4
gd = cq.Workplane("XY").rect(6 * i, 4 * i).extrude(6.35)
gd = gd.faces(">Z").workplane().pushPoints([(sx * 2.5 * i, sy * 1.5 * i) for sx in (-1, 1) for sy in (-1, 1)]).hole(0.25 * i)
write("dxf_inch_guard", gd)
