/**
 * A part's large payloads, served on their own:
 *
 *   GET /api/parts/:partId/mesh       the 3D preview ({ positions, triangleCount })
 *   GET /api/parts/:partId/geometry   the full measurements of a very detailed
 *                                     part (what the quote tool shows beside
 *                                     the summary it already has)
 *
 * These used to ride inside other answers — the quote-session answer carried
 * every line's mesh, re-read and re-serialised on the main thread, up to
 * 478 MB (independent review 2026-11-11, C1). Now an answer names the part and
 * the browser fetches what it shows, one file at a time:
 *
 *   - the stored file is STREAMED (never parsed here); an encrypted file is
 *     authenticated first and then decrypted as a stream (services/fileCrypto.js)
 *   - access is the part's own rule, through ONE helper (security/meshAccess.js)
 *   - `ETag` + `Cache-Control: private`: the browser keeps its copy and a reload
 *     costs a 304; nothing shared may cache it
 *   - a size cap per file (PART_PAYLOAD_SERVE_MAX_MB) and, per client, a request
 *     limiter (security/rateLimits.js) and a byte allowance per hour
 *     (PART_PREVIEW_MB_PER_CLIENT_HOUR), so the route cannot be turned into an
 *     egress bill
 *
 * A small payload that lives in the part's row (not in a file) is answered
 * from the row: a few kB.
 */
const crypto = require("crypto");
const fs = require("fs");
const express = require("express");
const { pipeline } = require("stream");
const { partsDB } = require("../models");
const payloads = require("../models/partPayloads");
const fileCrypto = require("../services/fileCrypto");
const { optionalAuth } = require("./auth");
const { isValidUUID } = require("../middleware/validate");
const { mayReadPart } = require("../security/meshAccess");
const { limits } = require("../security/limits");
const { clientKey } = require("../security/clientKey");
const brand = require("../../shared/brand.json");

const router = express.Router();
const HOUR = 60 * 60 * 1000;

// ─── Bytes served per client per hour ───────────────────────────
const egress = {
  windows: new Map(), // client key → { start, bytes }
  MAX_KEYS: 20000,
  used(key, now = Date.now()) {
    const w = this.windows.get(key);
    return w && now - w.start < HOUR ? w.bytes : 0;
  },
  add(key, bytes, now = Date.now()) {
    let w = this.windows.get(key);
    if (!w || now - w.start >= HOUR) {
      if (this.windows.size >= this.MAX_KEYS) for (const [k, v] of this.windows) if (now - v.start >= HOUR) this.windows.delete(k);
      if (this.windows.size >= this.MAX_KEYS) this.windows.clear();
      w = { start: now, bytes: 0 };
      this.windows.set(key, w);
    }
    w.bytes += Math.max(0, Number(bytes) || 0);
  },
  reset() { this.windows.clear(); },
};

const NOT_FOUND = { error: "Part not found" };
const unavailable = (code) => ({
  error: "We can't show the preview of this part right now. The quote and its price are not affected.",
  code,
});

const etagFor = (id, kind, bytes, mtimeMs) => `"${crypto.createHash("sha1").update(`${id}|${kind}|${bytes}|${Math.round(mtimeMs || 0)}`).digest("base64url").slice(0, 22)}"`;

function send(kind) {
  return async (req, res) => {
    try {
      const id = req.params.partId;
      // The summary row only: nothing is read from disk to decide who may have it.
      const row = isValidUUID(id) ? partsDB.getRow(id) : null;
      // "Not found" for a part that is not there and for one this caller may not read: the answer does not say which.
      if (!row || !mayReadPart(req, row)) return res.status(404).json(NOT_FOUND);

      const inFile = Number(kind === "mesh" ? row.meshBytes : row.detailBytes) > 0;
      const key = clientKey(req);
      res.set("Cache-Control", "private, max-age=3600");
      res.set("Vary", "X-Part-Key, Cookie, Authorization");
      res.set("X-Content-Type-Options", "nosniff");

      if (!inFile) {
        // Small enough to live in the row.
        const g = row.geometry && typeof row.geometry === "object" ? row.geometry : null;
        let body;
        if (kind === "mesh") {
          const mesh = g && g.meshData;
          if (!mesh || !Array.isArray(mesh.positions) || mesh.positions.length === 0) return res.status(404).json({ error: "This part has no 3D preview.", code: "no-preview" });
          body = JSON.stringify(mesh);
        } else {
          if (!g) return res.status(404).json(NOT_FOUND);
          body = JSON.stringify(g.meshData ? { ...g, meshData: { ...g.meshData, positions: [] } } : g);
        }
        const tag = `"${crypto.createHash("sha1").update(body).digest("base64url").slice(0, 22)}"`;
        res.set("ETag", tag);
        if (req.headers["if-none-match"] === tag) return res.status(304).end();
        egress.add(key, Buffer.byteLength(body));
        return res.type("application/json").send(body);
      }

      const file = payloads.locate(id, kind);
      if (!file) return res.status(404).json(unavailable("preview-unavailable"));
      if (file.bytes > limits.partPayloadServeMaxBytes) return res.status(413).json(unavailable("preview-too-large"));

      const tag = etagFor(id, kind, file.bytes, file.mtimeMs);
      res.set("ETag", tag);
      if (req.headers["if-none-match"] === tag) return res.status(304).end();

      if (egress.used(key) + file.bytes > limits.partPreviewBytesPerClientHour) {
        res.set("Retry-After", "600");
        return res.status(429).json({ error: `You've loaded a lot of previews from this network in the last hour. They'll be back shortly; pricing and ordering still work. Questions: ${brand.phone}.`, code: "preview-limit" });
      }

      let stream;
      let length;
      if (file.encrypted) {
        try {
          ({ stream, bytes: length } = await fileCrypto.openDecryptStream(file.path));
        } catch (err) {
          console.error(`Part payload (${kind}) of ${String(id).slice(0, 8)} could not be decrypted: ${err.code || err.message}`);
          return res.status(409).json(unavailable("preview-unavailable"));
        }
      } else {
        stream = fs.createReadStream(file.path);
        length = file.bytes;
      }
      egress.add(key, length);
      res.status(200);
      res.set("Content-Type", "application/json; charset=utf-8");
      res.set("Content-Length", String(length));
      pipeline(stream, res, (err) => {
        // A client that went away mid-stream is not an error worth a log line.
        if (err && err.code !== "ERR_STREAM_PREMATURE_CLOSE" && err.code !== "ECONNRESET" && err.code !== "EPIPE") console.error(`Part payload (${kind}) stream error: ${err.code || err.message}`);
      });
      return undefined;
    } catch (err) {
      console.error("Part payload route error:", err.message);
      if (!res.headersSent) res.status(500).json({ error: "Something went wrong on our side. Try again in a minute." });
      return undefined;
    }
  };
}

router.get("/parts/:partId/mesh", optionalAuth, send("mesh"));
router.get("/parts/:partId/geometry", optionalAuth, send("geometry"));

module.exports = router;
module.exports.egress = egress;
