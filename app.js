// ===== 設定 =====
// 這個工具只做三件事：從 Jimaku／kitsunekko 拿字幕 → 依停頓分成一段一段 → 每段可以複製、或丟給 Gemini 解說。
// 不呼叫任何 AI API、不讀寫本機檔案；只把「上次打開的那一個字幕」存在瀏覽器裡，重新整理後回到同一個狀態（見 DESIGN.md §28）。
const SUBTITLE_EXT_RE = /\.(srt|vtt|ass|ssa|sbv|txt)$/i;
const KITSUNEKKO_URL = "https://kitsunekko.net/dirlist.php?dir=subtitles%2Fjapanese%2F";
const KITSUNEKKO_ORIGIN_RE = /^https?:\/\/(www\.)?kitsunekko\.net$/;
const KITSUNEKKO_MAX_BYTES = 20 * 1024 * 1024; // 單一檔案（含 zip）上限，正常字幕檔才幾十 KB
const JIMAKU_API = "https://jimaku.cc/api";
const JIMAKU_KEY_STORAGE_KEY = "jst_jimaku_key_v1";
const JIMAKU_LAST_STORAGE_KEY = "jst_jimaku_last_v1"; // 上一次的搜尋：關鍵字、作品清單、打開過的作品檔案清單（只有名稱與網址，不含字幕內容）
const JIMAKU_CLIENT_ID = "japanese-subtitle-translation"; // Jimaku 要求帶 User-Agent 或 X-Client-Id；fetch 改不了 UA，所以用後者
const GEMINI_WEB_URL = "https://gemini.google.com/app";
const LAST_FILE_KEY = "jst_last_file_v1"; // 上次打開的字幕：{ name, text, line, savedAt }，只存這一個
const GEMINI_MODE_KEY = "jst_gemini_mode_v1"; // "shortcut" | "web"
const SHORTCUT_NAME_KEY = "jst_shortcut_name_v1";
const DEFAULT_SHORTCUT_NAME = "Gemini解說日文";
// iPadOS 的 Safari 預設回報成 Mac，要用觸控點數分辨
const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

// ===== DOM =====
const findPanel = document.getElementById("findPanel");
const jimakuKeyDetails = document.getElementById("jimakuKeyDetails");
const jimakuKeySummary = document.getElementById("jimakuKeySummary");
const jimakuKeyInput = document.getElementById("jimakuKeyInput");
const jimakuKeySaveBtn = document.getElementById("jimakuKeySaveBtn");
const jimakuKeyClearBtn = document.getElementById("jimakuKeyClearBtn");
const jimakuSearchForm = document.getElementById("jimakuSearchForm");
const jimakuQuery = document.getElementById("jimakuQuery");
const jimakuSearchBtn = document.getElementById("jimakuSearchBtn");
const findStatus = document.getElementById("findStatus");
const findBackBtn = document.getElementById("findBackBtn");
const findListEl = document.getElementById("findList");
const kitsuBookmarklet = document.getElementById("kitsuBookmarklet");
const openKitsunekkoBtn = document.getElementById("openKitsunekkoBtn");
const kitsuStatus = document.getElementById("kitsuStatus");

const subtitlePanel = document.getElementById("subtitlePanel");
const currentFileTitle = document.getElementById("currentFileTitle");
const lineCountText = document.getElementById("lineCountText");
const closeFileBtn = document.getElementById("closeFileBtn");
const lineListEl = document.getElementById("lineList");
const toastEl = document.getElementById("toast");
const geminiModeSummary = document.getElementById("geminiModeSummary");
const geminiModeRadios = document.querySelectorAll('input[name="geminiMode"]');
const shortcutNameInput = document.getElementById("shortcutNameInput");

// ===== 狀態 =====
let currentFileName = "";
let currentSubtitles = []; // { order, text }[]：一段一筆，段落裡的句子用換行分開
let currentRawText = ""; // 目前打開的字幕原文，記錄「上次看到哪一段」時要連同內容一起存

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

// 字幕檔的編碼很雜：kitsunekko 上有不少 Shift_JIS、UTF-16 的舊檔。
// 先看 BOM，再試嚴格 UTF-8，失敗才退回 Shift_JIS；都不行就用寬鬆 UTF-8（至少不會整個爆掉）。
function decodeSubtitleBytes(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  for (const label of ["utf-8", "shift_jis"]) {
    try {
      return new TextDecoder(label, { fatal: true }).decode(bytes);
    } catch (_error) {
      // 換下一個編碼試
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}


// ===== 字幕解析（支援多種格式，只取文字內容，順序以出現先後為準；時間軸只拿來斷句、分段，不顯示）=====
// Netflix 來源的字幕每句前後會包一層看不見的方向控制字元（U+202A…U+202C 等），
// 不拿掉的話複製出去、送給 Gemini、拿來當快取 key 都會帶著這些垃圾。所有格式都會有，所以在 parseSubtitleFile 一次清掉。
const BIDI_CONTROL_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function stripTags(text) {
  return text.replace(/<[^>]+>/g, "").replace(/\{[^}]*\}/g, "").trim();
}

// 有時間軸的格式（SRT／VTT／SBV）先解析成 cue：{ start, end, lines }（時間單位毫秒），再交給 cuesToSentences 重組成句子
function parseTimestamp(str) {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(str || "");
  if (!m) return null;
  return ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4].padEnd(3, "0"));
}

function cueFrom(timeLine, textLines) {
  const [startStr, endStr] = timeLine.split(/-->|,(?=\d+:\d{2}:\d{2}\.)/);
  const lines = textLines.map(stripTags).filter(Boolean);
  if (lines.length === 0) return null;
  return { start: parseTimestamp(startStr), end: parseTimestamp(endStr), lines };
}

