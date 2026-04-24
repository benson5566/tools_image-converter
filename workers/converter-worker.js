'use strict';

const { workerData, parentPort } = require('worker_threads');
const sharp = require('sharp');

async function run() {
  const { inputBuffer, originalName, options } = workerData;
  // inputBuffer 是透過 SharedArrayBuffer 或 Buffer 傳入
  const buf = Buffer.from(inputBuffer);

  const {
    outputFormat,
    jpgQuality = 85,
    avifQuality = 50,
    bgColor = '#ffffff',
  } = options;

  const warnings = [];

  let pipeline = sharp(buf, { failOn: 'none' });
  const metadata = await pipeline.metadata();

  // Animated WebP
  if (metadata.pages && metadata.pages > 1) {
    warnings.push('此檔案為動態 WebP，僅保留第一幀');
    pipeline = sharp(buf, { failOn: 'none', page: 0 });
  }

  // HDR / non-sRGB
  if (metadata.space && metadata.space !== 'srgb') {
    warnings.push('此圖片含 HDR 色域，已自動轉換為標準色域，顏色可能略有差異');
    pipeline = pipeline.toColorspace('srgb');
  }

  // Strip EXIF
  pipeline = pipeline.withMetadata(false);

  const hasAlpha = metadata.hasAlpha;

  switch (outputFormat) {
    case 'jpg':
      pipeline = pipeline.flatten({ background: bgColor }).jpeg({ quality: jpgQuality });
      break;
    case 'png':
      pipeline = pipeline.png();
      break;
    case 'webp':
      pipeline = hasAlpha ? pipeline.webp({ lossless: true }) : pipeline.webp({ quality: 80 });
      break;
    case 'avif':
      pipeline = pipeline.avif({ quality: avifQuality, effort: 4 });
      break;
    default:
      throw new Error(`Unsupported format: ${outputFormat}`);
  }

  const outBuf = await pipeline.toBuffer();
  const ext = { jpg: 'jpg', png: 'png', webp: 'webp', avif: 'avif' }[outputFormat];
  const baseName = originalName
    .replace(/\.[^.]+$/, '')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .slice(0, 200);
  const outputName = `${baseName}.${ext}`;

  // Transfer the underlying ArrayBuffer (zero-copy) instead of structured-clone copy
  const outArrayBuffer = outBuf.buffer.slice(outBuf.byteOffset, outBuf.byteOffset + outBuf.byteLength);
  parentPort.postMessage(
    { success: true, buffer: outArrayBuffer, outputName, warnings },
    [outArrayBuffer],
  );
}

run().catch(err => {
  parentPort.postMessage({ success: false, error: err.message });
});
