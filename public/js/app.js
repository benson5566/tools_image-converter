/* =============================================
   Image Converter – Frontend Application
   ============================================= */

'use strict';

// ── Constants ────────────────────────────────
const MAX_FILES = 50;
const MAX_FILE_SIZE_MB = 50;
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;
const ACCEPTED_TYPES = new Set(['image/webp', 'image/avif', 'image/png', 'image/jpeg']);
const ACCEPTED_EXT   = new Set(['.webp', '.avif', '.png', '.jpg', '.jpeg']);

// ── State ────────────────────────────────────
let selectedFiles   = [];   // File[]
let outputFormat    = 'jpg';
let jpgQuality      = 85;
let avifQuality     = 50;
let webpQuality     = 80;
let bgColor         = '#ffffff';
let hasTransparent  = false; // any selected file has alpha
let isConverting    = false;
let convertResults  = [];   // result objects from API
let turnstileToken  = null;

// ── DOM refs ─────────────────────────────────
const dropZone         = document.getElementById('dropZone');
const fileInput        = document.getElementById('fileInput');
const fileList         = document.getElementById('fileList');
const uploadError      = document.getElementById('uploadError');
const formatBtns       = document.querySelectorAll('.format-btn');
const jpgOptions       = document.getElementById('jpgOptions');
const qualitySlider    = document.getElementById('qualitySlider');
const qualityValue     = document.getElementById('qualityValue');
const bgColorGroup     = document.getElementById('bgColorGroup');
const avifOptions      = document.getElementById('avifOptions');
const avifQualitySlider= document.getElementById('avifQualitySlider');
const avifQualityValue = document.getElementById('avifQualityValue');
const webpOptions      = document.getElementById('webpOptions');
const webpQualitySlider= document.getElementById('webpQualitySlider');
const webpQualityValue = document.getElementById('webpQualityValue');
const webpLosslessNote = document.getElementById('webpLosslessNote');
const colorBtns        = document.querySelectorAll('.color-btn[data-color]');
const customColorLabel = document.querySelector('.color-custom-label');
const customColorInput = document.getElementById('customColorInput');
const customColorSwatch= document.getElementById('customColorSwatch');
const convertBtn       = document.getElementById('convertBtn');
const convertBtnText   = convertBtn.querySelector('.convert-btn-text');
const convertBtnSpinner= convertBtn.querySelector('.convert-btn-spinner');
const progressSection  = document.getElementById('progressSection');
const progressList     = document.getElementById('progressList');
const resultsSection   = document.getElementById('resultsSection');
const resultsList      = document.getElementById('resultsList');
const downloadAllBtn   = document.getElementById('downloadAllBtn');

// ── Utility helpers ──────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function formatExtension(filename) {
  const map = { '.png':'PNG', '.jpg':'JPG', '.jpeg':'JPG', '.webp':'WebP', '.avif':'AVIF' };
  return map[ext(filename).toLowerCase()] || '原始';
}

function calculateSavings(original, output) {
  if (original === 0) return { percent: 0, isSave: false };
  const diff = Math.round(((original - output) / original) * 100);
  return { percent: Math.abs(diff), isSave: output < original };
}

function ext(filename) {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showError(msg) {
  uploadError.textContent = msg;
  uploadError.hidden = false;
}

function clearError() {
  uploadError.hidden = true;
  uploadError.textContent = '';
}

// Detect transparency via Canvas API (100×100 sample for speed)
async function hasTransparency(file) {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = Math.min(img.width,  100);
      canvas.height = Math.min(img.height, 100);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      try {
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] < 255) {
            URL.revokeObjectURL(url);
            resolve(true);
            return;
          }
        }
      } catch (_) {
        // tainted canvas (e.g. cross-origin) – assume no transparency
      }
      URL.revokeObjectURL(url);
      resolve(false);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(false); };
    img.src = url;
  });
}

// ── File validation ──────────────────────────

