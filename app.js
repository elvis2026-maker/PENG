/**
 * 卓編數位書房 V3 - 前端邏輯
 * ------------------------------------------------
 * 請先依照 SETUP.md 完成 Cloudflare Worker 部署，
 * 並把下方 WORKER_BASE_URL 換成你自己的 Worker 網址。
 * ------------------------------------------------
 */

// ⚠️ 請將此網址換成你部署好的 Cloudflare Worker 網址（見 SETUP.md）
const WORKER_BASE_URL = "https://elvis-peng.elvis-liu2027.workers.dev";

// 若尚未設定 Worker 網址，系統會使用「示範模式」，以假資料展示完整流程，
// 方便你在正式串接前先體驗完整互動流程。
const DEMO_MODE = WORKER_BASE_URL.includes("YOUR-SUBDOMAIN");

// 全域狀態
let rulesCache = [];
let currentInterviewTitles = [];

// ================= V7：草稿自動保存（localStorage） =================
// 目的：避免手機使用者寫到一半被通知／切換 App 打斷，或不小心重新整理頁面而遺失輸入內容。
// 僅保存「輸入欄位」（初稿、活動資訊等），不保存卓編潤稿後的結果（結果可重新產生，欄位內容才是心血）。
const DRAFT_STORAGE_PREFIX = "zhuo_draft_";
const DRAFT_FIELDS = {
    report: ["report-draft", "report-length", "report-tone", "report-intensity"],
    interview: ["interview-draft", "interview-length", "interview-focus", "interview-intensity"],
    dm: ["dm-name", "dm-datetime", "dm-purpose", "dm-notes"],
};

let draftSaveTimer = null;

// 把某個功能頁目前欄位內容存進 localStorage（debounce 800ms，避免每個按鍵都寫入）
function scheduleDraftSave(pageKey) {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => saveDraftNow(pageKey), 800);
}

function saveDraftNow(pageKey) {
    const fields = DRAFT_FIELDS[pageKey];
    if (!fields) return;
    const data = {};
    let hasContent = false;
    fields.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        data[id] = el.value;
        if (el.value && el.value.trim()) hasContent = true;
    });

    try {
        if (hasContent) {
            data.savedAt = new Date().toISOString();
            localStorage.setItem(DRAFT_STORAGE_PREFIX + pageKey, JSON.stringify(data));
        } else {
            // 欄位都清空了（例如送出後手動清空），順便清掉暫存，避免下次又跳出「還原」提示
            localStorage.removeItem(DRAFT_STORAGE_PREFIX + pageKey);
        }
    } catch (err) {
        // 少數情況（無痕模式、儲存空間已滿）localStorage 會丟例外，草稿保存失敗不影響主要功能，靜默略過即可
    }
}

// 頁面剛渲染完時呼叫：若偵測到暫存草稿，顯示一條「是否還原上次未送出的內容」提示條
function checkDraftAndPrompt(pageKey, bannerContainerId) {
    let saved;
    try {
        const raw = localStorage.getItem(DRAFT_STORAGE_PREFIX + pageKey);
        if (!raw) return;
        saved = JSON.parse(raw);
    } catch (err) {
        return;
    }

    const bannerEl = document.getElementById(bannerContainerId);
    if (!bannerEl) return;

    const savedTime = saved.savedAt ? new Date(saved.savedAt) : null;
    const timeText = savedTime
        ? `${savedTime.getMonth() + 1}/${savedTime.getDate()} ${String(savedTime.getHours()).padStart(2, "0")}:${String(savedTime.getMinutes()).padStart(2, "0")}`
        : "先前";

    bannerEl.innerHTML = `
        <span>偵測到 ${timeText} 未送出的草稿，是否要還原？</span>
        <div class="draft-banner-actions">
            <button class="btn btn-secondary" style="padding:6px 14px;font-size:13px;" onclick="restoreDraft('${pageKey}', '${bannerContainerId}')">還原草稿</button>
            <button class="btn btn-danger-outline" onclick="dismissDraft('${pageKey}', '${bannerContainerId}')">不用了，清除</button>
        </div>
    `;
    bannerEl.classList.add("show");
}

function restoreDraft(pageKey, bannerContainerId) {
    let saved;
    try {
        const raw = localStorage.getItem(DRAFT_STORAGE_PREFIX + pageKey);
        if (!raw) return;
        saved = JSON.parse(raw);
    } catch (err) {
        return;
    }

    const fields = DRAFT_FIELDS[pageKey] || [];
    fields.forEach((id) => {
        const el = document.getElementById(id);
        if (el && saved[id] !== undefined) el.value = saved[id];
    });

    const bannerEl = document.getElementById(bannerContainerId);
    if (bannerEl) bannerEl.classList.remove("show");
}

function dismissDraft(pageKey, bannerContainerId) {
    localStorage.removeItem(DRAFT_STORAGE_PREFIX + pageKey);
    const bannerEl = document.getElementById(bannerContainerId);
    if (bannerEl) bannerEl.classList.remove("show");
}

// 幫某個功能頁的所有草稿欄位掛上自動保存監聽（input 事件即觸發，debounce 後才真正寫入）
function bindDraftAutosave(pageKey) {
    const fields = DRAFT_FIELDS[pageKey];
    if (!fields) return;
    fields.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener("input", () => scheduleDraftSave(pageKey));
        el.addEventListener("change", () => scheduleDraftSave(pageKey));
    });
}

// ================= V7：潤稿前後併排比對（簡易 word-level diff） =================
// 目的：讓使用者能直觀看到「卓編改了哪些字」，不用自己逐字對照，也有助於判斷潤稿品質、
// 決定要不要把某個修改習慣手動加進便條紙規則庫。
// 演算法：以「字」為最小單位（中文沒有天然分詞空格，直接拆字比逐詞斷詞更穩定、不需額外套件），
// 使用標準 LCS（最長共同子序列）動態規劃求出新舊文本的對齊方式，
// 只有在較短文本落在允許範圍內才執行（見 DIFF_MAX_LENGTH），避免長文章導致瀏覽器計算卡頓。
const DIFF_MAX_LENGTH = 6000; // 單邊文本超過這個字數就不提供 diff（避免 O(n*m) 記憶體爆掉），改顯示提示訊息

