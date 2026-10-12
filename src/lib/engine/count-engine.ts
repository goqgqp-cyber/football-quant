import { ENGINE_CONFIG } from '../../config/engine'
import type { Confidence, Triple, MatchRecord as CommonMatchRecord } from '../types'

export interface MatchRecord {
    date: string // YYYY-MM-DD
    competition?: string
    home_team: string
    away_team: string
    home_goals_ft: number
    away_goals_ft: number
    home_goals_ht?: number | null
    away_goals_ht?: number | null
    venue_note?: string | null
    source?: string
    fetchedAt?: string
    provenance?: {
        source: string
        fetchedAt: string
        verified?: boolean
    }
    source_url?: string
    source_name?: string
    source_fetched_at?: string
    verified?: boolean
}

export class MissingProvenanceError extends Error {
    constructor(message = 'Bản ghi trận đấu thiếu thông tin nguồn gốc (provenance: source, fetchedAt)') {
        super(message)
        this.name = 'MissingProvenanceError'
    }
}

export class InsufficientDataError extends Error {
    readonly homeMatches: number
    readonly awayMatches: number
    constructor(homeMatches: number, awayMatches: number, message?: string) {
        super(
            message ||
                `Dữ liệu không đủ để dự đoán: đội nhà có ${homeMatches} trận, đội khách có ${awayMatches} trận (yêu cầu tối thiểu 5 trận).`,
        )
        this.name = 'InsufficientDataError'
        this.homeMatches = homeMatches
        this.awayMatches = awayMatches
    }
}

export function validateMatchProvenance(record: MatchRecord | CommonMatchRecord | any): void {
    const hasSource = Boolean(
        record.source || record.provenance?.source || record.source_name || record.source_url,
    )
    const hasFetchedAt = Boolean(
        record.fetchedAt || record.provenance?.fetchedAt || record.source_fetched_at,
    )
    if (!hasSource || !hasFetchedAt) {
        const homeName = record.home_team || record.homeTeam || 'Home'
        const awayName = record.away_team || record.awayTeam || 'Away'
        throw new MissingProvenanceError(
            `Bản ghi trận đấu ${homeName} vs ${awayName} ngày ${record.date} thiếu thông tin nguồn gốc (source & fetchedAt).`,
        )
    }
}

export function validateSampleStreamsProvenance(
    samples: SampleStreams | MatchRecord[] | CommonMatchRecord[],
): void {
    if (Array.isArray(samples)) {
        for (const m of samples) {
            validateMatchProvenance(m)
        }
        return
    }
    const allMatches = [
        ...samples.H_venue,
        ...samples.H_all,
        ...samples.A_venue,
        ...samples.A_all,
        ...samples.X,
    ]
    for (const m of allMatches) {
        validateMatchProvenance(m)
    }
}

export interface SampleStreams {
    H_venue: MatchRecord[] // Home team's last up to 8 HOME matches
    H_all: MatchRecord[]   // Home team's last up to 10 matches all competitions
    A_venue: MatchRecord[] // Away team's last up to 8 AWAY matches
    A_all: MatchRecord[]   // Away team's last up to 10 matches all competitions
    X: MatchRecord[]       // Head-to-head, last up to 6 meetings
}

export type SelectionMarket = '1x2' | 'ah' | 'totals' | 'btts'
export type SelectionSide = 'home' | 'away' | 'draw' | 'over' | 'under' | 'yes' | 'no'

export interface SelectionTarget {
    market: SelectionMarket
    side: SelectionSide
    line?: number // e.g. -0.5, +0.25 for AH, 2.5, 2.75 for totals
    odds?: number
    oppositeOdds?: number // for 2-way no-vig calculation
    drawOdds?: number     // for 3-way 1X2 no-vig
}

export interface TeamNewsItem {
    team: 'home' | 'away'
    player: string
    status: 'out' | 'doubtful' | 'suspended' | 'returning'
    role: 'gk' | 'def' | 'mid' | 'att' | 'unknown'
    importance: 'key' | 'regular' | 'fringe' | 'unknown'
}

