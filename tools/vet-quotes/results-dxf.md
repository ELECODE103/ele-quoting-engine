# DXF parts — vetting run

From a full `run_vetting.js` run on branch dxf-routing (21 parts, 300 quotes, 0 sanity-check fails, 22 warnings — the same 22 as the pre-DXF baseline; no finding names a DXF part). Committed results.md/csv/json are left as they were.

## DXF vs STEP parity

Each DXF part is quoted next to a STEP plate of the same profile at the same thickness. The routed unit prices must agree within 2 % (`dxf-step-parity`). "floor" marks quantities where both hit the minimum part price, so they agree trivially.

| part | configuration | qty | DXF | STEP twin | difference |
|---|---|---|---|---|---|
| dxf_plate_holes | routing:rt-hdpe@6.35 | 1 | $64.07 | $64.07 | 0.00 % |
| dxf_plate_holes | routing:rt-hdpe@6.35 | 10 | $9.29 | $9.29 | 0.00 % |
| dxf_plate_holes | routing:rt-hdpe@6.35 | 25 | $6.00 | $6.00 | 0.00 % (floor) |
| dxf_plate_holes | routing:rt-hdpe@6.35 | 100 | $6.00 | $6.00 | 0.00 % (floor) |
| dxf_plate_holes | routing:rt-hdpe@6.35 | 250 | $6.00 | $6.00 | 0.00 % (floor) |
| dxf_plate_holes | routing:rt-delrin@6.35 | 1 | $66.04 | $66.04 | 0.00 % |
| dxf_plate_holes | routing:rt-delrin@6.35 | 10 | $11.07 | $11.07 | 0.00 % |
| dxf_plate_holes | routing:rt-delrin@6.35 | 25 | $7.41 | $7.41 | 0.00 % |
| dxf_plate_holes | routing:rt-delrin@6.35 | 100 | $6.00 | $6.00 | 0.00 % (floor) |
| dxf_plate_holes | routing:rt-delrin@6.35 | 250 | $6.00 | $6.00 | 0.00 % (floor) |
| dxf_slotted_guide | routing:rt-uhmw@12.7 | 1 | $66.20 | $66.20 | 0.00 % |
| dxf_slotted_guide | routing:rt-uhmw@12.7 | 10 | $11.21 | $11.21 | 0.01 % |
| dxf_slotted_guide | routing:rt-uhmw@12.7 | 25 | $7.54 | $7.54 | 0.01 % |
| dxf_slotted_guide | routing:rt-uhmw@12.7 | 100 | $6.00 | $6.00 | 0.00 % (floor) |
| dxf_slotted_guide | routing:rt-uhmw@12.7 | 250 | $6.00 | $6.00 | 0.00 % (floor) |
| dxf_slotted_guide | routing:rt-hdpe@12.7 | 1 | $65.68 | $65.68 | 0.00 % |
| dxf_slotted_guide | routing:rt-hdpe@12.7 | 10 | $10.74 | $10.74 | 0.01 % |
| dxf_slotted_guide | routing:rt-hdpe@12.7 | 25 | $7.10 | $7.10 | 0.01 % |
| dxf_slotted_guide | routing:rt-hdpe@12.7 | 100 | $6.00 | $6.00 | 0.00 % (floor) |
| dxf_slotted_guide | routing:rt-hdpe@12.7 | 250 | $6.00 | $6.00 | 0.00 % (floor) |
| dxf_bracket_window | routing:rt-delrin@9.5 | 1 | $71.70 | $71.70 | 0.00 % |
| dxf_bracket_window | routing:rt-delrin@9.5 | 10 | $16.16 | $16.16 | 0.00 % |
| dxf_bracket_window | routing:rt-delrin@9.5 | 25 | $12.22 | $12.22 | 0.01 % |
| dxf_bracket_window | routing:rt-delrin@9.5 | 100 | $9.06 | $9.06 | 0.01 % |
| dxf_bracket_window | routing:rt-delrin@9.5 | 250 | $8.22 | $8.22 | 0.01 % |
| dxf_inch_guard | routing:rt-polycarbonate@6.35 | 1 | $65.06 | $65.06 | 0.00 % |
| dxf_inch_guard | routing:rt-polycarbonate@6.35 | 10 | $10.18 | $10.18 | 0.00 % |
| dxf_inch_guard | routing:rt-polycarbonate@6.35 | 25 | $6.57 | $6.57 | 0.00 % |
| dxf_inch_guard | routing:rt-polycarbonate@6.35 | 100 | $6.00 | $6.00 | 0.00 % (floor) |
| dxf_inch_guard | routing:rt-polycarbonate@6.35 | 250 | $6.00 | $6.00 | 0.00 % (floor) |
| dxf_inch_guard | routing:rt-acrylic@6.35 | 1 | $64.83 | $64.83 | 0.00 % |
| dxf_inch_guard | routing:rt-acrylic@6.35 | 10 | $9.98 | $9.98 | 0.00 % |
| dxf_inch_guard | routing:rt-acrylic@6.35 | 25 | $6.38 | $6.38 | 0.00 % |
| dxf_inch_guard | routing:rt-acrylic@6.35 | 100 | $6.00 | $6.00 | 0.00 % (floor) |
| dxf_inch_guard | routing:rt-acrylic@6.35 | 250 | $6.00 | $6.00 | 0.00 % (floor) |

