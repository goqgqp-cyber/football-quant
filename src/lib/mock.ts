import type { MatchData, MatchInput, OddsLine, ActualResult } from './types'

/**
 * Dữ liệu GIẢ cho G1 — mô phỏng đúng schema Bước A.
 * KHÔNG dùng làm dữ liệu thật. G4 sẽ thay bằng output Gemini + grounding.
 * Ghi rõ nguồn 'mock' để không nhầm với dữ liệu thật.
 */
export const MOCK_MATCH_INPUT: MatchInput = {
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    league: 'Premier League',
    kickoff: '2026-10-18T14:30:00Z',
    lg_home: 1.45,
    lg_away: 1.15,
}

export const MOCK_MATCH_DATA: MatchData = {
    home: {
        xgf: 2.05,
        xga: 0.95,
        goals_for: 1.9,
        goals_against: 0.9,
        n: 10,
        injuries: [],
        lineup_confirmed: false,
    },
    away: {
        xgf: 1.5,
        xga: 1.25,
        goals_for: 1.4,
        goals_against: 1.2,
        n: 10,
        injuries: [],
        lineup_confirmed: false,
    },
    h2h: {
        n: 6,
        avg_goals: 2.6,
        btts_rate: 0.5,
    },
    sources: [
        { url: 'https://example.com/a', title: 'Nguồn A (giả)', fetched_at: '2026-10-11T00:00:00Z' },
        { url: 'https://example.com/b', title: 'Nguồn B (giả)', fetched_at: '2026-10-11T00:00:00Z' },
    ],
    conflicts: [],
    missing: [],
    origin: 'manual',
}

export const MOCK_ODDS: OddsLine[] = [
    { id: 't25', kind: 'totals', side: 'over', line: 2.5, odds: 1.95 },
    { id: 't25u', kind: 'totals', side: 'under', line: 2.5, odds: 1.95 },
    { id: 't30', kind: 'totals', side: 'over', line: 3.0, odds: 2.10 },
    { id: 't30u', kind: 'totals', side: 'under', line: 3.0, odds: 1.80 },
    { id: 'ahh0', kind: 'ah', side: 'home', line: 0, odds: 1.90 },
    { id: 'aha0', kind: 'ah', side: 'away', line: 0, odds: 1.90 },
    { id: 'ahh05', kind: 'ah', side: 'home', line: -0.5, odds: 2.00 },
    { id: 'aha05', kind: 'ah', side: 'away', line: -0.5, odds: 1.80 },
]

export const MOCK_RESULT: ActualResult = {
    htHome: 1,
    htAway: 0,
    ftHome: 2,
    ftAway: 1,
}