/**
 * xKiro AI Service — Dịch vụ gọi xKiro API chuẩn OpenAI format.
 * Model: qwen/qwen3.8-max:free
 * Base URL: https://api.xkiro.com/v1
 *
 * Chức năng:
 * 1. Phân tích định lượng trận đấu: xG (Expected Goals), mô hình Poisson, tỷ lệ ép sân, phạt góc.
 * 2. Giải thích 4 phần định lượng (Poisson, value/trap, kịch bản rủi ro).
 * 3. Trích xuất bảng kèo OCR qua multimodal vision chat completion.
 * 4. Trả về JSON thuần khớp với schema ứng dụng, không bọc trong markdown code block.
 */

import { env } from '../env.js'
import type {
    AnalysisResult,
    Explanation,
    H2H,
    MatchData,
    Source,
    TeamStats,
} from '../../src/lib/types.js'
import { buildFacts, factLabels, substituteFacts, verifyNumbers } from '../../src/lib/explain.js'
import { findSofaEvent, getEventH2H } from './sofascore.js'


export const XKIRO_BASE_URL = (env.xkiroBaseUrl || 'https://api.xkiro.com/v1').replace(/\/+$/, '')
export const XKIRO_MODEL = env.xkiroModel || 'qwen/qwen3.8-max:free'
export const XKIRO_ENDPOINT = `${XKIRO_BASE_URL}/chat/completions`

/** Ô kèo đọc được từ ảnh (OCR). */
export interface ExtractedRow {
    kind: 'totals' | 'ah'
    side: 'over' | 'under' | 'home' | 'away'
    line: number
    odds: number
    confidence: number
    note?: string
}

/** Thông tin trận đọc được. */
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
    homeTeam?: string
    awayTeam?: string
    league?: string
    isLive?: boolean
    currentMinute?: number | null
    currentScore?: { home: number; away: number } | null
    period?: string
    odds?: Array<{
        type: 'hdp' | 'ou' | '1x2'
        target: 'home' | 'away' | 'over' | 'under'
        line: number
        odds: number
    }>
    lowConfidence: boolean
    note?: string
    model: string
}


export interface ImageInput {
    mimeType: string
    /** Chuỗi base64 thuần (không có tiền tố data:image/...;base64) */
    data: string
}

export class XKiroError extends Error {
    readonly status: number

    constructor(message: string, status: number) {
        super(message)
        this.name = 'XKiroError'
        this.status = status
    }
}

function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0
    return Math.min(1, Math.max(0, n))
}

function num(v: unknown): number | null {
    const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''))
    return Number.isFinite(n) ? n : null
}

/**
 * Loại bỏ triệt để markdown code fences (```json ... ``` hoặc ``` ... ```)
 * để đảm bảo parse JSON thuần túy không bị lỗi cú pháp.
 */
export function stripJsonFence(text: string): string {
    let t = text.trim()
    if (t.startsWith('```')) {
        t = t.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim()
    }
    const jsonMatch = t.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
    if (jsonMatch) {
        return jsonMatch[0].trim()
    }
    return t
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Lọc bỏ triệt để chuỗi base64 hoặc nhị phân khỏi văn bản prompt nhằm tránh
 * token spike, đảm bảo không gửi nhầm ảnh vào các bước phân tích chuyên sâu.
 */
export function sanitizeCleanText(text: string): string {
    if (!text) return ''
    return text
        .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, '[IMAGE_REMOVED]')
        .replace(/[A-Za-z0-9+/]{250,}={0,2}/g, '[BLOB_REMOVED]')
        .trim()
}

