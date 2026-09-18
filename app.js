// ===== 設定 =====
// API Key 不寫在程式碼裡：這個專案會以純靜態網站部署（GitHub Pages），
// 任何寫進原始碼的 key 都等同公開。改由使用者在頁面上貼上，只存在自己瀏覽器的 localStorage。
const API_KEY_STORAGE_KEY = "jst_api_key_v1";
const GEMINI_MODEL = "gemini-3.6-flash";
const geminiEndpoint = () =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;

let geminiApiKey = "";
try {
  geminiApiKey = localStorage.getItem(API_KEY_STORAGE_KEY) || "";
} catch (_error) {
  // 無痕模式等情況讀不到 localStorage，當作沒設定過，使用者貼一次就能用（只是關掉就沒了）
}

const LOOKAHEAD_SIZE = 10; // 點某一句時，連同後面尚未解說的句子一起打包成「一次」請求的上限
const BATCH_DELAY_MS = 1500; // 連續排隊的請求之間的間隔（第一個請求不套用，不然點一下要乾等 1.5 秒）
const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];
const MAX_AUTO_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 5000; // 500/502/503/504 的遞增延遲：5s, 10s, 15s, 20s
const GLOBAL_COOLDOWN_MS = 30000; // 撞到 429 時，找不到伺服器建議的等待秒數時的預設全域冷卻時間
const SOFT_RPD_LIMIT = 180; // 今日請求數超過這個值就先跳確認視窗。Gemini 免費層的 RPD 沒有可靠的公開數字，自行調整

const RESULT_CACHE_KEY = "jst_result_cache_v1"; // 全域快取（不分檔案）：句子文字 → 結果
const USAGE_KEY = "jst_usage_v1";
const IDB_NAME = "jst-app-db";
const IDB_STORE = "handles";
const IDB_HANDLE_KEY = "cacheFileHandle"; // 舊版（§11）的單一快取檔，現在只用來做一次性匯入
const IDB_WORKDIR_KEY = "workDirHandle";

const GLOBAL_CACHE_FILENAME = "_jst-global-cache.json";
const NOTES_SUFFIX = ".notes.json";
const NOTES_KIND = "jst-notes";
const NOTES_VERSION = 1;
const SUBTITLE_EXT_RE = /\.(srt|vtt|ass|ssa|sbv|txt)$/i;

// 全域冷卻時間戳記：一旦有任何請求撞到 429（速率/額度限制），就會設定這個時間點，
// 讓後續所有請求在送出前都先等到這個時間點，而不是繼續往下猛打。
let globalCooldownUntil = 0;

// ===== DOM =====
const apiKeyInput = document.getElementById("apiKeyInput");
const apiKeySaveBtn = document.getElementById("apiKeySaveBtn");
const apiKeyToggleBtn = document.getElementById("apiKeyToggleBtn");
const apiKeyClearBtn = document.getElementById("apiKeyClearBtn");
const apiKeyStatus = document.getElementById("apiKeyStatus");

const workspacePanel = document.getElementById("workspacePanel");
const workspaceStatusText = document.getElementById("workspaceStatusText");
const pickDirBtn = document.getElementById("pickDirBtn");
const grantDirBtn = document.getElementById("grantDirBtn");
const rescanBtn = document.getElementById("rescanBtn");
const legacyUploadRow = document.getElementById("legacyUploadRow");
const fileInput = document.getElementById("fileInput");
const fileNameDisplay = document.getElementById("fileNameDisplay");
const fileListEl = document.getElementById("fileList");

const subtitlePanel = document.getElementById("subtitlePanel");
const currentFileTitle = document.getElementById("currentFileTitle");
const notesBanner = document.getElementById("notesBanner");
const notesBannerText = document.getElementById("notesBannerText");
const notesRebuildBtn = document.getElementById("notesRebuildBtn");
const progressText = document.getElementById("progressText");
const usageText = document.getElementById("usageText");
const downloadPdfBtn = document.getElementById("downloadPdfBtn");
const openImportDialogBtn = document.getElementById("openImportDialogBtn");
const closeFileBtn = document.getElementById("closeFileBtn");
const simplifiedOutput = document.getElementById("simplifiedOutput");
const copySimplifiedBtn = document.getElementById("copySimplifiedBtn");
const clearCacheBtn = document.getElementById("clearCacheBtn");
const importLegacyCacheBtn = document.getElementById("importLegacyCacheBtn");
const downloadNotesBtn = document.getElementById("downloadNotesBtn");
const statusText = document.getElementById("statusText");
const lineListEl = document.getElementById("lineList");
const printArea = document.getElementById("printArea");

const errorPanel = document.getElementById("errorPanel");
const errorPanelTime = document.getElementById("errorPanelTime");
const errorPanelMessage = document.getElementById("errorPanelMessage");
const errorPanelCountdown = document.getElementById("errorPanelCountdown");
const errorPanelClose = document.getElementById("errorPanelClose");

const noteDialog = document.getElementById("noteDialog");
const noteSeq = document.getElementById("noteSeq");
const noteOriginal = document.getElementById("noteOriginal");
const noteCountdown = document.getElementById("noteCountdown");
const noteBody = document.getElementById("noteBody");
const noteCloseBtn = document.getElementById("noteCloseBtn");
const notePrevBtn = document.getElementById("notePrevBtn");
const noteNextBtn = document.getElementById("noteNextBtn");
const noteReanalyzeBtn = document.getElementById("noteReanalyzeBtn");

const importDialog = document.getElementById("importDialog");
const importExpectedCount = document.getElementById("importExpectedCount");
const importTextarea = document.getElementById("importTextarea");
const importErrorText = document.getElementById("importErrorText");
const importConfirmBtn = document.getElementById("importConfirmBtn");
const importCancelBtn = document.getElementById("importCancelBtn");

// ===== 狀態 =====
let workDirHandle = null;
let workspaceState = "no-dir"; // unsupported | no-dir | needs-grant | ready
let subtitleFiles = []; // { name, handle }

let currentFileName = "";
let currentSubtitles = []; // { order, text }[]
let notes = null; // notes 檔內容（記憶體版）
let notesWriteBlocked = false;
let notesRawBackup = ""; // 毀損時原始文字，給「備份並重建」用
let lineState = []; // index = order - 1: idle | pending | done | error | skipped

const requestByOrder = new Map(); // order -> { orders, promise }
let apiQueue = Promise.resolve();
let lastApiFinishedAt = 0;

let dialogToken = 0;
let dialogOrder = 0;

let useStructuredOutput = true; // 收到 400 且訊息指向新欄位時會翻成 false（見 callGeminiBatch）

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===== 錯誤面板與 429 倒數 =====
function showErrorPanel(message) {
  errorPanelTime.textContent = new Date().toLocaleTimeString("zh-TW", { hour12: false });
  errorPanelMessage.textContent = message;
  errorPanel.hidden = false;
}

errorPanelClose.addEventListener("click", () => {
  errorPanel.hidden = true;
});

// 請求成功之後要把錯誤欄收掉，否則上一次的 429／重試訊息會一直掛在畫面上，
// 讓人以為現在還是壞的。冷卻倒數只有在真的已經結束時才清。
function clearErrorPanel() {
  errorPanel.hidden = true;
  errorPanelMessage.textContent = "";
  errorPanelTime.textContent = "";
  if (globalCooldownUntil <= Date.now()) {
    errorPanelCountdown.textContent = "";
    noteCountdown.textContent = "";
    if (cooldownIntervalId) {
      clearInterval(cooldownIntervalId);
      cooldownIntervalId = null;
    }
  }
}

// 429 冷卻倒數：即時顯示「距離解除限制還有幾秒」，每秒更新一次。
// 同時鏡射到彈窗裡（使用者的眼睛在彈窗上，不是在角落的錯誤欄）。
let cooldownIntervalId = null;

function tickCooldownCountdown() {
  const remainingMs = globalCooldownUntil - Date.now();
  if (remainingMs <= 0) {
    errorPanelCountdown.textContent = "";
    noteCountdown.textContent = "";
    if (cooldownIntervalId) {
      clearInterval(cooldownIntervalId);
      cooldownIntervalId = null;
    }
    return;
  }
  const text = `⏳ 429 速率限制預計還有 ${Math.ceil(remainingMs / 1000)} 秒解除`;
  errorPanelCountdown.textContent = text;
  noteCountdown.textContent = text;
}

function startCooldownCountdown() {
  if (cooldownIntervalId) clearInterval(cooldownIntervalId);
  tickCooldownCountdown();
  cooldownIntervalId = setInterval(tickCooldownCountdown, 1000);
}

