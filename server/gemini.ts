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
import type {
    AnalysisResult,
    Explanation,
    H2H,
    MatchData,
    Source,
    TeamStats,
} from '../src/lib/types.js'
import { buildFacts, factLabels, substituteFacts, verifyNumbers } from '../src/lib/explain.js'

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

// ===========================================================================
// BƯỚC A — thu thập dữ liệu nền bằng Gemini + Google Search grounding
// ===========================================================================

export interface GroundedHint {
    home: string
    away: string
    league?: string
    kickoff?: string | null
}

const STEP_A_PROMPT = `Bạn là trợ lý thu thập DỮ LIỆU THẬT cho một trận bóng đá, dùng công cụ Google Search.

Trận: {HOME} vs {AWAY}{LEAGUE_PART}{KICKOFF_PART}

Hãy tìm kiếm trên web và trả về DUY NHẤT một object JSON (không markdown, không văn xuôi ngoài JSON).

Yêu cầu tuyệt đối:
- CHỈ điền số liệu tìm thấy thật trên web. KHÔNG được đoán, không nội suy, không bịa.
- Trường nào không tìm được thì để null (với số) hoặc [] (với mảng), và GHI TÊN trường đó vào "missing".
- Nếu hai nguồn mâu thuẫn nhau, ghi mô tả ngắn vào "conflicts".
- Mọi số liệu phải là trung bình/trận và nêu rõ số trận mẫu n.

Cấu trúc JSON:
{
  "home": {"xgf":null,"xga":null,"goals_for":null,"goals_against":null,"n":0,"injuries":[],"lineup_confirmed":false},
  "away": {"xgf":null,"xga":null,"goals_for":null,"goals_against":null,"n":0,"injuries":[],"lineup_confirmed":false},
  "h2h": {"n":0,"avg_goals":null,"btts_rate":null},
  "conflicts": [],
  "missing": []
}`

function numOrNull(v: unknown): number | null {
    const n = num(v)
    if (n === null) return null
    // loại giá trị vô lý
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

/** Ghi tên các trường còn thiếu để UI cảnh báo "không đủ dữ liệu". */
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

/** Chuẩn hoá JSON thô của Bước A thành MatchData an toàn. */
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

/** Rút nguồn web từ groundingMetadata của Gemini. */
function extractSources(meta: unknown): Source[] {
    const gm = meta as
        | { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> }
        | undefined
    const chunks = gm?.groundingChunks ?? []
    const now = new Date().toISOString()
    const out: Source[] = []
    const seen = new Set<string>()
    for (const ch of chunks) {
        const url = ch.web?.uri
        if (!url || seen.has(url)) continue
        seen.add(url)
        out.push({ url, title: ch.web?.title?.slice(0, 200) ?? url, fetched_at: now })
        if (out.length >= 12) break
    }
    return out
}

/**
 * Đọc luồng SSE của Gemini (`alt=sse`), phát dần text qua `onDelta`,
 * gom nguồn web từ groundingMetadata. Dùng chung cho Bước A và Bước C.
 */
async function readGeminiStream(
    res: Response,
    onDelta: (chunk: string) => void,
): Promise<{ text: string; sources: Source[] }> {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let text = ''
    const sources: Source[] = []

    for (; ;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let idx: number
        while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim()
            buffer = buffer.slice(idx + 1)
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload || payload === '[DONE]') continue

            let chunk: {
                candidates?: Array<{
                    content?: { parts?: Array<{ text?: string }> }
                    groundingMetadata?: unknown
                }>
            }
            try {
                chunk = JSON.parse(payload)
            } catch {
                continue
            }
            const cand = chunk.candidates?.[0]
            const piece = cand?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
            if (piece) {
                text += piece
                onDelta(piece)
            }
            if (cand?.groundingMetadata) {
                sources.push(...extractSources(cand.groundingMetadata))
            }
        }
    }
    return { text, sources }
}

/**
 * BƯỚC A có streaming: gọi Gemini + Google Search grounding, phát dần text cho
 * client qua `onDelta`, cuối cùng trả MatchData đã chuẩn hoá.
 *
 * @throws {GeminiError} khi thiếu key / lỗi mạng / JSON hỏng.
 */
export async function streamCollectMatchData(
    hint: GroundedHint,
    onDelta: (chunk: string) => void,
): Promise<MatchData> {
    if (!env.geminiApiKey) {
        throw new GeminiError('Chưa cấu hình GEMINI_API_KEY trên server.', 503)
    }

    const prompt = STEP_A_PROMPT.replace('{HOME}', hint.home)
        .replace('{AWAY}', hint.away)
        .replace('{LEAGUE_PART}', hint.league ? `, giải ${hint.league}` : '')
        .replace('{KICKOFF_PART}', hint.kickoff ? `, thời điểm ${hint.kickoff}` : '')

    const body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json',
        },
    }

    let res: Response
    try {
        res = await fetch(`${ENDPOINT}/${env.geminiModel}:streamGenerateContent?alt=sse`, {
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

    if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '')
        console.error('[gemini] step A HTTP', res.status, detail.slice(0, 500))
        throw new GeminiError(`Gemini trả lỗi HTTP ${res.status}.`, 502)
    }

    const { text, sources } = await readGeminiStream(res, onDelta)

    if (!text.trim()) {
        throw new GeminiError('Gemini không trả về dữ liệu cho trận này.', 502)
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(stripJsonFence(text))
    } catch {
        throw new GeminiError('Gemini trả về JSON không hợp lệ ở Bước A.', 502)
    }

    // Khử trùng nguồn
    const seen = new Set<string>()
    const uniqSources = sources.filter((s) => {
        if (seen.has(s.url)) return false
        seen.add(s.url)
        return true
    })

    return normalizeMatchData(parsed, uniqSources)
}

