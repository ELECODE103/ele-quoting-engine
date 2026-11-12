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
  // ── Memory (the one setting the parse pool's limits derive from) ──
  /**
   * How much memory the service has, MB. Set it to the memory limit of the Railway service
   * (Settings → Resources). The default suits a 1 GB container. Everything below that says
   * "derived" scales with it; an explicit PARSE_MAX_HEAP_MB / PARSE_RSS_LIMIT_MB / DB_MAX_MB
   * still wins. docs/security/availability-fixes-2026-11-11.md has the table for 1, 2 and 4 GB.
   */
  get memoryBudgetMb() { return envInt("MEMORY_BUDGET_MB", 1024, 512, 65536); },

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
  get databaseMaxBytes() {
    // Derived: a sixteenth of the memory budget, between 64 and 256 MB (64 MB at 1 GB, 128 MB at 2 GB,
    // 256 MB from 4 GB up). The database lives in memory and a save copies it, so the file has to stay
    // small beside the memory the service has.
    const derived = Math.max(64, Math.min(256, Math.floor(this.memoryBudgetMb / 16)));
    return envInt("DB_MAX_MB", derived, 4, 16384) * MB;
  },
  /** Share of the database ceiling at which the oldest no-account draft quotes are swept (services/storagePressure.js). */
  get dbSweepFraction() { return envInt("DB_SWEEP_PERCENT", 80, 20, 95) / 100; },
  /** Share of the database ceiling kept for customers with a confirmed email: visitors without one stop at 100 − this. */
  get dbReservedFraction() { return envInt("DB_RESERVED_PERCENT", 15, 0, 50) / 100; },
  /** A no-account draft is left alone by the emergency sweep until nobody has touched it for this long, minutes. */
  get draftSweepMinAgeMinutes() { return envInt("DRAFT_SWEEP_MIN_AGE_MINUTES", 30, 0, 100000); },
  /** The same, once the database is so full that visitors without an account are being turned away: shorter, so the pause is short. */
  get draftSweepUrgentMinAgeMinutes() { return envInt("DRAFT_SWEEP_URGENT_MIN_AGE_MINUTES", 5, 0, 100000); },
  /** A draft quote of a visitor without an account that is never opened again lapses after this many hours. */
  get anonDraftHours() { return envInt("QUOTE_ANON_DRAFT_HOURS", 48, 1, 24 * 365); },
  /** Bytes one client address may have STORED at once (CAD files and what is derived from them, request attachments). */
  get uploadStoredBytesPerClient() { return envInt("UPLOAD_STORED_MB_PER_IP", 400, 1, 1000000) * MB; },
  /** Share of the file-storage ceiling kept for customers with a confirmed email: visitors without one stop at 100 − this. */
  get storageReservedFraction() { return envInt("UPLOAD_DIR_RESERVED_PERCENT", 15, 0, 50) / 100; },
  /** An upload is not evicted under storage pressure until it (and any draft that names it) has been idle this long, minutes. */
  get storageEvictMinAgeMinutes() { return envInt("STORAGE_EVICT_MIN_AGE_MINUTES", 30, 0, 100000); },
  /** Days after a request is declined, lost or expired before its attachment is deleted. */
  get rfqClosedAttachmentDays() { return envInt("RFQ_CLOSED_ATTACHMENT_DAYS", 14, 0, 3650); },
  /** An upload on disk that no part row names (the process died mid-parse) is deleted after this many minutes. */
  get uploadOrphanMinutes() { return envInt("UPLOAD_ORPHAN_MINUTES", 15, 2, 100000); },
  /**
   * What stays in a part's database row. A preview mesh whose JSON is larger than the first figure,
   * and geometry detail (recognised features, a DXF's loops) larger than the second, are written to
   * per-part files under data/part-payloads instead (models/partPayloads.js), so a row is a few kB
   * to a few tens of kB and the database no longer grows by megabytes per upload.
   */
  get partInlineMeshBytes() { return envInt("PART_INLINE_MESH_KB", 16, 0, 1024) * 1024; },
  // 8 kB since the availability fixes (it was 64): a 4 kB DXF with 150 holes used to leave a 50 kB row,
  // ten times its own size, and rows are what fills the database (independent review 2026-11-11, L6).
  get partInlineGeometryBytes() { return envInt("PART_INLINE_GEOMETRY_KB", 8, 8, 4096) * 1024; },
  /** Share of the ceiling at which a warning is logged. */
  get storageWarnFraction() { return envInt("UPLOAD_DIR_WARN_PERCENT", 80, 10, 99) / 100; },
  /** Largest drawing (PDF) attached to an instant quote, bytes. */
  get drawingMaxBytes() { return envInt("DRAWING_MAX_FILE_MB", 25, 1, 100) * MB; },

  // ── Geometry parsing (worker pool) ────────────────────────────
  /** Files parsed at the same time. */
  get parseConcurrency() { return envInt("PARSE_CONCURRENCY", Math.max(1, Math.min(2, os.cpus().length - 1 || 1)), 1, 16); },
  /** Files allowed to wait for a free worker before new ones are told "busy". */
  get parseQueueMax() { return envInt("PARSE_QUEUE_MAX", 8, 0, 500); },
  /** Of those waiting places, how many one client address may hold. */
  get parseQueuePerClient() { return envInt("PARSE_QUEUE_PER_CLIENT", 2, 0, 500); },
  /** Seconds of parsing one client address may use in an hour, counting parses that were stopped. */
  get parseSecondsPerClientHour() { return envInt("PARSE_SECONDS_PER_CLIENT_HOUR", 180, 5, 86400); },
  /** After a parse of theirs is stopped (time or memory), a client address is kept off the last free worker for this many minutes. */
  get parseSuspectMinutes() { return envInt("PARSE_SUSPECT_MINUTES", 60, 0, 1440); },
  /** Longest a file may wait for a worker, ms. */
  get parseQueueWaitMs() { return envInt("PARSE_QUEUE_WAIT_MS", 30000, 100, 600000); },
  /** Wall-clock budget for parsing one file, ms. The worker is terminated at this point. */
  get parseTimeoutMs() { return envInt("PARSE_TIMEOUT_MS", 60000, 100, 600000); },
  /**
   * The budget a given file actually gets, never more than PARSE_TIMEOUT_MS: a DXF outline reads in
   * well under a second, so 10 s is already generous; the other formats get a base plus time per MB,
   * because a file that takes a minute at 1 kB is not a part (independent review 2026-11-11, H2).
   */
  get parseTimeoutDxfMs() { return envInt("PARSE_TIMEOUT_DXF_MS", 10000, 100, 600000); },
  /** STL / 3MF: base and per-megabyte allowance, ms. */
  get parseTimeoutMeshBaseMs() { return envInt("PARSE_TIMEOUT_MESH_BASE_MS", 15000, 100, 600000); },
  get parseTimeoutMeshPerMbMs() { return envInt("PARSE_TIMEOUT_MESH_PER_MB_MS", 2000, 0, 600000); },
  /** STEP / IGES (the CAD kernel is slower to start and to mesh): base and per-megabyte allowance, ms. */
  get parseTimeoutCadBaseMs() { return envInt("PARSE_TIMEOUT_CAD_BASE_MS", 30000, 100, 600000); },
  get parseTimeoutCadPerMbMs() { return envInt("PARSE_TIMEOUT_CAD_PER_MB_MS", 10000, 0, 600000); },
  /** V8 heap ceiling of one parse worker, MB (resourceLimits.maxOldGenerationSizeMb). Derived: 3/8 of MEMORY_BUDGET_MB (384 at 1 GB, 768 at 2 GB). */
  get parseMaxHeapMb() { return envInt("PARSE_MAX_HEAP_MB", Math.max(128, Math.min(4096, Math.floor(this.memoryBudgetMb * 3 / 8))), 64, 8192); },
  /** Parse jobs one client address may have running at once (the rest of its files wait their turn). */
  get parsePerClient() { return envInt("PARSE_PER_CLIENT", 1, 1, 16); },
  /**
   * Memory (RSS) all running parses together may add to the process before the
   * longest-running one is stopped, MB. WASM and typed-array memory is outside
   * the V8 heap limit, so this is the backstop. The service needs this much
   * free above its idle footprint. 0 switches the watchdog off.
   * Derived: half of MEMORY_BUDGET_MB (512 at 1 GB, 1024 at 2 GB).
   */
  get parseRssLimitMb() { return envInt("PARSE_RSS_LIMIT_MB", Math.max(256, Math.floor(this.memoryBudgetMb / 2)), 0, 65536); },

  // ── Model size ceilings (bigger models go to a firm quote) ────
  /** Triangles in an STL or 3MF, or produced from a STEP/IGES. */
  get meshMaxTriangles() { return envInt("MESH_MAX_TRIANGLES", 500000, 1000, 20000000); },
  /** Entities read from a DXF (lines, arcs, polylines, …). The parser also stops at 120,000 curves and 5,000 contours. */
  get dxfMaxEntities() { return envInt("DXF_MAX_ENTITIES", 100000, 100, 2000000); },
  /** Largest DXF read for the instant quote, bytes (a part outline is far smaller). */
  get dxfMaxFileBytes() { return envInt("DXF_MAX_FILE_MB", 20, 1, 500) * MB; },
  /** Block copies a DXF may expand to in total (nested block arrays multiply). */
  get dxfMaxBlockInstances() { return envInt("DXF_MAX_BLOCK_INSTANCES", 20000, 100, 10000000); },
  /** Bytes an ASCII STL may spend per facet before it counts as padded (a facet is about 250 bytes). */
  get stlAsciiMaxBytesPerFacet() { return envInt("STL_ASCII_MAX_BYTES_PER_FACET", 1000, 300, 100000); },
  /** Share of a text CAD file (STEP, IGES, DXF over 256 kB) that may be blank space before it counts as padded. */
  get cadMaxBlankPercent() { return envInt("CAD_MAX_BLANK_PERCENT", 90, 50, 100); },

  // ── What counts as a real part (parsers/saneGeometry.js) ──────
  /** No coordinate may be further than this from the origin, mm. */
  get geometryMaxCoordMm() { return envInt("GEOMETRY_MAX_COORD_MM", 100000, 1000, 100000000); },
  /** No side of a part's bounding box may be longer than this, mm. */
  get geometryMaxExtentMm() { return envInt("GEOMETRY_MAX_EXTENT_MM", 10000, 100, 100000000); },
  /** A part's largest side must be at least this, micrometres (1000 = 1 mm). */
  get geometryMinPartUm() { return envInt("GEOMETRY_MIN_PART_UM", 1000, 1, 1000000); },
  /** Every side of a 3D model must be at least this, micrometres (10 = 0.01 mm). */
  get geometryMinThicknessUm() { return envInt("GEOMETRY_MIN_THICKNESS_UM", 10, 1, 1000000); },

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

  // ── Answers ───────────────────────────────────────────────────
  /** Largest JSON answer the API will send, bytes (security/answerCeiling.js). */
  get jsonAnswerMaxBytes() { return envInt("JSON_ANSWER_MAX_MB", 16, 1, 512) * MB; },
  /** Largest stored preview mesh / geometry file served to a browser, bytes (routes/partPayloadRoutes.js). */
  get partPayloadServeMaxBytes() { return envInt("PART_PAYLOAD_SERVE_MAX_MB", 24, 1, 512) * MB; },
  /** Preview bytes one client address may be served in an hour. */
  get partPreviewBytesPerClientHour() { return envInt("PART_PREVIEW_MB_PER_CLIENT_HOUR", 600, 1, 1000000) * MB; },

  // ── Quote pricing (POST /api/quote) ───────────────────────────
  /** Lines in one instant quote for a visitor who is not signed in (signed-in customers: 100). */
  get quoteMaxLinesAnonymous() { return envInt("QUOTE_MAX_LINES_ANON", 25, 1, 100); },
  /** Main-thread work one pricing request may use, ms (services/pricingMemo.js). */
  get quotePriceBudgetMs() { return envInt("QUOTE_PRICE_BUDGET_MS", 3000, 1, 600000); },
  /** Longest one pricing request may take on the clock, ms. */
  get quotePriceWallMs() { return envInt("QUOTE_PRICE_WALL_MS", 20000, 100, 600000); },
  /** Work done between two turns of the event loop while pricing, ms. */
  get quotePriceSliceMs() { return envInt("QUOTE_PRICE_SLICE_MS", 20, 1, 1000); },
  /** How long a second pricing request from the same client waits for the first, ms. */
  get quotePriceWaitMs() { return envInt("QUOTE_PRICE_WAIT_MS", 4000, 0, 60000); },
  /** Pricing requests running at once across all clients. */
  /** Pricing work one address may cause in an hour, seconds (charged per piece; services/pricingMemo.js). */
  get quotePriceSecondsPerClientHour() { return envInt("QUOTE_PRICE_SECONDS_PER_CLIENT_HOUR", 120, 1, 86400); },
  /** The same for one account, whatever address it comes from. */
  get quotePriceSecondsPerAccountHour() { return envInt("QUOTE_PRICE_SECONDS_PER_ACCOUNT_HOUR", 120, 1, 86400); },
  /** The heavy pricing lane: work it may do in one burst, ms, and its share of the thread once the burst is spent, percent. */
  get quotePriceHeavyBurstMs() { return envInt("QUOTE_PRICE_HEAVY_BURST_MS", 1000, 0, 600000); },
  get quotePriceHeavyDutyPercent() { return envInt("QUOTE_PRICE_HEAVY_DUTY_PERCENT", 33, 1, 100); },
  /** A quote whose distinct parts carry more measured detail than this (kB, summed) is priced in the heavy lane. */
  get quotePriceLightBytes() { return envInt("QUOTE_PRICE_LIGHT_KB", 256, 0, 1048576) * 1024; },
  /** A quote in the light lane that has used this much work, ms, goes on in the heavy lane. */
  get quotePriceLightMs() { return envInt("QUOTE_PRICE_LIGHT_MS", 150, 1, 600000); },
  /** Quotes that may wait for the pricing runner, whole site; and how long one waits before it is told to retry, ms. */
  get quotePriceQueueMax() { return envInt("QUOTE_PRICE_QUEUE_MAX", 200, 1, 100000); },
  get quotePriceQueueWaitMs() { return envInt("QUOTE_PRICE_QUEUE_WAIT_MS", 15000, 100, 600000); },
  get quotePriceMaxInFlight() { return envInt("QUOTE_PRICE_MAX_INFLIGHT", 8, 1, 1000); },
  /** NEW draft-quote rows per client address and per account (security/quoteGuards.js). */
  get quoteNewPerClientHour() { return envInt("QUOTE_NEW_PER_CLIENT_HOUR", 30, 1, 100000); },
  get quoteNewPerClientDay() { return envInt("QUOTE_NEW_PER_CLIENT_DAY", 120, 1, 1000000); },
  get quoteNewPerAccountHour() { return envInt("QUOTE_NEW_PER_ACCOUNT_HOUR", 60, 1, 100000); },
  get quoteNewPerAccountDay() { return envInt("QUOTE_NEW_PER_ACCOUNT_DAY", 240, 1, 1000000); },

  // ── Site-wide caps (whoever the sender is) ────────────────────
  /** Uses of one verified-human token in its hour. */
  get humanTokenMaxUses() { return envInt("HUMAN_TOKEN_MAX_USES", 2000, 10, 1000000); },
  /** Firm-quote requests accepted per hour, site-wide, from senders who did not pass the robot check. */
  get rfqUnverifiedPerHourSite() { return envInt("RFQ_UNVERIFIED_PER_HOUR_SITE", 30, 1, 100000); },
  /** Emails per hour, site-wide, to addresses nobody has confirmed (services/mailCaps.js). */
  get mailUnconfirmedPerHourSite() { return envInt("MAIL_UNCONFIRMED_PER_HOUR_SITE", 60, 1, 100000); },
  /** New-request notices per hour to the shop's own inbox. */
  get mailShopRequestsPerHourSite() { return envInt("MAIL_SHOP_REQUESTS_PER_HOUR_SITE", 40, 1, 100000); },

  // ── Rate limits (per client address) ──────────────────────────
  get rateApiPer15Min() { return envInt("RATE_API_PER_15MIN", 200, 10, 100000); },
  get rateUploadPer15Min() { return envInt("RATE_UPLOAD_PER_15MIN", 50, 1, 100000); },
  get rateQuotePer15Min() { return envInt("RATE_QUOTE_PER_15MIN", 300, 10, 100000); },
  get rateQuoteBurstPer10Sec() { return envInt("RATE_QUOTE_BURST_PER_10SEC", 40, 5, 10000); },
  get rateSessionPer15Min() { return envInt("RATE_QUOTE_SESSION_PER_15MIN", 60, 5, 100000); },
  get ratePartPreviewPer15Min() { return envInt("RATE_PART_PREVIEW_PER_15MIN", 240, 5, 100000); },
  get ratePdfPer15Min() { return envInt("RATE_PDF_PER_15MIN", 60, 5, 100000); },
  get rateDrawingPerHour() { return envInt("RATE_DRAWING_PER_HOUR", 20, 1, 100000); },
  get rateRfqPerHour() { return envInt("RATE_RFQ_PER_HOUR", 20, 1, 100000); },

  /** Proxy hops in front of the app whose X-Forwarded-For entry is trusted (Railway's edge = 1). */
  get trustProxyHops() { return envInt("TRUST_PROXY_HOPS", 1, 0, 5); },
};

module.exports = { limits, envInt, MB };
