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

console.log(`\n${passed} passed`);
