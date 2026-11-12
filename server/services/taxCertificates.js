/**
 * Tax-exemption certificates a buyer attaches before checkout.
 *
 * They travel the same path as a drawing attached to a quote, with the same guards:
 *   - the storage ceiling and the sender's daily byte budget are held before a byte is written
 *     (security/uploadGuards.admit, on the route),
 *   - the stored name is ours (a random id plus an extension from the allow-list),
 *   - the first bytes must be what the extension says (middleware/fileValidator),
 *   - the file is encrypted at rest when NORD_FILE_ENC_KEY is set (services/fileCrypto),
 *   - it lives in data/quote-drawings, so the storage ceiling counts it and the drawing sweep
 *     removes it once no quote, order or request points at it (services/fileRetention).
 *
 * A certificate is a PDF or a photo/scan of one. It is stored for the owner to read; nothing
 * here parses it or judges it. Only an admin can download it.
 */
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { randomUUID } = require("crypto");
const uploadGuards = require("../security/uploadGuards");
const { limits } = require("../security/limits");
const { attachmentMatchesExtension } = require("../middleware/fileValidator");
const fileCrypto = require("./fileCrypto");

const DIR = path.join(uploadGuards.DATA_DIR, "quote-drawings");
const EXTENSIONS = [".pdf", ".jpg", ".jpeg", ".png"];
const TYPES_MESSAGE = "Send the certificate as a PDF, or a JPG or PNG scan.";
const maxBytes = () => limits.drawingMaxBytes;

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { try { fs.mkdirSync(DIR, { recursive: true }); cb(null, DIR); } catch (err) { cb(err); } },
    // Nothing the client sent is in the path: a random id and an extension from the allow-list.
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!EXTENSIONS.includes(ext)) return cb(new Error("unsupported extension"));
      cb(null, `${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: maxBytes(), files: 1, fields: 5, fieldSize: 4 * 1024, fieldNameSize: 100, parts: 8, headerPairs: 50 },
  fileFilter: (req, file, cb) => {
    if (EXTENSIONS.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(Object.assign(new Error(TYPES_MESSAGE), { status: 400, expose: true }));
  },
});

async function remove(filePath) {
  if (!filePath) return;
  try { await fs.promises.unlink(filePath); } catch (err) { if (err.code !== "ENOENT") console.error("Tax certificate: could not remove a file:", err.code || err.name); }
}

/**
 * Take the one file in field "certificate" off the request, check it and store it.
 * Answers the request itself when the file is refused and resolves null; otherwise resolves
 * { fileName (the buyer's own name for it, cleaned: a label only), path (where it is stored) }.
 */
function receive(req, res) {
  return new Promise((resolve) => {
    upload.single("certificate")(req, res, async (err) => {
      const mb = Math.round(maxBytes() / (1024 * 1024));
      if (err) {
        const tooBig = err.code === "LIMIT_FILE_SIZE";
        res.status(tooBig ? 413 : 400).json({ error: tooBig ? `The certificate is over ${mb} MB.` : (err.expose ? err.message : "That upload couldn't be read. Try again."), code: tooBig ? "certificate-too-large" : err.expose ? "certificate-type" : "certificate-unreadable" });
        return resolve(null);
      }
      if (!req.file) { res.status(400).json({ error: "No certificate attached.", code: "certificate-missing" }); return resolve(null); }
      let stored = req.file.path;
      try {
        uploadGuards.account(req, { received: req.file.size });
        const ext = path.extname(req.file.originalname).toLowerCase();
        if (!attachmentMatchesExtension(stored, ext)) {
          await remove(stored);
          res.status(400).json({ error: `That file isn't what its name says it is (${ext.slice(1).toUpperCase()}). ${TYPES_MESSAGE}`, code: "content-mismatch" });
          return resolve(null);
        }
        stored = await fileCrypto.encryptFile(stored); // no-op unless NORD_FILE_ENC_KEY is set
        uploadGuards.storage.add(req.file.size);
        resolve({ fileName: uploadGuards.safeFileName(req.file.originalname, "certificate.pdf"), path: stored });
      } catch (e) {
        console.error("Tax certificate upload error:", e.message);
        await remove(stored);
        if (!res.headersSent) res.status(500).json({ error: "Could not attach the certificate. Please try again.", code: "certificate-failed" });
        resolve(null);
      }
    });
  });
}

/** Does any quote, order or request (other than `except`) still point at this stored certificate? */
function inUse(storedPath, { quotesDB, ordersDB, rfqsDB }, except = {}) {
  if (!storedPath) return false;
  return quotesDB.getAll().some((q) => q.id !== except.quoteId && q.taxCertPath === storedPath)
    || ordersDB.getAll().some((o) => o.taxCertPath === storedPath)
    || rfqsDB.getAll().some((r) => r.id !== except.rfqId && r.taxCertPath === storedPath);
}

/** Remove a replaced or withdrawn certificate, unless something else still points at it or it is not one of ours. */
async function discardIfUnused(storedPath, models, except = {}) {
  if (!storedPath || path.dirname(path.resolve(storedPath)) !== path.resolve(DIR)) return;
  if (!inUse(storedPath, models, except)) await remove(storedPath);
}

/** The route guard: the storage ceiling and the sender's daily budget, before the file is written. */
const admit = () => uploadGuards.admit({ maxRequestBytes: () => maxBytes() + 64 * 1024 });

module.exports = { receive, inUse, discardIfUnused, admit, EXTENSIONS, DIR };
