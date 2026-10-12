/**
 * Bước C (G5) — cơ chế "con số do máy tính, văn do LLM".
 *
 * Vấn đề: nếu để AI tự viết số, nó có thể bịa hoặc làm tròn sai (ảo giác số).
 * Cách chặn:
 *   1. Engine tính xong TẤT CẢ con số.
 *   2. Ta gán mỗi con số một token `{{U1}}`, `{{U2}}`… kèm giá trị đã định dạng.
 *   3. AI chỉ được viết văn và chèn token — TUYỆT ĐỐI không viết số.
 *   4. Server thay token bằng giá trị thật, rồi `verifyNumbers()` quét lại văn bản:
 *      con số nào không truy được về engine sẽ bị gắn cờ `verified: false`.
 *
 * Nhờ vậy, dù model có "nghĩ" ra số nào thì cũng không lọt được vào văn bản.
 */

import type { AnalysisResult, MatchData } from './types.js'

/** Một con số engine cung cấp cho LLM, kèm token thay thế. */
export interface Fact {
    token: string
    /** Chuỗi hiển thị cuối cùng (đã định dạng, ví dụ "55.3%" hoặc "2.35"). */
    value: string
    /** Số thô để so khớp khi kiểm chứng. */
    number: number
}

/** Định dạng số gọn: bỏ số 0 thừa ở cuối, làm tròn `digits` chữ số thập phân. */
export function fmt(n: number, digits = 2): string {
    if (!Number.isFinite(n)) return '—'
    const s = n.toFixed(digits)
    return s.replace(/\.?0+$/, '') || '0'
}

/** Mảng Fact kèm metadata (nhãn → token, số hợp lệ bổ sung). */
interface FactBag extends Array<Fact> {
    labels?: Record<string, string>
    extras?: number[]
}

/**
 * Sinh danh sách Fact từ dữ liệu trận + kết quả engine.
 * Chỉ đưa vào những con số thực sự hữu ích cho lời giải thích (tránh token rác).
 */
