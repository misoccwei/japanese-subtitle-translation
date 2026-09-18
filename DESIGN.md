# 設計理念說明

這份文件記錄這個小工具的設計決策與原因，之後要修改功能時可以先看這份文件，不用重新跟 AI 從頭解釋需求。

## 專案目的

選一個工作資料夾 → 點裡面的日文字幕檔（支援 `.srt` / `.vtt` / `.ass` / `.ssa` / `.sbv` / `.txt`）→ 自動拆解成逐句台詞（只保留文字與順序，不留時間軸）→ **點哪一句才解說哪一句**，呼叫 Gemini API 做「中文翻譯 + N3 以上單字/動詞拆解 + 文法說明」→ 以彈出視窗呈現 → 解說紀錄寫進同資料夾的 `<字幕檔名>.notes.json` → 可用瀏覽器列印功能把所有已解說的句子另存為 PDF。

純前端（HTML + CSS + 原生 JS），無框架、無建置流程，**雙擊 `index.html`、用 VS Code Live Server、或部署成 GitHub Pages 都可以**（細節與實測結果見 §14、§21）。

## 檔案結構

- `index.html` — 頁面結構：工作資料夾面板、字幕清單 `#lineList`、解說彈窗 `#noteDialog`、列印區 `#printArea`
- `style.css` — 卡片式 UI 樣式，含 `@media print` 專用列印樣式
- `app.js` — 所有邏輯：資料夾存取、notes 檔讀寫、字幕解析、Gemini 呼叫、清單/彈窗渲染、PDF 列印
- `.vscode/settings.json` — 只有在用 Live Server 時才需要，把埠釘死在 5500（原因見 §14）
- `DESIGN.md` — 本文件（設計決策與原因）
- `README.md` — 給 repo 讀者看的使用/部署說明
- `.github/workflows/deploy.yml` — GitHub Pages 部署（見 §21）
- `.gitignore` — 擋掉字幕檔與 `*.notes.json`（都是個人資料，不進版控）

## 核心設計決策

### 1. API Key 由使用者輸入，存在 localStorage（**推翻原本的「寫死在 app.js」**）

**原本的做法**：使用者要求把 Gemini API Key 直接寫在 `app.js` 的 `GEMINI_API_KEY` 常數，不做輸入欄位。方便，但 key 明碼躺在檔案裡，那份資料夾不能公開分享。

**改掉的原因**：專案要部署到 GitHub Pages。GitHub Pages 服務的是靜態原始檔，`app.js` 會被完整下載到每一個訪客的瀏覽器 —— 寫死的 key 等於貼在網路上（而且 Google 的 secret scanner 通常幾分鐘內就會偵測到並停用它）。「不要 commit key」在公開部署的專案裡不是建議，是硬性條件。

**現在的做法**（[app.js](app.js) 開頭 + `// ===== API Key 面板 =====` 區塊）：
- 頁面第一張卡片 `#apiKeyPanel` 讓使用者貼上自己的 key，存進 `localStorage`（`jst_api_key_v1`）
- `GEMINI_ENDPOINT` 常數改成 `geminiEndpoint()` 函式 —— key 會在執行期變動（使用者隨時可以改／清除），常數在載入時就算好會停在舊值
- 顯示時遮碼（`maskKey()`，頭 4 尾 4），有「顯示 / 隱藏 / 清除」三顆按鈕
- `localStorage` 讀寫都包 try/catch：無痕模式或停用 cookie 時讀不到／存不進去，此時仍可用（key 只活在記憶體裡），狀態列會明講「重新整理後要再貼一次」
- 沒有 key 時 `callGeminiBatchWithAutoRetry()` 直接丟帶 `noRetry` 旗標的錯誤並顯示在錯誤欄，**不進重試迴圈也不記 usage** —— 重試 4 次一樣沒有 key，純粹浪費時間
- 收到 400/403 且錯誤內容含 `API_KEY_INVALID` / `PERMISSION_DENIED` 時，也標 `noRetry` 並顯示人話訊息，而不是把整坨 Google 的 JSON 丟給使用者

**`noRetry` 旗標**：`callGeminiBatchWithAutoRetry()` 原本的判斷是「沒有 HTTP status 就當網路錯誤 → 可重試」。缺 key 的錯誤正好沒有 status，會被誤判成可重試，所以加了這個旗標讓「重試也不會好」的錯誤可以明確跳過重試迴圈。

**剩下的取捨**：key 存在 `localStorage`，任何能在這個 origin 執行 JS 的東西都讀得到。這是純前端、無後端架構的必然結果 —— 要真正藏住 key 就得架一台代理伺服器，那是另一個量級的專案。共用電腦請用完按「清除」。

### 2. PDF 匯出用瀏覽器原生列印，不用外部套件

`下載 PDF` 按鈕只是呼叫 `window.print()`，實際輸出靠 `style.css` 裡的 `@media print` 規則：
- `.no-print` 的元素（輸入區、按鈕、狀態列）在列印時隱藏
- 只有 `#printArea`（包住 `#results`）會被印出
- 卡片加 `page-break-inside: avoid`，避免分頁時卡片被硬切開

**為什麼不用 html2canvas + jsPDF**：那樣是把畫面截圖轉圖片再拼 PDF，中日文字型容易模糊、檔案較大、還要引入外部套件。瀏覽器原生列印是用真的文字渲染，字體清晰、零依賴，缺點是使用者要自己在列印視窗按「另存為 PDF」（多一步，但可接受）。

### 3. Gemini 模型名稱會一直變動，要留意

目前用的是 `GEMINI_MODEL` 常數（[app.js](app.js) 開頭），現在設定為 `gemini-3.6-flash`。

**背景**：一開始用 `gemini-1.5-flash`，後來改 `gemini-2.5-flash`，結果幾個月後 Google 又把它下架，API 回傳 404 並在錯誤訊息裡直接告知「請改用 models/gemini-3.6-flash」。
**教訓**：Gemini 的模型代號汰換很快，之後如果又跳出 404 + `NOT_FOUND` 錯誤，**直接看錯誤訊息裡 Google 建議的新模型名稱**，改掉 `GEMINI_MODEL` 這一行常數即可，不用改其他程式碼（endpoint 是用樣板字串組出來的）。

### 4. 批次呼叫（batching），且嚴格循序執行 + 批次間固定停頓

字幕不是一句一次 API 呼叫，而是每 `BATCH_SIZE`（預設 8 句）包成一批，一次請求要 Gemini 回傳一個「JSON 陣列」，陣列順序對應句子順序。

**為什麼批次**：字幕可能有上百句，逐句呼叫太慢、太容易撞到 API 的每分鐘請求數限制（RPM）。打包後 API 呼叫次數大幅減少。

