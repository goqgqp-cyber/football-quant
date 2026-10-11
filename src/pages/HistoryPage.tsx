import { formatPickTitle } from '../components/PickCard'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { GlassCard } from '../components/ui/GlassCard'
import { Button } from '../components/ui/Button'
import { TextInput } from '../components/ui/Field'
import { ExplanationPanel } from '../components/ExplanationPanel'
import { settlePick } from '../lib/settle'
import { ApiError, api, type HistoryItem } from '../lib/api'
import type { LiveMatchData, SettledPick } from '../lib/types'
import {
    getLocalHistory,
    saveLocalHistory,
    updateLocalHistoryItem,
    removeLocalHistoryItem,
    HISTORY_UPDATE_EVENT,
} from '../lib/historyStorage'

type Filter = 'all' | 'pending' | 'settled'

const OUTCOME_LABEL: Record<SettledPick['outcome'], string> = {
    win: 'THẮNG',
    win_half: 'THẮNG NỬA',
    push: 'HOÀN',
    lose_half: 'THUA NỬA',
    lose: 'THUA',
}

const OUTCOME_CLASS: Record<SettledPick['outcome'], string> = {
    win: 'text-emerald-400 bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 rounded text-[11px] font-bold inline-block',
    win_half: 'text-emerald-300 bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 rounded text-[11px] font-bold inline-block',
    push: 'text-neutral-300 bg-neutral-600/25 border border-neutral-500/30 px-2 py-0.5 rounded text-[11px] font-bold inline-block',
    lose_half: 'text-amber-400 bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 rounded text-[11px] font-bold inline-block',
    lose: 'text-rose-400 bg-rose-500/15 border border-rose-500/30 px-2 py-0.5 rounded text-[11px] font-bold inline-block',
}

/** Định dạng giờ thi đấu chuẩn xác (giờ:phút ngày/tháng/năm). */
export function formatKickoff(isoStr?: string | null): string {
    if (!isoStr) return 'Chưa có giờ đá'
    try {
        const d = new Date(isoStr)
        if (isNaN(d.getTime())) return isoStr
        const hours = String(d.getHours()).padStart(2, '0')
        const mins = String(d.getMinutes()).padStart(2, '0')
        const day = String(d.getDate()).padStart(2, '0')
        const month = String(d.getMonth() + 1).padStart(2, '0')
        const year = d.getFullYear()
        return `${hours}:${mins} ${day}/${month}/${year}`
    } catch {
        return isoStr
    }
}

