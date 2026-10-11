/**
 * Bước trích xuất ảnh kèo bằng Gemini (Google AI Studio REST).
 *
 * Ranh giới bắt buộc:
 * - GEMINI_API_KEY chỉ nằm ở server, TUYỆT ĐỐI không trả về client.
 * - Prompt yêu cầu JSON + `confidence` cho TỪNG ô số; client sẽ hiển thị
 *   cảnh báo để người dùng tự xác nhận, không tự động tin 100%.
 * - Nếu không đọc được (ảnh mờ, không phải bảng kèo) → trả `rows: []`,
 *   tuyệt đối không bịa số.
 */

import { env } from './env.js'

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'

/** Ô kèo đọc được từ ảnh. */
export interface ExtractedRow {
    kind: 'totals' | 'ah'
    side: 'over' | 'under' | 'home' | 'away'
    /** Mốc kèo: 2.5, -0.25… (kèo châu Âp/rời có thể là số thập phân 1 phần tư) */
    line: number
    odds: number
    /** 0..1 — mô hình tự chấm điểm độ tin cậy của ô này. */
    confidence: number
    note?: string
}

/** Thông tin trận đọc được (tùy chọn, có thể rỗng). */
export interface ExtractedMeta {
    home?: string
    away?: string
    league?: string
    kickoff?: string | null
    confidence?: number
}

export interface ExtractResult {
    rows: ExtractedRow[]
    meta: ExtractedMeta
    /** true nếu có ô dưới ngưỡng → UI bắt buộc người dùng kiểm tra lại. */
    lowConfidence: boolean
    /** Ghi chú/giải thích từ model (tiếng Việt). */
    note?: string
    model: string
}

export interface ImageInput {
    mimeType: string
    /** Không có tiền tố data:image/...;base64 */
    data: string
}

export class GeminiError extends Error {
    readonly status: number

    constructor(message: string, status: number) {
        super(message)
        this.name = 'GeminiError'
        this.status = status
    }
}

const PROMPT = `Bạn là công cụ OCR cho bảng kèo bóng đá (odds) của nhà cái.

Nhiệm vụ: đọc ảnh người dùng gửi và trả về JSON thuần, KHÔNG markdown, KHÔNG giải thích ngoài JSON.

Quy tắc bắt buộc:
1. Chỉ trích xuất những gì NHÌN THẤY THẬT trong ảnh. Tuyệt đối không đoán, không nội suy, không bịa số.
2. Mỗi dòng kèo gồm: loại ("totals" = trên/dưới, "ah" = khi cược chấp),
   phía ("over"/"under" hoặc "home"/"away"), mốc kèo (line) và tỉ lệ (odds).
   Ví dụ mốc 2.5 cho tổng bàn; mốc -0.25 / 0.25 cho khi cược chấp CHÂU ÂP.
3. "confidence" là số 0..1 do bạn tự chấm cho từng dòng:
   - 0.95–1.0: chữ rõ nét, không mơ hồ
   - 0.6–0.95: hơi mờ nhưng đọc chắc
   - 0.3–0.6: mờ/không rõ, cần người dùng kiểm tra
   - Dưới 0.3 thì bỏ dòng đó, đừng trả về.
4. Nếu ảnh không phải bảng kèo, hoặc không đọc được ô nào → trả "rows": [] và note giải thích.
5. odds là số thập phân dương (ví dụ 2.15). line là số thập phân có thể âm.

JSON cần đúng cấu trúc:
{
  "rows": [{"kind":"totals|ah","side":"over|under|home|away","line":2.5,"odds":2.15,"confidence":0.9,"note":"tu chon"}],
  "meta": {"home":"ten doi chu nha","away":"ten doi khach","league":"giai","kickoff":null,"confidence":0.8},
  "note": "ghi chu ngan gon"
}`

function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0
    return Math.min(1, Math.max(0, n))
}

function num(v: unknown): number | null {
    const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''))
    return Number.isFinite(n) ? n : null
}

