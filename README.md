# 門市排班系統

> **THE food co. 同興實業** 專用門市排班管理工具  
> 版本：v2.7 ｜ 部署平台：Cloudflare Pages + KV

---

## 功能總覽

| 功能 | 說明 |
|------|------|
| 🏪 **動態門市管理** | 新增、編輯、刪除門市（最多 8 家），設定自動存至雲端 |
| 👥 **員工管理** | 新增員工、設定可上班日、班數上下限、門市指派模式 |
| 📅 **排班表** | 各門市獨立班表，支援手動排班與一鍵自動排班 |
| ⚡ **自動排班** | Greedy 演算法，優先填滿週末，平均分配班次 |
| ⚠️ **違規偵測** | 即時警告：班數超標、連續排班、人力不足、互斥衝突、同日多店 |
| 🔐 **Zero Trust 保護** | Cloudflare Email OTP 驗證，非授權人員無法存取 |
| 👤 **多人即時共用** | 所有使用者共用同一份 KV 雲端資料，0.4 秒內自動同步 |
| 📷 **匯出班表圖片** | 桌曆式班表圖片（1080px × 3 倍解析度），支援深淺主題 |
| 🌙 **深淺主題切換** | 一鍵切換 Dark / Light Mode，偏好自動記憶 |
| 📦 **匯出 / 匯入 JSON** | 備份與還原完整排班資料 |

---

## 系統架構

```
shift-scheduler/
├── public/
│   └── index.html          # 前端單頁應用（所有邏輯含於此檔）
├── functions/
│   └── api/
│       ├── state.js        # GET / PUT 排班資料（Cloudflare KV）
│       └── whoami.js       # 解析 Zero Trust JWT，取得登入者 Email
├── wrangler.toml           # Cloudflare Pages / KV 設定
└── README.md
```

**技術棧：**
- 前端：純 HTML / CSS / Vanilla JS（無框架）
- 後端：Cloudflare Pages Functions（Edge Worker）
- 資料庫：Cloudflare KV（Key-Value 儲存）
- 驗證：Cloudflare Zero Trust Access（Email OTP）
- 字型：Noto Sans TC + JetBrains Mono（Google Fonts）
- 圖片匯出：html2canvas

---

## 資料架構（Cloudflare KV）

| KV Key | 內容 |
|--------|------|
| `global` | 門市清單、員工名單、門市設定、互斥組合（跨月共用） |
| `schedule:2026-05` | 2026 年 5 月的排班 assignments（含 updatedAt / updatedBy） |
| `backup:global` | `global` 覆寫前的上一世代備份 |
| `backup:schedule:2026-05` | 該月覆寫前的上一世代備份 |

員工名單與門市設定跨月共用；每月排班獨立儲存。

**資料保護機制（v2.8 起）：**
- 伺服器拒絕「空資料覆蓋非空資料」（HTTP 409），刻意清空需帶 `?force=1`
- 每次覆寫前自動將舊值備份到 `backup:*` key（保留一個世代）
- 內容未變更時跳過寫入，避免 KV 免費方案的寫入額度浪費
- 前端驗證伺服器回應必須為 JSON——Zero Trust 登入逾時（回傳 HTML 登入頁）會被偵測並提示重新登入，不再誤判為儲存成功

---

## 快速部署

### 前置需求

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) `npm install -g wrangler`
- Cloudflare 帳號（免費方案即可）

### 步驟一：建立 KV Namespace

```bash
wrangler kv:namespace create SCHEDULER_KV
```

將輸出的 `id` 填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "SCHEDULER_KV"
id = "你的KV_ID"
```

### 步驟二：部署到 Cloudflare Pages

```bash
# 首次部署（建立 Pages 專案）
wrangler pages deploy public/ --project-name shift-scheduler