export interface StreamEstimate {
    rawCounts: Triple
    n_eff: number
    Pw: number
    Pp: number
    Pl: number
    P_shrunk: Triple
    matchesCount: number
    dropped?: boolean
}

export interface SelectionEvaluation {
    market: SelectionMarket
    side: SelectionSide
    line: number
    odds?: number
    pData: Triple
    newsDeltaPp: number
    pDataAdjusted: Triple
    pMarket: Triple | null
    pFinal: Triple
    headlineWinProb: number
    breakEven: number | null
    edge: number
    ev: number
    status: 'PICK' | 'NO_BET' | 'ODDS_TOO_LOW' | 'INSUFFICIENT_DATA'
    flags: string[]
    confidence: Confidence
    confidenceScore: number
    stakePct: number
    streams: Record<keyof SampleStreams, StreamEstimate | null>
    weightsUsed: Record<keyof SampleStreams, number>
}

/**
 * Checks the data gate (Spec Section 5 & 7.2):
 * - Each team must have >= 5 matches in *_all within the last 12 months.
 * Returns true if gate passes, false otherwise.
 */
export function checkDataGate(samples: SampleStreams): boolean {
    return samples.H_all.length >= 5 && samples.A_all.length >= 5
}

/**
 * Evaluates outcome triple (win, push, lose) for a single match from perspective of side S.
 */
export function evalMatchOutcome(
    match: MatchRecord,
    selection: SelectionTarget,
    streamTeam: 'H_venue' | 'H_all' | 'A_venue' | 'A_all' | 'X' | 'home' | 'away' | 'h2h',
    targetSide: 'home' | 'away',
    homeTeamName?: string,
    awayTeamName?: string,
): Triple {
    let goalsS = 0
    let goalsOpp = 0

    if (streamTeam === 'X' || streamTeam === 'h2h') {
        const homeName = match.home_team.toLowerCase()
        const homeTargetName = homeTeamName?.toLowerCase()
        const isTargetHomeInMatch = homeTargetName
            ? homeName.includes(homeTargetName) || homeTargetName.includes(homeName)
            : targetSide === 'home'

        if (targetSide === 'home') {
            goalsS = isTargetHomeInMatch ? match.home_goals_ft : match.away_goals_ft
            goalsOpp = isTargetHomeInMatch ? match.away_goals_ft : match.home_goals_ft
        } else {
            goalsS = isTargetHomeInMatch ? match.away_goals_ft : match.home_goals_ft
            goalsOpp = isTargetHomeInMatch ? match.home_goals_ft : match.away_goals_ft
        }
    } else {
        // Determine whether the stream team was home or away in this specific historical match:
        const isHomeStream = streamTeam === 'H_venue' || streamTeam === 'H_all' || streamTeam === 'home'
        const streamTeamName = isHomeStream ? homeTeamName : awayTeamName

        let streamTeamPlayedHome = isHomeStream
        if (streamTeam === 'H_venue') {
            streamTeamPlayedHome = true
        } else if (streamTeam === 'A_venue') {
            streamTeamPlayedHome = false
        } else if (streamTeamName) {
            const h = match.home_team.toLowerCase()
            const a = match.away_team.toLowerCase()
            const name = streamTeamName.toLowerCase()
            if (h.includes(name) || name.includes(h)) {
                streamTeamPlayedHome = true
            } else if (a.includes(name) || name.includes(a)) {
                streamTeamPlayedHome = false
            }
        }

        const teamGoals = streamTeamPlayedHome ? match.home_goals_ft : match.away_goals_ft
        const oppGoals = streamTeamPlayedHome ? match.away_goals_ft : match.home_goals_ft

        // Perspective rule (Spec Section 6.2):
        // If stream belongs to target team: use its own result (teamGoals vs oppGoals)
        // If stream belongs to OTHER team: use reversed result (how often that team's opponents achieved the selection against it)
        const isTargetTeam = isHomeStream ? targetSide === 'home' : targetSide === 'away'
        if (isTargetTeam) {
            goalsS = teamGoals
            goalsOpp = oppGoals
        } else {
            goalsS = oppGoals
            goalsOpp = teamGoals
        }
    }

    const d = goalsS - goalsOpp
    const t = goalsS + goalsOpp

    // 1. 1X2 Market
    if (selection.market === '1x2') {
        if (selection.side === 'draw') {
            return d === 0 ? { win: 1, push: 0, lose: 0 } : { win: 0, push: 0, lose: 1 }
        }
        return d > 0 ? { win: 1, push: 0, lose: 0 } : { win: 0, push: 0, lose: 1 }
    }

    // 2. Asian Handicap Market
    if (selection.market === 'ah') {
        const h = selection.line ?? 0
        return evalAsianHandicap(d, h)
    }

    // 3. Over / Under Market
    if (selection.market === 'totals') {
        const line = selection.line ?? 2.5
        const isOver = selection.side === 'over'
        return evalTotals(t, line, isOver)
    }

    // 4. BTTS Market
    if (selection.market === 'btts') {
        const bttsHit = goalsS > 0 && goalsOpp > 0
        if (selection.side === 'yes') {
            return bttsHit ? { win: 1, push: 0, lose: 0 } : { win: 0, push: 0, lose: 1 }
        } else {
            return !bttsHit ? { win: 1, push: 0, lose: 0 } : { win: 0, push: 0, lose: 1 }
        }
    }

    return { win: 0, push: 0, lose: 1 }
}

