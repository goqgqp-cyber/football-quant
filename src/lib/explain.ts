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

/** Thay mọi token `{{U..}}` trong văn bản bằng giá trị thật. */
export function substituteFacts(text: string, facts: Fact[]): string {
    let out = text
    for (const f of facts) {
        out = out.split(f.token).join(f.value)
    }
    // Dọn token lạ còn sót (model bịa token) — bỏ hẳn để không lộ {{U..}} ra UI
    out = out.replace(/\{\{U\d+\}\}/g, '—')
    return out
}

const NUMBER_RE = /-?\d+(?:[.,]\d+)?/g

/**
 * Kiểm chứng: mọi con số trong văn bản phải truy được về một số engine đã tính.
 *
 * - Bỏ qua số thứ tự phần (1..4) và 0 để tránh báo nhầm.
 * - So khớp theo dung sai nhỏ (0.05 tuyệt đối hoặc 1% tương đối) để chấp nhận
 *   sai lệch do cách viết (55.3 vs 55.30).
 *
 * @returns danh sách các con số KHÔNG khớp (rỗng = văn bản sạch).
 */
export function verifyNumbers(text: string, facts: Fact[]): string[] {
    const allowed = facts.map((f) => f.number).concat((facts as FactBag).extras ?? [])
    const structural = new Set([0, 1, 2, 3, 4])
    const bad: string[] = []
    const seen = new Set<string>()

    for (const m of text.matchAll(NUMBER_RE)) {
        const raw = m[0]
        const n = Number.parseFloat(raw.replace(',', '.'))
        if (!Number.isFinite(n)) continue
        if (structural.has(n)) continue

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
