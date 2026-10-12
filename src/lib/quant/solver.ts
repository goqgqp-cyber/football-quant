import type { Pick } from '../types'

/**
 * Normalizes period to either 'ht' or 'ft'.
 */
export function normalizePeriod(period?: string, oddsLineId?: string): 'ht' | 'ft' {
    const s = `${period || ''} ${oddsLineId || ''}`.toLowerCase()
    if (s.includes('1st') || s.includes('h1') || s.includes('ht') || s.includes('hiệp 1') || s.includes('1h')) {
        return 'ht'
    }
    return 'ft'
}

/**
 * Normalizes bet object to either 'goals' or 'corners'.
 */
export function normalizeObject(kind?: string, object?: string, oddsLineId?: string): 'goals' | 'corners' {
    const s = `${kind || ''} ${object || ''} ${oddsLineId || ''}`.toLowerCase()
    if (s.includes('corner') || s.includes('goc') || s.includes('phạt góc')) {
        return 'corners'
    }
    return 'goals'
}

/**
 * Checks if two picks are directly opposing/contradictory.
 *
 * Rules:
 * 1. Must share the same period (HT vs FT) and the same object (goals vs corners).
 * 2. Over vs Under on the same line:
 *    - If Pick 1 is Over X, Pick 2 CANNOT be Under X of the same line and same period.
 *    - If Pick 1 is Under X, Pick 2 CANNOT be Over X of the same line and same period.
 * 3. Asian Handicap on opposite sides of the same handicap line:
 *    - If Pick 1 is Home +HDP, Pick 2 CANNOT be Away -HDP of the same handicap line.
 *    - If Pick 1 is Home -HDP, Pick 2 CANNOT be Away +HDP of the same handicap line.
 */
export function isOpposingPick(p1: Pick, p2: Pick): boolean {
    const p1Period = normalizePeriod(p1.period, p1.oddsLineId)
    const p2Period = normalizePeriod(p2.period, p2.oddsLineId)
    if (p1Period !== p2Period) return false

    const p1Object = normalizeObject(p1.kind, p1.object, p1.oddsLineId)
    const p2Object = normalizeObject(p2.kind, p2.object, p2.oddsLineId)
    if (p1Object !== p2Object) return false

    // 1. Totals / Over-Under Opposing Check
    const isTotals1 = p1.kind === 'totals' || p1.side === 'over' || p1.side === 'under'
    const isTotals2 = p2.kind === 'totals' || p2.side === 'over' || p2.side === 'under'
    if (isTotals1 && isTotals2) {
        const sameLine = Math.abs(p1.line - p2.line) < 1e-4
        const opposingSides =
            (p1.side === 'over' && p2.side === 'under') ||
            (p1.side === 'under' && p2.side === 'over')

        if (sameLine && opposingSides) {
            return true
        }
    }

    // 2. Asian Handicap Opposing Check
    const isAh1 = p1.kind === 'ah' || p1.side === 'home' || p1.side === 'away'
    const isAh2 = p2.kind === 'ah' || p2.side === 'home' || p2.side === 'away'
    if (isAh1 && isAh2) {
        const opposingSides =
            (p1.side === 'home' && p2.side === 'away') ||
            (p1.side === 'away' && p2.side === 'home')

        // When stored with home-relative lines, Home +X corresponds to Away -X (e.g. +0.25 vs -0.25).
        // In sportsbooks where line is absolute (e.g. 0.25 for both), abs(p1.line - p2.line) == 0.
        const sameHandicapLine =
            Math.abs(p1.line - p2.line) < 1e-4 ||
            Math.abs(p1.line + p2.line) < 1e-4

        if (opposingSides && sameHandicapLine) {
            return true
        }
    }

    return false
}

export interface SolvePicksResult {
    picks: Pick[]
    top1: Pick | null
    top2: Pick | null
}

export const MIN_RECOMMENDED_ODDS = 1.60
export const MAX_RECOMMENDED_ODDS = 2.35

/**
 * Checks if a pick falls within the strictly enforced odds range [1.60, 2.35].
 * Rejects extreme lines like < 1.60 or > 2.35 (e.g. 3.43, 4.12).
 */
export function isEligibleOdds(odds: number): boolean {
    return odds >= MIN_RECOMMENDED_ODDS && odds <= MAX_RECOMMENDED_ODDS
}

/**
 * Enforce hard boundary in candidate selection:
 * Rejects odds < 1.60 or > 2.35, traps, and suspicious edges.
 */
export function isCandidateEligible(line: Pick): boolean {
    if (line.odds < 1.60 || line.odds > 2.35) {
        return false // Strictly reject secondary high-odds lines like 3.43 or 4.12
    }
    if (line.status === 'trap' || line.flags.includes('suspicious_edge')) {
        return false
    }
    return true
}