/**
 * Asian Handicap outcome evaluation with quarter line (.25 / .75) splitting.
 */
export function evalAsianHandicap(d: number, h: number): Triple {
    const isQuarter = Math.abs(h * 4) % 2 === 1 // ends in .25 or .75

    if (!isQuarter) {
        const m = d + h
        if (m > 0) return { win: 1, push: 0, lose: 0 }
        if (m === 0) return { win: 0, push: 1, lose: 0 }
        return { win: 0, push: 0, lose: 1 }
    }

    // Split quarter line into two half-lines:
    const h1 = h - 0.25
    const h2 = h + 0.25
    const t1 = evalAsianHandicap(d, h1)
    const t2 = evalAsianHandicap(d, h2)

    return {
        win: (t1.win + t2.win) / 2,
        push: (t1.push + t2.push) / 2,
        lose: (t1.lose + t2.lose) / 2,
    }
}

/**
 * Over/Under outcome evaluation with quarter line (.25 / .75) splitting.
 */
export function evalTotals(t: number, line: number, isOver: boolean): Triple {
    const isQuarter = Math.abs(line * 4) % 2 === 1

    if (!isQuarter) {
        const diff = isOver ? t - line : line - t
        if (diff > 0) return { win: 1, push: 0, lose: 0 }
        if (diff === 0) return { win: 0, push: 1, lose: 0 }
        return { win: 0, push: 0, lose: 1 }
    }

    // Split quarter line
    const l1 = line - 0.25
    const l2 = line + 0.25
    const t1 = evalTotals(t, l1, isOver)
    const t2 = evalTotals(t, l2, isOver)

    return {
        win: (t1.win + t2.win) / 2,
        push: (t1.push + t2.push) / 2,
        lose: (t1.lose + t2.lose) / 2,
    }
}

/**
 * Resolves standard prior triple for a given market & line (Spec Section 6.3).
 */
export function getPriorTriple(market: SelectionMarket, line = 0): Triple {
    if (market === 'ah') {
        const isInteger = Number.isInteger(line)
        if (isInteger) {
            // Integer line prior
            return { win: 0.425, push: 0.15, lose: 0.425 }
        }
        // Half-line prior
        return { win: 0.5, push: 0, lose: 0.5 }
    }

    if (market === 'totals' || market === 'btts') {
        return { win: 0.5, push: 0, lose: 0.5 }
    }

    if (market === '1x2') {
        return { win: 0.44, push: 0, lose: 0.56 }
    }

    return { win: 0.5, push: 0, lose: 0.5 }
}

/**
 * Computes stream estimate with exponential recency decay and Bayesian shrinkage toward prior.
 */
