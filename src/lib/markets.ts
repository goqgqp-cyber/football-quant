import type { Triple, MarketKind } from './types'

/**
 * Một mốc là "1/4" khi không phải bội số của 0.5 (ví dụ 2.25, 2.75, -0.25).
 * Kèo 1/4 = chia đôi tiền vào hai mốc kề nhau (mốc ± 0.25).
 */
export function isQuarterLine(line: number): boolean {
    const twice = line * 2
    return Math.abs(twice - Math.round(twice)) > 1e-9
}

export function splitQuarter(line: number): [number, number] {
    return [line - 0.25, line + 0.25]
}

/** Trung bình bộ ba (mỗi nửa vốn vào một mốc). */
function avgTriple(a: Triple, b: Triple): Triple {
    return {
        win: (a.win + b.win) / 2,
        push: (a.push + b.push) / 2,
        lose: (a.lose + b.lose) / 2,
    }
}

/**
 * Tài/Xỉu cho một mốc đơn (mốc là bội số 0.5).
 * total = tổng bàn; over thắng khi total > line; push khi total == line.
 */
export function totalsSingle(matrix: number[][], line: number, side: 'over' | 'under'): Triple {
    let win = 0
    let push = 0
    let lose = 0
    for (let i = 0; i < matrix.length; i++) {
        for (let j = 0; j < matrix[i].length; j++) {
            const total = i + j
            const p = matrix[i][j]
            if (Math.abs(total - line) < 1e-9) {
                push += p
            } else if (side === 'over') {
                if (total > line) win += p
                else lose += p
            } else {
                if (total < line) win += p
                else lose += p
            }
        }
    }
    return { win, push, lose }
}

/** Tài/Xỉu, tự động xử lý mốc 1/4. */
export function totalsTriple(matrix: number[][], line: number, side: 'over' | 'under'): Triple {
    if (isQuarterLine(line)) {
        const [a, b] = splitQuarter(line)
        return avgTriple(totalsSingle(matrix, a, side), totalsSingle(matrix, b, side))
    }
    return totalsSingle(matrix, line, side)
}

/**
 * Kèo chấp châu Á cho một mốc đơn.
 * `h` là mốc chấp theo góc nhìn đội nhà (ví dụ -0.5, 0, +1).
 * Đội nhà: adjusted = (home - away) + h; khách: adjusted = (away - home) - h.
 */
export function ahSingle(matrix: number[][], h: number, side: 'home' | 'away'): Triple {
    let win = 0
    let push = 0
    let lose = 0
    for (let i = 0; i < matrix.length; i++) {
        for (let j = 0; j < matrix[i].length; j++) {
            const goalDiff = side === 'home' ? i - j : j - i
            const adjusted = goalDiff + h
            const p = matrix[i][j]
            if (Math.abs(adjusted) < 1e-9) push += p
            else if (adjusted > 0) win += p
            else lose += p
        }
    }
    return { win, push, lose }
}

/** Kèo chấp châu Á, tự động xử lý mốc 1/4. */
export function ahTriple(matrix: number[][], h: number, side: 'home' | 'away'): Triple {
    if (isQuarterLine(h)) {
        const [a, b] = splitQuarter(h)
        return avgTriple(ahSingle(matrix, a, side), ahSingle(matrix, b, side))
    }
    return ahSingle(matrix, h, side)
}

/** Tính bộ ba theo loại kèo. */
export function tripleFor(
    matrix: number[][],
    kind: MarketKind,
    line: number,
    side: string,
): Triple {
    if (kind === 'totals') {
        return totalsTriple(matrix, line, side as 'over' | 'under')
    }
    return ahTriple(matrix, line, side as 'home' | 'away')
}
