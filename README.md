# 日文字幕語法拆解小工具

從 [Jimaku](https://jimaku.cc/)／[kitsunekko](https://kitsunekko.net/dirlist.php?dir=subtitles%2Fjapanese%2F) 開日文字幕 → 依停頓分成一段一段（段落裡一句一行）→ 每段右邊兩顆按鈕：**📋 複製**、**Gemini**（把這段送去 Gemini，解說直接在 Gemini 看）。

純前端、零依賴、零建置：只有 `index.html` + `style.css` + `app.js` 三個檔案，可以直接丟上 GitHub Pages。不呼叫任何 AI API，也不讀寫你電腦裡的檔案。

> **線上版**：https://misoccwei.github.io/japanese-subtitle-translation/

## 功能

- **在頁面裡直接搜尋 Jimaku**：搜尋作品 → 點檔案就打開，手機平板也能用；kitsunekko 的字幕大多也收在 Jimaku 裡。`.zip` 會自動解壓，裡面有好幾集就列出來讓你挑（`.rar` / `.7z` 不支援）
- **電腦上也可以直接從 kitsunekko 抓**：用書籤小工具在 kitsunekko 頁面上一鍵送回
- **每段兩顆按鈕**：📋 複製這段；「Gemini」——iPhone／iPad 透過「捷徑」一鍵把這段日文送給 Gemini，其他裝置複製「解說日文：＋這段」並打開 Gemini（怎麼解說交給你在 Gemini 的個人化設定）
- **勾選幾句一起問**：點句子就勾選（可以跨段），點段落編號整段勾選，畫面底部會出現「📋 複製／Gemini」，把勾選的句子照字幕順序合成一段送出
- **分段可以調**：字幕上方的「分段設定」可以改「停頓幾秒換段」和「一段最多幾字」，也可以整個關掉變回一句一列，改了馬上重新分段，設定會記住
- **回到上次的狀態**：重新整理或下次回來，會自動打開上次的字幕、停在上次按過 📋／Gemini 的那一段；搜尋結果與檔案清單也會記住。只記得最後一個檔
- **多種字幕格式**：`.srt` / `.vtt` / `.ass` / `.ssa` / `.sbv` / `.txt`，自動判斷 UTF-8／Shift_JIS／UTF-16 編碼

## 使用方式

### 1. 設定 Jimaku API Key（只要做一次）

1. 到 [jimaku.cc](https://jimaku.cc/login) 免費註冊，在 [Account 頁](https://jimaku.cc/account) 產生 API key
2. 貼到「找字幕」卡片的「Jimaku API Key」，按儲存（只存在這台瀏覽器）

### 2. 找字幕

輸入作品名稱（日文、羅馬字、英文都可以）→ 點作品 → 點檔案，字幕就會打開。

電腦上也可以用卡片最下面的 kitsunekko 書籤小工具。細節見 [DESIGN.md](DESIGN.md) §22、§24。

### 3. 用 Gemini 解說

**iPhone／iPad（一鍵）**：在「捷徑」App 建一個捷徑（預設名稱「Gemini解說日文」，可在字幕上方的「Gemini 開啟方式」改）：

1. 「從分享表單接收」文字（沒有輸入時取得剪貼簿內容）
2. 加入 Gemini 的「Ask Gemini」動作，內容放「捷徑輸入」

之後每段右邊按「Gemini」→ Safari 問要不要打開「捷徑」時按打開 → 捷徑收到這段日文原文，交給 Gemini 解說（怎麼解說由你的捷徑與 Gemini 個人化設定決定）。

**電腦、Android**：按「Gemini」→ 已複製「解說日文：＋這段」、Gemini 在新分頁打開 → 在輸入框貼上、送出。
Gemini 在這些平台不支援用網址或 App 連結直接帶入文字（見 DESIGN.md §26、§27）。

## 本機執行／自己部署一份

沒有建置流程：

```bash
git clone https://github.com/misoccwei/japanese-subtitle-translation.git
cd japanese-subtitle-translation

# 任何靜態伺服器都可以
python3 -m http.server 5500
# 或 VS Code Live Server（.vscode/settings.json 已把埠釘在 5500）
```

部署到 GitHub Pages：repo → **Settings** → **Pages** → **Source** 選 **GitHub Actions**，推一次 `main`，[.github/workflows/deploy.yml](.github/workflows/deploy.yml) 就會把 repo 根目錄整包部署上去。

## 資料與隱私

- 只有「上次打開的那一個字幕」存在這個瀏覽器的 localStorage（只在這台裝置、不會上傳），按「關閉這個字幕」就清掉
- 其他存在 `localStorage` 的只有 Jimaku API key（`jst_jimaku_key_v1`）、上一次的 Jimaku 搜尋結果（作品名、檔名與下載網址）與「Gemini 開啟方式」的設定，共用電腦用完請按「清除」
- 按「Gemini」時，送到 Gemini 的只有那一段日文（網頁版前面加「解說日文：」）

## 檔案結構

```
.
├── index.html                  # 頁面結構
├── style.css                   # 樣式
├── app.js                      # 全部邏輯（Jimaku、kitsunekko 書籤、zip、字幕解析、複製、Gemini／捷徑）
├── DESIGN.md                   # 設計決策與原因，改功能前先看這份
├── .github/workflows/deploy.yml  # GitHub Pages 部署
└── .vscode/settings.json       # Live Server 埠號釘在 5500
```

## 授權

[MIT](LICENSE)