export function appendApiKey(url: string, key: string): string {
    if (!key || url.includes('key=')) return url
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}key=${encodeURIComponent(key)}`
}

export function getModelCandidates(): string[] {
    return [XKIRO_MODEL]
}

/**
 * Gửi request tới xKiro API theo chuẩn OpenAI Chat Completions.
 */
export async function callXKiroChat(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: unknown }>,
    options: {
        stream?: boolean
        temperature?: number
        maxTokens?: number
    } = {},
): Promise<Response> {
    const apiKey = (env.xkiroApiKey || 'sk-xl-589f55ae70854e45cae40b670eca7e0eef5d895e60fc903e').trim()
    if (!apiKey) {
        throw new XKiroError('Chưa cấu hình XKIRO_API_KEY trên server.', 503)
    }

    const payload = {
        model: XKIRO_MODEL,
        messages,
        temperature: options.temperature ?? 0.2,
        stream: options.stream ?? false,
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    }

    let res: Response
    try {
        res = await fetch(XKIRO_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(payload),
        })
    } catch (e) {
        throw new XKiroError(
            `Không thể kết nối tới xKiro API (${XKIRO_ENDPOINT}): ${e instanceof Error ? e.message : 'lỗi mạng'}.`,
            502,
        )
    }

    if (!res.ok) {
        const errorText = await res.text().catch(() => '')
        let parsedMessage = ''
        try {
            const errObj = JSON.parse(errorText)
            parsedMessage = errObj?.error?.message || ''
        } catch {
            parsedMessage = errorText.slice(0, 200)
        }

        console.error(`[xkiro] HTTP ${res.status}:`, parsedMessage || errorText)
        throw new XKiroError(
            `xKiro API trả lỗi HTTP ${res.status}${parsedMessage ? `: ${parsedMessage}` : ''}`,
            res.status,
        )
    }

    return res
}

/**
 * Đọc phản hồi streaming dạng SSE (Server-Sent Events) từ OpenAI-compatible chat completions.
 */
async function readXKiroStream(
    res: Response,
    onDelta?: (chunk: string) => void,
): Promise<{ text: string }> {
    if (!res.body) {
        throw new XKiroError('Phản hồi xKiro API không có body.', 502)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let fullText = ''

    while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        let newlineIndex: number

        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIndex).trim()
            buffer = buffer.slice(newlineIndex + 1)

            if (!line || !line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload === '[DONE]') continue

            try {
                const parsed = JSON.parse(payload) as {
                    choices?: Array<{
                        delta?: { content?: string }
                        text?: string
                    }>
                }
                const chunkText = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.text ?? ''
                if (chunkText) {
                    fullText += chunkText
                    onDelta?.(chunkText)
                }
            } catch {
                // Bỏ qua dòng dở dang
            }
        }
    }

    return { text: fullText }
}

const OCR_PROMPT = `Bạn là Chuyên gia Thị giác Máy tính và OCR Bảng Kèo Bóng Đá (Sportsbook Odds Vision Analyst).
Nhiệm vụ: Phân tích ảnh chụp màn hình bảng kèo nhà cái và bóc tách cấu trúc dữ liệu JSON chính xác:
1. Thông tin hai đội:
   - homeTeam: string (tên chính xác Đội Nhà hiển thị trong ảnh).
   - awayTeam: string (tên chính xác Đội Khách hiển thị trong ảnh).
   - league: string (tên giải đấu, nếu nhìn thấy).
2. Trạng thái trong trận (Temporal & Live Grounding):
   - isLive: boolean (true nếu ảnh có dấu hiệu trận đang đá, ví dụ đồng hồ chạy phút "25:27", "Trong Trận", "Live", "2H", tỉ số đang chạy; false nếu là kèo trước trận / pre-match).
   - currentMinute: integer hoặc null (ví dụ: 25 nếu đồng hồ là "25:27", hoặc null nếu trước trận).
   - currentScore: object { "home": number, "away": number } (tỉ số hiện tại nếu trận đang đá, ví dụ { "home": 0, "away": 0 }).
   - period: string ("1st Half", "2nd Half", "Halftime", hoặc "Pre-match").
3. Bảng kèo cá cược:
   - odds: mảng các đối tượng { "type": "hdp" | "ou" | "1x2", "target": "home" | "away" | "over" | "under", "line": number, "odds": number }.
     * type="hdp": Kèo chấp Asian Handicap (target="home" hoặc "away", line là mốc chấp từ góc nhìn đội đó, ví dụ -0.5 hoặc +0.5 hoặc 0, odds là tỷ lệ ăn thập phân).
     * type="ou": Kèo Tài/Xỉu Over/Under (target="over" hoặc "under", line là mốc bàn thắng ví dụ 2.5, odds là tỷ lệ ăn).
     * type="1x2": Kèo Châu Âu 1X2 (target="home" hoặc "away", line=0, odds là tỷ lệ ăn).
   - rows: mảng chuẩn hóa { "kind": "totals" | "ah", "side": "over" | "under" | "home" | "away", "line": number, "odds": number, "confidence": number }.

