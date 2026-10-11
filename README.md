# Football Quant — Phân tích kèo bóng đá

Web app tiếng Việt, mobile-first, phân tích xác suất kèo bóng đá bằng
**Poisson / Dixon-Coles** (code tự tính, không dùng LLM để tính), kết hợp
**Gemini + Google Search grounding** để thu thập dữ liệu thật và viết giải thích.

> ⚠️ Đây là phân tích xác suất, **không bảo đảm kết quả**. Chỉ cược số tiền bạn chấp nhận mất.
> App **không** có chức năng All-in / gấp thếp.

---

## Trạng thái các giai đoạn

| Giai đoạn | Nội dung | Trạng thái |
|---|---|---|
| **G1** | Khung app + giao diện (nền vũ trụ, liquid glass, chuyển động) + module tính toán TypeScript + unit test, dữ liệu giả | ✅ Hoàn tất |
| **G2** | Backend + đăng nhập/JWT cookie HttpOnly + refresh rotation + Upstash (lịch sử, đối soát, calibration) | ✅ Hoàn tất |
| **G3** | Upload ảnh + Gemini trích xuất + bảng xác nhận số liệu | ✅ Hoàn tất |
| **G4** | Bước A (Gemini + Google Search grounding) + SSE stream tiến trình | ✅ Hoàn tất |
| **G5** | Bước C (giải thích + kiểm tra con số) + tối ưu hiệu năng | ✅ Hoàn tất |
| **G6** | Hướng dẫn deploy + README đầy đủ | ✅ Hoàn tất |

---

## Chạy dự án

Yêu cầu: **Node.js ≥ 20** (khuyến nghị LTS 22/24).

```bash
npm install
npm run dev        # frontend Vite http://localhost:5173 (proxy /api -> 8787)
npm run dev:api    # backend Hono http://localhost:8787
npm run dev:all    # chạy cả hai song song
npm test           # vitest: 36 test (calc 7 + explain 9 + settle 11 + engine 9)
npm run smoke      # kiểm tra handler Vercel Node (health, auth, CSRF)
npm run typecheck  # tsc -b + tsc -p tsconfig.server.json
npm run build      # typecheck + build frontend + bundle API cho Vercel
```

Copy `.env.example` thành `.env` rồi điền khóa thật (không commit `.env`).

---

## Kiến trúc

```
src/
  lib/           # LÕI TÍNH TOÁN — TypeScript thuần, không phụ thuộc UI
    types.ts     # schema dữ liệu (MatchData, OddsLine, Pick, ...)
    math.ts      # poissonPmf, shrink, normalize, clamp
    poisson.ts   # ước lượng λ + ma trận tỉ số + Dixon-Coles + top tỉ số
    markets.ts   # Tài/Xỉu, kèo chấp châu Á, xử lý mốc 1/4
    engine.ts    # EV/Edge, lọc kèo, mức tin cậy, Kelly, analyzeMatch()
    settle.ts    # đối soát sau trận, calibration bin, Brier score
    explain.ts   # buildFacts / substituteFacts / verifyNumbers (Bước C)
    mock.ts      # dữ liệu GIẢ cho dev/offline
  components/    # UI: Starfield, Nav, GlassCard, Button, PickCard, ExplanationPanel, ...
  pages/         # 4 trang: Phân tích, Lịch sử, Hiệu suất, Tài khoản
  hooks/         # useHashRoute, useSettings, useAuth
server/
  app.ts         # Hono app: CORS, rate-limit, CSRF, mount routes
  index.ts       # serve @hono/node-server trên PORT (mặc định 8787)
  env.ts         # đọc + validate biến môi trường
  gemini.ts      # extractOddsFromImages, streamCollectMatchData, generateExplanation
  store.ts       # Upstash Redis: history, settle, stats
  routes/        # auth.ts, data.ts, extract.ts, stream.ts (SSE)
```

**Nguyên tắc bất biến:** frontend **không bao giờ** gọi Gemini hay Upstash trực tiếp.
Mọi lời gọi đi qua lớp server. Không có khóa API/token nào trong bundle frontend.

Luồng phân tích (`POST /api/collect/stream`, SSE qua `fetch` + `ReadableStream`):

1. `step collect` → Gemini + `google_search` thu thập phong độ, H2H, chấn thương (stream `delta`).
2. `data` → `MatchData` đã chuẩn hoá + `sources` (grounding metadata).
3. `step extract` → OCR ảnh kèo (nếu có) + bảng xác nhận ở client.
4. `step compute` → `analyzeMatch()` chạy cục bộ trên server (Poisson/Dixon-Coles).
5. `step explain` → Gemini viết 4 phần giải thích, **chỉ dùng token số `{{U..}}`** do engine cấp,
   server thay số thật qua `substituteFacts()` rồi quét lại bằng `verifyNumbers()`.
6. `explanation` + `result` → client hiển thị `ExplanationPanel` (4 phần + huy hiệu verified/caveats),
   `saveHistory()` lưu kèm `explanation` để xem lại ở trang Lịch sử.