**為什麼嚴格循序（batch N+1 要等 batch N 完成才發送）**：
- `handleStart()` 裡的迴圈用 `for` + `await runBatch(...)`，不是 `Promise.all` 或並發呼叫
- 避免同時炸出一堆併發請求觸發 RPM/併發數限制
- 讓使用者可以清楚看到「處理中… 第 N/M 批」的進度

**批次之間額外固定停頓 `BATCH_DELAY_MS`（目前 1.5 秒）**：使用者明確要求「不需要太快，需要穩定」，所以每批成功/失敗處理完，都會先 `sleep(1500ms)` 再送下一批，刻意犧牲總處理時間換取穩定性、降低觸發限流的機率。

**批次大小 `BATCH_SIZE`**：目前是 8。如果常常遇到單批 JSON 太長被截斷或解析失敗，可以調小（例如 5）；如果想再減少 API 呼叫次數，可以調大，但風險是單次回應變長、模型更容易漏掉某幾句或格式跑掉。

### 5. 失敗處理：先自動延遲重試（暫時性錯誤），全部重試失敗才顯示手動「重試此批次」按鈕

**背景**：曾實際遇到 Gemini 回傳 `503 UNAVAILABLE`（"currently experiencing high demand... try again later"），這類錯誤本質是暫時性的，過幾秒重試通常就會成功，不需要使用者手動介入。

目前邏輯（`callGeminiBatchWithAutoRetry()`，[app.js](app.js)）：
- 只對「暫時性錯誤」自動重試：HTTP 429 / 500 / 502 / 503 / 504，以及沒有 HTTP status 的網路層錯誤（fetch 直接 throw）
- 採遞增延遲：5s → 10s → 15s → 20s（`RETRY_BASE_DELAY_MS * (attempt+1)`），最多自動重試 `MAX_AUTO_RETRIES`（4）次，重試期間會即時更新狀態列文字告知使用者「第 X/4 次自動重試」
- 非暫時性錯誤（例如 400 請求格式錯誤、JSON parse 失敗、API Key 無效等）**不會**自動重試，直接進入手動重試流程，因為重試也不會自己好
- 全部自動重試次數用完仍失敗，才顯示錯誤卡片 + 一顆「重試此批次」按鈕，按下去會重新跑一次完整的 `callGeminiBatchWithAutoRetry`（等於重新歷經一輪自動重試）

**為什麼不是「失敗就馬上顯示按鈕，都靠人工重試」**：503 這種瞬間流量高峰通常幾秒到幾十秒就恢復，讓程式自己等待重試，使用者不需要一直盯著畫面手動點。

**每個批次有自己的 DOM 容器**（`.batch-container`），重試只會重新渲染那個容器，不影響其他已成功的批次。實作位置：[app.js](app.js) 的 `runBatch()` / `renderBatchError()` / `callGeminiBatchWithAutoRetry()`。

**下載 PDF 按鈕**：全部批次都跑完（不論成功或最終失敗顯示重試按鈕）才會 enable，避免字幕還在處理中就被拿去輸出不完整的 PDF。

### 6. Prompt 與 JSON 格式要求

Prompt（`buildPrompt()`）明確要求：
- 回傳「一個 JSON 陣列」，長度必須等於這批句子數、順序要跟輸入一致
- 不能有 markdown code fence（```json）
- 額外用 Gemini 的 `generationConfig.responseMimeType: "application/json"` 強制模型輸出合法 JSON（減少格式跑掉的機率）
- **只講解 N3（含）以上程度的單字/文法**：N4、N5 等基礎內容會被要求略過，若整句都只有基礎內容，`words`/`grammar` 可以回傳空陣列 `[]`（渲染時會顯示「無 N3 以上內容」）

每句的 JSON 結構固定為：
```json
{
  "translation": "中文翻譯",
  "words": [{ "word": "原字（不含假名）", "kana": "假名讀音", "meaning": "中文意思", "note": "詞源/動詞變化/語感等解說" }],
  "grammar": [{ "point": "文法點", "explanation": "接續與情境說明", "example": "例句" }]
}
```
`word` 與 `kana` 是分開的欄位（原本合併成「食べる(たべる)」一欄，後來拆開，方便表格對齊、也方便使用者只看漢字或只看假名）。

渲染時（`renderCard()`）會照這個結構生成 4 欄表格（原字／假名／中文意思／詳細解說）與文法清單，**如果之後要新增欄位（例如「音調」、「例句翻譯」），要同時改 prompt 的 JSON schema 說明和 `renderCard()` 的渲染邏輯，兩邊要一起改**。

### 7. 字幕解析：不保留時間軸，只保留順序；支援多種字幕格式

**不保留時間軸**：使用者要求「字幕檔直接轉成純文字就好，不需要保留時間軸，確保順序正確即可」。所以解析結果不再有 `startTime`/`endTime`，只有 `{ order, text }`，`order` 是這句在整份字幕裡的出現順序（從 1 開始），卡片標頭顯示的是「第 N 句」徽章（`.seq-badge`），不是時間碼。

**多格式支援**（`detectFormat()` + 對應 parser，[app.js](app.js)）：
- `.srt` → `parseSRT()`：序號行（可略過）+ 時間軸行（`-->`，僅用來定位、不保留）+ 文字行
- `.vtt`（WebVTT）→ `parseVTT()`：略過 `WEBVTT` 檔頭、`NOTE`/`STYLE`/`REGION` 區塊，cue 可能有可選的 identifier 行
- `.ass` / `.ssa`（Advanced SubStation Alpha）→ `parseASS()`：讀 `Format:` 那行決定 `Text` 欄位在第幾個逗號之後（避免文字本身含逗號被切錯），並移除 `{...}` 樣式標籤與 `\N` 換行符
- `.sbv`（YouTube 字幕格式）→ `parseSBV()`：辨識 `H:MM:SS.mmm,H:MM:SS.mmm` 這種時間行
- 其他/無法辨識格式（含 `.txt`）→ `parsePlainText()`：每一個非空行當成一句獨立字幕，不做任何時間軸解析

**格式判斷順序**：先看副檔名（`detectFormat()` 裡的 `filename` 參數），副檔名判斷不出來或使用者是用「貼上文字」而非上傳檔案時，退回用內容特徵判斷（`WEBVTT` 開頭、`Dialogue:`、SBV 時間格式、`-->`），都判斷不出來就當純文字逐行處理。

**之後如果要支援更多格式**（例如 `.lrc` 歌詞檔），依樣在 `detectFormat()` 加一個分支、寫一個新的 `parseXXX(text)` 函式回傳字串陣列即可，最後都會經過 `parseSubtitleFile()` 統一轉成 `{ order, text }[]`。

### 8. 檔案上傳按鈕改用自訂樣式

原生 `<input type="file">` 的按鈕在不同瀏覽器長得不一致、風格突兀。做法：
- `input[type=file]` 本身設 `hidden`，用 `<label for="fileInput" class="btn btn-secondary file-upload-btn">` 當作可點擊的按鈕（點 label 會觸發對應的 input）
- 旁邊加一個 `#fileNameDisplay` 顯示目前選了哪個檔案，選檔後由 `handleFileUpload()` 更新文字
- 這樣可以套用跟頁面其他按鈕一致的 `.btn` 樣式，不用自己刻一個全新的元件

