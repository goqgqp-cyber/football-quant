import { describe, it, expect } from 'vitest'
import { isOpposingPick, solveRecommendedPicks, filterRecommendedPicks } from './solver'
import type { Pick } from '../types'

function makeMockPick(overrides: Partial<Pick>): Pick {
    return {
        oddsLineId: 'test-id',
        kind: 'totals',
        side: 'over',
        line: 2.5,
        odds: 1.95,
        pWin: 0.55,
        pPush: 0,
        pLose: 0.45,
        pImplied: 0.513,
        pImpliedNoVig: 0.52,
        edge: 0.08,
        ev: 0.0725,
        compositeScore: 0.075,
        confidence: 'high',
        stakePct: 0.02,
        status: 'value',
        flags: [],
        marketDelta: 0.03,
        period: 'ft',
        object: 'goals',
        ...overrides,
    }
}

describe('Recommendation Solver - Opposing Bets Ban & Thresholds', () => {
    it('detects directly opposing Over vs Under on the same line and period', () => {
        const p1 = makeMockPick({ kind: 'totals', side: 'over', line: 0.5, period: 'ft', object: 'goals' })
        const p2 = makeMockPick({ kind: 'totals', side: 'under', line: 0.5, period: 'ft', object: 'goals' })

        expect(isOpposingPick(p1, p2)).toBe(true)
        expect(isOpposingPick(p2, p1)).toBe(true)
    })

    it('does NOT treat Over vs Under on different lines or periods as opposing', () => {
        const p1 = makeMockPick({ kind: 'totals', side: 'over', line: 0.5, period: 'ht', object: 'goals' })
        const p2 = makeMockPick({ kind: 'totals', side: 'under', line: 2.5, period: 'ft', object: 'goals' })

        expect(isOpposingPick(p1, p2)).toBe(false)

        const p3 = makeMockPick({ kind: 'totals', side: 'over', line: 0.5, period: 'ft', object: 'goals' })
        const p4 = makeMockPick({ kind: 'totals', side: 'under', line: 3.5, period: 'ft', object: 'goals' })
        expect(isOpposingPick(p3, p4)).toBe(false)
    })

    it('detects directly opposing Asian Handicap on opposite sides of the same handicap line', () => {
        // Home +0.25 vs Away -0.25
        const p1 = makeMockPick({ kind: 'ah', side: 'home', line: 0.25, period: 'ft', object: 'goals' })
        const p2 = makeMockPick({ kind: 'ah', side: 'away', line: -0.25, period: 'ft', object: 'goals' })
        expect(isOpposingPick(p1, p2)).toBe(true)

        // Home -0.5 vs Away +0.5
        const p3 = makeMockPick({ kind: 'ah', side: 'home', line: -0.5, period: 'ft', object: 'goals' })
        const p4 = makeMockPick({ kind: 'ah', side: 'away', line: 0.5, period: 'ft', object: 'goals' })
        expect(isOpposingPick(p3, p4)).toBe(true)

        // Absolute line notation: Home 0.25 vs Away 0.25
        const p5 = makeMockPick({ kind: 'ah', side: 'home', line: 0.25, period: 'ft', object: 'goals' })
        const p6 = makeMockPick({ kind: 'ah', side: 'away', line: 0.25, period: 'ft', object: 'goals' })
        expect(isOpposingPick(p5, p6)).toBe(true)
    })

    it('filters out opposing bet from Pick #2 and picks the next best non-conflicting bet', () => {
        const p1 = makeMockPick({
            oddsLineId: 'ou05-over',
            kind: 'totals',
            side: 'over',
            line: 0.5,
            edge: 0.12,
            ev: 0.11,
            compositeScore: 0.114,
        })
        const opposingP2 = makeMockPick({
            oddsLineId: 'ou05-under',
            kind: 'totals',
            side: 'under',
            line: 0.5,
            edge: 0.09,
            ev: 0.08,
            compositeScore: 0.084,
        })
        const validP3 = makeMockPick({
            oddsLineId: 'ah-home',
            kind: 'ah',
            side: 'home',
            line: -0.25,
            edge: 0.07,
            ev: 0.06,
            compositeScore: 0.064,
        })

        const res = solveRecommendedPicks([p1, opposingP2, validP3])
        expect(res.top1?.oddsLineId).toBe('ou05-over')
        expect(res.top2?.oddsLineId).toBe('ah-home')
        expect(res.top2?.oddsLineId).not.toBe('ou05-under')

        const filtered = filterRecommendedPicks(res.picks)
        expect(filtered.length).toBe(2)
        expect(filtered[0].oddsLineId).toBe('ou05-over')
        expect(filtered[1].oddsLineId).toBe('ah-home')
    })

    it('does NOT recommend Pick #2 if secondary bet has Edge < 5% or EV <= 0', () => {
        const p1 = makeMockPick({
            oddsLineId: 'best-pick',
            kind: 'totals',
            side: 'over',
            line: 2.5,
            edge: 0.10,
            ev: 0.09,
            compositeScore: 0.094,
        })
        const weakEdgePick = makeMockPick({
            oddsLineId: 'weak-edge',
            kind: 'ah',
            side: 'home',
            line: -0.5,
            edge: 0.03, // < 5%
            ev: 0.04,
            compositeScore: 0.036,
        })
        const negativeEvPick = makeMockPick({
            oddsLineId: 'negative-ev',
            kind: 'totals',
            side: 'under',
            line: 3.5,
            edge: 0.06,
            ev: -0.01, // EV <= 0
            compositeScore: 0.018,
        })

        const res = solveRecommendedPicks([p1, weakEdgePick, negativeEvPick])
        expect(res.top1?.oddsLineId).toBe('best-pick')
        expect(res.top2).toBeNull()

        const filtered = filterRecommendedPicks(res.picks)
        expect(filtered.length).toBe(1)
        expect(filtered[0].oddsLineId).toBe('best-pick')
    })

    it('strictly rejects extreme odds (< 1.60 or > 2.35) like 4.12 and 3.43 from candidate recommendations', () => {
        const extremeHigh1 = makeMockPick({
            oddsLineId: 'high-412',
            odds: 4.12, // Exceeds 2.35
            edge: 0.12,
            ev: 0.15,
            compositeScore: 0.14,
        })
        const extremeHigh2 = makeMockPick({
            oddsLineId: 'high-343',
            odds: 3.43, // Exceeds 2.35
            edge: 0.10,
            ev: 0.12,
            compositeScore: 0.11,
        })
        const extremeLow = makeMockPick({
            oddsLineId: 'low-145',
            odds: 1.45, // Below 1.60
            edge: 0.08,
            ev: 0.09,
            compositeScore: 0.085,
        })
        const validPick = makeMockPick({
            oddsLineId: 'valid-195',
            odds: 1.95, // Within [1.60, 2.35]
            edge: 0.07,
            ev: 0.08,
            compositeScore: 0.075,
        })

        // When only extreme lines are present, none are recommended
        const extremeOnlyRes = solveRecommendedPicks([extremeHigh1, extremeHigh2, extremeLow])
        expect(extremeOnlyRes.top1).toBeNull()
        expect(extremeOnlyRes.top2).toBeNull()
        expect(filterRecommendedPicks(extremeOnlyRes.picks)).toEqual([])

        // When a valid pick is present alongside high-odds lines, only validPick qualifies for Top 1 and high-odds lines are rejected for Top 2
        const mixedRes = solveRecommendedPicks([extremeHigh1, validPick, extremeHigh2])
        expect(mixedRes.top1?.oddsLineId).toBe('valid-195')
        expect(mixedRes.top2).toBeNull()

        const filtered = filterRecommendedPicks(mixedRes.picks)
        expect(filtered.length).toBe(1)
        expect(filtered[0].oddsLineId).toBe('valid-195')
    })
})

