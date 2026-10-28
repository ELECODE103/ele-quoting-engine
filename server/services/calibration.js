/**
 * Calibration — compares the engine's estimated machine minutes per piece with
 * what the shop floor actually took, per process, and turns the gap into a
 * conservative, explained rule suggestion.
 *
 * Inputs: order items whose `config` (the pricing meta saved at order time)
 * carries the engine's time (machineTimeHours / cycleMinutes / printTimeHours)
 * and whose `actualMinutes` the owner has filled in.
 *
 * The knob a process is calibrated with comes from the rule schema: the
 * descriptor with `calibration: { process, role: 'rate', relation }`. If the
 * schema in use carries no calibration hints, a built-in map is used.
 */
const { RULE_SCHEMA, getDescriptor } = require("../config/ruleSchema");

// Statuses where the work has been done, so an actual time can exist.
const COMPLETED_STATUSES = ["in_production", "quality_check", "packing", "shipped", "delivered"];

// Fallback if the schema lacks calibration hints.
const FALLBACK_DRIVERS = {
  "cnc": { rate: { key: "cncRoughingMrrCm3PerMin", relation: "inverse" }, floor: { key: "cncMinMinutesPerCm2", relation: "direct" } },
  "routing": { rate: { key: "routerFeedMmPerMin", relation: "inverse" } },
  "3d-printing:fdm": { rate: { key: "fdmDepositionMm3PerSec", relation: "inverse" } },
  "3d-printing:sla": { rate: { key: "slaLayerTimeSec", relation: "direct" } },
  "3d-printing:sls": { rate: { key: "slsLayerTimeSec", relation: "direct" } },
};

const MIN_SAMPLES = 3;        // do not suggest anything from fewer jobs
const DEADBAND = 0.10;        // within ±10 % the model is fine
const STEP_FRACTION = 0.5;    // move halfway toward the measured ratio

function engineMinutes(config) {
  if (!config || typeof config !== "object") return null;
  if (config.process === "cnc" && Number.isFinite(Number(config.machineTimeHours))) return Number(config.machineTimeHours) * 60;
  if (config.process === "routing" && Number.isFinite(Number(config.cycleMinutes))) return Number(config.cycleMinutes);
  if (config.process === "3d-printing" && Number.isFinite(Number(config.printTimeHours))) return Number(config.printTimeHours) * 60;
  return null;
}

function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function processKey(process, subProcess) {
  return process === "3d-printing" ? `3d-printing:${subProcess || "fdm"}` : process;
}

function driverFor(process, subProcess, role) {
  const hit = RULE_SCHEMA.find((d) => d.calibration && d.calibration.role === role && d.calibration.process === process
    && (!d.calibration.subProcess || d.calibration.subProcess === (subProcess || "fdm")));
  if (hit) return { key: hit.key, relation: hit.calibration.relation, desc: hit };
  const fb = (FALLBACK_DRIVERS[processKey(process, subProcess)] || {})[role];
  return fb ? { ...fb, desc: getDescriptor(fb.key) } : null;
}

function round(n, places = 2) { const f = 10 ** places; return Math.round(n * f) / f; }

/**
 * Build the calibration rows from orders + items.
 * @param {Array} orders   — ordersDB rows
 * @param {Array} items    — orderItemsDB rows
 */
function buildRows(orders, items) {
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const rows = [];
  for (const it of items) {
    const order = orderById.get(it.orderId);
    if (!order || !COMPLETED_STATUSES.includes(order.status)) continue;
    const config = it.config && typeof it.config === "object" ? it.config : {};
    const est = engineMinutes(config);
    const actual = it.actualMinutes != null && it.actualMinutes !== "" ? Number(it.actualMinutes) : null;
    rows.push({
      itemId: it.id,
      orderId: it.orderId,
      orderShort: String(it.orderId).slice(0, 8),
      orderStatus: order.status,
      orderDate: order.createdAt,
      customer: order.shippingName || "",
      fileName: it.fileName || "",
      process: it.process || config.process || "",
      subProcess: config.subProcess || it.subProcess || "",
      materialSlug: it.materialSlug || config.materialSlug || "",
      quantity: Number(it.quantity) || 1,
      unitPrice: it.unitPrice,
      engineMinutes: est != null ? round(est) : null,
      actualMinutes: Number.isFinite(actual) ? actual : null,
      actualNotes: it.actualNotes || "",
      actualRecordedAt: it.actualRecordedAt || null,
      ratio: est && Number.isFinite(actual) && est > 0 ? round(actual / est, 3) : null,
    });
  }
  rows.sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate));
  return rows;
}

/**
 * Per-process summary with a conservative suggestion.
 * @param {Array} rows   — from buildRows
 * @param {Object} rules — current effective rules
 */