function computeCharDiff(oldText, newText) {
    const oldChars = Array.from(oldText);
    const newChars = Array.from(newText);
    const m = oldChars.length;
    const n = newChars.length;

    // dp[i][j] = oldChars 前 i 字與 newChars 前 j 字的最長共同子序列長度
    const dp = new Array(m + 1);
    for (let i = 0; i <= m; i++) dp[i] = new Uint32Array(n + 1);

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldChars[i - 1] === newChars[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    // 回溯 dp 表，組出「刪除／新增／不變」的片段序列
    const ops = [];
    let i = m, j = n;
    while (i > 0 && j > 0) {
        if (oldChars[i - 1] === newChars[j - 1]) {
            ops.push({ type: "same", ch: oldChars[i - 1] });
            i--; j--;
        } else if (dp[i - 1][j] >= dp[i][j - 1]) {
            ops.push({ type: "del", ch: oldChars[i - 1] });
            i--;
        } else {
            ops.push({ type: "add", ch: newChars[j - 1] });
            j--;
        }
    }
    while (i > 0) { ops.push({ type: "del", ch: oldChars[i - 1] }); i--; }
    while (j > 0) { ops.push({ type: "add", ch: newChars[j - 1] }); j--; }

    ops.reverse();

    // 把逐字的 ops 合併成連續片段（同類型相鄰字合成一段），渲染時才不會產生大量細碎的 <span>
    const segments = [];
    ops.forEach((op) => {
        const last = segments[segments.length - 1];
        if (last && last.type === op.type) {
            last.text += op.ch;
        } else {
            segments.push({ type: op.type, text: op.ch });
        }
    });
    return segments;
}

// 把 diff 片段渲染成 HTML：新增（底線＋綠色底）、刪除（刪除線＋紅色底）、不變（原樣）
function renderDiffHtml(segments) {
    return segments
        .map((seg) => {
            const escaped = escapeHtml(seg.text);
            if (seg.type === "add") return `<span class="diff-add">${escaped}</span>`;
            if (seg.type === "del") return `<span class="diff-del">${escaped}</span>`;
            return escaped;
        })
        .join("");
}

// 記錄每個功能頁目前是否為 diff 檢視模式：{ [pageKey]: boolean }
const DIFF_VIEW_STATE = {};

// 每次重新送出潤稿請求時呼叫，重置該頁的 diff 顯示狀態與按鈕文字，避免舊的 diff 內容與新結果不同步
function resetDiffView(pageKey, toggleBtnId, diffBoxId) {
    DIFF_VIEW_STATE[pageKey] = false;
    const diffBox = document.getElementById(diffBoxId);
    const toggleBtn = document.getElementById(toggleBtnId);
    if (diffBox) diffBox.classList.remove("show");
    if (toggleBtn) toggleBtn.textContent = "顯示修改處對照";
    const resultBox = document.getElementById(pageKey === "report" ? "report-result-box" : "interview-result-box");
    if (resultBox) resultBox.classList.remove("hide");
}

function toggleDiffView(pageKey, originalText, resultText, resultBoxId, diffBoxId, toggleBtnId) {
    const showingDiff = !DIFF_VIEW_STATE[pageKey];
    DIFF_VIEW_STATE[pageKey] = showingDiff;

    const resultBox = document.getElementById(resultBoxId);
    const diffBox = document.getElementById(diffBoxId);
    const toggleBtn = document.getElementById(toggleBtnId);
    if (!resultBox || !diffBox) return;

    if (!showingDiff) {
        diffBox.classList.remove("show");
        resultBox.classList.remove("hide");
        if (toggleBtn) toggleBtn.textContent = "顯示修改處對照";
        return;
    }

    if (!originalText || !originalText.trim()) {
        diffBox.innerHTML = `<div class="empty-state">找不到原始初稿內容，無法比對（可能欄位已被清空）。</div>`;
    } else if (Array.from(originalText).length > DIFF_MAX_LENGTH || Array.from(resultText).length > DIFF_MAX_LENGTH) {
        diffBox.innerHTML = `<div class="empty-state">文章篇幅較長，為避免瀏覽器計算卡頓，暫不提供逐字對照，請直接閱讀上方潤稿結果。</div>`;
    } else {
        const segments = computeCharDiff(originalText, resultText);
        diffBox.innerHTML = `
            <div class="diff-legend">
                <span><span class="diff-add">綠底底線</span>＝新增／修改後的內容</span>
                <span><span class="diff-del">紅底刪除線</span>＝被移除的原文</span>
            </div>
            <div class="diff-content">${renderDiffHtml(segments)}</div>
        `;
    }

    diffBox.classList.add("show");
    resultBox.classList.add("hide");
    if (toggleBtn) toggleBtn.textContent = "隱藏修改處，只看結果";
}

// ================= 自繪圖示庫（手繪水墨線條風格，取代通用素材圖示） =================
// 所有選單／功能圖示皆為原創 SVG 線條繪製，呼應法鼓禪風的溫潤筆觸；
// LOGO 仍固定使用 logo.png，不在此列。
const ICONS = {
    // 活動報導：一張攤開的稿紙，右上角一筆勾勒的墨線，象徵潤飾筆觸
    report: `<svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M9 6.5H23.5L28 11V29.5H9V6.5Z" stroke="white" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M23 6.5V11H28" stroke="white" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M13 16.5H23" stroke="white" stroke-width="1.6" stroke-linecap="round"/>
        <path d="M13 20.5H23" stroke="white" stroke-width="1.6" stroke-linecap="round"/>
        <path d="M13 24.5H19" stroke="white" stroke-width="1.6" stroke-linecap="round"/>
        <path d="M25.5 15.5C26.5 14 27.8 14.6 27.4 16C27 17.4 24.6 19.4 23.5 20" stroke="white" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`,

    // 人物專訪：兩個相對而談的圓潤剪影，中間一朵簡化蓮花花瓣象徵禪意主標
    interview: `<svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="13" r="4" stroke="white" stroke-width="1.8"/>
        <path d="M6 27C6 22 8.5 19.5 12 19.5C15.5 19.5 18 22 18 27" stroke="white" stroke-width="1.8" stroke-linecap="round"/>
        <path d="M24 8C25.2 9.4 25.2 11 24 12.4" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
        <path d="M27 6C29 8 29 12.4 27 14.6" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
        <path d="M20.5 27C20.5 22.6 22.6 20 26 20C29.4 20 31.5 22.6 31.5 27" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="1.5 3"/>
        <circle cx="26" cy="15" r="3.2" stroke="white" stroke-width="1.6"/>
    </svg>`,

    // 活動 DM：一支揚起的宣傳旗幟／喇叭花瓣，三道弧線表示訊息擴散
    dm: `<svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M8 13L23 8V22.5L8 19V13Z" stroke="white" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M8 13H5.5V19H8" stroke="white" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M10.5 19.5L12 27" stroke="white" stroke-width="1.8" stroke-linecap="round"/>
        <path d="M26 12.5C28 14 28 16.5 26 18" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
        <path d="M29 9.5C32.5 12.5 32.5 18 29 21" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`,

    // 便條紙：一枚繫著細繩的木牌／便箋，加上一小截墨筆，呼應「大神的便條紙」
    rules: `<svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M11 9.5C11 8.4 11.9 7.5 13 7.5H23C24.1 7.5 25 8.4 25 9.5V27.5C25 28.3 24.1 28.8 23.4 28.3L18 24.5L12.6 28.3C11.9 28.8 11 28.3 11 27.5V9.5Z" stroke="white" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M14.5 13H21.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
        <path d="M14.5 16.5H21.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
        <path d="M14.5 20H18.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`,

    // 返回：回鋒筆觸的弧形箭頭
    back: `<svg class="icon-inline" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M14.5 6.5C10.5 8 7.5 10 7 12C7.5 14 10.5 16 14.5 17.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M10.5 8.2L7 12L10.5 15.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,

    // 呈上（送出）：毛筆筆尖，取代「auto_awesome」的通用星芒圖示
    submit: `<svg class="icon-inline icon-14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M18.5 4.5C15 6.5 9.5 12 7 17.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        <path d="M5.5 19.5C6 18 6.8 17 8 16.5C8.6 17.3 8.6 18.3 8 19C7.2 19.8 6.2 19.8 5.5 19.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
        <path d="M15.5 3.5C16.5 3 17.7 3.2 18.5 4.2C19 5 18.8 6.2 18 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`,

    // 完成勾選：圓潤的印章式勾勒
    done: `<svg class="icon-inline" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.6"/>
        <path d="M8.2 12.3L10.6 14.7L15.6 9.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,

    // 標題／印記：一枚簡化印章造型，取代 workspace_premium
    seal: `<svg class="icon-inline" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="5.5" y="5.5" width="13" height="13" rx="2.5" stroke="currentColor" stroke-width="1.6"/>
        <path d="M9 12L11 14.5L15.5 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,

    // 新增：一支簡潔的加號筆畫
    add: `<svg class="icon-inline icon-14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 5.5V18.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M5.5 12H18.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>`,

    // 首頁選單：簡化的合十屋簷造型
    home: `<svg class="icon-inline icon-14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M4.5 11.5L12 5L19.5 11.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M6.5 10V18.5H17.5V10" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
        <path d="M10 18.5V14H14V18.5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>`,

    // 匯入：一張紙頁與向上的墨線箭頭，象徵把外部稿件請進來
    importDoc: `<svg class="icon-inline icon-14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M6.5 3.5H14.5L18 7V20.5H6.5V3.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
        <path d="M14 3.5V7H18" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
        <path d="M12 17V10.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
        <path d="M9 13L12 10L15 13" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,

    // 匯出：一張紙頁與向下的墨線箭頭，象徵把定稿交付出去
    exportDoc: `<svg class="icon-inline icon-14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M6.5 3.5H14.5L18 7V20.5H6.5V3.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
        <path d="M14 3.5V7H18" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
        <path d="M12 10.5V17" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
        <path d="M9 14L12 17L15 14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
};

// 選單／內文用的小尺寸圖示（沿用同一套線條，line-only 版本）
const NAV_ICONS = {
    home: ICONS.home,
    report: `<svg class="icon-inline icon-14" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 6.5H23.5L28 11V29.5H9V6.5Z" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M23 6.5V11H28" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M13 20.5H23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    interview: `<svg class="icon-inline icon-14" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="13" cy="13" r="4.5" stroke="currentColor" stroke-width="2.2"/><path d="M6 27C6 21.8 9 19 13 19C17 19 20 21.8 20 27" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
    dm: `<svg class="icon-inline icon-14" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 13L28 6V26L8 19V13Z" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M8 13H5V19H8" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>`,
    rules: `<svg class="icon-inline icon-14" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11 9.5C11 8.4 11.9 7.5 13 7.5H23C24.1 7.5 25 8.4 25 9.5V27.5C25 28.3 24.1 28.8 23.4 28.3L18 24.5L12.6 28.3C11.9 28.8 11 28.3 11 27.5V9.5Z" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>`,
};

// 審稿中動畫（毛筆墨韻）：三圈暈染墨紋 + 一筆緩緩畫出的筆觸
const INK_LOADER = `
    <div class="ink-brush">
        <svg viewBox="0 0 40 40">
            <circle class="ink-ring" cx="20" cy="24" r="3"></circle>
            <circle class="ink-ring" cx="20" cy="24" r="3"></circle>
            <circle class="ink-ring" cx="20" cy="24" r="3"></circle>
            <path class="brush-tip" d="M9 14C13 10 18 8 25 9" />
        </svg>
    </div>`;

// 將圖示注入首頁卡片與頂部選單（在 DOM 就緒後執行一次）
function injectStaticIcons() {
    document.querySelectorAll("[data-icon]").forEach((el) => {
        const key = el.getAttribute("data-icon");
        if (ICONS[key]) el.innerHTML = ICONS[key];
    });
    document.querySelectorAll("[data-icon-inline]").forEach((el) => {
        const key = el.getAttribute("data-icon-inline");
        if (NAV_ICONS[key]) el.innerHTML = NAV_ICONS[key];
    });
}

// 依目前頁面，將頂部選單對應項目標記為 active（純視覺呼應，四卡片流程不變）
function updateNavActiveState(pageId) {
    document.querySelectorAll(".nav-link").forEach((el) => {
        el.classList.toggle("active", el.getAttribute("data-nav") === pageId);
    });
}

// ================= 頁面切換 =================
function showPage(pageId) {
    document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
    const target = document.getElementById(`page-${pageId}`);
    target.classList.add("active");

    if (pageId === "report" && !target.dataset.rendered) {
        renderReportPage(target);
    } else if (pageId === "interview" && !target.dataset.rendered) {
        renderInterviewPage(target);
    } else if (pageId === "dm" && !target.dataset.rendered) {
        renderDmPage(target);
    } else if (pageId === "rules" && !target.dataset.rendered) {
        renderRulesPage(target);
    }

    if (pageId === "rules") {
        loadRules(); // 每次進入便條紙頁都重新拉取最新規則
    }

    updateNavActiveState(pageId);
    window.scrollTo({ top: 0, behavior: "smooth" });
}

// ================= 便條紙規則庫：載入 / 組成 Prompt 片段 =================
async function loadRules() {
    if (DEMO_MODE) {
        if (rulesCache.length === 0) {
            rulesCache = [
                {
                    id: "demo-1",
                    content: "禁用「粉絲」，一律改用「信眾」或「菩薩」",
                    category: "詞彙提醒",
                    is_active: true,
                    created_at: "2026-07-01T00:00:00.000Z",
                },
                {
                    id: "demo-2",
                    content: "本期電子報主軸為「四安」（安心、安身、安家、安業），內文請適度帶入",
                    category: "當期主題",
                    is_active: true,
                    created_at: "2026-07-05T00:00:00.000Z",
                },
                {
                    id: "demo-3",
                    content: "標題避免驚嘆號與過度誇張的行銷語氣，維持法鼓禪風的溫潤莊重",
                    category: "排版規定",
                    is_active: true,
                    created_at: "2026-07-08T00:00:00.000Z",
                },
            ];
        }
        renderRulesList();
        return;
    }

    try {
        const resp = await fetch(`${WORKER_BASE_URL}/api/rules`);
        if (!resp.ok) throw new Error("讀取失敗");
        const data = await resp.json();
        rulesCache = data.rules || [];
        setConnectionStatus(true);
    } catch (err) {
        setConnectionStatus(false);
    }
    renderRulesList();
}

// V07：燈號不再直接顯示文字，改用 title（滑鼠 hover）+ tooltip（點擊查看，給手機用）
// el 本身只留一顆圓點，文字說明搬到 title 屬性和內部的 .status-tooltip
function setConnectionStatus(online) {
    const el = document.getElementById("connectionStatus");
    const tooltip = document.getElementById("connectionStatusTooltip");
    const text = online ? "知識庫已連線" : "知識庫連線異常";
    el.title = text;
    if (tooltip) tooltip.textContent = text;
    el.classList.remove("demo");
    if (online) {
        el.classList.remove("offline");
    } else {
        el.classList.add("offline");
    }
}

// 手機沒有 hover，點一下燈號彈出文字泡泡，2 秒後自動收起
let statusTooltipTimer = null;
function toggleStatusTooltip() {
    const tooltip = document.getElementById("connectionStatusTooltip");
    if (!tooltip) return;
    tooltip.classList.add("show");
    clearTimeout(statusTooltipTimer);
    statusTooltipTimer = setTimeout(() => {
        tooltip.classList.remove("show");
    }, 2000);
}

// 把目前啟用中的規則組成一段文字，安插進送給卓編的 System Prompt
function buildRulesPromptFragment() {
    const active = rulesCache.filter((r) => r.is_active);
    if (active.length === 0) return "（目前無特別注意事項）";

    const byCategory = {};
    active.forEach((r) => {
        if (!byCategory[r.category]) byCategory[r.category] = [];
        byCategory[r.category].push(r.content);
    });

    let text = "";
    for (const [category, items] of Object.entries(byCategory)) {
        text += `【${category}】\n`;
        items.forEach((item) => {
            text += `- ${item}\n`;
        });
    }
    return text.trim();
}

// ================= 呼叫 Worker（卓編審稿）統一入口 =================
async function askZhuo({ systemPrompt, userPrompt, temperature = 0.7 }) {
    if (DEMO_MODE) {
        await sleep(1200);
        return demoZhuoResponse(userPrompt);
    }

    const resp = await fetch(`${WORKER_BASE_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systemPrompt, userPrompt, temperature }),
    });

    const data = await resp.json();
    if (!resp.ok) {
        throw new Error(data.error || "卓編這邊發生未知的問題，請稍後再試");
    }
    return data.text;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// 示範模式：假回覆（尚未設定 Worker 網址時，用來體驗完整互動流程）
function demoZhuoResponse(userPrompt) {
    return `【示範模式輸出】

目前尚未串接真實的 Cloudflare Worker 網址，這是模擬的卓編潤稿結果，方便您預覽介面互動流程。

實際串接後，這裡會顯示卓編根據您輸入的初稿，依照法鼓禪風、動態套用「大神的便條紙」規則所產出的正式潤稿內容。

請參考 SETUP.md 完成 Worker 部署，並將 app.js 最上方的 WORKER_BASE_URL 換成您實際的網址，即可切換為正式運作模式。`;
}

function copyToClipboard(text, btnEl) {
    navigator.clipboard.writeText(text).then(() => {
        const original = btnEl.textContent;
        btnEl.textContent = "已複製 ✓";
        setTimeout(() => {
            btnEl.textContent = original;
        }, 1500);
    });
}

// ================= V5：Word 檔匯入 / 匯出（純前端，不經過 Worker） =================
//
// 匯入：使用 mammoth.js 在瀏覽器端讀取 .docx，抽出純文字貼入初稿欄位。
// 匯出：使用 docx.js 在瀏覽器端把潤稿結果組成 .docx，供使用者下載存檔。
// 兩者都是純前端運算，不會把檔案內容傳到 Worker 或任何伺服器。

// 讀取使用者選取的 .docx 檔案，把純文字塞進指定的 textarea，並顯示匯入狀態
async function handleWordImport(inputEl, textareaId, statusElId) {
    const statusEl = document.getElementById(statusElId);
    const file = inputEl.files && inputEl.files[0];
    if (!file) return;

    if (statusEl) {
        statusEl.textContent = "正在讀取檔案……";
        statusEl.className = "import-status";
    }

    const isDocx = /\.docx$/i.test(file.name);
    if (!isDocx) {
        if (statusEl) {
            statusEl.textContent = "目前僅支援 .docx 格式，若是舊版 .doc 請先用 Word 另存為 .docx 再上傳。";
            statusEl.className = "import-status error";
        }
        inputEl.value = "";
        return;
    }

    if (typeof mammoth === "undefined") {
        if (statusEl) {
            statusEl.textContent = "匯入元件尚未載入完成，請稍後再試一次。";
            statusEl.className = "import-status error";
        }
        inputEl.value = "";
        return;
    }

    try {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        const text = (result.value || "").trim();

        if (!text) {
            if (statusEl) {
                statusEl.textContent = "這份檔案讀不到任何文字內容，請確認檔案是否正確。";
                statusEl.className = "import-status error";
            }
            inputEl.value = "";
            return;
        }

        const textarea = document.getElementById(textareaId);
        if (textarea) textarea.value = text;

        if (statusEl) {
            statusEl.textContent = `已匯入「${file.name}」✓`;
            statusEl.className = "import-status success";
        }
    } catch (err) {
        if (statusEl) {
            statusEl.textContent = `匯入失敗：${err.message}`;
            statusEl.className = "import-status error";
        }
    } finally {
        // 清空 input 的值，讓使用者可以重複選擇同一個檔案再次觸發 change 事件
        inputEl.value = "";
    }
}

// 把文字內容（可含多段落，以換行分隔）匯出成 .docx 並觸發下載
// title：文件標題（選填，會以較大字體置於文件最上方）
// bodyText：正文內容
// filename：下載檔名（不含副檔名）
async function exportTextAsWord({ title, bodyText, filename }) {
    if (typeof docx === "undefined") {
        alert("匯出元件尚未載入完成，請稍後再試一次，或檢查網路連線是否能讀取 cdn.jsdelivr.net。");
        return;
    }

    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docx;

    const children = [];

    if (title && title.trim()) {
        children.push(
            new Paragraph({
                heading: HeadingLevel.HEADING_1,
                spacing: { after: 300 },
                children: [new TextRun({ text: title.trim(), bold: true })],
            })
        );
    }

    const paragraphs = (bodyText || "").split(/\n/);
    paragraphs.forEach((line) => {
        // 去除潤稿結果中常見的「■ 小標題」記號前綴，改用粗體呈現，其餘維持正文
        const headingMatch = line.match(/^■\s*(.+)$/);
        if (headingMatch) {
            children.push(
                new Paragraph({
                    spacing: { before: 200, after: 120 },
                    children: [new TextRun({ text: headingMatch[1], bold: true })],
                })
            );
        } else {
            children.push(
                new Paragraph({
                    spacing: { after: 120 },
                    children: [new TextRun({ text: line })],
                })
            );
        }
    });

    const doc = new Document({
        sections: [
            {
                properties: {},
                children,
            },
        ],
    });

    try {
        const blob = await Packer.toBlob(doc);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${filename || "卓編文稿"}.docx`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err) {
        alert(`匯出 Word 檔失敗：${err.message}`);
    }
}

// ================= 功能一：活動報導 潤稿 =================
function renderReportPage(container) {
    container.dataset.rendered = "1";
    container.innerHTML = `
        <div class="back-link" onclick="showPage('home')">
            ${ICONS.back}
            返回首頁
        </div>

        <div class="page-header">
            <div class="icon-box color-green icon-sm">${ICONS.report}</div>
            <div>
                <h2>活動報導 潤飾</h2>
                <p>梳理人事時地物，去除贅字，並自動加上提綱挈領的小標題</p>
            </div>
        </div>

        <div class="draft-banner" id="report-draft-banner"></div>

        <div class="panel">
            <div class="form-group">
                <label for="report-draft">貼上活動報導初稿</label>
                <div class="import-row">
                    <label class="file-import-label">
                        ${ICONS.importDoc}
                        匯入 Word 檔（.docx）
                        <input type="file" accept=".docx" onchange="handleWordImport(this, 'report-draft', 'report-import-status')">
                    </label>
                    <span class="import-status" id="report-import-status"></span>
                </div>
                <textarea id="report-draft" placeholder="請貼上寫手提交的初稿全文，或點選上方「匯入 Word 檔」直接上傳……"></textarea>
            </div>

            <div class="form-row">
                <div class="form-group">
                    <label for="report-length">期望字數</label>
                    <select id="report-length">
                        <option value="維持原文長度，僅潤飾語句">維持原文長度</option>
                        <option value="約 500 字">約 500 字（精簡版）</option>
                        <option value="約 800 字" selected>約 800 字（標準版）</option>
                        <option value="約 1200 字">約 1200 字（詳盡版）</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="report-tone">語氣強度</label>
                    <select id="report-tone">
                        <option value="平實莊重，貼近正式新聞稿語氣">平實莊重（新聞稿風格）</option>
                        <option value="溫潤親切，帶有法鼓禪風的溫度" selected>溫潤親切（法鼓禪風）</option>
                    </select>
                </div>
            </div>

            <div class="form-row">
                <div class="form-group">
                    <label for="report-intensity">潤稿幅度</label>
                    <select id="report-intensity">
                        <option value="light" selected>輕度（僅修正錯字、固定用語，保留原文句構）</option>
                        <option value="full">完整潤飾（梳理架構、去贅字、可調整句構）</option>
                    </select>
                </div>
            </div>

            <div class="btn-row">
                <button class="btn btn-primary" id="report-submit" onclick="handleReportSubmit()">
                    ${ICONS.submit}
                    請卓編過目
                </button>
                <div class="loading-indicator" id="report-loading">
                    ${INK_LOADER}
                    <span class="loading-text">卓編正在提筆潤稿<span class="dot">．</span><span class="dot">．</span><span class="dot">．</span></span>
                </div>
            </div>
            <div class="error-msg" id="report-error"></div>
        </div>

        <div class="panel result-panel" id="report-result-panel">
            <h4>${ICONS.done}潤稿結果</h4>
            <div class="result-box" id="report-result-box"></div>
            <div class="diff-box" id="report-diff-box"></div>
            <div class="btn-row" style="margin-top:16px;">
                <button class="btn btn-secondary copy-btn" onclick="copyToClipboard(document.getElementById('report-result-box').textContent, this)">複製全文</button>
                <button class="btn btn-secondary" onclick="exportTextAsWord({ title: '', bodyText: document.getElementById('report-result-box').textContent, filename: '活動報導_卓編潤稿' })">
                    ${ICONS.exportDoc}
                    匯出 Word 檔
                </button>
                <button class="btn btn-secondary" id="report-diff-toggle" onclick="toggleDiffView('report', document.getElementById('report-draft').value, document.getElementById('report-result-box').textContent, 'report-result-box', 'report-diff-box', 'report-diff-toggle')">顯示修改處對照</button>
            </div>
        </div>
    `;

    bindDraftAutosave("report");
    checkDraftAndPrompt("report", "report-draft-banner");
}

async function handleReportSubmit() {
    const draft = document.getElementById("report-draft").value.trim();
    const errorEl = document.getElementById("report-error");
    errorEl.classList.remove("show");

    if (!draft) {
        errorEl.textContent = "請先貼上初稿內容再送出。";
        errorEl.classList.add("show");
        return;
    }

    const length = document.getElementById("report-length").value;
    const tone = document.getElementById("report-tone").value;
    const intensity = document.getElementById("report-intensity").value;
    const submitBtn = document.getElementById("report-submit");
    const loadingEl = document.getElementById("report-loading");
    const resultPanel = document.getElementById("report-result-panel");

    submitBtn.disabled = true;
    loadingEl.classList.add("show");
    resultPanel.classList.remove("show");
    resetDiffView("report", "report-diff-toggle", "report-diff-box");

    const systemPrompt = intensity === "light"
        ? `你是「卓師姊」，法鼓山榮譽董事會的資深編輯，現在要做的是「輕度校對」，不是重寫。

【任務範圍，請務必嚴格遵守，不可超出】
1. 只修正：錯別字、標點符號誤用、明顯的用詞錯誤（例如固定用語被寫錯）。
2. 只在語句明顯不通順、有語病時做最小幅度的調整，讓句子讀得通即可。
3. 禁止事項（務必遵守）：
   - 不可重新組織段落結構或調動段落順序
   - 不可增刪原文的敘述內容、細節或例子
   - 不可大幅改寫句子、更換句構或改變原作者的表達方式與語氣
   - 不可自行加入原文沒有的小標題或內容
4. 除非原文長度與「${length}」的設定差距過大，否則不需為了字數而增刪內容；字數設定僅作參考，不可作為大幅改寫的理由。

【卓師姊的特別注意事項（請務必絕對遵守，這些是本次校對的重點）】
${buildRulesPromptFragment()}

請直接輸出校對後的完整文章，維持原文的段落與句構，不需要額外說明或前言。`
        : `你是「卓師姊」，法鼓山榮譽董事會的資深編輯，擅長潤飾活動報導文稿，文風溫潤、莊重、貼近法鼓禪風。

【任務】
針對使用者提供的活動報導初稿，進行以下處理：
1. 梳理清楚人、事、時、地、物等基本要素，確保敘述完整且邏輯清晰。
2. 去除贅字冗詞、口語化表達，改為書面、莊重但不失溫度的語氣（${tone}）。
3. 在文章重要段落前，加上 4-6 個字的提綱挈領小標題（以「■ 小標題」格式呈現於段落上方）。
4. 字數控制：${length}。

【卓師姊的特別注意事項（請務必絕對遵守）】
${buildRulesPromptFragment()}

請直接輸出潤飾後的完整文章（含小標題），不需要額外說明或前言。`;

    try {
        const result = await askZhuo({ systemPrompt, userPrompt: draft, temperature: 0.6 });
        document.getElementById("report-result-box").textContent = result;
        resultPanel.classList.add("show");
        resultPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
        localStorage.removeItem(DRAFT_STORAGE_PREFIX + "report");
    } catch (err) {
        errorEl.textContent = `潤稿失敗：${err.message}`;
        errorEl.classList.add("show");
    } finally {
        submitBtn.disabled = false;
        loadingEl.classList.remove("show");
    }
}

// ================= 功能二：人物專訪 潤稿 =================
function renderInterviewPage(container) {
    container.dataset.rendered = "1";
    container.innerHTML = `
        <div class="back-link" onclick="showPage('home')">
            ${ICONS.back}
            返回首頁
        </div>

        <div class="page-header">
            <div class="icon-box color-green icon-sm">${ICONS.interview}</div>
            <div>
                <h2>人物專訪 潤飾</h2>
                <p>萃取「學佛因緣」與「護法願心」，產出具備禪意的主標題選項</p>
            </div>
        </div>

        <div class="draft-banner" id="interview-draft-banner"></div>

        <div class="panel">
            <div class="form-group">
                <label for="interview-draft">貼上人物專訪初稿</label>
                <div class="import-row">
                    <label class="file-import-label">
                        ${ICONS.importDoc}
                        匯入 Word 檔（.docx）
                        <input type="file" accept=".docx" onchange="handleWordImport(this, 'interview-draft', 'interview-import-status')">
                    </label>
                    <span class="import-status" id="interview-import-status"></span>
                </div>
                <textarea id="interview-draft" placeholder="請貼上訪談逐字稿或初稿內容，或點選上方「匯入 Word 檔」直接上傳……"></textarea>
            </div>

            <div class="form-row">
                <div class="form-group">
                    <label for="interview-length">期望字數</label>
                    <select id="interview-length">
                        <option value="維持原文長度，僅潤飾語句">維持原文長度</option>
                        <option value="約 600 字">約 600 字（精簡版）</option>
                        <option value="約 1000 字" selected>約 1000 字（標準版）</option>
                        <option value="約 1500 字">約 1500 字（詳盡版）</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="interview-focus">內容側重</label>
                    <select id="interview-focus">
                        <option value="平均著重學佛因緣與護法願心兩部分" selected>學佛因緣 ＋ 護法願心（平均）</option>
                        <option value="更著重描寫學佛因緣、生命轉折的故事性">側重「學佛因緣」故事性</option>
                        <option value="更著重描寫護法願心、奉獻護持的實際行動">側重「護法願心」實踐面</option>
                    </select>
                </div>
            </div>

            <div class="form-row">
                <div class="form-group">
                    <label for="interview-intensity">潤稿幅度</label>
                    <select id="interview-intensity">
                        <option value="light" selected>輕度（僅修正錯字、固定用語，保留原文句構）</option>
                        <option value="full">完整潤飾（萃取重點、可調整句構與段落）</option>
                    </select>
                </div>
            </div>

            <div class="btn-row">
                <button class="btn btn-primary" id="interview-submit" onclick="handleInterviewSubmit()">
                    ${ICONS.submit}
                    請卓編過目
                </button>
                <div class="loading-indicator" id="interview-loading">
                    ${INK_LOADER}
                    <span class="loading-text">卓編正在細細品讀稿件<span class="dot">．</span><span class="dot">．</span><span class="dot">．</span></span>
                </div>
            </div>
            <div class="error-msg" id="interview-error"></div>
        </div>

        <div class="panel result-panel" id="interview-result-panel">
            <h4>${ICONS.seal}備選主標題（請點選一則套用）</h4>
            <div class="title-options" id="interview-title-options"></div>

            <h4>${ICONS.done}潤稿結果</h4>
            <div class="result-box" id="interview-result-box"></div>
            <div class="diff-box" id="interview-diff-box"></div>
            <div class="btn-row" style="margin-top:16px;">
                <button class="btn btn-secondary copy-btn" onclick="copyInterviewFull()">複製標題＋全文</button>
                <button class="btn btn-secondary" onclick="exportInterviewAsWord()">
                    ${ICONS.exportDoc}
                    匯出 Word 檔
                </button>
                <button class="btn btn-secondary" id="interview-diff-toggle" onclick="toggleDiffView('interview', document.getElementById('interview-draft').value, document.getElementById('interview-result-box').textContent, 'interview-result-box', 'interview-diff-box', 'interview-diff-toggle')">顯示修改處對照</button>
            </div>
        </div>
    `;

    bindDraftAutosave("interview");
    checkDraftAndPrompt("interview", "interview-draft-banner");
}

async function handleInterviewSubmit() {
    const draft = document.getElementById("interview-draft").value.trim();
    const errorEl = document.getElementById("interview-error");
    errorEl.classList.remove("show");

    if (!draft) {
        errorEl.textContent = "請先貼上專訪初稿內容再送出。";
        errorEl.classList.add("show");
        return;
    }

    const length = document.getElementById("interview-length").value;
    const focus = document.getElementById("interview-focus").value;
    const intensity = document.getElementById("interview-intensity").value;
    const submitBtn = document.getElementById("interview-submit");
    const loadingEl = document.getElementById("interview-loading");
    const resultPanel = document.getElementById("interview-result-panel");

    submitBtn.disabled = true;
    loadingEl.classList.add("show");
    resultPanel.classList.remove("show");
    resetDiffView("interview", "interview-diff-toggle", "interview-diff-box");

    const systemPrompt = intensity === "light"
        ? `你是「卓師姊」，法鼓山榮譽董事會的資深編輯，現在要做的是「輕度校對」，不是重寫。

【任務範圍，請務必嚴格遵守，不可超出】
1. 只修正：錯別字、標點符號誤用、明顯的用詞錯誤（例如固定用語被寫錯）。
2. 只在語句明顯不通順、有語病時做最小幅度的調整，讓句子讀得通即可。
3. 禁止事項（務必遵守）：
   - 不可重新組織段落結構或調動段落順序
   - 不可增刪原文的敘述內容、細節或例子
   - 不可大幅改寫句子、更換句構或改變受訪者原本的表達方式與語氣
4. 除非原文長度與「${length}」的設定差距過大，否則不需為了字數而增刪內容；字數設定僅作參考，不可作為大幅改寫的理由。
5. 仍需依內容側重方向（${focus}）產出 3 個備選主標題，標題須具備禪意與詩意，例如「從收藏到學佛，從藝到禪」的意境（八到十四字為宜）。標題是另外新增的產出，不屬於「不可改寫」的限制範圍。

【卓師姊的特別注意事項（請務必絕對遵守，這些是本次校對的重點）】
${buildRulesPromptFragment()}

【輸出格式規定，請務必嚴格遵守】`
        : `你是「卓師姊」，法鼓山榮譽董事會的資深編輯，擅長將人物專訪逐字稿或初稿，轉化為平穩且具溫度的正式文稿。

【任務】
1. 從內容中萃取受訪者的「學佛因緣」（如何接觸佛法、生命轉折）與「護法願心」（護持奉獻的心路歷程），作為文章重點。內容側重方向：${focus}
2. 將口語化、零散的敘述，潤飾為平穩、莊重但保有溫度的書面語氣，避免過度口語贅詞。
3. 字數控制：${length}。
4. 產出 3 個備選主標題，標題須具備禪意與詩意，例如「從收藏到學佛，從藝到禪」的意境（八到十四字為宜）。

【卓師姊的特別注意事項（請務必絕對遵守）】
${buildRulesPromptFragment()}

【輸出格式規定，請務必嚴格遵守】
請務必只用以下格式輸出，不要有其他說明文字：

TITLE1: 第一個備選標題
TITLE2: 第二個備選標題
TITLE3: 第三個備選標題
---
（這裡開始是潤飾後的完整內文，不要重複標題）`;

    try {
        const result = await askZhuo({ systemPrompt, userPrompt: draft, temperature: 0.75 });
        parseAndRenderInterviewResult(result);
        resultPanel.classList.add("show");
        resultPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
        localStorage.removeItem(DRAFT_STORAGE_PREFIX + "interview");
    } catch (err) {
        errorEl.textContent = `潤稿失敗：${err.message}`;
        errorEl.classList.add("show");
    } finally {
        submitBtn.disabled = false;
        loadingEl.classList.remove("show");
    }
}

function parseAndRenderInterviewResult(raw) {
    const titles = [];
    let body = raw;

    const t1 = raw.match(/TITLE1:\s*(.+)/);
    const t2 = raw.match(/TITLE2:\s*(.+)/);
    const t3 = raw.match(/TITLE3:\s*(.+)/);
    if (t1) titles.push(t1[1].trim());
    if (t2) titles.push(t2[1].trim());
    if (t3) titles.push(t3[1].trim());

    const splitIndex = raw.indexOf("---");
    if (splitIndex !== -1) {
        body = raw.slice(splitIndex + 3).trim();
    }

    // 若解析失敗（卓編這次沒有照格式回覆），則整段當作內文顯示，不顯示標題選項
    currentInterviewTitles = titles;

    const optionsEl = document.getElementById("interview-title-options");
    if (titles.length > 0) {
        optionsEl.innerHTML = titles
            .map(
                (title, idx) => `
            <div class="title-option" id="title-opt-${idx}" onclick="selectInterviewTitle(${idx})">
                <span>${escapeHtml(title)}</span>
                ${ICONS.done}
            </div>`
            )
            .join("");
        selectInterviewTitle(0);
    } else {
        optionsEl.innerHTML = `<div class="hint">（本次未偵測到標題格式，請參考下方全文內容）</div>`;
    }

    document.getElementById("interview-result-box").textContent = body;
}

function selectInterviewTitle(idx) {
    document.querySelectorAll(".title-option").forEach((el) => el.classList.remove("selected"));
    const el = document.getElementById(`title-opt-${idx}`);
    if (el) el.classList.add("selected");
    window.selectedInterviewTitleIdx = idx;
}

function copyInterviewFull() {
    const idx = window.selectedInterviewTitleIdx ?? 0;
    const title = currentInterviewTitles[idx] || "";
    const body = document.getElementById("interview-result-box").textContent;
    const fullText = title ? `${title}\n\n${body}` : body;
    navigator.clipboard.writeText(fullText).then(() => {
        const btn = event.target;
        const original = btn.textContent;
        btn.textContent = "已複製 ✓";
        setTimeout(() => (btn.textContent = original), 1500);
    });
}

function exportInterviewAsWord() {
    const idx = window.selectedInterviewTitleIdx ?? 0;
    const title = currentInterviewTitles[idx] || "";
    const body = document.getElementById("interview-result-box").textContent;
    exportTextAsWord({ title, bodyText: body, filename: "人物專訪_卓編潤稿" });
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

// ================= 功能三：活動 DM 文案撰寫 =================
function renderDmPage(container) {
    container.dataset.rendered = "1";
    container.innerHTML = `
        <div class="back-link" onclick="showPage('home')">
            ${ICONS.back}
            返回首頁
        </div>

        <div class="page-header">
            <div class="icon-box color-brown icon-sm">${ICONS.dm}</div>
            <div>
                <h2>活動 DM 撰寫</h2>
                <p>套用起承轉合架構與聖嚴師父法語，產出適合排版的宣傳文案</p>
            </div>
        </div>

        <div class="draft-banner" id="dm-draft-banner"></div>

        <div class="panel">
            <div class="form-row">
                <div class="form-group">
                    <label for="dm-name">活動名稱</label>
                    <input type="text" id="dm-name" placeholder="例如：2026 年度榮董感恩聯誼會">
                </div>
                <div class="form-group">
                    <label for="dm-datetime">活動日期／地點</label>
                    <input type="text" id="dm-datetime" placeholder="例如：11/15（日）09:00｜法鼓山世界佛教教育園區">
                </div>
            </div>

            <div class="form-group">
                <label for="dm-purpose">活動宗旨／目標對象</label>
                <div class="import-row">
                    <label class="file-import-label">
                        ${ICONS.importDoc}
                        匯入 Word 檔（.docx）
                        <input type="file" accept=".docx" onchange="handleWordImport(this, 'dm-purpose', 'dm-import-status')">
                    </label>
                    <span class="import-status" id="dm-import-status"></span>
                </div>
                <textarea id="dm-purpose" style="min-height:100px;" placeholder="例如：感恩榮董菩薩們一年來的護持，邀請所有榮董及其眷屬齊聚，共同回顧僧團弘化足跡……或點選上方「匯入 Word 檔」直接上傳寫手提供的活動宗旨初稿"></textarea>
            </div>

            <div class="form-group">
                <label for="dm-notes">特別注意事項（選填）</label>
                <textarea id="dm-notes" style="min-height:80px;" placeholder="例如：需提及本次活動需事先報名、有素齋供應等……"></textarea>
            </div>

            <div class="btn-row">
                <button class="btn btn-primary" id="dm-submit" onclick="handleDmSubmit()">
                    ${ICONS.submit}
                    生成 DM 文案
                </button>
                <div class="loading-indicator" id="dm-loading">
                    ${INK_LOADER}
                    <span class="loading-text">卓編正在構思文案<span class="dot">．</span><span class="dot">．</span><span class="dot">．</span></span>
                </div>
            </div>
            <div class="error-msg" id="dm-error"></div>
        </div>

        <div class="panel result-panel" id="dm-result-panel">
            <h4>${ICONS.done}DM 文案</h4>
            <div class="result-box" id="dm-result-box"></div>
            <div class="btn-row" style="margin-top:16px;">
                <button class="btn btn-secondary copy-btn" onclick="copyToClipboard(document.getElementById('dm-result-box').textContent, this)">複製全文</button>
                <button class="btn btn-secondary" onclick="exportTextAsWord({ title: document.getElementById('dm-name').value.trim(), bodyText: document.getElementById('dm-result-box').textContent, filename: '活動DM_卓編文案' })">
                    ${ICONS.exportDoc}
                    匯出 Word 檔
                </button>
            </div>
        </div>
    `;

    bindDraftAutosave("dm");
    checkDraftAndPrompt("dm", "dm-draft-banner");
}

async function handleDmSubmit() {
    const name = document.getElementById("dm-name").value.trim();
    const datetime = document.getElementById("dm-datetime").value.trim();
    const purpose = document.getElementById("dm-purpose").value.trim();
    const notes = document.getElementById("dm-notes").value.trim();
    const errorEl = document.getElementById("dm-error");
    errorEl.classList.remove("show");

    if (!name || !datetime || !purpose) {
        errorEl.textContent = "請至少填寫活動名稱、日期地點與活動宗旨。";
        errorEl.classList.add("show");
        return;
    }

    const submitBtn = document.getElementById("dm-submit");
    const loadingEl = document.getElementById("dm-loading");
    const resultPanel = document.getElementById("dm-result-panel");

    submitBtn.disabled = true;
    loadingEl.classList.add("show");
    resultPanel.classList.remove("show");

    const systemPrompt = `你是「卓師姊」，法鼓山榮譽董事會的資深編輯，擅長撰寫活動 DM 宣傳文案，文風溫潤、莊重，帶有法鼓禪風。

【任務】
根據使用者提供的活動資訊，撰寫一篇適合 DM 排版的宣傳文案，套用「起承轉合」架構：
- 起：以佛法問候語或聖嚴師父法語破題（例如引用「四它」「心靈環保」「奉獻即是修行」等精神，不需逐字引用原文，可用自己的話傳達其精神）
- 承：帶出本次活動的宗旨與意義
- 轉：說明活動亮點與重要資訊（時間地點、參與方式）
- 合：以溫暖的呼籲收尾，邀請菩薩們共結善緣、共襄盛舉

【卓師姊的特別注意事項（請務必絕對遵守）】
${buildRulesPromptFragment()}

請直接輸出完整 DM 文案，不需要額外說明或前言，文案中請自然帶入以下活動資訊。`;

    const userPrompt = `活動名稱：${name}
活動日期／地點：${datetime}
活動宗旨／目標對象：${purpose}
特別注意事項：${notes || "無"}`;

    try {
        const result = await askZhuo({ systemPrompt, userPrompt, temperature: 0.8 });
        document.getElementById("dm-result-box").textContent = result;
        resultPanel.classList.add("show");
        resultPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
        localStorage.removeItem(DRAFT_STORAGE_PREFIX + "dm");
    } catch (err) {
        errorEl.textContent = `文案生成失敗：${err.message}`;
        errorEl.classList.add("show");
    } finally {
        submitBtn.disabled = false;
        loadingEl.classList.remove("show");
    }
}

// ================= 功能四：大神的便條紙（規則庫管理） =================
function renderRulesPage(container) {
    container.dataset.rendered = "1";
    container.innerHTML = `
        <div class="back-link" onclick="showPage('home')">
            ${ICONS.back}
            返回首頁
        </div>

        <div class="page-header">
            <div class="icon-box color-brown icon-sm">${ICONS.rules}</div>
            <div>
                <h2>大神的便條紙</h2>
                <p>管理特別注意事項、詞彙提醒與當期主軸，其他三項功能會即時套用啟用中的規則</p>
            </div>
        </div>

        <div class="panel">
            <div class="rule-form">
                <div class="form-group" style="margin-bottom:0;">
                    <label for="new-rule-content">新增叮嚀內容</label>
                    <input type="text" id="new-rule-content" placeholder="例如：禁用「粉絲」，一律改用「信眾」或「菩薩」">
                </div>
                <div class="form-group" style="margin-bottom:0;">
                    <label for="new-rule-category">分類</label>
                    <select id="new-rule-category">
                        <option value="詞彙提醒">詞彙提醒</option>
                        <option value="當期主題">當期主題</option>
                        <option value="排版規定">排版規定</option>
                        <option value="自動歸納">自動歸納</option>
                    </select>
                </div>
                <button class="btn btn-primary" onclick="handleAddRule()">
                    ${ICONS.add}
                    新增
                </button>
            </div>

            <div class="error-msg" id="rules-error"></div>

            <div class="rule-filter-row" id="rule-filter-row">
                <button class="filter-chip active" data-filter="all" onclick="setRuleFilter('all')">全部</button>
                <button class="filter-chip" data-filter="week" onclick="setRuleFilter('week')">本週新增</button>
                <button class="filter-chip" data-filter="自動歸納" onclick="setRuleFilter('自動歸納')">僅看自動歸納</button>
                <span class="rule-filter-count" id="rule-filter-count"></span>
                <div class="rule-export-actions">
                    <button class="btn btn-secondary" style="padding:6px 14px;font-size:12.5px;" onclick="exportRulesAsJson()">
                        ${ICONS.exportDoc}
                        備份 JSON
                    </button>
                    <button class="btn btn-secondary" style="padding:6px 14px;font-size:12.5px;" onclick="exportRulesAsWord()">
                        ${ICONS.exportDoc}
                        備份 Word
                    </button>
                </div>
            </div>

            <div class="rule-list" id="rules-list">
                <div class="empty-state">載入中……</div>
            </div>
        </div>

        <div class="panel diff-panel">
            <h4>${ICONS.seal}從潤稿前後對照，自動歸納規則</h4>
            <p class="diff-desc">貼上（或匯入 Word 檔）同一篇文章的「潤稿前」與「潤稿後」版本，卓編會分析兩者差異，把可重複套用的修改習慣（例如固定用詞、慣用句式）自動整理成規則，直接加入上方清單。分析出來的規則會標記為「自動歸納」分類；若內容跟現有規則完全相同會自動略過，不會重複新增。</p>

            <div class="diff-columns">
                <div class="form-group" style="margin-bottom:0;">
                    <label for="diff-before">潤稿前（初稿原文）</label>
                    <div class="import-row">
                        <label class="file-import-label">
                            ${ICONS.importDoc}
                            匯入 Word 檔（.docx）
                            <input type="file" accept=".docx" onchange="handleWordImport(this, 'diff-before', 'diff-before-status')">
                        </label>
                        <span class="import-status" id="diff-before-status"></span>
                    </div>
                    <textarea id="diff-before" placeholder="請貼上寫手原始初稿，或點選上方「匯入 Word 檔」直接上傳……"></textarea>
                </div>
                <div class="form-group" style="margin-bottom:0;">
                    <label for="diff-after">潤稿後（卓師姊定稿）</label>
                    <div class="import-row">
                        <label class="file-import-label">
                            ${ICONS.importDoc}
                            匯入 Word 檔（.docx）
                            <input type="file" accept=".docx" onchange="handleWordImport(this, 'diff-after', 'diff-after-status')">
                        </label>
                        <span class="import-status" id="diff-after-status"></span>
                    </div>
                    <textarea id="diff-after" placeholder="請貼上卓師姊潤飾完成的定稿，或點選上方「匯入 Word 檔」直接上傳……"></textarea>
                </div>
            </div>

            <div class="btn-row">
                <button class="btn btn-primary" id="diff-submit" onclick="handleAnalyzeDiff()">
                    ${ICONS.submit}
                    分析並歸納規則
                </button>
                <button class="btn btn-secondary" onclick="addCurrentDiffToQueue()">
                    ${ICONS.add}
                    加入批次佇列
                </button>
                <div class="loading-indicator" id="diff-loading">
                    ${INK_LOADER}
                    <span class="loading-text">卓編正在比對前後差異<span class="dot">．</span><span class="dot">．</span><span class="dot">．</span></span>
                </div>
            </div>
            <div class="error-msg" id="diff-error"></div>
            <div id="diff-result-summary"></div>

            <!-- V7：批次處理 - 若有多篇文章要處理，可將每組前後對照加入佇列，最後一次送出逐篇分析 -->
            <div class="diff-batch-section">
                <h4>${ICONS.rules}批次佇列（一次處理多篇文章）</h4>
                <p class="diff-desc">若手上有好幾篇文章要比對，可以每填好一組「潤稿前／潤稿後」就按「加入批次佇列」，累積多組後再一次按「開始批次分析」，卓編會依序逐篇比對、自動彙總結果，不需要每篇都手動等待、重新填寫。</p>
                <div class="diff-batch-list" id="diff-batch-list">
                    <div class="empty-state">目前佇列是空的，請先在上方填好一組前後對照，再按「加入批次佇列」。</div>
                </div>
                <div class="btn-row" style="margin-top:16px;">
                    <button class="btn btn-primary" id="diff-batch-submit" onclick="handleBatchAnalyzeDiff()" disabled>
                        ${ICONS.submit}
                        開始批次分析
                    </button>
                    <button class="btn btn-danger-outline" onclick="clearDiffQueue()">清空佇列</button>
                    <div class="loading-indicator" id="diff-batch-loading">
                        ${INK_LOADER}
                        <span class="loading-text" id="diff-batch-loading-text">正在處理第 1 / 1 篇<span class="dot">．</span><span class="dot">．</span><span class="dot">．</span></span>
                    </div>
                </div>
                <div id="diff-batch-summary"></div>
            </div>
        </div>
    `;
}

let currentRuleFilter = "all";

function setRuleFilter(filter) {
    currentRuleFilter = filter;
    document.querySelectorAll(".filter-chip").forEach((el) => {
        el.classList.toggle("active", el.dataset.filter === filter);
    });
    renderRulesList();
}

// 判斷某規則的 created_at 是否落在最近 7 天內（含今天）
function isWithinLastWeek(createdAt) {
    if (!createdAt) return false;
    const created = new Date(createdAt);
    if (Number.isNaN(created.getTime())) return false;
    const now = new Date();
    const diffMs = now - created;
    return diffMs >= 0 && diffMs <= 7 * 24 * 60 * 60 * 1000;
}

// 把 ISO 日期格式化成「MM/DD」，用於規則卡片上顯示建立日期
function formatRuleDate(createdAt) {
    if (!createdAt) return "";
    const d = new Date(createdAt);
    if (Number.isNaN(d.getTime())) return "";
    return `${d.getMonth() + 1}/${d.getDate()}`;
}

// V7：規則庫備份 - 匯出成 JSON 檔（供日後匯入或純粹留底，KV 本身沒有版本記錄，誤刪不好復原）
function exportRulesAsJson() {
    if (rulesCache.length === 0) {
        alert("目前沒有任何規則可以匯出。");
        return;
    }
    const payload = {
        exported_at: new Date().toISOString(),
        source: "卓編數位書房 - 大神的便條紙",
        rule_count: rulesCache.length,
        rules: rulesCache,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const dateStr = new Date().toISOString().slice(0, 10);
    a.download = `便條紙備份_${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// V7：規則庫備份 - 匯出成易讀的 Word 檔，依分類分段列出，方便列印或傳閱給其他編輯参考
async function exportRulesAsWord() {
    if (rulesCache.length === 0) {
        alert("目前沒有任何規則可以匯出。");
        return;
    }
    if (typeof docx === "undefined") {
        alert("匯出元件尚未載入完成，請稍後再試一次，或檢查網路連線是否能讀取 cdn.jsdelivr.net。");
        return;
    }

    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docx;
    const children = [];

    children.push(
        new Paragraph({
            heading: HeadingLevel.HEADING_1,
            spacing: { after: 200 },
            children: [new TextRun({ text: "大神的便條紙 - 規則庫備份", bold: true })],
        })
    );
    children.push(
        new Paragraph({
            spacing: { after: 300 },
            children: [new TextRun({ text: `匯出時間：${new Date().toLocaleString("zh-TW")}　共 ${rulesCache.length} 則`, color: "666666", size: 20 })],
        })
    );

    const byCategory = {};
    rulesCache.forEach((r) => {
        if (!byCategory[r.category]) byCategory[r.category] = [];
        byCategory[r.category].push(r);
    });

    for (const [category, items] of Object.entries(byCategory)) {
        children.push(
            new Paragraph({
                heading: HeadingLevel.HEADING_2,
                spacing: { before: 200, after: 100 },
                children: [new TextRun({ text: `【${category}】`, bold: true })],
            })
        );
        items.forEach((r) => {
            const statusLabel = r.is_active ? "" : "（已停用）";
            const dateLabel = formatRuleDate(r.created_at);
            children.push(
                new Paragraph({
                    spacing: { after: 100 },
                    children: [
                        new TextRun({ text: `${dateLabel ? `[${dateLabel}] ` : ""}${r.content}${statusLabel}` }),
                    ],
                })
            );
        });
    }

    const doc = new Document({ sections: [{ properties: {}, children }] });

    try {
        const blob = await Packer.toBlob(doc);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const dateStr = new Date().toISOString().slice(0, 10);
        a.download = `便條紙備份_${dateStr}.docx`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err) {
        alert(`匯出 Word 檔失敗：${err.message}`);
    }
}

function renderRulesList() {
    const listEl = document.getElementById("rules-list");
    if (!listEl) return;

    if (rulesCache.length === 0) {
        listEl.innerHTML = `<div class="empty-state">目前還沒有任何叮嚀事項，請於上方新增。</div>`;
        const countEl = document.getElementById("rule-filter-count");
        if (countEl) countEl.textContent = "";
        return;
    }

    // V7：依目前選定的篩選條件過濾（全部 / 本週新增 / 特定分類）
    let filtered = rulesCache;
    if (currentRuleFilter === "week") {
        filtered = rulesCache.filter((r) => isWithinLastWeek(r.created_at));
    } else if (currentRuleFilter !== "all") {
        filtered = rulesCache.filter((r) => r.category === currentRuleFilter);
    }

    const countEl = document.getElementById("rule-filter-count");
    if (countEl) {
        countEl.textContent = `共 ${filtered.length} 則${filtered.length !== rulesCache.length ? `（總數 ${rulesCache.length} 則）` : ""}`;
    }

    if (filtered.length === 0) {
        listEl.innerHTML = `<div class="empty-state">此篩選條件下沒有符合的叮嚀事項。</div>`;
        return;
    }

    const categoryTagClass = {
        "詞彙提醒": "tag-vocab",
        "當期主題": "tag-theme",
        "排版規定": "tag-format",
        "自動歸納": "tag-auto",
    };

    listEl.innerHTML = filtered
        .map((rule) => {
            const tagClass = categoryTagClass[rule.category] || "tag-vocab";
            const dateLabel = formatRuleDate(rule.created_at);
            return `
            <div class="rule-item ${rule.is_active ? "" : "inactive"}" data-id="${rule.id}">
                <label class="toggle-switch" title="啟用／停用">
                    <input type="checkbox" ${rule.is_active ? "checked" : ""} onchange="handleToggleRule('${rule.id}', this.checked)">
                    <span class="toggle-slider"></span>
                </label>
                <div class="rule-main">
                    <span class="rule-tag ${tagClass}">${escapeHtml(rule.category)}</span>
                    ${dateLabel ? `<span class="rule-date">${dateLabel} 新增</span>` : ""}
                    <div class="rule-content">${escapeHtml(rule.content)}</div>
                </div>
                <div class="rule-actions">
                    <button class="btn btn-danger-outline" onclick="handleDeleteRule('${rule.id}')">刪除</button>
                </div>
            </div>`;
        })
        .join("");
}

// 共用：把一則規則寫入資料庫（DEMO_MODE 下寫入記憶體），回傳寫入後的 rule 物件
async function createRuleOnServer(content, category) {
    if (DEMO_MODE) {
        const rule = {
            id: `demo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            content,
            category,
            is_active: true,
            created_at: new Date().toISOString(),
        };
        rulesCache.push(rule);
        return rule;
    }

    const resp = await fetch(`${WORKER_BASE_URL}/api/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, category, is_active: true }),
    });
    if (!resp.ok) throw new Error("新增失敗");
    const data = await resp.json();
    rulesCache.push(data.rule);
    return data.rule;
}

async function handleAddRule() {
    const contentInput = document.getElementById("new-rule-content");
    const categorySelect = document.getElementById("new-rule-category");
    const errorEl = document.getElementById("rules-error");
    errorEl.classList.remove("show");

    const content = contentInput.value.trim();
    if (!content) {
        errorEl.textContent = "請輸入叮嚀內容再新增。";
        errorEl.classList.add("show");
        return;
    }

    const category = categorySelect.value;

    try {
        await createRuleOnServer(content, category);
        contentInput.value = "";
        renderRulesList();
    } catch (err) {
        errorEl.textContent = `新增失敗：${err.message}`;
        errorEl.classList.add("show");
    }
}

// ================= V6：潤稿前後對照 → 自動歸納規則 =================
// ================= V7：批次處理 - 佇列管理 =================
// 佇列裡每一項是 { id, beforeText, afterText, label }，label 是給使用者辨識用的簡短摘要（取前後文開頭幾個字）
let diffQueue = [];

function makeQueueLabel(text) {
    const trimmed = (text || "").replace(/\s+/g, " ").trim();
    return trimmed.length > 20 ? trimmed.slice(0, 20) + "…" : trimmed || "（空白）";
}

// 把目前「潤稿前／潤稿後」輸入框的內容加進佇列，並清空輸入框方便繼續填下一組
function addCurrentDiffToQueue() {
    const beforeText = document.getElementById("diff-before").value.trim();
    const afterText = document.getElementById("diff-after").value.trim();
    const errorEl = document.getElementById("diff-error");
    errorEl.classList.remove("show");

    if (!beforeText || !afterText) {
        errorEl.textContent = "請同時填好「潤稿前」與「潤稿後」，才能加入批次佇列。";
        errorEl.classList.add("show");
        return;
    }

    diffQueue.push({
        id: `queue-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        beforeText,
        afterText,
        label: makeQueueLabel(beforeText),
    });

    // 清空輸入框，方便使用者繼續貼下一組前後對照（匯入狀態文字也一併清除）
    document.getElementById("diff-before").value = "";
    document.getElementById("diff-after").value = "";
    const beforeStatus = document.getElementById("diff-before-status");
    const afterStatus = document.getElementById("diff-after-status");
    if (beforeStatus) beforeStatus.textContent = "";
    if (afterStatus) afterStatus.textContent = "";

    renderDiffQueueList();
}