### 9. 429（速率/額度限制）：全域冷卻機制 + 右側最新錯誤訊息匡

**背景**：使用者實際遇過 Gemini 回傳 `429`。429 跟前面第 5 點提到的 503 不同：503 通常是「Google 伺服器當下過載」，跟哪個帳號無關；429 則是「這個 API Key/專案本身的請求頻率或額度超過限制」，屬於帳號層級的限制，所以不能只讓「這一批」自己重試，其他批次也該一起暫停，不然只會繼續撞牆、甚至讓限制更嚴重。

做法（[app.js](app.js)）：
- 新增全域變數 `globalCooldownUntil`（一個時間戳記）。任何一批遇到 429 時，就設定 `globalCooldownUntil = 現在時間 + 冷卻秒數`
- 冷卻秒數優先採用 Gemini 錯誤回應裡的 `error.details[].retryDelay`（Google 自己建議的等待時間，例如 `"23s"`），解析函式是 `extractRetryDelaySeconds()`；如果回應裡沒有這個欄位，才退回用固定的 `GLOBAL_COOLDOWN_MS`（30 秒）
- **關鍵**：`callGeminiBatchWithAutoRetry()` 每次要送出請求前（不只是重試時，包括還沒開始的下一批第一次送出請求前）都會先檢查 `globalCooldownUntil`，如果還沒到那個時間點就先 `sleep` 等到冷卻結束，這樣才能真正做到「前面一批撞到 429 沒成功，後面全部批次都先停下來等，而不是各批各自繼續猛打」
- 500/502/503/504 這種非帳號層級的暫時性錯誤，仍維持原本第 5 點的「這一批自己遞增延遲重試」邏輯，不會觸發全域冷卻（沒必要連累其他批次）

**右側「最新錯誤訊息」訊息匡**：新增 `#errorPanel`（固定在畫面右上角、`position: fixed`），只要發生下列任何一種情況就會更新內容並顯示出來：
- 批次進入自動重試倒數（例如「遇到 429，30 秒後自動重試」）
- 批次最終失敗、顯示錯誤卡片+重試按鈕的當下

會顯示「發生時間」＋完整錯誤訊息，並有一個 × 可以自己關掉。螢幕寬度 ≤ 900px 時改成正常版面（不再是 fixed 浮動），避免在手機/小螢幕上遮住內容。實作位置：`showErrorPanel()`、`errorPanel` 相關 DOM 綁定。

**關於 429 本身怎麼處理（不是程式能完全解決的部分）**：429 有兩種常見成因，行為不同：
1. **每分鐘請求數 (RPM) 超過**：短暫的、通常等幾秒到一分鐘就會恢復，上面的自動冷卻機制可以處理
2. **每日/每月配額用完**：免費方案的配額通常要等到隔天（依 Google 的重置時間）才會恢復，這種狀況程式再怎麼重試都沒用，只能等配額重置，或是到 Google AI Studio / Google Cloud Console 檢查用量與方案、視情況升級到付費方案

### 10. 分析結果快取（localStorage）+ 下載 PDF 不用等全部跑完

**背景**：使用者通常不會頻繁換檔案，常常是同一份字幕重新處理（例如頁面重新整理、同樣內容再貼一次、或字幕裡本來就有重複句子）。原本每次都會重新呼叫 Gemini，等於同樣的內容重複問、浪費額度也浪費時間。另外原本「下載 PDF」要等全部批次跑完才能按，使用者現在覺得只要有結果就想先下載，不用等到全部完成。

做法（[app.js](app.js)）：
- 用 `localStorage`（key: `jst_result_cache_v1`）存一個「句子文字 → 分析結果」的對照表，`getCachedResult(text)` / `setCachedResult(text, result)` 是存取介面
- `runBatch()` 在送出一批之前，先把批次裡「文字完全相同、已經有快取」的句子挑出來直接渲染，不佔用 API 額度；只有真正沒快取過的句子才會打包成一批送去 Gemini（`runPendingBatch()`），拿到結果立刻寫回快取
- 重試「重試此批次」按鈕現在只會重試「真正沒拿到結果的那幾句」，已經命中快取或已經成功的句子不會被重新渲染或重新呼叫
- 一批如果整批都命中快取，`runBatch()` 回傳 `false`（代表沒有呼叫 API），外層迴圈就不會多等 `BATCH_DELAY_MS`，全部從快取讀取時幾乎是秒開
- 輸入卡片新增「清除已快取結果」按鈕（`#clearCacheBtn`），按下會跳確認視窗，確認後清空 `localStorage` 裡的快取，之後同樣的句子會重新呼叫 Gemini（用在覺得某次分析結果不理想、想強制重新產生的情況）

**下載 PDF 按鈕改成「有結果就能按」**：不再等到 `handleStart()` 整個迴圈跑完才 enable，而是只要有任何一句成功渲染出卡片（不論是從快取讀出來、還是剛呼叫 API 拿到），就會呼叫 `enableDownloadButton()` 把按鈕打開，之後保持開啟。這跟先前第 5 點「全部批次都跑完才開放下載 PDF」的舊決策是相反的，是使用者事後明確要求改掉的，**如果之後又想改回「全部完成才能下載」，記得同時把這裡的 `enableDownloadButton()` 呼叫拿掉，改回只在 `handleStart()` 迴圈結束後 enable**。

**快取的限制**：
- 快取 key 是句子的「完整文字內容」，不是檔名或整份字幕的雜湊，所以就算是不同檔案，只要某一句日文字完全相同，也會命中快取（多數情況下是好事，但如果同一句話在不同上下文想要不同解說，目前無法區分）
- `localStorage` 有容量上限（通常每個網域 5–10MB），字幕量非常大時有可能寫入失敗；`saveResultCache()` 有包 try/catch，寫入失敗就默默略過、不會讓功能整個掛掉，但那次的結果就不會被快取
- 沒有做快取過期機制，理論上會一直留著，除非使用者自己按「清除已快取結果」

### 11. 本機快取檔案（File System Access API）+ 下載 PDF 改回「全部完成才能按」