// ===== 共用工具：debounce + single-flight 寫檔 =====
// 同一個檔案同時開兩個 createWritable() 在 Chrome 會丟 NoModificationAllowedError，
// 所以 single-flight 不是優化而是必要條件。
function createFileWriter({ getHandle, getContent, debounceMs = 1500, maxWaitMs = 10000, label = "檔案" }) {
  let timer = null;
  let firstRequestAt = 0;
  let inFlight = null;
  let queued = false;

  async function writeNow() {
    if (inFlight) {
      queued = true;
      return inFlight;
    }
    const handle = await getHandle();
    if (!handle) return;
    inFlight = (async () => {
      try {
        const writable = await handle.createWritable();
        await writable.write(getContent());
        await writable.close();
      } catch (error) {
        console.error(`寫入${label}失敗`, error);
      }
    })();
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
    if (queued) {
      queued = false;
      await writeNow();
    }
  }

  return {
    schedule() {
      const now = Date.now();
      if (!firstRequestAt) firstRequestAt = now;
      if (timer) clearTimeout(timer);
      // hard max-wait：持續有更新時也不會被無限往後推
      const wait = Math.max(0, Math.min(debounceMs, firstRequestAt + maxWaitMs - now));
      timer = setTimeout(() => {
        timer = null;
        firstRequestAt = 0;
        writeNow();
      }, wait);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      firstRequestAt = 0;
      await writeNow();
    },
  };
}

// ===== 純函式工具 =====
const JP_CHAR_RE = /[぀-ゟ゠-ヿ一-鿿]/;
const JP_KANJI_RE = /[㐀-䶿一-鿿々〆]/; // 只比對漢字（含「々」「〆」），用來判斷要不要標假名
const JP_CHAR_GLOBAL_RE = /[぀-ゟ゠-ヿ一-鿿]/g;
const SYMBOL_ONLY_RE = /^[\s♪♬♩♫〜～~\-–—_=+*#@…‥・。、，,.!！?？:：;；'"“”‘’「」『』（）()[\]［］{}【】<>＜＞/\\|0-9０-９]*$/;
const SPEAKER_LABEL_RE = /^[^\s：:]{1,10}[：:]$/;

// 回傳 null 代表值得送去解說；回傳字串代表跳過的理由。
// 這些都是啟發式規則，所以彈窗一定要留「還是分析這句」讓使用者推翻。
function shouldSkipLine(text) {
  const t = (text || "").trim();
  if (!t) return "empty";
  if (SYMBOL_ONLY_RE.test(t)) return "symbol-only";
  if (!JP_CHAR_RE.test(t)) return "non-japanese";
  if (SPEAKER_LABEL_RE.test(t)) return "speaker-label";
  const jpCount = (t.match(JP_CHAR_GLOBAL_RE) || []).length;
  if (jpCount < 3) return "too-short";
  return null;
}

const SKIP_REASON_TEXT = {
  empty: "空白行",
  "symbol-only": "只有符號／音效",
  "non-japanese": "沒有日文字",
  "speaker-label": "說話者標籤",
  "too-short": "太短（日文字少於 3 個），多半是 N5 基礎內容",
};

// FNV-1a 32bit：只用來偵測字幕檔有沒有被改動，不需要密碼學強度
function hashLines(texts) {
  const str = texts.join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    h = Math.imul(h ^ (code & 0xff), 0x01000193) >>> 0;
    h = Math.imul(h ^ ((code >> 8) & 0xff), 0x01000193) >>> 0;
  }
  return `fnv1a32:${h.toString(16).padStart(8, "0")}`;
}

