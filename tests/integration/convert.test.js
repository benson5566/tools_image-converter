'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../../server');
const { createTestImage, buildFormData } = require('../helpers');

let server;
let baseUrl;

before(async () => {
  server = app.listen(0); // 隨機 port
  const { port } = server.address();
  baseUrl = `http://localhost:${port}`;
});

after((_, done) => {
  server.closeAllConnections?.();
  server.close(() => {
    // Force-exit to free any background timers / open handles
    // (e.g. Redis reconnect loop, TTL cleanup timeouts) so that
    // node:test can report results cleanly.
    setImmediate(() => process.exit(0));
    done();
  });
});

test('GET /health returns 200', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
});

test('POST /api/convert - no files returns 400', async () => {
  const form = new FormData();
  form.append('outputFormat', 'png');
  const res = await fetch(`${baseUrl}/api/convert`, { method: 'POST', body: form });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error);
});

test('POST /api/convert - invalid outputFormat returns 400', async () => {
  const buf = await createTestImage({ format: 'png' });
  const form = buildFormData([{ buffer: buf, name: 'test.png' }], { outputFormat: 'bmp' });
  const res = await fetch(`${baseUrl}/api/convert`, { method: 'POST', body: form });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /不支援的輸出格式/);
});

test('POST /api/convert - fake magic bytes returns success=false', async () => {
  const fakeBuf = Buffer.from('this is not an image at all!!');
  const form = buildFormData([{ buffer: fakeBuf, name: 'fake.png' }], { outputFormat: 'png' });
  const res = await fetch(`${baseUrl}/api/convert`, { method: 'POST', body: form });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.results[0].success, false);
  assert.match(body.results[0].error, /Magic bytes/);
});

test('POST /api/convert - PNG to JPG success', async () => {
  const buf = await createTestImage({ format: 'png' });
  const form = buildFormData([{ buffer: buf, name: 'test.png' }], { outputFormat: 'jpg', jpgQuality: '85' });
  const res = await fetch(`${baseUrl}/api/convert`, { method: 'POST', body: form });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.results[0].success, true);
  assert.ok(body.results[0].downloadUrl);
  assert.ok(body.results[0].originalSize > 0);
  assert.ok(body.results[0].outputSize > 0);
});

test('POST /api/convert - PNG to WebP success', async () => {
  const buf = await createTestImage({ format: 'png' });
  const form = buildFormData([{ buffer: buf, name: 'test.png' }], { outputFormat: 'webp', webpQuality: '80' });
  const res = await fetch(`${baseUrl}/api/convert`, { method: 'POST', body: form });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.results[0].success, true);
});

test('POST /api/convert - PNG to AVIF success', { timeout: 30000 }, async () => {
  const buf = await createTestImage({ format: 'png' });
  const form = buildFormData([{ buffer: buf, name: 'test.png' }], { outputFormat: 'avif', avifQuality: '50' });
  const res = await fetch(`${baseUrl}/api/convert`, { method: 'POST', body: form });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.results[0].success, true);
  assert.ok(body.results[0].outputName.endsWith('.avif'));
});

test('POST /api/convert - AVIF to PNG success', { timeout: 30000 }, async () => {
  const buf = await createTestImage({ format: 'avif' });
  const form = buildFormData([{ buffer: buf, name: 'test.avif', type: 'image/avif' }], { outputFormat: 'png' });
  const res = await fetch(`${baseUrl}/api/convert`, { method: 'POST', body: form });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.results[0].success, true);
});

test('POST /api/convert - jpgQuality out of range returns 400', async () => {
  const buf = await createTestImage({ format: 'png' });
  const form = buildFormData([{ buffer: buf, name: 'test.png' }], { outputFormat: 'jpg', jpgQuality: '59' });
  const res = await fetch(`${baseUrl}/api/convert`, { method: 'POST', body: form });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /jpgQuality/);
});

