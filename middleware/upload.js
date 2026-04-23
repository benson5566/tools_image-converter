'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const multer = require('multer');

// ── Constants ──────────────────────────────────────────────────────────────────

const UPLOAD_DIR = '/tmp/image-converter/uploads';

const MAX_FILE_SIZE = 50 * 1024 * 1024;   // 50 MB per file
const MAX_FILE_COUNT = 50;

const ALLOWED_EXTENSIONS = new Set(['.webp', '.avif', '.png', '.jpg', '.jpeg']);

/**
 * Magic-byte validators keyed by normalised extension.
 * Each function receives a Buffer of (at least) the first 20 bytes of the file.
 */
const MAGIC_BYTES = {
  webp: (buf) =>
    buf.length >= 12 &&
    buf.slice(0, 4).toString('ascii') === 'RIFF' &&
    buf.slice(8, 12).toString('ascii') === 'WEBP',

  avif: (buf) => {
    if (buf.length < 12) return false;
    const ftyp = buf.slice(4, 8).toString('ascii');
    const brand = buf.slice(8, 12).toString('ascii');
    return ftyp === 'ftyp' && (brand.includes('avif') || brand.includes('avis'));
  },

  png: (buf) =>
    buf.length >= 8 &&
    buf.slice(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    ),

  jpg: (buf) =>
    buf.length >= 2 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8,

  // .jpeg is the same format as .jpg
  jpeg: (buf) =>
    buf.length >= 2 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8,
};

// ── Directory bootstrap ────────────────────────────────────────────────────────

/**
 * Ensure the upload directory exists.  Called once at module load time so that
 * the very first request does not race against directory creation.
 */
function ensureUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

ensureUploadDir();

// ── Multer storage ─────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    // Re-confirm the directory still exists (handles edge cases such as tmpfs
    // being cleared by the OS between restarts).
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },

  filename(_req, file, cb) {
    // Use a timestamp + random suffix to avoid collisions and to prevent
    // original filenames (which may contain traversal sequences) from appearing
    // on-disk.
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `upload-${unique}${ext}`);
  },
});

// ── fileFilter: extension-only check (magic bytes validated separately) ────────

function fileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    // Attach a typed error so the calling route can distinguish it from generic
    // multer errors.
    const err = new Error(
      `不支援的副檔名「${ext}」。允許的格式：${[...ALLOWED_EXTENSIONS].join(', ')}`
    );
    err.code = 'INVALID_EXTENSION';
    return cb(err, false);
  }

  cb(null, true);
}

// ── Multer instance ────────────────────────────────────────────────────────────

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,   // 50 MB per file (enforced by multer)
    files: MAX_FILE_COUNT,     // max 50 files per request
  },
});

// ── Magic-bytes validator (called by route AFTER multer has written the file) ──

/**
 * Read the first 20 bytes of an uploaded file and verify they match the
 * magic bytes expected for `declaredExt`.
 *
 * @param {string} filePath    - Absolute path to the saved file.
 * @param {string} declaredExt - Extension from the original filename (e.g. '.png').
 * @returns {Promise<{ valid: boolean, detectedFormat: string|null }>}
 */
async function validateMagicBytes(filePath, declaredExt) {
  const PEEK_SIZE = 20;
  let fd;

  try {
    fd = await fsp.open(filePath, 'r');
    const buf = Buffer.alloc(PEEK_SIZE);
    const { bytesRead } = await fd.read(buf, 0, PEEK_SIZE, 0);
    const peek = buf.slice(0, bytesRead);

    // Normalise declared extension: strip leading dot, lowercase.
    const normExt = declaredExt.replace(/^\./, '').toLowerCase();

    // Determine which validator to use for the declared type.
    const validator = MAGIC_BYTES[normExt];
    if (!validator) {
      // Unknown extension slipped through fileFilter somehow; reject.
      return { valid: false, detectedFormat: null };
    }

    if (!validator(peek)) {
      // Declared extension does not match actual content.  Try to detect the
      // real format for a useful error message (but never trust it for security).
      let detectedFormat = null;
      for (const [fmt, fn] of Object.entries(MAGIC_BYTES)) {
        if (fn(peek)) {
          detectedFormat = fmt;
          break;
        }
      }
      return { valid: false, detectedFormat };
    }

    return { valid: true, detectedFormat: normExt };
  } finally {
    if (fd) await fd.close();
  }
}

// ── Cleanup helper ─────────────────────────────────────────────────────────────

/**
 * Remove a list of file paths from disk, ignoring errors (e.g. already gone).
 * Intended for use in error handlers to clean up partially-uploaded files.
 *
 * @param {string[]} filePaths
 */
async function cleanupFiles(filePaths) {
  await Promise.allSettled(
    filePaths.map((p) => fsp.unlink(p))
  );
}

// ── Exports ────────────────────────────────────────────────────────────────────

module.exports = {
  upload,
  validateMagicBytes,
  cleanupFiles,
  UPLOAD_DIR,
  MAX_FILE_SIZE,
  MAX_FILE_COUNT,
  ALLOWED_EXTENSIONS,
};