// ===========================================================================
// BƯỚC C — Gemini viết phân tích 4 phần, nhưng KHÔNG được tự viết số
// ===========================================================================

const STEP_C_PROMPT = `Bạn là chuyên gia phân tích kèo bóng đá, viết lời giải thích cho người đánh cược.

QUY TẮC SỐ — TUYỆT ĐỐI NGHIÊM:
- Bạn KHÔNG BAO GIỜ được viết bất kỳ con số nào (kể cả xấp xỉ, ví dụ "khoảng 55%" hay "hơn 2").
- Khi cần nêu số liệu, bạn PHẢI chèn đúng token tương ứng trong bảng "SỐ LIỆU ĐÃ TÍNH" bên dưới.
- Chỉ được dùng token có trong bảng. Không tự chế token.
- Nói "nhiều hơn/không có" thay cho số cụ thể nếu không có token phù hợp.

YÊU CẦU VĂN PHONG:
- Tiếng Việt, súc tích, thẳng thắn; không marketing, không khẩu hiệu cổ súy.
- Nếu kết quả là NO BET thì nói thẳng NO BET ở phần (4) và giải thích vì sao không có cơ hội.
- Không khuyến khược gấp thếp; chỉ mô tả kèo nào đạt chuẩn theo engine.

BỐN PHẦN (mỗi phần 2–4 câu):
(1) Đối soát chỉ số: tấn công/thủ của hai đội, chênh lệch, và điều đó dẫn tới λ thế nào.
(2) Chiến thuật & nhân sự: chấn thương, đội hình, lối chơi; nói rõ dữ liệu này chỉ là tin trước trận.
(3) Đánh giá từng kèo & kịch bản thua: kèo nào value, kèo nào bẫy (odds cao nhưng edge âm), kịch bản thua gồm những gì.
(4) Tổng kết: kết luận, số kèo value, tỉ số khả dĩ nhất, và các rủi ro/cảnh báo.

Trả về DUY NHẤT JSON đúng cấu trúc, không markdown:
{"parts":["câu 1 phần (1)","câu 2 phần (2)","câu 3 phần (3)","câu 4 phần (4)"],"caveats":["cảnh báo ngắn về dữ liệu thiếu/mâu thuẫn, nếu có"]}`

/**
 * Bước C: Gemini viết 4 phần giải thích dựa trên số liệu engine đã tính.
 *
 * Cơ chế chống bịa số (3 lớp):
 *  1. Gemini không được viết số — chỉ chèn token `{{U..}}`.
 *  2. Server thay token bằng số engine đã tính (`substituteFacts`).
 *  3. Server quét lại văn bản; số nào không truy được về engine sẽ bị gắn cờ
 *     (`verified: false`, `unverifiedNumbers`) để UI cảnh báo người dùng.
 *
 * @param onDelta cho phép phát text thô ra SSE (tuỳ chọn).
 */
export async function generateExplanation(
    meta: { home: string; away: string; league?: string },
    data: MatchData,
    result: AnalysisResult,
    onDelta?: (chunk: string) => void,
): Promise<Explanation> {
    if (!env.geminiApiKey) {
        throw new GeminiError('Chưa cấu hình GEMINI_API_KEY trên server.', 503)
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

    const prompt = [
        `Trận: ${meta.home} vs ${meta.away}${meta.league ? ` (${meta.league})` : ''}`,
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
        STEP_C_PROMPT,
    ].join('\n')

    const body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
            temperature: 0.3,
            responseMimeType: 'application/json',
        },
    }

    let res: Response
    try {
        res = await fetch(`${ENDPOINT}/${env.geminiModel}:streamGenerateContent?alt=sse`, {
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
    if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '')
        console.error('[gemini] step C HTTP', res.status, detail.slice(0, 500))
        throw new GeminiError(`Gemini trả lỗi HTTP ${res.status}.`, 502)
    }

    const { text } = await readGeminiStream(res, onDelta ?? (() => { }))

    let parsed: { parts?: unknown; caveats?: unknown }
    try {
        parsed = JSON.parse(stripJsonFence(text)) as { parts?: unknown; caveats?: unknown }
    } catch {
        throw new GeminiError('Gemini trả về JSON không hợp lệ ở Bước C.', 502)
    }

    // Lấy đúng 4 phần; phần thiếu thì để chuỗi rỗng (UI sẽ hiện "không có nội dung")
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

    // Kiểm chứng số trên TOÀN BỘ văn bản đã hiển thị
    const allText = parts.join('\n') + '\n' + caveats.join('\n')
    const unverifiedNumbers = verifyNumbers(allText, facts)

    return {
        parts,
        verified: unverifiedNumbers.length === 0,
        unverifiedNumbers,
        caveats,
        model: env.geminiModel,
    }
}