**背景**：使用者希望快取結果不要只存在瀏覽器的 localStorage（清瀏覽器資料、換 Chrome Profile 都會遺失），想要存在網頁以外的地方；同時也把先前「有結果就能下載 PDF」的決定改回「整份都跑完才能下載」。使用者在雲端（Google Drive／Firebase）與本機檔案兩種方案中，選了**本機檔案**（不用另外申請帳號、設定 OAuth／Firebase 專案）。

做法（[app.js](app.js)）：
- 用瀏覽器的 **File System Access API**（`window.showSaveFilePicker`）讓使用者自己選一個電腦上的 JSON 檔案（預設檔名 `japanese-subtitle-cache.json`），之後所有快取讀寫都會同步到這個檔案，不再只依賴 localStorage
- 選好的檔案控制代碼（`FileSystemFileHandle`）沒辦法存進 localStorage（無法序列化成字串），所以另外用 **IndexedDB** 存這個 handle（`idbGet`/`idbSet`），這樣重新整理頁面後還能認得之前選過的檔案，不用每次都重新選
- 每次 `saveResultCache()` 被呼叫（新結果寫入快取、或按「清除已快取結果」）時，除了寫 localStorage，也會背景呼叫 `persistCacheToFile()` 把整份 `resultCache` 寫回本機檔案；讀取端則是 `loadCacheFromFile()`，會在連結/重新整理時把檔案內容跟目前記憶體裡的 `resultCache` 合併（衝突時以目前記憶體內的為主，因為比較新）
- 權限模型：瀏覽器對 File System Access 的授權需要「使用者手勢」（點擊）才能要求，所以頁面載入時只會用 `queryPermission()` 被動檢查，如果還沒有權限（例如瀏覽器重啟後被收回），會顯示「尚未連結」或需要使用者按「連結本機快取檔案」按鈕重新授權，無法在背景偷偷跳出授權視窗
- **瀏覽器支援度限制**：只有 Chromium 系瀏覽器（Chrome、Edge）支援這組 API；偵測到不支援時（`supportsFileSystemAccess` 為 false）會隱藏連結按鈕，並在狀態文字顯示提示，此時功能會自動退回「只用 localStorage」，跟改動前的行為一樣，不會整個壞掉
- 換電腦、換瀏覽器都需要重新按一次「連結本機快取檔案」選擇檔案，這是 File System Access 的本質限制（handle 綁定在瀏覽器的來源權限上），不是 bug

**下載 PDF 改回「全部批次都跑完才能按」**：這是使用者這次明確要求改回去的（推翻了前一輪「有結果就能下載」的決定），`handleStart()` 迴圈開頭仍然 `downloadPdfBtn.disabled = true`，但現在要等整個 `for` 迴圈跑完（`runBatch` 的呼叫全部 resolve，不論成功或最終顯示重試按鈕）才會在最後把它設回 `false`，中途不會再提早開放。

**如果之後想換成雲端方案**：使用者當時考慮過 Google Drive（需要 OAuth 用戶端 ID + 同意畫面，且要求使用者每次登入）跟 Firebase Firestore（需要建立 Firebase 專案、開通 Firestore、把 config 貼給我，安全規則需要額外設計）。如果之後想從本機檔案換成這兩種之一，把 `loadCacheFromFile()` / `persistCacheToFile()` 這兩個函式換成對應的雲端讀寫邏輯即可，`getCachedResult()`/`setCachedResult()` 這層介面不需要變動。

### 12. 加大 BATCH_SIZE + 右側錯誤欄即時倒數 429 解除時間

**背景**：使用者常撞到 429，想知道加大批次能不能緩解，也想在右側錯誤欄直接看到「還要多久才解除限制」，而不是只看到一次性的文字訊息。

**加大批次為什麼有幫助**：Gemini 的 429 主要跟兩種額度有關——RPM（每分鐘請求數）跟 RPD（每日請求數）；批次越大，處理同樣句數所需的「請求次數」就越少，等於直接降低撞到 RPM/RPD 限制的機率。而且 prompt 裡的固定說明文字（JSON 結構要求、N3 規則等）是每個「請求」都要重複發送一次，句子塞得越多，這些固定開銷被越多句子分攤，連 TPM（每分鐘 token 數）也會稍微省一點。所以 `BATCH_SIZE` 從 8 調大到 `15`（[app.js](app.js) 開頭）。

**但不是無腦調越大越好**：批次越大，單次回應的 JSON 也越長，模型把整批分析塞進一次回應時，被截斷或格式跑掉的風險會升高（尤其句子本身很長、或單字/文法解說很豐富時）。如果之後改大 `BATCH_SIZE` 後常常遇到「Gemini 回傳的 JSON 陣列長度與句子數量不符」這類解析失敗，就是這個批次大小造成的，把 `BATCH_SIZE` 調小一點即可，這是一個純粹的數字調整、不用改其他邏輯。

**右側錯誤欄即時倒數 429 解除時間**：新增 `#errorPanelCountdown`（[index.html](index.html) 的 `errorPanel` 裡）跟對應的 `startCooldownCountdown()` / `tickCooldownCountdown()`（[app.js](app.js)）：
- 只要 `globalCooldownUntil`（第 9 點提到的全域冷卻時間戳記）被設定或偵測到還在冷卻中，就會啟動一個每秒觸發一次的 `setInterval`，即時算出 `globalCooldownUntil - 現在時間`，顯示「⏳ 429 速率限制預計還有 X 秒解除」
- 倒數算到 0 就自動清掉 interval、把文字清空，不會一直空轉
- 這個倒數只讀共用的 `globalCooldownUntil`，所以不管是哪個批次觸發 429、或哪個批次在等待中發現冷卻還沒解除，看到的都是同一份倒數，數字會一致
- 使用者按錯誤欄的 × 關掉面板後，倒數仍會在背景繼續跑（只是沒有畫面顯示），不會因為關閉面板就強制跳出來打斷使用者，只有下一次真的有新的錯誤/重試事件時面板才會重新被打開

### 13. 精簡化字幕預覽 + 一鍵複製 + 匯入外部結果

**背景**：使用者想要在上傳字幕後，先看到「精簡化後的字幕」（純文字、無時間軸），方便複製到別的地方（例如常常撞 429 時，先把乾淨的句子丟給其他 AI 工具手動問，再把結果帶回來）；同時希望有個「匯入」的小視窗，把從別處拿到的分析結果貼進來，一樣可以在這個頁面顯示卡片、輸出 PDF。

