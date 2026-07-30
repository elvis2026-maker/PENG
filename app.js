/**
 * 卓編數位書房 V2 - 前端邏輯
 * ------------------------------------------------
 * 請先依照 SETUP.md 完成 Cloudflare Worker 部署，
 * 並把下方 WORKER_BASE_URL 換成你自己的 Worker 網址。
 * ------------------------------------------------
 */

// ⚠️ 請將此網址換成你部署好的 Cloudflare Worker 網址（見 SETUP.md）
const WORKER_BASE_URL = "https://zhuo-editor-proxy.YOUR-SUBDOMAIN.workers.dev";

// 若尚未設定 Worker 網址，系統會使用「示範模式」，以假資料模擬 AI 回覆，
// 方便你在正式串接前先體驗完整互動流程。
const DEMO_MODE = WORKER_BASE_URL.includes("YOUR-SUBDOMAIN");

// 全域狀態
let rulesCache = [];
let currentInterviewTitles = [];

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

function setConnectionStatus(online) {
    const el = document.getElementById("connectionStatus");
    if (online) {
        el.textContent = "知識庫已連線";
        el.classList.remove("offline");
    } else {
        el.textContent = "知識庫連線異常";
        el.classList.add("offline");
    }
}

// 把目前啟用中的規則組成一段文字，安插進送給 AI 的 System Prompt
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

