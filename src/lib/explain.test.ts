import { describe, it, expect } from 'vitest'
import { analyzeMatch } from '@/lib/engine'
import {
    buildDeterministicNarrative,
    buildFacts,
    factLabels,
    fmt,
    postCheckNarrative,
    substituteFacts,
    verifyNumbers,
} from '@/lib/explain'
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

    it('thay thế trực tiếp các nhãn có tên {{LAMBDA_HOME}} và {LAMBDA_HOME}', () => {
        const out = substituteFacts('λ: {{LAMBDA_HOME}} vs {LAMBDA_AWAY}', facts)
        expect(out).toBe(`λ: ${valueOf(labels.LAMBDA_HOME)} vs ${valueOf(labels.LAMBDA_AWAY)}`)
        expect(out).not.toContain('{{LAMBDA_HOME}}')
        expect(out).not.toContain('{LAMBDA_AWAY}')
    })

    it('dọn triệt để token rò rỉ chưa được gán nhãn', () => {
        expect(substituteFacts('test {{UNKNOWN_TOKEN}} leak {RANDOM_LEAK}', facts)).toBe('test — leak —')
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

    it('không báo lỗi cho các tham số engine hợp lệ: -0.08, 2026, -1, 2.5', () => {
        const text = 'Mô hình Dixon-Coles hiệu chỉnh rho = -0.08 vào mùa giải 2026 với kèo chấp -1 và Tài Xỉu 2.5'
        expect(verifyNumbers(text, facts)).toEqual([])
    })
})

describe('Spec Section 8 & 15: Post-check and Deterministic Fallback Narrative', () => {
    const meta = { home: 'Arsenal', away: 'Chelsea', league: 'Premier League' }

    it('buildDeterministicNarrative sinh đúng 9 phần chuẩn theo Spec Section 8', () => {
        const parts = buildDeterministicNarrative(meta, MOCK_MATCH_DATA, result)
        expect(parts).toHaveLength(9)
        // Tất cả các phần đều chứa nội dung chữ hợp lệ
        for (const p of parts) {
            expect(p.length).toBeGreaterThan(10)
        }
    })

    it('postCheckNarrative giữ nguyên narrative nếu không có số bịa', () => {
        const cleanParts = [
            `Đối đầu ${valueOf(labels.H2H_N)} trận, ghi ${valueOf(labels.H2H_AVG)} bàn`,
            `Nhà ghi ${valueOf(labels.HOME_GF)} bàn, thủng lưới ${valueOf(labels.HOME_GA)}`,
            `Khách ghi ${valueOf(labels.AWAY_GF)} bàn, thủng lưới ${valueOf(labels.AWAY_GA)}`,
            'Đội hình dự kiến lực lượng ổn định',
        ]
        const res = postCheckNarrative(cleanParts, facts, meta, MOCK_MATCH_DATA, result)
        expect(res.verified).toBe(true)
        expect(res.isFallbackTemplate).toBe(false)
        expect(res.unverifiedNumbers).toEqual([])
        expect(res.parts).toEqual(cleanParts)
    })

    it('postCheckNarrative lập tức thay thế bằng template mẫu khi có số bịa (Corrupted Narrative Test)', () => {
        // Cố tình đưa vào số bịa không có trong facts (vd: 999.9%, 88.88)
        const corruptedParts = [
            'H2H hai đội có tỷ lệ thắng lên tới 999.9% cho Arsenal',
            'Phong độ ghi bàn đạt mức khủng khiếp 88.88 bàn mỗi trận',
            'Kèo chấp chắc thắng 100% không thể thua',
        ]
        const res = postCheckNarrative(corruptedParts, facts, meta, MOCK_MATCH_DATA, result)

        // Phải phát hiện và gắn cờ cảnh báo
        expect(res.verified).toBe(false)
        expect(res.isFallbackTemplate).toBe(true)
        expect(res.unverifiedNumbers).toContain('999.9')
        expect(res.unverifiedNumbers).toContain('88.88')

        // Narrative bị thay thế hoàn toàn bằng 9 phần chuẩn
        expect(res.parts).toHaveLength(9)
        expect(res.parts[0]).not.toContain('999.9')
        expect(res.parts[1]).not.toContain('88.88')

        // Số trong narrative thay thế phải hoàn toàn hợp lệ (không chứa số bịa)
        const checkFallback = verifyNumbers(res.parts.join('\n'), facts)
        expect(checkFallback).toEqual([])
    })
})

