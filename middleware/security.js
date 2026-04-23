'use strict';

// ── Optional Redis client (falls back to in-memory if unavailable) ─────────────

let redisClient = null;
try {
  const { createClient } = require('redis');
  redisClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
  redisClient.connect().catch(() => { redisClient = null; });
} catch { redisClient = null; }

// ── Constants ──────────────────────────────────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 60 * 1000;   // 1 minute
const RATE_LIMIT_MAX = 20;                 // requests per window per IP

const ALLOWED_OUTPUT_FORMATS = new Set(['png', 'jpg', 'webp']);
const JPG_QUALITY_MIN = 60;
const JPG_QUALITY_MAX = 100;
const BG_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

// ── 1. Security HTTP Headers ───────────────────────────────────────────────────

/**
 * Attach hardened security headers to every response.
 * Deliberately hand-rolled — no helmet dependency.
 */
function securityHeaders(req, res, next) {
  // Prevent MIME-type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Disallow embedding in iframes (clickjacking prevention)
  res.setHeader('X-Frame-Options', 'DENY');

  // CSP: allow same-origin resources + Cloudflare Turnstile challenge scripts/frames
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com"
  );

  // Legacy XSS filter for older browsers
  res.setHeader('X-XSS-Protection', '1; mode=block');

  next();
}

// ── 2. In-memory Rate Limiter ──────────────────────────────────────────────────

/**
 * Minimal sliding-window rate limiter backed by a plain Map.
 *
 * Each entry: { count: number, windowStart: number }
 *
 * Memory safety: stale entries are pruned on every request so the Map does not
 * grow without bound even under a large number of distinct IPs.
 */
const _rateLimitStore = new Map();

/**
 * Derive the client IP from the request, honouring X-Forwarded-For only when
 * running behind a trusted proxy (set req.app.locals.trustProxy = true).
 */
function _getClientIp(req) {
  const trustProxy = req.app && req.app.locals && req.app.locals.trustProxy;
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      // X-Forwarded-For may be a comma-separated list; take the first entry.
      return forwarded.split(',')[0].trim();
    }
  }
  return (
    req.ip ||
    (req.connection && req.connection.remoteAddress) ||
    'unknown'
  );
}

/**
 * Rate-limit middleware: max RATE_LIMIT_MAX requests per IP per RATE_LIMIT_WINDOW_MS.
 *
 * Uses Redis (INCR + EXPIRE) when a live Redis connection is available;
 * falls back to the in-memory Map otherwise.
 */
async function rateLimiter(req, res, next) {
  const ip = _getClientIp(req);

  // ── Redis path ─────────────────────────────────────────────────────────────
  if (redisClient && redisClient.isOpen) {
    try {
      const key = `rate:${ip}`;
      const count = await redisClient.incr(key);
      if (count === 1) await redisClient.expire(key, 60);
      if (count > RATE_LIMIT_MAX) {
        const ttl = await redisClient.ttl(key);
        const retryAfterSec = ttl > 0 ? ttl : 60;
        res.setHeader('Retry-After', String(retryAfterSec));
        return res.status(429).json({
          error: '請求過於頻繁，請稍後再試。',
          retryAfterSeconds: retryAfterSec,
        });
      }
      return next();
    } catch {
      // Redis error: fall through to in-memory fallback
    }
  }

  // ── In-memory fallback ─────────────────────────────────────────────────────
  const now = Date.now();

  // Prune entries whose window has expired (prevent unbounded Map growth).
  for (const [key, entry] of _rateLimitStore) {
    if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
      _rateLimitStore.delete(key);
    }
  }

  const entry = _rateLimitStore.get(ip);

  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    // First request in this window
    _rateLimitStore.set(ip, { count: 1, windowStart: now });
    return next();
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    const retryAfterSec = Math.ceil(
      (RATE_LIMIT_WINDOW_MS - (now - entry.windowStart)) / 1000
    );
    res.setHeader('Retry-After', String(retryAfterSec));
    return res.status(429).json({
      error: '請求過於頻繁，請稍後再試。',
      retryAfterSeconds: retryAfterSec,
    });
  }

  entry.count += 1;
  return next();
}

// ── 3. Content-Type Guard ──────────────────────────────────────────────────────

/**
 * Reject any request whose Content-Type is not multipart/form-data.
 *
 * Multer itself also validates this, but an early rejection before multer
 * runs avoids unnecessary body parsing.
 */
function requireMultipart(req, res, next) {
  const contentType = req.headers['content-type'] || '';

  if (!contentType.includes('multipart/form-data')) {
    return res.status(400).json({
      error: 'Content-Type 必須為 multipart/form-data。',
    });
  }

  next();
}

// ── 4. Output Parameter Validation ────────────────────────────────────────────

/**
 * Validate conversion-specific parameters present in req.body.
 *
 * Expected fields (all optional with sensible defaults):
 *   - outputFormat  : 'png' | 'jpg' | 'webp'
 *   - jpgQuality    : integer 60-100
 *   - bgColor       : hex colour string, e.g. '#ff00aa'
 *
 * Any field that is absent is not validated (the converter has defaults).
 * Call this middleware AFTER multer so that req.body is populated.
 */
function validateConversionParams(req, res, next) {
  const { outputFormat, jpgQuality, bgColor } = req.body || {};

  // -- outputFormat --
  if (outputFormat !== undefined) {
    if (!ALLOWED_OUTPUT_FORMATS.has(outputFormat)) {
      return res.status(400).json({
        error: `不支援的輸出格式「${outputFormat}」。允許的格式：${[...ALLOWED_OUTPUT_FORMATS].join(', ')}`,
      });
    }
  }

  // -- jpgQuality --
  if (jpgQuality !== undefined) {
    const quality = Number(jpgQuality);

    if (
      !Number.isFinite(quality) ||
      !Number.isInteger(quality) ||
      quality < JPG_QUALITY_MIN ||
      quality > JPG_QUALITY_MAX
    ) {
      return res.status(400).json({
        error: `jpgQuality 必須為 ${JPG_QUALITY_MIN}–${JPG_QUALITY_MAX} 之間的整數。`,
      });
    }
  }

  // -- bgColor --
  if (bgColor !== undefined) {
    if (!BG_COLOR_RE.test(bgColor)) {
      return res.status(400).json({
        error: 'bgColor 必須為有效的 hex 色碼，例如 #1a2b3c。',
      });
    }
  }

  next();
}

// ── Exports ────────────────────────────────────────────────────────────────────

module.exports = {
  securityHeaders,
  rateLimiter,
  requireMultipart,
  validateConversionParams,
};
