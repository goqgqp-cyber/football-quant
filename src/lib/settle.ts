import type { ActualResult, CalibrationBin, Pick, SettledPick } from './types'
import {
    gradeAsianHandicap,
    gradeOverUnder,
    getMarketBadge,
    formatCornerSplit,
} from './quant/settlement'

export { gradeAsianHandicap, gradeOverUnder, getMarketBadge, formatCornerSplit }

/**
 * Quyết định kết quả một pick theo tỉ số thực tế.
 * Xử lý mốc 1/4 (thắng nửa / thua nửa) và trường hợp hoà (push),
 * sửa triệt để lỗi đảo chiều (inversion) cho kèo Châu Á đội khách / kèo cộng.
 */
export function settlePick(pick: Pick, r: ActualResult, period: 'ht' | 'ft'): SettledPick {
    const home = period === 'ht' ? r.htHome : r.ftHome
    const away = period === 'ht' ? r.htAway : r.ftAway

    if (pick.kind === 'totals') {
        const graded = gradeOverUnder(home + away, pick.side as 'over' | 'under', pick.line, pick.odds)
        return { pick, outcome: graded.outcome, profit: graded.pnl }
    }

    if (pick.kind === 'corners') {
        const cHome = r.cornersHome ?? 0
        const cAway = r.cornersAway ?? 0
        if (pick.side === 'over' || pick.side === 'under') {
            const graded = gradeOverUnder(cHome + cAway, pick.side as 'over' | 'under', pick.line, pick.odds)
            return { pick, outcome: graded.outcome, profit: graded.pnl }
        } else {
            const graded = gradeAsianHandicap(cHome, cAway, pick.side as 'home' | 'away', pick.line, pick.odds)
            return { pick, outcome: graded.outcome, profit: graded.pnl }
        }
    }

    // Asian handicap (bàn thắng)
    const graded = gradeAsianHandicap(home, away, pick.side as 'home' | 'away', pick.line, pick.odds)
    return { pick, outcome: graded.outcome, profit: graded.pnl }
}


/** Lợi nhuận tổng (đơn vị) của một danh sách pick đã settle. */
export function totalProfit(settled: SettledPick[]): number {
    return settled.reduce((sum, s) => sum + s.profit, 0)
}

/**
 * Đưa xác suất dự đoán vào bin (ví dụ 50-55%, 55-60%...).
 * Trả về label bin.
 */
export function binLabel(p: number, binWidth = 0.05): string {
    const start = Math.floor(p / binWidth) * binWidth
    const end = start + binWidth
    return `${(start * 100).toFixed(0)}-${(end * 100).toFixed(0)}%`
}

/** Brier score: trung bình (p - kết quả)^2. */
export function brierScore(items: { p: number; win: boolean }[]): number {
    if (items.length === 0) return 0
    const sum = items.reduce((acc, it) => acc + (it.p - (it.win ? 1 : 0)) ** 2, 0)
    return sum / items.length
}

/** Gom pick đã đối soát vào các bin calibration. */
export function buildCalibration(
    settled: { pick: Pick; outcome: SettledPick['outcome'] }[],
): CalibrationBin[] {
    const map = new Map<string, CalibrationBin>()
    for (const s of settled) {
        const label = binLabel(s.pick.pWin)
        const cur = map.get(label) ?? { label, n: 0, sumPred: 0, wins: 0 }
        cur.n += 1
        cur.sumPred += s.pick.pWin
        if (s.outcome === 'win' || s.outcome === 'win_half') cur.wins += 1
        map.set(label, cur)
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label))
}

/** Ngưỡng tối thiểu để kết luận về độ hiệu chỉnh. */
export const CALIBRATION_MIN_PICKS = 100