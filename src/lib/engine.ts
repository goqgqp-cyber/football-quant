import type {
    AnalysisResult,
    Confidence,
    MatchData,
    OddsLine,
    Pick,
    Triple,
} from './types'
import { clamp } from './math'
import { estimateLambdas, scoreMatrix, inPlayScoreMatrix, topScorelines, DEFAULT_LG_HOME, DEFAULT_LG_AWAY } from './poisson'
import { tripleFor } from './markets'

export interface InPlayOptions {
    isLive?: boolean
    currentMinute?: number | null
    currentScore?: { home: number; away: number } | null
}

// ---- Ngưỡng lọc theo spec ----
export const MIN_ODDS = 1.5
export const MIN_EDGE = 0.05
export const MAX_MARKET_DELTA = 0.15 // 15 điểm %
export const STAK_MIN = 0.01
export const STAK_MAX = 0.025
export const KELLY_FRACTION = 0.25

/**
 * P_implied = 1 / odds
 */
export function pImplied(odds: number): number {
    return 1 / odds
}

/**
 * Loại vig khi có đủ 2 đầu (ví dụ Over + Under cùng mốc, hoặc AH cả 2 bên).
 * Trả về xác suất đã chuẩn hoá cho phía `side` (null nếu thiếu đầu đối).
 */
export function pImpliedNoVig(odds: number, oppositeOdds: number | null): number | null {
    const p = pImplied(odds)
    if (oppositeOdds == null || !Number.isFinite(oppositeOdds)) return null
    const q = pImplied(oppositeOdds)
    const total = p + q
    if (total <= 0) return null
    return p / total
}

/**
 * EV = P_thắng*(odds-1) - P_thua  (theo spec, dùng xác suất mô hình)
 * Edge = EV / odds
 */
export function evAndEdge(triple: Triple, odds: number): { ev: number; edge: number } {
    const ev = triple.win * (odds - 1) - triple.lose
    const edge = ev / odds
    return { ev, edge }
}

/**
 * Điểm tin cậy:
 *  +1 nếu n >= 8
 *  +1 nếu có >= 2 nguồn
 *  +1 nếu lệch thị trường <= 7%
 * 3 = Cao, 2 = Trung bình, còn lại Thấp
 */
export function confidenceScore(n: number, sourceCount: number, marketDelta: number): Confidence {
    let score = 0
    if (n >= 8) score += 1
    if (sourceCount >= 2) score += 1
    if (marketDelta <= 0.07) score += 1
    if (score === 3) return 'high'
    if (score === 2) return 'medium'
    return 'low'
}

/**
 * 25% Kelly, chặn trong [1.0%, 2.5%] tổng vốn.
 * Tin cậy Thấp -> 1.0%.
 */
export function stakePct(
    triple: Triple,
    odds: number,
    confidence: Confidence,
): number {
    let kelly = 0
    if (odds > 1) {
        const b = odds - 1
        kelly = (b * triple.win - triple.lose) / b
    }
    const stake = KELLY_FRACTION * Math.max(0, kelly)
    let pct = clamp(stake, STAK_MIN, STAK_MAX)
    if (confidence === 'low') pct = STAK_MIN
    return pct
}

/** Tìm odds đối diện cùng mốc để loại vig. */
function findOpposite(oddsLines: OddsLine[], line: OddsLine): number | null {
    const same = oddsLines.filter((o) => o.kind === line.kind && Math.abs(o.line - line.line) < 1e-9)
    let opp: OddsLine | undefined
    if (line.kind === 'totals') {
        opp = same.find((o) => o.side === (line.side === 'over' ? 'under' : 'over'))
    } else {
        opp = same.find((o) => o.side === (line.side === 'home' ? 'away' : 'home'))
    }
    return opp ? opp.odds : null
}

/**
 * Phân tích đầy đủ một trận.
 * Hỗ trợ in-play Poisson decay khi trận đang đá (isLive = true & currentMinute > 0).
 */