**精簡化字幕預覽**（[app.js](app.js) 的 `updateSimplifiedPreview()`）：
- 上傳檔案（`handleFileUpload()`）或按「開始解析」（`handleStart()`）時都會呼叫，把 `parseSubtitleFile()` 解析出來的 `{ order, text }[]` 轉成「`1. 句子`、`2. 句子`...」這種帶編號的純文字，塞進一個唯讀的 `#simplifiedOutput` 文字框裡（[index.html](index.html) 的 `#simplifiedField`）
- 編號用的是全域順序 `order`，跟卡片上「第 N 句」徽章、以及送給 Gemini 的 prompt 編號都是同一套，方便對照
- 「一鍵複製」按鈕（`copySimplifiedBtn`）用 `navigator.clipboard.writeText()`；如果瀏覽器政策擋掉 clipboard API（例如非安全情境），會退回「幫你選取文字，請自己按 Ctrl+C」

**匯入外部結果**（`<dialog id="importDialog">`，[index.html](index.html) + `handleImportConfirm()`，[app.js](app.js)）：
- 用原生 HTML `<dialog>` 元素做彈出小視窗（`showModal()`/`close()`），不需要額外套件
- 對話框裡會列出目前「精簡化字幕」的句數，並附上跟 `buildPrompt()` 一致的 JSON schema 範例，方便使用者拿去餵給其他 AI 工具、請它照同樣格式回答
- 貼上的內容必須是一個 **JSON 陣列**，長度必須跟目前 `currentSubtitles`（也就是精簡化預覽當下對應的那份字幕）完全一致，用「位置對應」（陣列第 i 個元素對應第 i 句）決定每句結果，不是用文字內容比對
- 會先去除可能夾帶的 ```json 標記，再嘗試 `JSON.parse`；陣列型別、長度不符、JSON 格式錯誤都會在對話框內顯示錯誤訊息，不會關閉視窗，讓使用者可以直接修改重試
- 匯入成功後：清空 `#results`、逐句呼叫 `renderCard()` 直接渲染卡片（不經過批次/重試機制，因為匯入是一次到位）、同時呼叫 `setCachedResult()` 把每句結果寫入快取（跟 Gemini 正常流程共用同一份快取，之後這些句子再跑「開始解析」也會直接命中快取，不會重新呼叫 Gemini）、開放下載 PDF、更新狀態文字

**限制**：匯入靠「陣列位置」對應句子，不是用句子文字比對，所以貼上的 JSON 陣列順序、數量一定要跟當下畫面上的「精簡化字幕」一致；如果使用者匯入前又重新上傳了不同的字幕、导致 `currentSubtitles` 換了一份，之前複製出去的編號跟句子就對不上了，需要重新複製一次精簡化字幕再去問別的工具。

### 14. 工作資料夾模式（取代「貼上字幕」輸入區）

**背景**：使用者一直撞到 Gemini 免費層的 429，而且希望每個字幕檔有自己的解說紀錄檔、檔名就是字幕檔名。

**做法**：拿掉貼上用的 `#srtInput` textarea（**推翻 §13 之前的輸入方式**），改成：
- 用 `showDirectoryPicker({ mode: "readwrite", id: "jst-workdir", startIn: "documents" })` 選一次工作資料夾，handle 存進 IndexedDB 的 `workDirHandle`（沿用 §11 就有的 `idbGet`/`idbSet`）
- 用 `for await (const entry of dirHandle.values())` 列出資料夾裡的字幕檔（排除 `*.notes.json` 與 `_jst-global-cache.json`），用 `localeCompare(..., { numeric: true })` 排序，讓 `ep2` 排在 `ep10` 前面
- 點檔案就直接讀進來，不再需要複製貼上

**`file://` 雙擊開啟是可以用的（實測過，不要憑印象認定不行）**。開發時一度誤以為 `showDirectoryPicker()` 在 `file://` 這種 opaque origin 上一定會丟 `SecurityError`，因此加了擋頁橫幅；實際用 CDP 驅動真的 Chrome 測過之後推翻了這個判斷：

| 在 `file://` 下測到的結果 | |
|---|---|
| `window.origin` | `"null"`（確實是 opaque origin） |
| `window.isSecureContext` | `true` |
| `showDirectoryPicker()` | **正常開出原生對話框，沒有 `SecurityError`** |
| `localStorage` / `IndexedDB` | 可寫、而且**跨頁面重新載入保存得住** |
| 換成同資料夾的另一個 `.html` 檔名 | **仍讀得到同一份資料**（所有 `file://` 頁面共用同一個 `null` origin 儲存空間） |

所以擋頁橫幅已經移除，`initWorkspace()` 不再檢查 `location.protocol`。

**兩個副作用要知道**：
1. 所有 `file://` 頁面共用同一份儲存空間，所以電腦上任何一個本機 HTML 檔理論上都讀得到這個工具的快取。單機自用沒問題，但不要在公用電腦上放敏感內容。
2. `file://` 與 `http://127.0.0.1:5500` 是**不同的 origin**，資料不互通。中途改變開啟方式，等於從零開始（localStorage 快取與資料夾授權都要重來；notes 檔因為是寫在資料夾裡，不受影響——這也是把解說存成檔案而不是只存瀏覽器的好處之一）。

**如果選擇用 Live Server，埠一定要釘死**：資料夾授權、IndexedDB、localStorage 都是綁「來源 + 連接埠」的。Live Server 在 5500 被佔用時會自動跳到 5501，一跳埠就會「莫名其妙」失去資料夾授權跟所有快取。`.vscode/settings.json` 已經把 `liveServer.settings.port` 釘在 5500，**如果 5500 被佔用，要去關掉佔用的程式，不要改這個數字**。用 `file://` 雙擊開啟則沒有這個問題（`null` origin 跟路徑無關，連整個資料夾搬家都不會掉資料）。

**四種 UI 狀態**（`setWorkspaceState()`，[app.js](app.js)），少一種就會有情境卡住：

| 狀態 | 判斷 | 畫面 |
|---|---|---|
| `unsupported` | 沒有 `showDirectoryPicker` | Firefox/Safari 退回舊的單檔上傳 + 「下載 notes JSON」 |
| `no-dir` | IndexedDB 裡沒有 handle | 只有「選擇工作資料夾」 |
| `needs-grant` | 有 handle 但 `queryPermission !== "granted"` | 「重新授權資料夾」，一鍵，不用重選 |
| `ready` | 已授權 | 自動列檔 + 「重新掃描」/「更換資料夾」 |

`needs-grant` 是**瀏覽器重啟後的常態**，不是例外——Chrome 會收回持久化的授權。頁面載入時只能被動 `queryPermission()`，`requestPermission()` 一定要在 click handler 裡才有使用者手勢。§11 就寫對的 `verifyFileHandlePermission()` 直接沿用，只改名成 `verifyHandlePermission()`（現在也服務目錄 handle）。

**目錄 handle 沒有變更通知**，外部丟進資料夾的新字幕檔不會自己出現，所以「重新掃描」按鈕是必要功能、不是裝飾。