// Gemini 免費層的 RPD 是在美國太平洋時間午夜重置，所以計數要用太平洋日期當 key
const PACIFIC_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function todayKeyPacific() {
  return PACIFIC_DATE_FMT.format(new Date());
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// ===== 用量計數 =====
const recentRequestTimes = []; // 記憶體內的滾動 RPM

function loadUsage() {
  try {
    const raw = localStorage.getItem(USAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_error) {
    return {};
  }
}

let usage = loadUsage();

function saveUsage() {
  // 只留最近 7 天
  const keys = Object.keys(usage).sort();
  while (keys.length > 7) delete usage[keys.shift()];
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
  } catch (_error) {
    // 忽略
  }
}

function todayUsage() {
  const key = todayKeyPacific();
  if (!usage[key]) usage[key] = { requests: 0, lines: 0, errors429: 0 };
  return usage[key];
}

function recordRequest(lineCount) {
  const today = todayUsage();
  today.requests += 1;
  today.lines += lineCount;
  recentRequestTimes.push(Date.now());
  saveUsage();
  renderUsage();
}

function record429() {
  todayUsage().errors429 += 1;
  saveUsage();
  renderUsage();
}

function currentRpm() {
  const cutoff = Date.now() - 60000;
  while (recentRequestTimes.length && recentRequestTimes[0] < cutoff) recentRequestTimes.shift();
  return recentRequestTimes.length;
}

function renderUsage() {
  const today = todayUsage();
  usageText.textContent = `今日 ${today.requests} 次請求 / ${today.lines} 句（近 60 秒 ${currentRpm()} 次）`;
  usageText.classList.toggle("usage-warn", today.requests >= SOFT_RPD_LIMIT);
  usageText.classList.toggle("usage-danger", today.requests >= SOFT_RPD_LIMIT * 1.2);
}

// 光有計數器是被動的，這個軟性攔截才真的擋得住把當日額度一次燒光
function confirmIfOverQuota(lineCount) {
  const today = todayUsage();
  if (today.requests < SOFT_RPD_LIMIT) return true;
  return confirm(
    `今日已經送出 ${today.requests} 次請求（設定的軟性上限是 ${SOFT_RPD_LIMIT}）。\n` +
      `這次還要再送出 1 次請求（${lineCount} 句）嗎？`
  );
}

// ===== 全域快取（localStorage + 工作資料夾裡的 _jst-global-cache.json）=====
// 不分檔案，同一句日文只要曾經成功解說過就直接沿用，是 notes 檔之外的第二層。
function loadResultCache() {
  try {
    const raw = localStorage.getItem(RESULT_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_error) {
    return {};
  }
}

let resultCache = loadResultCache();

const globalCacheWriter = createFileWriter({
  label: "全域快取檔",
  getHandle: async () => {
    if (!workDirHandle) return null;
    try {
      return await workDirHandle.getFileHandle(GLOBAL_CACHE_FILENAME, { create: true });
    } catch (error) {
      console.error("取得全域快取檔 handle 失敗", error);
      return null;
    }
  },
  getContent: () => JSON.stringify(resultCache),
});

function saveResultCache() {
  try {
    localStorage.setItem(RESULT_CACHE_KEY, JSON.stringify(resultCache));
  } catch (_error) {
    // 儲存空間不足或瀏覽器封鎖 localStorage 時忽略，只是這次不會快取，不影響功能
  }
  globalCacheWriter.schedule();
}

function getCachedResult(text) {
  return resultCache[text] || null;
}

function setCachedResult(text, result) {
  resultCache[text] = result;
  saveResultCache();
}

async function loadGlobalCacheFromDir() {
  if (!workDirHandle) return;
  try {
    const handle = await workDirHandle.getFileHandle(GLOBAL_CACHE_FILENAME);
    const text = await (await handle.getFile()).text();
    if (!text.trim()) return;
    const fileCache = JSON.parse(text);
    if (fileCache && typeof fileCache === "object") {
      resultCache = { ...fileCache, ...resultCache };
      saveResultCache();
    }
  } catch (error) {
    if (error.name !== "NotFoundError") console.error("讀取全域快取檔失敗", error);
  }
}

// ===== IndexedDB（只存 handle，handle 無法序列化成 JSON）=====
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 瀏覽器規定 requestPermission() 只能在使用者手勢（點擊）裡呼叫，
// 頁面載入時只能被動 queryPermission()。目錄 handle 與檔案 handle 共用同一組 API。
async function verifyHandlePermission(handle, requestIfNeeded) {
  const options = { mode: "readwrite" };
  try {
    if ((await handle.queryPermission(options)) === "granted") return true;
    if (requestIfNeeded && (await handle.requestPermission(options)) === "granted") return true;
  } catch (error) {
    console.error("檢查檔案權限失敗", error);
  }
  return false;
}

// ===== 工作資料夾 =====
function setWorkspaceState(state, message) {
  workspaceState = state;
  workspaceStatusText.textContent = message;
  pickDirBtn.hidden = state !== "no-dir" && state !== "ready";
  pickDirBtn.textContent = state === "ready" ? "更換工作資料夾" : "選擇工作資料夾";
  grantDirBtn.hidden = state !== "needs-grant";
  rescanBtn.hidden = state !== "ready";
  legacyUploadRow.hidden = state !== "unsupported";
  downloadNotesBtn.hidden = state !== "unsupported";
  if (state !== "ready") fileListEl.replaceChildren();
}

async function initWorkspace() {
  // 註：file:// 直接雙擊開啟是可以用的（已實測 Chrome：showDirectoryPicker 正常開啟對話框、
  // localStorage / IndexedDB 跨重新載入都保存得住），所以這裡不擋 file://。詳見 DESIGN.md §14。
  if (!("showDirectoryPicker" in window)) {
    setWorkspaceState(
      "unsupported",
      "這個瀏覽器不支援選擇工作資料夾（只有 Chrome / Edge 支援）。可以改用下面的「選擇字幕檔」，但解說只會存在瀏覽器裡，請自行用「下載 notes JSON」保存。"
    );
    return;
  }

  try {
    const stored = await idbGet(IDB_WORKDIR_KEY);
    if (stored) {
      workDirHandle = stored;
      if (await verifyHandlePermission(stored, false)) {
        await onWorkDirReady();
        return;
      }
      setWorkspaceState("needs-grant", `之前選過的資料夾：${stored.name}（瀏覽器重啟後授權會被收回，按一下就好）`);
      return;
    }
  } catch (_error) {
    // IndexedDB 不可用時退回「還沒選資料夾」
  }
  setWorkspaceState("no-dir", "還沒選擇工作資料夾。");
}

async function pickWorkDir() {
  try {
    const handle = await window.showDirectoryPicker({
      mode: "readwrite",
      id: "jst-workdir",
      startIn: "documents",
    });
    workDirHandle = handle;
    await idbSet(IDB_WORKDIR_KEY, handle);
    await onWorkDirReady();
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error("選擇工作資料夾失敗", error);
      setWorkspaceState("no-dir", `選擇資料夾失敗：${error.message}`);
    }
  }
}

async function onWorkDirReady() {
  setWorkspaceState("ready", `工作資料夾：${workDirHandle.name}`);
  await loadGlobalCacheFromDir();
  await importLegacyCacheIfGranted();
  await scanWorkDir();
}

async function scanWorkDir() {
  if (!workDirHandle) return;
  const files = [];
  try {
    for await (const entry of workDirHandle.values()) {
      if (entry.kind !== "file") continue;
      if (entry.name.endsWith(NOTES_SUFFIX)) continue;
      if (entry.name === GLOBAL_CACHE_FILENAME) continue;
      if (!SUBTITLE_EXT_RE.test(entry.name)) continue;
      files.push({ name: entry.name, handle: entry });
    }
  } catch (error) {
    // 授權被收回時會在這裡冒出 NotAllowedError，要翻成「需要重新授權」而不是丟進 console 就算了
    console.error("掃描資料夾失敗", error);
    setWorkspaceState("needs-grant", `讀取資料夾失敗（${error.name}），請重新授權：${workDirHandle.name}`);
    return;
  }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  subtitleFiles = files;
  renderFileList();
  loadFileListProgress(); // 背景補上「已分析 N/M」，不擋渲染
}

function renderFileList() {
  fileListEl.replaceChildren();
  if (subtitleFiles.length === 0) {
    const li = document.createElement("li");
    li.className = "file-row-empty";
    li.textContent = "這個資料夾裡沒有字幕檔（.srt / .vtt / .ass / .ssa / .sbv / .txt）。";
    fileListEl.appendChild(li);
    return;
  }
  subtitleFiles.forEach((file) => {
    const li = document.createElement("li");
    li.className = "file-row";
    li.dataset.name = file.name;
    li.innerHTML = `<span class="file-row-name">${escapeHtml(file.name)}</span><span class="file-row-progress"></span>`;
    li.addEventListener("click", () => openSubtitleFile(file));
    fileListEl.appendChild(li);
  });
}

async function loadFileListProgress() {
  for (const file of subtitleFiles) {
    try {
      const handle = await workDirHandle.getFileHandle(file.name + NOTES_SUFFIX);
      const parsed = JSON.parse(await (await handle.getFile()).text());
      const items = parsed?.items || {};
      const done = Object.values(items).filter((it) => it?.status === "done").length;
      const total = parsed?.sourceLineCount ?? Object.keys(items).length;
      const row = fileListEl.querySelector(`[data-name="${CSS.escape(file.name)}"] .file-row-progress`);
      if (row) row.textContent = `已解說 ${done}/${total}`;
    } catch (_error) {
      // 沒有 notes 檔或內容壞掉，就不顯示進度，不是錯誤
    }
  }
}

// ===== notes 檔（每個字幕檔一份）=====
function emptyNotes(fileName, subtitles) {
  return {
    kind: NOTES_KIND,
    version: NOTES_VERSION,
    sourceFile: fileName,
    sourceHash: hashLines(subtitles.map((s) => s.text)),
    sourceLineCount: subtitles.length,
    model: GEMINI_MODEL,
    updatedAt: new Date().toISOString(),
    items: {},
  };
}

const notesWriter = createFileWriter({
  label: "notes 檔",
  getHandle: async () => {
    if (!workDirHandle || !currentFileName || notesWriteBlocked) return null;
    try {
      return await workDirHandle.getFileHandle(currentFileName + NOTES_SUFFIX, { create: true });
    } catch (error) {
      console.error("取得 notes 檔 handle 失敗", error);
      return null;
    }
  },
  getContent: () => {
    notes.updatedAt = new Date().toISOString();
    return JSON.stringify(notes, null, 2);
  },
});

function markNotesDirty() {
  notesWriter.schedule();
}

// API 花錢換來的資料，回應一到就立刻寫，不走 debounce
function flushNotes() {
  return notesWriter.flush();
}

function showNotesBanner(message) {
  notesBannerText.textContent = message;
  notesBanner.hidden = false;
}

// 整檔偏執、單筆寬容：解析不出來的整份檔案絕不覆寫，單一格式不對的 item 才丟掉
async function loadNotes(fileName, subtitles) {
  notesWriteBlocked = false;
  notesRawBackup = "";
  notesBanner.hidden = true;

  const fresh = emptyNotes(fileName, subtitles);
  if (!workDirHandle) return fresh;

  let raw = "";
  try {
    const handle = await workDirHandle.getFileHandle(fileName + NOTES_SUFFIX);
    raw = await (await handle.getFile()).text();
  } catch (error) {
    if (error.name !== "NotFoundError") console.error("讀取 notes 檔失敗", error);
    return fresh;
  }
  if (!raw.trim()) return fresh;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_error) {
    parsed = null;
  }

  const unusable =
    !parsed ||
    typeof parsed !== "object" ||
    parsed.kind !== NOTES_KIND ||
    !parsed.items ||
    typeof parsed.items !== "object" ||
    Array.isArray(parsed.items) ||
    Number(parsed.version) > NOTES_VERSION;

  if (unusable) {
    notesWriteBlocked = true;
    notesRawBackup = raw;
    showNotesBanner(
      `${fileName}${NOTES_SUFFIX} 讀不出來（格式不符或版本較新）。為了避免覆蓋你的資料，這次不會寫入任何解說紀錄。`
    );
    return fresh;
  }

  // 單筆過濾
  const clean = {};
  for (const [key, item] of Object.entries(parsed.items)) {
    if (!item || typeof item !== "object") continue;
    if (item.status === "done" && typeof item.result?.translation !== "string") continue;
    if (item.status !== "done" && item.status !== "skipped") continue;
    clean[key] = item;
  }

  const currentHash = hashLines(subtitles.map((s) => s.text));
  const hashMatches = parsed.sourceHash === currentHash && parsed.sourceLineCount === subtitles.length;

  if (hashMatches) {
    fresh.items = clean;
    return fresh;
  }

  // 字幕檔被改過（重新調軸、增刪句子）。不要丟棄 notes——
  // 改用文字精確比對重新掛回正確的 order，再用新的 hash 覆寫。
  const byText = new Map();
  for (const item of Object.values(clean)) {
    if (item.status === "done" && typeof item.text === "string" && !byText.has(item.text)) {
      byText.set(item.text, item);
    }
  }
  let reattached = 0;
  subtitles.forEach((sub) => {
    const item = byText.get(sub.text);
    if (item) {
      fresh.items[String(sub.order)] = { ...item, text: sub.text };
      reattached += 1;
    }
  });
  showNotesBanner(
    `字幕檔內容跟上次不一樣（可能重新調軸或增刪過句子）。已用句子原文重新對應回 ${reattached} 句解說。`
  );
  markNotesDirty();
  return fresh;
}

notesRebuildBtn.addEventListener("click", async () => {
  if (!notesWriteBlocked || !workDirHandle) return;
  const backupName = `${currentFileName}.notes.corrupt-${Date.now()}.json`;
  try {
    const handle = await workDirHandle.getFileHandle(backupName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(notesRawBackup);
    await writable.close();
    notesWriteBlocked = false;
    notesBanner.hidden = true;
    statusText.textContent = `原始內容已備份成 ${backupName}，現在可以正常寫入解說紀錄了。`;
    markNotesDirty();
  } catch (error) {
    showNotesBanner(`備份失敗：${error.message}`);
  }
});

// ===== 字幕解析（支援多種格式，只取文字內容，不保留時間軸，順序以出現先後為準）=====
function stripTags(text) {
  return text.replace(/<[^>]+>/g, "").replace(/\{[^}]*\}/g, "").trim();
}