// ================= 呼叫 Worker（AI 生成）統一入口 =================
async function callAI({ systemPrompt, userPrompt, temperature = 0.7 }) {
    if (DEMO_MODE) {
        await sleep(1200);
        return demoAIResponse(userPrompt);
    }

    const resp = await fetch(`${WORKER_BASE_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systemPrompt, userPrompt, temperature }),
    });

    const data = await resp.json();
    if (!resp.ok) {
        throw new Error(data.error || "AI 服務發生未知錯誤");
    }
    return data.text;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// 示範模式：假回覆（尚未設定 Worker 網址時，用來體驗完整互動流程）
function demoAIResponse(userPrompt) {
    return `【示範模式輸出】

目前尚未串接真實的 Cloudflare Worker 網址，這是模擬的卓編潤稿結果，方便您預覽介面互動流程。

實際串接後，這裡會顯示 AI 根據您輸入的初稿，依照法鼓禪風、動態套用「大神的便條紙」規則所產出的正式潤稿內容。

請參考 SETUP.md 完成 Worker 部署，並將 app.js 最上方的 WORKER_BASE_URL 換成您實際的網址，即可切換為正式運作模式。`;
}

PLACEHOLDER_REPORT_SECTION
function copyToClipboard(text, btnEl) {
    navigator.clipboard.writeText(text).then(() => {
        const original = btnEl.textContent;
        btnEl.textContent = "已複製 ✓";
        setTimeout(() => {
            btnEl.textContent = original;
        }, 1500);
    });
}

// ================= 功能一：活動報導 潤稿 =================
function renderReportPage(container) {
    container.dataset.rendered = "1";
    container.innerHTML = `
        <div class="back-link" onclick="showPage('home')">
            <span class="material-symbols-outlined" style="font-size:18px;">arrow_back</span>
            返回首頁
        </div>

        <div class="page-header">
            <div class="icon-box color-green"><span class="material-symbols-outlined">article</span></div>
            <div>
                <h2>活動報導 潤飾</h2>
                <p>梳理人事時地物，去除贅字，並自動加上提綱挈領的小標題</p>
            </div>
        </div>

        <div class="panel">
            <div class="form-group">
                <label for="report-draft">貼上活動報導初稿</label>
                <textarea id="report-draft" placeholder="請貼上寫手提交的初稿全文……"></textarea>
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

            <div class="btn-row">
                <button class="btn btn-primary" id="report-submit" onclick="handleReportSubmit()">
                    <span class="material-symbols-outlined" style="font-size:18px;">auto_awesome</span>
                    請卓編過目
                </button>
                <div class="loading-indicator" id="report-loading">
                    <div class="spinner"></div>
                    卓編正在潤稿中，請稍候……
                </div>
            </div>
            <div class="error-msg" id="report-error"></div>
        </div>

        <div class="panel result-panel" id="report-result-panel">
            <h4><span class="material-symbols-outlined" style="font-size:18px;">task_alt</span>潤稿結果</h4>
            <div class="result-box" id="report-result-box"></div>
            <div class="btn-row" style="margin-top:16px;">
                <button class="btn btn-secondary copy-btn" onclick="copyToClipboard(document.getElementById('report-result-box').textContent, this)">複製全文</button>
            </div>
        </div>
    `;
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
    const submitBtn = document.getElementById("report-submit");
    const loadingEl = document.getElementById("report-loading");
    const resultPanel = document.getElementById("report-result-panel");

    submitBtn.disabled = true;
    loadingEl.classList.add("show");
    resultPanel.classList.remove("show");

    const systemPrompt = `你是「卓師姊」，法鼓山榮譽董事會的資深編輯，擅長潤飾活動報導文稿，文風溫潤、莊重、貼近法鼓禪風。

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
        const result = await callAI({ systemPrompt, userPrompt: draft, temperature: 0.6 });
        document.getElementById("report-result-box").textContent = result;
        resultPanel.classList.add("show");
        resultPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
            <span class="material-symbols-outlined" style="font-size:18px;">arrow_back</span>
            返回首頁
        </div>

        <div class="page-header">
            <div class="icon-box color-green"><span class="material-symbols-outlined">record_voice_over</span></div>
            <div>
                <h2>人物專訪 潤飾</h2>
                <p>萃取「學佛因緣」與「護法願心」，產出具備禪意的主標題選項</p>
            </div>
        </div>

        <div class="panel">
            <div class="form-group">
                <label for="interview-draft">貼上人物專訪初稿</label>
                <textarea id="interview-draft" placeholder="請貼上訪談逐字稿或初稿內容……"></textarea>
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

            <div class="btn-row">
                <button class="btn btn-primary" id="interview-submit" onclick="handleInterviewSubmit()">
                    <span class="material-symbols-outlined" style="font-size:18px;">auto_awesome</span>
                    請卓編過目
                </button>
                <div class="loading-indicator" id="interview-loading">
                    <div class="spinner"></div>
                    卓編正在提煉稿件中，請稍候……
                </div>
            </div>
            <div class="error-msg" id="interview-error"></div>
        </div>

        <div class="panel result-panel" id="interview-result-panel">
            <h4><span class="material-symbols-outlined" style="font-size:18px;">workspace_premium</span>備選主標題（請點選一則套用）</h4>
            <div class="title-options" id="interview-title-options"></div>

            <h4><span class="material-symbols-outlined" style="font-size:18px;">task_alt</span>潤稿結果</h4>
            <div class="result-box" id="interview-result-box"></div>
            <div class="btn-row" style="margin-top:16px;">
                <button class="btn btn-secondary copy-btn" onclick="copyInterviewFull()">複製標題＋全文</button>
            </div>
        </div>
    `;
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
    const submitBtn = document.getElementById("interview-submit");
    const loadingEl = document.getElementById("interview-loading");
    const resultPanel = document.getElementById("interview-result-panel");

    submitBtn.disabled = true;
    loadingEl.classList.add("show");
    resultPanel.classList.remove("show");

    const systemPrompt = `你是「卓師姊」，法鼓山榮譽董事會的資深編輯，擅長將人物專訪逐字稿或初稿，轉化為平穩且具溫度的正式文稿。

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
        const result = await callAI({ systemPrompt, userPrompt: draft, temperature: 0.75 });
        parseAndRenderInterviewResult(result);
        resultPanel.classList.add("show");
        resultPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
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

    // 若解析失敗（AI 未照格式回覆），則整段當作內文顯示，不顯示標題選項
    currentInterviewTitles = titles;

    const optionsEl = document.getElementById("interview-title-options");
    if (titles.length > 0) {
        optionsEl.innerHTML = titles
            .map(
                (title, idx) => `
            <div class="title-option" id="title-opt-${idx}" onclick="selectInterviewTitle(${idx})">
                <span>${escapeHtml(title)}</span>
                <span class="material-symbols-outlined">check_circle</span>
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
            <span class="material-symbols-outlined" style="font-size:18px;">arrow_back</span>
            返回首頁
        </div>

        <div class="page-header">
            <div class="icon-box color-brown"><span class="material-symbols-outlined">campaign</span></div>
            <div>
                <h2>活動 DM 撰寫</h2>
                <p>套用起承轉合架構與聖嚴師父法語，產出適合排版的宣傳文案</p>
            </div>
        </div>

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
                <textarea id="dm-purpose" style="min-height:100px;" placeholder="例如：感恩榮董菩薩們一年來的護持，邀請所有榮董及其眷屬齊聚，共同回顧僧團弘化足跡……"></textarea>
            </div>

            <div class="form-group">
                <label for="dm-notes">特別注意事項（選填）</label>
                <textarea id="dm-notes" style="min-height:80px;" placeholder="例如：需提及本次活動需事先報名、有素齋供應等……"></textarea>
            </div>

            <div class="btn-row">
                <button class="btn btn-primary" id="dm-submit" onclick="handleDmSubmit()">
                    <span class="material-symbols-outlined" style="font-size:18px;">auto_awesome</span>
                    生成 DM 文案
                </button>
                <div class="loading-indicator" id="dm-loading">
                    <div class="spinner"></div>
                    卓編正在撰寫文案中，請稍候……
                </div>
            </div>
            <div class="error-msg" id="dm-error"></div>
        </div>

        <div class="panel result-panel" id="dm-result-panel">
            <h4><span class="material-symbols-outlined" style="font-size:18px;">task_alt</span>DM 文案</h4>
            <div class="result-box" id="dm-result-box"></div>
            <div class="btn-row" style="margin-top:16px;">
                <button class="btn btn-secondary copy-btn" onclick="copyToClipboard(document.getElementById('dm-result-box').textContent, this)">複製全文</button>
            </div>
        </div>
    `;
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
        const result = await callAI({ systemPrompt, userPrompt, temperature: 0.8 });
        document.getElementById("dm-result-box").textContent = result;
        resultPanel.classList.add("show");
        resultPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
            <span class="material-symbols-outlined" style="font-size:18px;">arrow_back</span>
            返回首頁
        </div>

        <div class="page-header">
            <div class="icon-box color-brown"><span class="material-symbols-outlined">edit_note</span></div>
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
                    </select>
                </div>
                <button class="btn btn-primary" onclick="handleAddRule()">
                    <span class="material-symbols-outlined" style="font-size:18px;">add</span>
                    新增
                </button>
            </div>

            <div class="error-msg" id="rules-error"></div>
            <div class="rule-list" id="rules-list">
                <div class="empty-state">載入中……</div>
            </div>
        </div>
    `;
}

function renderRulesList() {
    const listEl = document.getElementById("rules-list");
    if (!listEl) return;

    if (rulesCache.length === 0) {
        listEl.innerHTML = `<div class="empty-state">目前還沒有任何叮嚀事項，請於上方新增。</div>`;
        return;
    }

    const categoryTagClass = {
        "詞彙提醒": "tag-vocab",
        "當期主題": "tag-theme",
        "排版規定": "tag-format",
    };

    listEl.innerHTML = rulesCache
        .map((rule) => {
            const tagClass = categoryTagClass[rule.category] || "tag-vocab";
            return `
            <div class="rule-item ${rule.is_active ? "" : "inactive"}" data-id="${rule.id}">
                <label class="toggle-switch" title="啟用／停用">
                    <input type="checkbox" ${rule.is_active ? "checked" : ""} onchange="handleToggleRule('${rule.id}', this.checked)">
                    <span class="toggle-slider"></span>
                </label>
                <div class="rule-main">
                    <span class="rule-tag ${tagClass}">${escapeHtml(rule.category)}</span>
                    <div class="rule-content">${escapeHtml(rule.content)}</div>
                </div>
                <div class="rule-actions">
                    <button class="btn btn-danger-outline" onclick="handleDeleteRule('${rule.id}')">刪除</button>
                </div>
            </div>`;
        })
        .join("");
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

    if (DEMO_MODE) {
        rulesCache.push({
            id: `demo-${Date.now()}`,
            content,
            category,
            is_active: true,
            created_at: new Date().toISOString(),
        });
        contentInput.value = "";
        renderRulesList();
        return;
    }

    try {
        const resp = await fetch(`${WORKER_BASE_URL}/api/rules`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content, category, is_active: true }),
        });
        if (!resp.ok) throw new Error("新增失敗");
        const data = await resp.json();
        rulesCache.push(data.rule);
        contentInput.value = "";
        renderRulesList();
    } catch (err) {
        errorEl.textContent = `新增失敗：${err.message}`;
        errorEl.classList.add("show");
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
    if (DEMO_MODE) {
        setConnectionStatus(false);
        document.getElementById("connectionStatus").textContent = "示範模式（尚未串接 Worker）";
    }
});
