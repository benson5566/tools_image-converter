# 圖片格式轉換服務 技術規格書

**版本：** 1.0.0
**日期：** 2026-04-23
**狀態：** 已確認，可供開發使用

---

## 目錄

1. [專案概述](#1-專案概述)
2. [目標用戶與使用情境](#2-目標用戶與使用情境)
3. [支援格式](#3-支援格式)
4. [轉換規則](#4-轉換規則)
5. [輸出品質設定](#5-輸出品質設定)
6. [上傳限制](#6-上傳限制)
7. [API 規格](#7-api-規格)
8. [安全性規格](#8-安全性規格)
9. [技術棧](#9-技術棧)
10. [開發 Agent 分工表](#10-開發-agent-分工表)
11. [錯誤處理規格](#11-錯誤處理規格)

---

## 1. 專案概述

本服務為一個以瀏覽器為操作介面的圖片格式轉換 Web 服務，讓使用者能夠將常見圖片格式（WebP、AVIF、PNG、JPG）批次轉換為目標格式（PNG、JPG、WebP），無需安裝任何本地應用程式。

服務後端使用 Node.js 搭配 Sharp 函式庫進行高效能圖片處理，並提供標準化 REST API 供前端呼叫。

---

## 2. 目標用戶與使用情境

### 目標用戶

**設計師**（UI/UX 設計師、平面設計師、網頁設計師）

### 主要使用情境

| 情境 | 說明 |
|------|------|
| 格式相容性轉換 | 將 AVIF / WebP 轉為傳統格式（JPG、PNG）以供不相容的工具或平台使用 |
| 網頁輸出優化 | 將 PNG / JPG 轉為 WebP 以降低網頁載入量 |
| 批次處理 | 一次上傳多個設計稿，統一轉換為同一格式 |
| 透明背景處理 | 將帶有透明背景的素材轉為 JPG 時，指定填充背景色 |

### 不支援情境

- SVG 向量格式轉換（不在本服務範疇）
- 圖片尺寸縮放或裁切（本服務僅作格式轉換）
- 動態圖片的完整動畫保留（動態 WebP 僅保留第一幀）

---

## 3. 支援格式

### 輸入格式

| 格式 | MIME Type | 備註 |
|------|-----------|------|
| WebP | `image/webp` | 靜態與動態均接受，動態僅保留第一幀 |
| AVIF | `image/avif` | HDR 內容自動 tone mapping 至 sRGB |
| PNG | `image/png` | 支援透明通道（Alpha） |
| JPG / JPEG | `image/jpeg` | 不含透明通道 |

### 輸出格式

| 格式 | 備註 |
|------|------|
| PNG | 無損，保留透明通道 |
| JPG | 有損壓縮，不支援透明（需指定背景填色） |
| WebP | 自動判斷 Lossless / Lossy 模式（見第 4 節） |

### 格式不支援聲明

- **SVG** 不在輸入或輸出格式之列，任何 SVG 上傳均應被拒絕。

---

## 4. 轉換規則

### 4.1 動態 WebP 處理

- **行為：** 自動擷取動態 WebP 的第一幀進行轉換，忽略後續幀。
- **使用者通知：** 轉換結果需在 `warnings` 欄位附上 inline 警告訊息。

```
警告文字：此檔案為動態 WebP，僅保留第一幀
```

- **實作說明：** 使用 Sharp 讀取時指定 `page: 0` 以取得第一幀。

---

### 4.2 AVIF HDR 處理

- **行為：** 偵測到 AVIF 檔案含有 HDR 色域（如 BT.2020）時，自動進行 tone mapping，將色域轉換至 sRGB。
- **使用者通知：** 轉換結果需在 `warnings` 欄位附上提示訊息。

```
提示文字：顏色可能略有差異
```

- **實作說明：** Sharp 讀取 AVIF 時套用色彩空間轉換至 `srgb`。

---

### 4.3 JPG 輸出透明背景填色

當來源圖片含有透明通道（Alpha Channel），且輸出格式為 JPG 時：

- **行為：** 使用者**必須**指定背景填色，不得留白。
- **填色選項：**

| 選項 | 值 |
|------|-----|
| 白色（預設） | `#ffffff` |
| 黑色 | `#000000` |
| 自訂色 | 任意合法 hex 色碼，如 `#f5c842` |

- **API 欄位：** `bgColor`（hex 字串，如 `'#ffffff'`）
- **前端行為：** 當偵測到輸出格式為 JPG 且來源有透明度時，應顯示背景色選擇介面。
- **實作說明：** 使用 Sharp 的 `.flatten({ background: bgColor })` 在轉換前合成背景色。

---

### 4.4 WebP 輸出模式自動判斷

輸出格式為 WebP 時，後端自動依據來源圖片決定壓縮模式：

| 來源圖片條件 | WebP 輸出模式 |
|-------------|--------------|
| 含有透明通道（Alpha） | **Lossless（無損）** |
| 不含透明通道 | **Lossy（有損）** |

- **實作說明：**
  - 使用 Sharp 讀取圖片後，檢查 metadata 中的 `hasAlpha` 屬性。
  - Lossless 模式：`sharp().webp({ lossless: true })`
  - Lossy 模式：`sharp().webp({ lossless: false })`

---

## 5. 輸出品質設定

### JPG 品質滑桿

| 屬性 | 值 |
|------|----|
| 適用格式 | JPG 輸出時 |
| 可調範圍 | 60 – 100 |
| 預設值 | 85 |
| API 欄位 | `jpgQuality`（數字字串） |

- 當 `outputFormat` 不為 `'jpg'` 時，`jpgQuality` 欄位應被後端忽略。
- 前端應以滑桿（range input）呈現，並即時顯示當前數值。

---

## 6. 上傳限制

| 限制項目 | 上限 |
|----------|------|
| 單次批次檔案數量 | **50 個** |
| 單一檔案大小 | **50 MB** |
| 單次總上傳量 | **500 MB** |

- 超過任一限制時，應於上傳前（前端驗證）或請求處理時（後端驗證）立即回傳錯誤，不得嘗試處理。
- 前後端均須實作限制驗證，前端驗證為輔助體驗，後端驗證為強制安全措施。

---

## 7. API 規格

### 7.1 `POST /api/convert` — 圖片轉換

#### Request

| 屬性 | 值 |
|------|----|
| Method | `POST` |
| Path | `/api/convert` |
| Content-Type | `multipart/form-data` |

#### Request 欄位

| 欄位名稱 | 類型 | 必填 | 說明 |
|----------|------|------|------|
| `files[]` | File（多個） | 是 | 上傳的圖片檔案，最多 50 個，每個最大 50 MB |
| `outputFormat` | string | 是 | 輸出格式：`'png'` \| `'jpg'` \| `'webp'` |
| `jpgQuality` | string（數字） | 否 | JPG 品質 60–100，預設 `'85'`；僅 `outputFormat=jpg` 時有效 |
| `bgColor` | string（hex） | 否 | 背景填色，格式如 `'#ffffff'`；僅 `outputFormat=jpg` 且來源含透明通道時使用 |

#### Response（成功）

**HTTP Status：** `200 OK`
**Content-Type：** `application/json`

```json
{
  "results": [
    {
      "originalName": "image.webp",
      "outputName": "image.png",
      "downloadUrl": "/download/uuid-image.png",
      "warnings": ["此檔案為動態 WebP，僅保留第一幀"],
      "success": true
    }
  ]
}
```

#### Response 欄位說明

| 欄位 | 類型 | 說明 |
|------|------|------|
| `results` | Array | 每個上傳檔案對應一筆結果 |
| `results[].originalName` | string | 原始上傳檔名 |
| `results[].outputName` | string | 轉換後檔名 |
| `results[].downloadUrl` | string | 下載路徑，格式為 `/download/<uuid>-<filename>` |
| `results[].warnings` | string[] | 警告或提示訊息陣列（無警告時為空陣列 `[]`） |
| `results[].success` | boolean | 該檔案是否轉換成功 |

#### Response（失敗）

**HTTP Status：** `400` / `413` / `422` / `500`（依錯誤類型）
**Content-Type：** `application/json`

```json
{
  "error": "錯誤訊息"
}
```

---

### 7.2 `GET /download/:filename` — 下載轉換檔案

#### Request

| 屬性 | 值 |
|------|----|
| Method | `GET` |
| Path | `/download/:filename` |
| 參數 | `filename`：由 `/api/convert` 回應中的 `downloadUrl` 取得 |

#### Response（成功）

**HTTP Status：** `200 OK`
**Content-Type：** 對應圖片 MIME Type（如 `image/png`）
**Body：** 二進位圖片檔案內容（附 `Content-Disposition: attachment` 標頭）

#### Response（失敗）

| 狀況 | HTTP Status |
|------|-------------|
| 檔案不存在 | `404 Not Found` |
| 路徑穿越攻擊 | `403 Forbidden` |

---

### 7.3 `GET /` — 前端頁面

| 屬性 | 值 |
|------|-----|
| Method | `GET` |
| Path | `/` |
| Response | `200 OK`，回傳 `index.html` |

---

## 8. 安全性規格

### 8.1 Magic Bytes 驗證

- 所有上傳檔案**必須**驗證檔案開頭的 Magic Bytes（File Signature），確認實際格式與宣稱格式一致。
- 禁止僅依賴副檔名或 MIME Type（可被偽造）判斷格式。

| 格式 | Magic Bytes（十六進位） |
|------|------------------------|
| PNG | `89 50 4E 47 0D 0A 1A 0A` |
| JPG | `FF D8 FF` |
| WebP | `52 49 46 46 xx xx xx xx 57 45 42 50`（RIFF....WEBP） |
| AVIF | `00 00 00 xx 66 74 79 70`（ftyp box） |

### 8.2 圖片尺寸限制

- 解碼後的圖片尺寸**不得超過** `8000 × 8000 px`。
- 超過尺寸限制的圖片應拒絕處理，回傳 `422 Unprocessable Entity`。
- 防止攻擊者上傳小檔案但解碼後佔用大量記憶體（Decompression Bomb 攻擊）。

### 8.3 解壓後記憶體上限

- 單一圖片解壓後佔用記憶體**不得超過 50 MB**。
- 若解壓後記憶體估算超過上限，應中止處理並回傳錯誤。
- 估算方式：`寬 × 高 × 通道數（4） × 位元深度（bytes）`

### 8.4 路徑安全

- `/download/:filename` 路由必須驗證 `filename` 不含路徑穿越字元（如 `../`、`%2e%2e`）。
- 所有下載路徑應限定於預設暫存目錄內。

### 8.5 檔案命名安全

- 上傳後的暫存檔案及輸出檔案應以 UUID 前綴命名，避免原始檔名被直接用於檔案系統操作。
- 原始檔名僅用於回應中的 `originalName` 欄位顯示。

### 8.6 上傳限制強制執行

- 後端**必須強制**執行第 6 節所列的所有上傳限制，不可僅依賴前端驗證。

---

## 9. 技術棧

| 層級 | 技術 |
|------|------|
| 執行環境 | Node.js |
| 圖片處理 | [Sharp](https://sharp.pixelplumbing.com/) |
| Web 框架 | （待後端 Agent 確認，建議 Express.js） |
| 前端 | 靜態 HTML / CSS / JavaScript（`public/index.html`） |
| 檔案上傳解析 | Multer（搭配 Express） |
| 暫存目錄 | 本機暫存資料夾（服務重啟後清除） |

---

## 10. 開發 Agent 分工表

### 規格書 Agent

**職責：**
- 根據已確認規格撰寫並維護本技術規格書（`SPEC.md`）
- 解答各 Agent 對規格的疑問
- 追蹤規格變更並更新文件版本

**交付物：**
- `SPEC.md`（本文件）

---

### 後端 Agent

**職責：**
- 實作 `POST /api/convert` 路由及核心轉換邏輯
- 整合 Sharp 函式庫處理各種格式轉換
- 實作動態 WebP 第一幀擷取
- 實作 AVIF HDR tone mapping
- 實作 JPG 輸出背景色填充
- 實作 WebP 輸出模式自動判斷（Lossless / Lossy）
- 實作 `GET /download/:filename` 路由
- 實作後端上傳限制（檔案數量、單檔大小、總上傳量）
- 呼叫安全中介層完成安全驗證
- 錯誤處理與標準化錯誤回應

**交付物：**
- `routes/convert.js`（或對應路由檔案）
- `routes/download.js`
- `utils/imageProcessor.js`（或對應工具模組）

---

### 前端 Agent

**職責：**
- 實作檔案拖曳上傳介面（支援多選，最多 50 個）
- 實作輸出格式選擇（PNG / JPG / WebP）
- 實作 JPG 品質滑桿（60–100，預設 85）
- 實作 JPG 背景色選擇介面（白色 / 黑色 / 自訂色），在輸出格式為 JPG 時顯示
- 實作前端上傳限制驗證（檔案數量、單檔大小、總上傳量）
- 呼叫 `POST /api/convert` API 並處理回應
- 顯示轉換結果列表，包含警告訊息
- 提供每個結果的下載連結（指向 `downloadUrl`）
- 實作批次下載功能（可選）
- 顯示上傳與轉換進度指示

**交付物：**
- `public/index.html`
- `public/style.css`（或內嵌樣式）
- `public/app.js`（或內嵌腳本）

---

### 安全中介層 Agent

**職責：**
- 實作 Magic Bytes 驗證中介層
- 實作圖片尺寸上限（8000×8000px）檢查
- 實作解壓後記憶體估算與上限（50MB）檢查
- 實作下載路由的路徑穿越攻擊防護
- 實作檔案命名安全（UUID 前綴）
- 將安全驗證函式以模組形式提供給後端 Agent 呼叫

**交付物：**
- `middleware/security.js`（Magic Bytes 驗證、尺寸檢查、記憶體估算）
- `utils/pathSafe.js`（路徑安全驗證工具）

---

## 11. 錯誤處理規格

### 11.1 錯誤回應格式

所有錯誤一律以 JSON 格式回傳：

```json
{
  "error": "具體錯誤說明文字"
}
```

### 11.2 HTTP 狀態碼對照表

| HTTP Status | 情境 |
|-------------|------|
| `400 Bad Request` | 缺少必要欄位、`outputFormat` 值不合法、`jpgQuality` 超出範圍 |
| `403 Forbidden` | 路徑穿越攻擊偵測 |
| `404 Not Found` | 下載路徑不存在（檔案已過期或不存在） |
| `413 Payload Too Large` | 單檔超過 50MB 或總上傳量超過 500MB |
| `415 Unsupported Media Type` | 上傳格式不在支援清單內（含 Magic Bytes 驗證失敗） |
| `422 Unprocessable Entity` | 圖片尺寸超過 8000×8000px 或解壓後記憶體超過 50MB |
| `429 Too Many Files` | 單次上傳檔案數量超過 50 個 |
| `500 Internal Server Error` | 伺服器內部錯誤（Sharp 處理失敗等非預期錯誤） |

### 11.3 部分成功處理

- 批次轉換時，若部分檔案失敗，其他檔案的轉換結果仍應正常回傳。
- 失敗的檔案在 `results` 陣列中以 `"success": false` 標示，並附上錯誤說明。

```json
{
  "results": [
    {
      "originalName": "valid.png",
      "outputName": "valid.jpg",
      "downloadUrl": "/download/uuid-valid.jpg",
      "warnings": [],
      "success": true
    },
    {
      "originalName": "corrupt.avif",
      "outputName": null,
      "downloadUrl": null,
      "warnings": [],
      "success": false,
      "error": "檔案損毀，無法解碼"
    }
  ]
}
```

### 11.4 前端錯誤顯示規則

| 錯誤類型 | 顯示方式 |
|----------|----------|
| 上傳前驗證失敗（檔案數量、大小） | 於上傳介面頂部顯示紅色提示，阻止上傳 |
| 個別檔案轉換失敗（`success: false`） | 於該檔案結果列表項目顯示錯誤訊息 |
| API 整體失敗（`error` 欄位） | 全域錯誤提示區塊 |
| 警告（`warnings` 陣列） | 黃色 inline 提示，附於對應檔案結果下方 |

---

*本規格書由規格書 Agent 依據 2026-04-23 已確認之專案規格撰寫，如有規格變更請更新本文件版本號與日期。*
