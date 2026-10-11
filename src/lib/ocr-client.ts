/**
 * Direct Browser-to-xKiro API Client
 * ---------------------------------------------------------------------------
 * Bỏ qua hoàn toàn backend Vercel Serverless Function (trần 10s của Vercel Hobby)
 * để loại bỏ triệt để lỗi HTTP 504 Gateway Timeout.
 * Trình duyệt gửi request trực tiếp đến https://api.xkiro.com/v1/chat/completions
 * với timeout 90 giây.
 */

import type { ExtractedOddsItem, ExtractedRow, ExtractResponse } from './api'

export const XKIRO_CLIENT_API_KEY = (
    (typeof import.meta !== 'undefined' &&
        (import.meta as unknown as { env?: Record<string, string> })?.env?.VITE_XKIRO_API_KEY) ||
    (typeof process !== 'undefined' &&
        (process.env?.NEXT_PUBLIC_XKIRO_API_KEY || process.env?.XKIRO_API_KEY)) ||
    'sk-xl-589f55ae70854e45cae40b670eca7e0eef5d895e60fc903e'
).trim()

/**
 * 2. Fast & Sharp Client-Side Canvas Pre-processing
 * - Nếu width > 1600px, thu nhỏ tỉ lệ về max width 1600px
 * - Xuất image/jpeg chất lượng 0.88
 * - Giảm payload từ nhiều MB xuống ~250KB, giữ sắc nét từng số thập phân odds và dấu (+/-).
 */
export async function preprocessImageToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        if (!file.type.startsWith('image/')) {
            reject(new Error('File tải lên không phải là ảnh hợp lệ.'))
            return
        }

        const img = new Image()
        const objectUrl = URL.createObjectURL(file)

        img.onload = () => {
            URL.revokeObjectURL(objectUrl)
            const MAX_WIDTH = 1600
            let { width, height } = img

            if (width > MAX_WIDTH) {
                height = Math.round((height * MAX_WIDTH) / width)
                width = MAX_WIDTH
            }

            const canvas = document.createElement('canvas')
            canvas.width = width
            canvas.height = height
            const ctx = canvas.getContext('2d')

            if (!ctx) {
                reject(new Error('Không thể khởi tạo Canvas 2D context.'))
                return
            }

            ctx.imageSmoothingEnabled = true
            ctx.imageSmoothingQuality = 'high'
            ctx.fillStyle = '#FFFFFF'
            ctx.fillRect(0, 0, width, height)
            ctx.drawImage(img, 0, 0, width, height)

            try {
                const dataUrl = canvas.toDataURL('image/jpeg', 0.88)
                resolve(dataUrl)
            } catch (err) {
                reject(err instanceof Error ? err : new Error('Lỗi mã hóa canvas toDataURL.'))
            }
        }

        img.onerror = () => {
            URL.revokeObjectURL(objectUrl)
            reject(new Error('Không thể tải dữ liệu ảnh từ thiết bị.'))
        }

        img.src = objectUrl
    })
}

/** Loại bỏ triệt để markdown code blocks và dấu backticks */
export function cleanJsonFence(text: string): string {
    let t = text.trim()
    if (t.startsWith('```')) {
        t = t.replace(/^```[a-zA-Z]*\r?\n?/, '').replace(/\r?\n?```\s*$/, '').trim()
    }
    const jsonMatch = t.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
    if (jsonMatch) {
        return jsonMatch[0].trim()
    }
    return t
}

/**
 * Gửi ảnh trực tiếp từ trình duyệt đến xKiro Vision API.
 * Timeout 90 giây, duyệt qua danh sách model tối ưu tốc độ.
 */