QUY TẮC BẮT BUỘC:
1. Chỉ trích xuất số liệu nhìn thấy thật trong ảnh. TUYỆT ĐỐI không mặc định Arsenal hay Chelsea nếu ảnh không phải trận đó.
2. BẮT BUỘC trả về DUY NHẤT một chuỗi JSON thuần, KHÔNG bọc trong markdown code block (TUYỆT ĐỐI KHÔNG dùng \`\`\`json hoặc \`\`\`), KHÔNG có bất kỳ văn bản hay lời chào nào ngoài JSON.

CẤU TRÚC JSON MẪU BẮT BUỘC:
{
  "homeTeam": "Tên đội nhà",
  "awayTeam": "Tên đội khách",
  "league": "Giải đấu",
  "isLive": false,
  "currentMinute": null,
  "currentScore": { "home": 0, "away": 0 },
  "period": "Pre-match",
  "odds": [
    { "type": "ou", "target": "over", "line": 2.5, "odds": 1.95 },
    { "type": "ou", "target": "under", "line": 2.5, "odds": 1.90 },
    { "type": "hdp", "target": "home", "line": -0.25, "odds": 2.02 },
    { "type": "hdp", "target": "away", "line": 0.25, "odds": 1.88 }
  ],
  "rows": [
    { "kind": "totals", "side": "over", "line": 2.5, "odds": 1.95, "confidence": 0.95 },
    { "kind": "totals", "side": "under", "line": 2.5, "odds": 1.90, "confidence": 0.95 },
    { "kind": "ah", "side": "home", "line": -0.25, "odds": 2.02, "confidence": 0.92 },
    { "kind": "ah", "side": "away", "line": 0.25, "odds": 1.88, "confidence": 0.92 }
  ],
  "note": "Bóc tách thành công"
}`

/**
 * Đọc ảnh bảng kèo OCR sử dụng xKiro.
 */
export async function extractOddsFromImages(
    images: ImageInput[],
    hint: ExtractedMeta = {},
): Promise<ExtractResult> {
    if (!env.xkiroApiKey) {
        throw new XKiroError('Chưa cấu hình XKIRO_API_KEY trên server.', 503)
    }
    if (images.length === 0) {
        throw new XKiroError('Không có ảnh nào được gửi.', 400)
    }

    const contentParts: Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }> = [
        { type: 'text', text: OCR_PROMPT },
    ]

    // Chỉ đưa hint nếu người dùng cung cấp và không phải mock mặc định
    const hasMeaningfulHome = hint.home && hint.home.trim() && hint.home.trim().toLowerCase() !== 'arsenal'
    const hasMeaningfulAway = hint.away && hint.away.trim() && hint.away.trim().toLowerCase() !== 'chelsea'
    if (hasMeaningfulHome || hasMeaningfulAway) {
        contentParts.push({
            type: 'text',
            text: `Gợi ý đối chiếu: chủ ${sanitizeCleanText(hint.home ?? '?')} – khách ${sanitizeCleanText(hint.away ?? '?')}${hint.league ? `, giải ${sanitizeCleanText(hint.league)}` : ''}.`,
        })
    }

    for (const img of images) {
        contentParts.push({
            type: 'image_url',
            image_url: { url: `data:${img.mimeType};base64,${img.data}` },
        })
    }

    const res = await callXKiroChat(
        [{ role: 'user', content: contentParts }],
        { temperature: 0 },
    )

    const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
    }
    const text = json.choices?.[0]?.message?.content ?? ''

    let parsed: {
        rows?: unknown[]
        meta?: Record<string, unknown>
        odds?: unknown[]
        homeTeam?: string
        awayTeam?: string
        league?: string
        isLive?: boolean
        currentMinute?: number | null
        currentScore?: { home: number; away: number }
        period?: string
        note?: string
    }
    try {
        parsed = JSON.parse(stripJsonFence(text))
    } catch {
        throw new XKiroError('xKiro không trả về JSON hợp lệ cho bảng kèo.', 502)
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

        const confidence = clamp01(num(r.confidence) ?? 0.85)
        if (confidence < 0.3) continue

        rows.push({
            kind,
            side,
            line,
            odds,
            confidence,
            note: typeof r.note === 'string' ? r.note.slice(0, 160) : undefined,
        })
    }

    const oddsList: Array<{
        type: 'hdp' | 'ou' | '1x2'
        target: 'home' | 'away' | 'over' | 'under'
        line: number
        odds: number
    }> = []

    for (const raw of Array.isArray(parsed.odds) ? parsed.odds : []) {
        const o = raw as Record<string, unknown>
        const type = o.type === 'hdp' ? 'hdp' : o.type === '1x2' ? '1x2' : 'ou'
        const target = o.target === 'home' || o.target === 'away' || o.target === 'under' ? o.target : 'over'
        const line = num(o.line) ?? 0
        const oddsVal = num(o.odds)
        if (oddsVal === null || oddsVal <= 1.01 || oddsVal > 500) continue
        oddsList.push({ type, target, line, odds: oddsVal })
    }

    // Nếu có odds nhưng rows trống, map odds sang rows để tương thích UI
    if (rows.length === 0 && oddsList.length > 0) {
        for (const o of oddsList) {
            if (o.type === 'ou') {
                rows.push({
                    kind: 'totals',
                    side: o.target === 'under' ? 'under' : 'over',
                    line: o.line,
                    odds: o.odds,
                    confidence: 0.9,
                })
            } else if (o.type === 'hdp') {
                rows.push({
                    kind: 'ah',
                    side: o.target === 'away' ? 'away' : 'home',
                    line: o.line,
                    odds: o.odds,
                    confidence: 0.9,
                })
            }
        }
    }

    // Nếu có rows nhưng oddsList trống, map ngược lại
    if (oddsList.length === 0 && rows.length > 0) {
        for (const r of rows) {
            if (r.kind === 'totals') {
                oddsList.push({
                    type: 'ou',
                    target: r.side === 'under' ? 'under' : 'over',
                    line: r.line,
                    odds: r.odds,
                })
            } else {
                oddsList.push({
                    type: 'hdp',
                    target: r.side === 'away' ? 'away' : 'home',
                    line: r.line,
                    odds: r.odds,
                })
            }
        }
    }

    const m = (parsed.meta ?? {}) as Record<string, unknown>
    const pAny = parsed as Record<string, unknown>
    const rawHome = pAny.homeTeam ?? m.homeTeam ?? m.home ?? pAny.home
    const rawAway = pAny.awayTeam ?? m.awayTeam ?? m.away ?? pAny.away
    const rawLeague = pAny.league ?? m.league
    const rawKickoff = m.kickoff ?? pAny.kickoff

    const isLive = Boolean(pAny.isLive ?? m.isLive ?? false)
    const currentMinute = num(pAny.currentMinute ?? m.currentMinute ?? pAny.minute ?? m.minute)
    let currentScore: { home: number; away: number } | null = null
    const rawScore = (pAny.currentScore ?? m.currentScore ?? pAny.score ?? m.score) as Record<string, unknown> | undefined
    if (rawScore && typeof rawScore === 'object') {
        const h = num(rawScore.home) ?? 0
        const a = num(rawScore.away) ?? 0
        currentScore = { home: h, away: a }
    }

    const period = typeof pAny.period === 'string' ? pAny.period : typeof m.period === 'string' ? m.period : undefined

    const meta: ExtractedMeta = {
        home: typeof rawHome === 'string' && rawHome.trim() ? rawHome.trim().slice(0, 80) : undefined,
        away: typeof rawAway === 'string' && rawAway.trim() ? rawAway.trim().slice(0, 80) : undefined,
        league:
            typeof rawLeague === 'string' && rawLeague.trim() ? rawLeague.trim().slice(0, 80) : undefined,
        kickoff: typeof rawKickoff === 'string' && rawKickoff.trim() ? rawKickoff.trim().slice(0, 64) : null,
        confidence: clamp01(num(m.confidence) ?? 0.85),
    }

    return {
        rows,
        meta,
        homeTeam: meta.home,
        awayTeam: meta.away,
        league: meta.league,
        isLive,
        currentMinute: currentMinute !== null ? Math.round(currentMinute) : null,
        currentScore,
        period,
        odds: oddsList,
        lowConfidence: rows.some((r) => r.confidence < 0.8),
        note: typeof parsed.note === 'string' ? parsed.note.slice(0, 300) : undefined,
        model: XKIRO_MODEL,
    }
}


