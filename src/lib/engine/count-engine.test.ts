import { describe, expect, it } from 'vitest'
import {
    checkDataGate,
    computeStreamEstimate,
    computeTeamNewsDelta,
    evalAsianHandicap,
    evalMatchOutcome,
    evalTotals,
    evaluateCountSelection,
    type MatchRecord,
    type SampleStreams,
    type SelectionTarget,
    type TeamNewsItem,
} from './count-engine'
import { ENGINE_CONFIG } from '../../config/engine'

describe('Spec Section 6 & 7: Count-Based Probability Engine', () => {
    // Helper to generate dummy match records with specific score
    function makeMatch(
        homeScore: number,
        awayScore: number,
        date = '2026-03-01',
        homeTeam = 'Arsenal',
        awayTeam = 'Chelsea',
    ): MatchRecord {
        return {
            date,
            home_team: homeTeam,
            away_team: awayTeam,
            home_goals_ft: homeScore,
            away_goals_ft: awayScore,
            source: 'api-football',
            fetchedAt: '2026-03-01T12:00:00Z',
            verified: true,
        }
    }

    describe('Section 6.7: Worked Example Unit Test', () => {
        it('matches Section 6.7 worked example down to 1e-4 accuracy', () => {
            // Worked example: Over 2.5 goals
            // Hits:
            // H_venue: 3 hits out of 5 (3 Over, 2 Under)
            // H_all: 4 hits out of 8 (4 Over, 4 Under)
            // A_venue: 2 hits out of 5 (2 Over, 3 Under)
            // A_all: 3 hits out of 8 (3 Over, 5 Under)
            // X: 2 hits out of 5 (2 Over, 3 Under)

            const hVenueMatches: MatchRecord[] = [
                makeMatch(2, 1), // Over 2.5 (3 goals)
                makeMatch(3, 0), // Over 2.5 (3 goals)
                makeMatch(2, 2), // Over 2.5 (4 goals)
                makeMatch(1, 0), // Under 2.5 (1 goal)
                makeMatch(0, 1), // Under 2.5 (1 goal)
            ]

            const hAllMatches: MatchRecord[] = [
                makeMatch(2, 1), // Over
                makeMatch(3, 1), // Over
                makeMatch(2, 2), // Over
                makeMatch(3, 0), // Over
                makeMatch(1, 0), // Under
                makeMatch(0, 0), // Under
                makeMatch(1, 1), // Under
                makeMatch(0, 2), // Under
            ]

            const aVenueMatches: MatchRecord[] = [
                makeMatch(2, 1), // Over
                makeMatch(1, 2), // Over
                makeMatch(1, 0), // Under
                makeMatch(0, 1), // Under
                makeMatch(0, 0), // Under
            ]

            const aAllMatches: MatchRecord[] = [
                makeMatch(2, 1), // Over
                makeMatch(3, 0), // Over
                makeMatch(0, 3), // Over
                makeMatch(1, 0), // Under
                makeMatch(0, 1), // Under
                makeMatch(0, 0), // Under
                makeMatch(1, 1), // Under
                makeMatch(0, 2), // Under
            ]

            const xMatches: MatchRecord[] = [
                makeMatch(2, 1), // Over
                makeMatch(1, 2), // Over
                makeMatch(1, 0), // Under
                makeMatch(0, 1), // Under
                makeMatch(1, 1), // Under
            ]

            const samples: SampleStreams = {
                H_venue: hVenueMatches,
                H_all: hAllMatches,
                A_venue: aVenueMatches,
                A_all: aAllMatches,
                X: xMatches,
            }

            const targetOver: SelectionTarget = {
                market: 'totals',
                side: 'over',
                line: 2.5,
                odds: 1.95,
                oppositeOdds: 1.90, // Under odds
            }

            const customConfig = {
                ...ENGINE_CONFIG,
                DECAY: 1.0,
                SHRINK_K: 4,
            }

            // 1. Check Stream Estimates
            const estHVenue = computeStreamEstimate(samples.H_venue, targetOver, 'home', 'home', 1.0, 4)
            const estHAll = computeStreamEstimate(samples.H_all, targetOver, 'home', 'home', 1.0, 4)
            const estAVenue = computeStreamEstimate(samples.A_venue, targetOver, 'away', 'home', 1.0, 4)
            const estAAll = computeStreamEstimate(samples.A_all, targetOver, 'away', 'home', 1.0, 4)
            const estX = computeStreamEstimate(samples.X, targetOver, 'h2h', 'home', 1.0, 4)

            // Shrunk values should be ~0.5556, 0.5000, 0.4444, 0.4167, 0.4444
            expect(estHVenue.P_shrunk.win).toBeCloseTo(0.5556, 4)
            expect(estHAll.P_shrunk.win).toBeCloseTo(0.5000, 4)
            expect(estAVenue.P_shrunk.win).toBeCloseTo(0.4444, 4)
            expect(estAAll.P_shrunk.win).toBeCloseTo(0.4167, 4)
            expect(estX.P_shrunk.win).toBeCloseTo(0.4444, 4)

            // 2. Evaluate Over 2.5
            const evalOver = evaluateCountSelection(samples, targetOver, 'home', [], customConfig)

            // P_data(Over) = 0.4764
            expect(evalOver.pData.win).toBeCloseTo(0.4764, 4)
            expect(evalOver.pData.lose).toBeCloseTo(0.5236, 4)

            // No-vig P_market(Over) = 0.4935
            expect(evalOver.pMarket?.win).toBeCloseTo(0.4935, 4)

            // With beta = 0.30: P_final(Over) = 0.4815
            expect(evalOver.pFinal.win).toBeCloseTo(0.4815, 4)
            expect(evalOver.headlineWinProb).toBeCloseTo(0.4815, 4)

            // Decision: Over 2.5 -> NO BET (below 50%)
            expect(evalOver.status).toBe('NO_BET')

            // 3. Evaluate Under 2.5 @ 1.90
            const targetUnder: SelectionTarget = {
                market: 'totals',
                side: 'under',
                line: 2.5,
                odds: 1.90,
                oppositeOdds: 1.95,
            }
            const evalUnder = evaluateCountSelection(samples, targetUnder, 'home', [], customConfig)

            // P_final(Under) = 0.5185
            expect(evalUnder.pFinal.win).toBeCloseTo(0.5185, 4)
            expect(evalUnder.headlineWinProb).toBeCloseTo(0.5185, 4)

            // Decision: Under 2.5 -> PICK, but break-even = 1/1.90 = 52.63% > 51.85% -> NEGATIVE_VALUE
            expect(evalUnder.status).toBe('PICK')
            expect(evalUnder.breakEven).toBeCloseTo(1 / 1.90, 4)
            expect(evalUnder.flags).toContain('NEGATIVE_VALUE')
            // Staking capped at 1.0% when NEGATIVE_VALUE
            expect(evalUnder.stakePct).toBeLessThanOrEqual(0.01)
        })
    })

    describe('Probability Invariants & Sum to 1', () => {
        it('ensures win + push + lose === 1 for all streams and final combined estimate', () => {
            const matches: MatchRecord[] = [
                makeMatch(1, 0),
                makeMatch(2, 2),
                makeMatch(0, 1),
                makeMatch(3, 1),
                makeMatch(0, 0),
            ]
            const samples: SampleStreams = {
                H_venue: matches,
                H_all: [...matches, ...matches],
                A_venue: matches,
                A_all: [...matches, ...matches],
                X: matches,
            }

            const targetAH: SelectionTarget = {
                market: 'ah',
                side: 'home',
                line: -0.25,
                odds: 1.95,
                oppositeOdds: 1.95,
            }

            const res = evaluateCountSelection(samples, targetAH, 'home')
            expect(res.pData.win + res.pData.push + res.pData.lose).toBeCloseTo(1.0, 6)
            expect(res.pFinal.win + res.pFinal.push + res.pFinal.lose).toBeCloseTo(1.0, 6)
        })
    })

    describe('Quarter-Line Splitting', () => {
        it('correctly splits Asian Handicap quarter lines (+0.25, -0.75)', () => {
            // Margin d + h. For h = -0.25, splits into 0 and -0.5
            // If d = 0 (draw):
            // h1 = 0: d + 0 = 0 -> push
            // h2 = -0.5: d - 0.5 = -0.5 -> lose
            // Result should be: win 0, push 0.5, lose 0.5
            const ahQuarter = evalAsianHandicap(0, -0.25)
            expect(ahQuarter.win).toBe(0)
            expect(ahQuarter.push).toBe(0.5)
            expect(ahQuarter.lose).toBe(0.5)

            // If d = 1 (win by 1):
            // h = -0.75 splits into -0.5 and -1.0
            // h1 = -0.5: 1 - 0.5 = +0.5 -> win
            // h2 = -1.0: 1 - 1.0 = 0 -> push
            // Result: win 0.5, push 0.5, lose 0
            const ahThreeQuarter = evalAsianHandicap(1, -0.75)
            expect(ahThreeQuarter.win).toBe(0.5)
            expect(ahThreeQuarter.push).toBe(0.5)
            expect(ahThreeQuarter.lose).toBe(0)
        })

        it('correctly splits Over/Under quarter lines (2.25, 2.75)', () => {
            // Over 2.25 with total goals = 2:
            // l1 = 2.0: 2 - 2.0 = 0 -> push
            // l2 = 2.5: 2 - 2.5 = -0.5 -> lose
            // Result: win 0, push 0.5, lose 0.5
            const ouQuarter = evalTotals(2, 2.25, true)
            expect(ouQuarter.win).toBe(0)
            expect(ouQuarter.push).toBe(0.5)
            expect(ouQuarter.lose).toBe(0.5)

            // Over 2.75 with total goals = 3:
            // l1 = 2.5: 3 - 2.5 = 0.5 -> win
            // l2 = 3.0: 3 - 3.0 = 0 -> push
            // Result: win 0.5, push 0.5, lose 0
            const ouThreeQuarter = evalTotals(3, 2.75, true)
            expect(ouThreeQuarter.win).toBe(0.5)
            expect(ouThreeQuarter.push).toBe(0.5)
            expect(ouThreeQuarter.lose).toBe(0)
        })
    })

    describe('Perspective Reversal', () => {
        it('applies reversed perspective when evaluating opponent stream', () => {
            const match = makeMatch(3, 1, '2026-03-01', 'Chelsea', 'Fulham')
            const selection: SelectionTarget = { market: '1x2', side: 'home' }

            // Home perspective on home team match (Arsenal is home, match was Chelsea win 3-1):
            // Arsenal viewpoint when stream is Chelsea (opponent away team stream):
            // Opponent won 3-1 -> Against opponent, Fulham lost -> Reversed result: opponent's opponent scored 1, opponent scored 3 -> d = -2 -> lose
            const outcomeOpp = evalMatchOutcome(match, selection, 'A_all', 'home', 'Arsenal', 'Chelsea')
            expect(outcomeOpp.win).toBe(0)
            expect(outcomeOpp.lose).toBe(1)
        })
    })

    describe('Weight Redistribution on Dropped Streams', () => {
        it('drops venue stream with < 3 matches and redistributes weight', () => {
            const fiveMatches = [
                makeMatch(1, 0),
                makeMatch(2, 0),
                makeMatch(1, 1),
                makeMatch(0, 0),
                makeMatch(2, 1),
            ]
            const samples: SampleStreams = {
                H_venue: [makeMatch(1, 0), makeMatch(2, 0)], // only 2 matches -> MUST BE DROPPED
                H_all: fiveMatches,
                A_venue: [makeMatch(0, 1), makeMatch(1, 1), makeMatch(0, 0)], // 3 matches -> kept
                A_all: fiveMatches,
                X: [], // 0 matches -> MUST BE DROPPED
            }

            const target: SelectionTarget = { market: '1x2', side: 'home', odds: 1.8 }
            const res = evaluateCountSelection(samples, target, 'home')

            expect(res.weightsUsed.H_venue).toBe(0)
            expect(res.weightsUsed.X).toBe(0)
            // Remaining streams: H_all (0.15), A_venue (0.25), A_all (0.15)
            // Total = 0.55
            expect(res.weightsUsed.H_all).toBeCloseTo(0.15 / 0.55, 4)
            expect(res.weightsUsed.A_venue).toBeCloseTo(0.25 / 0.55, 4)
            expect(res.weightsUsed.A_all).toBeCloseTo(0.15 / 0.55, 4)
            expect(
                res.weightsUsed.H_all + res.weightsUsed.A_venue + res.weightsUsed.A_all,
            ).toBeCloseTo(1.0, 6)
        })
    })

    describe('Team News Bounded Adjustment', () => {
        it('caps news adjustment at +/- 5 percentage points', () => {
            const news: TeamNewsItem[] = [
                { team: 'home', player: 'A', role: 'att', importance: 'key', status: 'out' }, // -2 pp
                { team: 'home', player: 'B', role: 'def', importance: 'key', status: 'out' }, // -2 pp
                { team: 'home', player: 'C', role: 'gk', importance: 'key', status: 'out' }, // -2 pp
                { team: 'home', player: 'D', role: 'att', importance: 'key', status: 'suspended' }, // -2 pp
            ] // Total -8 pp, should cap at -5 pp

            const delta = computeTeamNewsDelta(news, 'home', '1x2', 'home')
            expect(delta).toBe(-5)
        })
    })

    describe('Data Gate & Hard Decision Rules', () => {
        it('fails data gate when a team has fewer than 5 matches in *_all', () => {
            const fourMatches = [
                makeMatch(1, 0),
                makeMatch(2, 0),
                makeMatch(1, 1),
                makeMatch(0, 0),
            ]
            const samples: SampleStreams = {
                H_venue: fourMatches,
                H_all: fourMatches, // 4 matches < 5 gate!
                A_venue: fourMatches,
                A_all: [
                    ...fourMatches,
                    makeMatch(1, 0),
                ],
                X: [],
            }

            expect(checkDataGate(samples)).toBe(false)
            const res = evaluateCountSelection(samples, { market: '1x2', side: 'home' }, 'home')
            expect(res.status).toBe('INSUFFICIENT_DATA')
            expect(res.flags).toContain('INSUFFICIENT_DATA')
        })

        it('strictly returns ODDS_TOO_LOW when odds < 1.50', () => {
            const fiveMatches = [
                makeMatch(3, 0),
                makeMatch(2, 0),
                makeMatch(3, 1),
                makeMatch(2, 1),
                makeMatch(4, 0),
            ]
            const samples: SampleStreams = {
                H_venue: fiveMatches,
                H_all: fiveMatches,
                A_venue: fiveMatches,
                A_all: fiveMatches,
                X: fiveMatches,
            }

            const target: SelectionTarget = {
                market: '1x2',
                side: 'home',
                odds: 1.35, // Below 1.50
                oppositeOdds: 3.50,
            }

            const res = evaluateCountSelection(samples, target, 'home')
            expect(res.status).toBe('ODDS_TOO_LOW')
            expect(res.flags).toContain('odds_below_min')
        })
    })
})
