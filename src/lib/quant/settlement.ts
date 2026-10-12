/**
 * Quantitative Settlement Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Cung cấp công thức chấm điểm chuẩn xác cho kèo Châu Á (Asian Handicap),
 * Kèo Tài/Xỉu (Over/Under) và Phạt góc, khắc phục triệt để lỗi đảo chiều (inversion).
 */

export interface GradeResult {
    status: 'THẮNG' | 'THẮNG NỬA' | 'HÒA' | 'THUA NỬA' | 'THUA'
    pnl: number
    outcome: 'win' | 'win_half' | 'push' | 'lose_half' | 'lose'
}

/**
 * Chấm điểm kèo chấp Châu Á (Asian Handicap)
 * Net = Goal Difference (từ góc nhìn đội đặt cược) + Handicap
 */
export function gradeAsianHandicap(
    homeScore: number,
    awayScore: number,
    side: 'home' | 'away',
    hdp: number,
    odds: number,
): GradeResult {
    const goalDiff = side === 'home' ? homeScore - awayScore : awayScore - homeScore
    const net = Number((goalDiff + hdp).toFixed(4))

    if (net >= 0.5) {
        return {
            status: 'THẮNG',
            pnl: Number((odds - 1).toFixed(2)),
            outcome: 'win',
        }
    }
    if (Math.abs(net - 0.25) < 1e-4) {
        return {
            status: 'THẮNG NỬA',
            pnl: Number(((odds - 1) / 2).toFixed(2)),
            outcome: 'win_half',
        }
    }
    if (Math.abs(net) < 1e-4) {
        return {
            status: 'HÒA',
            pnl: 0.0,
            outcome: 'push',
        }
    }
    if (Math.abs(net - (-0.25)) < 1e-4) {
        return {
            status: 'THUA NỬA',
            pnl: -0.5,
            outcome: 'lose_half',
        }
    }
    return {
        status: 'THUA',
        pnl: -1.0,
        outcome: 'lose',
    }
}

/**
 * Chấm điểm kèo Tài / Xỉu (Over / Under)
 * Diff = (totalScore - line) nếu Over; (line - totalScore) nếu Under.
 */
export function gradeOverUnder(
    totalScore: number,
    side: 'over' | 'under',
    line: number,
    odds: number,
): GradeResult {
    const diff = Number((side === 'over' ? totalScore - line : line - totalScore).toFixed(4))

    if (diff >= 0.5) {
        return {
            status: 'THẮNG',
            pnl: Number((odds - 1).toFixed(2)),
            outcome: 'win',
        }
    }
    if (Math.abs(diff - 0.25) < 1e-4) {
        return {
            status: 'THẮNG NỬA',
            pnl: Number(((odds - 1) / 2).toFixed(2)),
            outcome: 'win_half',
        }
    }
    if (Math.abs(diff) < 1e-4) {
        return {
            status: 'HÒA',
            pnl: 0.0,
            outcome: 'push',
        }
    }
    if (Math.abs(diff - (-0.25)) < 1e-4) {
        return {
            status: 'THUA NỬA',
            pnl: -0.5,
            outcome: 'lose_half',
        }
    }
    return {
        status: 'THUA',
        pnl: -1.0,
        outcome: 'lose',
    }
}

/**
 * Tạo nhãn phân loại (Badges) rõ ràng cho từng loại kèo:
 * - [Châu Á FT - Bàn]
 * - [Tài/Xỉu H1 - Bàn]
 * - [Tài/Xỉu FT - Bàn]
 * - [Phạt góc FT]
 */
export function getMarketBadge(kind: string, period?: string | null): string {
    const p = (period || '').toLowerCase()
    const isH1 = p.includes('1st') || p.includes('h1') || p.includes('ht') || p.includes('hiệp 1')

    if (kind === 'corners') {
        return isH1 ? '[Phạt góc H1]' : '[Phạt góc FT]'
    }
    if (kind === 'totals') {
        return isH1 ? '[Tài/Xỉu H1 - Bàn]' : '[Tài/Xỉu FT - Bàn]'
    }
    if (kind === 'ah') {
        return isH1 ? '[Châu Á H1 - Bàn]' : '[Châu Á FT - Bàn]'
    }
    return '[Kèo FT]'
}

/**
 * Format hiển thị chi tiết chia phạt góc hai đội: Góc: 8 [5-3]
 */
export function formatCornerSplit(homeCorners?: number, awayCorners?: number): string {
    if (homeCorners === undefined || awayCorners === undefined) {
        return 'Góc: —'
    }
    const total = homeCorners + awayCorners
    return `Góc: ${total} [${homeCorners}-${awayCorners}]`
}