// ===========================================================================
// BƯỚC A — Thu thập dữ liệu nền & Phân tích định lượng (xG, Poisson, ép sân, góc)
// ===========================================================================

export interface GroundedHint {
    home: string
    away: string
    league?: string
    kickoff?: string | null
    eventId?: number | null
}


const QUANT_ANALYST_SYSTEM_PROMPT = `Bạn là Chuyên gia Phân tích Bóng đá Định lượng (Quantitative Football Analyst).
Nhiệm vụ: Phân tích định lượng toàn diện cho trận đấu bóng đá dựa trên dữ liệu xG (Expected Goals), phân phối Poisson (Dixon-Coles rho=-0.08), phong độ 6-10 trận gần nhất, và các chỉ số thống kê thực tế. Thị trường cược là nguồn thông tin mạnh, không suy đoán cảm tính.

QUY TẮC BẮT BUỘC:
1. Đưa ra các chỉ số toán học định lượng thực tế, trung thực và hợp lý nhất cho hai đội:
   - xgf: Bàn thắng kỳ vọng trung bình mỗi trận (Expected Goals For).
   - xga: Bàn thua kỳ vọng trung bình mỗi trận (Expected Goals Against).
   - goals_for: Số bàn thắng trung bình thực tế ghi được mỗi trận.
   - goals_against: Số bàn thua trung bình thực tế mỗi trận.
   - n: Số trận trong mẫu dữ liệu (từ 5 đến 15 trận gần nhất).
   - injuries: Danh sách cầu thủ trụ cột chấn thương/treo giò đã xác nhận.
   - lineup_confirmed: false (hoặc true nếu đã có đội hình chính thức).
   - h2h: Lịch sử đối đầu gồm số trận n, bàn thắng trung bình avg_goals, và tỷ lệ cả 2 đội ghi bàn btts_rate (0.0 đến 1.0).
2. Chống thiên lệch: Không thiên vị đội lớn, không bịa đặt số liệu. Dưới 5 trận thì đánh dấu không đủ dữ liệu.
3. Định dạng phản hồi: DUY NHẤT một đối tượng JSON thuần, KHÔNG bao bọc trong khối mã markdown (TUYỆT ĐỐI KHÔNG dùng \`\`\`json hoặc \`\`\`), KHÔNG có văn bản hay lời chào nào ngoài JSON.

CẤU TRÚC JSON BẮT BUỘC KHỚP CHÍNH XÁC:
{
  "home": {
    "xgf": 1.75,
    "xga": 1.10,
    "goals_for": 1.80,
    "goals_against": 1.05,
    "n": 10,
    "injuries": [],
    "lineup_confirmed": false
  },
  "away": {
    "xgf": 1.20,
    "xga": 1.50,
    "goals_for": 1.15,
    "goals_against": 1.45,
    "n": 10,
    "injuries": [],
    "lineup_confirmed": false
  },
  "h2h": {
    "n": 5,
    "avg_goals": 2.8,
    "btts_rate": 0.6
  },
  "conflicts": [],
  "missing": []
}`

