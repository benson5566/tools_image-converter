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

    worker.on('message', (result) => {
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

    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
    });
  });
}

module.exports = { convertImage };
