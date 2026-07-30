# 卓編數位書房 — 前端（GitHub Pages 靜態站）

## 目錄結構

```
frontend-project/
├── index.html    # 主頁面（四功能票卡選單 + 四個子頁面容器）
├── app.js        # 前端邏輯（頁面切換、System Prompt 組合、呼叫 Worker API）
├── logo.png      # Elvis IT 品牌 Logo
└── README.md     # 本檔案
```

無建置流程、無框架依賴，三個檔案（`index.html` / `app.js` / `logo.png`）放在同一層即可直接部署到 GitHub Pages 或任何靜態主機。V5 起，`index.html` 額外從兩個公開 CDN 載入兩支 `<script>`（`mammoth.js` 用於讀取 Word 檔、`docx` 用於匯出 Word 檔），詳見下方「V5 新增：Word 檔匯入匯出」。

## 串接後端

這份前端需要搭配另一個 Worker 專案（`worker-project/`，見該專案 README 的部署步驟）。

Worker 部署完成、拿到正式網址後，打開 `app.js`，修改最上方這一行：

```js
const WORKER_BASE_URL = "https://zhuo-editor-proxy.<your-subdomain>.workers.dev";
```

## 示範模式

`app.js` 會偵測 `WORKER_BASE_URL` 是否仍是預設佔位字串，若是，自動切換為示範模式：

- 介面與流程完全可操作
- 卓編的回覆為模擬文字（不會真的呼叫 API）
- 便條紙規則庫只存在瀏覽器記憶體（重新整理會重置為三筆示範資料）

方便在 Worker 尚未部署完成前，先確認介面與互動流程是否符合需求。

## 部署到 GitHub Pages

1. 建立一個 GitHub repository
2. 把 `index.html`、`app.js`、`logo.png` 上傳到 repo 根目錄（或 `/docs` 資料夾，視你的 Pages 設定）
3. repo → Settings → Pages → 選擇對應分支/資料夾 → Save
4. 幾分鐘後即可透過 `https://<你的帳號>.github.io/<repo名稱>/` 存取

## 四個功能頁面對應的程式區塊（app.js）

| 功能 | render 函式 | 送出處理函式 |
|---|---|---|
| 活動報導潤稿 | `renderReportPage` | `handleReportSubmit` |
| 人物專訪潤稿 | `renderInterviewPage` | `handleInterviewSubmit` |
| 活動 DM 撰寫 | `renderDmPage` | `handleDmSubmit` |
| 大神的便條紙 | `renderRulesPage` | `handleAddRule` / `handleToggleRule` / `handleDeleteRule` |

每個「送出處理函式」內都有組 `systemPrompt` 的邏輯，其中會呼叫 `buildRulesPromptFragment()` 動態取得目前啟用中的便條紙規則並安插進去——這是四個功能共用規則庫的關鍵函式，如果要調整卓編潤稿的邏輯或語氣，直接修改對應函式裡的 `systemPrompt` 字串即可。

實際呼叫 Worker（或示範模式假回覆）的統一入口是 `askZhuo()`（V2 版原名 `callAI()`，V3 更名以配合「卓編親自審稿」的語氣調整，行為未變）。

## V3 新增：圖示庫與動畫（app.js 開頭）

- `ICONS`：首頁四張卡片大圖示、內文小圖示（返回、送出、完成勾選、標題印記、新增）的原創 SVG 定義，皆為手繪水墨線條風格。要更換或新增圖示，直接編輯對應的 SVG 字串即可，不需要額外的圖示套件或字型。
- `NAV_ICONS`：頂部導覽選單用的小尺寸版本圖示。
- `INK_LOADER`：四個送出按鈕旁「墨滴暈染＋毛筆筆觸」載入動畫的 HTML 片段，動畫效果本身定義在 `index.html` 的 `<style>` 區塊（`.ink-brush` / `@keyframes ink-bloom` / `@keyframes brush-stroke`）。
- `injectStaticIcons()` / `updateNavActiveState()`：頁面載入與切換時，分別負責把圖示塞進 `data-icon` / `data-icon-inline` 容器、以及讓頂部選單反白對應項目，皆在 `DOMContentLoaded` 與 `showPage()` 內呼叫，不需手動觸發。

LOGO（`logo.png`）不在這套圖示庫內，維持原檔案不變。

## V5 新增：Word 檔匯入匯出

三項潤稿／文案功能（活動報導、人物專訪、活動 DM）都新增了「匯入 Word 檔」與「匯出 Word 檔」，全部在瀏覽器端運算，不會經過 Worker：

- **匯入**：使用 [mammoth.js](https://github.com/mwilliamson/mammoth.js)（`mammoth.extractRawText`）把使用者上傳的 `.docx` 轉成純文字，寫入對應的 textarea。對應函式：`handleWordImport(inputEl, textareaId, statusElId)`。
- **匯出**：使用 [docx](https://docx.js.org/)（`Packer.toBlob`）把潤稿結果組成 `.docx`，透過 blob URL 觸發瀏覽器下載。對應函式：`exportTextAsWord({ title, bodyText, filename })`；人物專訪頁面另有 `exportInterviewAsWord()` 包裝，會自動帶入目前選定的備選標題。
- 兩支函式都定義在 `app.js` 的「V5：Word 檔匯入 / 匯出」區塊，緊接在 `copyToClipboard` 之後。
- **外部依賴**：`index.html` 新增了兩個 `<script src>`（cdnjs 的 `mammoth.browser.min.js`、jsDelivr 的 `docx` UMD build）。這兩支腳本由**使用者的瀏覽器**直接向 CDN 下載，與 Worker 無關；如果使用者所在的網路環境有網域白名單限制，需要放行 `cdnjs.cloudflare.com` 與 `cdn.jsdelivr.net`，否則匯入／匯出按鈕會顯示「元件尚未載入完成」的錯誤訊息。
- 目前只支援 `.docx`；上傳其他格式（如舊版 `.doc`）會顯示提示訊息，請對方先用 Word 另存新檔為 `.docx` 再上傳。
- 潤稿結果中的「■ 小標題」記號，匯出時會自動轉換為 Word 文件內的粗體小標題（並移除 ■ 符號），其餘段落維持原樣。
