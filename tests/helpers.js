'use strict';

const sharp = require('sharp');

// 建立測試用圖片 buffer
async function createTestImage({ width = 100, height = 100, format = 'png', hasAlpha = false } = {}) {
  const channels = hasAlpha ? 4 : 3;
  const background = hasAlpha
    ? { r: 100, g: 150, b: 200, alpha: 0.5 }
    : { r: 100, g: 150, b: 200 };

  const builder = sharp({
    create: { width, height, channels, background }
  });

  switch (format) {
    case 'png': return builder.png().toBuffer();
    case 'jpg': return builder.jpeg().toBuffer();
    case 'webp': return builder.webp().toBuffer();
    case 'avif': return builder.avif().toBuffer();
    default: throw new Error(`Unknown format: ${format}`);
  }
}

// 建立 multipart form data（用 FormData API）
function buildFormData(files, fields = {}) {
  const form = new FormData();
  for (const { buffer, name, type = 'image/png' } of files) {
    form.append('files[]', new Blob([buffer], { type }), name);
  }
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  return form;
}

module.exports = { createTestImage, buildFormData };
