import { describe, it, expect } from 'vitest'
import { analyzeMatch } from '@/lib/engine'
import { buildFacts, factLabels, fmt, substituteFacts, verifyNumbers } from '@/lib/explain'
import { MOCK_MATCH_DATA, MOCK_ODDS } from '@/lib/mock'

/**
 * Kiểm thử cơ chế "con số do máy tính, văn do LLM" (Bước C):
 * token hoá số, thay token bằng giá trị engine, và quét lại văn bản để phát
 * hiện số bịa. Đây là hàng rào chống ảo giác số quan trọng nhất của G5.
 */
const result = analyzeMatch(MOCK_MATCH_DATA, MOCK_ODDS, 1.45, 1.15)
const facts = buildFacts(MOCK_MATCH_DATA, result)
const labels = factLabels(facts)

/** Giá trị đã định dạng của fact ứng với token cho trước. */
function valueOf(token: string): string {
    const f = facts.find((x) => x.token === token)
    if (!f) throw new Error(`Không có fact cho token ${token}`)
    return f.value
}

describe('fmt', () => {
    it('bỏ số 0 thừa ở cuối', () => {
        expect(fmt(1.5)).toBe('1.5')
        expect(fmt(2.0)).toBe('2')
        expect(fmt(55.3, 1)).toBe('55.3')
        expect(fmt(0)).toBe('0')
    })

    it('trả về "—" cho số không hữu hạn', () => {
        expect(fmt(Number.NaN)).toBe('—')
        expect(fmt(Number.POSITIVE_INFINITY)).toBe('—')
    })
})

describe('buildFacts / factLabels', () => {
    it('mọi token đều có dạng {{U..}} và số hữu hạn', () => {
        expect(facts.length).toBeGreaterThan(0)
        for (const f of facts) {
            expect(f.token).toMatch(/^\{\{U\d+\}\}$/)
            expect(Number.isFinite(f.number)).toBe(true)
        }
    })

    it('có nhãn cho λ, tỉ số khả dĩ và ít nhất một kèo', () => {
        expect(labels.LAMBDA_HOME).toMatch(/^\{\{U\d+\}\}$/)
        expect(labels.LAMBDA_AWAY).toMatch(/^\{\{U\d+\}\}$/)
        expect(labels.TOP1_SCORE).toBeTruthy()
        expect(labels.TOP1_P).toMatch(/^\{\{U\d+\}\}$/)
        // MOCK_ODDS sinh ra pick → phải có nhãn cho kèo đầu tiên
        expect(labels.P1_ODDS).toMatch(/^\{\{U\d+\}\}$/)
    })
})

describe('substituteFacts', () => {
    it('thay token bằng giá trị thật, không còn {{U..}}', () => {
        const tok = labels.LAMBDA_HOME
        const out = substituteFacts(`λ nhà là ${tok} bàn/trận`, facts)
        expect(out).toBe(`λ nhà là ${valueOf(tok)} bàn/trận`)
        expect(out).not.toContain('{{')
    })

    it('xoá token lạ do model bịa (không lộ {{U..}} ra UI)', () => {
        expect(substituteFacts('a {{U999}} b', facts)).toBe('a — b')
    })
})

describe('verifyNumbers', () => {
    it('văn bản chỉ chứa số engine cấp thì sạch', () => {
        const clean = `λ nhà ${valueOf(labels.LAMBDA_HOME)}, λ khách ${valueOf(labels.LAMBDA_AWAY)}`
        expect(verifyNumbers(clean, facts)).toEqual([])
    })

    it('bắt được số bịa không truy được về engine', () => {
        expect(verifyNumbers('xác suất lên tới 1234.5%', facts)).toContain('1234.5')
    })

    it('bỏ qua số thứ tự phần (1..4) và 0', () => {
        expect(verifyNumbers('phần 2 có 3 kèo, còn 0 rủi ro', facts)).toEqual([])
    })
})
