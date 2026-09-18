# 日文字幕語法拆解小工具

開啟日文字幕檔 → 點任何一句 → 取得**中文翻譯、N3 以上單字拆解、文法說明**，解說結果會存回你自己的資料夾，下次開同一個檔案不用再花 API 額度。

純前端、零依賴、零建置：只有 `index.html` + `style.css` + `app.js` 三個檔案，可以直接丟上 GitHub Pages。

> **線上版**：https://misoccwei.github.io/japanese-subtitle-translation/

## 功能

- **多種字幕格式**：`.srt` / `.vtt` / `.ass` / `.ssa` / `.sbv` / `.txt`，解析後只留下句子與順序，不留時間軸
- **點哪句才解說哪句**：不會一次把整份字幕送去 API 燒額度；點一句時會順帶預抓後面幾句
- **假名標註**：日文原句以 `<ruby>` 顯示振假名
- **解說存回本機資料夾**：寫進 `<字幕檔名>.notes.json`，跟字幕檔放在一起；重開檔案直接讀，不重複呼叫 API
- **PDF 匯出**：用瀏覽器原生列印輸出已解說的句子（文字清晰、無外部套件）
- **穩健的 API 錯誤處理**：429 全域冷卻、5xx 遞增延遲自動重試、部分結果保留、失敗批次可單獨重試
- **匯入外部結果**：可把其他工具產生的 JSON 貼進來對應到現有句子

## 瀏覽器需求

| 瀏覽器 | 支援程度 |
| --- | --- |
| Chrome / Edge（桌機） | ✅ 完整功能，包含選擇工作資料夾、自動讀寫 notes 檔 |
| Safari / Firefox | ⚠️ 退化模式：只能單獨選一個字幕檔，解說存在瀏覽器裡，需自行按「下載 notes JSON」保存 |

「選擇工作資料夾」用的是 [File System Access API](https://developer.mozilla.org/docs/Web/API/File_System_Access_API)，目前只有 Chromium 系瀏覽器支援。

## 快速開始（使用者）

1. 到 [Google AI Studio](https://aistudio.google.com/apikey) 申請一把免費的 Gemini API Key
2. 打開網站，在「1. Gemini API Key」貼上 key 按「儲存」
3. 「2. 工作資料夾」選一個**專門放字幕檔的資料夾**（授權等於把整個資料夾的讀寫權交給這個頁面，不要選整個「文件」）
4. 點清單中的字幕檔 → 點任何一句 → 彈出解說

## 快速開始（開發／自己部署一份）

### 本機執行

沒有建置流程，三種方式都可以：

```bash
git clone https://github.com/misoccwei/japanese-subtitle-translation.git
cd japanese-subtitle-translation

# 方式 A：直接用瀏覽器開（Chrome 實測 file:// 可正常運作）
open index.html

# 方式 B：任何靜態伺服器
python3 -m http.server 5500

# 方式 C：VS Code Live Server（.vscode/settings.json 已把埠釘在 5500）
```

> 埠號會被釘死是有原因的：授權過的資料夾是綁在 origin 上的，換埠 = 換 origin = 授權重來。詳見 [DESIGN.md](DESIGN.md) §14。

### 從零建立自己的 repo

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/misoccwei/japanese-subtitle-translation.git
git push -u origin main
```

### 開啟 GitHub Pages

1. GitHub repo → **Settings** → **Pages**
2. **Source** 選 **GitHub Actions**（不要選 "Deploy from a branch"）
3. 推一次 `main`，[.github/workflows/deploy.yml](.github/workflows/deploy.yml) 就會把 repo 根目錄整包部署上去
4. 網址是 `https://misoccwei.github.io/japanese-subtitle-translation/`

## API Key 與安全性

**這個 repo 裡沒有、也不應該有任何 API Key。**

Key 由使用者自己在頁面上輸入，存在該瀏覽器的 `localStorage`（key 名稱 `jst_api_key_v1`）：

- 不會送到任何第三方伺服器 —— 請求是瀏覽器**直接**打給 `generativelanguage.googleapis.com`
- 沒有後端，所以也沒有伺服器端可以外洩
- 代價是：**在共用電腦上用完請按「清除」**，而且任何能在你瀏覽器執行 JS 的東西都讀得到這把 key

如果 fork 之後想改成寫死 key，請務必把 repo 設為 private —— GitHub Pages 的靜態檔案是公開的，寫進 `app.js` 的 key 等於貼在網路上。Google 的掃描器通常幾分鐘內就會偵測到並停用該 key。

## 檔案結構

```
.
├── index.html                  # 頁面結構
├── style.css                   # 樣式，含 @media print 列印規則
├── app.js                      # 全部邏輯（資料夾存取、字幕解析、Gemini 呼叫、渲染、列印）
├── DESIGN.md                   # 設計決策與原因，改功能前先看這份
├── .github/workflows/deploy.yml  # GitHub Pages 部署
└── .vscode/settings.json       # Live Server 埠號釘在 5500
```

## 常見問題

**Gemini 回 404 / NOT_FOUND？**
Google 汰換模型代號很快。看錯誤訊息裡建議的新模型名稱，改掉 `app.js` 開頭的 `GEMINI_MODEL` 那一行即可。

**一直撞 429？**
免費層有每分鐘與每日請求上限。程式已經內建全域冷卻與自動重試，等一下就好；要更保守可以把 `app.js` 的 `BATCH_DELAY_MS` 調大、`LOOKAHEAD_SIZE` 調小。

**換了瀏覽器／重開機後資料夾授權不見了？**
這是 File System Access API 的設計，授權不會永久保留。按「重新授權資料夾」即可，之前的 notes 檔都還在。

**解說結果存到哪？**
字幕檔旁邊的 `<字幕檔名>.notes.json`。這是純 JSON，可以自己備份、版控或搬到別台機器。

## 授權

[MIT](LICENSE)