export function buildFacts(data: MatchData, result: AnalysisResult): Fact[] {
    const facts: Fact[] = []
    let i = 0
    const add = (n: number, digits = 2, suffix = ''): string => {
        const token = `{{U${++i}}}`
        const value = `${fmt(n, digits)}${suffix}`
        facts.push({ token, value, number: n })
        return token
    }

    // Nhãn chỉ số (để prompt tham chiếu được, không phải số)
    const labels: Record<string, string> = {
        LAMBDA_HOME: add(result.lambdaHome, 2),
        LAMBDA_AWAY: add(result.lambdaAway, 2),
        LAMBDA_FINAL_HOME: add(result.lambdaHome, 2),
        LAMBDA_FINAL_AWAY: add(result.lambdaAway, 2),
        HOME_XGF: add(data.home.xgf ?? 0, 2),
        HOME_XGA: add(data.home.xga ?? 0, 2),
        AWAY_XGF: add(data.away.xgf ?? 0, 2),
        AWAY_XGA: add(data.away.xga ?? 0, 2),
        HOME_GF: add(data.home.goals_for ?? 0, 2),
        HOME_GA: add(data.home.goals_against ?? 0, 2),
        AWAY_GF: add(data.away.goals_for ?? 0, 2),
        AWAY_GA: add(data.away.goals_against ?? 0, 2),
        H2H_N: add(data.h2h.n, 0),
        H2H_AVG: add(data.h2h.avg_goals ?? 0, 2),
        SOURCE_COUNT: add(data.sources.length, 0),
        VALUE_COUNT: add(result.picks.filter((p) => p.status === 'value').length, 0),
        PICK_COUNT: add(result.picks.length, 0),
    }

    if (result.lambdaModel) {
        labels['LAMBDA_MODEL_HOME'] = add(result.lambdaModel.home, 2)
        labels['LAMBDA_MODEL_AWAY'] = add(result.lambdaModel.away, 2)
    }
    if (result.lambdaMarket) {
        labels['LAMBDA_MARKET_HOME'] = add(result.lambdaMarket.home, 2)
        labels['LAMBDA_MARKET_AWAY'] = add(result.lambdaMarket.away, 2)
    }
    if (result.weightModel !== undefined) {
        labels['WEIGHT_MODEL'] = add(result.weightModel * 100, 0, '%')
    }

    // Top 3 tỉ số khả dĩ. Số bàn trong tỉ số (vd "5-1") cũng phải được coi là hợp lệ.
    const extras: number[] = []
    result.topScorelines.slice(0, 3).forEach((s, idx) => {
        labels[`TOP${idx + 1}_SCORE`] = s.score
        labels[`TOP${idx + 1}_P`] = add(s.p * 100, 1, '%')
        for (const g of s.score.split('-')) {
            const n = Number.parseInt(g, 10)
            if (Number.isFinite(n)) extras.push(n)
        }
    })
    // Số bàn tối đa trong ma trận (0..MAX_GOALS) — tránh báo nhầm khi nhắc "0..10"
    for (let g = 0; g <= 10; g++) extras.push(g)

    // Mô hình và tham số chuẩn (Dixon-Coles rho = -0.08, quản trị vốn 1.0% - 2.5%, các năm 2023..2028)
    extras.push(-0.08, 0.08, 1.0, 1.5, 2.0, 2.5, 3.0, 5.0)
    for (let yr = 2023; yr <= 2028; yr++) extras.push(yr)

    // Toàn bộ các mốc handicap/totals từ tất cả các kèo
    if (result.picks) {
        for (const p of result.picks) {
            extras.push(p.line, -p.line, p.odds)
        }
    }
    // Mốc kèo châu Á / Tài Xỉu tiêu chuẩn
    const commonLines = [-3, -2.5, -2, -1.75, -1.5, -1.25, -1, -0.75, -0.5, -0.25, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.5, 4]
    for (const l of commonLines) extras.push(l)

    // Các kèo: ưu tiên value, sau đó tới các kèo còn lại (tối đa 6 kèo)
    const ordered = [...result.picks].sort((a, b) => {
        const av = a.status === 'value' ? 0 : 1
        const bv = b.status === 'value' ? 0 : 1
        return av - bv
    })
    ordered.slice(0, 6).forEach((p, idx) => {
        const k = `P${idx + 1}`
        labels[`${k}_LINE`] = add(p.line, 2)
        labels[`${k}_ODDS`] = add(p.odds, 2)
        labels[`${k}_PWIN`] = add(p.pWin * 100, 1, '%')
        labels[`${k}_PIMPLIED`] = add(p.pImplied * 100, 1, '%')
        labels[`${k}_EDGE`] = add(p.edge * 100, 1, '%')
        labels[`${k}_EV`] = add(p.ev, 3)
        labels[`${k}_STAKE`] = add(p.stakePct, 2, '%')
    })

    // Gắn bảng nhãn + số hợp lệ bổ sung để prompt/verify dùng
    const bag = facts as FactBag
    bag.labels = labels
    bag.extras = extras
    return facts
}

/** Lấy bảng nhãn → token mà buildFacts đã gắn kèm. */
export function factLabels(facts: Fact[]): Record<string, string> {
    return (facts as FactBag).labels ?? {}
}

/** Thay mọi token `{{U..}}` và các token định danh `{LAMBDA_HOME}`, `{{LAMBDA_HOME}}` trong văn bản bằng giá trị thật. */
export function substituteFacts(text: string, facts: Fact[]): string {
    let out = text
    const bag = facts as FactBag
    const labels = bag.labels ?? {}

    // 1. Thay thế trực tiếp các nhãn có tên nếu AI viết dạng {TOKEN} hoặc {{TOKEN}}
    for (const [key, val] of Object.entries(labels)) {
        const matchingFact = facts.find((f) => f.token === val)
        const displayValue = matchingFact ? matchingFact.value : val
        out = out.split(`{{${key}}}`).join(displayValue)
        out = out.split(`{${key}}`).join(displayValue)
    }

    // 2. Thay thế các token ẩn {{U1}}, {{U2}}...
    for (const f of facts) {
        out = out.split(f.token).join(f.value)
    }

    // 3. Dọn triệt để mọi token lạ/rò rỉ còn sót ({{LAMBDA_...}}, {TOP1_...}, {{U...}}) để không bao giờ lộ ra UI
    out = out.replace(/\{\{+[A-Za-z0-9_]+\}\}+/g, '—')
    out = out.replace(/\{[A-Za-z0-9_]{3,}\}/g, '—')
    out = out.replace(/\{\{U\d+\}\}/g, '—')
    return out
}

const NUMBER_RE = /-?\d+(?:[.,]\d+)?/g

