/**
 * The layer height to price: the requested one when the material offers it,
 * otherwise the nearest one it does offer. A material with no list keeps the
 * request, and no request means the material's default (undefined here).
 */
function offeredLayerHeight(material, requested) {
  const want = Number(requested);
  if (requested == null || requested === "" || !Number.isFinite(want) || want <= 0) return undefined;
  const offered = (Array.isArray(material && material.layerHeights) ? material.layerHeights : []).map(Number).filter((h) => h > 0);
  if (offered.length === 0) return want;
  return offered.reduce((best, h) => (Math.abs(h - want) < Math.abs(best - want) ? h : best), offered[0]);
}

module.exports = { offeredLayerHeight };