export function analyzeMatch(
    data: MatchData,
    oddsLines: OddsLine[],
    lgHome = DEFAULT_LG_HOME,
    lgAway = DEFAULT_LG_AWAY,
    inPlay?: InPlayOptions,
): AnalysisResult {
    const { lambdaHome: baseLambdaHome, lambdaAway: baseLambdaAway } = estimateLambdas(data, lgHome, lgAway)

    let lambdaHome = baseLambdaHome
    let lambdaAway = baseLambdaAway
    let matrix: number[][]

    // In-play time decay logic:
    if (inPlay?.isLive && inPlay.currentMinute != null && inPlay.currentMinute > 0) {
        const curScore = inPlay.currentScore ?? { home: 0, away: 0 }
        const decayed = inPlayScoreMatrix(baseLambdaHome, baseLambdaAway, inPlay.currentMinute, curScore)
        matrix = decayed.matrix
        lambdaHome = decayed.lambdaRemHome
        lambdaAway = decayed.lambdaRemAway
    } else {
        matrix = scoreMatrix(baseLambdaHome, baseLambdaAway)
    }

    // Gán odds đối diện để loại vig
    const picks: Pick[] = []
    const sourceCount = data.sources.length
    const n = Math.min(data.home.n, data.away.n)

    for (const line of oddsLines) {
        const opposite = findOpposite(oddsLines, line)
        const triple = tripleFor(matrix, line.kind, line.line, line.side)
        const { ev, edge } = evAndEdge(triple, line.odds)
        const imp = pImplied(line.odds)
        const impNoVig = pImpliedNoVig(line.odds, opposite)
        const marketDelta = Math.abs(triple.win - imp)

        const flags: string[] = []
        if (line.odds < MIN_ODDS) flags.push('odds_below_min')
        if (edge < MIN_EDGE) flags.push('edge_below_min')
        if (ev <= 0) flags.push('ev_non_positive')
        if (marketDelta > MAX_MARKET_DELTA) flags.push('model_disagreement')

        const confidence = confidenceScore(n, sourceCount, marketDelta)
        if (edge < 0 && line.odds >= 2.0) flags.push('trap_high_odds_negative_edge')

        let status: Pick['status'] = 'rejected'
        if (
            line.odds >= MIN_ODDS &&
            edge >= MIN_EDGE &&
            ev > 0 &&
            marketDelta <= MAX_MARKET_DELTA &&
            confidence !== 'low'
        ) {
            status = 'value'
        } else if (flags.includes('trap_high_odds_negative_edge')) {
            status = 'trap'
        }


        const stake = stakePct(triple, line.odds, confidence)
        const compositeScore = Number(((ev * 0.6) + (edge * 0.4)).toFixed(4))

        picks.push({
            oddsLineId: line.id,
            kind: line.kind,
            side: line.side,
            line: line.line,
            odds: line.odds,
            pWin: triple.win,
            pPush: triple.push,
            pLose: triple.lose,
            pImplied: imp,
            pImpliedNoVig: impNoVig,
            edge,
            ev,
            compositeScore,
            confidence,
            stakePct: stake,
            status,
            flags,
            marketDelta,
        })
    }

    // 1. Sắp xếp toàn bộ kèo theo Composite Score: (EV * 0.6) + (Edge * 0.4) giảm dần
    picks.sort((a, b) => (b.compositeScore ?? 0) - (a.compositeScore ?? 0))

    // 2. BẮT BUỘC ĐƯA RA KÈO TỐI ƯU (ELIMINATE NO BET):
    // Luôn chọn Top 1 Value và Top 2 Dự phòng bất kể ngưỡng Edge bảo thủ có bị cản bởi biên nhà cái
    if (picks.length > 0) {
        // Top 1: Kèo tối ưu nhất
        const p1 = picks[0]
        p1.rankLabel = '[KÈO TỐI ƯU NHẤT - TOP 1 VALUE]'
        if (p1.status !== 'trap') {
            p1.status = 'value'
        }
        // Đề xuất vốn Kelly từ 2% đến 5%
        p1.stakePct = p1.stakePct > 0 ? Math.min(0.05, Math.max(0.02, p1.stakePct)) : 0.03

        // Top 2: Kèo dự phòng (nếu có từ 2 kèo trở lên)
        if (picks.length > 1) {
            const p2 = picks[1]
            p2.rankLabel = '[KÈO DỰ PHÒNG - TOP 2]'
            if (p2.status !== 'trap') {
                p2.status = 'value'
            }
            p2.stakePct = p2.stakePct > 0 ? Math.min(0.04, Math.max(0.02, p2.stakePct)) : 0.02
        }
    }

    const noBetReasons: string[] = []
    if (oddsLines.length === 0) {
        noBetReasons.push('Chưa nhập kèo nào để phân tích.')
    }

    return {
        lambdaHome,
        lambdaAway,
        matrix,
        topScorelines: topScorelines(matrix, 5),
        picks,
        noBet: oddsLines.length === 0,
        noBetReasons,
    }
}

/** Gợi ý mốc kèo phổ biến để điền nhanh trong form (G1). */
export function suggestedLines(): OddsLine[] {
    return [
        { id: 't25', kind: 'totals', side: 'over', line: 2.5, odds: 1.95 },
        { id: 't25u', kind: 'totals', side: 'under', line: 2.5, odds: 1.95 },
        { id: 't30', kind: 'totals', side: 'over', line: 3.0, odds: 2.10 },
        { id: 't30u', kind: 'totals', side: 'under', line: 3.0, odds: 1.80 },
        { id: 'ahh0', kind: 'ah', side: 'home', line: 0, odds: 1.90 },
        { id: 'aha0', kind: 'ah', side: 'away', line: 0, odds: 1.90 },
        { id: 'ahh05', kind: 'ah', side: 'home', line: -0.5, odds: 2.00 },
        { id: 'aha05', kind: 'ah', side: 'away', line: -0.5, odds: 1.80 },
        { id: 'ahh025', kind: 'ah', side: 'home', line: -0.25, odds: 1.75 },
        { id: 'aha025', kind: 'ah', side: 'away', line: -0.25, odds: 2.05 },
    ]
}

/**
 * Lọc các pick đạt chuẩn khuyến nghị để lưu lịch sử & hiển thị:
 * - BẮT BUỘC trả về Top 1 và Top 2 (Top 1 Value & Top 2 Dự phòng)
 * - Sắp xếp theo compositeScore giảm dần
 */
export function filterRecommendedPicks(picks: Pick[]): Pick[] {
    if (picks.length === 0) return []
    const topPicks = picks.filter((p) => p.rankLabel)
    if (topPicks.length > 0) return topPicks.slice(0, 2)
    const valuePicks = picks.filter((p) => p.status === 'value')
    if (valuePicks.length > 0) return valuePicks.slice(0, 2)
    return picks.slice(0, 2)
}