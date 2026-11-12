/**
 * How a part is described in an API answer, and the answer of
 * GET /api/quote/:id/session — both built so their size is bounded whatever
 * the quote holds.
 *
 * The session answer used to carry, for every line, the part's geometry and
 * its whole preview mesh, read from disk and re-serialised on the main thread:
 * one dense part on 100 lines was a 478 MB answer and took the site down
 * (independent review 2026-11-11, C1). The rule now, for every answer:
 *
 *   what is small enough to live in the part's database row is in the answer;
 *   what lives in a file is named by a URL and fetched by the browser when it
 *   shows it (routes/partPayloadRoutes.js streams the file).
 *
 * So a part is described by
 *   geometry        the measurements: all of them when they are in the row, the
 *                   summary (size, volume, counts) when the detail is in a file
 *   geometryDetail  { url, bytes } — only when the detail is in a file
 *   meshPreview     { positions, triangleCount } — positions only when the mesh
 *                   is in the row (a few kB); otherwise empty
 *   mesh            { url, triangleCount, bytes } — when the part has a preview
 *
 * and the session answer is
 *   parts       one entry per LINE: its configuration and the file name
 *   partsById   one entry per DISTINCT part, however many lines use it
 *
 * No file is opened to build either. A row is at most PART_INLINE_GEOMETRY_KB
 * + PART_INLINE_MESH_KB, so 100 distinct parts are a few megabytes at the very
 * worst and a typical quote is tens of kB.
 */

/** The configuration lines of a stored quote (quotes saved before the builder config was kept are rebuilt from the priced lines). */
function configLines(quote) {
  return quote.config?.parts || (quote.lineItems || []).map((li) => ({
    partId: li.partId, quantity: li.quantity, process: li.meta?.process, subProcess: li.meta?.subProcess,
    materialSlug: li.meta?.materialSlug, grade: li.meta?.grade, finishSlug: li.meta?.finishSlug,
  }));
}

/**
 * Where a part's big pieces are, from its row.
 * @param {object} row  a part row (id, geometry as stored, meshBytes, detailBytes)
 * @returns {{ geometry: object, meshPreview: object, mesh?: object, geometryDetail?: object }}
 */
function describePart(row) {
  const { meshData, ...geometry } = (row.geometry && typeof row.geometry === "object" ? row.geometry : {});
  const triangleCount = Number(meshData && meshData.triangleCount) || 0;
  const inRow = Boolean(meshData && Array.isArray(meshData.positions) && meshData.positions.length > 0);
  const meshInFile = Number(row.meshBytes) > 0;
  const out = {
    geometry,
    meshPreview: { positions: inRow ? meshData.positions : [], triangleCount },
  };
  if (inRow || meshInFile) {
    out.mesh = { url: `/api/parts/${row.id}/mesh`, triangleCount, ...(meshInFile ? { bytes: Number(row.meshBytes) } : {}) };
  }
  if (Number(row.detailBytes) > 0) {
    out.geometryDetail = { url: `/api/parts/${row.id}/geometry`, bytes: Number(row.detailBytes) };
  }
  return out;
}

/**
 * @param {object} quote    the stored quote
 * @param {object} partsDB  models.partsDB (PartsStore): getRow(id) reads the row and nothing else
 * @returns {object} the session answer
 */
function build(quote, partsDB) {
  const partsById = Object.create(null); // keyed by ids from stored data: no prototype to collide with
  const missing = new Set();
  const lines = [];
  for (const config of configLines(quote)) {
    if (!config || typeof config.partId !== "string") continue;
    const id = config.partId;
    if (missing.has(id)) continue;
    if (!partsById[id]) {
      const row = partsDB.getRow(id);
      if (!row) { missing.add(id); continue; } // the part is gone: the line is left out, as before
      partsById[id] = { fileName: row.fileName, dfm: row.dfm, ...describePart(row) };
    }
    lines.push({ ...config, fileName: partsById[id].fileName });
  }
  return {
    quoteId: quote.id,
    status: quote.status,
    process: quote.config?.process || lines[0]?.process || "",
    leadTimeSlug: quote.leadTimeSlug || "standard",
    paperwork: Boolean(quote.paperwork),
    notes: quote.notes || "",
    drawingFileName: quote.drawingFileName || "",
    parts: lines,
    partsById,
  };
}

module.exports = { build, configLines, describePart };
