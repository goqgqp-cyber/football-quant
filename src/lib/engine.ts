import type {
    AnalysisResult,
    Confidence,
    MatchData,
    OddsLine,
    Pick,
    Triple,
} from './types'
import { clamp } from './math'
import {
    estimateLambdas,
    impliedLambdas,
    blendLambdas,
    scoreMatrix,
    inPlayScoreMatrix,
    topScorelines,
    DEFAULT_LG_HOME,
    DEFAULT_LG_AWAY,
} from './poisson'
import { tripleFor } from './markets'
import { solveRecommendedPicks, filterRecommendedPicks } from './quant/solver'
import { validateSampleStreamsProvenance } from './engine/count-engine'
export { filterRecommendedPicks }


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
    if (line.kind === 'totals') {
        const opp = oddsLines.find(
            (o) => o.kind === 'totals' && Math.abs(o.line - line.line) < 1e-6 && o.side !== line.side,
        )
        return opp ? opp.odds : null
    }

    const opp = oddsLines.find(
        (o) =>
            o.kind === 'ah' &&
            (Math.abs(o.line - line.line) < 1e-6 || Math.abs(o.line + line.line) < 1e-6) &&
            o.side !== line.side,
    )
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
    // 0. HARD ENFORCEMENT: Xác thực Provenance nếu có matchRecords truyền vào
    if (data.matchRecords) {
        if (data.matchRecords.home) validateSampleStreamsProvenance(data.matchRecords.home)
        if (data.matchRecords.away) validateSampleStreamsProvenance(data.matchRecords.away)
        if (data.matchRecords.h2h) validateSampleStreamsProvenance(data.matchRecords.h2h)
    }

    const homeN = data.matchRecords?.home ? data.matchRecords.home.length : (data.home?.n ?? 0)
    const awayN = data.matchRecords?.away ? data.matchRecords.away.length : (data.away?.n ?? 0)
    const h2hN = data.matchRecords?.h2h ? data.matchRecords.h2h.length : (data.h2h?.n ?? 0)

    // HARD ENFORCEMENT 1: DATA_UNAVAILABLE
    // Nếu tất cả provider thất bại hoặc không có nguồn dữ liệu nào thu thập được
    const isDataUnavailable =
        data.origin === 'failed' ||
        (homeN === 0 && awayN === 0 && (!data.sources || data.sources.length === 0)) ||
        (data.missing && data.missing.includes('all_providers_failed'))

    if (isDataUnavailable) {
        return {
            status: 'DATA_UNAVAILABLE',
            dataGatePassed: false,
            dataCounts: {
                homeMatches: homeN,
                awayMatches: awayN,
                h2hMatches: h2hN,
            },
            fixtureIdentity: data.fixtureIdentity,
            providerSummaries: data.providerSummaries,
            callLogs: data.callLogs,
            webSearchSummary: data.webSearchSummary,
            lambdaHome: 0,
            lambdaAway: 0,
            matrix: [],
            topScorelines: [],
            picks: [],
            noBet: true,
            noBetReasons: ['Dữ liệu không khả dụng: Các nhà cung cấp đều thất bại hoặc trả về rỗng.'],
        }
    }

    // CỔNG DỮ LIỆU (DATA GATE) & LOW-DATA PIPELINE:
    // Đánh giá dữ liệu có đạt chuẩn tối thiểu 5 trận/đội hay không.
    // NGUYÊN TẮC QUANT: Khi dữ liệu thấp (homeN < 5 hoặc awayN < 5), TUYỆT ĐỐI KHÔNG DỪNG PIPELINE.
    // Chuyển sang chế độ Market-Anchored Low-Data Pipeline:
    // - Neo 85% vào tỷ lệ thị trường (w = 0.15) và giá trị nền giải đấu (LG_HOME: 1.45, LG_AWAY: 1.15).
    // - Gắn nhãn badge "Tin cậy Thấp (low_data)".
    // - Hoàn tất đầy đủ 4 bước (Thu thập -> Trích xuất -> Tính toán -> Diễn giải).
    const isLowData = homeN < 5 || awayN < 5
    const dataGatePassed = !isLowData

    // Bước 1: λ theo dữ liệu đội
    const { lambdaHome: modelLambdaHome, lambdaAway: modelLambdaAway } = estimateLambdas(data, lgHome, lgAway)
    const lambdaModel = { home: modelLambdaHome, away: modelLambdaAway }

    // Bước 2: λ ngầm định từ thị trường (loại vig)
    const marketResult = impliedLambdas(oddsLines, lgHome, lgAway)
    const hasMarketOdds = marketResult.hasMarketOu || marketResult.hasMarketAh
    const lambdaMarket = hasMarketOdds
        ? { home: marketResult.lambdaHome, away: marketResult.lambdaAway }
        : null

    // Bước 3: Trộn mô hình và thị trường (w theo chất lượng dữ liệu)
    const sourceCount = data.sources.length
    const n = Math.min(data.home.n, data.away.n)
    const lineupConfirmed = data.home.lineup_confirmed === true && data.away.lineup_confirmed === true
    let blended = blendLambdas(
        lambdaModel,
        lambdaMarket,
        { n, sourceCount, lineupConfirmed },
        hasMarketOdds,
    )

    // Dữ liệu thấp (< 5 trận/đội): Enforce neo 85% thị trường (w = 0.15)
    if (isLowData) {
        const wLow = 0.15
        if (hasMarketOdds && lambdaMarket) {
            blended = {
                lambdaHome: Math.max(0.15, Number((wLow * lambdaModel.home + (1 - wLow) * lambdaMarket.home).toFixed(4))),
                lambdaAway: Math.max(0.15, Number((wLow * lambdaModel.away + (1 - wLow) * lambdaMarket.away).toFixed(4))),
                w: wLow,
                reason: `Dữ liệu mẫu hạn chế (Nhà: ${homeN} trận, Khách: ${awayN} trận < 5): Neo 85% vào tỷ lệ thị trường & giải đấu (w = 0.15).`,
            }
        } else {
            blended = {
                lambdaHome: lambdaModel.home,
                lambdaAway: lambdaModel.away,
                w: wLow,
                reason: `Dữ liệu mẫu hạn chế (Nhà: ${homeN} trận, Khách: ${awayN} trận < 5) & thiếu odds 2 đầu: Dùng baseline giải đấu (LG_HOME: ${lgHome}, LG_AWAY: ${lgAway}).`,
            }
        }
    }

    let lambdaHome = blended.lambdaHome
    let lambdaAway = blended.lambdaAway
    let matrix: number[][]

    // In-play time decay logic:
    if (inPlay?.isLive && inPlay.currentMinute != null && inPlay.currentMinute > 0) {
        const curScore = inPlay.currentScore ?? { home: 0, away: 0 }
        const decayed = inPlayScoreMatrix(blended.lambdaHome, blended.lambdaAway, inPlay.currentMinute, curScore)
        matrix = decayed.matrix
        lambdaHome = Math.max(0.08, decayed.lambdaRemHome)
        lambdaAway = Math.max(0.08, decayed.lambdaRemAway)
    } else {
        // Bước 4: Ma trận Dixon-Coles rho=-0.08 từ lambda_final
        matrix = scoreMatrix(blended.lambdaHome, blended.lambdaAway)
    }

    // Gán odds đối diện để loại vig
    const picks: Pick[] = []

    for (const line of oddsLines) {
        const opposite = findOpposite(oddsLines, line)
        const rawTriple = tripleFor(matrix, line.kind, line.line, line.side)
        const { edge: rawEdge } = evAndEdge(rawTriple, line.odds)

        // HARD SANITY CAP (ABSOLUTE BAN ON 100.0% WIN RATES):
        // 1. Khóa trần xác suất thắng trong khoảng [22%, 78%] (tuyệt đối không để 100%)
        const finalWinProb = Math.min(0.78, Math.max(0.22, rawTriple.win))
        // 2. Khóa trần Edge trong khoảng [-20%, 15%]
        const finalEdge = Math.min(0.15, Math.max(-0.20, rawEdge))
        // 3. Tính toán lại EV theo xác suất chuẩn: (finalWinProb * odds) - 1
        const finalEV = Number(((finalWinProb * line.odds) - 1).toFixed(3))

        const finalPush = rawTriple.push
        const finalLose = Math.max(0, 1 - finalWinProb - finalPush)

        const triple: Triple = {
            win: finalWinProb,
            push: finalPush,
            lose: finalLose,
        }
        const ev = finalEV
        const edge = finalEdge
        const imp = pImplied(line.odds)
        const impNoVig = pImpliedNoVig(line.odds, opposite)
        const marketDelta = Math.abs(triple.win - imp)

        const nonPush = triple.win + triple.lose
        const headlineWinProb = nonPush > 0 ? triple.win / nonPush : triple.win
        const breakEven = line.odds > 1 ? 1 / line.odds : null

        const flags: string[] = []
        if (line.odds < MIN_ODDS) flags.push('odds_below_min')
        if (edge < MIN_EDGE) flags.push('edge_below_min')
        if (ev <= 0) flags.push('ev_non_positive')
        if (marketDelta > MAX_MARKET_DELTA) flags.push('model_disagreement')
        if (edge > 0.15) flags.push('suspicious_edge')
        if (blended.w === 0.15 || isLowData) flags.push('low_data')
        if (breakEven !== null && headlineWinProb < breakEven) flags.push('NEGATIVE_VALUE')
        if (headlineWinProb < 0.50) flags.push('prob_below_50')

        const confidence = isLowData ? 'low' : confidenceScore(n, sourceCount, marketDelta)
        if (edge < 0 && line.odds >= 2.0) flags.push('trap_high_odds_negative_edge')

        let status: Pick['status'] = 'rejected'
        if (
            line.odds >= MIN_ODDS &&
            edge >= MIN_EDGE &&
            ev > 0 &&
            marketDelta <= MAX_MARKET_DELTA &&
            confidence !== 'low' &&
            !flags.includes('suspicious_edge')
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
            period: line.period,
            object: line.object,
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
            headlineWinProb,
            breakEven,
            pData: triple,
            pMarket: impNoVig != null ? { win: impNoVig, push: 0, lose: 1 - impNoVig } : null,
            pFinal: triple,
        })
    }

    // 1 & 2: Giải toán xếp hạng đề xuất (Top 1 Value & Top 2 Dự phòng)
    // Loại trừ triệt để kèo đối lập, áp trần chất lượng Edge >= 5% và EV > 0 cho Pick #2
    solveRecommendedPicks(picks)


    const noBetReasons: string[] = []
    if (oddsLines.length === 0) {
        noBetReasons.push('Chưa nhập kèo nào để phân tích.')
    }

    return {
        status: 'SUCCESS',
        dataGatePassed,
        dataCounts: {
            homeMatches: homeN,
            awayMatches: awayN,
            h2hMatches: h2hN,
        },
        fixtureIdentity: data.fixtureIdentity,
        providerSummaries: data.providerSummaries,
        callLogs: data.callLogs,
        webSearchSummary: data.webSearchSummary,
        lambdaHome,
        lambdaAway,
        lambdaModel,
        lambdaMarket: lambdaMarket ?? undefined,
        weightModel: blended.w,
        blendReason: blended.reason,
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
