/**
 * Loading a part's large pieces after the page has the quote.
 *
 * The server no longer puts 3D previews inside other answers (one dense part on
 * every line of a quote used to make a 478 MB answer). An upload or a reopened
 * quote now says where each part's preview is — `part.mesh.url` — and, for a
 * very detailed drawing, where its full detail is — `part.geometryDetail.url`.
 * This module fetches them:
 *
 *   resolveDetail(parts)   before parts are shown: a DXF needs its outline and
 *                          units to be drawn and priced, so its detail is
 *                          fetched first (one at a time). 3D parts are left as
 *                          they are; nothing on the page reads their detail.
 *   wantMeshes(...)        after parts are shown: previews, ONE AT A TIME, the
 *                          part on screen first. Each arrives through onMesh.
 *
 * A preview that cannot be loaded is simply not shown; pricing and ordering do
 * not depend on it.
 */
import { api } from './api';

/** Fill in the full geometry of the 2D parts that came with a summary only. */
export async function resolveDetail(parts) {
  const out = [];
  for (const p of parts) {
    if (p?.geometryDetail?.url && p.geometry?.is2D) {
      try {
        const { meshData, ...geometry } = await api.getPartPayload(p.geometryDetail.url, p.editKey);
        out.push({ ...p, geometry: { ...geometry, is2D: true } });
        continue;
      } catch { /* shown without its outline; the server still prices it */ }
    }
    out.push(p);
  }
  return out;
}

const status = new Map(); // partId → 'loading' | 'done' | 'failed'
let queue = [];           // [{ partId, url, editKey }]
let deliver = null;
let busy = false;

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const next = queue.shift();
      if (status.get(next.partId)) continue;
      status.set(next.partId, 'loading');
      try {
        const mesh = await api.getPartPayload(next.url, next.editKey);
        status.set(next.partId, 'done');
        if (deliver && mesh && Array.isArray(mesh.positions)) deliver(next.partId, { positions: mesh.positions, triangleCount: mesh.triangleCount || 0 });
      } catch {
        status.set(next.partId, 'failed');
      }
    }
  } finally {
    busy = false;
  }
}

/**
 * Ask for the previews of these parts. Call it whenever the list or the part
 * on screen changes: the latest call sets the order (the active part first).
 * @param {Array} parts      the builder's parts
 * @param {string} activeId  the part on screen
 * @param {(partId: string, meshPreview: {positions: number[], triangleCount: number}) => void} onMesh
 */
export function wantMeshes(parts, activeId, onMesh) {
  deliver = onMesh;
  const need = (parts || []).filter((p) => p?.mesh?.url && !(p.meshPreview?.positions?.length) && !status.get(p.partId));
  need.sort((a, b) => (b.partId === activeId) - (a.partId === activeId));
  queue = need.map((p) => ({ partId: p.partId, url: p.mesh.url, editKey: p.editKey }));
  if (queue.length) pump();
}

/** Forget what was loaded (a new quote is being opened). */
export function resetMeshes() {
  status.clear();
  queue = [];
}
