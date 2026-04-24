'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const { convertImage } = require('../utils/converter');
const { logger } = require('../utils/logger');

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
  'application/octet-stream', // curl 等工具未指定 type 時的 fallback，magic bytes 負責實際驗證
]);

const SUPPORTED_OUTPUT_FORMATS = new Set(['png', 'jpg', 'webp', 'avif']);

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

  // AVIF / AVIF-sequence: offset 4 = "ftyp", offset 8 = major brand.
  // Valid brands include "avif" (still) and "avis" (AVIF Image Sequence).
  // See ISO/IEC 14496-12 and AV1 Image File Format specification.
  if (
    buf.length >= 12 &&
    buf.slice(4, 8).toString('ascii') === 'ftyp'
  ) {
    const brand = buf.slice(8, 12).toString('ascii').toLowerCase();
    if (brand === 'avif' || brand === 'avis') {
      return 'avif';
    }
  }

  return null;
}

// ── Multer setup – memory storage so we can inspect bytes ─────────────────
// NOTE: fileFilter 也接受 application/octet-stream，因為部分 HTTP 客戶端
// （如 curl）無法正確推斷 .webp 等格式的 MIME type。
// 真正的格式驗證由後續的 magic bytes 檢查負責。
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
      const err = new Error(`不支援的檔案類型：${file.mimetype}`);
      err.code = 'UNSUPPORTED_MEDIA_TYPE';
      err.expose = true;
      cb(err);
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
      // ── Cloudflare Turnstile verification (when secret key is configured) ──
      const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY;
      if (!TURNSTILE_SECRET && process.env.NODE_ENV === 'production') {
        logger.error('TURNSTILE_SECRET_KEY is not set in production — bot protection is disabled');
      }
      if (TURNSTILE_SECRET) {
        const token = req.body['cf-turnstile-response'];
        if (!token) return res.status(400).json({ error: '請完成人機驗證' });
        const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret: TURNSTILE_SECRET, response: token }),
        });
        const verifyData = await verifyRes.json();
        if (!verifyData.success) return res.status(403).json({ error: '人機驗證失敗，請重試' });
      }

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
          error: '不支援的輸出格式，請使用 png、jpg、webp 或 avif',
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

      // Parse and validate avifQuality
      let avifQuality = 50;
      if (req.body.avifQuality !== undefined) {
        avifQuality = parseInt(req.body.avifQuality, 10);
        if (isNaN(avifQuality) || avifQuality < 1 || avifQuality > 63) {
          return res.status(400).json({ error: 'avifQuality 必須為 1–63 之間的整數' });
        }
      }

      // Parse and validate webpQuality
      let webpQuality = 80;
      if (req.body.webpQuality !== undefined) {
        webpQuality = parseInt(req.body.webpQuality, 10);
        if (isNaN(webpQuality) || webpQuality < 1 || webpQuality > 100) {
          return res.status(400).json({ error: 'webpQuality 必須為 1–100 之間的整數' });
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
            const { width, height, channels } = meta;
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

            // 2b. Decompression-bomb guard (SPEC 8.3).
            // Estimate uncompressed RGBA memory: width × height × 4 channels × 1 byte.
            // Even if the source has fewer channels, Sharp internally promotes to RGBA,
            // so 4 is the safe upper bound for the channel count.
            const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MB
            const estimatedBytes = (width || 0) * (height || 0) * Math.max(channels || 4, 4);
            if (estimatedBytes > MAX_UNCOMPRESSED_BYTES) {
              return {
                originalName: originalname,
                outputName: null,
                downloadUrl: null,
                warnings: [],
                success: false,
                error: `解壓後記憶體估算（${(estimatedBytes / 1024 / 1024).toFixed(1)}MB）超過限制（最大 50MB），請縮小圖片後再試`,
              };
            }

            // 3. Convert
            const { buffer: outBuf, outputName, warnings } = await convertImage(
              buffer,
              originalname,
              { outputFormat, jpgQuality, avifQuality, webpQuality, bgColor },
            );

            // 4. Write to tmp with UUID prefix to avoid collisions
            // Use only UUID + extension for the stored filename to ensure
            // filesystem and URL safety regardless of original filename encoding.
            const uuid = uuidv4();
            const ext = outputFormat; // 'png' | 'jpg' | 'webp' | 'avif'
            const storedName = `${uuid}.${ext}`;
            const storedPath = path.join(TMP_DIR, storedName);
            await fsp.writeFile(storedPath, outBuf);

            // 5. Schedule TTL cleanup
            scheduleCleanup(storedPath);

            // Encode outputName so the download URL is always valid,
            // while the human-readable filename (outputName) is preserved
            // for Content-Disposition via the download route.
            const encodedOutputName = encodeURIComponent(outputName);

            return {
              originalName: originalname,
              outputName,
              downloadUrl: `/download/${storedName}?name=${encodedOutputName}`,
              warnings,
              success: true,
              originalSize: buffer.byteLength,
              outputSize: outBuf.length,
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

      logger.info('convert', { files: files.length, outputFormat, totalSize, ip: req.ip });
      return res.json({ results });
    } catch (err) {
      logger.error('convert unhandled error', { message: err.message, ip: req.ip });
      return res.status(500).json({ error: '伺服器內部錯誤' });
    }
  },
);

