import { describe, it, expect } from 'vitest'
import {
    pImplied,
    pImpliedNoVig,
    evAndEdge,
    confidenceScore,
    stakePct,
    analyzeMatch,
    suggestedLines,
    MIN_ODDS,
} from './engine'
import type { MatchData, OddsLine } from './types'

function sampleMatchData(): MatchData {
    return {
        home: {
            xgf: 1.9,
            xga: 0.9,
            goals_for: 2.0,
            goals_against: 0.8,
            n: 10,
            injuries: [],
            lineup_confirmed: true,
        },
        away: {
            xgf: 1.1,
            xga: 1.4,
            goals_for: 1.0,
            goals_against: 1.5,
            n: 10,
            injuries: [],
            lineup_confirmed: true,
        },
        h2h: { n: 4, avg_goals: 2.5, btts_rate: 0.5 },
        sources: [
            { url: 'https://fbref.com', title: 'FBref', fetched_at: '2026-10-11T00:00:00Z' },
            { url: 'https://understat.com', title: 'Understat', fetched_at: '2026-10-11T00:00:00Z' },
        ],
        conflicts: [],
        missing: [],
    }
}

describe('engine - odds & probabilities', () => {
    it('pImplied calculates 1 / odds', () => {
        expect(pImplied(2.0)).toBeCloseTo(0.5)
        expect(pImplied(4.0)).toBeCloseTo(0.25)
    })

    it('pImpliedNoVig strips vig between two balanced sides', () => {
        // Ví dụ 1.90 vs 1.90 -> P_implied mỗi bên 0.5263, no-vig mỗi bên 0.5
        const p1 = pImpliedNoVig(1.9, 1.9)
        expect(p1).toBeCloseTo(0.5)

        // Không có odds đối diện
        expect(pImpliedNoVig(2.0, null)).toBeNull()
    })

    it('evAndEdge calculates EV and Edge correctly', () => {
        const triple = { win: 0.55, push: 0.05, lose: 0.40 }
        const { ev, edge } = evAndEdge(triple, 2.0)
        // EV = 0.55 * (2 - 1) - 0.40 = 0.15
        expect(ev).toBeCloseTo(0.15)
        // Edge = EV / odds = 0.15 / 2 = 0.075
        expect(edge).toBeCloseTo(0.075)
    })
})

describe('engine - confidenceScore & stakePct', () => {
    it('confidenceScore returns high, medium, low', () => {
        // n >= 8 (+1), sourceCount >= 2 (+1), delta <= 7% (+1) -> 3 = high
        expect(confidenceScore(10, 2, 0.05)).toBe('high')
        // 2 trong 3 -> medium
        expect(confidenceScore(5, 2, 0.05)).toBe('medium')
        expect(confidenceScore(10, 1, 0.05)).toBe('medium')
        expect(confidenceScore(10, 2, 0.10)).toBe('medium')
        // <= 1 -> low
        expect(confidenceScore(4, 1, 0.12)).toBe('low')
    })

    it('stakePct clamps to [1.0%, 2.5%] and respects low confidence', () => {
        const triple = { win: 0.70, push: 0, lose: 0.30 }
        // Kelly cao, confidence high -> chặn ở STAK_MAX 2.5%
        const highStake = stakePct(triple, 2.0, 'high')
        expect(highStake).toBeCloseTo(0.025)

        // Low confidence luôn hạ về 1.0%
        const lowStake = stakePct(triple, 2.0, 'low')
        expect(lowStake).toBeCloseTo(0.01)
    })
})

