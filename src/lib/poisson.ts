import type { MatchData, OddsLine } from './types'
import { poissonPmf, shrink, normalize } from './math'
import { totalsTriple, ahTriple } from './markets'

/** Tham số mặc định của giải (chỉnh được theo giải). */
export const DEFAULT_LG_HOME = 1.45
export const DEFAULT_LG_AWAY = 1.15

/** Hệ số làm mịn k */
export const SHRINK_K = 5

/** rho hiệu chỉnh Dixon-Coles */
export const DC_RHO = -0.08

/** Kích thước ma trận tỉ số: 0..10 */
export const MAX_GOALS = 10

/** Tỷ lệ bàn thắng trung bình Hiệp 1 so với cả trận (~44% tổng số bàn thắng). */
export const FIRST_HALF_RATIO = 0.44

/**
 * Tính số bàn kỳ vọng λ cho Hiệp 1 dựa trên trọng số 44%.
 */
export function firstHalfLambdas(
    lambdaHome: number,
    lambdaAway: number,
    ratio = FIRST_HALF_RATIO,
): { lambdaHome: number; lambdaAway: number } {
    return {
        lambdaHome: Math.max(0.15 * ratio, Number((lambdaHome * ratio).toFixed(4))),
        lambdaAway: Math.max(0.15 * ratio, Number((lambdaAway * ratio).toFixed(4))),
    }
}

/**
 * Ước lượng λ (số bàn kỳ vọng) cho hai đội theo công thức trong spec:
 *   lg_avg = (lg_home + lg_away) / 2
 *   λ_home = lg_home * (shr(home.xgf)/lg_avg) * (shr(away.xga)/lg_avg)
 *   λ_away = lg_away * (shr(away.xgf)/lg_avg) * (shr(home.xga)/lg_avg)
 *
 * xgf/xga ưu tiên; nếu null thì dùng goals_for/goals_against; nếu cả hai null
 * thì shrink() sẽ trả về lg_avg (tức trung tính).
 * Luôn clamp sàn tối thiểu lambda >= 0.15 để tránh triệt tiêu xác suất.
 */
export function estimateLambdas(
    data: MatchData,
    lgHome = DEFAULT_LG_HOME,
    lgAway = DEFAULT_LG_AWAY,
): { lambdaHome: number; lambdaAway: number; lgAvg: number } {
    const lgAvg = (lgHome + lgAway) / 2

    const homeAtt = data.home.xgf ?? data.home.goals_for
    const homeDef = data.home.xga ?? data.home.goals_against
    const awayAtt = data.away.xgf ?? data.away.goals_for
    const awayDef = data.away.xga ?? data.away.goals_against

    const sHomeAtt = shrink(homeAtt, data.home.n, lgAvg, SHRINK_K)
    const sHomeDef = shrink(homeDef, data.home.n, lgAvg, SHRINK_K)
    const sAwayAtt = shrink(awayAtt, data.away.n, lgAvg, SHRINK_K)
    const sAwayDef = shrink(awayDef, data.away.n, lgAvg, SHRINK_K)

    const rawLambdaHome = lgHome * (sHomeAtt / lgAvg) * (sAwayDef / lgAvg)
    const rawLambdaAway = lgAway * (sAwayAtt / lgAvg) * (sHomeDef / lgAvg)

    const lambdaHome = Math.max(0.15, Number(rawLambdaHome.toFixed(4)))
    const lambdaAway = Math.max(0.15, Number(rawLambdaAway.toFixed(4)))

    return { lambdaHome, lambdaAway, lgAvg }
}

/**
 * Hệ số hiệu chỉnh Dixon-Coles cho các tỉ số thấp.
 */
export function dcTau(x: number, y: number, lambda: number, mu: number, rho = DC_RHO): number {
    if (x === 0 && y === 0) return 1 - lambda * mu * rho
    if (x === 0 && y === 1) return 1 + lambda * rho
    if (x === 1 && y === 0) return 1 + mu * rho
    if (x === 1 && y === 1) return 1 - rho
    return 1
}

/**
 * Ma trận tỉ số Poisson độc lập có nhân Dixon-Coles, chuẩn hoá tổng = 1.
 * matrix[i][j] = P(đội nhà ghi i, đội khách ghi j).
 */