**安全提醒**：授權 `readwrite` 等於把整個資料夾的讀寫權交給這個頁面，而 API Key 是明碼寫在 `app.js` 裡的（§1）。UI 上有提示請使用者指向專門放字幕的資料夾，不要選整個「文件」。

### 15. 每個字幕檔一份 notes 檔

解說紀錄寫進同資料夾的 `<字幕檔名>.notes.json`：

```json
{
  "kind": "jst-notes",
  "version": 1,
  "sourceFile": "ep01.ja.srt",
  "sourceHash": "fnv1a32:9a3c1f7e",
  "sourceLineCount": 412,
  "items": {
    "17": { "text": "今日はいい天気ですね。", "status": "done", "source": "gemini", "at": "...", "result": { ... } },
    "18": { "text": "♪～", "status": "skipped", "reason": "symbol-only" }
  }
}
```

**為什麼用句子編號（order）當 key，而不是句子文字**：動畫/日劇字幕的重複句非常多（「はい」「えっ」「なに」）。用文字當 key 會把它們壓成同一筆，於是無法記錄「第 18 句 skipped、第 400 句同樣文字卻是 done」，清單上每一列的狀態點也就沒辦法只靠 notes 檔畫出來。這個檔案本來就只服務單一字幕檔，order 在它的生命週期內是穩定的。

**用文字當完整性檢查**：唯一的失效情境是使用者重新調軸或增刪句子，而這是**可偵測、可復原**的。載入時比對 `sourceHash`（FNV-1a 32bit）+ `sourceLineCount`：
- 相符 → 直接信任 order（O(1)），但每次查找仍順手檢查 `items[order].text === 該句文字` 當廉價護欄
- 不符 → **絕不丟棄 notes**，改用 `items` 建一份「文字 → 結果」索引，以文字精確比對重新掛回正確的 order，再用修正後的 order + 新 hash 覆寫，並在畫面上說明重新對應了幾句

**只持久化 `done` 與 `skipped`**。`pending` / `error` 只留在記憶體——不要把暫時性失敗寫進使用者的檔案。

**debounce + single-flight 寫檔**（`createFileWriter()`，[app.js](app.js)）：
- **這順便修掉了 §11 的一個效能 bug**：舊版 `saveResultCache()` 在每次 `setCachedResult()` 都全量重寫整份 JSON 檔，等於 O(n²) 的寫入量
- trailing debounce 1.5 秒 + hard max-wait 10 秒（持續有更新時也不會被無限往後推）
- `inFlight` 單飛保護是**必要條件不是優化**：同一個檔案同時開兩個 `createWritable()` 在 Chrome 會丟 `NoModificationAllowedError`
- **API 成功回應後立刻 flush，不走 debounce**——那是花錢換來的資料。另外在彈窗關閉、切換字幕檔、`visibilitychange → hidden` 時也 flush。`beforeunload` 沒辦法 await 非同步寫入，這是接受的限制，最壞情況只掉一個 `skipped` 標記

**毀損 / 被手改的檔案：整檔偏執、單筆寬容**。`JSON.parse` 失敗、`kind` 不對、`items` 不是物件、或 `version` 比程式新 → 設 `notesWriteBlocked`、本次用空的記憶體 notes 跑、顯示常駐橫幅「為避免覆蓋你的資料，這次不會寫入」，附一顆「備份並重建」按鈕（把原始文字寫成 `<name>.notes.corrupt-<timestamp>.json` 後解鎖）。單一 item 格式不對則只丟那一筆、保留其餘。

**副作用**：`createWritable()` 是寫暫存檔再 atomic rename，分頁被強制關掉時會在資料夾裡留下 `<name>.notes.json.crswap`。無害，直接刪掉即可。

### 16. 延遲解說 + 前瞻預取（**推翻 §4 的「一次跑完全部批次」主流程**）

**問題**：舊的 `handleStart()` 是一次全打——按「開始解析」就把整份字幕切成 15 句一批全部送完。300 句 = 20 次請求，而且**每一句都解說**，即使使用者只想看其中幾句。額度就是這樣燒掉的。

**新做法**：`handleStart()` / `runBatch()` / `runPendingBatch()` / `renderBatchError()` / `chunkArray()` 全部刪掉，改成點哪一句才解說哪一句。

**關鍵取捨：不是「一次只問一句」。** 逐句問會讓請求數等於看過的句數，對 RPD（每日請求數）反而比舊的批次更糟——看 100 句就是 100 次請求，而舊做法只要 7 次。所以做成**前瞻預取**：點第 N 句時，把 N 連同後面尚未解說的句子打包成 **一次** 請求，共 `LOOKAHEAD_SIZE`（10）句不重複的文字。彈窗立刻顯示第 N 句，其餘 9 句寫進 notes 備用，之後點那幾句是 0 次請求。彈窗的「上一句 / 下一句」就是為了讓使用者零成本走完這 10 句。

`LOOKAHEAD_SIZE` 是刻意的取捨：預取會花額度在使用者可能不會打開的句子上，換來的是請求數壓到「實際想看的句數 ÷ 10」。想更省就調小（極端是 1，等於純逐句），想更少請求就調大。

**每句狀態**：`lineState[]` 是唯一真相來源，值為 `idle` / `pending` / `done` / `error` / `skipped`。開檔時做一次初始掃描（notes → 全域快取 → 跳過規則）把它填滿，之後只有 API 結果會改動它。

**防重複請求**：`requestByOrder` 是 `order → 請求紀錄` 的 Map，一個批次涵蓋的**每一個** order 都會登記進去。點到已經有紀錄的句子就直接 await 那個 promise——這一個機制同時涵蓋「快速連點」與「點到已被某個預取批次涵蓋的句子」兩種情況。

**沿用不動的部分**：`callGeminiBatchWithAutoRetry()` 的重試階梯與 §9 的全域 429 冷卻**完全沒有改**。所有 API 呼叫串成單一 promise chain（`enqueueApi()`，併發上限 1），維持 §4「嚴格循序」的決定。`BATCH_DELAY_MS` 只套用在**連續排隊的請求之間**，第一個請求不套用——使用者點一下要乾等 1.5 秒是不能接受的。429 冷卻倒數除了角落的 `#errorPanel` 之外，也鏡射到彈窗裡，因為使用者的眼睛在彈窗上。

**重複文字扇出**：批次內依文字去重，同樣的句子只送一次，回來之後要扇出給**每一個**相同文字的 order。這是整段邏輯裡最容易寫錯的地方——漏了扇出會讓那些行永遠看起來沒解說過。

另外，預取視窗**之外**的重複句（例如第 12 句在這批裡、但同文的第 20 句在視窗外）本來就不會再花額度（點它時會命中全域快取），但清單上會一直顯示成未解說。所以每批結果寫回之後會再跑一次 `promoteAllFromGlobalCache()`，把整份字幕裡所有「其實已經零成本可用」的句子一次標成 done，讓進度數字誠實。這是端對端測試抓出來的，不是設計時想到的。