const WHITELISTED_MODEL_CONSTANTS = new Set([
    -0.08, 0.08, // Tham số tương quan Dixon-Coles rho
    1.0, 1.5, 2.0, 2.5, 3.0, 5.0, // Quy tắc phân bổ vốn Kelly & quản trị rủi ro (1.0% - 2.5%)
    2023, 2024, 2025, 2026, 2027, 2028, // Năm dương lịch / mốc thời gian thi đấu
])

/**
 * Kiểm chứng: mọi con số trong văn bản phải truy được về một số engine đã tính.
 *
 * - Bỏ qua số thứ tự phần, số đếm nguyên nhỏ (-5..10), và các tham số mô hình chuẩn (-0.08, 2026, 2.5).
 * - So khớp theo dung sai nhỏ (0.05 tuyệt đối hoặc 1% tương đối) để chấp nhận
 *   sai lệch do cách viết (55.3 vs 55.30).
 *
 * @returns danh sách các con số KHÔNG khớp (rỗng = văn bản sạch).
 */
export function verifyNumbers(text: string, facts: Fact[]): string[] {
    const allowed = facts.map((f) => f.number).concat((facts as FactBag).extras ?? [])
    const bad: string[] = []
    const seen = new Set<string>()

    for (const m of text.matchAll(NUMBER_RE)) {
        const raw = m[0]
        const n = Number.parseFloat(raw.replace(',', '.'))
        if (!Number.isFinite(n)) continue
        if (Number.isInteger(n) && n >= -5 && n <= 10) continue
        if (WHITELISTED_MODEL_CONSTANTS.has(n)) continue

        const ok = allowed.some(
            (a) => Math.abs(n - a) <= 0.05 || (a !== 0 && Math.abs(n - a) / Math.abs(a) <= 0.01),
        )
        if (!ok && !seen.has(raw)) {
            seen.add(raw)
            bad.push(raw)
        }
    }
    return bad.slice(0, 12)
}

/**
 * Xây dựng báo cáo giải thích 9 phần mẫu chuẩn (Spec Section 8) thuần túy từ số liệu engine.
 * Dùng làm fallback khi AI hallucinate ra con số không có trong kết quả tính toán.
 */