function parseSRT(text) {
  const blocks = text.split(/\n\s*\n/);
  const lines = [];
  for (const block of blocks) {
    const blockLines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (blockLines.length === 0) continue;

    let idx = 0;
    if (/^\d+$/.test(blockLines[0])) idx = 1;

    const timeLine = blockLines[idx];
    if (!timeLine || !/-->/.test(timeLine)) continue;

    const textLines = blockLines.slice(idx + 1);
    const fullText = stripTags(textLines.join(" "));
    if (fullText) lines.push(fullText);
  }
  return lines;
}

function parseVTT(text) {
  const withoutHeader = text.replace(/^WEBVTT[^\n]*\n?/i, "");
  const blocks = withoutHeader.split(/\n\s*\n/);
  const lines = [];
  for (const block of blocks) {
    const blockLines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (blockLines.length === 0) continue;
    if (/^NOTE/i.test(blockLines[0]) || /^STYLE/i.test(blockLines[0]) || /^REGION/i.test(blockLines[0])) continue;

    let idx = 0;
    if (!/-->/.test(blockLines[0])) idx = 1; // 第一行可能是 cue identifier

    const timeLine = blockLines[idx];
    if (!timeLine || !/-->/.test(timeLine)) continue;

    const textLines = blockLines.slice(idx + 1);
    const fullText = stripTags(textLines.join(" "));
    if (fullText) lines.push(fullText);
  }
  return lines;
}

function parseASS(text) {
  const rawLines = text.split(/\r?\n/);
  const lines = [];
  let textFieldIndex = 9; // 標準 ASS/SSA 的 Dialogue 欄位中，Text 是第 10 個欄位（index 9）

  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (/^Format:/i.test(line)) {
      const fields = line.slice(line.indexOf(":") + 1).split(",").map((f) => f.trim());
      const foundIndex = fields.findIndex((f) => /^text$/i.test(f));
      if (foundIndex !== -1) textFieldIndex = foundIndex;
      continue;
    }
    if (/^Dialogue:/i.test(line)) {
      const content = line.slice(line.indexOf(":") + 1);
      const parts = content.split(",");
      const dialogueText = parts.slice(textFieldIndex).join(",");
      const cleaned = dialogueText
        .replace(/\{[^}]*\}/g, "")
        .replace(/\\N|\\n/gi, " ")
        .trim();
      if (cleaned) lines.push(cleaned);
    }
  }
  return lines;
}

function parseSBV(text) {
  const blocks = text.split(/\n\s*\n/);
  const lines = [];
  const timeLinePattern = /^\d+:\d{2}:\d{2}\.\d{3},\d+:\d{2}:\d{2}\.\d{3}$/;

  for (const block of blocks) {
    const blockLines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (blockLines.length === 0) continue;
    if (!timeLinePattern.test(blockLines[0])) continue;

    const textLines = blockLines.slice(1);
    const fullText = stripTags(textLines.join(" "));
    if (fullText) lines.push(fullText);
  }
  return lines;
}

function parsePlainText(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function detectFormat(text, filename) {
  const name = (filename || "").toLowerCase();
  if (name.endsWith(".vtt")) return "vtt";
  if (name.endsWith(".ass") || name.endsWith(".ssa")) return "ass";
  if (name.endsWith(".sbv")) return "sbv";
  if (name.endsWith(".srt")) return "srt";

  if (/^WEBVTT/i.test(text)) return "vtt";
  if (/^\[Script Info\]/im.test(text) || /^Dialogue:/im.test(text)) return "ass";
  if (/^\d+:\d{2}:\d{2}\.\d{3},\d+:\d{2}:\d{2}\.\d{3}/m.test(text)) return "sbv";
  if (/-->/.test(text)) return "srt";
  return "text";
}

function parseSubtitleFile(rawText, filename) {
  const normalized = rawText.replace(/\r\n/g, "\n").replace(/^﻿/, "").trim();
  if (!normalized) return [];

  const format = detectFormat(normalized, filename);
  let lines;
  switch (format) {
    case "vtt":
      lines = parseVTT(normalized);
      break;
    case "ass":
      lines = parseASS(normalized);
      break;
    case "sbv":
      lines = parseSBV(normalized);
      break;
    case "srt":
      lines = parseSRT(normalized);
      break;
    default:
      lines = parsePlainText(normalized);
      break;
  }

  return lines.map((text, i) => ({ order: i + 1, text }));
}

// ===== Gemini 呼叫 =====
// 固定規則搬到 systemInstruction，JSON 結構改用 responseSchema 描述，
// 散文規則因此可以大幅縮短（注意：systemInstruction 一樣會計入 input token，
// 真正省下的是原本那一大段描述 JSON 結構的文字）。
const SYSTEM_RULES = `你是一位專業的日文教師。使用者會給你一個 JSON 陣列，每個元素是 {"id": 句子編號, "text": 日文句子}。
請逐句分析，並針對「每一個 id」回傳一個對應的物件，id 必須原封不動地帶回來。

規則：
- words 與 grammar 只列出「N3（含）以上程度」的單字、動詞與文法點；N5、N4 等初級基礎內容不要列出。整句都只有基礎內容時，words 或 grammar 回傳空陣列。
- word 欄位只放漢字或原形本身，不要把假名寫在裡面；假名一律放 kana。
- note 要寫出詞源、詞性、動詞變化（原形／て形／た形／辭書形等）與語感。
- translation 是該句的中文翻譯。
- 所有說明文字都用繁體中文。

假名標注（很重要）：
- reading 欄位＝把輸入的原句原封不動照抄，但把「每一個含漢字的詞」用 漢字[假名] 的格式標上讀音。
  例如輸入「今日はいい天気ですね。」→ reading 為「今日[きょう]はいい天気[てんき]ですね。」
  假名只標在漢字上，送り仮名不要包進中括號：食べる 要寫成 食[た]べる，不是 食べる[たべる]。
- grammar.point、grammar.example、words[].note 這三個欄位裡，只要出現含漢字的「日文」詞，也要用同樣的 漢字[假名] 格式標注。
- 中文說明文字（translation、meaning、explanation，以及 note 裡的中文部分）**絕對不要**標注，中文漢字不加任何中括號。`;

const WORD_SCHEMA = {
  type: "OBJECT",
  properties: {
    word: { type: "STRING" },
    kana: { type: "STRING" },
    meaning: { type: "STRING" },
    note: { type: "STRING" },
  },
  propertyOrdering: ["word", "kana", "meaning", "note"],
  required: ["word", "kana", "meaning", "note"],
};

const GRAMMAR_SCHEMA = {
  type: "OBJECT",
  properties: {
    point: { type: "STRING" },
    explanation: { type: "STRING" },
    example: { type: "STRING" },
  },
  propertyOrdering: ["point", "explanation", "example"],
  required: ["point", "explanation", "example"],
};

// propertyOrdering 讓 id 最先輸出：模型是左到右生成的，id 在前面的話，
// 就算回應被截斷，前面已經完整的項目仍然救得回來。
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "INTEGER" },
          reading: { type: "STRING" }, // 原句，漢字用 漢字[假名] 標注
          translation: { type: "STRING" },
          words: { type: "ARRAY", items: WORD_SCHEMA },
          grammar: { type: "ARRAY", items: GRAMMAR_SCHEMA },
        },
        propertyOrdering: ["id", "reading", "translation", "words", "grammar"],
        required: ["id", "reading", "translation", "words", "grammar"],
      },
    },
  },
  propertyOrdering: ["items"],
  required: ["items"],
};

// responseSchema 關掉時的退路：把 JSON 結構用文字描述一次
const FALLBACK_SCHEMA_TEXT = `請回傳一個 JSON 物件，結構為 {"items": [...]}，items 的每個元素為：
{
  "id": 對應輸入的句子編號（整數）,
  "reading": "原句照抄，漢字用 漢字[假名] 標注讀音",
  "translation": "中文翻譯",
  "words": [{ "word": "原字", "kana": "假名", "meaning": "中文意思", "note": "詞源/詞性/動詞變化/語感" }],
  "grammar": [{ "point": "文法點", "explanation": "接續與情境說明", "example": "日文例句" }]
}
只能回傳合法 JSON，不可包含 markdown 標籤（例如 \`\`\`json）或任何其他文字。`;