function summarize(rows, rules) {
  const groups = new Map();
  for (const r of rows) {
    if (!r.process) continue;
    const key = processKey(r.process, r.subProcess);
    if (!groups.has(key)) groups.set(key, { key, process: r.process, subProcess: r.process === "3d-printing" ? (r.subProcess || "fdm") : "", items: [], measured: [] });
    const g = groups.get(key);
    g.items.push(r);
    if (r.ratio != null) g.measured.push(r);
  }

  const out = [];
  for (const g of groups.values()) {
    const ratios = g.measured.map((r) => r.ratio);
    const med = median(ratios);
    const summary = {
      process: g.process,
      subProcess: g.subProcess,
      jobs: g.items.length,
      measured: g.measured.length,
      medianRatio: med != null ? round(med, 2) : null,
      minRatio: ratios.length ? round(Math.min(...ratios), 2) : null,
      maxRatio: ratios.length ? round(Math.max(...ratios), 2) : null,
      suggestion: null,
    };

    const rateDriver = driverFor(g.process, g.subProcess, "rate");
    const floorDriver = driverFor(g.process, g.subProcess, "floor");
    const label = g.process === "3d-printing" ? `${g.subProcess.toUpperCase()} printing` : g.process === "cnc" ? "CNC" : g.process;

    if (g.measured.length < MIN_SAMPLES) {
      summary.suggestion = {
        kind: "wait",
        text: g.measured.length === 0
          ? `No actual times recorded for ${label} yet. Enter minutes per piece on the rows below as jobs finish.`
          : `${g.measured.length} ${label} job${g.measured.length === 1 ? "" : "s"} measured — ${MIN_SAMPLES} are needed before a rate change is suggested.`,
      };
    } else if (Math.abs(med - 1) <= DEADBAND) {
      summary.suggestion = {
        kind: "ok",
        text: `${label} is running ${med.toFixed(2)}× the model over ${g.measured.length} jobs — inside ±10 %. Leave the rates alone.`,
      };
    } else if (!rateDriver || !rateDriver.desc) {
      summary.suggestion = { kind: "manual", text: `${label} is running ${med.toFixed(2)}× the model, but no rule is mapped to its time. Adjust by hand.` };
    } else {
      // On the floor? For CNC the minimum machine time can be what the engine charged.
      let onFloor = 0;
      if (floorDriver && rules[floorDriver.key] != null) {
        const floorMin = Number(rules[floorDriver.key]) * 60;
        onFloor = g.measured.filter((r) => Math.abs(r.engineMinutes - floorMin) < 0.05).length;
      }
      const floorDominated = floorDriver && onFloor > g.measured.length / 2;
      const driver = floorDominated ? floorDriver : rateDriver;
      const current = rules[driver.key];
      // Halfway toward the measured ratio, conservatively.
      const target = 1 + (med - 1) * STEP_FRACTION;
      const factor = driver.relation === "inverse" ? 1 / target : target;
      let suggested;
      if (current && typeof current === "object" && !Array.isArray(current)) {
        suggested = {};
        for (const [k, v] of Object.entries(current)) suggested[k] = clampToDesc(driver.desc, round(Number(v) * factor, 0));
      } else {
        const places = Number(current) < 1 ? 3 : Number(current) < 20 ? 2 : 0;
        suggested = clampToDesc(driver.desc, round(Number(current) * factor, places));
      }
      const direction = med > 1 ? "longer" : "shorter";
      const knob = driver.desc.label || driver.key;
      const because = floorDominated
        ? `${onFloor} of ${g.measured.length} measured parts were charged the ${floorDriver.desc?.label?.toLowerCase() || "minimum machine time"}, so the floor — not the removal rate — set their price.`
        : driver.relation === "inverse"
          ? `Minutes = work ÷ ${knob.toLowerCase()}, so ${med > 1 ? "lowering" : "raising"} it makes the model's minutes ${direction}.`
          : `Minutes scale with ${knob.toLowerCase()}, so ${med > 1 ? "raising" : "lowering"} it makes the model's minutes ${direction}.`;
      summary.suggestion = {
        kind: "adjust",
        key: driver.key,
        label: knob,
        unit: driver.desc.unit || "",
        current,
        suggested,
        medianRatio: round(med, 2),
        text: `Your ${label} jobs are running ${med.toFixed(2)}× the model's minutes (median of ${g.measured.length}, range ${summary.minRatio}–${summary.maxRatio}×). ${because} Matching it fully would ${driver.relation === "inverse" ? (med > 1 ? "divide" : "multiply") : (med > 1 ? "multiply" : "divide")} ${knob} by ${med.toFixed(2)}; go halfway first — ${formatValue(current, driver.desc)} → ${formatValue(suggested, driver.desc)} — then re-check after the next ${MIN_SAMPLES} jobs. Check the preview before saving: this moves every ${label} quote.`,
      };
    }
    out.push(summary);
  }
  out.sort((a, b) => (b.measured - a.measured) || a.process.localeCompare(b.process));
  return out;
}

function clampToDesc(desc, n) {
  if (!desc) return n;
  if (desc.min !== undefined && n < desc.min) return desc.min;
  if (desc.max !== undefined && n > desc.max) return desc.max;
  return n;
}

function formatValue(v, desc) {
  if (v && typeof v === "object") return Object.entries(v).map(([k, n]) => `${k} ${n}`).join(", ");
  if (desc && desc.type === "percent") return `${Math.round(Number(v) * 100)} %`;
  return `${v}${desc && desc.unit ? " " + desc.unit : ""}`;
}

module.exports = { buildRows, summarize, engineMinutes, COMPLETED_STATUSES, MIN_SAMPLES };
