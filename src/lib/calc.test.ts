import { describe, it, expect } from 'vitest'
import { scoreMatrix, estimateLambdas, impliedLambdas, blendLambdas, inPlayScoreMatrix } from '@/lib/poisson'
import { tripleFor } from '@/lib/markets'
import { evAndEdge, analyzeMatch } from '@/lib/engine'
import { settlePick } from '@/lib/settle'
import type { MatchData, ActualResult, Pick, OddsLine } from '@/lib/types'

function diagMatchData(): MatchData {
    return {
        home: { xgf: 1.8, xga: 1.0, goals_for: 1.8, goals_against: 1.0, n: 10, injuries: [], lineup_confirmed: false },
        away: { xgf: 1.2, xga: 1.3, goals_for: 1.2, goals_against: 1.3, n: 10, injuries: [], lineup_confirmed: false },
        h2h: { n: 5, avg_goals: 2.5, btts_rate: 0.4 },
        sources: [
            { url: 'https://a', title: 'A', fetched_at: '2026-10-11T00:00:00Z' },
            { url: 'https://b', title: 'B', fetched_at: '2026-10-11T00:00:00Z' },
        ],
        conflicts: [],
        missing: [],
    }
}

describe('matrix + probability invariants', () => {
    it('total matrix = 1', () => {
        const { lambdaHome, lambdaAway } = estimateLambdas(diagMatchData())
        const m = scoreMatrix(lambdaHome, lambdaAway)
        const sum = m.flat().reduce((a, b) => a + b, 0)
        expect(sum).toBeCloseTo(1, 10)
    })

    it('triple win+push+lose = 1 for totals 2.5, 3.0, quarter 2.75', () => {
        const { lambdaHome, lambdaAway } = estimateLambdas(diagMatchData())
        const m = scoreMatrix(lambdaHome, lambdaAway)
        for (const { line, side } of [
            { line: 2.5, side: 'over' },
            { line: 2.5, side: 'under' },
            { line: 3.0, side: 'over' },
            { line: 3.0, side: 'under' },
            { line: 2.75, side: 'over' },
            { line: 2.75, side: 'under' },
        ] as Array<{ line: number; side: 'over' | 'under' }>) {
            const t = tripleFor(m, 'totals', line, side)
            expect(t.win + t.push + t.lose).toBeCloseTo(1, 10)
        }
    })

    it('triple win+push+lose = 1 for AH including -0.25', () => {
        const { lambdaHome, lambdaAway } = estimateLambdas(diagMatchData())
        const m = scoreMatrix(lambdaHome, lambdaAway)
        for (const line of [0, -0.5, -0.25, 0.75] as number[]) {
            for (const side of ['home', 'away'] as const) {
                const t = tripleFor(m, 'ah', line, side)
                expect(t.win + t.push + t.lose).toBeCloseTo(1, 10)
            }
        }
    })

    it('quarter line splits correctly', () => {
        const { lambdaHome, lambdaAway } = estimateLambdas(diagMatchData())
        const m = scoreMatrix(lambdaHome, lambdaAway)
        const qOr = tripleFor(m, 'totals', 2.75, 'over')
        const half = tripleFor(m, 'totals', 2.5, 'over')
        const next = tripleFor(m, 'totals', 3.0, 'over')
        const avg = { win: (half.win + next.win) / 2, push: (half.push + next.push) / 2 }
        expect(qOr.win).toBeCloseTo(avg.win, 10)
        expect(qOr.push).toBeCloseTo(avg.push, 10)
    })

    it('Edge = EV / odds', () => {
        const triples = [
            { win: 0.6, push: 0, lose: 0.4 },
            { win: 0.3, push: 0.2, lose: 0.5 },
        ]
        for (const t of triples) {
            const odds = 2.0
            const { ev, edge } = evAndEdge(t, odds)
            expect(edge).toBeCloseTo(ev / odds, 12)
        }
    })
})

describe('settle (quarter line)', () => {
    function mkTotals(side: 'over' | 'under', line: number, odds: number): Pick {
        return {
            oddsLineId: 'x',
            kind: 'totals',
            side,
            line,
            odds,
            pWin: 0.5,
            pPush: 0,
            pLose: 0.5,
            pImplied: 1 / odds,
            pImpliedNoVig: null,
            edge: 0,
            ev: 0,
            confidence: 'medium',
            stakePct: 0.015,
            status: 'value',
            flags: [],
            marketDelta: 0,
        }
    }

    const ft: ActualResult = { htHome: 0, htAway: 0, ftHome: 2, ftAway: 1 } // total 3

    it('totals over 2.75 wins_half at total 3 (2.5 wins, 3.0 push -> half)', () => {
        const p = mkTotals('over', 2.75, 1.9)
        const s = settlePick(p, ft, 'ft')
        expect(s.outcome).toBe('win_half')
        expect(s.profit).toBeCloseTo((1.9 - 1) / 2, 10) // (win + push)/2
    })

    it('totals over 3.0 push at total 3', () => {
        const p = mkTotals('over', 3.0, 2.1)
        const s = settlePick(p, ft, 'ft')
        expect(s.outcome).toBe('push')
        expect(s.profit).toBe(0)
    })
})

import { formatPickTitle } from '../components/PickCard'

