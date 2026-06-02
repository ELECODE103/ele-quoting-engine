/**
 * CNC process definition. Self-contained: pricing + DFM live in this folder.
 */
module.exports = {
  slug: "cnc",
  defaultFinishSlug: "cnc-as-machined",
  previewSubProcess: "milling",
  // Back-compat method-name wiring.
  priceMethod: "calculateCNCPrice",
  dfmFn: "runCNCDFM",
  pricing: require("./pricing"),
  dfm: require("./dfm"),
};