function validateFiles(incoming) {
  const errors = [];
  const valid  = [];

  for (const file of incoming) {
    const fileExt  = ext(file.name);
    const accepted = ACCEPTED_TYPES.has(file.type) || ACCEPTED_EXT.has(fileExt);

    if (!accepted) {
      errors.push(`「${file.name}」格式不支援（僅接受 WebP / AVIF / PNG / JPG）`);
      continue;
    }
    if (file.size > MAX_FILE_SIZE) {
      errors.push(`「${file.name}」超過 ${MAX_FILE_SIZE_MB} MB 限制（${formatBytes(file.size)}）`);
      continue;
    }
    // Deduplicate by name+size
    const duplicate = selectedFiles.some(f => f.name === file.name && f.size === file.size);
    if (duplicate) continue;

    valid.push(file);
  }

  const totalAfter = selectedFiles.length + valid.length;
  if (totalAfter > MAX_FILES) {
    const allowed = MAX_FILES - selectedFiles.length;
    if (allowed <= 0) {
      errors.push(`已達上限 ${MAX_FILES} 個檔案，無法再新增。`);
      return { valid: [], errors };
    }
    errors.push(`一次最多 ${MAX_FILES} 個檔案，已自動截取前 ${allowed} 個。`);
    valid.splice(allowed);
  }

  return { valid, errors };
}

// ── Render file list ─────────────────────────

// Track file-list thumbnail Object URLs so they can be cleaned up on re-render
const _fileThumbUrls = [];

function renderFileList() {
  // Revoke previous file-list thumbnail Object URLs before re-rendering
  _fileThumbUrls.forEach(u => URL.revokeObjectURL(u));
  _fileThumbUrls.length = 0;

  if (selectedFiles.length === 0) {
    fileList.hidden = true;
    fileList.innerHTML = '';
    updateConvertBtn();
    return;
  }

  fileList.hidden = false;
  fileList.innerHTML = selectedFiles.map((file, idx) => {
    const thumb = URL.createObjectURL(file);
    _fileThumbUrls.push(thumb);
    return `
      <div class="file-item" data-idx="${idx}">
        <img class="file-thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy"
             onerror="this.outerHTML='<div class=\\'file-thumb-placeholder\\'>${escapeHtml(ext(file.name).replace('.', '').toUpperCase())}</div>'" />
        <div class="file-info">
          <div class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
          <div class="file-size">${formatBytes(file.size)}</div>
        </div>
        <button class="file-remove" data-idx="${idx}" aria-label="移除 ${escapeHtml(file.name)}" title="移除">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    `;
  }).join('');

  updateConvertBtn();
}

function removeFile(idx) {
  if (isConverting) return; // block file changes while a conversion is in progress
  selectedFiles.splice(idx, 1);
  renderFileList();
  detectTransparency();
}

// ── Add files ────────────────────────────────

async function addFiles(newFiles) {
  if (isConverting) return; // block file changes while a conversion is in progress
  clearError();
  const { valid, errors } = validateFiles(Array.from(newFiles));

  if (errors.length) showError(errors.join('；'));
  if (!valid.length)  return;

  selectedFiles.push(...valid);
  renderFileList();

  // Re-run transparency detection
  await detectTransparency();
}

// ── Transparency detection ───────────────────

async function detectTransparency() {
  if (selectedFiles.length === 0) {
    bgColorGroup.hidden = true;
    if (webpLosslessNote) webpLosslessNote.hidden = true;
    hasTransparent = false;
    return;
  }
  const results = await Promise.all(selectedFiles.map(f => hasTransparency(f)));
  hasTransparent = results.some(Boolean);
  if (outputFormat === 'jpg') {
    bgColorGroup.hidden = !hasTransparent;
    if (webpLosslessNote) webpLosslessNote.hidden = true;
  } else if (outputFormat === 'webp') {
    bgColorGroup.hidden = true;
    if (webpLosslessNote) {
      webpLosslessNote.hidden = !hasTransparent;
      webpQualitySlider.disabled = hasTransparent;
    }
  } else {
    bgColorGroup.hidden = true;
    if (webpLosslessNote) webpLosslessNote.hidden = true;
  }
}

// ── Format selection ─────────────────────────

formatBtns.forEach(btn => {
  btn.addEventListener('click', async () => {
    outputFormat = btn.dataset.format;

    formatBtns.forEach(b => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
    });

    // Show/hide format-specific options
    if (outputFormat === 'jpg') {
      jpgOptions.hidden = false;
      avifOptions.hidden = true;
      webpOptions.hidden = true;
      await detectTransparency();
    } else if (outputFormat === 'avif') {
      jpgOptions.hidden = true;
      avifOptions.hidden = false;
      webpOptions.hidden = true;
      bgColorGroup.hidden = true;
      hasTransparent = false;
    } else if (outputFormat === 'webp') {
      jpgOptions.hidden = true;
      avifOptions.hidden = true;
      webpOptions.hidden = false;
      await detectTransparency();
    } else {
      // png
      jpgOptions.hidden = true;
      avifOptions.hidden = true;
      webpOptions.hidden = true;
      bgColorGroup.hidden = true;
      hasTransparent = false;
    }
  });
});