describe('formatPickTitle (Explicit Bet Naming Convention: [Loại Kèo] [Thời Gian] - [Đối Tượng])', () => {
    it('renders Asian Handicap FT & H1 with explicit badges', () => {
        const pFT = { kind: 'ah', side: 'home', line: 0.5, period: 'ft' }
        expect(formatPickTitle(pFT, 'Hull City', 'Everton')).toBe('[Châu Á Bàn FT] Hull City (+0.5)')

        const pH1 = { kind: 'ah', side: 'away', line: -0.25, period: 'h1' }
        expect(formatPickTitle(pH1, 'Arsenal', 'Chelsea')).toBe('[Châu Á Bàn H1] Chelsea (-0.25)')

        const pZero = { kind: 'ah', side: 'home', line: 0, period: 'ft' }
        expect(formatPickTitle(pZero, 'Hull City', 'Everton')).toBe('[Châu Á Bàn FT] Hull City (0)')
    })

    it('renders Over/Under Goals and Corners FT & H1 with explicit badges', () => {
        const pGoalFT = { kind: 'totals', side: 'over', line: 2.5, period: 'ft' }
        expect(formatPickTitle(pGoalFT, 'Hull City', 'Everton')).toBe('[Tài/Xỉu Bàn FT] Tài 2.5')

        const pGoalH1 = { kind: 'totals', side: 'over', line: 0.5, period: 'h1' }
        expect(formatPickTitle(pGoalH1, 'Hull City', 'Everton')).toBe('[Tài/Xỉu Bàn H1] Tài 0.5')

        const pCornerFT = { kind: 'corners', side: 'under', line: 9.5, period: 'ft' }
        expect(formatPickTitle(pCornerFT, 'Hull City', 'Everton')).toBe('[Tài/Xỉu Góc FT] Xỉu 9.5')

        const pCornerH1 = { kind: 'corners', side: 'over', line: 4.5, period: 'h1' }
        expect(formatPickTitle(pCornerH1, 'Hull City', 'Everton')).toBe('[Tài/Xỉu Góc H1] Tài 4.5')
    })
})

describe('anti-bias market anchoring & blending engine', () => {
    it('impliedLambdas solves lambdaTotal from Over/Under and lambdas from AH', () => {
        const odds: OddsLine[] = [
            { id: '1', kind: 'totals', side: 'over', line: 2.5, odds: 1.95 },
            { id: '2', kind: 'totals', side: 'under', line: 2.5, odds: 1.95 },
            { id: '3', kind: 'ah', side: 'home', line: -0.5, odds: 1.90 },
            { id: '4', kind: 'ah', side: 'away', line: 0.5, odds: 1.90 },
        ]

        const res = impliedLambdas(odds)
        expect(res.hasMarketOu).toBe(true)
        expect(res.hasMarketAh).toBe(true)
        expect(res.lambdaTotal).toBeGreaterThan(2.0)
        expect(res.lambdaTotal).toBeLessThan(3.5)
        expect(res.lambdaHome).toBeGreaterThan(res.lambdaAway) // home chấp -0.5 ăn 1.90 => lambdaHome > lambdaAway
    })

    it('blendLambdas assigns correct w weights based on quality gates', () => {
        const model = { home: 1.8, away: 1.0 }
        const market = { home: 1.4, away: 1.2 }

        // Đầy đủ 3 điều kiện (n >= 8, sourceCount >= 2, lineupConfirmed): w = 0.50
        const b1 = blendLambdas(model, market, { n: 10, sourceCount: 2, lineupConfirmed: true })
        expect(b1.w).toBe(0.50)
        expect(b1.lambdaHome).toBeCloseTo(0.5 * 1.8 + 0.5 * 1.4, 2)

        // Thiếu 1 điều kiện (lineup chưa xác nhận): w = 0.30
        const b2 = blendLambdas(model, market, { n: 10, sourceCount: 2, lineupConfirmed: false })
        expect(b2.w).toBe(0.30)
        expect(b2.lambdaHome).toBeCloseTo(0.3 * 1.8 + 0.7 * 1.4, 2)

        // Thiếu 2 điều kiện (n < 8, 1 nguồn): w = 0.15
        const b3 = blendLambdas(model, market, { n: 4, sourceCount: 1, lineupConfirmed: false })
        expect(b3.w).toBe(0.15)
        expect(b3.lambdaHome).toBeCloseTo(0.15 * 1.8 + 0.85 * 1.4, 2)

        // Không có market odds 2 đầu: w = 1.0
        const b4 = blendLambdas(model, null, { n: 10, sourceCount: 2, lineupConfirmed: true }, false)
        expect(b4.w).toBe(1.0)
        expect(b4.lambdaHome).toBe(1.8)
    })

    it('caps correlated picks scenario at maximum 2.5% total stake', () => {
        const data = diagMatchData()
        const correlatedOdds: OddsLine[] = [
            { id: '1', kind: 'ah', side: 'home', line: -0.5, odds: 2.0 },
            { id: '2', kind: 'totals', side: 'over', line: 2.5, odds: 2.0 },
        ]

        const res = analyzeMatch(data, correlatedOdds)
        expect(res.picks.length).toBe(2)
        const totalStake = res.picks[0].stakePct + res.picks[1].stakePct
        expect(totalStake).toBeLessThanOrEqual(0.025 + 1e-6)
    })

    it('inPlayScoreMatrix retains safety floor > 0 for remaining lambdas even at minute 90', () => {
        const decayed = inPlayScoreMatrix(1.5, 1.2, 90, { home: 1, away: 0 })
        expect(decayed.lambdaRemHome).toBeGreaterThanOrEqual(0.08)
        expect(decayed.lambdaRemAway).toBeGreaterThanOrEqual(0.08)
        expect(decayed.decayFactor).toBeGreaterThanOrEqual(0.05)
    })
})