function removeFromDiffQueue(id) {
    diffQueue = diffQueue.filter((item) => item.id !== id);
    renderDiffQueueList();
}

function clearDiffQueue() {
    diffQueue = [];
    renderDiffQueueList();
    const summaryEl = document.getElementById("diff-batch-summary");
    if (summaryEl) summaryEl.innerHTML = "";
}

function renderDiffQueueList() {
    const listEl = document.getElementById("diff-batch-list");
    const submitBtn = document.getElementById("diff-batch-submit");
    if (!listEl) return;

    if (diffQueue.length === 0) {
        listEl.innerHTML = `<div class="empty-state">目前佇列是空的，請先在上方填好一組前後對照，再按「加入批次佇列」。</div>`;
        if (submitBtn) submitBtn.disabled = true;
        return;
    }

    listEl.innerHTML = diffQueue
        .map(
            (item, idx) => `
        <div class="diff-batch-item">
            <span class="diff-batch-item-no">第 ${idx + 1} 篇</span>
            <span class="diff-batch-item-label">${escapeHtml(item.label)}</span>
            <button class="btn btn-danger-outline" onclick="removeFromDiffQueue('${item.id}')">移除</button>
        </div>`
        )
        .join("");

    if (submitBtn) submitBtn.disabled = false;
}