export function scoreMatrix(lambdaHome: number, lambdaAway: number, rho = DC_RHO): number[][] {
    const homePmf: number[] = []
    const awayPmf: number[] = []
    for (let i = 0; i <= MAX_GOALS; i++) {
        homePmf.push(poissonPmf(i, lambdaHome))
        awayPmf.push(poissonPmf(i, lambdaAway))
    }

    const raw: number[][] = []
    for (let i = 0; i <= MAX_GOALS; i++) {
        const row: number[] = []
        for (let j = 0; j <= MAX_GOALS; j++) {
            const tau = dcTau(i, j, lambdaHome, lambdaAway, rho)
            row.push(homePmf[i] * awayPmf[j] * tau)
        }
        raw.push(row)
    }

    // Chuẩn hoá toàn ma trận về tổng = 1
    const flat = raw.flat()
    const normFlat = normalize(flat)
    const out: number[][] = []
    let k = 0
    for (let i = 0; i <= MAX_GOALS; i++) {
        const row: number[] = []
        for (let j = 0; j <= MAX_GOALS; j++) {
            row.push(normFlat[k++])
        }
        out.push(row)
    }
    return out
}

/** Top N tỉ số khả dĩ nhất từ ma trận. */
export function topScorelines(
    matrix: number[][],
    n = 5,
): { score: string; p: number }[] {
    const items: { score: string; p: number }[] = []
    for (let i = 0; i < matrix.length; i++) {
        for (let j = 0; j < matrix[i].length; j++) {
            items.push({ score: `${i}-${j}`, p: matrix[i][j] })
        }
    }
    items.sort((a, b) => b.p - a.p)
    return items.slice(0, n)
}

/**
 * Tính ma trận phân phối tỉ số trong trận (In-play Poisson Decay):
 * - decayFactor = Math.max(0, (90 - currentMinute) / 90)
 * - lambda_remaining = lambda_baseline * decayFactor
 * - Simulate remaining score distribution using Dixon-Coles (rho = -0.08)
 * - Neo tỉ số cuối cùng vào tỉ số hiện tại:
 *   Final_Score_Home = currentScore.home + Simulated_Remaining_Home
 *   Final_Score_Away = currentScore.away + Simulated_Remaining_Away
 */
export function inPlayScoreMatrix(
    lambdaHome: number,
    lambdaAway: number,
    currentMinute: number,
    currentScore: { home: number; away: number },
    rho = DC_RHO,
): { matrix: number[][]; lambdaRemHome: number; lambdaRemAway: number; decayFactor: number } {
    const decayFactor = Math.max(0, (90 - currentMinute) / 90)
    const lambdaRemHome = lambdaHome * decayFactor
    const lambdaRemAway = lambdaAway * decayFactor

    // Mô phỏng số bàn thắng còn lại bằng Dixon-Coles
    const remMatrix = scoreMatrix(lambdaRemHome, lambdaRemAway, rho)

    // Neo vào tỉ số hiện tại
    const curH = Math.max(0, Math.floor(currentScore.home))
    const curA = Math.max(0, Math.floor(currentScore.away))

    const finalMatrix: number[][] = Array.from({ length: MAX_GOALS + 1 }, () =>
        Array.from({ length: MAX_GOALS + 1 }, () => 0),
    )

    for (let i = 0; i <= MAX_GOALS; i++) {
        for (let j = 0; j <= MAX_GOALS; j++) {
            const prob = remMatrix[i][j]
            const targetH = Math.min(MAX_GOALS, curH + i)
            const targetA = Math.min(MAX_GOALS, curA + j)
            finalMatrix[targetH][targetA] += prob
        }
    }

    // Chuẩn hoá toàn ma trận về tổng = 1
    const flat = finalMatrix.flat()
    const normFlat = normalize(flat)
    const out: number[][] = []
    let k = 0
    for (let i = 0; i <= MAX_GOALS; i++) {
        const row: number[] = []
        for (let j = 0; j <= MAX_GOALS; j++) {
            row.push(normFlat[k++])
        }
        out.push(row)
    }

    return { matrix: out, lambdaRemHome, lambdaRemAway, decayFactor }
}

export interface DataQuality {
    n: number
    sourceCount: number
    lineupConfirmed?: boolean
}

export interface MarketOddsInput {
    ouLine?: number
    ouOverOdds?: number
    ouUnderOdds?: number
    ahLine?: number
    ahHomeOdds?: number
    ahAwayOdds?: number
}