describe('analyzeMatch - integration & filtering', () => {
    it('analyzes match and returns sorted value picks', () => {
        const odds: OddsLine[] = [
            { id: '1', kind: 'totals', side: 'over', line: 2.5, odds: 1.95 },
            { id: '2', kind: 'totals', side: 'under', line: 2.5, odds: 1.95 },
            { id: '3', kind: 'ah', side: 'home', line: -0.5, odds: 1.90 },
            { id: '4', kind: 'ah', side: 'away', line: 0.5, odds: 1.90 },
        ]

        const res = analyzeMatch(sampleMatchData(), odds)
        expect(res.lambdaHome).toBeGreaterThan(0)
        expect(res.lambdaAway).toBeGreaterThan(0)
        expect(res.matrix.length).toBe(11) // 0..10
        expect(res.topScorelines).toHaveLength(5)
        expect(res.picks).toHaveLength(4)

        // Mỗi pick phải có đầy đủ thuộc tính tính toán
        for (const p of res.picks) {
            expect(p.pWin).toBeGreaterThan(0)
            expect(p.pLose).toBeGreaterThan(0)
            expect(p.pWin + p.pPush + p.pLose).toBeCloseTo(1.0, 5)
        }
    })

    it('flags trap for high odds with negative edge', () => {
        // Trận bình thường ít bàn, đặt Tài 5.5 với odds 2.50 (odds cao nhưng xác suất thực tế rất thấp -> Edge âm)
        const odds: OddsLine[] = [
            { id: 'trap', kind: 'totals', side: 'over', line: 5.5, odds: 2.5 },
        ]
        const res = analyzeMatch(sampleMatchData(), odds)
        const trapPick = res.picks.find((p) => p.oddsLineId === 'trap')
        expect(trapPick).toBeDefined()
        expect(trapPick?.edge).toBeLessThan(0)
        expect(trapPick?.flags).toContain('trap_high_odds_negative_edge')
        expect(trapPick?.status).toBe('trap')
    })

    it('returns noBet only when empty and assigns Top 1 Value pick for valid odds range [1.60, 2.35]', () => {
        const emptyRes = analyzeMatch(sampleMatchData(), [])
        expect(emptyRes.noBet).toBe(true)
        expect(emptyRes.noBetReasons[0]).toContain('Chưa nhập kèo')

        // Kèo hợp lệ trong [1.60, 2.35] được xếp hạng Top 1 Value
        const validOdds: OddsLine[] = [
            { id: 'v1', kind: 'totals', side: 'over', line: 2.5, odds: 1.85 },
        ]
        const res = analyzeMatch(sampleMatchData(), validOdds)
        expect(res.noBet).toBe(false)
        expect(res.picks[0].rankLabel).toBe('[KÈO TỐI ƯU NHẤT - TOP 1 VALUE]')

        // Kèo ngoài khoảng [1.60, 2.35] (như 1.10 hay 4.12) bị từ chối đề xuất
        const outOfRangeOdds: OddsLine[] = [
            { id: 'lo', kind: 'totals', side: 'over', line: 0.5, odds: 1.10 },
            { id: 'hi', kind: 'ah', side: 'home', line: -1.25, odds: 4.12 },
        ]
        const outRes = analyzeMatch(sampleMatchData(), outOfRangeOdds)
        expect(outRes.picks.every((p) => p.rankLabel === undefined)).toBe(true)
    })

    it('in-play Asian Handicap at minute 44 (HT 3 - 1) calculates on remaining goals distribution, avoids 77.3% error, and rejects odds > 2.35', () => {
        const liveOdds: OddsLine[] = [
            { id: 'atalanta-ah', kind: 'ah', side: 'home', line: -1.25, odds: 4.12 },
            { id: 'backup-high', kind: 'totals', side: 'over', line: 5.5, odds: 3.43 },
            { id: 'normal-ou', kind: 'totals', side: 'over', line: 4.5, odds: 1.95 },
        ]

        const res = analyzeMatch(sampleMatchData(), liveOdds, undefined, undefined, {
            isLive: true,
            currentMinute: 44,
            currentScore: { home: 3, away: 1 },
        })

        const atalantaPick = res.picks.find((p) => p.oddsLineId === 'atalanta-ah')
        expect(atalantaPick).toBeDefined()
        // Win probability on remaining goals must NOT be 77.3% (must be <= 35%)
        expect(atalantaPick!.pWin).toBeLessThan(0.35)
        // Odds 4.12 exceeds maximum odds 2.35 -> must have odds_out_of_range flag and cannot be recommended
        expect(atalantaPick!.flags).toContain('odds_out_of_range')
        expect(atalantaPick!.rankLabel).toBeUndefined()

        // Backup line 3.43 must also be rejected due to odds > 2.35
        const backupPick = res.picks.find((p) => p.oddsLineId === 'backup-high')
        expect(backupPick!.rankLabel).toBeUndefined()

        // Normal line with odds 1.95 qualifies for Top 1 Value
        const normalPick = res.picks.find((p) => p.oddsLineId === 'normal-ou')
        expect(normalPick!.rankLabel).toBe('[KÈO TỐI ƯU NHẤT - TOP 1 VALUE]')
    })

    it('suggestedLines returns predefined common lines', () => {
        const lines = suggestedLines()
        expect(lines.length).toBeGreaterThanOrEqual(8)
        expect(lines.every((l) => l.odds >= MIN_ODDS)).toBe(true)
    })

    it('under low-data conditions (home.n < 5 or away.n < 5), engine does NOT halt with INSUFFICIENT_DATA and enforces market-anchored pipeline with low_data flag and w=0.15', () => {
        const lowData: MatchData = {
            ...sampleMatchData(),
            home: {
                ...sampleMatchData().home,
                n: 2, // Low sample
            },
            away: {
                ...sampleMatchData().away,
                n: 3, // Low sample
            },
        }

        const odds: OddsLine[] = [
            { id: 't25', kind: 'totals', side: 'over', line: 2.5, odds: 1.95 },
            { id: 't25u', kind: 'totals', side: 'under', line: 2.5, odds: 1.95 },
            { id: 'ah0', kind: 'ah', side: 'home', line: 0, odds: 1.90 },
            { id: 'ah0a', kind: 'ah', side: 'away', line: 0, odds: 1.90 },
        ]

        const res = analyzeMatch(lowData, odds)

        // Engine must complete without halting
        expect(res.status).toBe('SUCCESS')
        expect(res.dataGatePassed).toBe(false)
        expect(res.weightModel).toBe(0.15)
        expect(res.picks.length).toBeGreaterThan(0)
        expect(res.topScorelines).toHaveLength(5)

        // All picks must carry low_data flag and low confidence
        for (const p of res.picks) {
            expect(p.flags).toContain('low_data')
            expect(p.confidence).toBe('low')
        }

        // Top 1 Value recommendation is generated
        expect(res.picks[0].rankLabel).toBe('[KÈO TỐI ƯU NHẤT - TOP 1 VALUE]')
        expect(res.picks[0].stakePct).toBe(0.015) // Defensive stake for low data
    })
})
