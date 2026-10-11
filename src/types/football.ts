/**
 * Core Data Models & Types for Football Ingestion, Quant Solver, Statistics & Events Hub
 * API Provider: API-Football (v3.football.api-sports.io)
 */

export interface TeamInfo {
    id: number
    name: string
    logo: string
    form?: string[] // e.g. ['W', 'W', 'W', 'W', 'D']
}

export interface MatchScore {
    halftime: { home: number | null; away: number | null }
    fulltime: { home: number | null; away: number | null }
    current: { home: number; away: number }
}

export interface MatchEventItem {
    time: { elapsed: number; extra?: number | null }
    team: { id: number; name: string; logo: string }
    player: { id: number; name: string }
    assist?: { id: number | null; name: string | null }
    type: 'Goal' | 'Card' | 'subst' | 'Var'
    detail: string // "Normal Goal", "Yellow Card", "Substitution 1", "Goal confirmed"
    comments?: string | null
}

export interface MatchDetailedStats {
    possession: { home: number; away: number }
    shots: {
        total: { home: number; away: number }
        onTarget: { home: number; away: number }
        offTarget: { home: number; away: number }
        blocked: { home: number; away: number }
        insideBox: { home: number; away: number }
        outsideBox: { home: number; away: number }
    }
    passing: {
        total: { home: number; away: number }
        accurate: { home: number; away: number }
        accuracyPercentage: { home: number; away: number }
        keyPasses: { home: number; away: number }
        crossesAccurate: { home: number; away: number; percentageHome: number; percentageAway: number }
        longBallsAccurate: { home: number; away: number; percentageHome: number; percentageAway: number }
    }
    duelsAndDefense: {
        tackles: { home: number; away: number }
        interceptions: { home: number; away: number }
        clearances: { home: number; away: number }
        fouls: { home: number; away: number }
        saves: { home: number; away: number }
        aerialWon: { home: number; away: number; percentageHome: number; percentageAway: number }
    }
    discipline: {
        corners: { home: number; away: number }
        offsides: { home: number; away: number }
        yellowCards: { home: number; away: number }
        redCards: { home: number; away: number }
        penaltiesAwarded: { home: number; away: number }
    }
}

export interface ExtractedOddsLine {
    id: string
    type: 'ou' | 'ah' | '1x2' // Over/Under, Asian Handicap, Match Winner
    line: number // e.g., 4.25, 4.5, -0.5, 0.25
    side: 'over' | 'under' | 'home' | 'away' | 'draw'
    odds: number // Decimal odds e.g., 2.41, 1.95
    selectionName: string // e.g., "Xỉu 4.25", "Freiburg (-0.5)"
}

export interface QuantRecommendation {
    rank: 1 | 2
    badge: '[KÈO TỐI ƯU NHẤT - TOP 1 VALUE]' | '[KÈO DỰ PHÒNG - TOP 2]'
    selectionName: string
    line: number
    marketType: string
    odds: number
    modelProb: number
    expectedValue: number
    edge: number
    kellyStakePercentage: number
    reasoning: string
}