---

## Công thức tính toán (đã cài đặt + kiểm thử)

**Ước lượng λ**

```
lg_avg = (lg_home + lg_away) / 2            # mặc định 1.45 / 1.15
shr(x,n) = (n·x + k·lg_avg) / (n + k)       # k = 5

λ_home = lg_home · (shr(home.xgf)/lg_avg) · (shr(away.xga)/lg_avg)
λ_away = lg_away · (shr(away.xgf)/lg_avg) · (shr(home.xga)/lg_avg)
```

`xgf/xga` ưu tiên; nếu `null` thì dùng `goals_for/goals_against`; nếu cả hai `null`
thì `shr()` trả về `lg_avg` (trung tính). **Không bịa số.**

**Ma trận tỉ số** 0..10 × 0..10 theo Poisson, nhân hiệu chỉnh Dixon-Coles
(`rho = -0.08`) cho 0-0, 0-1, 1-0, 1-1, chuẩn hoá tổng = 1.

**Kèo**
- Tài/Xỉu và chấp châu Á trả về bộ ba (thắng, hoàn, thua).
- Mốc 1/4 (2.25, 2.75, −0.25, …) được chia đôi tiền vào hai mốc kề nhau.
- `P_implied = 1/odds`; loại vig khi có đủ 2 đầu.
- `EV = P_thắng·(odds−1) − P_thua`; `Edge = EV/odds`.

**Lọc kèo:** odds ≥ 1.50 **và** Edge ≥ 5% **và** EV > 0 **và** lệch thị trường ≤ 15 điểm %.
Edge < 0 nhưng odds cao → gắn cờ `TRAP`.

**Mức tin cậy:** `(n ≥ 8) + (≥ 2 nguồn) + (lệch thị trường ≤ 7%)` → 3 Cao, 2 TB, còn lại Thấp.

**Mức vốn:** 25% Kelly, chặn trong **1.0%–2.5%** tổng vốn; tin cậy Thấp → 1.0%.
ROI / Brier / calibration **chỉ tính trên pick có `stakePct > 0`** (pick `noBet` bị loại).

### Unit test (36 test, tất cả xanh)

- **calc.ts (7 test):**
  - Tổng ma trận xác suất = 1
  - `thắng + hoàn + thua = 1` cho Tài/Xỉu (2.5, 3.0, 1/4 2.75) và chấp châu Á (0, −0.5, −0.25, 0.75)
  - Mốc 1/4 chia đúng: `P(2.75) = (P(2.5) + P(3.0)) / 2`
  - `Edge = EV / odds`
- **explain.ts (9 test):**
  - `fmt()`, `buildFacts()` sinh token `{{U..}}` + nhãn
  - `substituteFacts()` thay token và xóa token lạ `{{U999}}`
  - `verifyNumbers()` bỏ qua số cấu trúc 0–4 và bắt số bịa
- **settle.ts (11 test):**
  - Đối soát chấp châu Á (0, -0.25, +0.25, -0.75) với các trường hợp thắng, hoà, thua, thắng nửa, thua nửa
  - Đối soát Tài/Xỉu mốc 1/4 (over 2.75, under 2.25, under 2.75)
  - Đối soát theo hiệp 1 (`ht`) và cả trận (`ft`)
  - `totalProfit`, `binLabel` (5% buckets), `brierScore`, `buildCalibration`
- **engine.ts (9 test):**
  - `pImplied` và loại vig `pImpliedNoVig` giữa 2 cửa đối xứng
  - Công thức EV và Edge
  - Mức tin cậy `confidenceScore` (high, medium, low) theo số trận mẫu, số nguồn, độ lệch thị trường
  - Quản lý vốn `stakePct` theo 25% Kelly, chặn [1.0%, 2.5%]
  - Phân tích `analyzeMatch()`, phát hiện bẫy `trap`, và trả cờ `noBet` khi không đạt điều kiện
  - Danh sách kèo gợi ý `suggestedLines()`

---

## Giao diện

- **Tối, huyền ảo, tím.** Token màu trong `src/index.css` (`@theme`).
- **Nền vũ trụ:** canvas 2D starfield + parallax theo chuột/nghiêng thiết bị + sao băng;
  tạm dừng khi tab ẩn, giảm hạt trên mobile, tôn trọng `prefers-reduced-motion`.
- **Liquid glass:** `backdrop-filter: blur() saturate()`, viền sáng gradient, specular highlight
  theo con trỏ, fallback khi trình duyệt không hỗ trợ.
- **Khúc xạ cong:** SVG `feTurbulence` + `feDisplacementMap` (`#refraction`).
- **Chuyển động:** chỉ animate `transform`/`opacity`, spring physics, stagger, số đếm lên,
  thanh tiến trình có ánh sáng chạy, skeleton dạng kính.
- **Bước C:** `ExplanationPanel` hiển thị 4 phần (đối soát chỉ số / chiến thuật & nhân sự /
  đánh giá kèo & kịch bản thua / tổng kết) + huy hiệu `verified` + hộp `caveats` +
  hộp số chưa khớp (nếu có).