function buildRequestBody(items) {
  const payload = JSON.stringify(items.map((it) => ({ id: it.id, text: it.text })));
  if (useStructuredOutput) {
    return {
      systemInstruction: { parts: [{ text: SYSTEM_RULES }] },
      contents: [{ parts: [{ text: payload }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        thinkingConfig: { thinkingLevel: "low" },
        maxOutputTokens: 8192,
      },
    };
  }
  // 退路：不用 systemInstruction / responseSchema / thinkingConfig，全部塞進 prompt
  return {
    contents: [{ parts: [{ text: `${SYSTEM_RULES}\n\n${FALLBACK_SCHEMA_TEXT}\n\n輸入：\n${payload}` }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
    },
  };
}

function normalizeResult(obj) {
  return {
    reading: typeof obj.reading === "string" ? obj.reading : "",
    translation: obj.translation,
    words: Array.isArray(obj.words) ? obj.words : [],
    grammar: Array.isArray(obj.grammar) ? obj.grammar : [],
  };
}

// 回傳 { results: Map<id, result>, missingIds: number[] }。
// 取代舊版「陣列長度不符就整批丟掉」的做法——部分結果也是花過錢的，一定要留下來。
async function callGeminiBatch(items) {
  const requestedIds = new Set(items.map((it) => it.id));

  let response;
  try {
    response = await fetch(geminiEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildRequestBody(items)),
    });
  } catch (networkError) {
    throw new Error(`網路連線失敗：${networkError.message}`);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    // Google 換過一次模型代號（見 DESIGN.md §3），這些新欄位遲早也會被改名。
    // 收到 400 且訊息指向這些欄位時，本次 session 退回舊格式重試一次，而不是整個壞掉。
    if (
      response.status === 400 &&
      useStructuredOutput &&
      /responseSchema|thinkingConfig|thinkingLevel|propertyOrdering|Unknown name|Invalid JSON payload/i.test(errText)
    ) {
      useStructuredOutput = false;
      showErrorPanel(
        `Gemini 拒絕了結構化輸出的參數（400），已自動改用相容模式重試。錯誤內容：${errText.slice(0, 300)}`
      );
      recordRequest(items.length); // 退路重試也是一次真的請求
      return callGeminiBatch(items);
    }
    // key 打錯 / 沒開權限：重試不會自己好，直接講人話，不要丟一大坨 JSON 給使用者
    if (
      (response.status === 400 || response.status === 403) &&
      /API_KEY_INVALID|API key not valid|PERMISSION_DENIED/i.test(errText)
    ) {
      const keyErr = new Error(`Gemini 不接受這把 API Key（${response.status}），請回到「1. Gemini API Key」重新貼一次。`);
      keyErr.status = response.status;
      keyErr.noRetry = true;
      showErrorPanel(keyErr.message);
      throw keyErr;
    }
    const err = new Error(`Gemini API 錯誤 (${response.status}): ${errText}`);
    err.status = response.status;
    err.body = errText;
    throw err;
  }

  const data = await response.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error("Gemini 回應中找不到內容");

  // 內容層級的錯誤（JSON 壞掉、對不到任何一句）跟網路/5xx 不一樣：
  // 同樣的 prompt 再送 4 次多半得到同樣的結果，純粹是在燒額度，所以只允許重試 1 次。
  const contentError = (message) => {
    const err = new Error(message);
    err.contentError = true;
    return err;
  };

  const cleaned = rawText.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    throw contentError(`Gemini 回傳的內容不是合法 JSON：${error.message}`);
  }

  const list = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(list)) throw contentError("Gemini 回傳的內容缺少 items 陣列");

  const results = new Map();
  list.forEach((obj) => {
    if (!obj || typeof obj !== "object") return;
    const id = Number(obj.id);
    if (!Number.isInteger(id) || !requestedIds.has(id)) return; // 沒送出過的 id 一律忽略（防幻覺）
    if (typeof obj.translation !== "string") return;
    results.set(id, normalizeResult(obj));
  });

  // 沒有 id 可對應時（模型完全忽略 id），退回按順序對應，總比整批丟掉好
  if (results.size === 0 && list.length === items.length) {
    list.forEach((obj, i) => {
      if (obj && typeof obj.translation === "string") results.set(items[i].id, normalizeResult(obj));
    });
  }

  if (results.size === 0) throw contentError("Gemini 回傳的結果無法對應到任何一句");

  const missingIds = items.map((it) => it.id).filter((id) => !results.has(id));
  return { results, missingIds };
}

// 429 (RESOURCE_EXHAUSTED) 的回應常會附上 Google 建議的等待秒數，優先採用該數字。
function extractRetryDelaySeconds(errorBodyText) {
  try {
    const parsed = JSON.parse(errorBodyText);
    const details = parsed?.error?.details;
    if (Array.isArray(details)) {
      const retryInfo = details.find((d) => typeof d.retryDelay === "string");
      if (retryInfo) {
        const match = retryInfo.retryDelay.match(/(\d+(?:\.\d+)?)/);
        if (match) return parseFloat(match[1]);
      }
    }
  } catch (_parseError) {
    // 內容不是預期的 JSON 結構，忽略，改用預設冷卻時間
  }
  return null;
}