function parseSRT(text) {
  const blocks = text.split(/\n\s*\n/);
  const cues = [];
  for (const block of blocks) {
    const blockLines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (blockLines.length === 0) continue;

    let idx = 0;
    if (/^\d+$/.test(blockLines[0])) idx = 1;

    const timeLine = blockLines[idx];
    if (!timeLine || !/-->/.test(timeLine)) continue;

    const cue = cueFrom(timeLine, blockLines.slice(idx + 1));
    if (cue) cues.push(cue);
  }
  return cues;
}

function parseVTT(text) {
  const withoutHeader = text.replace(/^WEBVTT[^\n]*\n?/i, "");
  const blocks = withoutHeader.split(/\n\s*\n/);
  const cues = [];
  for (const block of blocks) {
    const blockLines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (blockLines.length === 0) continue;
    if (/^NOTE/i.test(blockLines[0]) || /^STYLE/i.test(blockLines[0]) || /^REGION/i.test(blockLines[0])) continue;

    let idx = 0;
    if (!/-->/.test(blockLines[0])) idx = 1; // 第一行可能是 cue identifier

    const timeLine = blockLines[idx];
    if (!timeLine || !/-->/.test(timeLine)) continue;

    const cue = cueFrom(timeLine, blockLines.slice(idx + 1));
    if (cue) cues.push(cue);
  }
  return cues;
}

function parseSBV(text) {
  const blocks = text.split(/\n\s*\n/);
  const cues = [];
  const timeLinePattern = /^\d+:\d{2}:\d{2}\.\d{3},\d+:\d{2}:\d{2}\.\d{3}$/;

  for (const block of blocks) {
    const blockLines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (blockLines.length === 0) continue;
    if (!timeLinePattern.test(blockLines[0])) continue;

    const cue = cueFrom(blockLines[0], blockLines.slice(1));
    if (cue) cues.push(cue);
  }
  return cues;
}

// ===== cue → 句子 =====
// 字幕的 cue 是照「畫面上放得下、念得完」切的，不是照句子切：
// - 一個 cue 裡可能是兩個人的對話（每行開頭標說話者「（おさく）」或對話破折號「－」），要拆開；
// - 一句長台詞常被拆到連續幾個 cue（「ここら辺りまで来たので―」｜「おめえたちの顔が見たくて…」），要接回去。
// 「話還沒講完」要看這個檔的寫法（整個檔一起判斷，各家字幕組習慣不同）：
// - dash：Netflix 在要接到下一個 cue 的句尾放「―」「—」，有就接，沒有就是講完了；
// - period：電視台字幕每句都收「。」「！」「？」，沒收尾就是還沒講完；同一個 cue 裡收了尾的行也拆成兩句；
// - plain：兩種都沒有，只能看句尾的助詞，挑誤判少的幾個（「て」「で」常是命令句結尾，不列）。
// 都是啟發式：寧可少接，也不要把兩個人的話黏成一大串。
const UTTERANCE_START_RE = /^(?:[（(][^）)]{1,15}[）)]|[-－‐―–—]\s*)/; // 說話者標記、對話破折號、或（音效）
const UNCLOSED_PAIRS = [["「", "」"], ["『", "』"], ["《", "》"], ["（", "）"], ["(", ")"]];
const DASH_CONTINUES_RE = /[―—→]$/;
const SENTENCE_END_RE = /[。．！？!?…‥」』》）)～〜♪]$/;
const PLAIN_CONTINUES_RE = /(?:[、，,]|が|を|は|ので|のに)$/;
const MERGE_MAX_GAP_MS = 1500;
const MERGE_MAX_BRACKET_GAP_MS = 5000; // 「…」《…》還沒關起來是很強的訊號，間隔可以放寬
const MERGE_MAX_CHARS = 80;

function hasUnclosedBracket(text) {
  return UNCLOSED_PAIRS.some(([open, close]) => text.split(open).length > text.split(close).length);
}

function detectContinuationStyle(cues) {
  const lastLines = cues.map((c) => c.lines[c.lines.length - 1]);
  if (lastLines.filter((l) => DASH_CONTINUES_RE.test(l)).length >= 3) return "dash";
  if (lastLines.filter((l) => /[。．]$/.test(l)).length >= lastLines.length * 0.2) return "period";
  return "plain";
}

function cueToUtterances(lines, style) {
  const utterances = [];
  for (const line of lines) {
    const prev = utterances[utterances.length - 1];
    const splitHere = !prev || UTTERANCE_START_RE.test(line) || (style === "period" && SENTENCE_END_RE.test(prev) && !hasUnclosedBracket(prev));
    if (splitHere) utterances.push(line);
    else utterances[utterances.length - 1] += " " + line;
  }
  return utterances.map((u) => u.replace(/^[-－‐―–—]\s*/, "").trim()).filter(Boolean);
}

function continuesIntoNext(text, style, gap) {
  if (hasUnclosedBracket(text)) return gap <= MERGE_MAX_BRACKET_GAP_MS;
  if (gap > MERGE_MAX_GAP_MS) return false;
  // 「おい！―」這種是同一個人接著講下一句，句子本身已經完整，不接
  if (style === "dash") return DASH_CONTINUES_RE.test(text) && !/[！？!?]\s*[―—→]$/.test(text);
  if (style === "period") return !SENTENCE_END_RE.test(text);
  return PLAIN_CONTINUES_RE.test(text);
}

function cuesToSentences(cues) {
  const style = detectContinuationStyle(cues);
  const sentences = [];
  let prevCue = null;
  for (const cue of cues) {
    const utterances = cueToUtterances(cue.lines, style);
    if (utterances.length === 0) continue;
    if (prevCue && !UTTERANCE_START_RE.test(cue.lines[0])) {
      const last = sentences[sentences.length - 1];
      const gap = cue.start != null && prevCue.end != null ? cue.start - prevCue.end : Infinity;
      if (continuesIntoNext(last.text, style, gap) && last.text.length + utterances[0].length <= MERGE_MAX_CHARS) {
        last.text = `${last.text} ${utterances.shift()}`;
        last.end = cue.end;
      }
    }
    sentences.push(...utterances.map((text) => ({ text, start: cue.start, end: cue.end })));
    prevCue = cue;
  }
  return sentences;
}