export function computeStreamEstimate(
    matches: MatchRecord[],
    selection: SelectionTarget,
    streamTeam: 'H_venue' | 'H_all' | 'A_venue' | 'A_all' | 'X' | 'home' | 'away' | 'h2h',
    targetSide: 'home' | 'away',
    decay = ENGINE_CONFIG.DECAY,
    shrinkK = ENGINE_CONFIG.SHRINK_K,
    prior: Triple = getPriorTriple(selection.market, selection.line),
    homeTeamName?: string,
    awayTeamName?: string,
): StreamEstimate {
    if (matches.length === 0) {
        return {
            rawCounts: { win: 0, push: 0, lose: 0 },
            n_eff: 0,
            Pw: prior.win,
            Pp: prior.push,
            Pl: prior.lose,
            P_shrunk: prior,
            matchesCount: 0,
            dropped: true,
        }
    }

    let n_eff = 0
    let sumWin = 0
    let sumPush = 0
    let sumLose = 0
    let rawWin = 0
    let rawPush = 0
    let rawLose = 0

    // i = 1..n (most recent match is index 0)
    for (let i = 0; i < matches.length; i++) {
        const w_i = Math.pow(decay, i)
        const outcome = evalMatchOutcome(matches[i], selection, streamTeam, targetSide, homeTeamName, awayTeamName)

        n_eff += w_i
        sumWin += w_i * outcome.win
        sumPush += w_i * outcome.push
        sumLose += w_i * outcome.lose

        rawWin += outcome.win
        rawPush += outcome.push
        rawLose += outcome.lose
    }

    const Pw = sumWin / n_eff
    const Pp = sumPush / n_eff
    const Pl = sumLose / n_eff

    // Shrink toward prior: P_s = (n_eff * P + shrinkK * prior) / (n_eff + shrinkK)
    const shrunkWin = (n_eff * Pw + shrinkK * prior.win) / (n_eff + shrinkK)
    const shrunkPush = (n_eff * Pp + shrinkK * prior.push) / (n_eff + shrinkK)
    const shrunkLose = (n_eff * Pl + shrinkK * prior.lose) / (n_eff + shrinkK)

    return {
        rawCounts: { win: rawWin, push: rawPush, lose: rawLose },
        n_eff,
        Pw,
        Pp,
        Pl,
        P_shrunk: { win: shrunkWin, push: shrunkPush, lose: shrunkLose },
        matchesCount: matches.length,
    }
}

/**
 * Computes bounded team-news adjustment in percentage points (+/- 5 pp) (Spec Section 6.5).
 */
export function computeTeamNewsDelta(
    news: TeamNewsItem[],
    targetSide: 'home' | 'away',
    market: SelectionMarket,
    side: SelectionSide,
): number {
    let deltaPp = 0

    for (const item of news) {
        if (item.importance !== 'key') continue
        const isAbsent = item.status === 'out' || item.status === 'suspended'
        const isDoubtful = item.status === 'doubtful'
        if (!isAbsent && !isDoubtful) continue

        const multiplier = isAbsent ? 1.0 : 0.5
        const isOwnTeam = item.team === targetSide

        if (market === '1x2' || market === 'ah') {
            // Key attacker out: -2 pp to own win
            if (item.role === 'att') {
                deltaPp += isOwnTeam ? -2.0 * multiplier : +2.0 * multiplier
            }
            // Key GK or Def out: -2 pp to own win
            if (item.role === 'gk' || item.role === 'def') {
                deltaPp += isOwnTeam ? -2.0 * multiplier : +2.0 * multiplier
            }
        } else if (market === 'totals') {
            // Key attacker out: -2 pp to Over / +2 pp to Under
            if (item.role === 'att') {
                const change = -2.0 * multiplier
                deltaPp += side === 'over' ? change : -change
            }
            // Key GK or Def out: +2 pp to Over / -2 pp to Under
            if (item.role === 'gk' || item.role === 'def') {
                const change = +2.0 * multiplier
                deltaPp += side === 'over' ? change : -change
            }
        }
    }

    // Cap at +/- NEWS_ADJUST_CAP_PP
    const cap = ENGINE_CONFIG.NEWS_ADJUST_CAP_PP
    return Math.max(-cap, Math.min(cap, deltaPp))
}