// 批次分析：依序逐篇呼叫卓編分析（沿用單篇分析的 systemPrompt 邏輯），彙總所有新增／略過/失敗的規則
async function handleBatchAnalyzeDiff() {
    if (diffQueue.length === 0) return;

    const submitBtn = document.getElementById("diff-batch-submit");
    const loadingEl = document.getElementById("diff-batch-loading");
    const loadingTextEl = document.getElementById("diff-batch-loading-text");
    const summaryEl = document.getElementById("diff-batch-summary");
    summaryEl.innerHTML = "";
    summaryEl.className = "";

    submitBtn.disabled = true;
    loadingEl.classList.add("show");

    let totalFound = 0;
    let totalCreated = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    const perArticleResults = [];

    // 逐篇處理，刻意不並行送出（避免同時打爆三組備援 Key 額度、也方便使用者看到進度文字）
    for (let i = 0; i < diffQueue.length; i++) {
        const item = diffQueue[i];
        if (loadingTextEl) {
            loadingTextEl.innerHTML = `正在處理第 ${i + 1} / ${diffQueue.length} 篇<span class="dot">．</span><span class="dot">．</span><span class="dot">．</span>`;
        }

        try {
            const extractedRules = await analyzeDiffPair(item.beforeText, item.afterText);
            totalFound += extractedRules.length;

            const existingContents = new Set(rulesCache.map((r) => r.content.trim()));
            const toCreate = [];
            let skippedCount = 0;

            extractedRules.forEach((r) => {
                const content = (r.content || "").trim();
                if (!content) return;
                if (existingContents.has(content)) {
                    skippedCount++;
                } else {
                    toCreate.push(content);
                    existingContents.add(content);
                }
            });

            let createdCount = 0;
            let failedCount = 0;
            for (const content of toCreate) {
                try {
                    await createRuleOnServer(content, "自動歸納");
                    createdCount++;
                } catch (err) {
                    failedCount++;
                }
            }

            totalCreated += createdCount;
            totalSkipped += skippedCount;
            totalFailed += failedCount;

            perArticleResults.push({
                label: item.label,
                found: extractedRules.length,
                created: createdCount,
                skipped: skippedCount,
                failed: failedCount,
                error: null,
            });
        } catch (err) {
            perArticleResults.push({
                label: item.label,
                found: 0,
                created: 0,
                skipped: 0,
                failed: 0,
                error: err.message,
            });
        }
    }

    renderRulesList();

    let html = `<div class="diff-result-summary ${totalFailed > 0 ? "error" : "success"}">`;
    html += `批次分析完成，共處理 ${diffQueue.length} 篇文章：找到 ${totalFound} 條修改模式，`;
    html += `<strong>新增 ${totalCreated} 條</strong>`;
    if (totalSkipped > 0) html += `，略過 ${totalSkipped} 條重複規則`;
    if (totalFailed > 0) html += `，<strong style="color:var(--danger);">${totalFailed} 條寫入失敗</strong>`;
    html += `。</div>`;

    html += `<div class="diff-batch-list" style="margin-top:12px;">`;
    perArticleResults.forEach((r, idx) => {
        html += `<div class="diff-batch-item">
            <span class="diff-batch-item-no">第 ${idx + 1} 篇</span>
            <span class="diff-batch-item-label">${escapeHtml(r.label)}</span>
            <span class="diff-batch-item-result">${
                r.error
                    ? `<span style="color:var(--danger);">分析失敗：${escapeHtml(r.error)}</span>`
                    : `找到 ${r.found} 條，新增 ${r.created} 條${r.skipped ? `，略過 ${r.skipped} 條` : ""}${r.failed ? `，失敗 ${r.failed} 條` : ""}`
            }</span>
        </div>`;
    });
    html += `</div>`;

    summaryEl.innerHTML = html;

    // 全部處理完後清空佇列，避免使用者不小心重複分析同一批
    diffQueue = [];
    renderDiffQueueList();

    submitBtn.disabled = true; // 佇列已清空，維持停用狀態，直到使用者再加入新的一組
    loadingEl.classList.remove("show");
}