// ===== 句子 → 段落 =====
// 解說以「段」為單位：使用者的 Gemini 設定會自己把段落拆句解說，給它整段對話，主語、代名詞、誰對誰說話都比較判斷得出來。
// 停頓超過 PARAGRAPH_GAP_MS 就換一段（講話中間幾乎不會停這麼久，通常是換場景）。
// 但吵架、連珠炮的場景可以好幾分鐘都沒停頓，一段會長到幾千字（實測一集 Netflix 時代劇最長 2641 字），
// 所以超過 PARAGRAPH_MAX_CHARS 的段，再從段裡停頓最久的地方切開，切到每段都在上限內（或只剩一句）。
const PARAGRAPH_GAP_MS = 2000;
const PARAGRAPH_MAX_CHARS = 200;

function sentenceGap(a, b) {
  return a.end != null && b.start != null ? b.start - a.end : 0;
}

function splitLongParagraph(sentences) {
  const chars = sentences.reduce((sum, s) => sum + s.text.length, 0);
  if (chars <= PARAGRAPH_MAX_CHARS || sentences.length < 2) return [sentences];
  let cut = 1;
  for (let i = 2; i < sentences.length; i++) {
    if (sentenceGap(sentences[i - 1], sentences[i]) > sentenceGap(sentences[cut - 1], sentences[cut])) cut = i;
  }
  return [...splitLongParagraph(sentences.slice(0, cut)), ...splitLongParagraph(sentences.slice(cut))];
}

function sentencesToParagraphs(sentences) {
  const groups = [];
  for (const sentence of sentences) {
    const group = groups[groups.length - 1];
    if (group && sentenceGap(group[group.length - 1], sentence) < PARAGRAPH_GAP_MS) group.push(sentence);
    else groups.push([sentence]);
  }
  return groups.flatMap(splitLongParagraph).map((group) => group.map((s) => s.text).join("\n"));
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
  const normalized = rawText.replace(/\r\n/g, "\n").replace(/^﻿/, "").replace(BIDI_CONTROL_RE, "").trim();
  if (!normalized) return [];

  const format = detectFormat(normalized, filename);
  let lines;
  switch (format) {
    case "vtt":
      lines = sentencesToParagraphs(cuesToSentences(parseVTT(normalized)));
      break;
    case "ass":
      lines = parseASS(normalized);
      break;
    case "sbv":
      lines = sentencesToParagraphs(cuesToSentences(parseSBV(normalized)));
      break;
    case "srt":
      lines = sentencesToParagraphs(cuesToSentences(parseSRT(normalized)));
      break;
    default:
      lines = parsePlainText(normalized);
      break;
  }

  return lines.map((text, i) => ({ order: i + 1, text }));
}

// ===== 字幕清單 =====
function loadSubtitles(fileName, rawText, { scroll = true, save = true } = {}) {
  const subtitles = parseSubtitleFile(rawText, fileName);
  if (subtitles.length === 0) {
    showToast(`${fileName} 裡找不到字幕內容，請換一個檔案。`, 6000);
    return false;
  }
  currentFileName = fileName;
  currentSubtitles = subtitles;
  currentRawText = rawText;
  if (save) saveLastFile(null);
  currentFileTitle.textContent = fileName;
  lineCountText.textContent = `共 ${subtitles.length} 段。📋 複製這段，「Gemini」把這段送去 Gemini 解說。`;
  renderLineList();
  subtitlePanel.hidden = false;
  if (scroll) subtitlePanel.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}

function renderLineList() {
  const frag = document.createDocumentFragment();
  currentSubtitles.forEach((sub) => {
    const li = document.createElement("li");
    li.className = "line-row";
    li.dataset.order = String(sub.order);
    // 整段都是音效、符號這類句子就淡化顯示（判斷規則見 shouldSkipLine），但按鈕照樣可以用
    if (sub.text.split("\n").every(shouldSkipLine)) li.classList.add("is-minor");
    li.innerHTML = `
      <span class="line-order">${sub.order}</span>
      <span class="line-ja">${escapeHtml(sub.text)}</span>
      <span class="line-actions">
        <button type="button" class="line-copy" title="複製這段" aria-label="複製第 ${sub.order} 段">📋</button>
        <button type="button" class="line-gemini" title="用 Gemini 解說這段" aria-label="用 Gemini 解說第 ${sub.order} 段">Gemini</button>
      </span>
    `;
    frag.appendChild(li);
  });
  lineListEl.replaceChildren(frag);
}

lineListEl.addEventListener("click", (event) => {
  const row = event.target.closest(".line-row");
  if (!row) return;
  const order = Number(row.dataset.order);
  const copyBtn = event.target.closest(".line-copy");
  const geminiBtn = event.target.closest(".line-gemini");
  if (!copyBtn && !geminiBtn) return;
  markLastLine(order);
  if (copyBtn) copyWithFeedback(copyBtn, currentSubtitles[order - 1]?.text || "", { done: "✓", failed: "✕" });
  else askGemini(order);
});

closeFileBtn.addEventListener("click", () => {
  currentFileName = "";
  currentSubtitles = [];
  currentRawText = "";
  clearLastFile();
  lineListEl.replaceChildren();
  subtitlePanel.hidden = true;
  findPanel.scrollIntoView({ behavior: "smooth", block: "start" });
});