export function buildDeterministicNarrative(
    meta: { home: string; away: string; league?: string },
    data: MatchData,
    result: AnalysisResult,
): string[] {
    const homeTeam = meta.home || 'Đội nhà'
    const awayTeam = meta.away || 'Đội khách'

    // (1) H2H summary
    const part1 = data.h2h.n > 0
        ? `Lịch sử đối đầu ghi nhận ${data.h2h.n} cuộc chạm trán gần nhất giữa hai đội. Trung bình có ${fmt(data.h2h.avg_goals ?? 0)} bàn thắng mỗi trận${data.h2h.btts_rate != null ? ` với tỷ lệ hai đội cùng ghi bàn đạt ${fmt(data.h2h.btts_rate * 100, 1)}%` : ''}.`
        : `Hai đội chưa có cuộc đối đầu trực tiếp đáng kể trong cơ sở dữ liệu mẫu gần đây.`

    // (2) Home form
    const part2 = `${homeTeam} thi đấu ${data.home.n} trận gần nhất, đạt hiệu suất ghi bàn trung bình ${fmt(data.home.goals_for ?? 0)} bàn/trận và để thủng lưới ${fmt(data.home.goals_against ?? 0)} bàn/trận${data.home.xgf != null ? ` (xG: ${fmt(data.home.xgf)}, xGA: ${fmt(data.home.xga ?? 0)})` : ''}.`

    // (3) Away form
    const part3 = `${awayTeam} thi đấu ${data.away.n} trận gần nhất, đạt hiệu suất ghi bàn trung bình ${fmt(data.away.goals_for ?? 0)} bàn/trận và để thủng lưới ${fmt(data.away.goals_against ?? 0)} bàn/trận${data.away.xgf != null ? ` (xG: ${fmt(data.away.xgf)}, xGA: ${fmt(data.away.xga ?? 0)})` : ''}.`

    // (4) Team news & context
    const homeInj = data.home.injuries.length > 0 ? `vắng ${data.home.injuries.join(', ')}` : 'lực lượng đầy đủ'
    const awayInj = data.away.injuries.length > 0 ? `vắng ${data.away.injuries.join(', ')}` : 'lực lượng đầy đủ'
    const lineupStatus = data.home.lineup_confirmed && data.away.lineup_confirmed ? 'Đội hình chính thức đã xác nhận.' : 'Đội hình ra sân ở trạng thái dự kiến.'
    const part4 = `Tình hình lực lượng: ${homeTeam} (${homeInj}); ${awayTeam} (${awayInj}). ${lineupStatus}`

    // (5) Missing data & conflicts
    const missingStr = data.missing.length > 0 ? `Thiếu dữ liệu: ${data.missing.join(', ')}.` : 'Dữ liệu thu thập đầy đủ.'
    const conflictsStr = data.conflicts.length > 0 ? ` Mâu thuẫn nguồn: ${data.conflicts.join(' · ')}.` : ' Không ghi nhận mâu thuẫn số liệu giữa các nguồn đối soát.'
    const part5 = `${missingStr}${conflictsStr}`

    // (6) What the data suggests (descriptive only)
    const topScores = result.topScorelines.slice(0, 3).map((s) => `${s.score} (${fmt(s.p * 100, 1)}%)`).join(', ')
    const part6 = `Mô hình Poisson hiệu chỉnh Dixon-Coles xác định kỳ vọng bàn thắng λ: ${homeTeam} = ${fmt(result.lambdaHome)}, ${awayTeam} = ${fmt(result.lambdaAway)}. Ba kịch bản tỉ số khả dĩ nhất lần lượt là: ${topScores}.`

    // (7) The verdict exactly as computed
    const valuePicks = result.picks.filter((p) => p.status === 'value')
    let part7 = ''
    if (result.noBet || result.picks.length === 0) {
        part7 = `Khuyến nghị: NO BET. ${result.noBetReasons.join(' ') || 'Không có lựa chọn nào đạt đủ điều kiện an toàn theo mô hình.'}`
    } else if (valuePicks.length > 0) {
        const pickDescs = valuePicks.slice(0, 2).map((p, i) => {
            const kindText = p.kind === 'totals' ? (p.side === 'over' ? 'Tài' : 'Xỉu') : `Chấp ${p.side === 'home' ? homeTeam : awayTeam}`
            return `${i === 0 ? '[Top 1 Value]' : '[Top 2]'} ${kindText} ${p.line} @ ${fmt(p.odds)} (Xác suất: ${fmt(p.pWin * 100, 1)}%, Edge: ${fmt(p.edge * 100, 1)}%, Vốn đề xuất: ${fmt(p.stakePct, 2)}%)`
        }).join('; ')
        part7 = `Kết luận thuật toán: ${pickDescs}.`
    } else {
        part7 = `Kết luận: Không có kèo nào vượt ngưỡng giá trị kỳ vọng dương (EV > 0). Khuyến nghị đứng ngoài hoặc chỉ theo dõi.`
    }

    // (8) Biggest risks to the conclusion
    const part8 = `Rủi ro lớn nhất: Biến động đột ngột của tỷ lệ cược thị trường trước giờ bóng lăn, yếu tố thời tiết hoặc các sự cố thẻ đỏ/chấn thương sớm làm phá vỡ ma trận phân phối xác suất.`

    // (9) Source list
    const sourceList = data.sources.length > 0
        ? data.sources.map((s) => s.title).join('; ')
        : 'Cơ sở dữ liệu nội bộ và thống kê giải đấu chính thức'
    const part9 = `Danh sách nguồn tham chiếu: ${sourceList}.`

    return [part1, part2, part3, part4, part5, part6, part7, part8, part9]
}

/**
 * Hàng rào kiểm soát hậu kiểm (Spec Section 8 & 15):
 * Quét toàn bộ số trong narrative. Nếu có bất kỳ số nào chưa được engine cấp,
 * lập tức kích hoạt cơ chế thay thế bằng mẫu chuẩn xác định từ JSON và gắn cờ cảnh báo.
 */
export function postCheckNarrative(
    rawParts: string[],
    facts: Fact[],
    meta: { home: string; away: string; league?: string },
    data: MatchData,
    result: AnalysisResult,
): { parts: string[]; verified: boolean; unverifiedNumbers: string[]; isFallbackTemplate: boolean } {
    const allText = rawParts.join('\n')
    const unverified = verifyNumbers(allText, facts)

    if (unverified.length > 0) {
        const fallbackParts = buildDeterministicNarrative(meta, data, result)
        return {
            parts: fallbackParts,
            verified: false,
            unverifiedNumbers: unverified,
            isFallbackTemplate: true,
        }
    }

    return {
        parts: rawParts,
        verified: true,
        unverifiedNumbers: [],
        isFallbackTemplate: false,
    }
}

