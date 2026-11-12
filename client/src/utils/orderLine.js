// The full description of an order line for the admin screens, with the app's process labels
// and grade wording. The rules are in utils/orderLineCore.js.
import { PROCESS_LABELS } from '../brand';
import { gradeLabel } from '../facts';
import { specFor } from './orderLineCore';

const LABELS = { ...PROCESS_LABELS, cnc: 'CNC machining', routing: 'CNC routing', '3d-printing': '3D printing' };

/** @returns {{parts: Array<{text: string, missing: boolean}>, missing: string[]}} */
export function orderLineSpec(item) {
  return specFor(item, { labels: LABELS, gradeLabel });
}
