'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const { convertImage } = require('../utils/converter');

const router = express.Router();

// ── Constants ──────────────────────────────────────────────────────────────
const TMP_DIR = '/tmp/image-converter';
const MAX_FILES = 50;
const MAX_FILE_SIZE = 50 * 1024 * 1024;   // 50 MB per file
const MAX_TOTAL_SIZE = 500 * 1024 * 1024; // 500 MB total
const MAX_DIMENSION = 8000;               // px
const TTL_MS = 15 * 60 * 1000;            // 15 minutes

const SUPPORTED_INPUT_MIMES = new Set([
  'image/webp',
  'image/avif',
  'image/png',
  'image/jpeg',
]);

const SUPPORTED_OUTPUT_FORMATS = new Set(['png', 'jpg', 'webp']);

// Ensure tmp directory exists
fs.mkdirSync(TMP_DIR, { recursive: true });

// ── Magic-bytes validation ─────────────────────────────────────────────────
/**
 * Returns the detected image type from magic bytes, or null if unrecognised.
 * @param {Buffer} buf
 * @returns {'webp'|'avif'|'png'|'jpg'|null}
 */
function detectMagicBytes(buf) {
  if (buf.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'png';
  }

  // JPG: FF D8
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    return 'jpg';
  }

  // WebP: bytes 0-3 = "RIFF", bytes 8-11 = "WEBP"
  if (
    buf.slice(0, 4).toString('ascii') === 'RIFF' &&
    buf.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }

  // AVIF: offset 4 = "ftyp", offset 8 = "avif" (case-insensitive)
  if (
    buf.length >= 12 &&
    buf.slice(4, 8).toString('ascii') === 'ftyp' &&
    buf.slice(8, 12).toString('ascii').toLowerCase() === 'avif'
  ) {
    return 'avif';
  }

  return null;
}

// ── Multer setup – memory storage so we can inspect bytes ─────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: MAX_FILES,
    fileSize: MAX_FILE_SIZE,
  },
  fileFilter(_req, file, cb) {
    if (SUPPORTED_INPUT_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`不支援的檔案類型：${file.mimetype}`));
    }
  },
});

// ── TTL cleanup helper ─────────────────────────────────────────────────────
/**
 * Schedule deletion of a tmp file after TTL_MS.
 * @param {string} filePath
 */
function scheduleCleanup(filePath) {
  setTimeout(async () => {
    try {
      await fsp.unlink(filePath);
    } catch {
      // File may have already been deleted after download; ignore
    }
  }, TTL_MS);
}

// ── POST /api/convert ──────────────────────────────────────────────────────
router.post(
  '/convert',
  upload.array('files[]', MAX_FILES),
  async (req, res) => {
    try {
      // Validate files presence
      const files = req.files;
      if (!files || files.length === 0) {
        return res.status(400).json({ error: '請至少上傳一個檔案' });
      }

      // Validate total size
      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      if (totalSize > MAX_TOTAL_SIZE) {
        return res.status(400).json({
          error: `總檔案大小超過限制（最大 500MB），目前：${(totalSize / 1024 / 1024).toFixed(1)}MB`,
        });
      }

      // Validate outputFormat
      const outputFormat = (req.body.outputFormat || '').toLowerCase();
      if (!SUPPORTED_OUTPUT_FORMATS.has(outputFormat)) {
        return res.status(400).json({
          error: `不支援的輸出格式：${outputFormat}，請使用 png、jpg 或 webp`,
        });
      }

      // Parse and validate jpgQuality
      let jpgQuality = 85;
      if (req.body.jpgQuality !== undefined) {
        jpgQuality = parseInt(req.body.jpgQuality, 10);
        if (isNaN(jpgQuality) || jpgQuality < 60 || jpgQuality > 100) {
          return res.status(400).json({
            error: 'jpgQuality 必須為 60–100 之間的整數',
          });
        }
      }

      // Parse bgColor (only used for JPG output)
      const bgColor = req.body.bgColor || '#ffffff';
      if (!/^#[0-9a-fA-F]{6}$/.test(bgColor)) {
        return res.status(400).json({
          error: 'bgColor 必須為有效的 hex 色碼，例如：#ffffff',
        });
      }

      // ── Process each file ──────────────────────────────────────────────
      const results = await Promise.all(
        files.map(async (file) => {
          const { originalname, buffer } = file;

          try {
            // 1. Magic bytes check
            const detectedType = detectMagicBytes(buffer);
            if (!detectedType) {
              return {
                originalName: originalname,
                outputName: null,
                downloadUrl: null,
                warnings: [],
                success: false,
                error: '無法識別的圖片格式（Magic bytes 驗證失敗）',
              };
            }

            // 2. Dimension check via Sharp metadata
            const meta = await sharp(buffer, { failOn: 'none' }).metadata();
            const { width, height } = meta;
            if (
              width === undefined || height === undefined ||
              width > MAX_DIMENSION || height > MAX_DIMENSION
            ) {
              return {
                originalName: originalname,
                outputName: null,
                downloadUrl: null,
                warnings: [],
                success: false,
                error: `圖片尺寸超過限制（最大 ${MAX_DIMENSION}×${MAX_DIMENSION}px），實際：${width}×${height}px`,
              };
            }

            // 3. Convert
            const { buffer: outBuf, outputName, warnings } = await convertImage(
              buffer,
              originalname,
              { outputFormat, jpgQuality, bgColor },
            );

            // 4. Write to tmp with UUID prefix to avoid collisions
            const uuid = uuidv4();
            const storedName = `${uuid}-${outputName}`;
            const storedPath = path.join(TMP_DIR, storedName);
            await fsp.writeFile(storedPath, outBuf);

            // 5. Schedule TTL cleanup
            scheduleCleanup(storedPath);

            return {
              originalName: originalname,
              outputName,
              downloadUrl: `/download/${storedName}`,
              warnings,
              success: true,
            };
          } catch (err) {
            return {
              originalName: originalname,
              outputName: null,
              downloadUrl: null,
              warnings: [],
              success: false,
              error: err.message || '轉換時發生未知錯誤',
            };
          }
        }),
      );

      return res.json({ results });
    } catch (err) {
      console.error('[/api/convert] Unhandled error:', err);
      return res.status(500).json({ error: '伺服器內部錯誤' });
    }
  },
);

// ── GET /download/:filename ────────────────────────────────────────────────
router.get('/download/:filename', async (req, res) => {
  // Sanitise: allow only safe filename characters (uuid + basename + ext)
  const { filename } = req.params;
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(filename)) {
    return res.status(400).json({ error: '無效的檔案名稱' });
  }

  const filePath = path.join(TMP_DIR, filename);

  // Ensure the resolved path is still within TMP_DIR (path traversal guard)
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(TMP_DIR) + path.sep)) {
    return res.status(400).json({ error: '無效的路徑' });
  }

  try {
    await fsp.access(filePath, fs.constants.R_OK);
  } catch {
    return res.status(404).json({ error: '檔案不存在或已過期' });
  }

  // Derive a clean download filename (strip UUID prefix: "<uuid>-<name>")
  const downloadName = filename.replace(/^[a-f0-9-]{36}-/, '');

  res.download(filePath, downloadName, async (err) => {
    if (err) {
      // Header already sent – just log
      console.error('[/download] Error sending file:', err.message);
      return;
    }
    // Delete after successful download
    try {
      await fsp.unlink(filePath);
    } catch {
      // Ignore – TTL cleanup will handle it
    }
  });
});

module.exports = router;
