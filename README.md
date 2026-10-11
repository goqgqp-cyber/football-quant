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
| G2 | Backend + đăng nhập/JWT cookie HttpOnly + refresh rotation + Upstash (lịch sử, đối soát, calibration) | ⏳ Chưa |
| G3 | Upload ảnh + Gemini trích xuất + bảng xác nhận số liệu | ⏳ Chưa |
| G4 | Bước A (Gemini + Google Search grounding) + SSE stream tiến trình | ⏳ Chưa |
| G5 | Bước C (giải thích + kiểm tra con số) + tối ưu hiệu năng | ⏳ Chưa |
| G6 | Hướng dẫn deploy + README đầy đủ | ⏳ Chưa |

---

## Chạy dự án (G1)

Yêu cầu: **Node.js ≥ 20** (khuyến nghị LTS 22/24).

```bash
npm install
npm run dev      # mở http://localhost:5173
npm test         # unit test module tính toán
npm run build    # typecheck + build production
```

---

## Kiến trúc (định hướng)

```
src/
  lib/           # LÕI TÍNH TOÁN — TypeScript thuần, không phụ thuộc UI
    types.ts     # schema dữ liệu (MatchData, OddsLine, Pick, ...)
    math.ts      # poissonPmf, shrink, normalize, clamp
    poisson.ts   # ước lượng λ + ma trận tỉ số + Dixon-Coles + top tỉ số
    markets.ts   # Tài/Xỉu, kèo chấp châu Á, xử lý mốc 1/4
    engine.ts    # EV/Edge, lọc kèo, mức tin cậy, Kelly, analyzeMatch()
    settle.ts    # đối soát sau trận, calibration bin, Brier score
    mock.ts      # dữ liệu GIẢ cho G1
  components/    # UI: Starfield, Nav, GlassCard, Button, PickCard, ...
  pages/         # 4 trang: Phân tích, Lịch sử, Hiệu suất, Tài khoản
  hooks/         # useHashRoute, useSettings
```

**Nguyên tắc bất biến:** frontend **không bao giờ** gọi Gemini hay Upstash trực tiếp.
Mọi lời gọi đi qua lớp server (G2+). Không có khóa API/token nào trong bundle frontend.

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

### Unit test (7 test, tất cả xanh)

- Tổng ma trận = 1
- `thắng + hoàn + thua = 1` cho Tài/Xỉu (2.5, 3.0, 1/4 2.75) và chấp châu Á (0, −0.5, −0.25, 0.75)
- Mốc 1/4 chia đúng: `P(2.75) = (P(2.5) + P(3.0)) / 2`
- `Edge = EV / odds`
- Đối soát mốc 1/4: `over 2.75` với tổng 3 bàn → **thắng nửa**; `over 3.0` → **hoàn**

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

---

## Biến môi trường

Xem [`.env.example`](.env.example). Không commit `.env` thật (đã có trong `.gitignore`).

| Biến | Dùng ở | Ghi chú |
|---|---|---|
| `GEMINI_API_KEY` | Backend | Không nhúng frontend |
| `GEMINI_MODEL` | Backend | ví dụ `gemini-2.5-flash` |
| `UPSTASH_REDIS_REST_URL` | Backend | |
| `UPSTASH_REDIS_REST_TOKEN` | Backend | |
| `JWT_SECRET` | Backend | chuỗi ngẫu nhiên ≥ 32 ký tự |
| `ADMIN_EMAIL` | Backend | tài khoản được tạo khi tắt đăng ký công khai |
| `ALLOW_PUBLIC_SIGNUP` | Backend | mặc định `false` |
| `STORE_ORIGINAL_IMAGES` | Backend | mặc định `false` |

---

## Ghi chú

- G1 dùng **dữ liệu giả** (`src/lib/mock.ts`) — mọi nơi hiển thị đều ghi rõ "giả lập".
- Nếu môi trường không chạy backend an toàn được, sẽ đề xuất export qua **Cloud Run**
  hoặc **Vercel**; khóa chỉ nằm ở server.