---

## Biến môi trường

Xem [`.env.example`](.env.example). Không commit `.env` thật (đã có trong `.gitignore`).

| Biến | Dùng ở | Ghi chú |
|---|---|---|
| `GEMINI_API_KEY` | Backend | Không nhúng frontend |
| `GEMINI_MODEL` | Backend | mặc định `gemini-flash-latest` (alias đã kiểm chứng); hoặc ID chính xác từ nút "Copy cURL quickstart" trong AI Studio |
| `UPSTASH_REDIS_REST_URL` | Backend | Có thể dùng `KV_REST_API_URL` của Vercel KV thay thế (tự nhận, không đổi code). Chỉ nhận URL dạng `http(s)://` — `KV_URL`/`REDIS_URL` là `rediss://` (TCP) nên bị bỏ qua. |
| `UPSTASH_REDIS_REST_TOKEN` | Backend | Có thể dùng `KV_REST_API_TOKEN` (token ghi/xóa đầy đủ; `KV_REST_API_READ_ONLY_TOKEN` không chạy được vì app cần ghi history/session). |
| `JWT_SECRET` | Backend | chuỗi ngẫu nhiên ≥ 32 ký tự |
| `ADMIN_EMAIL` | Backend | tài khoản được tạo khi tắt đăng ký công khai |
| `ALLOW_PUBLIC_SIGNUP` | Backend | mặc định `false` |
| `STORE_ORIGINAL_IMAGES` | Backend | mặc định `false` |
| `PORT` | Backend | mặc định `8787` |
| `CORS_ORIGINS` | Backend | danh sách origin cho phép, cách nhau dấu phẩy |
| `VITE_DEV_API_TARGET` | Frontend (dev) | target proxy `/api` khi `npm run dev` |

---

## Deploy (G6)

### Vercel (khuyến nghị — một project, một domain)

Repo đã kèm sẵn cấu hình để cả frontend **và** backend chạy trên cùng một project Vercel:

- `vercel.json` ghim `framework: vite`, build `npm run build` → `dist/`, và cấu hình `maxDuration: 60`
  cho các function API để luồng SSE phân tích (Gemini + Grounding) không bị timeout.
- Adapter Node Runtime (`server/vercel.ts`) được esbuild tự động bundle (qua `scripts/build-api.mjs`)
  thành `api/[...route].js` và `api/index.js` độc lập, đầy đủ dependency (Hono, Jose, Bcryptjs, Zod...).
  Hỗ trợ chunk streaming thời gian thực cho SSE `/api/collect/stream` và xử lý triệt để lỗi
  `this.raw.headers.get is not a function` của Edge adapter cũ.
- Frontend gọi same-origin `/api` (xem `src/lib/api.ts`) → **không cần `CORS_ORIGINS`** khi
  chạy trên Vercel.

**Các bước:**

1. Trên Vercel: **Settings → Build and Deployment → Framework Preset = Vite**,
   Root Directory = `.`, Build Command = `npm run build`, Output Directory = `dist`.
2. Thêm biến môi trường (mục dưới), rồi **Redeploy**.
3. Kiểm tra: mở `https://<domain>/api/health` → phải thấy `{"ok":true,...}`.

### Chạy self-host (Cloud Run / VPS)

- Build: `npm run build` → `dist/` (frontend); server chạy bằng `npm run start:api` (tsx)
  đặt sau reverse proxy và trỏ frontend tới cùng origin `/api`.
- Bắt buộc đặt `JWT_SECRET`, `UPSTASH_*`, `GEMINI_API_KEY` trên host.
- Không bao giờ expose `GEMINI_API_KEY` hay `UPSTASH_*` cho frontend.

### Lưu ý khi deploy Vercel

1. **Mọi biến chứa key/token phải lưu dạng Secret**, không dùng Plain Text — Vercel cảnh báo
   *“looks like a secret, but its value is visible to anyone with access”* nếu để dạng `<>`.
2. Xoay (rotate) secret đã từng lộ, rồi redeploy để biến mới được inject.
3. Biến tối thiểu cần có: `GEMINI_API_KEY`, `GEMINI_MODEL`, `JWT_SECRET`,
   và Redis REST (URL + token ghi/xóa).
4. `KV_URL` / `REDIS_URL` (`rediss://`) không dùng cho client REST — không cần đặt.
5. Vercel Hobby giới hạn thời lượng function (~60s); luồng SSE `collect/stream` chạy grounding
   + Gemini có thể chạm ngưỡng này trên gói free.

## Ghi chú

- Dev/offline dùng **dữ liệu giả** (`src/lib/mock.ts`) — mọi nơi hiển thị đều ghi rõ "giả lập".
- Auth: JWT access + refresh xoay vòng trong cookie HttpOnly (`fq_at`, `fq_rt`) + CSRF double-submit (`fq_csrf`).
- Rate-limit API: 240 req/phút/IP (in-memory).