function numOrNull(v: unknown): number | null {
    const n = num(v)
    if (n === null) return null
    if (n < 0 || n > 100) return null
    return n
}

function strArray(v: unknown, max = 20): string[] {
    if (!Array.isArray(v)) return []
    return v
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((s) => s.trim().slice(0, 160))
        .slice(0, max)
}

function normalizeTeamStats(v: unknown): TeamStats {
    const o = (v ?? {}) as Record<string, unknown>
    const n = num(o.n)
    return {
        xgf: numOrNull(o.xgf),
        xga: numOrNull(o.xga),
        goals_for: numOrNull(o.goals_for),
        goals_against: numOrNull(o.goals_against),
        n: n !== null && n >= 0 && n <= 200 ? Math.round(n) : 0,
        injuries: strArray(o.injuries),
        lineup_confirmed: o.lineup_confirmed === true,
    }
}

function normalizeH2H(v: unknown): H2H {
    const o = (v ?? {}) as Record<string, unknown>
    const n = num(o.n)
    const btts = num(o.btts_rate)
    return {
        n: n !== null && n >= 0 && n <= 200 ? Math.round(n) : 0,
        avg_goals: numOrNull(o.avg_goals),
        btts_rate: btts !== null && btts >= 0 && btts <= 1 ? btts : null,
    }
}