// 遇到暫時性錯誤（伺服器過載、限流、網路問題）時自動延遲重試，追求穩定而非速度。
// 429 屬於帳號/專案層級的速率限制，會另外設定全域冷卻時間，讓後續請求也一起暫停。
async function callGeminiBatchWithAutoRetry(items, label, onStatus) {
  // 沒有 key 就別浪費一次 recordRequest，也別自動重試——重試 4 次一樣沒有 key
  if (!geminiApiKey) {
    const err = new Error("還沒設定 Gemini API Key，請先在最上方的「1. Gemini API Key」貼上你的 key。");
    err.noRetry = true;
    showErrorPanel(err.message);
    throw err;
  }

  let lastError;
  for (let attempt = 0; attempt <= MAX_AUTO_RETRIES; attempt++) {
    const waitMs = globalCooldownUntil - Date.now();
    if (waitMs > 0) {
      onStatus?.(`偵測到 API 速率限制（429），等 ${Math.ceil(waitMs / 1000)} 秒後才會送出請求…`);
      startCooldownCountdown();
      await sleep(waitMs);
    }

    try {
      recordRequest(items.length);
      return await callGeminiBatch(items);
    } catch (error) {
      lastError = error;
      const isRetryable = !error.noRetry && (!error.status || RETRYABLE_STATUSES.includes(error.status));
      // 內容層級的錯誤最多只再試 1 次（見 callGeminiBatch 的 contentError）
      const budget = error.contentError ? Math.min(1, MAX_AUTO_RETRIES) : MAX_AUTO_RETRIES;
      if (!isRetryable || attempt >= budget) throw error;

      let delayMs;
      if (error.status === 429) {
        record429();
        const serverDelaySec = extractRetryDelaySeconds(error.body);
        delayMs = serverDelaySec ? serverDelaySec * 1000 + 1000 : GLOBAL_COOLDOWN_MS;
        globalCooldownUntil = Date.now() + delayMs;
        startCooldownCountdown();
      } else {
        delayMs = RETRY_BASE_DELAY_MS * (attempt + 1);
      }

      const message = `${label} 遇到暫時性錯誤（${error.status ?? "網路"}），${Math.ceil(delayMs / 1000)} 秒後自動重試（第 ${attempt + 1}/${MAX_AUTO_RETRIES} 次）…`;
      onStatus?.(message);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

// 部分缺漏時只補送缺的那幾句（最糟 2 次呼叫），而不是整批重來
async function analyzeItems(items, label, onStatus) {
  const { results, missingIds } = await callGeminiBatchWithAutoRetry(items, label, onStatus);
  if (missingIds.length > 0) {
    const retryItems = items.filter((it) => missingIds.includes(it.id));
    try {
      const second = await callGeminiBatchWithAutoRetry(retryItems, `${label}（補缺 ${retryItems.length} 句）`, onStatus);
      second.results.forEach((value, key) => results.set(key, value));
    } catch (error) {
      console.error("補缺請求失敗", error);
    }
  }
  return results;
}

// ===== 渲染 =====
// 把模型回傳的「漢字[かんじ]」標記轉成 <ruby>漢字<rt>かんじ</rt></ruby>。
// 標記以外的文字一律走 escapeHtml，只有 ruby 標籤是我們自己插的。
const RUBY_RE = /([㐀-䶿一-鿿々〆]+)\[([^\]]{1,24})\]/g;

function renderRuby(text) {
  const src = String(text ?? "");
  let out = "";
  let last = 0;
  RUBY_RE.lastIndex = 0;
  let m;
  while ((m = RUBY_RE.exec(src)) !== null) {
    out += escapeHtml(src.slice(last, m.index));
    out += `<ruby>${escapeHtml(m[1])}<rt>${escapeHtml(m[2])}</rt></ruby>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(src.slice(last));
}

// 單字有 word / kana 兩個分開的欄位，可以直接組 ruby。
// 但假名要只標在漢字上：食べる + たべる 應該是 食[た]べる，不是整個詞頂著「たべる」。
// 做法是從頭尾把相同的送り仮名剝掉，剩下的才是漢字與它的讀音。
function splitOkurigana(word, kana) {
  let base = String(word ?? "");
  let reading = String(kana ?? "");
  let suffix = "";
  let prefix = "";
  while (base.length > 1 && reading.length > 0 && base[base.length - 1] === reading[reading.length - 1]) {
    suffix = base[base.length - 1] + suffix;
    base = base.slice(0, -1);
    reading = reading.slice(0, -1);
  }
  while (base.length > 1 && reading.length > 0 && base[0] === reading[0]) {
    prefix += base[0];
    base = base.slice(1);
    reading = reading.slice(1);
  }
  return { prefix, base, reading, suffix };
}

function renderWordWithRuby(word, kana) {
  const w = String(word ?? "");
  if (!kana || !JP_KANJI_RE.test(w)) return escapeHtml(w);
  const { prefix, base, reading, suffix } = splitOkurigana(w, kana);
  if (!base || !reading) return escapeHtml(w);
  return `${escapeHtml(prefix)}<ruby>${escapeHtml(base)}<rt>${escapeHtml(reading)}</rt></ruby>${escapeHtml(suffix)}`;
}

// 原句優先用模型回傳的 reading（帶假名標記），沒有就退回純文字。
// 舊的快取結果沒有 reading 欄位，這裡要能正常降級。
function renderOriginal(subtitle, result) {
  return result?.reading ? renderRuby(result.reading) : escapeHtml(subtitle.text);
}

function buildCard(subtitle, result) {
  const card = document.createElement("article");
  card.className = "subtitle-card";

  const words = Array.isArray(result?.words) ? result.words : [];
  const grammar = Array.isArray(result?.grammar) ? result.grammar : [];

  const wordRows = words.map((w) => `
    <tr>
      <td>${renderWordWithRuby(w.word, w.kana)}</td>
      <td>${escapeHtml(w.kana)}</td>
      <td>${escapeHtml(w.meaning)}</td>
      <td>${renderRuby(w.note)}</td>
    </tr>
  `).join("");

  const grammarItems = grammar.map((g) => `
    <li>
      <div class="grammar-point">${renderRuby(g.point)}</div>
      <div class="grammar-explanation">${renderRuby(g.explanation)}</div>
      <div class="grammar-example">例：${renderRuby(g.example)}</div>
    </li>
  `).join("");

  // 沒有內容的區塊整塊不顯示，不再印「無 N3 以上內容」的空表格
  const wordSection = words.length === 0 ? "" : `
    <h3>📖 單字與動詞解析（N3 以上）</h3>
    <div class="table-wrap">
      <table class="word-table">
        <thead>
          <tr>
            <th>原字</th>
            <th>假名</th>
            <th>中文意思</th>
            <th>詳細解說（含動詞變化/詞源）</th>
          </tr>
        </thead>
        <tbody>${wordRows}</tbody>
      </table>
    </div>`;

  const grammarSection = grammar.length === 0 ? "" : `
    <h3>📝 文法說明（N3 以上）</h3>
    <ul class="grammar-list">${grammarItems}</ul>`;

  const nothingExtra = words.length === 0 && grammar.length === 0
    ? `<p class="no-extra">這一句沒有 N3 以上的單字或文法點。</p>`
    : "";

  card.innerHTML = `
    <span class="seq-badge">第 ${subtitle.order} 句</span>
    <p class="original-text">${renderOriginal(subtitle, result)}</p>
    <p class="translation">${escapeHtml(result?.translation)}</p>
    ${wordSection}
    ${grammarSection}
    ${nothingExtra}
  `;

  return card;
}

function renderLineList() {
  const frag = document.createDocumentFragment();
  currentSubtitles.forEach((sub) => {
    const li = document.createElement("li");
    li.className = "line-row";
    li.dataset.order = String(sub.order);
    li.dataset.state = lineState[sub.order - 1];
    li.innerHTML = `
      <span class="line-order">${sub.order}</span>
      <span class="line-dot" aria-hidden="true"></span>
      <span class="line-text">
        <span class="line-ja">${escapeHtml(sub.text)}</span>
        <span class="line-zh"></span>
      </span>
    `;
    frag.appendChild(li);
  });
  lineListEl.replaceChildren(frag);
  currentSubtitles.forEach((sub) => repaintRow(sub.order));
}

function repaintRow(order) {
  const row = lineListEl.querySelector(`.line-row[data-order="${order}"]`);
  if (!row) return;
  row.dataset.state = lineState[order - 1];
  const zh = row.querySelector(".line-zh");
  const result = lookupNote(order);
  zh.textContent = result?.translation || "";
}

function renderProgress() {
  const done = lineState.filter((s) => s === "done").length;
  const skipped = lineState.filter((s) => s === "skipped").length;
  progressText.textContent = `已解說 ${done} / ${currentSubtitles.length} 句（自動跳過 ${skipped} 句）`;
  downloadPdfBtn.textContent = `下載 PDF（${done} 句）`;
}

// ===== 每句狀態存取 =====
function lookupNote(order) {
  const item = notes?.items?.[String(order)];
  if (item && item.status === "done" && item.result) return item.result;
  return null;
}

function applyResult(order, result, source) {
  const sub = currentSubtitles[order - 1];
  if (!sub) return;
  notes.items[String(order)] = {
    text: sub.text,
    status: "done",
    source,
    at: new Date().toISOString(),
    result,
  };
  lineState[order - 1] = "done";
  markNotesDirty();
  repaintRow(order);
  renderProgress();
}

function markSkipped(order, reason) {
  const sub = currentSubtitles[order - 1];
  if (!sub) return;
  notes.items[String(order)] = { text: sub.text, status: "skipped", reason };
  lineState[order - 1] = "skipped";
  markNotesDirty();
}

// 全域快取命中時「升級」成這個檔案的 notes 紀錄，之後就完全不用再查第二層
function promoteFromGlobalCache(order) {
  const sub = currentSubtitles[order - 1];
  if (!sub) return false;
  const cached = getCachedResult(sub.text);
  if (!cached) return false;
  applyResult(order, cached, "cache");
  return true;
}

// 一批結果回來之後，整份掃一次：預取視窗「之外」如果有相同文字的句子，
// 它們其實已經零成本可用了，要立刻標成 done，否則清單上會顯示成還沒解說。
function promoteAllFromGlobalCache() {
  let promoted = 0;
  currentSubtitles.forEach((sub) => {
    if (lineState[sub.order - 1] !== "idle") return;
    if (promoteFromGlobalCache(sub.order)) promoted += 1;
  });
  return promoted;
}

// ===== 開啟字幕檔 =====
async function openSubtitleFile(file) {
  let rawText;
  try {
    rawText = await (await file.handle.getFile()).text();
  } catch (error) {
    setWorkspaceState("needs-grant", `讀取 ${file.name} 失敗（${error.name}），請重新授權資料夾。`);
    return;
  }
  await loadSubtitles(file.name, rawText);
}

async function loadSubtitles(fileName, rawText) {
  await flushNotes(); // 切檔前把上一個檔案的紀錄寫完

  const subtitles = parseSubtitleFile(rawText, fileName);
  if (subtitles.length === 0) {
    statusText.textContent = "找不到有效的字幕內容，請確認字幕格式是否正確。";
    return;
  }

  requestByOrder.clear();
  // 先清掉上一個檔案的列，否則下面初始掃描裡的 repaintRow() 會寫到舊檔案的列上
  lineListEl.replaceChildren();
  currentFileName = fileName;
  currentSubtitles = subtitles;
  notes = await loadNotes(fileName, subtitles);
  lineState = new Array(subtitles.length).fill("idle");

  // 初始掃描：notes → 全域快取 → 跳過規則。跑完之後 lineState 就是唯一真相來源。
  subtitles.forEach((sub) => {
    const item = notes.items[String(sub.order)];
    if (item && item.text === sub.text && item.status === "done" && item.result) {
      lineState[sub.order - 1] = "done";
      return;
    }
    if (item && item.text === sub.text && item.status === "skipped") {
      lineState[sub.order - 1] = "skipped";
      return;
    }
    const cached = getCachedResult(sub.text);
    if (cached) {
      applyResult(sub.order, cached, "cache");
      return;
    }
    const reason = shouldSkipLine(sub.text);
    if (reason) markSkipped(sub.order, reason);
  });

  currentFileTitle.textContent = `3. ${fileName}`;
  simplifiedOutput.value = subtitles.map((s) => `${s.order}. ${s.text}`).join("\n");
  importExpectedCount.textContent = String(subtitles.length);

  renderLineList();
  renderProgress();
  renderUsage();
  subtitlePanel.hidden = false;
  statusText.textContent = "點任何一句就會顯示解說；沒解說過的句子才會呼叫 Gemini。";
  subtitlePanel.scrollIntoView({ behavior: "smooth", block: "start" });

  await flushNotes();
}

// ===== 請求佇列 =====
// 所有 API 呼叫串成單一 promise chain（併發上限 1），維持「嚴格循序」的既有決定。
function enqueueApi(job) {
  const run = async () => {
    const since = Date.now() - lastApiFinishedAt;
    // 只在連續排隊的請求之間停頓；第一個請求不套用，不然使用者點一下要乾等 1.5 秒
    if (lastApiFinishedAt && since < BATCH_DELAY_MS) await sleep(BATCH_DELAY_MS - since);
    try {
      return await job();
    } finally {
      lastApiFinishedAt = Date.now();
    }
  };
  const p = apiQueue.then(run, run);
  apiQueue = p.then(
    () => {},
    () => {}
  );
  return p;
}

// 從 startOrder 往後收集尚未解說的句子，湊滿 LOOKAHEAD_SIZE 個「不重複的文字」。
// 重複文字只送一次，回來之後扇出給每一個 order——漏了扇出會讓那些行永遠看起來沒解說。
function collectBatch(startOrder) {
  const first = currentSubtitles[startOrder - 1];
  if (!first) return null;

  const byText = new Map(); // text -> { id, orders: [] }
  const covered = [];

  const add = (sub) => {
    covered.push(sub.order);
    const entry = byText.get(sub.text);
    if (entry) entry.orders.push(sub.order);
    else byText.set(sub.text, { id: sub.order, orders: [sub.order] });
  };

  add(first);

  for (let order = startOrder + 1; order <= currentSubtitles.length && byText.size < LOOKAHEAD_SIZE; order++) {
    if (requestByOrder.has(order)) continue;
    // error 的句子也讓它跟著預抓重試，不然整批失敗後就再也不會被順帶帶起來
    if (lineState[order - 1] !== "idle" && lineState[order - 1] !== "error") continue;
    const sub = currentSubtitles[order - 1];
    if (shouldSkipLine(sub.text)) continue;
    if (promoteFromGlobalCache(order)) continue;
    add(sub);
  }

  const payload = [...byText.values()].map((entry) => ({
    id: entry.id,
    text: currentSubtitles[entry.id - 1].text,
  }));
  return { covered, byText, payload };
}

// 呼叫前，強制重新分析的情況必須先清掉該句的 notes 紀錄與全域快取（見 openNote），
// 否則 stillNeeded 會把它當成已完成而直接跳過。
function ensureAnalysis(startOrder) {
  const existing = requestByOrder.get(startOrder);
  if (existing) return existing.promise; // 快速連點、或點到已被預抓涵蓋的句子，都在這裡收斂

  const batch = collectBatch(startOrder);
  if (!batch) return Promise.resolve();

  const label = `第 ${startOrder} 句起共 ${batch.payload.length} 句`;
  const record = { orders: batch.covered, promise: null };

  record.promise = enqueueApi(async () => {
    // 出列時重新檢查：排隊期間可能已經被前一個 job 涵蓋了
    const stillNeeded = batch.payload.filter((item) => !lookupNote(item.id) && !getCachedResult(item.text));
    if (stillNeeded.length === 0) return;

    if (!confirmIfOverQuota(stillNeeded.length)) {
      throw new Error(`已取消：今日請求數已超過設定的軟性上限（${SOFT_RPD_LIMIT}）。`);
    }

    statusText.textContent = `解說中… ${label}`;
    const results = await analyzeItems(stillNeeded, label, (msg) => {
      statusText.textContent = msg;
      showErrorPanel(msg);
    });

    for (const [text, entry] of batch.byText) {
      const result = results.get(entry.id);
      if (!result) continue;
      setCachedResult(text, result);
      entry.orders.forEach((order) => applyResult(order, result, "gemini"));
    }
    promoteAllFromGlobalCache(); // 預取視窗外的重複句，這下也零成本可用了
    await flushNotes(); // 花錢換來的資料，立刻寫檔，不走 debounce
    clearErrorPanel(); // 成功了就把上一次的重試／429 訊息收掉
    statusText.textContent = `完成：${label}（其中 ${results.size} 句取得解說）`;
  });

  batch.covered.forEach((order) => {
    requestByOrder.set(order, record);
    const state = lineState[order - 1];
    if (state === "idle" || state === "error") lineState[order - 1] = "pending";
    repaintRow(order);
  });

  record.promise
    .catch((error) => {
      batch.covered.forEach((order) => {
        if (lineState[order - 1] === "pending") lineState[order - 1] = "error";
      });
      statusText.textContent = `解說失敗：${error.message}`;
      showErrorPanel(`${label} 失敗：${error.message}`);
    })
    .finally(() => {
      // 一定要把 record 清掉，下次點擊才能乾淨地重試
      batch.covered.forEach((order) => {
        if (requestByOrder.get(order) === record) requestByOrder.delete(order);
        if (lineState[order - 1] === "pending") lineState[order - 1] = "idle";
        repaintRow(order);
      });
      renderProgress();
    });

  return record.promise;
}

// ===== 彈窗 =====
function setNoteBody(token, order, html) {
  if (token !== dialogToken || order !== dialogOrder) return; // 慢回來的舊回應不准蓋掉當前彈窗
  noteBody.innerHTML = html;
}

function setNoteCard(token, order, result) {
  if (token !== dialogToken || order !== dialogOrder) return;
  const sub = currentSubtitles[order - 1];
  // 卡片裡的原句被 CSS 藏起來了（彈窗自己有一行原句），所以要另外把帶假名的版本填進去
  noteOriginal.innerHTML = renderOriginal(sub, result);
  noteBody.replaceChildren(buildCard(sub, result));
}

async function openNote(order, { force = false } = {}) {
  const sub = currentSubtitles[order - 1];
  if (!sub) return;

  dialogToken += 1;
  const token = dialogToken;
  dialogOrder = order;

  // 先開窗再說，絕不讓使用者等網路才看到東西
  noteSeq.textContent = `第 ${order} 句`;
  noteOriginal.textContent = sub.text;
  noteCountdown.textContent = "";
  noteBody.innerHTML = `<p class="note-loading">讀取中…</p>`;
  notePrevBtn.disabled = order <= 1;
  noteNextBtn.disabled = order >= currentSubtitles.length;
  if (!noteDialog.open) noteDialog.showModal();

  if (!force) {
    const existing = lookupNote(order) || (promoteFromGlobalCache(order) ? lookupNote(order) : null);
    if (existing) {
      setNoteCard(token, order, existing);
      return;
    }
    const reason = shouldSkipLine(sub.text);
    if (reason) {
      setNoteBody(
        token,
        order,
        `<p class="note-skipped">這一句被自動跳過，沒有花 API 額度。<br>理由：${escapeHtml(SKIP_REASON_TEXT[reason] || reason)}</p>
         <button type="button" class="btn btn-secondary" id="noteForceBtn">還是分析這句</button>`
      );
      const forceBtn = document.getElementById("noteForceBtn");
      forceBtn?.addEventListener("click", () => openNote(order, { force: true }));
      return;
    }
  }

  setNoteBody(token, order, `<p class="note-loading">解說中…（連同後面尚未解說的句子一起送出，之後點那幾句不會再花額度）</p>`);

  // 強制重新分析：先清掉這一句的紀錄與全域快取，否則 ensureAnalysis 會判定它已完成而直接跳過。
  // 舊結果先留一份，失敗時要還回去——重新分析失敗不該連原本有的解說一起弄丟。
  const key = String(order);
  const previousItem = force ? notes.items[key] : null;
  if (force) {
    delete notes.items[key];
    delete resultCache[sub.text];
    saveResultCache();
    lineState[order - 1] = "idle";
    requestByOrder.delete(order);
  }

  try {
    await ensureAnalysis(order);
    const result = lookupNote(order);
    if (result) setNoteCard(token, order, result);
    else setNoteBody(token, order, `<p class="note-error">這一句沒有取得解說，請按「重新分析這句」再試一次。</p>`);
  } catch (error) {
    if (previousItem && !notes.items[key]) {
      notes.items[key] = previousItem;
      lineState[order - 1] = "done";
      repaintRow(order);
      renderProgress();
    }
    setNoteBody(token, order, `<p class="note-error">解說失敗：${escapeHtml(error.message)}</p>`);
  }
}

lineListEl.addEventListener("click", (event) => {
  const row = event.target.closest(".line-row");
  if (!row) return;
  openNote(Number(row.dataset.order));
});

// dialog 本身 padding 必須為 0、內容全放在 .note-dialog-inner，
// 否則點在 dialog 自己的內距上會被當成點背景而誤關。
noteDialog.addEventListener("click", (event) => {
  if (event.target === noteDialog) noteDialog.close();
});

noteDialog.addEventListener("close", () => {
  dialogOrder = 0;
  flushNotes();
});

noteCloseBtn.addEventListener("click", () => noteDialog.close());
notePrevBtn.addEventListener("click", () => openNote(dialogOrder - 1));
noteNextBtn.addEventListener("click", () => openNote(dialogOrder + 1));
noteReanalyzeBtn.addEventListener("click", () => openNote(dialogOrder, { force: true }));

// ===== 列印 / PDF =====
// 解說改成彈窗之後，畫面上已經沒有卡片可印，所以列印時才即時建構列印區，印完丟掉。
function renderPrintArea() {
  const frag = document.createDocumentFragment();
  const head = document.createElement("h1");
  head.textContent = currentFileName;
  frag.appendChild(head);
  currentSubtitles.forEach((sub) => {
    const result = lookupNote(sub.order);
    if (result) frag.appendChild(buildCard(sub, result));
  });
  printArea.replaceChildren(frag);
}

downloadPdfBtn.addEventListener("click", () => {
  noteDialog.close(); // modal dialog 在 top layer，不關會蓋著整頁印出來
  renderPrintArea();
  window.print();
});

window.addEventListener("afterprint", () => printArea.replaceChildren());

// ===== 匯入外部結果 =====
openImportDialogBtn.addEventListener("click", () => {
  importErrorText.textContent = "";
  importTextarea.value = "";
  importExpectedCount.textContent = String(currentSubtitles.length);
  importDialog.showModal();
});

importCancelBtn.addEventListener("click", () => importDialog.close());

// 依序嘗試：id 對應 → 句子原文對應（扇出到所有相同文字的句子）→ 陣列位置對應
function handleImportConfirm() {
  importErrorText.textContent = "";

  if (currentSubtitles.length === 0) {
    importErrorText.textContent = "請先開啟一個字幕檔。";
    return;
  }

  const raw = importTextarea.value.trim();
  if (!raw) {
    importErrorText.textContent = "請貼上 JSON 內容。";
    return;
  }

  const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    importErrorText.textContent = `JSON 格式錯誤：${error.message}`;
    return;
  }

  const list = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(list)) {
    importErrorText.textContent = "內容必須是一個 JSON 陣列，或是包含 items 陣列的物件。";
    return;
  }

  const textToOrders = new Map();
  currentSubtitles.forEach((sub) => {
    if (!textToOrders.has(sub.text)) textToOrders.set(sub.text, []);
    textToOrders.get(sub.text).push(sub.order);
  });

  const applied = new Set();
  let unmatched = 0;
  const usePositional = list.length === currentSubtitles.length && !list.some((o) => o && (o.id != null || o.text != null));

  list.forEach((obj, index) => {
    if (!obj || typeof obj !== "object" || typeof obj.translation !== "string") {
      unmatched += 1;
      return;
    }
    const result = normalizeResult(obj);

    let orders = null;
    const id = Number(obj.id);
    if (Number.isInteger(id) && currentSubtitles[id - 1]) orders = [id];
    else if (typeof obj.text === "string" && textToOrders.has(obj.text)) orders = textToOrders.get(obj.text);
    else if (usePositional && currentSubtitles[index]) orders = [index + 1];

    if (!orders) {
      unmatched += 1;
      return;
    }
    orders.forEach((order) => {
      applyResult(order, result, "import");
      setCachedResult(currentSubtitles[order - 1].text, result);
      applied.add(order);
    });
  });

  if (applied.size === 0) {
    importErrorText.textContent = "沒有任何一筆能對應到目前的字幕。請確認每筆有 id 或 text 欄位，或是陣列長度剛好等於句數。";
    return;
  }

  flushNotes();
  renderProgress();
  statusText.textContent = `已匯入 ${applied.size} 句${unmatched > 0 ? `，${unmatched} 筆找不到對應` : ""}。`;
  importDialog.close();
}

importConfirmBtn.addEventListener("click", handleImportConfirm);

// ===== 其他按鈕 =====
pickDirBtn.addEventListener("click", pickWorkDir);

grantDirBtn.addEventListener("click", async () => {
  if (!workDirHandle) return pickWorkDir();
  if (await verifyHandlePermission(workDirHandle, true)) await onWorkDirReady();
  else setWorkspaceState("needs-grant", `還是沒有取得授權：${workDirHandle.name}`);
});

rescanBtn.addEventListener("click", scanWorkDir);

closeFileBtn.addEventListener("click", async () => {
  await flushNotes();
  subtitlePanel.hidden = true;
  currentFileName = "";
  currentSubtitles = [];
  lineState = [];
  requestByOrder.clear();
  if (workspaceState === "ready") loadFileListProgress();
  workspacePanel.scrollIntoView({ behavior: "smooth", block: "start" });
});

copySimplifiedBtn.addEventListener("click", async () => {
  const originalLabel = copySimplifiedBtn.textContent;
  try {
    await navigator.clipboard.writeText(simplifiedOutput.value);
    copySimplifiedBtn.textContent = "已複製！";
  } catch (_error) {
    simplifiedOutput.select();
    copySimplifiedBtn.textContent = "已選取，請按 Ctrl+C";
  }
  setTimeout(() => {
    copySimplifiedBtn.textContent = originalLabel;
  }, 1800);
});

clearCacheBtn.addEventListener("click", () => {
  if (!confirm("確定要清除「全域快取」嗎？這不會動到各字幕檔的 .notes.json，只會讓沒有 notes 紀錄的句子重新呼叫 Gemini。")) return;
  resultCache = {};
  saveResultCache();
  statusText.textContent = "已清除全域快取。";
});

// 舊版（DESIGN.md §11）用 showSaveFilePicker 選的那個單一快取檔，現在只當成匯入來源
async function importLegacyCacheIfGranted() {
  try {
    const handle = await idbGet(IDB_HANDLE_KEY);
    if (!handle) return;
    if (!(await verifyHandlePermission(handle, false))) return;
    const text = await (await handle.getFile()).text();
    if (!text.trim()) return;
    const old = JSON.parse(text);
    if (old && typeof old === "object") {
      resultCache = { ...old, ...resultCache };
      saveResultCache();
    }
  } catch (_error) {
    // 舊檔不存在或無權限，忽略
  }
}

importLegacyCacheBtn.addEventListener("click", async () => {
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: "JSON 快取檔案", accept: { "application/json": [".json"] } }],
    });
    const old = JSON.parse(await (await handle.getFile()).text());
    if (!old || typeof old !== "object") throw new Error("內容不是物件");
    const before = Object.keys(resultCache).length;
    resultCache = { ...old, ...resultCache };
    saveResultCache();
    statusText.textContent = `已匯入舊快取，句數從 ${before} 增加到 ${Object.keys(resultCache).length}。`;
  } catch (error) {
    if (error.name !== "AbortError") statusText.textContent = `匯入舊快取失敗：${error.message}`;
  }
});

// 非 Chromium 瀏覽器的退路：只能選單一字幕檔，解說存在瀏覽器裡，靠這顆按鈕手動保存
downloadNotesBtn.addEventListener("click", () => {
  if (!notes) return;
  const blob = new Blob([JSON.stringify(notes, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = currentFileName + NOTES_SUFFIX;
  a.click();
  URL.revokeObjectURL(a.href);
});

fileInput.addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  fileNameDisplay.textContent = file.name;
  const reader = new FileReader();
  reader.onload = (e) => loadSubtitles(file.name, e.target.result);
  reader.readAsText(file, "UTF-8");
});

// beforeunload 沒辦法 await 非同步寫入，所以主要靠「API 回應後立刻 flush」；
// visibilitychange 是額外的保險。
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushNotes();
});

// ===== API Key 面板 =====
function maskKey(key) {
  if (key.length <= 8) return "*".repeat(key.length);
  return `${key.slice(0, 4)}${"*".repeat(Math.min(key.length - 8, 24))}${key.slice(-4)}`;
}

function renderApiKeyPanel() {
  if (geminiApiKey) {
    apiKeyStatus.textContent = `已設定：${maskKey(geminiApiKey)}（只存在這台瀏覽器）`;
    apiKeyInput.value = geminiApiKey;
  } else {
    apiKeyStatus.textContent = "還沒設定 API Key，設定之前沒辦法產生解說。";
    apiKeyInput.value = "";
  }
  apiKeyInput.type = "password";
  apiKeyToggleBtn.textContent = "顯示";
}

function saveApiKey() {
  const value = apiKeyInput.value.trim();
  if (!value) {
    apiKeyStatus.textContent = "請先貼上 API Key。";
    return;
  }
  geminiApiKey = value;
  try {
    localStorage.setItem(API_KEY_STORAGE_KEY, value);
  } catch (_error) {
    // 存不進去（無痕模式/停用 cookie）也還是能用，只是重新整理後要再貼一次
    apiKeyStatus.textContent = `已套用：${maskKey(value)}（這個瀏覽器不讓存，重新整理後要再貼一次）`;
    return;
  }
  renderApiKeyPanel();
}

apiKeySaveBtn.addEventListener("click", saveApiKey);

apiKeyInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") saveApiKey();
});

apiKeyToggleBtn.addEventListener("click", () => {
  const showing = apiKeyInput.type === "text";
  apiKeyInput.type = showing ? "password" : "text";
  apiKeyToggleBtn.textContent = showing ? "顯示" : "隱藏";
});

apiKeyClearBtn.addEventListener("click", () => {
  geminiApiKey = "";
  try {
    localStorage.removeItem(API_KEY_STORAGE_KEY);
  } catch (_error) {
    // 本來就沒存進去，忽略
  }
  renderApiKeyPanel();
});

// ===== 啟動 =====
renderApiKeyPanel();
renderUsage();
initWorkspace();
