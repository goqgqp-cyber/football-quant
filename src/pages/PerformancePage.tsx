import { useMemo } from 'react'
import { GlassCard } from '../components/ui/GlassCard'
import { AnimatedNumber } from '../components/ui/AnimatedNumber'
import { CALIBRATION_MIN_PICKS, brierScore, buildCalibration, binLabel } from '../lib/settle'
import type { Pick } from '../lib/types'

/**
 * Trang Hiệu suất (G1: dữ liệu mô phỏng).
 * G2 sẽ đọc `u:{userId}:calibration:bins` + result từ Upstash.
 */
export function PerformancePage() {
    // Mô phỏng các pick đã đối soát
    const settled = useMemo(() => {
        const rows: { pick: Pick; outcome: 'win' | 'lose' | 'push' | 'win_half' | 'lose_half' }[] = []
        const probs = [0.52, 0.54, 0.56, 0.58, 0.6, 0.62, 0.66, 0.7]
        let i = 0
        for (const p of probs) {
            for (let k = 0; k < 8; k++) {
                const win = Math.random() < p
                rows.push({
                    pick: {
                        oddsLineId: `m${i++}`,
                        kind: 'totals',
                        side: 'over',
                        line: 2.5,
                        odds: 1.9,
                        pWin: p,
                        pPush: 0,
                        pLose: 1 - p,
                        pImplied: 1 / 1.9,
                        pImpliedNoVig: null,
                        edge: 0.05,
                        ev: 0.05,
                        confidence: 'medium',
                        stakePct: 0.015,
                        status: 'value',
                        flags: [],
                        marketDelta: 0.02,
                    },
                    outcome: win ? 'win' : 'lose',
                })
            }
        }
        return rows
    }, [])

    const nPicks = settled.length
    const wins = settled.filter((s) => s.outcome === 'win').length
    const winRate = nPicks ? wins / nPicks : 0

    const profit = settled.reduce((sum, s) => {
        if (s.outcome === 'win') return sum + (s.pick.odds - 1) * s.pick.stakePct
        if (s.outcome === 'lose') return sum - s.pick.stakePct
        return sum
    }, 0)
    const stakedTotal = settled.reduce((sum, s) => sum + s.pick.stakePct, 0)
    const roi = stakedTotal ? profit / stakedTotal : 0

    const bins = useMemo(() => buildCalibration(settled), [settled])
    const brier = useMemo(
        () => brierScore(settled.map((s) => ({ p: s.pick.pWin, win: s.outcome === 'win' }))),
        [settled],
    )

    const enough = nPicks >= CALIBRATION_MIN_PICKS

    return (
        <div className="flex flex-col gap-5">
            <div className="grid gap-3 sm:grid-cols-3">
                <Stat label="ROI cộng dồn" value={roi * 100} digits={2} suffix="%" tone={roi >= 0 ? 'value' : 'danger'} />
                <Stat label="Tỉ lệ thắng thực tế" value={winRate * 100} digits={1} suffix="%" tone="default" />
                <Stat label="Brier score" value={brier} digits={4} tone="default" />
            </div>

            <GlassCard>
                <p className="font-display text-sm font-bold text-ink-100">
                    Đường cong calibration (dự đoán vs thực tế)
                </p>
                <p className="mt-1 text-xs text-ink-500">
                    Tổng pick đã đối soát: <span className="font-display text-ink-300">{nPicks}</span>
                </p>

                {!enough ? (
                    <div className="mt-3 rounded-xl border border-warn-400/30 bg-warn-500/10 px-3 py-3 text-sm text-warn-400">
                        Chưa đủ dữ liệu để kết luận về độ hiệu chỉnh. Cần tối thiểu {CALIBRATION_MIN_PICKS} pick đã
                        đối soát (hiện có {nPicks}).
                    </div>
                ) : null}

                <div className="mt-4 overflow-x-auto rounded-xl border border-white/10">
                    <table className="min-w-full text-sm">
                        <thead className="bg-white/5 text-xs text-ink-500">
                            <tr>
                                <th className="px-3 py-2 text-left">Bin</th>
                                <th className="px-3 py-2 text-right">Số pick</th>
                                <th className="px-3 py-2 text-right">Dự đoán TB</th>
                                <th className="px-3 py-2 text-right">Thực tế</th>
                                <th className="px-3 py-2 text-right">Chênh lệch</th>
                            </tr>
                        </thead>
                        <tbody>
                            {bins.map((b) => {
                                const avgPred = b.n ? b.sumPred / b.n : 0
                                const actual = b.n ? b.wins / b.n : 0
                                const diff = actual - avgPred
                                return (
                                    <tr key={b.label} className="border-t border-white/8">
                                        <td className="px-3 py-1.5">{b.label}</td>
                                        <td className="px-3 py-1.5 text-right">{b.n}</td>
                                        <td className="px-3 py-1.5 text-right">{(avgPred * 100).toFixed(1)}%</td>
                                        <td className="px-3 py-1.5 text-right">{(actual * 100).toFixed(1)}%</td>
                                        <td
                                            className={`px-3 py-1.5 text-right font-semibold ${Math.abs(diff) <= 0.05 ? 'text-value-400' : 'text-warn-400'
                                                }`}
                                        >
                                            {diff >= 0 ? '+' : ''}
                                            {(diff * 100).toFixed(1)} điểm %
                                        </td>
                                    </tr>
                                )
                            })}
                            {bins.length === 0 && (
                                <tr>
                                    <td colSpan={5} className="px-3 py-3 text-center text-ink-500">
                                        Chưa có bin nào.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
                <p className="mt-2 text-xs text-ink-500">
                    Bin được chia theo xác suất mô hình: {binLabel(0.5)} … Chỉ kết luận khi ≥ {CALIBRATION_MIN_PICKS} pick.
                </p>
            </GlassCard>
        </div>
    )
}

function Stat({
    label,
    value,
    digits,
    suffix,
    tone,
}: {
    label: string
    value: number
    digits: number
    suffix?: string
    tone: 'default' | 'value' | 'danger'
}) {
    const color =
        tone === 'value' ? 'text-value-400' : tone === 'danger' ? 'text-danger-400' : 'text-ink-100'
    return (
        <GlassCard>
            <p className="text-xs uppercase tracking-wider text-ink-500">{label}</p>
            <p className={`mt-1 text-3xl font-black ${color}`}>
                <AnimatedNumber value={value} digits={digits} suffix={suffix} />
            </p>
        </GlassCard>
    )
}
