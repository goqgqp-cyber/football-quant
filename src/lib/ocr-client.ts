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
 * Client-Side Canvas Pre-Compression (OddsUpload / Image Upload)
 * - Load image vào HTML Image object
 * - Nếu ảnh < 3.5MB: Giữ nguyên độ phân giải gốc để chữ và số nhỏ trên bảng kèo cực kỳ sắc nét.
 * - Chỉ thu nhỏ tỉ lệ nếu ảnh vượt 3.5MB hoặc vượt quá maxWidth (2560px):
 *     if (!isUnder3_5MB && width > maxWidth) {
 *       height = Math.round((height * maxWidth) / width);
 *       width = maxWidth;
 *     }
 * - Xuất image/jpeg chất lượng 0.95 sắc nét tối đa hoặc PNG trực tiếp nếu tệp nhỏ.
 * - Đảm bảo các dòng chữ nhỏ ("Cược Tài/Xỉu hiệp 1") và tỉ lệ odds không bị vỡ/nhoè.
 */
export async function compressImageToJpegBase64(
    file: File,
    maxWidth = 2560,
    quality = 0.95,
): Promise<{ mimeType: string; data: string; dataUrl: string }> {
    return new Promise((resolve, reject) => {
        if (!file.type.startsWith('image/')) {
            reject(new Error('Tệp tải lên không phải là ảnh hợp lệ.'))
            return
        }

        const img = new Image()
        const objectUrl = URL.createObjectURL(file)

        img.onload = () => {
            URL.revokeObjectURL(objectUrl)
            let width = img.naturalWidth || img.width
            let height = img.naturalHeight || img.height

            // Nếu ảnh <= 3.5MB: KHÔNG giảm kích thước nếu width <= 2560px (giữ nguyên độ phân giải gốc)
            const isUnder3_5MB = file.size <= 3.5 * 1024 * 1024

            if (!isUnder3_5MB && width > maxWidth) {
                height = Math.round((height * maxWidth) / width)
                width = maxWidth
            } else if (width > 2560) {
                // Kẹp chặn 2560px cho ảnh 4K/siêu rộng tránh tràn bộ nhớ canvas
                height = Math.round((height * 2560) / width)
                width = 2560
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
                // Nếu ảnh gốc là PNG và dung lượng nhỏ, ưu tiên giữ PNG sắc nét không nén
                if (file.type === 'image/png' && isUnder3_5MB) {
                    try {
                        const pngDataUrl = canvas.toDataURL('image/png')
                        if (pngDataUrl.length < 5 * 1024 * 1024) {
                            const base64Data = pngDataUrl.replace(/^data:image\/png;base64,/, '')
                            resolve({
                                mimeType: 'image/png',
                                data: base64Data,
                                dataUrl: pngDataUrl,
                            })
                            return
                        }
                    } catch {
                        // Fallback to jpeg 0.95
                    }
                }

                // Xuất JPEG với chất lượng 0.95 (giữ nguyên độ nét của số thập phân và tiêu đề nhỏ)
                const dataUrl = canvas.toDataURL('image/jpeg', quality)
                const base64Data = dataUrl.replace(/^data:image\/jpeg;base64,/, '')
                resolve({
                    mimeType: 'image/jpeg',
                    data: base64Data,
                    dataUrl,
                })
            } catch (err) {
                reject(err instanceof Error ? err : new Error('Lỗi mã hóa canvas toDataURL.'))
            }
        }

        img.onerror = () => {
            URL.revokeObjectURL(objectUrl)
            reject(new Error('Không thể đọc dữ liệu ảnh từ thiết bị.'))
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

    // 1. Tiền xử lý tất cả ảnh qua Canvas (tối đa 2560px, JPEG 0.95 sắc nét tối đa)
    const compressedList = await Promise.all(files.map((f) => compressImageToJpegBase64(f, 2560, 0.95)))

    // 2. Chuẩn bị prompt bóc tách
    const promptText = `Bạn là Chuyên gia Thị giác Máy tính và OCR Bảng Kèo Bóng Đá (Sportsbook Vision Expert).
Nhiệm vụ: Trích xuất chính xác toàn bộ bảng kèo cược, tên hai đội, giải đấu, phút thi đấu (nếu đang đá) và tỉ số từ ảnh bảng kèo nhà cái.
${hint.home || hint.away ? `Gợi ý đối chiếu: chủ "${hint.home || '?'}" - khách "${hint.away || '?'}"` : ''}

QUY TẮC BỐ CỤC BẢNG KÈO (2 CỘT SONG SONG):
BẢNG CƯỢC CÓ 2 CỘT SONG SONG:
- Cột trái: Các mục Cược trực tiếp cả trận (1X2, Kèo chấp cả trận, Tài/xỉu cả trận). TẤT CẢ các dòng thuộc cụm này đều mang period: 'FT'.
- Cột phải: Các mục Cược Hiệp 1 (1X2 Hiệp 1, Kèo chấp Hiệp 1, Cược Tài/Xỉu hiệp 1, Cược Tài/Xỉu tổng số bàn thắng hiệp 1). TẤT CẢ các dòng thuộc cụm này BẮT BUỘC mang period: 'HT'.

QUY TẮC BẮT BUỘC:
1. Mọi kèo nằm dưới tiêu đề chứa "Hiệp 1", "H1", "1st Half" BẮT BUỘC gán period: "HT" và phân loại đối tượng rõ ràng [Tài/Xỉu Bàn H1] hoặc [Châu Á Bàn H1].
2. TUYỆT ĐỐI KHÔNG BAO GIỜ dán nhãn kèo Hiệp 1 thành [Tài/Xỉu Bàn FT] hay FT!
3. Phân biệt rõ ràng kèo Bàn Thắng (object: "goals") và Phạt Góc (object: "corners").
4. BẮT BUỘC trả về DUY NHẤT một chuỗi JSON thuần hợp lệ, TUYỆT ĐỐI KHÔNG dùng markdown block (\`\`\`json hoặc \`\`\`), không có văn bản hay lời chào nào ngoài JSON.
5. Trích xuất đúng tên đội thật trong ảnh, không mặc định Arsenal hay Chelsea nếu ảnh không phải.

CẤU TRÚC JSON MẪU:
{
  "homeTeam": "Tên đội nhà",
  "awayTeam": "Tên đội khách",
  "league": "Tên giải đấu",
  "isLive": false,
  "currentMinute": null,
  "currentScore": { "home": 0, "away": 0 },
  "corners": null,
  "shots": null,
  "period": "Pre-match",
  "odds": [
    { "type": "hdp", "target": "home", "line": -0.5, "odds": 1.95, "period": "FT", "object": "goals" },
    { "type": "hdp", "target": "away", "line": 0.5, "odds": 1.92, "period": "FT", "object": "goals" },
    { "type": "ou", "target": "over", "line": 2.5, "odds": 1.88, "period": "FT", "object": "goals" },
    { "type": "ou", "target": "under", "line": 2.5, "odds": 1.98, "period": "FT", "object": "goals" },
    { "type": "ou", "target": "over", "line": 0.5, "odds": 1.85, "period": "HT", "object": "goals" },
    { "type": "ou", "target": "under", "line": 0.5, "odds": 1.95, "period": "HT", "object": "goals" }
  ],
  "rows": [
    { "kind": "ah", "side": "home", "line": -0.5, "odds": 1.95, "confidence": 0.95, "period": "FT", "object": "goals" },
    { "kind": "ah", "side": "away", "line": 0.5, "odds": 1.92, "confidence": 0.95, "period": "FT", "object": "goals" },
    { "kind": "totals", "side": "over", "line": 2.5, "odds": 1.88, "confidence": 0.95, "period": "FT", "object": "goals" },
    { "kind": "totals", "side": "under", "line": 2.5, "odds": 1.98, "confidence": 0.95, "period": "FT", "object": "goals" },
    { "kind": "totals", "side": "over", "line": 0.5, "odds": 1.85, "confidence": 0.95, "period": "HT", "object": "goals" },
    { "kind": "totals", "side": "under", "line": 0.5, "odds": 1.95, "confidence": 0.95, "period": "HT", "object": "goals" }
  ],
  "note": "Bóc tách thành công"
}`

    const contentParts: Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }> = [
        { type: 'text', text: promptText },
        ...compressedList.map((item) => ({
            type: 'image_url' as const,
            image_url: { url: item.dataUrl },
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

    // 4. Đồng bộ hóa giữa rows và odds (Chuẩn hóa nghiêm ngặt HT vs FT, Goals vs Corners)
    const normalizePeriod = (p?: unknown, note?: unknown): 'ft' | 'ht' => {
        const s = `${String(p || '')} ${String(note || '')}`.toLowerCase()
        if (s.includes('h1') || s.includes('ht') || s.includes('1st') || s.includes('hiệp 1') || s.includes('1h')) {
            return 'ht'
        }
        return 'ft'
    }

    const normalizeObject = (o?: unknown, note?: unknown): 'goals' | 'corners' => {
        const s = `${String(o || '')} ${String(note || '')}`.toLowerCase()
        if (s.includes('corner') || s.includes('goc') || s.includes('phạt góc')) {
            return 'corners'
        }
        return 'goals'
    }

    const rows: ExtractedRow[] = []
    if (Array.isArray(parsed.rows) && parsed.rows.length > 0) {
        for (const r of parsed.rows) {
            const kind = r.kind === 'ah' ? 'ah' : 'totals'
            const side = r.side
            if (side !== 'over' && side !== 'under' && side !== 'home' && side !== 'away') continue
            const line = typeof r.line === 'number' ? r.line : parseFloat(String(r.line || '0'))
            const oddsVal = typeof r.odds === 'number' ? r.odds : parseFloat(String(r.odds || '1.9'))
            const period = normalizePeriod(r.period, r.note)
            const object = normalizeObject(r.object, r.note)
            rows.push({
                kind,
                side,
                line: Number.isFinite(line) ? line : 0,
                odds: Number.isFinite(oddsVal) ? oddsVal : 1.9,
                confidence: typeof r.confidence === 'number' ? r.confidence : 0.95,
                note: r.note ? String(r.note) : undefined,
                period,
                object,
            })
        }
    } else if (Array.isArray(parsed.odds) && parsed.odds.length > 0) {
        for (const o of parsed.odds) {
            const kind = o.type === 'hdp' ? 'ah' : 'totals'
            const side = o.target
            if (side !== 'over' && side !== 'under' && side !== 'home' && side !== 'away') continue
            const line = typeof o.line === 'number' ? o.line : parseFloat(String(o.line || '0'))
            const oddsVal = typeof o.odds === 'number' ? o.odds : parseFloat(String(o.odds || '1.9'))
            const period = normalizePeriod(o.period)
            const object = normalizeObject(o.object)
            rows.push({
                kind,
                side,
                line: Number.isFinite(line) ? line : 0,
                odds: Number.isFinite(oddsVal) ? oddsVal : 1.9,
                confidence: 0.95,
                period,
                object,
            })
        }
    }

    const oddsList: ExtractedOddsItem[] = Array.isArray(parsed.odds)
        ? parsed.odds.map((o) => ({
              ...o,
              period: normalizePeriod(o.period),
              object: normalizeObject(o.object),
          }))
        : rows.map((r) => ({
              type: r.kind === 'ah' ? ('hdp' as const) : ('ou' as const),
              target: r.side,
              line: r.line,
              odds: r.odds,
              period: r.period,
              object: r.object,
          }))

    const lowConfidence = rows.some((r) => r.confidence < 0.8)

    let corners: { home: number; away: number } | null = null
    const rawCorners = (parsed as Record<string, unknown>).corners as Record<string, unknown> | undefined
    if (rawCorners && typeof rawCorners === 'object') {
        const ch = typeof rawCorners.home === 'number' ? rawCorners.home : parseInt(String(rawCorners.home || ''), 10)
        const ca = typeof rawCorners.away === 'number' ? rawCorners.away : parseInt(String(rawCorners.away || ''), 10)
        if (!isNaN(ch) && !isNaN(ca)) {
            corners = { home: Math.max(0, ch), away: Math.max(0, ca) }
        }
    }
    if (!corners && typeof responseText === 'string') {
        const cornerMatch = responseText.match(/(?:phạt\s*góc|góc|corner|corners|fg)[^\d\n\r]{0,25}(\d+)\s*[-:]\s*(\d+)/i)
        if (cornerMatch) {
            corners = { home: parseInt(cornerMatch[1], 10), away: parseInt(cornerMatch[2], 10) }
        }
    }

    let shots: { home: number; away: number } | null = null
    const rawShots = (parsed as Record<string, unknown>).shots as Record<string, unknown> | undefined
    if (rawShots && typeof rawShots === 'object') {
        const sh = typeof rawShots.home === 'number' ? rawShots.home : parseInt(String(rawShots.home || ''), 10)
        const sa = typeof rawShots.away === 'number' ? rawShots.away : parseInt(String(rawShots.away || ''), 10)
        if (!isNaN(sh) && !isNaN(sa)) {
            shots = { home: Math.max(0, sh), away: Math.max(0, sa) }
        }
    }
    if (!shots && typeof responseText === 'string') {
        const shotMatch = responseText.match(/(?:sút|shot|shots)[^\d\n\r]{0,25}(\d+)\s*[-:]\s*(\d+)/i)
        if (shotMatch) {
            shots = { home: parseInt(shotMatch[1], 10), away: parseInt(shotMatch[2], 10) }
        }
    }

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
        corners,
        shots,
        period: parsed.period,
        odds: oddsList,
        lowConfidence,
        note: parsed.note ?? 'Trích xuất trực tiếp thành công từ xKiro.',
        model: chosenModel,
    }
}
