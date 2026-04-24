# ImageConvert

支援 WebP、AVIF、PNG、JPG 四種格式互轉的 Web 服務，以 Express + Sharp 為核心，提供批次轉換、安全驗證與 Docker 化部署能力。

**功能亮點**

- **格式**：WebP / AVIF / PNG / JPG 四向互轉
- **批次**：最多 50 個檔案，單檔 50 MB，批次總量 500 MB
- **安全**：Magic bytes 驗證、EXIF 剝除、速率限制、Cloudflare Turnstile bot 防護
- **轉換**：Worker Thread 隔離（Sharp 不佔用主執行緒），60 秒超時保護

---

## 目錄

1. [快速啟動](#1-快速啟動)
2. [環境變數說明](#2-環境變數說明)
3. [API 文件](#3-api-文件)
4. [格式支援矩陣](#4-格式支援矩陣)
5. [架構說明](#5-架構說明)
6. [開發指南](#6-開發指南)
7. [部署注意事項](#7-部署注意事項)
8. [常見問題](#8-常見問題)

---

## 1. 快速啟動

### 本機開發（不用 Docker）

```bash
cd examples/image-converter
npm install
cp .env.example .env
node server.js
# 開啟 http://localhost:3000
```

### Docker Compose（生產）

```bash
# 1. 設定環境變數
cp .env.example .env
# 編輯 .env 填入 TURNSTILE_SECRET_KEY

# 2. 產生 TLS 憑證（開發用自簽）
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes \
  -out certs/image-converter.crt \
  -keyout certs/image-converter.key \
  -days 365 -subj "/CN=localhost"
openssl dhparam -out certs/dhparam.pem 2048

# 3. 啟動
docker compose up -d

# 4. 確認服務
curl -k https://localhost/health
```

---

## 2. 環境變數說明

| 變數 | 必填 | 預設值 | 說明 |
|------|------|--------|------|
| `PORT` | 否 | `3000` | Node.js 監聽埠號 |
| `NODE_ENV` | 否 | `production` | 執行環境；設為 `production` 時若缺少 `TURNSTILE_SECRET_KEY` 會輸出警告 |
| `REDIS_URL` | 否 | `redis://localhost:6379` | Redis 連線 URL，用於持久化速率限制計數；未設定時降級為記憶體模式 |
| `TURNSTILE_SECRET_KEY` | 建議填寫 | （空）| Cloudflare Turnstile 伺服器端金鑰；未設定時跳過 bot 驗證，**生產環境強烈建議填寫** |

---

## 3. API 文件

### POST /api/convert

將一或多個圖片檔案轉換為指定格式。

**Content-Type**：`multipart/form-data`

#### 請求欄位

| 欄位 | 型別 | 必填 | 值域 / 格式 | 說明 |
|------|------|------|-------------|------|
| `files[]` | File（可多個） | 是 | WebP / AVIF / PNG / JPG；單檔 ≤ 50 MB；最多 50 個；批次總量 ≤ 500 MB | 要轉換的圖片檔案 |
| `outputFormat` | string | 是 | `png` \| `jpg` \| `webp` \| `avif` | 輸出格式 |
| `jpgQuality` | integer | 否 | 60–100（預設 `85`） | JPG 輸出品質；僅在 `outputFormat=jpg` 時有效 |
| `avifQuality` | integer | 否 | 1–63（預設 `50`） | AVIF 輸出品質；數值越低壓縮率越高 |
| `webpQuality` | integer | 否 | 1–100（預設 `80`） | WebP 有損輸出品質；含 Alpha 通道的圖片自動切換無損模式 |
| `bgColor` | string | 否 | `#rrggbb`（預設 `#ffffff`） | 輸出 JPG 時用來填平透明背景的底色 |
| `cf-turnstile-response` | string | 條件必填 | Cloudflare Turnstile token | 伺服器端設定 `TURNSTILE_SECRET_KEY` 時必須提供，否則回傳 400 |

#### 成功回應（HTTP 200）

```json
{
  "results": [
    {
      "originalName": "photo.png",
      "outputName": "photo.jpg",
      "downloadUrl": "/download/550e8400-e29b-41d4-a716-446655440000.jpg?name=photo.jpg",
      "warnings": [],
      "success": true,
      "originalSize": 204800,
      "outputSize": 98304
    },
    {
      "originalName": "broken.png",
      "outputName": null,
      "downloadUrl": null,
      "warnings": [],
      "success": false,
      "error": "無法識別的圖片格式（Magic bytes 驗證失敗）"
    }
  ]
}
```

> 批次請求時，即使部分檔案失敗，整體回應仍為 HTTP 200；請依各項目的 `success` 欄位判斷結果。

#### 錯誤回應

| HTTP Code | 說明 |
|-----------|------|
| `400` | 請求參數錯誤（缺少檔案、格式不支援、品質數值超出範圍、bgColor 格式錯誤、缺少 Turnstile token 等） |
| `400` | 非預期的 multipart 欄位名稱（應使用 `files[]`） |
| `403` | Cloudflare Turnstile 驗證失敗 |
| `413` | 單一檔案超過 50 MB |
| `429` | 速率限制（每 IP 每分鐘最多 20 次 API 請求）；回應包含 `Retry-After` 標頭 |
| `500` | 伺服器內部錯誤 |

---

### GET /download/:filename

下載已轉換的圖片。

#### 路徑參數

| 參數 | 說明 |
|------|------|
| `filename` | 轉換後的儲存檔名，格式為 `<uuid>.<ext>`，由 `/api/convert` 回應的 `downloadUrl` 提供 |

#### 查詢參數

| 參數 | 說明 |
|------|------|
| `name` | （選填）URL-encoded 的人類可讀檔名，用於瀏覽器下載時的 `Content-Disposition` 檔名 |

#### 說明

- 檔案在轉換後保留最多 **15 分鐘**（TTL）。
- **下載成功後立即刪除**，不會留存於伺服器。
- 檔案不存在或已過期時回傳 HTTP 404。

---

### POST /api/zip

將多個已轉換的檔案打包成單一 ZIP 壓縮包下載。

**Content-Type**：`application/json`

#### 請求體

```json
{
  "files": ["550e8400-e29b-41d4-a716-446655440000.jpg", "6ba7b810-9dad-11d1-80b4-00c04fd430c8.png"]
}
```

| 欄位 | 型別 | 必填 | 值域 | 說明 |
|------|------|------|------|------|
| `files` | string[] | 是 | 1–50 個元素 | 要打包的儲存檔名列表（`<uuid>.<ext>` 格式） |

#### 回應

- **Content-Type**：`application/zip`
- 檔名：`images.zip`
- 若部分檔案已過期，ZIP 內會附上 `_MISSING_FILES.txt` 說明哪些檔案未包含。
- 全部檔案皆不存在時回傳 HTTP 404。

---

### GET /health

服務健康檢查。

#### 回應範例（HTTP 200）

```json
{
  "status": "ok",
  "timestamp": "2026-04-24T08:00:00.000Z",
  "uptime": 3600.123
}
```

---

## 4. 格式支援矩陣

| 輸入 \ 輸出 | JPG | PNG | WebP | AVIF |
|------------|:---:|:---:|:----:|:----:|
| **JPG**    |  v  |  v  |   v  |   v  |
| **PNG**    |  v  |  v  |   v  |   v  |
| **WebP**   |  v  |  v  |   v  |   v  |
| **AVIF**   |  v  |  v  |   v  |   v  |

所有四種格式皆可作為輸入或輸出，支援完整四向互轉。

---

## 5. 架構說明

### 系統架構圖

```
Browser
  |
  | HTTPS (443) / HTTP 重導 (80)
  v
Nginx (nginx:1.27-alpine)
  |  反向代理，TLS 終止，連線數 / 速率限制
  |  upstream: app:3000（Docker 內網 DNS）
  v
Node.js / Express (app:3000)
  |
  +-- Multer（memory storage）：接收 multipart 上傳
  |
  +-- Magic bytes 驗證：確認圖片格式真實性
  |
  +-- Sharp in Worker Thread：圖片轉換（隔離主執行緒）
  |     └── 60 秒超時保護
  |
  +-- /tmp/image-converter：暫存轉換結果（15 分鐘 TTL）
  |
  +-- Redis（redis:7-alpine）：分散式速率限制
        └── 無 Redis 時降級為記憶體 Map
```

### 安全機制

| 機制 | 說明 |
|------|------|
| **Magic bytes 驗證** | 讀取檔案開頭的原始位元組確認格式，防止副檔名偽造 |
| **EXIF 剝除** | 所有輸出圖片一律移除 EXIF / XMP / IPTC metadata，保護拍攝地點等隱私資訊 |
| **解壓炸彈防護** | 轉換前預估解壓後記憶體用量（width × height × 4 bytes），超過 50 MB 拒絕處理 |
| **尺寸限制** | 圖片任一邊長不得超過 8000 px |
| **速率限制** | 每 IP 每分鐘最多 20 次 API 請求（Redis 或記憶體），Nginx 層另有 10 req/min 轉換端點限制 |
| **Cloudflare Turnstile** | 前端 bot 挑戰，伺服器端驗證 token，可選用 |
| **Worker Thread 隔離** | Sharp/libvips 在獨立執行緒執行，單張圖片轉換 hang 不影響主程序 |
| **安全標頭** | CSP、HSTS、X-Frame-Options、X-Content-Type-Options 等由 Express 層統一設定 |
| **路徑遍歷防護** | 下載路由驗證 `path.resolve()` 結果必須位於 `TMP_DIR` 之內 |

---

## 6. 開發指南

### 目錄結構

```
examples/image-converter/
├── server.js                  # Express 應用程式進入點（PORT、路由掛載）
├── package.json
├── .env.example               # 環境變數範本
├── Dockerfile                 # 生產映像
├── Dockerfile.dev             # 開發映像（支援熱重載）
├── docker-compose.yml         # 生產部署（app + redis + nginx）
├── docker-compose.dev.yml     # 開發覆蓋層（掛載原始碼、開放 debug port）
├── nginx.conf                 # Nginx 反向代理與 TLS 設定
├── certs/                     # TLS 憑證（需自行產生或掛入）
├── public/                    # 靜態前端檔案
├── routes/
│   └── convert.js             # /api/convert、/download/:filename、/api/zip 路由
├── middleware/
│   ├── security.js            # securityHeaders、rateLimiter、requireMultipart
│   └── upload.js              # Multer 設定（獨立模組）
├── utils/
│   ├── converter.js           # Worker Thread 封裝（convertImage）
│   └── logger.js              # 結構化日誌
└── workers/
    └── converter-worker.js    # Sharp 轉換邏輯（在 Worker Thread 內執行）
```

### 開發模式

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
# 支援熱重載（原始碼以 volume 掛載）
# Debug port: 9229（可用 Chrome DevTools 或 VS Code 遠端除錯）
```

或不使用 Docker，以 Node.js 內建 `--watch` 啟動：

```bash
npm run dev
# 等同於 node --watch server.js
```

### 執行測試

```bash
npm test
```

---

## 7. 部署注意事項

- **TURNSTILE_SECRET_KEY 必須設定**：生產環境未設定此變數時，bot 防護完全停用，並在 log 中輸出警告。請至 [Cloudflare Dashboard](https://dash.cloudflare.com/) 申請 Turnstile 金鑰後填入 `.env`。
- **Nginx upstream 位址**：`nginx.conf` 中 proxy_pass 指向 `http://127.0.0.1:3000`，但在 Docker Compose 網路中 app 服務以 `app:3000` 解析。若自行調整部署拓撲，需確認 upstream 位址正確。
- **檔案 TTL 為 15 分鐘**：轉換結果存於 `/tmp/image-converter`（Docker volume `image_converter_tmp`），超過 TTL 或下載後立即刪除，不會長期保留。
- **Redis 強烈建議使用**：未連接 Redis 時速率限制降級為記憶體 Map，重啟後計數歸零，且無法在多個 Node.js 實例之間共享狀態。
- **TLS 憑證**：生產環境請替換為 Let's Encrypt 或正式 CA 憑證，並更新 `nginx.conf` 中的憑證路徑（`ssl_certificate` / `ssl_certificate_key`）。
- **記憶體用量**：Multer 使用 memory storage，所有上傳的檔案在轉換期間都暫存於記憶體。批次 500 MB 上限在記憶體充裕的前提下才能安全運作，建議容器分配至少 1 GB RAM。

---

## 8. 常見問題

**Q：為什麼 AVIF 轉換比較慢？**

AVIF 基於 AV1 編碼器，壓縮演算法的計算複雜度遠高於 JPG 或 WebP。本服務的 AVIF 轉換使用 `effort: 4`（中等壓縮努力值），在壓縮率與速度之間取得平衡。若需要加快速度，可在 `workers/converter-worker.js` 中調低 `effort` 值（最低 0），但輸出檔案會稍大。

**Q：我沒有 Cloudflare 帳號可以用嗎？**

可以。Turnstile 驗證為**選用功能**。不設定 `TURNSTILE_SECRET_KEY` 時，服務會跳過 bot 驗證直接處理請求，適合內網或自用環境。若在公開網路上部署，建議申請免費的 Cloudflare 帳號並啟用 Turnstile，以防止濫用。

**Q：上傳的圖片會被保留嗎？**

不會。圖片上傳後以 memory storage 暫存於記憶體，轉換完成後寫入 `/tmp/image-converter` 並設定 15 分鐘 TTL。使用者下載後立即從磁碟刪除；若未下載，TTL 到期後也會自動清除。伺服器不會永久儲存任何使用者圖片，EXIF 資訊在輸出時也一併剝除。