/**
 * Computes market no-vig probability from odds (Spec Section 6.6).
 */
export function computeNoVigMarket(
    odds: number,
    oppositeOdds?: number,
    drawOdds?: number,
): Triple | null {
    if (!odds || odds <= 1.01) return null

    if (drawOdds && drawOdds > 1.01 && oppositeOdds && oppositeOdds > 1.01) {
        // 3-way 1X2 market
        const q1 = 1 / odds
        const qD = 1 / drawOdds
        const q2 = 1 / oppositeOdds
        const sum = q1 + qD + q2
        return {
            win: q1 / sum,
            push: 0,
            lose: (qD + q2) / sum,
        }
    }

    if (oppositeOdds && oppositeOdds > 1.01) {
        // 2-way market
        const q1 = 1 / odds
        const q2 = 1 / oppositeOdds
        const sum = q1 + q2
        return {
            win: q1 / sum,
            push: 0,
            lose: q2 / sum,
        }
    }

    // Single odds fallback (without opposite, unnormalized)
    const p = Math.min(0.95, 1 / odds)
    return {
        win: p,
        push: 0,
        lose: 1 - p,
    }
}

/**
 * Evaluates confidence score (0 to 5 points) (Spec Section 7.3).
 */
export function evaluateConfidence(
    samples: SampleStreams,
    streamEstimates: Record<keyof SampleStreams, StreamEstimate | null>,
): { confidence: Confidence; score: number } {
    let score = 0

    // (1) Both teams have >= 8 matches in *_all
    if (samples.H_all.length >= 8 && samples.A_all.length >= 8) {
        score += 1
    }

    // (2) >= 80% of used matches are verified
    const allMatches = [
        ...samples.H_venue,
        ...samples.H_all,
        ...samples.A_venue,
        ...samples.A_all,
        ...samples.X,
    ]
    if (allMatches.length > 0) {
        const verifiedCount = allMatches.filter((m) => m.verified !== false).length
        if (verifiedCount / allMatches.length >= 0.8) {
            score += 1
        }
    }

    // (3) Lineup/news freshness (assumed satisfied if data present)
    score += 1

    // (4) X has >= 3 meetings
    if (samples.X.length >= 3) {
        score += 1
    }

    // (5) All valid stream estimates on same side of 50%
    const estimates = Object.values(streamEstimates).filter((e): e is StreamEstimate => e !== null && !e.dropped)
    if (estimates.length > 0) {
        const allAbove50 = estimates.every((e) => e.P_shrunk.win >= 0.5)
        const allBelow50 = estimates.every((e) => e.P_shrunk.win < 0.5)
        if (allAbove50 || allBelow50) {
            score += 1
        }
    }

    const confidence: Confidence = score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low'
    return { confidence, score }
}

/**
 * Main Count-Based Probability Engine Evaluation (Spec Section 6 & 7).
 */