export async function extractOddsDirectClient(
    files: File[],
    hint: { home?: string; away?: string; league?: string } = {},
): Promise<ExtractResponse> {
    if (files.length === 0) {
        throw new Error('Vui lòng chọn ít nhất 1 ảnh bảng kèo.')
    }

    // 1. Tiền xử lý tất cả ảnh qua Canvas (max width 1600px, JPEG 0.88)
    const dataUrls = await Promise.all(files.map((f) => preprocessImageToDataUrl(f)))

    // 2. Chuẩn bị prompt bóc tách
    const promptText = `Bạn là Chuyên gia Thị giác Máy tính và OCR Bảng Kèo Bóng Đá.
Nhiệm vụ: Trích xuất chính xác toàn bộ bảng kèo cược, tên hai đội, giải đấu, phút thi đấu (nếu đang đá) và tỉ số từ ảnh bảng kèo nhà cái.
${hint.home || hint.away ? `Gợi ý đối chiếu: chủ "${hint.home || '?'}" - khách "${hint.away || '?'}"` : ''}

QUY TẮC BẮT BUỘC:
1. BẮT BUỘC trả về DUY NHẤT một chuỗi JSON thuần hợp lệ, TUYỆT ĐỐI KHÔNG dùng markdown block (\`\`\`json hoặc \`\`\`), không có văn bản hay lời chào nào ngoài JSON.
2. Trích xuất đúng tên đội thật trong ảnh, không mặc định Arsenal hay Chelsea nếu ảnh không phải.

CẤU TRÚC JSON MẪU:
{
  "homeTeam": "Tên đội nhà",
  "awayTeam": "Tên đội khách",
  "league": "Tên giải đấu",
  "isLive": false,
  "currentMinute": null,
  "currentScore": { "home": 0, "away": 0 },
  "period": "Pre-match",
  "odds": [
    { "type": "hdp", "target": "home", "line": -0.5, "odds": 1.95 },
    { "type": "hdp", "target": "away", "line": 0.5, "odds": 1.92 },
    { "type": "ou", "target": "over", "line": 2.5, "odds": 1.88 },
    { "type": "ou", "target": "under", "line": 2.5, "odds": 1.98 }
  ],
  "rows": [
    { "kind": "ah", "side": "home", "line": -0.5, "odds": 1.95, "confidence": 0.95 },
    { "kind": "ah", "side": "away", "line": 0.5, "odds": 1.92, "confidence": 0.95 },
    { "kind": "totals", "side": "over", "line": 2.5, "odds": 1.88, "confidence": 0.95 },
    { "kind": "totals", "side": "under", "line": 2.5, "odds": 1.98, "confidence": 0.95 }
  ],
  "note": "Bóc tách thành công"
}`

    const contentParts: Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }> = [
        { type: 'text', text: promptText },
        ...dataUrls.map((url) => ({
            type: 'image_url' as const,
            image_url: { url },
        })),
    ]

    // Danh sách model ưu tiên xử lý thị giác
    const candidateModels = [
        'qwen/qwen3.8-omni-flash',
        'qwen/qwen3.8-omni-flash:free',
        'qwen/qwen-2.5-vl-72b-instruct',
        'qwen/qwen3.8-max',
    ]

    let lastError: Error | null = null
    let responseText = ''
    let chosenModel = candidateModels[0]

    for (const model of candidateModels) {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 90000) // 90s browser timeout
        chosenModel = model

        try {
            const res = await fetch('https://api.xkiro.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${XKIRO_CLIENT_API_KEY}`,
                },
                body: JSON.stringify({
                    model,
                    temperature: 0.0,
                    max_tokens: 1500,
                    messages: [
                        {
                            role: 'user',
                            content: contentParts,
                        },
                    ],
                }),
                signal: controller.signal,
            })

            clearTimeout(timeoutId)

            if (!res.ok) {
                const errText = await res.text().catch(() => '')
                throw new Error(`xKiro HTTP ${res.status}: ${errText || res.statusText}`)
            }

            const json = (await res.json()) as {
                choices?: Array<{ message?: { content?: string } }>
            }
            responseText = json.choices?.[0]?.message?.content ?? ''
            if (responseText.trim()) {
                break // Thành công!
            }
        } catch (err) {
            clearTimeout(timeoutId)
            lastError = err instanceof Error ? err : new Error(String(err))
            if (err instanceof DOMException && err.name === 'AbortError') {
                throw new Error('Quá thời gian chờ xKiro API (90 giây). Vui lòng thử lại.')
            }
            console.warn(`[Direct-xKiro] Thử model ${model} không thành công (${lastError.message}), đang chuyển fallback…`)
        }
    }

    if (!responseText.trim()) {
        throw lastError || new Error('xKiro API không trả về nội dung bảng cược.')
    }

    // 3. Phân tích cú pháp JSON
    let parsed: {
        homeTeam?: string
        awayTeam?: string
        league?: string
        isLive?: boolean
        currentMinute?: number | null
        currentScore?: { home: number; away: number } | null
        period?: string
        odds?: ExtractedOddsItem[]
        rows?: ExtractedRow[]
        note?: string
    }

    try {
        const cleaned = cleanJsonFence(responseText)
        parsed = JSON.parse(cleaned)
    } catch {
        throw new Error('xKiro không trả về định dạng JSON hợp lệ cho bảng kèo.')
    }

    // 4. Đồng bộ hóa giữa rows và odds
    const rows: ExtractedRow[] = []
    if (Array.isArray(parsed.rows) && parsed.rows.length > 0) {
        for (const r of parsed.rows) {
            const kind = r.kind === 'ah' ? 'ah' : 'totals'
            const side = r.side
            if (side !== 'over' && side !== 'under' && side !== 'home' && side !== 'away') continue
            const line = typeof r.line === 'number' ? r.line : parseFloat(String(r.line || '0'))
            const oddsVal = typeof r.odds === 'number' ? r.odds : parseFloat(String(r.odds || '1.9'))
            rows.push({
                kind,
                side,
                line: Number.isFinite(line) ? line : 0,
                odds: Number.isFinite(oddsVal) ? oddsVal : 1.9,
                confidence: typeof r.confidence === 'number' ? r.confidence : 0.95,
                note: r.note ? String(r.note) : undefined,
            })
        }
    } else if (Array.isArray(parsed.odds) && parsed.odds.length > 0) {
        for (const o of parsed.odds) {
            const kind = o.type === 'hdp' ? 'ah' : 'totals'
            const side = o.target
            if (side !== 'over' && side !== 'under' && side !== 'home' && side !== 'away') continue
            const line = typeof o.line === 'number' ? o.line : parseFloat(String(o.line || '0'))
            const oddsVal = typeof o.odds === 'number' ? o.odds : parseFloat(String(o.odds || '1.9'))
            rows.push({
                kind,
                side,
                line: Number.isFinite(line) ? line : 0,
                odds: Number.isFinite(oddsVal) ? oddsVal : 1.9,
                confidence: 0.95,
            })
        }
    }

    const oddsList: ExtractedOddsItem[] = Array.isArray(parsed.odds) ? parsed.odds : rows.map((r) => ({
        type: r.kind === 'ah' ? ('hdp' as const) : ('ou' as const),
        target: r.side,
        line: r.line,
        odds: r.odds,
    }))

    const lowConfidence = rows.some((r) => r.confidence < 0.8)

    return {
        rows,
        meta: {
            home: parsed.homeTeam,
            away: parsed.awayTeam,
            league: parsed.league,
            kickoff: null,
            confidence: 0.95,
        },
        homeTeam: parsed.homeTeam,
        awayTeam: parsed.awayTeam,
        league: parsed.league,
        isLive: Boolean(parsed.isLive),
        currentMinute: parsed.currentMinute ?? null,
        currentScore: parsed.currentScore ?? null,
        period: parsed.period,
        odds: oddsList,
        lowConfidence,
        note: parsed.note ?? 'Trích xuất trực tiếp thành công từ xKiro.',
        model: chosenModel,
    }
}