export interface ImpliedLambdasResult {
    lambdaHome: number
    lambdaAway: number
    lambdaTotal: number
    hasMarketOu: boolean
    hasMarketAh: boolean
}

/**
 * Trích xuất cặp kèo 2 đầu (Over/Under và Home/Away) đại diện từ danh sách OddsLine.
 */
export function extractMarketPairs(oddsLines: OddsLine[]): MarketOddsInput {
    const input: MarketOddsInput = {}

    // Tìm cặp Totals 2 đầu (ưu tiên mốc gần 2.5 nhất)
    const totalsOver = oddsLines.filter((o) => o.kind === 'totals' && o.side === 'over')
    for (const over of totalsOver) {
        const under = oddsLines.find(
            (o) => o.kind === 'totals' && o.side === 'under' && Math.abs(o.line - over.line) < 1e-6,
        )
        if (under) {
            if (input.ouLine === undefined || Math.abs(over.line - 2.5) < Math.abs(input.ouLine - 2.5)) {
                input.ouLine = over.line
                input.ouOverOdds = over.odds
                input.ouUnderOdds = under.odds
            }
        }
    }

    // Tìm cặp Asian Handicap 2 đầu (ưu tiên mốc gần 0 nhất)
    const ahHome = oddsLines.filter((o) => o.kind === 'ah' && o.side === 'home')
    for (const home of ahHome) {
        const away = oddsLines.find(
            (o) =>
                o.kind === 'ah' &&
                o.side === 'away' &&
                (Math.abs(o.line - home.line) < 1e-6 || Math.abs(o.line + home.line) < 1e-6),
        )
        if (away) {
            if (input.ahLine === undefined || Math.abs(home.line) < Math.abs(input.ahLine)) {
                input.ahLine = home.line
                input.ahHomeOdds = home.odds
                input.ahAwayOdds = away.odds
            }
        }
    }

    return input
}

/**
 * Bước 2: λ ngầm định từ thị trường (Market Implied Lambdas).
 * - Loại vig từng cặp odds.
 * - Giải ra lambdaTotal từ kèo Over/Under qua tìm kiếm nhị phân (bisection).
 * - Giải ra (lambdaHome, lambdaAway) từ kèo Asian Handicap cố định lambdaTotal.
 */
export function impliedLambdas(
    input: MarketOddsInput | OddsLine[],
    lgHome = DEFAULT_LG_HOME,
    lgAway = DEFAULT_LG_AWAY,
): ImpliedLambdasResult {
    const pairs: MarketOddsInput = Array.isArray(input) ? extractMarketPairs(input) : input

    let lambdaTotal = lgHome + lgAway
    let hasMarketOu = false

    // 1. Giải lambdaTotal từ Over/Under nếu có cặp odds 2 đầu
    if (
        pairs.ouLine !== undefined &&
        pairs.ouOverOdds !== undefined &&
        pairs.ouUnderOdds !== undefined &&
        pairs.ouOverOdds > 1 &&
        pairs.ouUnderOdds > 1
    ) {
        const pOverRaw = 1 / pairs.ouOverOdds
        const pUnderRaw = 1 / pairs.ouUnderOdds
        const sum = pOverRaw + pUnderRaw
        if (sum > 0) {
            const targetPOver = Math.min(0.98, Math.max(0.02, pOverRaw / sum))
            let low = 0.2
            let high = 8.0
            for (let i = 0; i < 25; i++) {
                const mid = (low + high) / 2
                const m = scoreMatrix(mid / 2, mid / 2)
                const trip = totalsTriple(m, pairs.ouLine, 'over')
                const dec = trip.win + trip.lose
                const p = dec > 0 ? trip.win / dec : 0.5
                if (p < targetPOver) {
                    low = mid
                } else {
                    high = mid
                }
            }
            lambdaTotal = Number(((low + high) / 2).toFixed(4))
            hasMarketOu = true
        }
    }

    let lambdaHome = lgHome
    let lambdaAway = lgAway
    let hasMarketAh = false

    // 2. Giải (lambdaHome, lambdaAway) từ Asian Handicap nếu có cặp odds 2 đầu
    if (
        pairs.ahLine !== undefined &&
        pairs.ahHomeOdds !== undefined &&
        pairs.ahAwayOdds !== undefined &&
        pairs.ahHomeOdds > 1 &&
        pairs.ahAwayOdds > 1
    ) {
        const pHomeRaw = 1 / pairs.ahHomeOdds
        const pAwayRaw = 1 / pairs.ahAwayOdds
        const sum = pHomeRaw + pAwayRaw
        if (sum > 0) {
            const targetPHome = Math.min(0.98, Math.max(0.02, pHomeRaw / sum))
            let low = 0.02 * lambdaTotal
            let high = 0.98 * lambdaTotal
            for (let i = 0; i < 25; i++) {
                const mid = (low + high) / 2
                const candH = mid
                const candA = Math.max(0.01, lambdaTotal - mid)
                const m = scoreMatrix(candH, candA)
                const trip = ahTriple(m, pairs.ahLine, 'home')
                const dec = trip.win + trip.lose
                const p = dec > 0 ? trip.win / dec : 0.5
                if (p < targetPHome) {
                    low = mid
                } else {
                    high = mid
                }
            }
            lambdaHome = Math.max(0.15, Number(((low + high) / 2).toFixed(4)))
            lambdaAway = Math.max(0.15, Number(Math.max(0.15, lambdaTotal - lambdaHome).toFixed(4)))
            hasMarketAh = true
        }
    }

    // Nếu chỉ có OU mà không có AH, chia theo tỷ lệ trung bình giải
    if (hasMarketOu && !hasMarketAh) {
        const lgRatio = lgHome / (lgHome + lgAway)
        lambdaHome = Math.max(0.15, Number((lambdaTotal * lgRatio).toFixed(4)))
        lambdaAway = Math.max(0.15, Number(Math.max(0.15, lambdaTotal - lambdaHome).toFixed(4)))
    }

    return {
        lambdaHome: Math.max(0.15, lambdaHome),
        lambdaAway: Math.max(0.15, lambdaAway),
        lambdaTotal: Math.max(0.30, lambdaTotal),
        hasMarketOu,
        hasMarketAh,
    }
}