/** Làm sạch phần JSON do model trả về (bỏ code fence, cắt sau object cuối). */
function stripJsonFence(text: string): string {
    let t = text.trim()
    if (t.startsWith('```')) {
        t = t.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim()
    }
    return t
}

/**
 * Gọi Gemini đọc ảnh.
 * @throws {GeminiError} khi thiếu API key, lỗi mạng, HTTP lỗi hoặc JSON không hợp lệ.
 */
export async function extractOddsFromImages(
    images: ImageInput[],
    hint: ExtractedMeta = {},
): Promise<ExtractResult> {
    if (!env.geminiApiKey) {
        throw new GeminiError('Chưa cấu hình GEMINI_API_KEY trên server.', 503)
    }
    if (images.length === 0) {
        throw new GeminiError('Không có ảnh nào được gửi.', 400)
    }

    const parts: Record<string, unknown>[] = [{ text: PROMPT }]

    if (hint.home || hint.away) {
        parts.push({
            text: `Gợi ý từ người dùng (có thể sai, chỉ để đối chiếu): chủ ${hint.home ?? '?'} – khách ${hint.away ?? '?'}${hint.league ? `, giải ${hint.league}` : ''}.`,
        })
    }

    for (const img of images) {
        parts.push({
            inline_data: { mime_type: img.mimeType, data: img.data },
        })
    }

    const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
        },
    }

    let res: Response
    try {
        res = await fetch(`${ENDPOINT}/${env.geminiModel}:generateContent`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': env.geminiApiKey,
            },
            body: JSON.stringify(body),
        })
    } catch (e) {
        throw new GeminiError(
            `Không gọi được Gemini: ${e instanceof Error ? e.message : 'lỗi mạng'}`,
            502,
        )
    }

    if (!res.ok) {
        const detail = await res.text().catch(() => '')
        console.error('[gemini] HTTP', res.status, detail.slice(0, 500))
        throw new GeminiError(`Gemini trả lỗi HTTP ${res.status}.`, 502)
    }

    const json = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''

    let parsed: {
        rows?: unknown[]
        meta?: Record<string, unknown>
        note?: string
    }
    try {
        parsed = JSON.parse(stripJsonFence(text))
    } catch {
        throw new GeminiError('Gemini không trả về JSON hợp lệ.', 502)
    }

    const rows: ExtractedRow[] = []
    for (const raw of Array.isArray(parsed.rows) ? parsed.rows : []) {
        const r = raw as Record<string, unknown>
        const kind = r.kind === 'ah' ? 'ah' : 'totals'
        const side = r.side
        if (side !== 'over' && side !== 'under' && side !== 'home' && side !== 'away') continue
        if (kind === 'totals' && side !== 'over' && side !== 'under') continue
        if (kind === 'ah' && side !== 'home' && side !== 'away') continue

        const line = num(r.line)
        const odds = num(r.odds)
        if (line === null || odds === null || odds <= 1.01 || odds > 500) continue

        const confidence = clamp01(num(r.confidence) ?? 0.3)
        if (confidence < 0.3) continue // quá mờ → bỏ, đừng bịa

        rows.push({
            kind,
            side,
            line,
            odds,
            confidence,
            note: typeof r.note === 'string' ? r.note.slice(0, 160) : undefined,
        })
    }

    const m = parsed.meta ?? {}
    const meta: ExtractedMeta = {
        home: typeof m.home === 'string' && m.home.trim() ? m.home.trim().slice(0, 80) : undefined,
        away: typeof m.away === 'string' && m.away.trim() ? m.away.trim().slice(0, 80) : undefined,
        league:
            typeof m.league === 'string' && m.league.trim() ? m.league.trim().slice(0, 80) : undefined,
        kickoff: typeof m.kickoff === 'string' && m.kickoff.trim() ? m.kickoff.trim().slice(0, 64) : null,
        confidence: clamp01(num(m.confidence) ?? 0.3),
    }

    return {
        rows,
        meta,
        lowConfidence: rows.some((r) => r.confidence < 0.8),
        note: typeof parsed.note === 'string' ? parsed.note.slice(0, 300) : undefined,
        model: env.geminiModel,
    }
}