// 把「呼叫卓編分析一組前後對照」抽出成共用函式，單篇分析與批次分析都呼叫這個
async function analyzeDiffPair(beforeText, afterText) {
    const systemPrompt = `你是「卓師姊」的助理，任務是比對同一篇文章「潤稿前」與「潤稿後」的差異，從中歸納出卓師姊慣用的修改習慣，整理成日後可以重複套用的規則。

【任務】
1. 仔細比對兩份文字的差異（用詞替換、句式調整、固定用語、格式習慣等）。
2. 只萃取「有規律、值得日後重複套用」的修改模式，例如：
   - 特定詞彙固定替換為另一個詞（例如某個字詞卓師姊一律改成另一種說法）
   - 特定人物、頭銜、機構名稱的固定寫法
   - 一致的格式或標點習慣
3. 忽略以下這類差異，不要產生規則：
   - 單純因為上下文不同而產生的一次性調整（沒有重複性、無法歸納成通則）
   - 單純的錯字修正但只出現一次、看不出是否為固定規則
   - 單純的字數增刪、段落順序調整
4. 如果比對後找不到任何有規律的修改模式，回傳空陣列，不要為了湊數而勉強生成規則。
5. 每一則規則的文字敘述，請比照「大神的便條紙」現有規則的口吻與精簡度撰寫，例如：「聖嚴師父的說法固定用「開示」，不可用「示導」或其他說法」。

【輸出格式規定，請務必嚴格遵守】
只能輸出一個 JSON 陣列，不要有任何其他文字、說明、前言或 Markdown 符號（不要用 \`\`\`json 包起來）。格式如下：
[
  { "content": "規則文字敘述" },
  { "content": "規則文字敘述" }
]
如果沒有可歸納的規則，請輸出：[]`;

    const userPrompt = `【潤稿前（初稿原文）】
${beforeText}

【潤稿後（卓師姊定稿）】
${afterText}`;

    const result = await askZhuo({ systemPrompt, userPrompt, temperature: 0.3 });
    return parseDiffAnalysisResult(result);
}