// ===== 複製到剪貼簿 =====
// navigator.clipboard 在少數情況會被拒（非安全來源、權限被關），退回舊的 execCommand。
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_error) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (_e) {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

const copyLabelTimers = new WeakMap();

async function copyWithFeedback(button, text, { done = "已複製！", failed = "複製失敗" } = {}) {
  if (!text) return;
  // 連點時不能把「已複製！」當成原本的字存起來
  if (!copyLabelTimers.has(button)) button.dataset.label = button.textContent;
  clearTimeout(copyLabelTimers.get(button));
  const ok = await copyText(text);
  button.textContent = ok ? done : failed;
  copyLabelTimers.set(button, setTimeout(() => {
    button.textContent = button.dataset.label;
    copyLabelTimers.delete(button);
  }, 1500));
  return ok;
}

// ===== kitsunekko 匯入 =====
// kitsunekko 沒有 CORS header，公開代理（allorigins、codetabs、cors.eu.org…）實測全部被它回 403（擋機房 IP），
// 所以「這個頁面直接 fetch kitsunekko」這條路不存在。改成：
//   1. 這個頁面用 window.open 開 kitsunekko（保留 window.opener）
//   2. 使用者在 kitsunekko 頁面上按書籤小工具，它在每個檔案旁加一顆按鈕
//   3. 按下去時 fetch 是在 kitsunekko 自己的 origin 上跑（同源、用使用者自己的 IP），抓到 bytes 再 postMessage 回來
// 詳見 DESIGN.md §22。手機上書籤幾乎不能用，改走 Jimaku（kitsunekko 的字幕大多也在那裡）。

// 這個函式會被 toString() 塞進書籤網址，在 kitsunekko 的頁面上執行：
// 不能引用外面任何變數，也不能用這個檔案裡的工具函式。
function kitsunekkoBookmarklet() {
  if (!/(^|\.)kitsunekko\.net$/.test(location.hostname)) {
    alert("請在 kitsunekko.net 的字幕資料夾頁面上按這個書籤。");
    return;
  }
  const target = window.opener;
  if (!target || target.closed) {
    alert("找不到字幕工具的分頁。請回到字幕工具，按「開啟 kitsunekko」從那裡開這個分頁，再按一次書籤。");
    return;
  }
  if (document.getElementById("jst-kitsu-bar")) return; // 重複按書籤不要長出兩排按鈕

  const links = [...document.querySelectorAll("#flisttable a[href]")]
    .filter((a) => !a.getAttribute("href").includes("dirlist.php"));
  if (links.length === 0) {
    alert("這一頁沒有可下載的檔案。請先點進某部作品的資料夾，再按一次書籤。");
    return;
  }

  const bar = document.createElement("div");
  bar.id = "jst-kitsu-bar";
  bar.textContent = "📥 字幕工具：每個檔案旁的按鈕會把檔案送回字幕工具的分頁（換頁後要再按一次書籤）";
  bar.style.cssText = "position:sticky;top:0;z-index:9999;background:#2563eb;color:#fff;padding:8px 12px;font:14px sans-serif;";
  document.body.prepend(bar);

  const pending = new Map();
  let seq = 0;
  window.addEventListener("message", (event) => {
    if (event.source !== target) return;
    const msg = event.data;
    if (!msg || msg.type !== "jst-kitsunekko-ack" || !pending.has(msg.id)) return;
    const btn = pending.get(msg.id);
    pending.delete(msg.id);
    btn.disabled = false;
    btn.textContent = (msg.ok ? "✓ " : "✕ ") + msg.message;
  });

  links.forEach((a) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "📥 送到字幕工具";
    btn.style.cssText = "margin-left:8px;padding:2px 8px;font-size:12px;cursor:pointer;";
    a.insertAdjacentElement("afterend", btn);
    // 根目錄有好幾百 MB 的整包封存檔，別傻傻下載完才被字幕工具拒絕。
    // 上限要跟 KITSUNEKKO_MAX_BYTES 一致（這裡不能引用外面的常數）。
    const size = Number(a.closest("tr")?.querySelector("td.tdleft")?.title);
    if (size > 20 * 1024 * 1024) {
      btn.disabled = true;
      btn.textContent = "檔案太大，請自行下載";
      return;
    }
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      if (target.closed) {
        btn.textContent = "字幕工具的分頁已經關掉了";
        return;
      }
      btn.disabled = true;
      btn.textContent = "下載中…";
      try {
        const res = await fetch(a.href);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.arrayBuffer();
        const id = ++seq;
        pending.set(id, btn);
        const name = a.textContent.trim() || decodeURIComponent(a.pathname.split("/").pop());
        target.postMessage({ type: "jst-kitsunekko-file", id, name, data }, "*", [data]);
        btn.textContent = "已送出，等字幕工具回應…";
        setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          btn.disabled = false;
          btn.textContent = "字幕工具沒有回應（分頁還開著嗎？）";
        }, 20000);
      } catch (error) {
        btn.disabled = false;
        btn.textContent = "下載失敗：" + error.message;
      }
    });
  });
}

kitsuBookmarklet.href = "javascript:" + encodeURIComponent(`(${kitsunekkoBookmarklet.toString()})()`);
kitsuBookmarklet.addEventListener("click", (event) => {
  event.preventDefault();
  showKitsuStatus("這顆要用「拖」的：按住它拖到書籤列放開。之後在 kitsunekko 的頁面上點書籤列的那一顆。");
});

let kitsunekkoWindow = null;

openKitsunekkoBtn.addEventListener("click", () => {
  // 不能加 noopener：書籤小工具就是靠 window.opener 找回這個分頁
  kitsunekkoWindow = window.open(KITSUNEKKO_URL, "jst-kitsunekko");
  if (!kitsunekkoWindow) showKitsuStatus("瀏覽器擋掉了新分頁，請允許這個網站開啟彈出視窗。");
});