function detectMissing(data: MatchData): string[] {
    const miss: string[] = []
    for (const [label, t] of [
        ['home', data.home],
        ['away', data.away],
    ] as const) {
        if (t.xgf === null && t.goals_for === null) miss.push(`${label}.xgf/goals_for`)
        if (t.xga === null && t.goals_against === null) miss.push(`${label}.xga/goals_against`)
        if (t.n === 0) miss.push(`${label}.n`)
    }
    if (data.h2h.n === 0) miss.push('h2h.n')
    return miss
}

function normalizeMatchData(raw: unknown, sources: Source[]): MatchData {
    const o = (raw ?? {}) as Record<string, unknown>
    const data: MatchData = {
        home: normalizeTeamStats(o.home),
        away: normalizeTeamStats(o.away),
        h2h: normalizeH2H(o.h2h),
        sources,
        conflicts: strArray(o.conflicts),
        missing: [],
        origin: 'search',
    }
    data.missing = detectMissing(data)
    return data
}

/**
 * BƯỚC A: Phân tích định lượng (xG, Poisson, ép sân, phạt góc) và thu thập số liệu qua xKiro.
 */
export async function streamCollectMatchData(
    hint: GroundedHint,
    onDelta: (chunk: string) => void,
): Promise<MatchData> {
    if (!env.xkiroApiKey) {
        throw new XKiroError('Chưa cấu hình XKIRO_API_KEY trên server.', 503)
    }

    const cleanHome = sanitizeCleanText(hint.home)
    const cleanAway = sanitizeCleanText(hint.away)
    const cleanLeague = sanitizeCleanText(hint.league ?? '')
    const cleanKickoff = sanitizeCleanText(hint.kickoff ?? '')

    // Tự động tìm kiếm SofaScore H2H nếu có eventId hoặc tìm theo tên 2 đội
    let h2hText = ''
    let sofaEventId = hint.eventId
    try {
        if (!sofaEventId) {
            const sofaEv = await findSofaEvent(cleanHome, cleanAway)
            if (sofaEv?.id) sofaEventId = sofaEv.id
        }
        if (sofaEventId) {
            const h2hRes = await getEventH2H(sofaEventId)
            if (h2hRes?.h2hText) {
                h2hText = h2hRes.h2hText
            }
        }
    } catch {
        /* ignore h2h fetch error */
    }

    const userPrompt = [
        `Phân tích định lượng toàn diện cho trận đấu:`,
        `- Đội nhà: ${cleanHome}`,
        `- Đội khách: ${cleanAway}`,
        cleanLeague ? `- Giải đấu: ${cleanLeague}` : '',
        cleanKickoff ? `- Thời gian thi đấu: ${cleanKickoff}` : '',
        h2hText
            ? [
                  '',
                  h2hText,
                  '',
                  'QUY TẮC BẮT BUỘC VỀ ĐỐI ĐẦU: Sử dụng CHÍNH XÁC số liệu từ THỰC TẾ LỊCH SỬ ĐỐI ĐẦU (H2H SofaScore) ở trên để điền trường "h2h": { "n", "avg_goals", "btts_rate" }. TUYỆT ĐỐI CẤM bịa đặt hoặc đoán mò lịch sử đối đầu từ trí nhớ!',
              ].join('\n')
            : '',
        '',
        `Yêu cầu: Dựa trên mô hình Poisson, thống kê xG (xgf, xga), tỷ lệ ép sân/áp lực tấn công và kỳ vọng phạt góc, xuất ra đối tượng JSON chuẩn xác theo đúng schema.`,
    ].filter(Boolean).join('\n')

    const res = await callXKiroChat(
        [
            { role: 'system', content: QUANT_ANALYST_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
        ],
        { stream: true, temperature: 0.2 },
    )

    const { text } = await readXKiroStream(res, onDelta)

    if (!text.trim()) {
        throw new XKiroError('xKiro không trả về dữ liệu phân tích cho trận này.', 502)
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(stripJsonFence(text))
    } catch {
        throw new XKiroError('xKiro trả về JSON không hợp lệ ở Bước phân tích định lượng.', 502)
    }

    const sources: Source[] = [
        {
            url: 'https://api.xkiro.com',
            title: `xKiro AI Engine (${XKIRO_MODEL}) - Quantitative Analytics`,
            fetched_at: new Date().toISOString(),
        },
    ]

    if (sofaEventId) {
        sources.push({
            url: `https://www.sofascore.com/event/${sofaEventId}`,
            title: `SofaScore Real H2H & Live Match Data (#${sofaEventId})`,
            fetched_at: new Date().toISOString(),
        })
    }

    return normalizeMatchData(parsed, sources)
}


// ===========================================================================
// BƯỚC C — xKiro viết phân tích định lượng dựa trên số liệu engine
// ===========================================================================

const EXPLANATION_SYSTEM_PROMPT = `Bạn là Chuyên gia Phân tích Bóng đá Định lượng (Quantitative Football Analyst), viết lời giải thích chi tiết cho người cược dựa trên kết quả tính toán mô hình định lượng (xG, Poisson, tỷ lệ ép sân, phạt góc).

QUY TẮC SỐ — TUYỆT ĐỐI NGHIÊM:
- Bạn KHÔNG BAO GIỜ được tự ý viết bất kỳ con số cụ thể nào (kể cả ước lượng như "khoảng 60%" hay "hơn 2 quả").
- Mọi số liệu PHẢI được thay thế chính xác bằng các TOKEN trong bảng "SỐ LIỆU ĐÃ TÍNH SẴN" (ví dụ: {LAMBDA_HOME}, {LAMBDA_AWAY}, {TOP1_SCORE}, {P1_ODDS}, v.v.).
- Chỉ được dùng token có trong bảng. Không tự ý sáng tạo token mới.

YÊU CẦU VĂN PHONG:
- Tiếng Việt súc tích, logic, phản ánh tư duy định lượng toán học, không quảng cáo hay cổ súy cá độ.
- Đánh giá thẳng thắn: nếu là NO BET thì nêu rõ NO BET ở phần (4) và giải thích vì sao edge không đạt kỳ vọng toán học (EV).

BỐN PHẦN CẦN TRÌNH BÀY (mỗi phần 2–4 câu):
(1) Đối soát chỉ số định lượng: Đánh giá xG, tỷ lệ ép sân và thông số Poisson λ của hai đội.
(2) Chiến thuật & nhân sự: Tác động của chấn thương, sơ đồ thi đấu và tần suất phạt góc tới nhịp độ.
(3) Đánh giá kèo & kịch bản thua: Kèo nào có value (+EV), bẫy kèo nhà cái (-EV), các kịch bản thực tế dẫn tới thua cược.
(4) Tổng kết & rủi ro: Kết luận cuối cùng, số lượng kèo value, tỉ số khả dĩ nhất và khuyến cáo rủi ro.

YÊU CẦU ĐỊNH DẠNG BẮT BUỘC:
- Trả về DUY NHẤT một đối tượng JSON thuần, KHÔNG sử dụng markdown backticks (\`\`\`json hoặc \`\`\`), KHÔNG có văn bản nào ngoài JSON:
{"parts":["nội dung câu 1 đến câu 4 của phần (1)","nội dung phần (2)","nội dung phần (3)","nội dung phần (4)"],"caveats":["cảnh báo dữ liệu hoặc rủi ro nếu có"]}`

/**
 * Bước C: xKiro viết 4 phần giải thích định lượng dựa trên số liệu engine đã tính.
 */
export async function generateExplanation(
    meta: { home: string; away: string; league?: string },
    data: MatchData,
    result: AnalysisResult,
    onDelta?: (chunk: string) => void,
): Promise<Explanation> {
    if (!env.xkiroApiKey) {
        throw new XKiroError('Chưa cấu hình XKIRO_API_KEY trên server.', 503)
    }

    const facts = buildFacts(data, result)
    const labels = factLabels(facts)
    const factsTable = facts.map((f) => `- ${f.token} = ${f.value}`).join('\n')

    const pickLines = result.picks
        .slice(0, 6)
        .map((p, i) => {
            const k = `P${i + 1}`
            return `- ${k}: ${p.kind === 'totals' ? (p.side === 'over' ? 'Trên' : 'Dưới') : `Chấp ${p.side}`} ${labels[`${k}_LINE`]} @ ${labels[`${k}_ODDS`]} · xác suất ${labels[`${k}_PWIN`]} · thị trường ${labels[`${k}_PIMPLIED`]} · edge ${labels[`${k}_EDGE`]} · stake ${labels[`${k}_STAKE`]} · trạng thái ${p.status}`
        })
        .join('\n')

    const cleanHome = sanitizeCleanText(meta.home)
    const cleanAway = sanitizeCleanText(meta.away)
    const cleanLeague = sanitizeCleanText(meta.league ?? '')

    const userPrompt = [
        `Trận: ${cleanHome} vs ${cleanAway}${cleanLeague ? ` (${cleanLeague})` : ''}`,
        '',
        'SỐ LIỆU ĐÃ TÍNH SẴN (dùng token, tuyệt đối không tự viết số):',
        factsTable,
        '',
        'BẢNG NHÃN:',
        `- LAMBDA_HOME=${labels.LAMBDA_HOME} LAMBDA_AWAY=${labels.LAMBDA_AWAY}`,
        `- Tỉ số khả dĩ: ${labels.TOP1_SCORE} (${labels.TOP1_P}), ${labels.TOP2_SCORE} (${labels.TOP2_P}), ${labels.TOP3_SCORE} (${labels.TOP3_P})`,
        `- H2H: ${labels.H2H_N} trận, trung bình ${labels.H2H_AVG} bàn/trận`,
        `- Nguồn dữ liệu: ${labels.SOURCE_COUNT}; kèo value: ${labels.VALUE_COUNT}/${labels.PICK_COUNT}`,
        '',
        'CÁC KÈO ĐÃ TÍNH:',
        pickLines || '(chưa có kèo nào)',
        '',
        'DỮ LIỆU THIẾU / MÂU THUẪN (phải nêu trong caveats nếu có):',
        data.missing.length ? data.missing.join(', ') : 'không thiếu',
        data.conflicts.length ? data.conflicts.join(' · ') : 'không mâu thuẫn',
        '',
        'Hãy viết 4 phần giải thích và caveats dưới định dạng JSON thuần.',
    ].join('\n')

    const res = await callXKiroChat(
        [
            { role: 'system', content: EXPLANATION_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
        ],
        { stream: !!onDelta, temperature: 0.3 },
    )

    let text = ''
    if (onDelta) {
        const streamResult = await readXKiroStream(res, onDelta)
        text = streamResult.text
    } else {
        const json = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>
        }
        text = json.choices?.[0]?.message?.content ?? ''
    }

    let parsed: { parts?: unknown; caveats?: unknown }
    try {
        parsed = JSON.parse(stripJsonFence(text)) as { parts?: unknown; caveats?: unknown }
    } catch {
        throw new XKiroError('xKiro trả về JSON không hợp lệ ở Bước giải thích định lượng.', 502)
    }

    const rawParts = Array.isArray(parsed.parts) ? parsed.parts : []
    const parts = [0, 1, 2, 3].map((i) =>
        typeof rawParts[i] === 'string'
            ? substituteFacts((rawParts[i] as string).slice(0, 1200), facts)
            : '',
    ) as [string, string, string, string]

    const caveats = Array.isArray(parsed.caveats)
        ? (parsed.caveats as unknown[])
            .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
            .map((c) => substituteFacts(c.trim().slice(0, 200), facts))
            .slice(0, 8)
        : []

    const allText = parts.join('\n') + '\n' + caveats.join('\n')
    const unverifiedNumbers = verifyNumbers(allText, facts)

    return {
        parts,
        verified: unverifiedNumbers.length === 0,
        unverifiedNumbers,
        caveats,
        model: XKIRO_MODEL,
    }
}
