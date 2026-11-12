/**
 * The admin order line: the full description, and NOT RECORDED for what a line does not carry.
 * Run: `node client/src/utils/orderLineCore.test.js`
 */
import assert from 'node:assert';
import { specFor } from './orderLineCore.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}
const labels = { cnc: 'CNC machining', routing: 'CNC routing', '3d-printing': '3D printing' };
const text = (item) => specFor(item, { labels }).parts.map((p) => p.text).join(' · ');

console.log('Admin order line');

test('a routed DXF line shows grade, stock thickness in both units, size, finish and quantity', () => {
  const line = text({
    fileName: 'guard-12x8in.dxf', process: 'routing', materialName: 'HDPE', finishName: 'As cut', quantity: 12,
    config: { process: 'routing', grade: 'HDPE — black', thicknessMm: 19.1, geometrySummary: { blankMm: { w: 311.2, h: 209.6, t: 19.1 } } },
  });
  for (const phrase of ['CNC routing', 'HDPE', 'grade HDPE — black', 'stock thickness 19.1 mm (0.752 in)', 'blank 311.2 × 209.6 mm (12.25 × 8.25 in)', 'finish As cut', 'qty 12']) assert.ok(line.includes(phrase), `${phrase} in: ${line}`);
  assert.ok(!line.includes('NOT RECORDED'));
});

test('a routed line with nothing in its config says what is missing, in order, and never leaves it out', () => {
  const spec = specFor({ fileName: 'plate.dxf', process: 'routing', materialName: 'UHMW', finishName: 'As cut', quantity: 4, config: {} }, { labels });
  assert.deepStrictEqual(spec.missing, ['grade', 'thickness', 'size']);
  const miss = spec.parts.filter((p) => p.missing).map((p) => p.text);
  assert.deepStrictEqual(miss, ['grade: NOT RECORDED — confirm with customer', 'thickness: NOT RECORDED — confirm with customer', 'size: NOT RECORDED — measure from the file']);
});

test('the buyer\'s own choices (config.input) are read when the line detail lacks them', () => {
  const line = text({ process: 'routing', materialName: 'UHMW', finishSlug: 'rt-as-cut', quantity: 2, config: { input: { thicknessMm: 12.7, grade: 'Natural' }, geometrySummary: { blankMm: { w: 100, h: 50 } } } });
  assert.ok(line.includes('stock thickness 12.7 mm (0.500 in)') && line.includes('grade Natural') && line.includes('finish As cut'), line);
});

test('a milled block has no stock thickness to miss; a print shows its layer height or says it is missing', () => {
  const cnc = specFor({ process: 'cnc', materialName: 'Acetal', finishName: 'As Machined', quantity: 5, config: { subProcess: 'milling', grade: 'Natural', geometrySummary: { stockMm: { w: 50, h: 40, d: 25 } } } }, { labels });
  assert.deepStrictEqual(cnc.missing, []);
  assert.ok(cnc.parts[0].text === 'CNC milling');
  const print = text({ process: '3d-printing', materialName: 'PETG', finishSlug: 'raw', quantity: 3, config: { subProcess: 'fdm', layerHeightMm: 0.2, input: { infill: 0.35 } }, geometry: { boundingBox: { width: 40, height: 30, depth: 12 } } });
  assert.ok(print.includes('3D printing (FDM)') && print.includes('layer height 0.2 mm') && print.includes('infill 35%') && print.includes('size 40 × 30 × 12 mm'), print);
  assert.deepStrictEqual(specFor({ process: '3d-printing', materialName: 'PETG', finishSlug: 'raw', quantity: 3, config: {}, geometry: { boundingBox: { width: 40, height: 30, depth: 12 } } }, { labels }).missing, ['layer height']);
});

// What review-fixes stores with every order line since 2026-11-11 (server/services/quoteIntegrity.js partSnapshot + the
// validated configuration): `config.priced`. The description reads it first.
const PRICED = { fingerprint: 'f'.repeat(64), geometryHash: 'a'.repeat(64), units: 'mm', sourceUnit: 'in', dimsMm: { x: 254, y: 203.2, z: 12.7 }, volumeMm3: null, is2D: true,
  process: 'routing', subProcess: 'sheet', materialSlug: 'rt-polycarbonate', materialName: 'Polycarbonate', grade: 'Clear', thicknessMm: 12.7, finishSlug: 'rt-as-cut', finishName: 'As cut', quantity: 4, layerHeight: null, infill: null };

test('the snapshot of what was priced (config.priced) is what the line shows: thickness, grade, units and size, with no part row needed', () => {
  // The order line's own columns are blank here and there is no geometry: everything comes from the snapshot.
  const spec = specFor({ fileName: 'bracket.dxf', quantity: 4, config: { priced: PRICED } }, { labels });
  const line = spec.parts.map((p) => p.text).join(' · ');
  for (const phrase of ['CNC routing', 'Polycarbonate', 'grade Clear', 'stock thickness 12.7 mm (0.500 in)', 'size 254 × 203.2 mm (10.00 × 8.00 in)', 'drawing units inches', 'finish As cut', 'qty 4']) assert.ok(line.includes(phrase), `${phrase} in: ${line}`);
  assert.deepStrictEqual(spec.missing, []);
  // It wins over older fields that disagree (a part row re-read at another size is not what was charged for).
  const both = text({ fileName: 'bracket.dxf', process: 'routing', quantity: 4, config: { thicknessMm: 6.35, grade: 'Old', priced: PRICED }, geometry: { is2D: true, boundingBox: { width: 10, height: 8 } } });
  assert.ok(both.includes('stock thickness 12.7 mm') && both.includes('grade Clear') && both.includes('size 254 × 203.2 mm') && !both.includes('6.35') && !both.includes('size 10 × 8'), both);
  // A 3D part: three dimensions, the layer height and infill that were priced.
  const print = text({ fileName: 'cover.stl', quantity: 3, config: { priced: { ...PRICED, is2D: false, sourceUnit: null, process: '3d-printing', subProcess: 'fdm', materialName: 'PETG', grade: '', thicknessMm: null, finishName: 'As printed', dimsMm: { x: 40, y: 30, z: 12 }, layerHeight: 0.2, infill: 0.35 } } });
  assert.ok(print.includes('3D printing (FDM)') && print.includes('size 40 × 30 × 12 mm') && print.includes('layer height 0.2 mm') && print.includes('infill 35%'), print);
});

test('an order from before the snapshot existed still says NOT RECORDED; a part that no longer matches what was priced is called out', () => {
  const old = specFor({ fileName: 'plate.dxf', process: 'routing', materialName: 'UHMW', finishName: 'As cut', quantity: 4, config: { priced: null } }, { labels });
  assert.deepStrictEqual(old.missing, ['grade', 'thickness', 'size']);
  const changed = specFor({ fileName: 'bracket.dxf', quantity: 4, matchesPriced: false, config: { priced: PRICED } }, { labels });
  assert.deepStrictEqual(changed.missing, ['part file']);
  assert.ok(changed.parts.some((p) => p.missing && /PART FILE CHANGED SINCE IT WAS PRICED/.test(p.text)));
  assert.deepStrictEqual(specFor({ fileName: 'bracket.dxf', quantity: 4, matchesPriced: true, config: { priced: PRICED } }, { labels }).missing, []);
});

console.log(`\n${passed} passed`);
