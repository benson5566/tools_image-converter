'use strict';

const { Worker } = require('worker_threads');
const path = require('path');

const WORKER_PATH = path.join(__dirname, '../workers/converter-worker.js');

/**
 * Convert a single image buffer via a dedicated Worker Thread.
 * Isolates Sharp/libvips from the main Express process.
 */
function convertImage(inputBuffer, originalName, options = {}) {
  return new Promise((resolve, reject) => {
    // Build a single ArrayBuffer slice and reuse the same reference for both
    // workerData and transferList. This ensures the buffer is truly transferred
    // (zero-copy) rather than copied via structured clone.
    const arrayBuffer = inputBuffer.buffer.slice(
      inputBuffer.byteOffset,
      inputBuffer.byteOffset + inputBuffer.byteLength
    );

    const worker = new Worker(WORKER_PATH, {
      workerData: {
        inputBuffer: arrayBuffer,
        originalName,
        options,
      },
      transferList: [arrayBuffer],
    });

    // Kill the worker if it takes too long (hung libvips decode, decompression
    // bomb that slipped through the size estimate, etc.).
    const TIMEOUT_MS = 60_000; // 60 seconds per image
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('圖片轉換逾時，請確認圖片未損毀後再試'));
    }, TIMEOUT_MS);

    worker.on('message', (result) => {
      clearTimeout(timer);
      if (result.success) {
        resolve({
          buffer: Buffer.from(result.buffer),
          outputName: result.outputName,
          warnings: result.warnings,
        });
      } else {
        reject(new Error(result.error));
      }
    });

    worker.on('error', (err) => { clearTimeout(timer); reject(err); });
    worker.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
    });
  });
}

module.exports = { convertImage };
