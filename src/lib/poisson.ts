import type { MatchData } from './types'
import { poissonPmf, shrink, normalize } from './math'

/** Tham số mặc định của giải (chỉnh được theo giải). */
export const DEFAULT_LG_HOME = 1.45
export const DEFAULT_LG_AWAY = 1.15

/** Hệ số làm mịn k */
export const SHRINK_K = 5

/** rho hiệu chỉnh Dixon-Coles */
export const DC_RHO = -0.08

/** Kích thước ma trận tỉ số: 0..10 */
export const MAX_GOALS = 10

/**
 * Ước lượng λ (số bàn kỳ vọng) cho hai đội theo công thức trong spec:
 *   lg_avg = (lg_home + lg_away) / 2
 *   λ_home = lg_home * (shr(home.xgf)/lg_avg) * (shr(away.xga)/lg_avg)
 *   λ_away = lg_away * (shr(away.xgf)/lg_avg) * (shr(home.xga)/lg_avg)
 *
 * xgf/xga ưu tiên; nếu null thì dùng goals_for/goals_against; nếu cả hai null
 * thì shrink() sẽ trả về lg_avg (tức trung tính).
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

    const lambdaHome = lgHome * (sHomeAtt / lgAvg) * (sAwayDef / lgAvg)
    const lambdaAway = lgAway * (sAwayAtt / lgAvg) * (sHomeDef / lgAvg)

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