test('POST /api/convert - avifQuality out of range returns 400', async () => {
  const buf = await createTestImage({ format: 'png' });
  const form = buildFormData([{ buffer: buf, name: 'test.png' }], { outputFormat: 'avif', avifQuality: '64' });
  const res = await fetch(`${baseUrl}/api/convert`, { method: 'POST', body: form });
  assert.equal(res.status, 400);
});

test('POST /api/convert - invalid bgColor returns 400', async () => {
  const buf = await createTestImage({ format: 'png' });
  const form = buildFormData([{ buffer: buf, name: 'test.png' }], { outputFormat: 'jpg', bgColor: 'red' });
  const res = await fetch(`${baseUrl}/api/convert`, { method: 'POST', body: form });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /bgColor/);
});

test('GET /download/:filename - after convert, file is downloadable', async () => {
  const buf = await createTestImage({ format: 'png' });
  const form = buildFormData([{ buffer: buf, name: 'test.png' }], { outputFormat: 'png' });
  const convertRes = await fetch(`${baseUrl}/api/convert`, { method: 'POST', body: form });
  const { results } = await convertRes.json();
  assert.equal(results[0].success, true);

  const dlRes = await fetch(`${baseUrl}${results[0].downloadUrl}`);
  assert.equal(dlRes.status, 200);
  assert.ok(dlRes.headers.get('content-disposition').includes('attachment'));
});

test('GET /download/:filename - path traversal returns 400', async () => {
  const res = await fetch(`${baseUrl}/download/..%2F..%2Fetc%2Fpasswd`);
  assert.equal(res.status, 400);
});

test('GET /download/:filename - non-existent file returns 404', async () => {
  const res = await fetch(`${baseUrl}/download/00000000-0000-0000-0000-000000000000.png`);
  assert.equal(res.status, 404);
});

test('POST /api/zip - empty files returns 400', async () => {
  const res = await fetch(`${baseUrl}/api/zip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: [] }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/zip - invalid filename returns 400', async () => {
  const res = await fetch(`${baseUrl}/api/zip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: ['../etc/passwd'] }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/zip - all files missing returns 404', async () => {
  const res = await fetch(`${baseUrl}/api/zip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: ['00000000-0000-0000-0000-000000000000.png'] }),
  });
  assert.equal(res.status, 404);
});

test('POST /api/zip - valid files returns zip', async () => {
  // convert two files first
  const buf = await createTestImage({ format: 'png' });
  const form = buildFormData(
    [{ buffer: buf, name: 'a.png' }, { buffer: buf, name: 'b.png' }],
    { outputFormat: 'png' }
  );
  const convertRes = await fetch(`${baseUrl}/api/convert`, { method: 'POST', body: form });
  const { results } = await convertRes.json();
  const filenames = results.filter(r => r.success).map(r => {
    const m = r.downloadUrl.match(/\/download\/([a-zA-Z0-9\-.]+)/);
    return m ? m[1] : null;
  }).filter(Boolean);

  const zipRes = await fetch(`${baseUrl}/api/zip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: filenames }),
  });
  assert.equal(zipRes.status, 200);
  assert.equal(zipRes.headers.get('content-type'), 'application/zip');
});

test('Security headers are present', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.ok(res.headers.get('x-content-type-options'));
  assert.ok(res.headers.get('x-frame-options'));
  assert.ok(res.headers.get('content-security-policy'));
});

test('Batch convert - 3 files returns 3 results', async () => {
  const buf = await createTestImage({ format: 'jpg' });
  const form = buildFormData(
    [
      { buffer: buf, name: '1.jpg', type: 'image/jpeg' },
      { buffer: buf, name: '2.jpg', type: 'image/jpeg' },
      { buffer: buf, name: '3.jpg', type: 'image/jpeg' },
    ],
    { outputFormat: 'png' }
  );
  const res = await fetch(`${baseUrl}/api/convert`, { method: 'POST', body: form });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.results.length, 3);
  body.results.forEach(r => assert.equal(r.success, true));
});