# 之後更新
wrangler pages deploy public/ --project-name shift-scheduler
```

### 步驟三：綁定 KV 到 Pages Functions

1. Cloudflare Dashboard → **Pages** → `shift-scheduler` → **Settings** → **Functions**
2. **KV namespace bindings** → **Add binding**
   - Variable name：`SCHEDULER_KV`
   - KV namespace：選剛才建立的 namespace
3. 重新部署一次

### 步驟四：設定 Zero Trust（Email OTP 驗證）

1. Dashboard → **Zero Trust** → **Access** → **Applications** → **Add application**
2. 選 **Self-hosted**
3. Application domain：`shift-scheduler.pages.dev`
4. Policy → Include rule → **Emails** → 填入所有允許的 Email
5. 儲存後，訪問網站時會要求 Email OTP 驗證

### 步驟五：連結 GitHub 自動部署（建議）

1. Dashboard → **Pages** → `shift-scheduler` → **Settings** → **Builds & deployments**
2. **Connect to Git** → 選 GitHub → 授權 → 選 `abey28/shift-scheduler`
3. Production branch 設為 `master`
4. 之後每次 `git push` 會自動觸發 Production 部署

---

## 本地開發

```bash
# 安裝 wrangler
npm install -g wrangler

# 啟動本地開發伺服器（自動 mock KV）
wrangler pages dev public/ --kv SCHEDULER_KV

# 訪問 http://localhost:8788
```

本地開發時 `/api/whoami` 回傳 `dev@local`，不需要 Zero Trust 驗證。

---

## 使用說明

### 建議操作流程

1. 進入「**門市設定**」→「門市管理」確認或新增門市
2. 進入「**員工管理**」新增所有員工
3. 在每位員工卡片點擊日期格子，設定該員工本月可上班日
4. 進入「**門市設定**」調整各店班別（整日 / 早晚班）及每班需求人數
5. 如有不合的員工，在「互斥排班」區新增組合
6. 回到「**排班表**」按「⚡ 自動排班」一鍵產出
7. 檢視違規提醒，手動微調，完成排班
8. 按「📷 匯出圖片」選擇門市，下載桌曆式班表圖片

### 門市管理

在「門市設定」頁的「🏪 門市管理」區塊：

- **新增門市**：點「➕ 新增門市」，輸入全名與縮寫（最多 8 家）
- **編輯門市**：點「✏️ 編輯」修改名稱或縮寫
- **刪除門市**：點「🗑 刪除」（有排班資料時會提示確認並自動清除）

### 員工門市指派

每位員工可設定：
- **不指定**：三家門市皆可排班（系統平均分配）
- **指定門市**：只排到指定的門市，並可進一步設定「偏好優先門市」

### 自動排班演算法

- 優先填滿週末（週六、週日）
- 依員工剩餘可排班次數從高到低排序
- 遵守：門市指派限制、互斥約束、同日不排多店、連續排班上限

---

## 版本紀錄

| 版本 | 日期 | 主要更新 |
|------|------|---------|
| **v2.8** | 2026-07-16 | 重大修復：儲存可靠性強化 — 登入逾時偵測、切月競態修復、空覆寫防護、自動備份、儲存重試、歷史班表查詢 |
| v2.7 | 2026-05-05 | 動態門市管理（新增/編輯/刪除）、擴充 8 色色彩系統 |
| v2.6 | 2026-04-11 | Cloudflare 雲端部署、多人即時共用、Zero Trust 保護 |
| v2.5 | 2026-04-08 | 違規偵測全面升級、同日多店衝突偵測 |
| v2.4 | 2026-04-07 | 匯出圖片支援深淺主題 |
| v2.3 | 2026-04-07 | 新增匯出班表圖片功能 |
| v2.2 | 2026-04-07 | 門市指派重設計、深淺主題切換 |
| v2.1 | 2026-04-01 | 門市指派模式、假日預設雙人 |
| v2.0 | 2026-03-29 | 品牌升級、使用說明頁面 |
| v1.x | 2026-03-29 | 核心排班功能、互斥排班、localStorage |

---

## 常見問題

**Q：多人同時修改會衝突嗎？**  
A：KV 採 last-write-wins，建議操作前先按「🔄 同步」按鈕拉取最新資料。

**Q：KV 費用？**  
A：Cloudflare KV 免費方案每天 10 萬次讀取、1,000 次寫入，日常使用遠不超過。

**Q：如何備份資料？**  
A：在「門市設定」→「資料管理」點「匯出 JSON」即可下載完整備份檔案。

**Q：刪除門市後能恢復嗎？**  
A：無法自動恢復。建議刪除前先匯出 JSON 備份。

---

## License

MIT © 2026 THE food co. 同興實業