function showKitsuStatus(message) {
  kitsuStatus.hidden = false;
  kitsuStatus.textContent = message;
}

// 檔名會拿來在工作資料夾建檔，要先去掉路徑與檔案系統不接受的字元
function sanitizeFileName(name) {
  const base = String(name || "").split(/[\\/]/).pop().replace(/[<>:"|?*\u0000-\u001f]/g, "_").trim();
  return base.replace(/^\.+/, "").slice(0, 200) || "subtitle.srt";
}

// 最小的 zip 讀取器：只處理 kitsunekko 上會出現的情況（stored / deflate、無加密、非 zip64）。
// 解壓靠瀏覽器內建的 DecompressionStream，不需要外部套件。只解出字幕檔，其他項目連解壓都不做。
async function extractSubtitlesFromZip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 zip 檔");

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("zip 目錄損毀");
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
    // bit 11 = 檔名是 UTF-8；沒設的話日文 zip 多半是 Shift_JIS
    const name = flags & 0x800 ? new TextDecoder("utf-8").decode(nameBytes) : decodeSubtitleBytes(nameBytes);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/") || name.startsWith("__MACOSX/") || !SUBTITLE_EXT_RE.test(name)) continue;
    if (flags & 0x1) throw new Error("zip 有加密，沒辦法解開");

    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const comp = bytes.subarray(start, start + compSize);
    let data;
    if (method === 0) {
      data = comp;
    } else if (method === 8) {
      const stream = new Blob([comp]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      data = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      throw new Error(`不支援的 zip 壓縮方式（${method}）`);
    }
    out.push({ name: sanitizeFileName(name), text: decodeSubtitleBytes(data) });
  }
  return out;
}

async function importDownloadedSubtitle(rawName, buffer) {
  const name = sanitizeFileName(rawName);
  let files;
  if (/\.zip$/i.test(name)) {
    files = await extractSubtitlesFromZip(buffer);
    if (files.length === 0) throw new Error("zip 裡沒有字幕檔");
  } else if (/\.(rar|7z)$/i.test(name)) {
    throw new Error("不支援 .rar / .7z");
  } else if (SUBTITLE_EXT_RE.test(name)) {
    files = [{ name, text: decodeSubtitleBytes(buffer) }];
  } else {
    throw new Error("不是支援的字幕格式");
  }

  // zip 裡有好幾集時不替使用者決定，列出來讓他挑
  if (files.length > 1) {
    showArchiveChooser(name, files);
    return `zip 裡有 ${files.length} 個字幕檔，請在「找字幕」選一個`;
  }
  loadSubtitles(files[0].name, files[0].text);
  return `已開啟 ${files[0].name}`;
}

// 一次只處理一個，連按好幾個檔案時才不會搶著寫同一個檔名（kitsunekko 與 Jimaku 共用）
let importQueue = Promise.resolve();

function enqueueImport(job) {
  const run = importQueue.then(job);
  importQueue = run.catch(() => {});
  return run;
}

window.addEventListener("message", (event) => {
  if (!KITSUNEKKO_ORIGIN_RE.test(event.origin)) return;
  const msg = event.data;
  if (!msg || msg.type !== "jst-kitsunekko-file") return;
  const reply = (ok, message) => {
    event.source?.postMessage({ type: "jst-kitsunekko-ack", id: msg.id, ok, message }, event.origin);
  };
  // 用 toString 判斷而不是 instanceof：跨 realm（例如測試環境）的 ArrayBuffer 用 instanceof 會判斷錯
  if (Object.prototype.toString.call(msg.data) !== "[object ArrayBuffer]" || typeof msg.name !== "string") {
    return reply(false, "資料格式不對");
  }
  if (msg.data.byteLength > KITSUNEKKO_MAX_BYTES) return reply(false, "檔案太大");

  enqueueImport(async () => {
    showKitsuStatus(`收到 ${msg.name}，處理中…`);
    try {
      const message = await importDownloadedSubtitle(msg.name, msg.data);
      showKitsuStatus(`kitsunekko：${message}`);
      reply(true, message);
    } catch (error) {
      console.error("kitsunekko 匯入失敗", error);
      showKitsuStatus(`kitsunekko：${msg.name} 匯入失敗：${error.message}`);
      reply(false, error.message);
    }
  });
});

// ===== Jimaku 搜尋（在這個頁面裡直接搜尋、下載）=====
// Jimaku 的 API 有開 CORS（任何 origin 都回 Access-Control-Allow-Origin），下載網址也是 *，
// 所以不需要 kitsunekko 那套書籤。代價是搜尋要 API key（免費註冊就有），下載不用。
// kitsunekko 的字幕大多也被收進 Jimaku（作品標「External」），手機上就靠這條路。詳見 DESIGN.md §24。
let jimakuKey = "";
try {
  jimakuKey = localStorage.getItem(JIMAKU_KEY_STORAGE_KEY) || "";
} catch (_error) {
  // 讀不到就當沒設定
}

// 「找字幕」卡片目前顯示什麼：搜尋結果 → 某部作品的檔案 → 某個 zip 裡的檔案
const findView = { entries: null, entry: null, files: null, archive: null };

// 記住上一次的搜尋，重新整理或手機分頁被收掉後回到同一個畫面，不用再搜一次（也省 Jimaku 的請求次數）。
// 只存清單的中繼資料（作品名、檔名、大小、下載網址）；zip 解出來的內容是字幕本身，不存
function saveLastSearch() {
  if (!findView.entries) return;
  const pickEntry = (e) => ({ id: e.id, name: e.name, english_name: e.english_name, japanese_name: e.japanese_name, flags: e.flags });
  const data = {
    savedAt: Date.now(),
    query: findView.query || "",
    entries: findView.entries.map(pickEntry),
    entry: findView.entry ? pickEntry(findView.entry) : null,
    files: findView.files ? findView.files.map((f) => ({ name: f.name, size: f.size, url: f.url })) : null,
    hiddenAss: findView.hiddenAss || 0,
  };
  try {
    localStorage.setItem(JIMAKU_LAST_STORAGE_KEY, JSON.stringify(data));
  } catch (_error) {
    // 存不進去就算了，只是下次要重新搜尋
  }
}

function restoreLastSearch() {
  let data = null;
  try {
    data = JSON.parse(localStorage.getItem(JIMAKU_LAST_STORAGE_KEY) || "null");
  } catch (_error) {
    return;
  }
  if (!data || !Array.isArray(data.entries)) return;
  Object.assign(findView, {
    query: data.query || "",
    entries: data.entries,
    entry: data.entry || null,
    files: Array.isArray(data.files) ? data.files : null,
    hiddenAss: data.hiddenAss || 0,
    archive: null,
  });
  jimakuQuery.value = findView.query;
  const when = new Date(data.savedAt || Date.now()).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const where = findView.files && findView.entry ? `，停在「${findView.entry.japanese_name || findView.entry.name}」的檔案清單` : "";
  setFindStatus(`上次（${when}）搜尋「${findView.query}」的結果${where}。`);
  renderFindView();
}

function setFindStatus(message) {
  findStatus.hidden = !message;
  findStatus.textContent = message || "";
}

function renderJimakuKey() {
  jimakuKeyInput.value = jimakuKey;
  jimakuKeySummary.textContent = jimakuKey ? "Jimaku API Key：已設定" : "Jimaku API Key：還沒設定（搜尋前要先設定）";
  // 還沒設定時直接展開，不然手機上很難發現要先填這個
  jimakuKeyDetails.open = !jimakuKey;
}

jimakuKeySaveBtn.addEventListener("click", () => {
  const value = jimakuKeyInput.value.trim();
  if (!value) {
    setFindStatus("請先貼上 Jimaku 的 API Key。");
    return;
  }
  jimakuKey = value;
  try {
    localStorage.setItem(JIMAKU_KEY_STORAGE_KEY, value);
    setFindStatus("");
  } catch (_error) {
    setFindStatus("這個瀏覽器不讓存，重新整理後要再貼一次。");
  }
  renderJimakuKey();
});

jimakuKeyClearBtn.addEventListener("click", () => {
  jimakuKey = "";
  try {
    localStorage.removeItem(JIMAKU_KEY_STORAGE_KEY);
  } catch (_error) {
    // 本來就沒存進去
  }
  renderJimakuKey();
});

async function jimakuGet(path) {
  if (!jimakuKey) throw new Error("請先在上面的「Jimaku API Key」貼上 key 再搜尋。");
  let response;
  try {
    response = await fetch(`${JIMAKU_API}${path}`, {
      headers: { Authorization: jimakuKey, "X-Client-Id": JIMAKU_CLIENT_ID },
    });
  } catch (error) {
    throw new Error(`連不到 Jimaku：${error.message}`);
  }
  if (response.status === 401) throw new Error("Jimaku 不接受這把 API Key，請重新貼一次。");
  if (response.status === 429) throw new Error("Jimaku 的請求次數暫時用完了（以 IP 計算），等一分鐘再試。");
  if (!response.ok) throw new Error(`Jimaku 回傳錯誤（${response.status}）`);
  return response.json();
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// 可以直接開的格式：字幕檔或 zip；rar / 7z 瀏覽器解不開
function downloadableReason(name, size) {
  if (/\.(rar|7z)$/i.test(name)) return "不支援 .rar／.7z";
  if (!SUBTITLE_EXT_RE.test(name) && !/\.zip$/i.test(name)) return "不支援的格式";
  if (size > KITSUNEKKO_MAX_BYTES) return "檔案太大";
  return "";
}

function makeFindRow({ title, sub, meta, disabledReason, onClick }) {
  const li = document.createElement("li");
  li.className = "file-row find-row";
  li.innerHTML = `
    <span class="find-row-main">
      <span class="file-row-name">${escapeHtml(title)}</span>
      ${sub ? `<span class="find-row-sub">${escapeHtml(sub)}</span>` : ""}
    </span>
    <span class="file-row-progress">${escapeHtml(disabledReason || meta || "")}</span>
  `;
  if (disabledReason) {
    li.classList.add("is-disabled");
    li.setAttribute("aria-disabled", "true");
  } else {
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    li.addEventListener("click", onClick);
    li.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onClick();
      }
    });
  }
  return li;
}

