/**
 * Every hard limit the server enforces on untrusted input, in one place.
 *
 * Each value has a safe default and an environment override, so the owner can
 * tune a limit from the Railway dashboard without a code change. A value that
 * is missing, not a number or outside its sane range falls back to the default
 * (a typo can never switch a limit off).
 *
 * The values are read when asked for (not frozen at startup) so tests can set
 * the environment before each case. docs/security/hardening-2026-11-11-server.md
 * lists them with their reasons.
 */
const os = require("os");

const MB = 1024 * 1024;

/** Integer from the environment, clamped to [min, max]; `def` when unset or invalid. */
function envInt(name, def, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  const v = Math.floor(n);
  if (v < min || v > max) return def;
  return v;
}

const limits = {
  // ── Uploads (POST /api/upload) ────────────────────────────────
  /** Largest single CAD file, bytes. */
  get uploadMaxFileBytes() { return envInt("UPLOAD_MAX_FILE_MB", 50, 1, 500) * MB; },
  /** Files accepted in one request. */
  get uploadMaxFiles() { return envInt("UPLOAD_MAX_FILES", 10, 1, 50); },
  /** Bytes one client address may upload in a rolling 24 hours (CAD + drawings). */
  get uploadDailyBytesPerClient() { return envInt("UPLOAD_DAILY_MB_PER_IP", 500, 1, 100000) * MB; },
  /** Hard ceiling on everything stored under data/uploads, data/quote-drawings, data/rfq-drawings and data/part-payloads. */
  get storageMaxBytes() { return envInt("UPLOAD_DIR_MAX_MB", 2048, 10, 1000000) * MB; },
  /**
   * Database file size past which new uploads are refused. Every write rewrites the whole file:
   * measured, a write blocks the server for about 2 ms per MB of database (0.4 s at 200 MB) and
   * memory runs at ~5× the file. A part row used to carry its preview mesh (up to ~3 MB); the mesh
   * and other large detail now live in files (partInline* above), so a row is tens of kB at most
   * and this ceiling is a backstop, not something a busy month reaches.
   */
  get databaseMaxBytes() { return envInt("DB_MAX_MB", 256, 16, 16384) * MB; },
  /**
   * What stays in a part's database row. A preview mesh whose JSON is larger than the first figure,
   * and geometry detail (recognised features, a DXF's loops) larger than the second, are written to
   * per-part files under data/part-payloads instead (models/partPayloads.js), so a row is a few kB
   * to a few tens of kB and the database no longer grows by megabytes per upload.
   */
  get partInlineMeshBytes() { return envInt("PART_INLINE_MESH_KB", 16, 0, 1024) * 1024; },
  get partInlineGeometryBytes() { return envInt("PART_INLINE_GEOMETRY_KB", 64, 8, 4096) * 1024; },
  /** Share of the ceiling at which a warning is logged. */
  get storageWarnFraction() { return envInt("UPLOAD_DIR_WARN_PERCENT", 80, 10, 99) / 100; },
  /** Largest drawing (PDF) attached to an instant quote, bytes. */
  get drawingMaxBytes() { return envInt("DRAWING_MAX_FILE_MB", 25, 1, 100) * MB; },

  // ── Geometry parsing (worker pool) ────────────────────────────
  /** Files parsed at the same time. */
  get parseConcurrency() { return envInt("PARSE_CONCURRENCY", Math.max(1, Math.min(2, os.cpus().length - 1 || 1)), 1, 16); },
  /** Files allowed to wait for a free worker before new ones are told "busy". */
  get parseQueueMax() { return envInt("PARSE_QUEUE_MAX", 8, 0, 500); },
  /** Longest a file may wait for a worker, ms. */
  get parseQueueWaitMs() { return envInt("PARSE_QUEUE_WAIT_MS", 30000, 100, 600000); },
  /** Wall-clock budget for parsing one file, ms. The worker is terminated at this point. */
  get parseTimeoutMs() { return envInt("PARSE_TIMEOUT_MS", 60000, 100, 600000); },
  /** V8 heap ceiling of one parse worker, MB (resourceLimits.maxOldGenerationSizeMb). */
  get parseMaxHeapMb() { return envInt("PARSE_MAX_HEAP_MB", 768, 64, 8192); },
  /** Parse jobs one client address may have running at once (the rest of its files wait their turn). */
  get parsePerClient() { return envInt("PARSE_PER_CLIENT", 1, 1, 16); },
  /**
   * Memory (RSS) all running parses together may add to the process before the
   * longest-running one is stopped, MB. WASM and typed-array memory is outside
   * the V8 heap limit, so this is the backstop. The service needs this much
   * free above its idle footprint. 0 switches the watchdog off.
   */
  get parseRssLimitMb() { return envInt("PARSE_RSS_LIMIT_MB", 1024, 0, 65536); },

  // ── Model size ceilings (bigger models go to a firm quote) ────
  /** Triangles in an STL or 3MF, or produced from a STEP/IGES. */
  get meshMaxTriangles() { return envInt("MESH_MAX_TRIANGLES", 500000, 1000, 20000000); },
  /** Entities read from a DXF (lines, arcs, polylines, …). The parser also stops at 120,000 curves and 5,000 contours. */
  get dxfMaxEntities() { return envInt("DXF_MAX_ENTITIES", 100000, 100, 2000000); },

  // ── 3MF (a ZIP archive) ───────────────────────────────────────
  /** Entries allowed in the archive. */
  get zipMaxEntries() { return envInt("ZIP_MAX_ENTRIES", 1000, 1, 100000); },
  /** Declared uncompressed size of all entries together, bytes. */
  get zipMaxTotalBytes() { return envInt("ZIP_MAX_TOTAL_MB", 256, 1, 8192) * MB; },
  /** Uncompressed size of the one entry that is read (3D/3dmodel.model), bytes. */
  get zipMaxModelBytes() { return envInt("ZIP_MAX_MODEL_MB", 64, 1, 2048) * MB; },
  /** Uncompressed : compressed ratio above which an entry is treated as a bomb. */
  get zipMaxRatio() { return envInt("ZIP_MAX_RATIO", 100, 2, 100000); },
  /** Nesting depth of the model XML. */
  get xmlMaxDepth() { return envInt("XML_MAX_DEPTH", 32, 4, 1000); },

  // ── Request bodies ────────────────────────────────────────────
  /** JSON / urlencoded body on every route that does not ask for more, bytes. */
  get jsonBodyBytes() { return envInt("JSON_BODY_LIMIT_KB", 1024, 16, 51200) * 1024; },

  // ── Rate limits (per client address) ──────────────────────────
  get rateApiPer15Min() { return envInt("RATE_API_PER_15MIN", 200, 10, 100000); },
  get rateUploadPer15Min() { return envInt("RATE_UPLOAD_PER_15MIN", 50, 1, 100000); },
  get rateQuotePer15Min() { return envInt("RATE_QUOTE_PER_15MIN", 300, 10, 100000); },
  get rateQuoteBurstPer10Sec() { return envInt("RATE_QUOTE_BURST_PER_10SEC", 40, 5, 10000); },
  get rateSessionPer15Min() { return envInt("RATE_QUOTE_SESSION_PER_15MIN", 60, 5, 100000); },
  get ratePdfPer15Min() { return envInt("RATE_PDF_PER_15MIN", 60, 5, 100000); },
  get rateDrawingPerHour() { return envInt("RATE_DRAWING_PER_HOUR", 20, 1, 100000); },
  get rateRfqPerHour() { return envInt("RATE_RFQ_PER_HOUR", 20, 1, 100000); },

  /** Proxy hops in front of the app whose X-Forwarded-For entry is trusted (Railway's edge = 1). */
  get trustProxyHops() { return envInt("TRUST_PROXY_HOPS", 1, 0, 5); },
};

module.exports = { limits, envInt, MB };