export function HistoryPage() {
    // Nạp ngay tức thì từ LocalStorage (hiển thị lập tức trận vừa phân tích)
    const [items, setItems] = useState<HistoryItem[]>(() => getLocalHistory())
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [filter, setFilter] = useState<Filter>('all')

    const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const { items: serverRows } = await api.history(200)
            const local = getLocalHistory()
            const serverIds = new Set(serverRows.map((r) => r.id))
            // Giữ lại các lượt phân tích vừa phát sinh trên client nếu server chưa kịp trả về
            const uncommitted = local.filter((l) => !serverIds.has(l.id))
            const merged = [...uncommitted, ...serverRows]
            setItems(merged)
            saveLocalHistory(merged)
        } catch (e) {
            setError(e instanceof ApiError ? e.message : 'Không tải được lịch sử từ server. Đang dùng bộ nhớ máy.')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        void load()

        // Lắng nghe event khi trang /analyze vừa phân tích xong trận mới (Hull vs Everton...)
        const handleUpdate = () => {
            const fresh = getLocalHistory()
            if (fresh.length > 0) {
                setItems(fresh)
            }
        }
        window.addEventListener(HISTORY_UPDATE_EVENT, handleUpdate)
        return () => window.removeEventListener(HISTORY_UPDATE_EVENT, handleUpdate)
    }, [load])

    const filtered = useMemo(() => {
        return items.filter((it) => {
            if (filter === 'all') return true
            if (filter === 'pending') return it.result == null
            return it.result != null
        })
    }, [items, filter])

    const applySettled = (updated: HistoryItem) => {
        updateLocalHistoryItem(updated)
        setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)))
    }

    const remove = async (id: string) => {
        try {
            await api.deleteHistory(id)
        } catch {
            /* ignore server error */
        }
        removeLocalHistoryItem(id)
        setItems((prev) => prev.filter((it) => it.id !== id))
    }

    return (
        <div className="flex flex-col gap-5">
            <GlassCard>
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <p className="font-display text-base font-bold text-ink-100">Lịch sử phân tích & Đối soát kèo</p>
                        <p className="text-xs text-neutral-400">
                            Chỉ lưu các pick đạt chuẩn khuyến nghị (Edge ≥ 5%, EV &gt; 0, Odds ≥ 1.50). Đồng bộ LocalStorage & Upstash Redis.
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {(['all', 'pending', 'settled'] as Filter[]).map((f) => (
                            <Button
                                key={f}
                                variant={filter === f ? 'primary' : 'ghost'}
                                onClick={() => setFilter(f)}
                            >
                                {f === 'all' ? 'Tất cả' : f === 'pending' ? 'Chưa kết thúc' : 'Đã đối soát'}
                            </Button>
                        ))}
                        <Button variant="ghost" onClick={() => void load()} disabled={loading}>
                            {loading ? 'Đang tải…' : '🔄 Tải lại'}
                        </Button>
                    </div>
                </div>
            </GlassCard>

            {error && (
                <GlassCard>
                    <p className="text-sm text-danger-400">{error}</p>
                </GlassCard>
            )}

            {!loading && filtered.length === 0 && (
                <GlassCard>
                    <p className="text-sm text-ink-500">
                        {items.length === 0
                            ? 'Chưa có lượt phân tích nào. Hãy chạy phân tích ở trang Phân tích.'
                            : 'Không có bản ghi nào khớp bộ lọc.'}
                    </p>
                </GlassCard>
            )}

            {filtered.map((it) => (
                <HistoryRow key={it.id} item={it} onSettled={applySettled} onDelete={remove} />
            ))}
        </div>
    )
}

