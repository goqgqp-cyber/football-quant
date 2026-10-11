import { useCallback, useEffect, useMemo, useState } from 'react'
import { GlassCard } from '../components/ui/GlassCard'
import { AnimatedNumber } from '../components/ui/AnimatedNumber'
import { Button } from '../components/ui/Button'
import { CALIBRATION_MIN_PICKS, brierScore, binLabel } from '../lib/settle'
import { ApiError, api, type StatsResponse } from '../lib/api'

/**
 * Trang Hiệu suất (Performance) — nạp danh sách các trận đã settle từ Upstash Redis
 * để tính tỷ lệ Win Rate (%), ROI, và tổng số trận đoán đúng/sai.
 */
export function PerformancePage() {
    const [stats, setStats] = useState<StatsResponse | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const data = await api.stats()
            setStats(data)
        } catch (e) {
            setError(e instanceof ApiError ? e.message : 'Không tải được số liệu hiệu suất.')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        void load()
    }, [load])

    const settled = stats?.settled ?? []
    const staked = useMemo(() => settled.filter((s) => s.pick.stakePct > 0), [settled])
    const nPicks = staked.length

    const winsCount = stats?.winsCount ?? staked.filter((s) => s.outcome === 'win' || s.outcome === 'win_half').length
    const lossesCount = stats?.lossesCount ?? staked.filter((s) => s.outcome === 'lose' || s.outcome === 'lose_half').length
    const pushesCount = stats?.pushesCount ?? staked.filter((s) => s.outcome === 'push').length

    const winRate = stats?.winRate ?? (nPicks ? (winsCount / nPicks) * 100 : 0)
    const profit = stats?.profit ?? 0
    const stakedTotal = staked.reduce((sum, s) => sum + s.pick.stakePct, 0)
    const roi = stats?.roi ?? (stakedTotal ? (profit / stakedTotal) * 100 : 0)

    const settledMatches = stats?.settledMatches ?? []

    const bins = useMemo(() => stats?.calibration ?? [], [stats])
    const brier = useMemo(
        () => brierScore(staked.map((s) => ({ p: s.pick.pWin, win: s.outcome === 'win' }))),
        [staked],
    )

    const enough = nPicks >= CALIBRATION_MIN_PICKS

    return (
        <div className="flex flex-col gap-5">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold tracking-tight text-white">Hiệu suất & Thống kê đối soát</h1>
                    <p className="text-xs text-neutral-400">
                        Dữ liệu tự động cập nhật từ Upstash Redis (settled_matches) và lịch sử đối soát.
                    </p>
                </div>
                <Button variant="ghost" onClick={() => void load()} disabled={loading}>
                    {loading ? 'Đang tải…' : '🔄 Tải lại'}
                </Button>
            </div>

            {error && (
                <GlassCard>
                    <p className="text-sm text-danger-400">{error}</p>
                </GlassCard>
            )}

            {/* 4 Chỉ số quan trọng: Win Rate, ROI, Lợi nhuận, Tỷ lệ Thắng/Hòa/Thua */}
            <div className="grid gap-3 sm:grid-cols-4">
                <Stat
                    label="Tỷ lệ thắng (Win Rate)"
                    value={winRate}
                    digits={1}
                    suffix="%"
                    tone={winRate >= 50 ? 'value' : 'default'}
                />
                <Stat
                    label="ROI (Lợi suất vốn)"
                    value={roi}
                    digits={2}
                    suffix="%"
                    tone={roi >= 0 ? 'value' : 'danger'}
                />
                <Stat
                    label="Lợi nhuận cộng dồn"
                    value={profit}
                    digits={2}
                    suffix=" đv"
                    tone={profit >= 0 ? 'value' : 'danger'}
                />
                <GlassCard>
                    <p className="text-xs uppercase tracking-wider text-neutral-400">Kết quả tổng thể</p>
                    <div className="mt-2 flex items-baseline gap-2">
                        <span className="font-mono text-2xl font-black text-emerald-400">{winsCount}W</span>
                        <span className="text-neutral-500 font-bold">·</span>
                        <span className="font-mono text-2xl font-black text-neutral-400">{pushesCount}P</span>
                        <span className="text-neutral-500 font-bold">·</span>
                        <span className="font-mono text-2xl font-black text-rose-400">{lossesCount}L</span>
                    </div>
                    <p className="mt-1 text-[11px] text-neutral-500">
                        {winsCount} Thắng · {pushesCount} Hòa · {lossesCount} Thua
                    </p>
                </GlassCard>
            </div>

            {/* Danh sách các trận đã Settle từ Redis settled_matches */}
            <GlassCard>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <div>
                        <p className="font-display text-base font-bold text-ink-100">
                            Các trận đã đối soát (Redis: settled_matches)
                        </p>
                        <p className="text-xs text-neutral-400">
                            Lưu vĩnh viễn kết quả tỷ số, phạt góc và chấm điểm tự động từ SportAPI.
                        </p>
                    </div>
                    <span className="rounded-full bg-white/5 border border-white/10 px-2.5 py-0.5 text-xs text-neutral-300">
                        {settledMatches.length} trận đã lưu
                    </span>
                </div>

                {settledMatches.length === 0 ? (
                    <div className="rounded-xl border border-white/5 bg-black/20 p-6 text-center text-xs text-neutral-400">
                        Chưa có trận nào trong danh sách <code className="bg-white/10 px-1 py-0.5 rounded text-white">settled_matches</code>.
                        Khi trận đấu kết thúc ở tab Phân tích hoặc gọi đối soát, hệ thống sẽ tự động lưu vào đây.
                    </div>
                ) : (
                    <div className="space-y-3">
                        {settledMatches.map((m) => (
                            <div
                                key={m.id}
                                className="rounded-xl border border-white/8 bg-black/40 p-4 transition hover:border-white/15"
                            >
                                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 pb-2.5">
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <span className="font-bold text-sm text-white">
                                                {m.home} vs {m.away}
                                            </span>
                                            {m.league && (
                                                <span className="rounded bg-white/5 px-2 py-0.5 text-[11px] text-neutral-400">
                                                    {m.league}
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-[11px] text-neutral-500 mt-0.5">
                                            Đối soát lúc: {new Date(m.settledAt).toLocaleString('vi-VN')}
                                        </p>
                                    </div>

                                    <div className="flex items-center gap-3">
                                        <div className="text-right">
                                            <span className="font-mono text-base font-black text-white">
                                                FT {m.score.ftHome} - {m.score.ftAway}
                                            </span>
                                            {m.corners && (
                                                <p className="text-[11px] text-amber-400 font-medium">
                                                    Góc: {m.corners.total} ({m.corners.home}-{m.corners.away})
                                                </p>
                                            )}
                                        </div>
                                        <span
                                            className={`rounded-lg px-2.5 py-1 text-xs font-bold uppercase tracking-wider ${m.summaryOutcome === 'win'
                                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                                : m.summaryOutcome === 'lose'
                                                    ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                                                    : 'bg-neutral-500/20 text-neutral-300 border border-neutral-500/30'
                                                }`}
                                        >
                                            {m.summaryOutcome === 'win'
                                                ? '🏆 THẮNG'
                                                : m.summaryOutcome === 'lose'
                                                    ? '❌ THUA'
                                                    : '🤝 HÒA'}
                                        </span>
                                    </div>
                                </div>

                                {/* Chi tiết từng kèo */}
                                <div className="mt-3 overflow-x-auto">
                                    <table className="w-full text-left text-xs">
                                        <thead className="text-[11px] uppercase tracking-wider text-neutral-500">
                                            <tr>
                                                <th className="pb-1.5 font-medium">Loại kèo</th>
                                                <th className="pb-1.5 font-medium">Lựa chọn</th>
                                                <th className="pb-1.5 font-medium">Mốc & Tỷ lệ</th>
                                                <th className="pb-1.5 font-medium text-center">Kết quả</th>
                                                <th className="pb-1.5 font-medium text-right">Lợi nhuận</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-white/5">
                                            {m.picks.map((p, idx) => (
                                                <tr key={idx} className="text-neutral-300">
                                                    <td className="py-1.5 font-medium text-white">
                                                        {p.kind === 'totals'
                                                            ? 'Tài Xỉu (Bàn)'
                                                            : p.kind === 'corners'
                                                                ? 'Phạt góc'
                                                                : 'Châu Á (AH)'}
                                                    </td>
                                                    <td className="py-1.5">
                                                        {p.side === 'over'
                                                            ? 'Tài (Over)'
                                                            : p.side === 'under'
                                                                ? 'Xỉu (Under)'
                                                                : p.side === 'home'
                                                                    ? `Chủ (${m.home})`
                                                                    : `Khách (${m.away})`}
                                                    </td>
                                                    <td className="py-1.5 font-mono">
                                                        {p.line >= 0 ? `+${p.line}` : p.line} @ {p.odds.toFixed(2)}
                                                    </td>
                                                    <td className="py-1.5 text-center">
                                                        <span
                                                            className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${p.outcome === 'win'
                                                                ? 'bg-emerald-500/20 text-emerald-400'
                                                                : p.outcome === 'win_half'
                                                                    ? 'bg-emerald-500/20 text-emerald-300'
                                                                    : p.outcome === 'lose'
                                                                        ? 'bg-rose-500/20 text-rose-400'
                                                                        : p.outcome === 'lose_half'
                                                                            ? 'bg-rose-500/20 text-rose-300'
                                                                            : 'bg-neutral-500/20 text-neutral-400'
                                                                }`}
                                                        >
                                                            {p.outcome === 'win'
                                                                ? 'Thắng'
                                                                : p.outcome === 'win_half'
                                                                    ? 'Thắng nửa'
                                                                    : p.outcome === 'lose'
                                                                        ? 'Thua'
                                                                        : p.outcome === 'lose_half'
                                                                            ? 'Thua nửa'
                                                                            : 'Hòa'}
                                                        </span>
                                                    </td>
                                                    <td
                                                        className={`py-1.5 text-right font-mono font-bold ${p.profit > 0
                                                            ? 'text-emerald-400'
                                                            : p.profit < 0
                                                                ? 'text-rose-400'
                                                                : 'text-neutral-400'
                                                            }`}
                                                    >
                                                        {p.profit > 0 ? '+' : ''}
                                                        {p.profit.toFixed(2)} đv
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </GlassCard>

            {/* Bảng Calibration */}
            <GlassCard>
                <p className="font-display text-sm font-bold text-ink-100">
                    Đường cong calibration (dự đoán vs thực tế)
                </p>
                <p className="mt-1 text-xs text-ink-500">
                    Tổng pick đã đối soát: <span className="font-display text-ink-300">{nPicks}</span> · Lợi nhuận:{' '}
                    <span className={`font-display ${profit >= 0 ? 'text-value-400' : 'text-danger-400'}`}>
                        {profit >= 0 ? '+' : ''}
                        {profit.toFixed(3)} đv
                    </span>
                    · Brier score: <span className="font-mono text-ink-300">{brier.toFixed(4)}</span>
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