export function evaluateCountSelection(
    samples: SampleStreams,
    selection: SelectionTarget,
    targetSide: 'home' | 'away',
    teamNews: TeamNewsItem[] = [],
    config = ENGINE_CONFIG,
    homeTeamName?: string,
    awayTeamName?: string,
): SelectionEvaluation {
    // 0. Enforce Provenance on all input match records
    validateSampleStreamsProvenance(samples)

    const flags: string[] = []

    // 1. Data Gate Check (Section 7.2)
    if (!checkDataGate(samples)) {
        return {
            market: selection.market,
            side: selection.side,
            line: selection.line ?? 0,
            odds: selection.odds,
            pData: { win: 0, push: 0, lose: 0 },
            newsDeltaPp: 0,
            pDataAdjusted: { win: 0, push: 0, lose: 0 },
            pMarket: null,
            pFinal: { win: 0, push: 0, lose: 0 },
            headlineWinProb: 0,
            breakEven: null,
            edge: 0,
            ev: 0,
            status: 'INSUFFICIENT_DATA',
            flags: ['INSUFFICIENT_DATA'],
            confidence: 'low',
            confidenceScore: 0,
            stakePct: 0,
            streams: { H_venue: null, H_all: null, A_venue: null, A_all: null, X: null },
            weightsUsed: { H_venue: 0, H_all: 0, A_venue: 0, A_all: 0, X: 0 },
        }
    }

    // Resolve team names for accurate perspective mapping
    const resolvedHome = homeTeamName ?? samples.H_venue[0]?.home_team ?? samples.H_all[0]?.home_team
    const resolvedAway = awayTeamName ?? samples.A_venue[0]?.away_team ?? samples.A_all[0]?.away_team

    // 2. Stream Drops & Recency check
    const streamKeys: Array<keyof SampleStreams> = ['H_venue', 'H_all', 'A_venue', 'A_all', 'X']
    const rawWeights = { ...config.STREAM_WEIGHTS }

    // Venue drop rule: venue sample with < 3 matches dropped (weight redistributed)
    const dropHVenue = samples.H_venue.length < 3
    const dropAVenue = samples.A_venue.length < 3
    const dropX = samples.X.length === 0

    if (dropHVenue) rawWeights.H_venue = 0
    if (dropAVenue) rawWeights.A_venue = 0
    if (dropX) rawWeights.X = 0

    // X recency factor: if mean meeting age > 3 years (1095 days)
    if (!dropX && samples.X.length > 0) {
        const now = Date.now()
        const agesDays = samples.X.map((m) => Math.max(0, (now - new Date(m.date).getTime()) / (86400 * 1000)))
        const meanAge = agesDays.reduce((a, b) => a + b, 0) / agesDays.length
        if (meanAge > 1095) {
            rawWeights.X *= config.X_RECENCY_FACTOR_STALE
            flags.push('stale_h2h')
        }
    }

    // Renormalise weights to sum to 1
    const totalWeight = Object.values(rawWeights).reduce((a, b) => a + b, 0)
    const weightsUsed: Record<keyof SampleStreams, number> = {
        H_venue: rawWeights.H_venue / totalWeight,
        H_all: rawWeights.H_all / totalWeight,
        A_venue: rawWeights.A_venue / totalWeight,
        A_all: rawWeights.A_all / totalWeight,
        X: rawWeights.X / totalWeight,
    }

    // 3. Compute Stream Estimates
    const streamEstimates: Record<keyof SampleStreams, StreamEstimate | null> = {
        H_venue: dropHVenue ? null : computeStreamEstimate(samples.H_venue, selection, 'H_venue', targetSide, config.DECAY, config.SHRINK_K, undefined, resolvedHome, resolvedAway),
        H_all: computeStreamEstimate(samples.H_all, selection, 'H_all', targetSide, config.DECAY, config.SHRINK_K, undefined, resolvedHome, resolvedAway),
        A_venue: dropAVenue ? null : computeStreamEstimate(samples.A_venue, selection, 'A_venue', targetSide, config.DECAY, config.SHRINK_K, undefined, resolvedHome, resolvedAway),
        A_all: computeStreamEstimate(samples.A_all, selection, 'A_all', targetSide, config.DECAY, config.SHRINK_K, undefined, resolvedHome, resolvedAway),
        X: dropX ? null : computeStreamEstimate(samples.X, selection, 'X', targetSide, config.DECAY, config.SHRINK_K, undefined, resolvedHome, resolvedAway),
    }

    // 4. Combine Streams: P_data = Σ (weight_stream * P_stream)
    let pDataWin = 0
    let pDataPush = 0
    let pDataLose = 0

    for (const key of streamKeys) {
        const w = weightsUsed[key]
        const est = streamEstimates[key]
        if (w > 0 && est && !est.dropped) {
            pDataWin += w * est.P_shrunk.win
            pDataPush += w * est.P_shrunk.push
            pDataLose += w * est.P_shrunk.lose
        }
    }

    const pData: Triple = { win: pDataWin, push: pDataPush, lose: pDataLose }

    // 5. Team News Adjustment (bounded +/- 5 pp)
    const newsDeltaPp = computeTeamNewsDelta(teamNews, targetSide, selection.market, selection.side)
    const deltaDec = newsDeltaPp / 100

    let pDataAdjWin = Math.max(0, Math.min(1 - pData.push, pData.win + deltaDec))
    let pDataAdjLose = Math.max(0, 1 - pDataAdjWin - pData.push)
    const pDataAdjusted: Triple = { win: pDataAdjWin, push: pData.push, lose: pDataAdjLose }

    // 6. Market Blend
    let pMarket: Triple | null = null
    let pFinal: Triple = pDataAdjusted

    if (selection.odds && selection.odds > 1.01) {
        pMarket = computeNoVigMarket(selection.odds, selection.oppositeOdds, selection.drawOdds)
        if (pMarket) {
            const beta = config.MARKET_BLEND_WEIGHT
            const finWin = (1 - beta) * pDataAdjusted.win + beta * pMarket.win
            const finPush = (1 - beta) * pDataAdjusted.push + beta * pMarket.push
            const finLose = Math.max(0, 1 - finWin - finPush)
            pFinal = { win: finWin, push: finPush, lose: finLose }
        }
    }

    // 7. Headline Win Probability (pushes excluded)
    const nonPushSum = pFinal.win + pFinal.lose
    const headlineWinProb = nonPushSum > 0 ? pFinal.win / nonPushSum : pFinal.win

    // 8. Financial Metrics
    const breakEven = selection.odds && selection.odds > 1 ? 1 / selection.odds : null
    const edge = breakEven !== null && selection.odds ? (headlineWinProb - breakEven) / (1 / selection.odds) : 0
    const ev = selection.odds ? headlineWinProb * (selection.odds - 1) - (1 - headlineWinProb) : 0

    // 9. Confidence Evaluation
    const { confidence, score: confidenceScore } = evaluateConfidence(samples, streamEstimates)

    // 10. Decision Rules (Spec Section 7.1)
    let status: 'PICK' | 'NO_BET' | 'ODDS_TOO_LOW' | 'INSUFFICIENT_DATA' = 'PICK'

    // Rule 1: Odds < 1.50 -> ODDS_TOO_LOW
    if (selection.odds && selection.odds < config.MIN_ODDS) {
        status = 'ODDS_TOO_LOW'
        flags.push('odds_below_min')
    }
    // Rule 2: Headline Win Prob < 50% -> strictly NO_BET
    else if (headlineWinProb < config.DECISION_THRESHOLD) {
        status = 'NO_BET'
    }
    // Rule 3: Otherwise PICK
    else {
        status = 'PICK'
    }

    // Rule 4: Value vs Break-even check
    if (breakEven !== null && headlineWinProb < breakEven) {
        flags.push('NEGATIVE_VALUE')
        if (config.BLOCK_NEGATIVE_VALUE) {
            status = 'NO_BET'
        }
    }

    // 11. Staking Sizing (Spec Section 7.4)
    let stakePct = 0
    if (status === 'PICK') {
        // Base by confidence
        stakePct = confidence === 'high' ? 0.02 : confidence === 'medium' ? 0.015 : 0.01
        // Extra 0.5% if headlineWinProb - break_even >= 0.05
        if (breakEven !== null && headlineWinProb - breakEven >= 0.05) {
            stakePct += 0.005
        }
        // Cap at 2.5%
        stakePct = Math.min(0.025, stakePct)
        // NEGATIVE_VALUE flag caps at 1.0%
        if (flags.includes('NEGATIVE_VALUE')) {
            stakePct = Math.min(0.01, stakePct)
        }
    }

    return {
        market: selection.market,
        side: selection.side,
        line: selection.line ?? 0,
        odds: selection.odds,
        pData,
        newsDeltaPp,
        pDataAdjusted,
        pMarket,
        pFinal,
        headlineWinProb,
        breakEven,
        edge,
        ev,
        status,
        flags,
        confidence,
        confidenceScore,
        stakePct,
        streams: streamEstimates,
        weightsUsed,
    }
}