// Start with JPG selected and options visible
jpgOptions.hidden = false;
avifOptions.hidden = true;
webpOptions.hidden = true;

// ── Quality slider ────────────────────────────

function updateSliderTrack() {
  const pct = ((jpgQuality - 60) / 40) * 100;
  qualitySlider.style.setProperty('--pct', pct + '%');
}

qualitySlider.addEventListener('input', () => {
  jpgQuality = parseInt(qualitySlider.value, 10);
  qualityValue.textContent = jpgQuality;
  qualitySlider.setAttribute('aria-valuenow', jpgQuality);
  updateSliderTrack();
});

updateSliderTrack(); // initial

// ── AVIF quality slider ───────────────────────

function updateAvifSliderTrack() {
  const pct = ((avifQuality - 1) / 62) * 100;
  avifQualitySlider.style.setProperty('--pct', pct + '%');
}
avifQualitySlider.addEventListener('input', () => {
  avifQuality = parseInt(avifQualitySlider.value, 10);
  avifQualityValue.textContent = avifQuality;
  avifQualitySlider.setAttribute('aria-valuenow', avifQuality);
  updateAvifSliderTrack();
});
updateAvifSliderTrack();

// ── WebP quality slider ───────────────────────

function updateWebpSliderTrack() {
  const pct = ((webpQuality - 1) / 99) * 100;
  webpQualitySlider.style.setProperty('--pct', pct + '%');
}
webpQualitySlider.addEventListener('input', () => {
  webpQuality = parseInt(webpQualitySlider.value, 10);
  webpQualityValue.textContent = webpQuality;
  webpQualitySlider.setAttribute('aria-valuenow', webpQuality);
  updateWebpSliderTrack();
});
updateWebpSliderTrack();

// ── Background color picker ──────────────────

function setActiveColorBtn(activeBtn) {
  [...colorBtns, customColorLabel].forEach(btn => {
    btn.classList.remove('active');
    if (btn.dataset && btn.dataset.color !== undefined) {
      btn.setAttribute('aria-pressed', 'false');
    }
  });
  activeBtn.classList.add('active');
  if (activeBtn.dataset && activeBtn.dataset.color !== undefined) {
    activeBtn.setAttribute('aria-pressed', 'true');
  }
}

colorBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    bgColor = btn.dataset.color;
    setActiveColorBtn(btn);
  });
});

customColorLabel.addEventListener('click', () => {
  customColorInput.click();
});

customColorInput.addEventListener('input', () => {
  bgColor = customColorInput.value;
  customColorSwatch.style.background = bgColor;
  setActiveColorBtn(customColorLabel);
});

customColorInput.addEventListener('change', () => {
  bgColor = customColorInput.value;
  customColorSwatch.style.background = bgColor;
  setActiveColorBtn(customColorLabel);
});

// ── Drag & Drop ───────────────────────────────

dropZone.addEventListener('dragenter', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', e => {
  if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('drag-over');
});
dropZone.addEventListener('drop', async e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const files = e.dataTransfer?.files;
  if (files?.length) await addFiles(files);
});

// Click to open file picker (the hidden input covers the zone)
dropZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});

fileInput.addEventListener('change', async () => {
  if (fileInput.files?.length) await addFiles(fileInput.files);
  fileInput.value = ''; // reset so same file can be re-selected
});

// Delegate file-remove clicks
fileList.addEventListener('click', e => {
  const btn = e.target.closest('.file-remove');
  if (!btn) return;
  removeFile(parseInt(btn.dataset.idx, 10));
});

// ── Convert button state ─────────────────────

function updateConvertBtn() {
  convertBtn.disabled = selectedFiles.length === 0 || isConverting || !turnstileToken;
}

// ── Conversion ───────────────────────────────

function setConverting(val) {
  isConverting = val;
  convertBtnText.hidden = val;
  convertBtnSpinner.hidden = !val;
  updateConvertBtn();
}

