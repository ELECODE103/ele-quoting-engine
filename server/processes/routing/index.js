/**
 * CNC routing process definition. Self-contained: pricing + DFM live here.
 */
module.exports = {
  slug: "routing",
  defaultFinishSlug: "rt-as-cut",
  previewSubProcess: "sheet",
  pricing: require("./pricing"),
  dfm: require("./dfm"),
};