### 17. 以 id 對應、保留部分結果（**推翻 §6 的「陣列長度必須恰好相符」**）

**舊版最花額度的地雷**：`callGeminiBatch()` 原本檢查 `parsed.length !== batch.length`，15 句回 14 句就把**已經付費產生的 15 句結果整批丟掉重試**。

**新做法**：每筆結果帶回 `id`（就是句子編號），回應建成 `Map<id, result>` 後逐一比對送出的 id：
- 有效 → 收下
- 缺漏 → 收進 `missingIds`，**只針對缺的 id 再送一次**（`analyzeItems()`），最糟 2 次呼叫
- 回傳了沒送出過的 id → 直接忽略（防幻覺）
- 模型完全忽略 id 且筆數剛好相符 → 退回按順序對應，總比整批丟掉好

**請求格式**：固定規則搬到 `systemInstruction`，JSON 結構改用 `generationConfig.responseSchema` 描述，並加上 `thinkingConfig: { thinkingLevel: "low" }` 與 `maxOutputTokens`。`RESPONSE_SCHEMA` 用 `propertyOrdering` 讓 `id` 最先輸出——模型是左到右生成的，id 在前面的話，就算回應被截斷，前面已經完整的項目仍然救得回來。

**誠實說明效益**：`systemInstruction` **不會**減少計費的 input token（一樣會算）；真正省下來的是有了 `responseSchema` 之後，原本那一大段描述 JSON 結構的散文可以砍掉。`thinkingLevel: "low"` 省的是 output token。**但這兩者都不影響 RPD/RPM**——真正解決 429 的是 §16 的延遲解說。

**內容層級錯誤只重試 1 次**：JSON 壞掉、對不到任何一句這類錯誤（`err.contentError`）跟網路/5xx 不一樣，同樣的 prompt 再送 4 次多半得到一樣的結果，純粹在燒額度。所以這類錯誤的重試預算是 1 次，網路/5xx 維持 `MAX_AUTO_RETRIES`（4）次。

**400 kill switch（照 §3 的教訓預先準備）**：Google 已經換過一次模型代號讓這個專案 404，上面這些新欄位遲早也會被改名。所以請求收到 400 且錯誤內容命中 `/responseSchema|thinkingConfig|thinkingLevel|propertyOrdering|Unknown name|Invalid JSON payload/` 時，本次 session 把 `useStructuredOutput` 翻成 `false`、在錯誤欄顯示訊息、自動改用「純 prompt 描述 schema」的相容格式重試一次，而不是整個壞掉。

**未來要重查的欄位**（不要憑記憶改）：`thinkingConfig.thinkingLevel` 是 Gemini 3+ 的控制方式，`thinkingBudget` 是 2.5 世代的欄位，**兩個同時送會 400**；Gemini 3 Flash 無法完全關閉 thinking，`"low"` 是下限。另外不要改用 `responseJsonSchema`，留在 `responseSchema`。

### 18. 清單 + 彈窗 UI 與列印路徑

**版面**：`#lineList` 是一個扁平清單，每列 `<li class="line-row" data-order="17" data-state="done">`，顯示編號、狀態點、日文原文、已解說的話再加一行中文翻譯。**只掛一個委派 click listener 在 `#lineList` 上**，不逐列綁；狀態點純靠 CSS 吃 `data-state`（`○` idle /`◐` pending /`●` done /`✕` error /`–` skipped），所以重畫一列 = 改一個 attribute。

**彈窗**：原生 `<dialog id="noteDialog">`。**點下去先開窗再說**（顯示原文 + 讀取中），絕不讓使用者等網路才看到東西。用 `dialogToken` 防競態——每個非同步渲染都要先檢查 token 與 order 都沒變，否則慢回來的舊回應會蓋掉當前彈窗。

**點背景關閉的坑**：`dialog.addEventListener("click", e => { if (e.target === dialog) dialog.close(); })` 這招，**只有在 `<dialog>` 元素本身 `padding: 0`、內容全放在內層 `.note-dialog-inner` 時才正確**，否則點在 dialog 自己的內距上會被判定成點背景而誤關。`.import-dialog` 有 `padding: 24px 28px`，新的 `.note-dialog` 不能照抄它。

**`renderCard()` 改成 `buildCard(subtitle, result) => HTMLElement`**，同時服務彈窗與列印區兩個使用者。渲染邏輯本身沒變，§6 講的「改欄位要同時改 prompt schema 跟渲染邏輯」仍然成立（現在是 prompt schema / `RESPONSE_SCHEMA` / `buildCard()` 三邊要一起改）。

**列印路徑**：解說改成彈窗之後，畫面上已經沒有卡片可印，所以 `#printArea` 平常 `display: none`，按下「下載 PDF」時才由 `renderPrintArea()` 即時建構（檔名抬頭 + 所有 `done` 的句子），`afterprint` 事件再清空。列印前一定要先 `noteDialog.close()`——modal dialog 在 top layer，不關會蓋著整頁印出來；CSS 另外加了 `@media print { dialog[open] { display: none } }` 當第二道保險。

**下載 PDF 改回永遠可按（第三次改這個決策，明確推翻 §11）**：§10 開放 → §11 收回成「全部跑完才能按」→ 現在再開放。理由是延遲解說根本沒有「跑完」這個時間點，按鈕上直接顯示「下載 PDF（42 句）」告訴使用者現在會印出幾句。

**匯入外部結果改成文字比對（修掉 §13 記錄的限制）**：依序嘗試 ① 每筆的 `id` → ② 每筆的 `text`（**扇出到所有相同文字的句子**）→ ③ 兩者都沒有時才退回陣列位置對應。原本「長度不符就整個拒絕」改成報告式：「已匯入 38 句，3 筆找不到對應」。

### 19. 額度節流措施