function renderFindView() {
  findListEl.replaceChildren();
  const { entries, entry, files, archive } = findView;
  findBackBtn.hidden = !(archive && (files || entries)) && !(files && entries);

  if (archive) {
    findBackBtn.textContent = files ? `← 回到 ${entry?.name || "檔案清單"}` : "← 回到搜尋結果";
    archive.files.forEach((file) => {
      findListEl.appendChild(makeFindRow({
        title: file.name,
        meta: "開啟",
        onClick: () => openFromArchive(file),
      }));
    });
    return;
  }

  if (files) {
    findBackBtn.textContent = "← 回到搜尋結果";
    if (files.length === 0) {
      findListEl.innerHTML = `<li class="file-row-empty">這部作品還沒有檔案。</li>`;
      return;
    }
    files.forEach((file) => {
      findListEl.appendChild(makeFindRow({
        title: file.name,
        meta: formatSize(file.size),
        disabledReason: downloadableReason(file.name, file.size),
        onClick: () => downloadJimakuFile(file),
      }));
    });
    return;
  }

  if (entries) {
    if (entries.length === 0) {
      findListEl.innerHTML = `<li class="file-row-empty">找不到符合的作品，換個名稱（日文／羅馬字／英文）試試。</li>`;
      return;
    }
    entries.forEach((item) => {
      const tags = [item.flags?.movie ? "電影" : item.flags?.anime ? "動畫" : "影劇", item.flags?.external ? "External" : ""]
        .filter(Boolean)
        .join("・");
      const altNames = [item.name, item.english_name].filter((n) => n && n !== (item.japanese_name || item.name));
      findListEl.appendChild(makeFindRow({
        title: item.japanese_name || item.name,
        sub: altNames.join(" / "),
        meta: tags,
        onClick: () => openJimakuEntry(item),
      }));
    });
  }
}

jimakuSearchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = jimakuQuery.value.trim();
  if (!query) {
    setFindStatus("請輸入作品名稱。");
    return;
  }
  jimakuQuery.blur(); // 手機上收起鍵盤，才看得到結果
  jimakuSearchBtn.disabled = true;
  setFindStatus("搜尋中…");
  try {
    const entries = await jimakuGet(`/entries/search?query=${encodeURIComponent(query)}`);
    Object.assign(findView, { query, entries: Array.isArray(entries) ? entries.slice(0, 50) : [], entry: null, files: null, hiddenAss: 0, archive: null });
    setFindStatus(findView.entries.length ? `找到 ${entries.length} 部作品${entries.length > 50 ? "（只列前 50 部）" : ""}，點一部看檔案。` : "");
    renderFindView();
    saveLastSearch();
  } catch (error) {
    setFindStatus(error.message);
    if (!jimakuKey) jimakuKeyDetails.open = true;
  } finally {
    jimakuSearchBtn.disabled = false;
  }
});

// 同一部作品常同時有 .srt（串流平台的乾淨台詞）和字幕組的 .ass（夾雜特效、招牌字）。
// 有 .srt 就不列 .ass／.ssa；排序：.srt → 其他能開的（zip、vtt…）→ 不支援的，同一組內依集數自然排序
function arrangeJimakuFiles(files) {
  const all = Array.isArray(files) ? files : [];
  const hasSrt = all.some((f) => /\.srt$/i.test(f.name));
  const list = hasSrt ? all.filter((f) => !/\.(ass|ssa)$/i.test(f.name)) : all.slice();
  const rank = (f) => (/\.srt$/i.test(f.name) ? 0 : downloadableReason(f.name, f.size) ? 2 : 1);
  list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { list, hiddenAss: all.length - list.length };
}

async function openJimakuEntry(entry) {
  setFindStatus(`讀取「${entry.japanese_name || entry.name}」的檔案…`);
  try {
    const { list, hiddenAss } = arrangeJimakuFiles(await jimakuGet(`/entries/${encodeURIComponent(entry.id)}/files`));
    Object.assign(findView, { entry, files: list, hiddenAss, archive: null });
    saveLastSearch();
    const hiddenNote = hiddenAss ? `（有 .srt，所以略過 ${hiddenAss} 個 .ass）` : "";
    setFindStatus(`${entry.japanese_name || entry.name}：${list.length} 個檔案${hiddenNote}，點一個就會打開。`);
    renderFindView();
    findPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    setFindStatus(error.message);
  }
}

function downloadJimakuFile(file) {
  return enqueueImport(async () => {
    setFindStatus(`下載 ${file.name}…`);
    try {
      const response = await fetch(new URL(file.url, "https://jimaku.cc/").href);
      if (!response.ok) throw new Error(`下載失敗（${response.status}）`);
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > KITSUNEKKO_MAX_BYTES) throw new Error("檔案太大");
      setFindStatus(await importDownloadedSubtitle(file.name, buffer));
    } catch (error) {
      console.error("Jimaku 下載失敗", error);
      setFindStatus(`${file.name}：${error.message}`);
    }
  });
}

// zip 裡有好幾個檔時，列出來讓使用者挑一集
function showArchiveChooser(archiveName, files) {
  findView.archive = { name: archiveName, files };
  setFindStatus(`${archiveName} 裡有 ${files.length} 個字幕檔，點一個打開：`);
  renderFindView();
  findPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function openFromArchive(file) {
  loadSubtitles(file.name, file.text);
  setFindStatus(`已開啟 ${file.name}`);
}

findBackBtn.addEventListener("click", () => {
  if (findView.archive) findView.archive = null;
  else if (findView.files) Object.assign(findView, { entry: null, files: null, hiddenAss: 0 });
  setFindStatus("");
  renderFindView();
  saveLastSearch();
});

// ===== 用 Gemini 解說一段 =====
// Gemini 沒有「帶入提示詞」的方法（2026-10 查證）：網頁版的 ?q= 只有第三方桌機擴充功能做得到；
// 手機 App 沒有可帶文字的 deep link，Android 分享選單只收圖片／檔案、iOS 沒有分享擴充功能。
// 所以網頁版的做法是：複製到剪貼簿 → 開 Gemini → 使用者貼上送出；iOS 改走捷徑（見下面的 askGemini 與 DESIGN.md §27）。
// 怎麼解說交給使用者在 Gemini 設好的個人化設定：網頁版只送「解說日文：」＋原句，捷徑只送原句（捷徑自己會加前綴）。
// 複製要在 window.open 之前「開始」：開新分頁後這頁失去焦點，剪貼簿 API 會拒絕。
const GEMINI_WEB_PREFIX = "解說日文：";

let toastTimer = null;

function showToast(message, ms = 5000) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, ms);
}

// ===== Gemini 開啟方式：iOS 捷徑（一鍵）或網頁版（複製後開啟）=====
// iPhone／iPad 上可以用捷徑的 URL scheme 直接跑使用者自己的捷徑並把文字傳進去：
//   shortcuts://run-shortcut?name=<捷徑名稱>&input=text&text=<文字>（Apple 官方文件）
// 捷徑裡用 Gemini App 提供的「Ask Gemini」動作，就能真正一鍵帶入提示詞（見 DESIGN.md §27）。
function readSetting(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch (_error) {
    return fallback;
  }
}

function writeSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_error) {
    // 存不進去就只在這次有效
  }
}

let geminiMode = readSetting(GEMINI_MODE_KEY, IS_IOS ? "shortcut" : "web") === "shortcut" ? "shortcut" : "web";
let shortcutName = readSetting(SHORTCUT_NAME_KEY, DEFAULT_SHORTCUT_NAME);

function renderGeminiMode() {
  geminiModeRadios.forEach((radio) => {
    radio.checked = radio.value === geminiMode;
  });
  shortcutNameInput.value = shortcutName;
  shortcutNameInput.disabled = geminiMode !== "shortcut";
  geminiModeSummary.textContent = geminiMode === "shortcut"
    ? `Gemini 開啟方式：iOS 捷徑「${shortcutName}」`
    : "Gemini 開啟方式：網頁版（複製後開啟）";
}

geminiModeRadios.forEach((radio) => {
  radio.addEventListener("change", () => {
    geminiMode = radio.value === "shortcut" ? "shortcut" : "web";
    writeSetting(GEMINI_MODE_KEY, geminiMode);
    renderGeminiMode();
  });
});

shortcutNameInput.addEventListener("change", () => {
  shortcutName = shortcutNameInput.value.trim() || DEFAULT_SHORTCUT_NAME;
  writeSetting(SHORTCUT_NAME_KEY, shortcutName);
  renderGeminiMode();
});

// 獨立成函式：自訂 scheme 不會讓這頁離開（字幕還在記憶體裡），測試也能換掉它
function launchUrl(url) {
  window.location.href = url;
}

function askGemini(order) {
  const sub = currentSubtitles[order - 1];
  if (!sub) return;

  // 捷徑模式只傳日文原句：使用者的捷徑／Gemini 已經有個人化設定，知道要怎麼解說。
  // 也先複製同一段，捷徑沒收到輸入時會改讀剪貼簿
  if (geminiMode === "shortcut") {
    copyText(sub.text);
    launchUrl(`shortcuts://run-shortcut?name=${encodeURIComponent(shortcutName)}&input=text&text=${encodeURIComponent(sub.text)}`);
    showToast(`用捷徑「${shortcutName}」開 Gemini…（Safari 問要不要打開「捷徑」時按「打開」）`, 6000);
    return;
  }

  // 網頁版：「解說日文：」＋原句，對應使用者在 Gemini 設好的個人化設定
  const copied = copyText(`${GEMINI_WEB_PREFIX}${sub.text}`);

  const win = window.open(GEMINI_WEB_URL, "_blank");
  if (win) win.opener = null; // 不讓 Gemini 那邊拿到這個分頁
  copied.then((ok) => {
    if (!ok) {
      showToast("瀏覽器不讓自動複製。請先按 📋 複製這段，到 Gemini 輸入「解說日文：」後貼上。", 8000);
    } else if (!win) {
      showToast("已複製，但新分頁被擋掉了：請自己打開 Gemini，在輸入框貼上送出。", 8000);
    } else {
      // 手機、平板沒有滑鼠：有裝 Gemini App 的話系統會直接用 App 開，貼上要長按輸入框
      const touch = window.matchMedia?.("(hover: none)").matches;
      showToast(touch
        ? `已複製「解說日文：第 ${order} 段」。在 Gemini 輸入框長按 →「貼上」→ 送出。`
        : `已複製「解說日文：第 ${order} 段」。在 Gemini 輸入框按 Ctrl/⌘+V 貼上、送出。`);
    }
  });
}

// ===== 上次打開的字幕（只存這一個）=====
// 重新整理、或手機把分頁收掉之後，回到上次打開的字幕與上次按過的那一段。
// 只存一個檔（新的蓋掉舊的），字幕檔通常幾十～幾百 KB，放 localStorage 就夠；太大存不進去就算了。
function saveLastFile(line) {
  if (!currentFileName) return;
  try {
    localStorage.setItem(LAST_FILE_KEY, JSON.stringify({ name: currentFileName, text: currentRawText, line, savedAt: Date.now() }));
  } catch (error) {
    console.warn("上次打開的字幕太大，沒有存", error);
    clearLastFile();
  }
}

function clearLastFile() {
  try {
    localStorage.removeItem(LAST_FILE_KEY);
  } catch (_error) {
    // 本來就沒存
  }
}

function markLastLine(order) {
  lineListEl.querySelector(".line-row.is-last")?.classList.remove("is-last");
  lineListEl.querySelector(`.line-row[data-order="${order}"]`)?.classList.add("is-last");
  saveLastFile(order);
}

function restoreLastFile() {
  let data = null;
  try {
    data = JSON.parse(localStorage.getItem(LAST_FILE_KEY) || "null");
  } catch (_error) {
    clearLastFile();
    return;
  }
  if (!data || typeof data.name !== "string" || typeof data.text !== "string") return;
  if (!loadSubtitles(data.name, data.text, { scroll: false, save: false })) return;
  const row = Number.isInteger(data.line) && lineListEl.querySelector(`.line-row[data-order="${data.line}"]`);
  if (row) {
    row.classList.add("is-last");
    // 自己捲到上次那一段，不讓瀏覽器的捲動還原跟我們搶
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
    row.scrollIntoView({ block: "center" });
  }
}

// ===== 啟動 =====
renderJimakuKey();
renderGeminiMode();
restoreLastSearch();
restoreLastFile();
// 舊版（§28 初版）曾把所有打開過的字幕存在 IndexedDB 的 jst-library，現在用不到了，清掉釋放空間
try {
  window.indexedDB?.deleteDatabase("jst-library");
  localStorage.removeItem("jst_last_opened_v1");
} catch (_error) {
  // 沒有就算了
}