/**
 * Bước 3: Trộn mô hình và thị trường (Bayesian / Evidence Weighted Blend).
 * λ_final = w × λ_model + (1 − w) × λ_market
 * - w = 0.50 nếu: >= 8 trận, xG từ >= 2 nguồn, đội hình đã xác nhận.
 * - w = 0.30 nếu thiếu 1 điều kiện.
 * - w = 0.15 nếu thiếu từ 2 điều kiện trở lên.
 * Clamp sàn λ >= 0.15 (không bao giờ bằng 0.00).
 */
export function blendLambdas(
    lambdaModel: { home: number; away: number },
    lambdaMarket: { home: number; away: number } | null,
    quality: DataQuality,
    hasMarketOdds = true,
): {
    lambdaHome: number
    lambdaAway: number
    w: number
    reason: string
} {
    if (
        !hasMarketOdds ||
        !lambdaMarket ||
        !Number.isFinite(lambdaMarket.home) ||
        !Number.isFinite(lambdaMarket.away)
    ) {
        return {
            lambdaHome: Math.max(0.15, lambdaModel.home),
            lambdaAway: Math.max(0.15, lambdaModel.away),
            w: 1.0,
            reason: 'Thị trường thiếu odds 2 đầu để giải λ_market; dùng 100% λ_model.',
        }
    }

    const c1 = quality.n >= 8
    const c2 = quality.sourceCount >= 2
    const c3 = quality.lineupConfirmed === true

    let conditionsMet = 0
    if (c1) conditionsMet++
    if (c2) conditionsMet++
    if (c3) conditionsMet++

    let w = 0.15
    let reason = ''
    if (conditionsMet === 3) {
        w = 0.5
        reason = 'Đầy đủ 3 điều kiện (>= 8 trận, >= 2 nguồn, đội hình xác nhận): w = 0.50 cân bằng mô hình & thị trường.'
    } else if (conditionsMet === 2) {
        w = 0.3
        reason = 'Thiếu 1 điều kiện dữ liệu: w = 0.30 nghiêng về thị trường (70%).'
    } else {
        w = 0.15
        reason = 'Thiếu từ 2 điều kiện dữ liệu trở lên: w = 0.15 ưu tiên mạnh thị trường (85%).'
    }

    const lambdaHome = Math.max(0.15, Number((w * lambdaModel.home + (1 - w) * lambdaMarket.home).toFixed(4)))
    const lambdaAway = Math.max(0.15, Number((w * lambdaModel.away + (1 - w) * lambdaMarket.away).toFixed(4)))

    return {
        lambdaHome,
        lambdaAway,
        w,
        reason,
    }
}