function HistoryRow({
    item,
    onSettled,
    onDelete,
}: {
    item: HistoryItem
    onSettled: (updated: HistoryItem) => void
    onDelete: (id: string) => void
}) {
    const [htHome, setHtHome] = useState('0')
    const [htAway, setHtAway] = useState('0')
    const [ftHome, setFtHome] = useState('')
    const [ftAway, setFtAway] = useState('')
    const [busy, setBusy] = useState(false)
    const [err, setErr] = useState<string | null>(null)

    // Trạng thái live từ API-Football
    const [liveData, setLiveData] = useState<LiveMatchData | null>(null)
    const [checkingLive, setCheckingLive] = useState(false)
    const [autoSettledNotice, setAutoSettledNotice] = useState<string | null>(null)

    // Tự động kiểm tra tỷ số & đối soát khi trận kết thúc (FT)
    const checkLiveAndAutoSettle = useCallback(async () => {
        if (item.result) return
        setCheckingLive(true)
        try {
            const live = await api.getLiveMatch(item.meta.home, item.meta.away)
            if (live.found) {
                setLiveData(live)
                // Nếu trận đã kết thúc (isFinished), tự động đối soát với API-Football
                if (live.isFinished) {
                    try {
                        const res = await api.autoSettle({
                            recordId: item.id,
                            home: item.meta.home,
                            away: item.meta.away,
                            eventId: live.eventId,
                        })
                        if (res.item) {
                            setAutoSettledNotice(
                                `✨ Trận đấu đã FT (${live.score.home}-${live.score.away}) — Đã tự động đối soát kết quả vào Redis!`
                            )
                            onSettled(res.item)
                        }
                    } catch {
                        /* ignore autoSettle error and keep liveData */
                    }
                }
            }
        } catch {
            /* ignore network errors */
        } finally {
            setCheckingLive(false)
        }
    }, [item.id, item.meta.home, item.meta.away, item.result, onSettled])

    useEffect(() => {
        if (!item.result) {
            void checkLiveAndAutoSettle()
        }
    }, [checkLiveAndAutoSettle, item.result])

    const settled: SettledPick[] | null = useMemo(() => {
        if (!item.result) return null
        return item.picks.map((p) => settlePick(p, item.result as NonNullable<typeof item.result>, 'ft'))
    }, [item])

    const totalProfit = settled ? settled.reduce((s, x) => s + x.profit, 0) : 0
    const kickoffLabel = formatKickoff(item.meta.kickoff)

    const submitManual = async () => {
        setBusy(true)
        setErr(null)
        try {
            const { item: updated } = await api.settle({
                id: item.id,
                htHome: Number(htHome) || 0,
                htAway: Number(htAway) || 0,
                ftHome: Number(ftHome) || 0,
                ftAway: Number(ftAway) || 0,
            })
            onSettled(updated)
        } catch (e) {
            setErr(e instanceof ApiError ? e.message : 'Không lưu được kết quả.')
        } finally {
            setBusy(false)
        }
    }

    const isMatchLive =
        !item.result &&
        (liveData?.status === 'inprogress' || (!liveData?.isFinished && Boolean(liveData?.minute)))

    return (
        <GlassCard>
            <div className="flex flex-wrap items-start justify-between gap-2 border-b border-white/8 pb-3">
                <div>
                    <div className="flex items-center gap-2">
                        <p className="font-display text-base font-bold text-ink-100">
                            {item.meta.home} <span className="text-ink-500 font-normal">vs</span> {item.meta.away}
                        </p>
                        {item.meta.league && (
                            <span className="rounded bg-white/5 border border-white/10 px-2 py-0.5 text-[11px] text-neutral-300 font-medium">
                                {item.meta.league}
                            </span>
                        )}
                    </div>
                    <p className="text-xs text-neutral-400 mt-1 flex items-center gap-2">
                        <span>🕒 Giờ đá: <strong className="text-white font-mono">{kickoffLabel}</strong></span>
                        <span className="text-neutral-600">·</span>
                        <span className="text-neutral-500 font-mono text-[11px]">ID: {item.id}</span>
                    </p>
                </div>

                <div className="flex items-center gap-2">
                    {item.result ? (
                        <span className="rounded-full border border-emerald-500/40 bg-emerald-500/15 px-3 py-1 text-xs font-bold text-emerald-300">
                            ✓ Đã kết thúc (Đã đối soát)
                        </span>
                    ) : isMatchLive ? (
                        <span className="rounded-full border border-sky-400/50 bg-sky-500/20 px-3 py-1 text-xs font-bold text-sky-300 animate-pulse flex items-center gap-1.5">
                            <span className="h-2 w-2 rounded-full bg-sky-400 animate-ping" />
                            Đang diễn ra (Phút {liveData?.minute ?? item.meta.inPlay?.currentMinute ?? '—'}) - Tỉ số {liveData?.score.home ?? item.meta.inPlay?.currentScore?.home ?? 0}-{liveData?.score.away ?? item.meta.inPlay?.currentScore?.away ?? 0}
                        </span>
                    ) : (
                        <span className="rounded-full border border-amber-400/40 bg-amber-500/15 px-3 py-1 text-xs font-semibold text-amber-300">
                            ⏳ Chưa diễn ra
                        </span>
                    )}

                    <button
                        className="text-xs text-danger-400 hover:text-danger-300 px-2 py-1"
                        onClick={() => onDelete(item.id)}
                        title="Xóa bản ghi"
                    >
                        ✕ Xóa
                    </button>
                </div>
            </div>

            {autoSettledNotice && (
                <div className="mt-2.5 rounded-lg border border-emerald-500/30 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300 font-medium">
                    {autoSettledNotice}
                </div>
            )}

            {item.explanation && (
                <details className="mt-3">
                    <summary className="cursor-pointer text-xs text-violet-400 hover:text-violet-300">
                        Xem phân tích chi tiết (Bước C){item.explanation.verified ? '' : ' — có số chưa khớp'}
                    </summary>
                    <div className="mt-2">
                        <ExplanationPanel explanation={item.explanation} />
                    </div>
                </details>
            )}

            {!item.result ? (
                <div className="mt-3 space-y-3">
                    {/* Banner chờ kết quả hết trận */}
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/25 bg-amber-950/20 p-3 text-xs text-amber-200">
                        <div className="flex items-center gap-2">
                            <span className="font-bold">⏳ Chờ kết quả hết trận</span>
                            <span className="text-neutral-400">
                                (Không tính thắng/thua khi trận chưa kết thúc · Tự động đối soát khi FT)
                            </span>
                        </div>
                        <Button
                            variant="ghost"
                            onClick={() => void checkLiveAndAutoSettle()}
                            disabled={checkingLive}
                            className="text-xs py-1 px-2.5"
                        >
                            {checkingLive ? 'Đang kiểm tra…' : '🔄 Kiểm tra tỷ số trực tiếp'}
                        </Button>
                    </div>

                    {/* Bảng các pick khuyến nghị đã lưu */}
                    <div className="overflow-x-auto rounded-xl border border-white/10">
                        <table className="min-w-full text-xs">
                            <thead className="bg-white/5 text-ink-500 uppercase tracking-wider text-[11px]">
                                <tr>
                                    <th className="px-3 py-2 text-left font-medium">Kèo khuyến nghị</th>
                                    <th className="px-3 py-2 text-left font-medium">Odds vào</th>
                                    <th className="px-3 py-2 text-left font-medium">Edge / EV</th>
                                    <th className="px-3 py-2 text-left font-medium">Xác suất tính toán</th>
                                    <th className="px-3 py-2 text-right font-medium">Kết quả đối chiếu</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                                {item.picks.map((p, idx) => (
                                    <tr key={idx} className="hover:bg-white/[0.02]">
                                        <td className="px-3 py-2 font-medium text-white">
                                            <span className="font-bold text-sky-300">
                                                {formatPickTitle(p, item.meta.home, item.meta.away)}
                                            </span>
                                        </td>
                                        <td className="px-3 py-2 font-mono text-white font-bold">{p.odds.toFixed(2)}</td>
                                        <td className="px-3 py-2 font-mono text-emerald-400">
                                            +{(p.edge * 100).toFixed(1)}% (EV: +{p.ev.toFixed(2)})
                                        </td>
                                        <td className="px-3 py-2 font-mono text-neutral-300">
                                            Thắng {(p.pWin * 100).toFixed(1)}% · Hoàn {(p.pPush * 100).toFixed(1)}%
                                        </td>
                                        <td className="px-3 py-2 text-right">
                                            <span className="rounded bg-neutral-800/80 border border-neutral-700 px-2 py-0.5 text-[11px] font-medium text-neutral-400">
                                                Chờ kết quả hết trận
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                                {item.picks.length === 0 && (
                                    <tr>
                                        <td colSpan={5} className="px-3 py-3 text-center text-neutral-400 italic">
                                            NO BET · Không có kèo nào đạt chuẩn Edge ≥ 5%, EV &gt; 0, Odds ≥ 1.50
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>

                    {/* Tùy chọn nhập tỉ số thủ công */}
                    <details className="text-xs">
                        <summary className="cursor-pointer text-neutral-500 hover:text-neutral-300">
                            Nhập tỉ số thủ công (nếu cần đối soát ngay)
                        </summary>
                        <div className="mt-2.5 grid grid-cols-2 gap-3 sm:grid-cols-4 rounded-xl border border-white/5 bg-black/20 p-3">
                            <div>
                                <p className="mb-1 text-[11px] text-neutral-400">Hiệp 1 — nhà</p>
                                <TextInput value={htHome} onChange={(e) => setHtHome(e.target.value)} inputMode="numeric" />
                            </div>
                            <div>
                                <p className="mb-1 text-[11px] text-neutral-400">Hiệp 1 — khách</p>
                                <TextInput value={htAway} onChange={(e) => setHtAway(e.target.value)} inputMode="numeric" />
                            </div>
                            <div>
                                <p className="mb-1 text-[11px] text-neutral-400">Cả trận — nhà (FT)</p>
                                <TextInput value={ftHome} onChange={(e) => setFtHome(e.target.value)} inputMode="numeric" />
                            </div>
                            <div>
                                <p className="mb-1 text-[11px] text-neutral-400">Cả trận — khách (FT)</p>
                                <TextInput value={ftAway} onChange={(e) => setFtAway(e.target.value)} inputMode="numeric" />
                            </div>
                            <div className="col-span-2 sm:col-span-4 flex items-center gap-2">
                                <Button onClick={() => void submitManual()} disabled={ftHome === '' || ftAway === '' || busy}>
                                    {busy ? 'Đang lưu…' : 'Lưu kết quả & đối soát'}
                                </Button>
                                {err && <p className="text-xs text-danger-400">{err}</p>}
                            </div>
                        </div>
                    </details>
                </div>
            ) : (
                <div className="mt-3 space-y-3">
                    <div className="rounded-xl border border-emerald-500/20 bg-emerald-950/20 px-3.5 py-2.5 text-xs text-emerald-300 flex flex-wrap items-center justify-between gap-2">
                        <span>
                            Tỉ số chính thức:{' '}
                            <strong className="text-white font-mono text-sm">
                                H1 {item.result.htHome} - {item.result.htAway} · FT {item.result.ftHome} - {item.result.ftAway}
                            </strong>
                            {item.result.cornersHome !== undefined && (
                                <span className="ml-2 text-amber-300 font-mono">
                                    (Góc: {item.result.cornersHome + (item.result.cornersAway ?? 0)})
                                </span>
                            )}
                        </span>
                        <span className="font-bold">
                            Lợi nhuận tổng:{' '}
                            <span className={totalProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                                {totalProfit >= 0 ? '+' : ''}{totalProfit.toFixed(2)} đv
                            </span>
                        </span>
                    </div>

                    <div className="overflow-x-auto rounded-xl border border-white/10">
                        <table className="min-w-full text-sm">
                            <thead className="bg-white/5 text-xs text-ink-500 uppercase tracking-wider">
                                <tr>
                                    <th className="px-3 py-2 text-left">Kèo đã chọn</th>
                                    <th className="px-3 py-2 text-left">Odds lúc vào</th>
                                    <th className="px-3 py-2 text-center">Kết quả đối soát</th>
                                    <th className="px-3 py-2 text-right">Lợi nhuận (đv)</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                                {settled?.map((s, idx) => (
                                    <tr key={idx} className="hover:bg-white/[0.02]">
                                        <td className="px-3 py-2 font-medium text-white">
                                            <span className="text-sky-300 font-bold">
                                                {formatPickTitle(s.pick, item.meta.home, item.meta.away)}
                                            </span>
                                        </td>
                                        <td className="px-3 py-2 font-mono text-neutral-300 font-semibold">{s.pick.odds.toFixed(2)}</td>
                                        <td className="px-3 py-2 text-center">
                                            <span className={OUTCOME_CLASS[s.outcome]}>
                                                {OUTCOME_LABEL[s.outcome]}
                                            </span>
                                        </td>
                                        <td
                                            className={`px-3 py-2 text-right font-mono font-bold ${
                                                s.profit > 0
                                                    ? 'text-emerald-400'
                                                    : s.profit < 0
                                                        ? 'text-rose-400'
                                                        : 'text-neutral-400'
                                            }`}
                                        >
                                            {s.profit > 0 ? '+' : ''}
                                            {s.profit.toFixed(2)} đv
                                        </td>
                                    </tr>
                                ))}
                                {settled?.length === 0 && (
                                    <tr>
                                        <td colSpan={4} className="px-3 py-3 text-center text-neutral-400 italic text-xs">
                                            NO BET · Không có kèo nào vào tiền ở trận này.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                            <tfoot>
                                <tr className="border-t border-white/12 bg-white/[0.02]">
                                    <td className="px-3 py-2 font-bold text-white" colSpan={3}>
                                        Tổng lợi nhuận
                                    </td>
                                    <td
                                        className={`px-3 py-2 text-right font-mono font-black text-base ${
                                            totalProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'
                                        }`}
                                    >
                                        {totalProfit >= 0 ? '+' : ''}
                                        {totalProfit.toFixed(2)} đv
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </div>
            )}
        </GlassCard>
    )
}
