/**
 * File content validator middleware.
 * Validates uploaded files by checking magic bytes match the claimed extension.
 * Runs AFTER multer has saved the files to disk.
 */
const fs = require("fs");
const path = require("path");

// Magic byte signatures for supported CAD file formats
const MAGIC_BYTES = {
  // STL binary starts with 80-byte header then triangle count (little-endian uint32)
  // STL ASCII starts with "solid"
  ".stl": {
    check: (buffer, size) => {
      // ASCII STL: "solid <name>" and, close behind it, the first "facet" (or an empty "endsolid").
      const text = buffer.toString("latin1");
      if (/^\s*solid\b/.test(text) && /\b(facet|endsolid)\b/.test(text)) return true;
      // Binary STL has no signature, so check its arithmetic instead: an 80-byte
      // header, a triangle count, then exactly 50 bytes per triangle. A file of
      // another kind renamed .stl fails this (its "count" does not fit its size).
      if (buffer.length < 84 || !(size >= 84)) return false;
      const count = buffer.readUInt32LE(80);
      if (count === 0) return false;
      const expected = 84 + count * 50;
      // Some exporters pad the end; none write less than the count promises.
      return size >= expected && size - expected <= 1024;
    },
  },
  // STEP/STP files start with "ISO-10303-21"
  ".step": {
    check: (buffer) => {
      const header = buffer.slice(0, 80).toString("ascii");
      return header.includes("ISO-10303-21");
    },
  },
  ".stp": {
    check: (buffer) => {
      const header = buffer.slice(0, 80).toString("ascii");
      return header.includes("ISO-10303-21");
    },
  },
  // IGES files start with lines in specific column format, first section flag in col 73 is "S"
  ".iges": {
    check: (buffer) => {
      // IGES is fixed 80-column records. Column 73 of the first record is the
      // section letter: "S" (Start) — or "B"/"C" for the binary and compressed
      // forms — followed by the sequence number in columns 74–80.
      const first = buffer.toString("latin1").split(/\r?\n/)[0] || "";
      if (first.length < 80) return false;
      return /^[SBC]/.test(first.slice(72)) && /^[SBC][ 0]*1\s*$/.test(first.slice(72, 80));
    },
  },
  ".igs": {
    check: (buffer) => {
      // IGES is fixed 80-column records. Column 73 of the first record is the
      // section letter: "S" (Start) — or "B"/"C" for the binary and compressed
      // forms — followed by the sequence number in columns 74–80.
      const first = buffer.toString("latin1").split(/\r?\n/)[0] || "";
      if (first.length < 80) return false;
      return /^[SBC]/.test(first.slice(72)) && /^[SBC][ 0]*1\s*$/.test(first.slice(72, 80));
    },
  },
  // DXF: ASCII group-code pairs — optional 999 comments, then "0 / SECTION".
  // (Binary DXF starts with a sentinel string; the parser rejects it with a
  // message telling the customer to save as ASCII. A DWG renamed .dxf fails here.)
  ".dxf": {
    check: (buffer) => {
      const head = buffer.toString("latin1").replace(/^\uFEFF/, "").replace(/^\xEF\xBB\xBF/, "");
      if (head.startsWith("AutoCAD Binary DXF")) return true;
      return /^\s*(999\s*\r?\n[^\n]*\n\s*)*0\s*\r?\n\s*SECTION\s*\r?\n/.test(head);
    },
  },
  // 3MF files are ZIP archives (magic bytes: PK\x03\x04)
  ".3mf": {
    check: (buffer) => {
      return buffer.length >= 4 &&
        buffer[0] === 0x50 && buffer[1] === 0x4B &&
        buffer[2] === 0x03 && buffer[3] === 0x04;
    },
  },
};

/**
 * Express middleware that validates uploaded file contents.
 * Must run AFTER multer middleware.
 * Invalid files are deleted from disk and removed from req.files.
 */
function validateFileContent(req, res, next) {
  if (!req.files || req.files.length === 0) {
    return next();
  }

  const validFiles = [];
  const rejected = [];

  for (const file of req.files) {
    const ext = path.extname(file.originalname).toLowerCase();
    const validator = MAGIC_BYTES[ext];

    if (!validator) {
      // No validator for this extension — reject it
      rejected.push({ fileName: file.originalname, reason: "No validator for extension" });
      safeDelete(file.path);
      continue;
    }

    try {
      // Read just the first 512 bytes for validation
      const fd = fs.openSync(file.path, "r");
      const buffer = Buffer.alloc(512);
      const bytesRead = fs.readSync(fd, buffer, 0, 512, 0);
      fs.closeSync(fd);

      if (bytesRead < 4) {
        rejected.push({ fileName: file.originalname, reason: "File too small" });
        safeDelete(file.path);
        continue;
      }

      if (!validator.check(buffer.slice(0, bytesRead), fs.statSync(file.path).size)) {
        rejected.push({ fileName: file.originalname, reason: "File content does not match extension" });
        safeDelete(file.path);
        continue;
      }

      validFiles.push(file);
    } catch (err) {
      rejected.push({ fileName: file.originalname, reason: "Validation error" });
      safeDelete(file.path);
    }
  }

  // Replace req.files with only valid files
  req.files = validFiles;

  // Attach rejected files info for the route handler to include in response
  if (rejected.length > 0) {
    req.rejectedFiles = rejected;
  }

  next();
}

function safeDelete(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.error("Failed to delete invalid upload:", e.message);
  }
}

/**
 * Does the file at `filePath` look like what `ext` says it is?
 * (The same checks as the middleware, for callers that hold a path.)
 */
function contentMatchesExtension(filePath, ext) {
  const validator = MAGIC_BYTES[String(ext || "").toLowerCase()];
  if (!validator) return false;
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(512);
    const bytesRead = fs.readSync(fd, buffer, 0, 512, 0);
    if (bytesRead < 4) return false;
    return Boolean(validator.check(buffer.slice(0, bytesRead), fs.fstatSync(fd).size));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

module.exports = { validateFileContent, contentMatchesExtension, MAGIC_BYTES };