1. **批次內文字去重**（§16）。字幕檔上這是實打實的大宗。
2. **`shouldSkipLine()` 自動跳過不值得花額度的行**：只有符號/音效（`♪～`）、沒有任何假名漢字、說話者標籤（`田中：`）、去標點後日文字少於 3 個（`はい。`『うん』這種 N5 內容）。跳過的句子標成 `skipped` 並寫進 notes，**但仍然可以點**，彈窗會說明跳過理由並提供「還是分析這句」——不能推翻的啟發式規則只會變成 bug 回報。
3. **每日請求計數**（`localStorage["jst_usage_v1"]`）：用**美國太平洋時區**的日期當 key，因為 Google 免費層的 RPD 是在太平洋午夜重置（`Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" })` 直接產出 `YYYY-MM-DD`）。只留最近 7 天。面板顯示「今日 N 次請求 / M 句（近 60 秒 K 次）」，超過軟性上限轉琥珀色、超過 20% 轉紅。
4. **軟性攔截**：今日請求數超過 `SOFT_RPD_LIMIT` 後，每次要發請求前先跳確認視窗。光有計數器是被動的，這個才真的擋得住把當日額度一次燒光。
5. `SOFT_RPD_LIMIT` 預設 180，是一個**要自己調的數字**：`gemini-3.6-flash` 免費層的實際 RPD 沒有可靠的公開數字，撞到 429 就往下調。
6. **全域快取（`_jst-global-cache.json`）保留成第二層**：notes → 全域快取 → API。同一句日文不管在哪個檔案出現過都不會重問。§11 那個用 `showSaveFilePicker` 選的單一快取檔已經不再同步寫入，改成放在工作資料夾裡；舊檔透過「匯入舊版快取檔」按鈕一次性帶進來（連結過且權限還在的話，選資料夾時會自動匯入）。

### 20. 假名標注（ruby）、空區塊隱藏、錯誤欄自動收起

**假名標注**：日文漢字上方用小字標假名。做法是請模型在特定欄位用 `漢字[假名]` 的括號標記回傳，前端再用 `renderRuby()` 轉成 `<ruby>漢字<rt>假名</rt></ruby>`。

- 新增 `reading` 欄位＝原句照抄但加上假名標記（`今日[きょう]はいい天気[てんき]ですね。`）
- `grammar.point`、`grammar.example`、`words[].note` 也用同樣格式；**中文說明欄位（translation / meaning / explanation）明確禁止標注**，否則模型會去幫中文漢字加假名
- `renderRuby()` 只有 `<ruby>` / `<rt>` 兩個標籤是自己插的，其餘一律走 `escapeHtml()`，注入面不變
- 單字表的「原字」欄不走括號標記，而是用既有的 `word` + `kana` 兩個欄位組 ruby。**假名只能標在漢字上**：`食べる` + `たべる` 要呈現成 食[た]べる，不是整個詞頂著「たべる」。`splitOkurigana()` 從頭尾剝掉相同的送り仮名，剩下的才是漢字與它的讀音
- `word` / `kana` 分成兩欄的決定（§6）維持不變，「假名」欄仍然保留，只是「原字」欄多了 ruby

**舊快取沒有 `reading`**：`renderOriginal()` 找不到 `reading` 時會退回純文字，不會壞掉。所以在這次改動之前就解說過的句子，原句上不會有假名，要用彈窗的「重新分析這句」才會重新產生（那會花一次 API 額度）。

**空區塊隱藏**：`words` 或 `grammar` 是空陣列時，整個區塊（含 `<h3>` 標題）不渲染，不再印「無 N3 以上內容」的空表格。兩個都空時顯示一行 `.no-extra` 說明，避免彈窗看起來像壞掉。這推翻了 §6 最後提到的「渲染時會顯示『無 N3 以上內容』」。

**錯誤欄成功後自動收起**：以前 `#errorPanel` 只能手動按 × 關掉，所以一次 429 之後那則訊息會一直掛在畫面上，讓人以為現在還是壞的。新增 `clearErrorPanel()`，在每次請求成功後呼叫。冷卻倒數則只有在 `globalCooldownUntil` 真的已經過去時才清掉，不會把還在進行中的倒數誤關。

### 21. 部署成 GitHub Pages：不需要建置，但需要把 key 拿掉

**為什麼可以直接部署**：這個專案沒有任何建置步驟、沒有 npm 依賴、沒有後端 API。`index.html` / `style.css` / `app.js` 三個檔案照原樣丟上靜態主機就會動，所以 workflow 就是「checkout → 把整個 repo 根目錄當成 artifact 上傳 → deploy」，沒有 Node、沒有 bundler。

**為什麼用 GitHub Actions 而不是 "Deploy from a branch"**：兩種都可以，選 Actions 是因為部署流程寫在版控裡看得到，之後如果真的長出建置步驟（例如要壓縮、要注入版本號），在同一個檔案加一步就好，不用去改 repo 設定。設定位置：Settings → Pages → Source 選 **GitHub Actions**。

**`.nojekyll`**：GitHub Pages 預設會跑 Jekyll，它會忽略底線開頭的檔案與資料夾。目前 repo 沒有這種檔名，但放一個空的 `.nojekyll` 可以省掉「之後某天加了 `_something.js` 結果 404」這種很難查的問題。

**HTTPS 對功能的影響**：File System Access API 需要 secure context。`https://` 與 `file://` 都算 secure context，所以 GitHub Pages 上「選擇工作資料夾」照常可用 —— 換句話說，這個工具在線上版仍然是讀寫使用者**自己電腦**的資料夾，沒有任何檔案會上傳。

**origin 變了，授權與快取也跟著變**（延續 §14 的「埠號要釘死」）：`localStorage`、IndexedDB 裡的資料夾 handle 都綁在 origin 上。本機 `localhost:5500` 與線上 `xxx.github.io` 是兩個不同的 origin，所以 **API key 要各貼一次、資料夾要各授權一次、全域快取也不共用**。這不是 bug，是瀏覽器的隔離機制；真正重要的解說結果存在使用者資料夾的 `*.notes.json` 裡，跟 origin 無關，換哪邊開都讀得到。

**`.gitignore` 擋掉字幕檔**：`*.srt` / `*.vtt` / `*.notes.json` 這些都是使用者的個人內容（可能還有版權問題），預設不進版控。要放測試用字幕的話用 `git add -f` 明確加。

## 之後可能會想改的地方（先記下來，還沒做）

- `LOOKAHEAD_SIZE`、`BATCH_DELAY_MS`、`MAX_AUTO_RETRIES`、`SOFT_RPD_LIMIT` 都是寫死的常數，沒有做成 UI 可調整（`SOFT_RPD_LIMIT` 最需要，因為免費層實際額度要自己試出來）
- `shouldSkipLine()` 的門檻（日文字少於 3 個）是拍腦袋定的，可能會誤跳一些值得看的短句；目前靠彈窗的「還是分析這句」補救
- N3 以上的判斷完全交給 Gemini 自己判斷，沒有額外驗證機制，模型偶爾可能誤判難度
- 沒有做 notes 檔的 schema 遷移機制，之後如果 `version` 要升到 2，得補一段轉換邏輯（目前遇到版本比程式新只會停止寫入）
- 非 Chromium 瀏覽器的退路只能存在瀏覽器裡、手動下載 notes JSON，沒有真正的檔案同步
- 假名標注完全依賴模型自己標對，沒有字典可以驗證；遇到破音字（例如「入る」）有可能標錯
- 這次改動之前解說過的句子沒有 `reading`，原句不會有假名，只能逐句「重新分析」補回來（會花額度）