async function handleAnalyzeDiff() {
    const beforeText = document.getElementById("diff-before").value.trim();
    const afterText = document.getElementById("diff-after").value.trim();
    const errorEl = document.getElementById("diff-error");
    const summaryEl = document.getElementById("diff-result-summary");
    errorEl.classList.remove("show");
    summaryEl.innerHTML = "";
    summaryEl.className = "";

    if (!beforeText || !afterText) {
        errorEl.textContent = "請同時貼上（或匯入）「潤稿前」與「潤稿後」兩份文字，才能進行比對。";
        errorEl.classList.add("show");
        return;
    }

    const submitBtn = document.getElementById("diff-submit");
    const loadingEl = document.getElementById("diff-loading");

    submitBtn.disabled = true;
    loadingEl.classList.add("show");

    try {
        const extractedRules = await analyzeDiffPair(beforeText, afterText);

        if (extractedRules.length === 0) {
            summaryEl.className = "diff-result-summary";
            summaryEl.textContent = "這次比對沒有找到明顯、可重複套用的修改模式，因此沒有新增任何規則。";
            return;
        }

        // 與現有規則做「內容完全相同」的重複比對，跳過重複的，只新增沒看過的規則
        const existingContents = new Set(rulesCache.map((r) => r.content.trim()));
        const toCreate = [];
        const skipped = [];

        extractedRules.forEach((r) => {
            const content = (r.content || "").trim();
            if (!content) return;
            if (existingContents.has(content)) {
                skipped.push(content);
            } else {
                toCreate.push({ content });
                existingContents.add(content); // 避免這次分析結果內部自己重複
            }
        });

        const created = [];
        const failed = [];
        for (const r of toCreate) {
            try {
                // 分類固定標記為「自動歸納」，方便日後跟人工新增的規則做區分
                const rule = await createRuleOnServer(r.content, "自動歸納");
                created.push(rule);
            } catch (err) {
                failed.push(r.content);
            }
        }

        renderRulesList();

        let summaryHtml = `本次分析共找到 ${extractedRules.length} 條修改模式：<br>`;
        summaryHtml += `<strong>新增 ${created.length} 條</strong>（已標記為「自動歸納」分類）`;
        if (skipped.length > 0) {
            summaryHtml += `，<strong>略過 ${skipped.length} 條重複規則</strong>（便條紙裡已經有一模一樣的內容）`;
        }
        if (failed.length > 0) {
            summaryHtml += `，<strong style="color:var(--danger);">${failed.length} 條寫入失敗</strong>`;
        }
        summaryHtml += "。";

        if (created.length > 0) {
            summaryHtml += `<ul style="margin-top:8px; padding-left:20px;">`;
            created.forEach((rule) => {
                summaryHtml += `<li>${escapeHtml(rule.content)}</li>`;
            });
            summaryHtml += `</ul>`;
        }

        summaryEl.className = failed.length > 0 ? "diff-result-summary error" : "diff-result-summary success";
        summaryEl.innerHTML = summaryHtml;
    } catch (err) {
        errorEl.textContent = `分析失敗：${err.message}`;
        errorEl.classList.add("show");
    } finally {
        submitBtn.disabled = false;
        loadingEl.classList.remove("show");
    }
}