function buildProgressItems(files) {
  progressList.innerHTML = '';
  files.forEach((file, i) => {
    const el = document.createElement('div');
    el.className = 'progress-item';
    el.id = `prog-${i}`;
    el.innerHTML = `
      <div class="progress-item-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
      <div class="progress-bar-wrap">
        <div class="progress-bar indeterminate" id="prog-bar-${i}"></div>
      </div>
      <div class="progress-item-status" id="prog-status-${i}">處理中…</div>
    `;
    progressList.appendChild(el);
  });
}

function setProgressDone(i, success, msg) {
  const bar    = document.getElementById(`prog-bar-${i}`);
  const status = document.getElementById(`prog-status-${i}`);
  if (!bar || !status) return;
  bar.classList.remove('indeterminate');
  bar.style.width = '100%';
  if (success) {
    bar.style.background = 'var(--success)';
    status.textContent = '完成';
    status.className = 'progress-item-status done';
  } else {
    bar.style.background = 'var(--error)';
    status.textContent = msg || '失敗';
    status.className = 'progress-item-status error';
  }
}

// Track result-card thumbnail Object URLs so we can revoke them later to free memory
const _thumbUrls = [];

function renderResults(results) {
  // Revoke any previous thumbnail object URLs
  _thumbUrls.forEach(u => URL.revokeObjectURL(u));
  _thumbUrls.length = 0;

  resultsList.innerHTML = '';
  convertResults = results;

  results.forEach((res, idx) => {
    const card = document.createElement('div');
    card.className = 'result-card';

    if (!res.success) {
      card.innerHTML = `
        <div class="result-thumb-wrap">
          <div style="height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:0.78rem;">無預覽</div>
        </div>
        <div class="result-body">
          <div class="result-filename" title="${escapeHtml(res.originalName)}">${escapeHtml(res.originalName)}</div>
        </div>
        <div class="result-error">轉換失敗：${escapeHtml(res.error || '未知錯誤')}</div>
      `;
    } else {
      const badges = (res.warnings || []).map(w => {
        return `<span class="badge badge-warning">${escapeHtml(w)}</span>`;
      }).join('');

      let statsHtml = '';
      if (res.originalSize !== undefined && res.outputSize !== undefined) {
        const origFmt = formatExtension(res.originalName);
        const outFmt = formatExtension(res.outputName || res.originalName);
        const { percent, isSave } = calculateSavings(res.originalSize, res.outputSize);
        const savingClass = res.originalSize === res.outputSize ? 'stat-neutral'
          : isSave ? 'stat-save' : 'stat-increase';
        const savingText = res.originalSize === res.outputSize ? '大小不變'
          : isSave ? `節省 ${percent}%` : `增加 ${percent}%`;
        statsHtml = `
          <div class="result-stats">
            <div class="stat-row">
              <span class="stat-label">${origFmt} ${formatBytes(res.originalSize)} → ${outFmt} ${formatBytes(res.outputSize)}</span>
              <span class="${savingClass}">${savingText}</span>
            </div>
          </div>`;
      }

      // Use original file as thumbnail source — avoids hitting the download
      // endpoint (which deletes the file on first access). The original file
      // is visually close enough for a preview, and the real converted file
      // is preserved for when the user clicks the download button.
      const originalFile = selectedFiles[idx];
      const thumbSrc = originalFile ? URL.createObjectURL(originalFile) : '';
      if (thumbSrc) _thumbUrls.push(thumbSrc);

      card.innerHTML = `
        <div class="result-thumb-wrap">
          <img class="result-thumb" src="${escapeHtml(thumbSrc)}" alt="${escapeHtml(res.originalName)}" loading="lazy" />
          ${badges ? `<div class="result-badges">${badges}</div>` : ''}
        </div>
        <div class="result-body">
          <div class="result-filename" title="${escapeHtml(res.outputName || res.originalName)}">${escapeHtml(res.outputName || res.originalName)}</div>
          ${statsHtml}
          <a class="result-download" href="${escapeHtml(res.downloadUrl)}" download="${escapeHtml(res.outputName || res.originalName)}">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M7 1.5V9M3.5 6L7 9.5L10.5 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M1.5 11.5H12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            </svg>
            下載
          </a>
        </div>
      `;
    }

    resultsList.appendChild(card);
  });

  resultsSection.hidden = false;
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

convertBtn.addEventListener('click', async () => {
  if (isConverting || selectedFiles.length === 0) return;

  clearError();
  setConverting(true);
  resultsSection.hidden = true;
  resultsList.innerHTML = '';

  // Show progress UI
  progressSection.hidden = false;
  buildProgressItems(selectedFiles);
  progressSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Build FormData
  const formData = new FormData();
  selectedFiles.forEach(file => formData.append('files[]', file));
  formData.append('outputFormat', outputFormat);

  if (outputFormat === 'jpg') {
    formData.append('jpgQuality', String(jpgQuality));
    if (hasTransparent) formData.append('bgColor', bgColor);
  } else if (outputFormat === 'avif') {
    formData.append('avifQuality', String(avifQuality));
  } else if (outputFormat === 'webp') {
    formData.append('webpQuality', String(webpQuality));
  }

  if (turnstileToken) {
    formData.append('cf-turnstile-response', turnstileToken);
  }

  try {
    const response = await fetch('/api/convert', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      let errMsg = `伺服器錯誤（${response.status}）`;
      try {
        const errData = await response.json();
        if (errData?.error) errMsg = errData.error;
      } catch (_) { /* ignore */ }
      throw new Error(errMsg);
    }

    const data = await response.json();
    const results = data.results || [];

    // Update each progress item
    results.forEach((res, i) => {
      setProgressDone(i, res.success, res.error);
    });

    // Small delay so user sees all-green state, then show results
    await new Promise(r => setTimeout(r, 600));

    progressSection.hidden = true;
    renderResults(results);

  } catch (err) {
    // Mark all remaining as failed
    selectedFiles.forEach((_, i) => {
      const bar    = document.getElementById(`prog-bar-${i}`);
      const status = document.getElementById(`prog-status-${i}`);
      if (bar && bar.classList.contains('indeterminate')) {
        setProgressDone(i, false, '失敗');
      }
    });
    showError(`轉換失敗：${err.message || '請稍後再試'}`);
  } finally {
    setConverting(false);
    if (window.turnstile) {
      window.turnstile.reset();
      turnstileToken = null;
      updateConvertBtn();
    }
  }
});

// ── Download All ──────────────────────────────

function setDownloadLoading(isLoading) {
  downloadAllBtn.disabled = isLoading;
  if (isLoading) {
    downloadAllBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true" style="animation:spin 0.8s linear infinite">
        <circle cx="10" cy="10" r="8" stroke="white" stroke-width="2" stroke-dasharray="40" stroke-dashoffset="15" stroke-linecap="round"/>
      </svg>
      下載中…`;
  } else {
    downloadAllBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 2V10M4 7L8 11L12 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M2 13H14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
      全部下載`;
  }
}

downloadAllBtn.addEventListener('click', async () => {
  const successes = convertResults.filter(r => r.success && r.downloadUrl);
  if (!successes.length) return;

  if (successes.length === 1) {
    const a = document.createElement('a');
    a.href = successes[0].downloadUrl;
    a.download = successes[0].outputName || successes[0].originalName || 'download';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return;
  }

  setDownloadLoading(true);
  try {
    const filenames = successes.map(res => {
      const match = res.downloadUrl.match(/\/download\/([a-zA-Z0-9\-\.]+)/);
      return match ? match[1] : null;
    }).filter(Boolean);

    if (filenames.length === 0) throw new Error('無法解析檔案名稱');

    const response = await fetch('/api/zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: filenames }),
    });

    if (!response.ok) {
      let errMsg = `伺服器錯誤（${response.status}）`;
      try { const d = await response.json(); if (d?.error) errMsg = d.error; } catch (_) {}
      throw new Error(errMsg);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'images.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    showError(`下載 ZIP 失敗：${err.message || '請稍後再試'}`);
  } finally {
    setDownloadLoading(false);
  }
});

// ── Turnstile callbacks ───────────────────────

window.onTurnstileSuccess = function(token) {
  turnstileToken = token;
  updateConvertBtn();
};
window.onTurnstileExpired = function() {
  turnstileToken = null;
  updateConvertBtn();
};

// ── Init ──────────────────────────────────────

// If Turnstile is using the placeholder key (dev/staging), bypass token requirement
// so the convert button is usable without a real Cloudflare account.
const cfWidget = document.querySelector('.cf-turnstile');
if (cfWidget && cfWidget.dataset.sitekey === '0x4AAAAAAA_PLACEHOLDER') {
  turnstileToken = 'dev-bypass';
  // Hide the widget wrapper so the placeholder UI doesn't confuse users in dev
  const turnstileWrapper = document.querySelector('.turnstile-wrapper');
  if (turnstileWrapper) turnstileWrapper.hidden = true;
}

updateConvertBtn();
