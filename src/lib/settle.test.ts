import { describe, it, expect } from 'vitest'
import {
    settlePick,
    totalProfit,
    binLabel,
    brierScore,
    buildCalibration,
} from './settle'
import type { ActualResult, Pick } from './types'

function mockPick(overrides: Partial<Pick>): Pick {
    return {
        oddsLineId: 'test-line',
        kind: 'totals',
        side: 'over',
        line: 2.5,
        odds: 1.9,
        pWin: 0.55,
        pPush: 0,
        pLose: 0.45,
        pImplied: 1 / 1.9,
        pImpliedNoVig: null,
        edge: 0.05,
        ev: 0.045,
        confidence: 'medium',
        stakePct: 0.015,
        status: 'value',
        flags: [],
        marketDelta: 0.02,
        ...overrides,
    }
}

describe('settlePick - Asian Handicap', () => {
    it('AH 0: win at 1-0, push at 0-0, lose at 0-1', () => {
        const pick = mockPick({ kind: 'ah', side: 'home', line: 0, odds: 2.0 })
        const win = settlePick(pick, { htHome: 0, htAway: 0, ftHome: 1, ftAway: 0 }, 'ft')
        expect(win.outcome).toBe('win')
        expect(win.profit).toBeCloseTo(1.0)

        const push = settlePick(pick, { htHome: 0, htAway: 0, ftHome: 0, ftAway: 0 }, 'ft')
        expect(push.outcome).toBe('push')
        expect(push.profit).toBeCloseTo(0)

        const lose = settlePick(pick, { htHome: 0, htAway: 0, ftHome: 0, ftAway: 1 }, 'ft')
        expect(lose.outcome).toBe('lose')
        expect(lose.profit).toBeCloseTo(-1.0)
    })

    it('AH -0.25: win at 1-0, lose_half at 0-0', () => {
        const pick = mockPick({ kind: 'ah', side: 'home', line: -0.25, odds: 1.9 })
        const win = settlePick(pick, { htHome: 0, htAway: 0, ftHome: 1, ftAway: 0 }, 'ft')
        expect(win.outcome).toBe('win')
        expect(win.profit).toBeCloseTo(0.9)

        const loseHalf = settlePick(pick, { htHome: 0, htAway: 0, ftHome: 0, ftAway: 0 }, 'ft')
        expect(loseHalf.outcome).toBe('lose_half')
        expect(loseHalf.profit).toBeCloseTo(-0.5)
    })

    it('AH +0.25: win_half at 0-0', () => {
        const pick = mockPick({ kind: 'ah', side: 'home', line: 0.25, odds: 1.8 })
        const winHalf = settlePick(pick, { htHome: 0, htAway: 0, ftHome: 0, ftAway: 0 }, 'ft')
        expect(winHalf.outcome).toBe('win_half')
        expect(winHalf.profit).toBeCloseTo((1.8 - 1) / 2)
    })

    it('AH -0.75: win_half at 1-0 (thắng cách biệt đúng 1 bàn)', () => {
        const pick = mockPick({ kind: 'ah', side: 'home', line: -0.75, odds: 2.0 })
        const winHalf = settlePick(pick, { htHome: 0, htAway: 0, ftHome: 1, ftAway: 0 }, 'ft')
        expect(winHalf.outcome).toBe('win_half')
        expect(winHalf.profit).toBeCloseTo(0.5) // (1.0 + 0) / 2
    })
})

describe('settlePick - Totals', () => {
    it('under 2.25: win_half at total 2', () => {
        const pick = mockPick({ kind: 'totals', side: 'under', line: 2.25, odds: 1.9 })
        const r: ActualResult = { htHome: 0, htAway: 0, ftHome: 1, ftAway: 1 }
        const res = settlePick(pick, r, 'ft')
        expect(res.outcome).toBe('win_half')
        expect(res.profit).toBeCloseTo((1.9 - 1) / 2)
    })

    it('under 2.75: lose_half at total 3', () => {
        const pick = mockPick({ kind: 'totals', side: 'under', line: 2.75, odds: 2.1 })
        const r: ActualResult = { htHome: 0, htAway: 0, ftHome: 2, ftAway: 1 }
        const res = settlePick(pick, r, 'ft')
        expect(res.outcome).toBe('lose_half')
        expect(res.profit).toBeCloseTo(-0.5)
    })

    it('settles ht period correctly', () => {
        const pick = mockPick({ kind: 'totals', side: 'over', line: 1.5, odds: 2.0 })
        const r: ActualResult = { htHome: 2, htAway: 0, ftHome: 2, ftAway: 1 }
        const res = settlePick(pick, r, 'ht')
        expect(res.outcome).toBe('win')
        expect(res.profit).toBeCloseTo(1.0)
    })
})

describe('totalProfit, brierScore, binLabel, calibration', () => {
    it('totalProfit sums up profits', () => {
        const items = [
            { pick: mockPick({}), outcome: 'win' as const, profit: 0.9 },
            { pick: mockPick({}), outcome: 'lose' as const, profit: -1.0 },
            { pick: mockPick({}), outcome: 'win_half' as const, profit: 0.45 },
        ]
        expect(totalProfit(items)).toBeCloseTo(0.35)
    })

    it('binLabel groups into 5% buckets', () => {
        expect(binLabel(0.52)).toBe('50-55%')
        expect(binLabel(0.57)).toBe('55-60%')
        expect(binLabel(0.80)).toBe('80-85%')
    })

    it('brierScore calculates MSE against win/loss', () => {
        expect(brierScore([])).toBe(0)
        // Hoàn hảo
        expect(brierScore([{ p: 1.0, win: true }, { p: 0.0, win: false }])).toBe(0)
        // Hoàn toàn sai
        expect(brierScore([{ p: 1.0, win: false }, { p: 0.0, win: true }])).toBe(1)
        // 50% dự đoán
        expect(brierScore([{ p: 0.5, win: true }, { p: 0.5, win: false }])).toBeCloseTo(0.25)
    })

    it('buildCalibration groups and aggregates counts', () => {
        const settled = [
            { pick: mockPick({ pWin: 0.52 }), outcome: 'win' as const },
            { pick: mockPick({ pWin: 0.54 }), outcome: 'lose' as const },
            { pick: mockPick({ pWin: 0.62 }), outcome: 'win' as const },
        ]
        const bins = buildCalibration(settled)
        expect(bins).toHaveLength(2)

        const bin50 = bins.find((b) => b.label === '50-55%')
        expect(bin50?.n).toBe(2)
        expect(bin50?.wins).toBe(1)
        expect(bin50?.sumPred).toBeCloseTo(1.06)

        const bin60 = bins.find((b) => b.label === '60-65%')
        expect(bin60?.n).toBe(1)
        expect(bin60?.wins).toBe(1)
    })
})