// 解析卓編回傳的 JSON 規則陣列文字，容錯處理（去除可能的 ```json 包裹、多餘文字）
function parseDiffAnalysisResult(rawText) {
    let text = (rawText || "").trim();

    // 容錯：即使指示不要用 Markdown 包裹，仍去除可能出現的 ```json ... ``` 包裹
    const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch) {
        text = fencedMatch[1].trim();
    }

    // 容錯：只取第一個 [ 到最後一個 ] 之間的內容，避免前後有額外說明文字
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start !== -1 && end !== -1 && end > start) {
        text = text.slice(start, end + 1);
    }

    try {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((r) => r && typeof r.content === "string" && r.content.trim());
    } catch (err) {
        throw new Error("卓編回傳的格式無法解析，請再試一次");
    }
}

async function handleToggleRule(id, isActive) {
    const rule = rulesCache.find((r) => r.id === id);
    if (rule) rule.is_active = isActive;
    renderRulesList();

    if (DEMO_MODE) return;

    try {
        await fetch(`${WORKER_BASE_URL}/api/rules/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ is_active: isActive }),
        });
    } catch (err) {
        // 失敗時靜默處理，下次載入頁面會自動回復真實狀態
    }
}

async function handleDeleteRule(id) {
    if (!confirm("確定要刪除這則叮嚀事項嗎？")) return;

    rulesCache = rulesCache.filter((r) => r.id !== id);
    renderRulesList();

    if (DEMO_MODE) return;

    try {
        await fetch(`${WORKER_BASE_URL}/api/rules/${id}`, { method: "DELETE" });
    } catch (err) {
        // 失敗時靜默處理
    }
}

// ================= 初始化 =================
document.addEventListener("DOMContentLoaded", () => {
    injectStaticIcons();
    updateNavActiveState("home");

    if (DEMO_MODE) {
        const el = document.getElementById("connectionStatus");
        const tooltip = document.getElementById("connectionStatusTooltip");
        const text = "示範模式（尚未串接 Worker）";
        el.title = text;
        if (tooltip) tooltip.textContent = text;
        el.classList.remove("offline");
        el.classList.add("demo");
    }
});
