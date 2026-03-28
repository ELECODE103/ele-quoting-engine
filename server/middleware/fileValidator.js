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
    check: (buffer) => {
      const ascii = buffer.slice(0, 6).toString("ascii");
      // ASCII STL starts with "solid "
      if (ascii.startsWith("solid")) return true;
      // Binary STL: 80-byte header + 4-byte triangle count â just check it's long enough
      return buffer.length >= 84;
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
      const header = buffer.slice(0, 200).toString("ascii");
      // IGES files have "S" section identifiers or typical header patterns
      return header.includes("S      1") || header.includes("S ") || header.includes("IGES");
    },
  },
  ".igs": {
    check: (buffer) => {
      const header = buffer.slice(0, 200).toString("ascii");
      return header.includes("S      1") || header.includes("S ") || header.includes("IGES");
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
      // No validator for this extension â reject it
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

      if (!validator.check(buffer.slice(0, bytesRead))) {
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

module.exports = { validateFileContent };
