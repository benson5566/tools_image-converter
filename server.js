'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');

const convertRouter = require('./routes/convert');
const { logger } = require('./utils/logger');
const { securityHeaders, rateLimiter } = require('./middleware/security');

// ── Shared constants (must match routes/convert.js) ───────────────────────
const MAX_FILES = 50;

// ── Ensure tmp directory exists ────────────────────────────────────────────
const TMP_DIR = '/tmp/image-converter';
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.chmodSync(TMP_DIR, 0o700);

// ── App setup ──────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;
app.disable('x-powered-by');

// Trust the first proxy in the chain (Nginx / load balancer) so that
// req.ip resolves to the real client IP via X-Forwarded-For.
// Without this, all requests behind a reverse proxy appear as 127.0.0.1,
// causing the per-IP rate limiter to bucket ALL users together.
app.set('trust proxy', 1);
app.locals.trustProxy = true;

// Parse JSON bodies (for non-multipart routes)
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Security headers (applied to all responses) ────────────────────────────
app.use(securityHeaders);

// ── Rate limiting (applied to API and download routes) ─────────────────────
app.use('/api', rateLimiter);
app.use('/download', rateLimiter);

// ── Request logging middleware ──────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  res.on('finish', () => {
    logger.info('request', { method: req.method, path: req.path, status: res.statusCode, ip: req.ip });
  });
  next();
});

// ── Static files ───────────────────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// Serve index.html at root
app.get('/', (_req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(200).send(`
<!DOCTYPE html>
<html lang="zh-TW">
<head><meta charset="UTF-8"><title>Image Converter</title></head>
<body>
  <h1>Image Converter API</h1>
  <p>POST /api/convert — 上傳圖片並轉換格式</p>
  <p>GET /download/:filename — 下載轉換後的圖片</p>
</body>
</html>
    `.trim());
  }
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

// ── API routes ─────────────────────────────────────────────────────────────
app.use('/api', convertRouter);

// Download route is mounted at root level for clean URLs (/download/:file)
app.use('/', convertRouter);

// ── 404 handler ───────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: '找不到該路由' });
});

// ── Global error handler ───────────────────────────────────────────────────
// Catches multer errors (e.g. file too large, too many files) and other sync throws
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error('global error handler', { message: err.message, code: err.code });

  // Multer-specific error codes
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: '單一檔案超過大小限制（最大 50MB）' });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ error: '檔案數量超過限制（最多 50 個）' });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: '非預期的欄位名稱，請使用 files[]' });
  }

  // Do NOT expose err.message to the client — it may contain internal paths,
  // Sharp/libvips internals, or filesystem details.  Use a safe generic message
  // for unexpected errors; only well-typed application errors carry a safe status.
  const status = err.status || err.statusCode || 500;
  const safeMessage = (status >= 400 && status < 500 && err.expose !== false)
    ? (err.message || '請求錯誤')
    : '伺服器內部錯誤';
  res.status(status).json({ error: safeMessage });
});

// ── Start server ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[image-converter] Server listening on http://localhost:${PORT}`);
  console.log(`[image-converter] Temp files: ${TMP_DIR}`);
});

module.exports = app; // export for testing
