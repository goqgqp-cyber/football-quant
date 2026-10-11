import type { ActualResult, CalibrationBin, Pick, SettledPick } from './types'

/**
 * Quyết định kết quả một pick theo tỉ số thực tế.
 * Xử lý mốc 1/4 (thắng nửa / thua nửa) và trường hợp hoà (push).
 */
export function settlePick(pick: Pick, r: ActualResult, period: 'ht' | 'ft'): SettledPick {
    const home = period === 'ht' ? r.htHome : r.ftHome
    const away = period === 'ht' ? r.htAway : r.ftAway

    if (pick.kind === 'totals') {
        const total = home + away
        const quarter = Math.abs(pick.line * 2 - Math.round(pick.line * 2)) > 1e-9
        const lo = pick.line - 0.25
        const hi = pick.line + 0.25
        // Hàm trả về lợi nhuận (theo đơn vị) cho một mốc đơn
        const profitAt = (l: number): number => {
            const dir = pick.side === 'over' ? 1 : -1
            const diff = (total - l) * dir
            if (Math.abs(diff) < 1e-9) return 0 // push
            return diff > 0 ? pick.odds - 1 : -1
        }
        if (quarter) {
            const p1 = profitAt(lo)
            const p2 = profitAt(hi)
            const profit = (p1 + p2) / 2
            const outcome =
                p1 === 0 && p2 === 0 ? 'push' : p1 > 0 && p2 > 0 ? 'win' : p1 < 0 && p2 < 0 ? 'lose' : p1 >= 0 ? 'win_half' : 'lose_half'
            return { pick, outcome, profit }
        }
        const profit = profitAt(pick.line)
        const outcome = profit === 0 ? 'push' : profit > 0 ? 'win' : 'lose'
        return { pick, outcome, profit }
    }

    if (pick.kind === 'corners') {
        const cHome = r.cornersHome ?? 0
        const cAway = r.cornersAway ?? 0
        if (pick.side === 'over' || pick.side === 'under') {
            const total = cHome + cAway
            const quarter = Math.abs(pick.line * 2 - Math.round(pick.line * 2)) > 1e-9
            const profitAt = (l: number): number => {
                const dir = pick.side === 'over' ? 1 : -1
                const diff = (total - l) * dir
                if (Math.abs(diff) < 1e-9) return 0
                return diff > 0 ? pick.odds - 1 : -1
            }
            if (quarter) {
                const p1 = profitAt(pick.line - 0.25)
                const p2 = profitAt(pick.line + 0.25)
                const profit = (p1 + p2) / 2
                const outcome =
                    p1 === 0 && p2 === 0 ? 'push' : p1 > 0 && p2 > 0 ? 'win' : p1 < 0 && p2 < 0 ? 'lose' : p1 >= 0 ? 'win_half' : 'lose_half'
                return { pick, outcome, profit }
            }
            const profit = profitAt(pick.line)
            const outcome = profit === 0 ? 'push' : profit > 0 ? 'win' : 'lose'
            return { pick, outcome, profit }
        } else {
            const quarter = Math.abs(pick.line * 2 - Math.round(pick.line * 2)) > 1e-9
            const profitAt = (l: number): number => {
                const adjusted = pick.side === 'home' ? cHome - cAway + l : cAway - cHome - l
                if (Math.abs(adjusted) < 1e-9) return 0
                return adjusted > 0 ? pick.odds - 1 : -1
            }
            if (quarter) {
                const p1 = profitAt(pick.line - 0.25)
                const p2 = profitAt(pick.line + 0.25)
                const profit = (p1 + p2) / 2
                const outcome =
                    p1 === 0 && p2 === 0 ? 'push' : p1 > 0 && p2 > 0 ? 'win' : p1 < 0 && p2 < 0 ? 'lose' : p1 >= 0 ? 'win_half' : 'lose_half'
                return { pick, outcome, profit }
            }
            const profit = profitAt(pick.line)
            const outcome = profit === 0 ? 'push' : profit > 0 ? 'win' : 'lose'
            return { pick, outcome, profit }
        }
    }

    // Asian handicap
    const quarter = Math.abs(pick.line * 2 - Math.round(pick.line * 2)) > 1e-9
    const profitAt = (l: number): number => {
        const adjusted = pick.side === 'home' ? home - away + l : away - home - l
        if (Math.abs(adjusted) < 1e-9) return 0
        return adjusted > 0 ? pick.odds - 1 : -1
    }
    if (quarter) {
        const p1 = profitAt(pick.line - 0.25)
        const p2 = profitAt(pick.line + 0.25)
        const profit = (p1 + p2) / 2
        const outcome =
            p1 === 0 && p2 === 0 ? 'push' : p1 > 0 && p2 > 0 ? 'win' : p1 < 0 && p2 < 0 ? 'lose' : p1 >= 0 ? 'win_half' : 'lose_half'
        return { pick, outcome, profit }
    }
    const profit = profitAt(pick.line)
    const outcome = profit === 0 ? 'push' : profit > 0 ? 'win' : 'lose'
    return { pick, outcome, profit }
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