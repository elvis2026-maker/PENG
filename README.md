# 卓編數位書房 — 前端（GitHub Pages 靜態站）

## 目錄結構

```
frontend-project/
├── index.html    # 主頁面（四功能票卡選單 + 四個子頁面容器）
├── app.js        # 前端邏輯（頁面切換、System Prompt 組合、呼叫 Worker API）
├── logo.png      # Elvis IT 品牌 Logo
└── README.md     # 本檔案
```

無建置流程、無框架依賴，三個檔案（`index.html` / `app.js` / `logo.png`）放在同一層即可直接部署到 GitHub Pages 或任何靜態主機。

## 串接後端

這份前端需要搭配另一個 Worker 專案（`worker-project/`，見該專案 README 的部署步驟）。

Worker 部署完成、拿到正式網址後，打開 `app.js`，修改最上方這一行：

```js
const WORKER_BASE_URL = "https://zhuo-editor-proxy.<your-subdomain>.workers.dev";
```

## 示範模式

`app.js` 會偵測 `WORKER_BASE_URL` 是否仍是預設佔位字串，若是，自動切換為示範模式：

- 介面與流程完全可操作
- AI 回覆為模擬文字（不會真的呼叫 API）
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

每個「送出處理函式」內都有組 `systemPrompt` 的邏輯，其中會呼叫 `buildRulesPromptFragment()` 動態取得目前啟用中的便條紙規則並安插進去——這是四個功能共用規則庫的關鍵函式，如果要調整 AI 的潤稿邏輯或語氣，直接修改對應函式裡的 `systemPrompt` 字串即可。
