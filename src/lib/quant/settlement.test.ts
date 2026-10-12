import { describe, expect, it } from 'vitest'
import {
    gradeAsianHandicap,
    gradeOverUnder,
    getMarketBadge,
    formatCornerSplit,
} from './settlement.js'

describe('Quantitative Settlement Math & Badges Engine', () => {
    describe('gradeAsianHandicap - Asian Handicap Settlement & Inversion Prevention', () => {
        it('Trận hòa với kèo được chấp +0.50 phải THẮNG (trước đây bị lỗi đảo chiều)', () => {
            // Tỷ số 1 - 1, đội khách (away) được chấp +0.5, odds 1.95
            const res = gradeAsianHandicap(1, 1, 'away', 0.5, 1.95)
            expect(res.status).toBe('THẮNG')
            expect(res.outcome).toBe('win')
            expect(res.pnl).toBe(0.95) // (1.95 - 1)
        })

        it('Trận hòa với kèo được chấp +0.25 phải THẮNG NỬA (trước đây bị lỗi đảo chiều)', () => {
            // Tỷ số 0 - 0, đội khách (away) được chấp +0.25, odds 2.00
            const res = gradeAsianHandicap(0, 0, 'away', 0.25, 2.0)
            expect(res.status).toBe('THẮNG NỬA')
            expect(res.outcome).toBe('win_half')
            expect(res.pnl).toBe(0.5) // (2.00 - 1) / 2
        })

        it('Trận hòa với kèo đồng banh 0.0 phải HÒA (PnL = 0)', () => {
            const resHome = gradeAsianHandicap(2, 2, 'home', 0, 1.9)
            expect(resHome.status).toBe('HÒA')
            expect(resHome.outcome).toBe('push')
            expect(resHome.pnl).toBe(0.0)

            const resAway = gradeAsianHandicap(2, 2, 'away', 0, 1.9)
            expect(resAway.status).toBe('HÒA')
            expect(resAway.outcome).toBe('push')
            expect(resAway.pnl).toBe(0.0)
        })

        it('Trận hòa với kèo chấp -0.25 phải THUA NỬA (PnL = -0.50)', () => {
            const res = gradeAsianHandicap(1, 1, 'home', -0.25, 1.95)
            expect(res.status).toBe('THUA NỬA')
            expect(res.outcome).toBe('lose_half')
            expect(res.pnl).toBe(-0.5)
        })

        it('Trận hòa với kèo chấp -0.50 phải THUA (PnL = -1.00)', () => {
            const res = gradeAsianHandicap(1, 1, 'home', -0.5, 1.95)
            expect(res.status).toBe('THUA')
            expect(res.outcome).toBe('lose')
            expect(res.pnl).toBe(-1.0)
        })

        it('Đội thắng cách biệt 1 bàn với kèo chấp -0.75 phải THẮNG NỬA', () => {
            // 2 - 1 (goalDiff = +1), net = 1 - 0.75 = +0.25
            const res = gradeAsianHandicap(2, 1, 'home', -0.75, 1.9)
            expect(res.status).toBe('THẮNG NỬA')
            expect(res.outcome).toBe('win_half')
            expect(res.pnl).toBe(0.45) // (1.90 - 1) / 2
        })

        it('Đội thua cách biệt 1 bàn với kèo được chấp +0.75 phải THUA NỬA', () => {
            // 2 - 1, away thua 1 bàn (goalDiff = -1), net = -1 + 0.75 = -0.25
            const res = gradeAsianHandicap(2, 1, 'away', 0.75, 1.9)
            expect(res.status).toBe('THUA NỬA')
            expect(res.outcome).toBe('lose_half')
            expect(res.pnl).toBe(-0.5)
        })
    })

    describe('gradeOverUnder - Over/Under Settlement Math', () => {
        it('Over 2.25 khi tổng bàn = 2 phải THUA NỬA', () => {
            // diff = 2 - 2.25 = -0.25
            const res = gradeOverUnder(2, 'over', 2.25, 1.95)
            expect(res.status).toBe('THUA NỬA')
            expect(res.outcome).toBe('lose_half')
            expect(res.pnl).toBe(-0.5)
        })

        it('Under 2.25 khi tổng bàn = 2 phải THẮNG NỬA', () => {
            // diff = 2.25 - 2 = +0.25
            const res = gradeOverUnder(2, 'under', 2.25, 1.9)
            expect(res.status).toBe('THẮNG NỬA')
            expect(res.outcome).toBe('win_half')
            expect(res.pnl).toBe(0.45) // (1.90 - 1) / 2
        })

        it('Over 2.5 khi tổng bàn = 3 phải THẮNG', () => {
            const res = gradeOverUnder(3, 'over', 2.5, 2.05)
            expect(res.status).toBe('THẮNG')
            expect(res.outcome).toBe('win')
            expect(res.pnl).toBe(1.05)
        })

        it('Under 2.0 khi tổng bàn = 2 phải HÒA', () => {
            const res = gradeOverUnder(2, 'under', 2.0, 1.85)
            expect(res.status).toBe('HÒA')
            expect(res.outcome).toBe('push')
            expect(res.pnl).toBe(0.0)
        })
    })

    describe('getMarketBadge & formatCornerSplit', () => {
        it('Trả về badge chuẩn xác cho các loại kèo FT và H1', () => {
            expect(getMarketBadge('ah', 'ft')).toBe('[Châu Á FT - Bàn]')
            expect(getMarketBadge('ah', 'h1')).toBe('[Châu Á H1 - Bàn]')
            expect(getMarketBadge('totals', 'ft')).toBe('[Tài/Xỉu FT - Bàn]')
            expect(getMarketBadge('totals', '1st half')).toBe('[Tài/Xỉu H1 - Bàn]')
            expect(getMarketBadge('corners', 'ft')).toBe('[Phạt góc FT]')
            expect(getMarketBadge('corners', 'ht')).toBe('[Phạt góc H1]')
        })

        it('Định dạng hiển thị chi tiết phạt góc Góc: 8 [5-3]', () => {
            expect(formatCornerSplit(5, 3)).toBe('Góc: 8 [5-3]')
            expect(formatCornerSplit(0, 0)).toBe('Góc: 0 [0-0]')
            expect(formatCornerSplit(undefined, 2)).toBe('Góc: —')
        })
    })
})
