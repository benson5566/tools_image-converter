'use strict';

const sharp = require('sharp');

/**
 * Detect if AVIF/image has non-sRGB colorspace from Sharp metadata.
 * Sharp reports colorspace as 'srgb', 'rgb16', 'cmyk', etc.
 */
function isNonSrgb(metadata) {
  const { space } = metadata;
  if (!space) return false;
  return space !== 'srgb';
}

/**
 * Convert a single image buffer to the target format.
 *
 * @param {Buffer}  inputBuffer   - Raw file bytes
 * @param {string}  originalName  - Original filename (for output name derivation)
 * @param {object}  options
 * @param {string}  options.outputFormat  - 'png' | 'jpg' | 'webp'
 * @param {number}  [options.jpgQuality=85]  - JPEG quality 60-100
 * @param {string}  [options.bgColor='#ffffff']  - Hex background for JPG flatten
 * @returns {Promise<{ buffer: Buffer, outputName: string, warnings: string[] }>}
 */
async function convertImage(inputBuffer, originalName, options = {}) {
  const {
    outputFormat,
    jpgQuality = 85,
    bgColor = '#ffffff',
  } = options;

  const warnings = [];

  // Build initial Sharp pipeline from buffer
  let pipeline = sharp(inputBuffer, { failOn: 'none' });

  // ── 1. Fetch metadata BEFORE any transformation ───────────────────────────
  const metadata = await pipeline.metadata();

  // ── 2. Animated WebP: extract first frame ─────────────────────────────────
  if (metadata.pages && metadata.pages > 1) {
    warnings.push('此檔案為動態 WebP，僅保留第一幀');
    // Re-create pipeline with page option to extract only the first frame
    pipeline = sharp(inputBuffer, { failOn: 'none', page: 0 });
    // Re-fetch metadata for the single frame
    await pipeline.metadata();
  }

  // ── 3. HDR / non-sRGB colorspace: tone-map to sRGB ────────────────────────
  if (isNonSrgb(metadata)) {
    warnings.push('此圖片含 HDR 色域，已自動轉換為標準色域，顏色可能略有差異');
    pipeline = pipeline.toColorspace('srgb');
  }

  // ── 4. Apply format-specific transformations ───────────────────────────────
  const hasAlpha = metadata.hasAlpha;

  switch (outputFormat) {
    case 'jpg': {
      // Flatten transparency onto bgColor before encoding as JPEG
      pipeline = pipeline
        .flatten({ background: bgColor })
        .jpeg({ quality: jpgQuality });
      break;
    }

    case 'png': {
      pipeline = pipeline.png();
      break;
    }

    case 'webp': {
      if (hasAlpha) {
        pipeline = pipeline.webp({ lossless: true });
      } else {
        pipeline = pipeline.webp({ quality: 80 });
      }
      break;
    }

    default:
      throw new Error(`Unsupported output format: ${outputFormat}`);
  }

  const buffer = await pipeline.toBuffer();

  // Derive output filename: replace extension
  const extMap = { jpg: 'jpg', png: 'png', webp: 'webp' };
  const outputExt = extMap[outputFormat];
  const baseName = originalName.replace(/\.[^.]+$/, '');
  const outputName = `${baseName}.${outputExt}`;

  return { buffer, outputName, warnings };
}

module.exports = { convertImage };
