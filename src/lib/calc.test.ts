import { describe, it, expect } from 'vitest'
import { scoreMatrix, estimateLambdas } from '@/lib/poisson'
import { tripleFor } from '@/lib/markets'
import { evAndEdge } from '@/lib/engine'
import { settlePick } from '@/lib/settle'
import type { MatchData, ActualResult, Pick } from '@/lib/types'

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

describe('formatPickTitle (Formula check: Tên đội thật + mốc, không chữ Đội nhà/Đội khách)', () => {

    it('renders home handicap as [Tên Đội Nhà] ([mốc])', () => {
        const p = { kind: 'ah', side: 'home', line: 0.5 }
        expect(formatPickTitle(p, 'Hull City', 'Everton')).toBe('Hull City (+0.5)')

        const p2 = { kind: 'ah', side: 'home', line: -0.5 }
        expect(formatPickTitle(p2, 'Arsenal', 'Chelsea')).toBe('Arsenal (-0.5)')
    })

    it('renders away handicap as [Tên Đội Khách] ([mốc])', () => {
        const p = { kind: 'ah', side: 'away', line: -0.5 }
        expect(formatPickTitle(p, 'Hull City', 'Everton')).toBe('Everton (-0.5)')

        const p2 = { kind: 'ah', side: 'away', line: 0.5 }
        expect(formatPickTitle(p2, 'Arsenal', 'Chelsea')).toBe('Chelsea (+0.5)')
    })

    it('renders level (0) handicap as [Tên Đội] (0)', () => {
        const pHome = { kind: 'ah', side: 'home', line: 0 }
        expect(formatPickTitle(pHome, 'Hull City', 'Everton')).toBe('Hull City (0)')

        const pAway = { kind: 'ah', side: 'away', line: 0 }
        expect(formatPickTitle(pAway, 'Hull City', 'Everton')).toBe('Everton (0)')
    })

    it('renders totals as Tài [mốc] or Xỉu [mốc]', () => {
        const pOver = { kind: 'totals', side: 'over', line: 2.5 }
        expect(formatPickTitle(pOver, 'Hull City', 'Everton')).toBe('Tài 2.5')

        const pUnder = { kind: 'totals', side: 'under', line: 2.75 }
        expect(formatPickTitle(pUnder, 'Hull City', 'Everton')).toBe('Xỉu 2.75')
    })
})
