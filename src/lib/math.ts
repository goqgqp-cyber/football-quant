/**
 * Tiện ích toán học thuần — không phụ thuộc framework.
 * Tất cả hàm ở đây là pure function để dễ unit test.
 */

export function clamp(x: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, x))
}

/**
 * Poisson PMF: P(X = k) = e^-λ * λ^k / k!
 */
export function poissonPmf(k: number, lambda: number): number {
    if (k < 0 || !Number.isInteger(k)) return 0
    if (lambda <= 0) return k === 0 ? 1 : 0
    let logp = -lambda + k * Math.log(lambda)
    for (let i = 2; i <= k; i++) logp -= Math.log(i)
    return Math.exp(logp)
}

export function factorial(n: number): number {
    let f = 1
    for (let i = 2; i <= n; i++) f *= i
    return f
}

/**
 * Làm mịn (shrinkage) số liệu mẫu về trung bình giải.
 * shr(x, n) = (n*x + k*lg_avg) / (n + k), k = 5
 */
export function shrink(x: number | null, n: number, lgAvg: number, k = 5): number {
    const xx = x ?? lgAvg
    return (n * xx + k * lgAvg) / (n + k)
}

/**
 * Chuẩn hoá mảng về tổng bằng 1. Nếu tổng = 0 trả về phân bố đều.
 */
export function normalize(values: number[]): number[] {
    const sum = values.reduce((a, b) => a + b, 0)
    if (sum <= 0) return values.map(() => 1 / values.length)
    return values.map((v) => v / sum)
}

export function round(x: number, digits = 4): number {
    const f = 10 ** digits
    return Math.round(x * f) / f
}

export function fmtPct(x: number, digits = 1): string {
    return `${(x * 100).toFixed(digits)}%`
}

export function fmtOdds(x: number): string {
    return x.toFixed(2)
}