// ── GET /download/:filename ────────────────────────────────────────────────
router.get('/download/:filename', async (req, res) => {
  // Stored filenames are now UUID-only (e.g. "<uuid>.png"), so we only need
  // to allow alphanumeric, hyphens and dots.
  const { filename } = req.params;
  if (!/^[a-zA-Z0-9\-\.]+$/.test(filename)) {
    return res.status(400).json({ error: '無效的檔案名稱' });
  }

  const filePath = path.join(TMP_DIR, filename);

  // Ensure the resolved path is still within TMP_DIR (path traversal guard)
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(TMP_DIR) + path.sep)) {
    return res.status(403).json({ error: '存取被拒：路徑不合法' });
  }

  try {
    await fsp.access(filePath, fs.constants.R_OK);
  } catch {
    return res.status(404).json({ error: '檔案不存在或已過期' });
  }

  // Use the human-readable name from query param if provided (URL-encoded),
  // otherwise fall back to the stored filename.
  const rawName = req.query.name;
  const downloadName = rawName
    ? decodeURIComponent(rawName).replace(/[\r\n\t]/g, '_').slice(0, 255)
    : filename;

  res.download(filePath, downloadName, (err) => {
    if (err) {
      logger.error('download error', { file: filename, message: err.message });
    }
  });
});

// ── POST /api/zip – Batch ZIP download ─────────────────────────────────────
const archiver = require('archiver');

router.post('/zip', async (req, res) => {
  try {
    const { files } = req.body;
    if (!Array.isArray(files)) return res.status(400).json({ error: 'files 必須為陣列' });
    if (files.length < 1 || files.length > 50) return res.status(400).json({ error: 'files 陣列長度必須為 1–50' });

    const validatedFiles = [];
    const missingFiles = [];

    for (const filename of files) {
      if (!/^[a-zA-Z0-9\-\.]+$/.test(filename)) {
        return res.status(400).json({ error: `無效的檔案名稱格式：${filename}` });
      }
      const filePath = path.join(TMP_DIR, filename);
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(TMP_DIR) + path.sep)) {
        return res.status(403).json({ error: '存取被拒：路徑不合法' });
      }
      try {
        await fsp.access(filePath, fs.constants.R_OK);
        validatedFiles.push({ filename, filePath });
      } catch {
        missingFiles.push(filename);
      }
    }

    if (missingFiles.length > 0 && validatedFiles.length === 0) {
      return res.status(404).json({ error: '所有請求的檔案不存在或已過期' });
    }

    const archive = archiver('zip', { zlib: { level: 6 } });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="images.zip"');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    archive.on('error', (err) => {
      logger.error('zip archive error', { message: err.message, ip: req.ip });
      if (!res.headersSent) {
        res.status(500).json({ error: '打包時發生錯誤' });
      } else {
        res.destroy();
      }
    });

    archive.pipe(res);

    for (const { filename, filePath } of validatedFiles) {
      try {
        archive.append(fs.createReadStream(filePath), { name: filename });
      } catch (err) {
        logger.error('zip append error', { file: filename, message: err.message });
      }
    }

    if (missingFiles.length > 0) {
      const notice = `以下檔案已過期或不存在，未包含在此 ZIP 中：\n${missingFiles.join('\n')}`;
      archive.append(notice, { name: '_MISSING_FILES.txt' });
    }

    await archive.finalize();
    logger.info('zip download', { files: validatedFiles.length, missing: missingFiles.length, ip: req.ip });
  } catch (err) {
    logger.error('zip unhandled error', { message: err.message, ip: req.ip });
    if (!res.headersSent) res.status(500).json({ error: '伺服器內部錯誤' });
  }
});

module.exports = router;
