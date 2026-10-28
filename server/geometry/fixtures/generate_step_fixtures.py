#!/usr/bin/env python3
"""
generate_step_fixtures.py — STEP test fixtures for server/geometry (B-rep path).

Requires cadquery (pip install cadquery). The committed .step files were made
with this script; re-run it only when a fixture needs to change.

Every fixture has analytic truth recorded in fixtures.json so geometry.test.js
can grade the B-rep path (holes with diameters, counterbore/countersink stacks,
pocket depth, bore, undercut).

Usage: python3 server/geometry/fixtures/generate_step_fixtures.py
"""
import json
import math
import os

import cadquery as cq

OUT = os.path.dirname(os.path.abspath(__file__))
fixtures = {}


def write(name, shape, truth):
    path = os.path.join(OUT, name + ".step")
    cq.exporters.export(shape, path, exportType="STEP")
    fixtures[name] = truth
    print("wrote", path)


# 1. Plate 120 x 80 x 8 with: 4 x D6.6 through holes, 1 x D5 blind hole 5 deep,
#    1 x counterbored hole (D6.6 thru, D11 cbore 6 deep), 1 x countersunk hole
#    (D6.6 thru, D13 csk at 90 deg).
plate = cq.Workplane("XY").box(120, 80, 8)
plate = (plate.faces(">Z").workplane()
         .pushPoints([(-45, -25), (45, -25), (-45, 25), (45, 25)]).hole(6.6))
plate = plate.faces(">Z").workplane().pushPoints([(0, 25)]).hole(5.0, depth=5.0)
plate = plate.faces(">Z").workplane().pushPoints([(-20, 0)]).cboreHole(6.6, 11.0, 6.0)
plate = plate.faces(">Z").workplane().pushPoints([(20, 0)]).cskHole(6.6, 13.0, 90)
write("plate_holes", plate, {
    "bbox": [120, 80, 8],
    "holes": 7,
    "through": 6,
    "blind": 1,
    "counterbored": 1,
    "countersunk": 1,
    "diameters": [6.6, 6.6, 6.6, 6.6, 5.0, 6.6, 6.6],
    "blindDepth": 5.0,
    "cboreDiameter": 11.0,
    "cboreDepth": 6.0,
    "cskDiameter": 13.0,
    "pockets": 0,
})

# 2. Tube OD 40, ID 25, length 60 (revolved, bore).
tube = cq.Workplane("XY").circle(20).circle(12.5).extrude(60)
write("tube", tube, {"bbox": [40, 40, 60], "od": 40, "bore": 25, "length": 60, "holes": 1, "revolved": True})

# 3. Pocketed tray 150 x 100 x 20, pocket 120 x 70 x 12 deep with R8 corners.
tray = cq.Workplane("XY").box(150, 100, 20)
tray = tray.faces(">Z").workplane().sketch().rect(120, 70).vertices().fillet(8).finalize().cutBlind(-12)
pocket_area = 120 * 70 - (4 - math.pi) * 8 ** 2
write("tray", tray, {
    "bbox": [150, 100, 20], "pockets": 1, "pocketDepth": 12.0, "pocketArea": pocket_area,
    "pocketCornerRadius": 8.0, "holes": 0,
})

# 4. Block with a closed T-slot (true undercut): 60 x 60 x 30, neck 10 wide x 30
#    long x 8 deep from the top, cavity 20 wide x 40 long x 8 deep under it. The
#    cavity ceiling (20 x 40 - 10 x 30 = 500 mm2) is reachable from no axis direction.
block = cq.Workplane("XY").box(60, 60, 30)
neck = cq.Workplane("XY").box(10, 30, 8.001).translate((0, 0, 15 - 4))
cavity = cq.Workplane("XY").box(20, 40, 8).translate((0, 0, 15 - 8 - 4))
block = block.cut(neck).cut(cavity)
total_area = (3600 - 300) + 3600 + 4 * 60 * 30 + 2 * (30 * 8 + 10 * 8) + 500 + 2 * (40 * 8 + 20 * 8) + 20 * 40
write("tslot_block", block, {"bbox": [60, 60, 30], "undercut": True, "undercutArea": 500, "surfaceArea": total_area, "holes": 0})

# 5. Boss plate: 80 x 60 x 6 plate with a D20 x 10 tall boss and a D8 hole through the boss.
boss = cq.Workplane("XY").box(80, 60, 6)
boss = boss.faces(">Z").workplane().circle(10).extrude(10)
boss = boss.faces(">Z").workplane().hole(8.0)
write("boss_plate", boss, {"bbox": [80, 60, 16], "bosses": 1, "bossDiameter": 20, "bossHeight": 10, "holes": 1, "holeDiameter": 8.0, "holeDepth": 16.0})

with open(os.path.join(OUT, "fixtures.json"), "w") as f:
    json.dump(fixtures, f, indent=1)
print("wrote fixtures.json")