/**
 * Solves top recommendations with strict anti-contradiction and quality guards:
 * 1. Sorts picks by compositeScore ((EV * 0.6) + (Edge * 0.4)) descending.
 * 2. Picks Top 1 within strict odds range [1.60, 2.35] (not suspicious/trap).
 * 3. Filters candidates for Top 2:
 *    - MUST have odds in [1.60, 2.35].
 *    - MUST NOT be directly opposing Top 1.
 *    - MUST have Edge >= 5% (0.05).
 *    - MUST have EV > 0.
 *    - MUST NOT be a trap or suspicious edge.
 * 4. If no candidate qualifies for Top 2, only Top 1 is labeled and recommended.
 * 5. If no candidate qualifies for Top 1, returns null recommendations.
 */
export function solveRecommendedPicks(picks: Pick[]): SolvePicksResult {
    if (picks.length === 0) {
        return { picks: [], top1: null, top2: null }
    }

    // Clear previous rankLabels
    for (const p of picks) {
        delete p.rankLabel
    }

    // Sort by compositeScore descending
    picks.sort((a, b) => (b.compositeScore ?? 0) - (a.compositeScore ?? 0))

    // Select Top 1 Pick
    let p1Idx = picks.findIndex((p) => isCandidateEligible(p))
    if (p1Idx === -1) {
        return { picks, top1: null, top2: null }
    }

    const p1 = picks[p1Idx]
    p1.rankLabel = '[KÈO TỐI ƯU NHẤT - TOP 1 VALUE]'
    if (p1.status !== 'trap') {
        p1.status = 'value'
    }

    // Stake sizing for Top 1
    if (p1.flags.includes('suspicious_edge') || p1.confidence === 'low') {
        p1.stakePct = 0.015
    } else {
        p1.stakePct = p1.stakePct > 0 ? Math.min(0.05, Math.max(0.02, p1.stakePct)) : 0.03
    }

    // Search for Top 2 candidate
    let top2: Pick | null = null
    for (let i = 0; i < picks.length; i++) {
        if (i === p1Idx) continue
        const cand = picks[i]

        // 0. Hard boundary in candidate selection: [1.60, 2.35]
        if (cand.odds < 1.60 || cand.odds > 2.35) {
            continue // Strictly reject secondary high-odds lines like 3.43 or 4.12
        }

        // 1. Strict opposition ban
        if (isOpposingPick(p1, cand)) {
            continue
        }

        // 2. Strict quality threshold: Edge >= 5% and EV > 0
        if (cand.edge < 0.05 || cand.ev <= 0) {
            continue
        }

        // 3. Health guards
        if (cand.status === 'trap' || cand.flags.includes('suspicious_edge')) {
            continue
        }

        // Candidate qualifies as Top 2!
        top2 = cand
        break
    }

    if (top2) {
        top2.rankLabel = '[KÈO DỰ PHÒNG - TOP 2]'
        if (top2.status !== 'trap') {
            top2.status = 'value'
        }
        top2.stakePct = top2.stakePct > 0 ? Math.min(0.04, Math.max(0.02, top2.stakePct)) : 0.02
    }

    // Correlated picks scenario check across positions:
    // Nếu các kèo cùng chung kịch bản (ví dụ đội cửa trên thắng + Tài), coi như một vị thế, tổng vốn <= 2.5%
    const remainingPicks = picks.filter((_, idx) => idx !== p1Idx)
    if (remainingPicks.length > 0) {
        const nextPick = top2 || remainingPicks[0]
        const isCorrelated =
            (p1.side === 'home' && nextPick.side === 'over') ||
            (p1.side === 'over' && nextPick.side === 'home') ||
            (p1.side === 'away' && nextPick.side === 'under') ||
            (p1.side === 'under' && nextPick.side === 'away') ||
            p1.side === nextPick.side

        if (isCorrelated && p1.stakePct + nextPick.stakePct > 0.025) {
            p1.stakePct = Math.min(p1.stakePct, 0.015)
            nextPick.stakePct = Math.min(nextPick.stakePct, 0.010)
            nextPick.flags.push('correlated_scenario_capped_2.5%')
        }
    }

    return {
        picks,
        top1: p1,
        top2,
    }
}

/**
 * Filter qualified picks for presentation & history persistence.
 * Returns at most [Top 1, Top 2] if Top 2 meets the strict thresholds.
 * If only Top 1 qualifies, returns only [Top 1].
 */
export function filterRecommendedPicks(picks: Pick[]): Pick[] {
    if (picks.length === 0) return []
    const topPicks = picks.filter((p) => p.rankLabel && isEligibleOdds(p.odds))
    if (topPicks.length > 0) {
        return topPicks.slice(0, 2)
    }

    // Fallback if rankLabel was not explicitly run:
    const valuePicks = picks.filter(
        (p) => isEligibleOdds(p.odds) && p.status === 'value' && p.edge >= 0.05 && p.ev > 0 && !p.flags.includes('suspicious_edge'),
    )
    if (valuePicks.length === 0) {
        return []
    }
    if (valuePicks.length === 1) {
        return valuePicks
    }

    // Ensure valuePicks[1] is not opposing valuePicks[0]
    const p1 = valuePicks[0]
    const nonOpposingP2 = valuePicks.slice(1).find((p) => !isOpposingPick(p1, p))
    return nonOpposingP2 ? [p1, nonOpposingP2] : [p1]
}
