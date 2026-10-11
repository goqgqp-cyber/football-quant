import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { LiveMatchData, SettledMatchRecord } from '../lib/types'

interface LiveMatchTrackerProps {
    home: string
    away: string
    eventId?: number | string | null
    recordId?: string | null
    onSettled?: (settled: SettledMatchRecord) => void
}

export function LiveMatchTracker({ home, away, eventId, recordId, onSettled }: LiveMatchTrackerProps) {
    const [liveData, setLiveData] = useState<LiveMatchData | null>(null)
    const [loading, setLoading] = useState(false)
    const [lastPoll, setLastPoll] = useState<Date | null>(null)
    const [autoSettled, setAutoSettled] = useState<SettledMatchRecord | null>(null)
    const [settling, setSettling] = useState(false)
    const [settleError, setSettleError] = useState<string | null>(null)

    // SofaScore Event ID nhập tay hoặc nhận từ SportAPI
    const [customEventId, setCustomEventId] = useState<string>('')
    const [showEmbed, setShowEmbed] = useState<boolean>(true)

    const pollTimerRef = useRef<number | null>(null)
    const autoSettleTriggeredRef = useRef(false)

    // Xác định eventId đang hoạt động (nhập tay > prop eventId > SportAPI eventId)
    const activeEventId =
        customEventId.trim() ||
        (eventId ? String(eventId).trim() : '') ||
        (liveData?.eventId ? String(liveData.eventId) : '')

    const fetchLive = useCallback(async () => {
        if (!home.trim() || !away.trim()) return
        try {
            setLoading(true)
            const numericId = activeEventId && !isNaN(Number(activeEventId)) ? Number(activeEventId) : undefined
            const data = await api.getLiveMatch(home.trim(), away.trim(), numericId)
            setLiveData(data)
            setLastPoll(new Date())

            // Kiểm tra tự động đối soát (Auto-settle) khi trận đấu kết thúc (status = 'finished' / 'FT')
            if (
                data.found &&
                data.isFinished &&
                recordId &&
                !autoSettleTriggeredRef.current &&
                !autoSettled
            ) {
                autoSettleTriggeredRef.current = true
                setSettling(true)
                try {
                    const res = await api.autoSettle({
                        recordId,
                        eventId: data.eventId,
                        home: data.homeTeam || home,
                        away: data.awayTeam || away,
                    })
                    setAutoSettled(res.settledMatch)
                    onSettled?.(res.settledMatch)
                } catch (err) {
                    setSettleError(
                        err instanceof Error ? err.message : 'Tự động đối soát thất bại.',
                    )
                } finally {
                    setSettling(false)
                }
            }
        } catch {
            // Không ngắt UI khi mạng tạm chập chờn
        } finally {
            setLoading(false)
        }
    }, [home, away, activeEventId, recordId, autoSettled, onSettled])

    // Polling tự động chu kỳ 20 giây/lần
    useEffect(() => {
        if (!home.trim() || !away.trim()) {
            setLiveData(null)
            return
        }

        autoSettleTriggeredRef.current = false
        setAutoSettled(null)
        setSettleError(null)

        // Gọi ngay lập tức lần đầu
        void fetchLive()

        // Lập lịch 20 giây một lần
        pollTimerRef.current = window.setInterval(() => {
            if (document.visibilityState === 'visible') {
                void fetchLive()
            }
        }, 20000)

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                void fetchLive()
            }
        }
        document.addEventListener('visibilitychange', handleVisibilityChange)

        return () => {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current)
            document.removeEventListener('visibilitychange', handleVisibilityChange)
        }
    }, [home, away, fetchLive])

    if (!home.trim() || !away.trim()) return null

    // Trích xuất các chỉ số
    const possessionHome = liveData?.possession.home ?? 50
    const possessionAway = liveData?.possession.away ?? 50
    const cornersHome = liveData?.corners.home ?? 0
    const cornersAway = liveData?.corners.away ?? 0
    const totalCorners = liveData?.corners.total ?? cornersHome + cornersAway
    const shotsHome = liveData?.shotsOnTarget.home ?? 0
    const shotsAway = liveData?.shotsOnTarget.away ?? 0
    const yellowHome = liveData?.cards.yellowHome ?? 0
    const yellowAway = liveData?.cards.yellowAway ?? 0
    const redHome = liveData?.cards.redHome ?? 0
    const redAway = liveData?.cards.redAway ?? 0

    const isLive = liveData?.status === 'inprogress'
    const isFinished = liveData?.isFinished

    return (
        <div className="relative overflow-hidden rounded-xl border border-white/16 bg-gradient-to-b from-neutral-900/95 to-neutral-950/98 p-4 shadow-2xl">
            {/* Header thanh trạng thái live */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 pb-3">
                <div className="flex items-center gap-2">
                    {isLive ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-500/30 bg-rose-500/10 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wider text-rose-400">
                            <span className="relative flex h-2 w-2">
                                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75"></span>
                                <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500"></span>
                            </span>
                            LIVE · {typeof liveData?.minute === 'number' ? `${liveData.minute}'` : liveData?.minute || "Đang đá"}
                        </span>
                    ) : isFinished ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wider text-emerald-400">
                            🏁 HẾT GIỜ (FT)
                        </span>
                    ) : liveData?.found ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wider text-amber-400">
                            ⏳ {liveData?.statusDescription || 'Sắp diễn ra'}
                        </span>
                    ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-xs font-semibold text-slate-300">
                            📡 SportAPI Live Tracker
                        </span>
                    )}

                    {liveData?.league && (
                        <span className="text-xs text-slate-300 truncate max-w-[200px]">
                            • {liveData.league}
                        </span>
                    )}
                </div>

                <div className="flex items-center gap-2 text-xs text-slate-400">
                    {lastPoll && (
                        <span>
                            Cập nhật: {lastPoll.toLocaleTimeString('vi-VN')}
                        </span>
                    )}
                    <button
                        type="button"
                        onClick={() => void fetchLive()}
                        disabled={loading}
                        className="rounded p-1 hover:bg-white/5 text-slate-400 hover:text-white transition"
                        title="Làm mới ngay"
                    >
                        🔄 {loading ? '...' : ''}
                    </button>
                </div>
            </div>

            {/* Bảng tỷ số trực tiếp */}
            {liveData?.found ? (
                <div className="my-3">
                    <div className="grid grid-cols-7 items-center text-center">
                        <div className="col-span-3 text-right pr-3">
                            <p className="font-bold text-base text-white truncate">{liveData.homeTeam || home}</p>
                            <div className="flex justify-end gap-1 mt-0.5">
                                {yellowHome > 0 && (
                                    <span className="inline-block w-2.5 h-3.5 bg-yellow-400 rounded-xs shadow-xs" title={`${yellowHome} thẻ vàng`} />
                                )}
                                {redHome > 0 && (
                                    <span className="inline-block w-2.5 h-3.5 bg-red-600 rounded-xs shadow-xs" title={`${redHome} thẻ đỏ`} />
                                )}
                            </div>
                        </div>

                        <div className="col-span-1 flex flex-col items-center justify-center rounded-lg bg-white/5 px-3 py-1.5 border border-white/10">
                            <span className="font-mono text-2xl font-black tracking-tight text-white">
                                {liveData.score.home} - {liveData.score.away}
                            </span>
                            {liveData.periodScore?.htHome !== undefined && (
                                <span className="text-[10px] text-slate-400">
                                    HT: {liveData.periodScore.htHome} - {liveData.periodScore.htAway}
                                </span>
                            )}
                        </div>

                        <div className="col-span-3 text-left pl-3">
                            <p className="font-bold text-base text-white truncate">{liveData.awayTeam || away}</p>
                            <div className="flex justify-start gap-1 mt-0.5">
                                {yellowAway > 0 && (
                                    <span className="inline-block w-2.5 h-3.5 bg-yellow-400 rounded-xs shadow-xs" title={`${yellowAway} thẻ vàng`} />
                                )}
                                {redAway > 0 && (
                                    <span className="inline-block w-2.5 h-3.5 bg-red-600 rounded-xs shadow-xs" title={`${redAway} thẻ đỏ`} />
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Thanh chỉ số trực quan (Comparison Bars) */}
                    <div className="mt-4 space-y-2.5 rounded-lg bg-neutral-900/60 p-3 border border-white/8">
                        {/* 1. Kiểm soát bóng */}
                        <div>
                            <div className="flex justify-between text-xs font-medium text-neutral-300 mb-1">
                                <span className="font-bold text-indigo-400">{possessionHome}%</span>
                                <span className="text-slate-300 font-normal">Kiểm soát bóng</span>
                                <span className="font-bold text-indigo-400">{possessionAway}%</span>
                            </div>
                            <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                                <div
                                    className="bg-indigo-500 transition-all duration-500"
                                    style={{ width: `${possessionHome}%` }}
                                />
                                <div
                                    className="bg-indigo-700 transition-all duration-500"
                                    style={{ width: `${possessionAway}%` }}
                                />
                            </div>
                        </div>

                        {/* 2. Sút trúng đích */}
                        <div>
                            <div className="flex justify-between text-xs font-medium text-neutral-300 mb-1">
                                <span className="font-bold text-emerald-400">{shotsHome}</span>
                                <span className="text-slate-300 font-normal">Sút trúng đích</span>
                                <span className="font-bold text-emerald-400">{shotsAway}</span>
                            </div>
                            <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                                <div
                                    className="bg-emerald-500 transition-all duration-500"
                                    style={{
                                        width: `${shotsHome + shotsAway > 0 ? (shotsHome / (shotsHome + shotsAway)) * 100 : 50}%`,
                                    }}
                                />
                                <div
                                    className="bg-emerald-700 transition-all duration-500"
                                    style={{
                                        width: `${shotsHome + shotsAway > 0 ? (shotsAway / (shotsHome + shotsAway)) * 100 : 50}%`,
                                    }}
                                />
                            </div>
                        </div>

                        {/* 3. Phạt góc */}
                        <div>
                            <div className="flex justify-between text-xs font-medium text-neutral-300 mb-1">
                                <span className="font-bold text-amber-400">{cornersHome}</span>
                                <span className="text-slate-300 font-normal">
                                    Phạt góc (Tổng: <strong className="text-white">{totalCorners}</strong>)
                                </span>
                                <span className="font-bold text-amber-400">{cornersAway}</span>
                            </div>
                            <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                                <div
                                    className="bg-amber-500 transition-all duration-500"
                                    style={{
                                        width: `${totalCorners > 0 ? (cornersHome / totalCorners) * 100 : 50}%`,
                                    }}
                                />
                                <div
                                    className="bg-amber-700 transition-all duration-500"
                                    style={{
                                        width: `${totalCorners > 0 ? (cornersAway / totalCorners) * 100 : 50}%`,
                                    }}
                                />
                            </div>
                        </div>
                    </div>
                </div>
            ) : (
                <div className="my-2 py-3 text-center text-xs text-slate-300">
                    <p>Đang tìm kiếm luồng dữ liệu trực tiếp cho trận <strong className="text-white">{home}</strong> vs <strong className="text-white">{away}</strong>...</p>
                    <p className="mt-1 text-[11px] text-slate-400">(Tự động làm mới mỗi 20s qua SportAPI RapidAPI)</p>
                </div>
            )}

            {/* Thanh điều khiển SofaScore Event ID */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/8 pt-2.5 text-xs">
                <div className="flex items-center gap-2">
                    <span className="text-slate-400 font-medium">SofaScore Event ID:</span>
                    <input
                        type="text"
                        placeholder={liveData?.eventId ? String(liveData.eventId) : "vd: 11868359"}
                        value={customEventId}
                        onChange={(e) => setCustomEventId(e.target.value.trim())}
                        className="rounded-lg border border-white/12 bg-neutral-900/90 px-2.5 py-1 text-xs text-white placeholder-slate-500 focus:border-white/50 focus:outline-none w-36 font-mono shadow-inner"
                    />
                    {customEventId && (
                        <button
                            type="button"
                            onClick={() => setCustomEventId('')}
                            className="text-slate-400 hover:text-white text-xs px-1"
                            title="Quay lại ID tự động từ SportAPI"
                        >
                            ✕
                        </button>
                    )}
                </div>

                {activeEventId && (
                    <span className="text-[11px] text-slate-400 flex items-center gap-1">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                        WebSocket SofaScore trực tiếp · 0s độ trễ
                    </span>
                )}
            </div>

            {/* SofaScore Attack Momentum & Live Match Radar Iframe */}
            {activeEventId && (
                <div className="mt-3.5 overflow-hidden rounded-xl border border-white/14 bg-black shadow-2xl">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-neutral-900/90 px-3.5 py-2">
                        <div className="flex items-center gap-2">
                            <span className="relative flex h-2 w-2">
                                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75"></span>
                                <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500"></span>
                            </span>
                            <span className="text-xs font-bold text-white tracking-wide">
                                SofaScore Live Attack Momentum
                            </span>
                            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-mono text-neutral-300">
                                ID: {activeEventId}
                            </span>
                        </div>
                        <div className="flex items-center gap-3">
                            <button
                                type="button"
                                onClick={() => setShowEmbed((v) => !v)}
                                className="text-[11px] font-medium text-slate-300 hover:text-white transition"
                            >
                                {showEmbed ? 'Thu gọn ▲' : 'Mở rộng ▼'}
                            </button>
                            <a
                                href={`https://www.sofascore.com/event/${activeEventId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[11px] text-indigo-300 hover:text-indigo-200 underline transition"
                            >
                                Xem trực tiếp trên SofaScore (Tab mới) ↗
                            </a>
                        </div>
                    </div>
                    {showEmbed && (
                        <div className="relative w-full bg-black overflow-hidden" style={{ minHeight: '320px' }}>
                            <iframe
                                id={`sofascore-embed-${activeEventId}`}
                                src={`https://widgets.sofascore.com/embed/attack-momentum?id=${activeEventId}&widgetTitle=Attack%20Momentum&v=2`}
                                width="100%"
                                height="320px"
                                frameBorder="0"
                                scrolling="no"
                                style={{ border: "none", overflow: "hidden" }}
                                title={`SofaScore Live Attack Momentum - ${home} vs ${away}`}
                                loading="lazy"
                            />
                            <div className="flex items-center justify-between border-t border-white/10 bg-neutral-900/80 px-3.5 py-2 text-xs">
                                <span className="text-[11px] text-slate-400">
                                    Nếu biểu đồ không tải hoặc bị chặn kết nối:
                                </span>
                                <a
                                    href={`https://www.sofascore.com/event/${activeEventId}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 font-semibold text-indigo-300 hover:text-indigo-100 hover:underline transition"
                                >
                                    Xem trực tiếp trên SofaScore (Tab mới) ↗
                                </a>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Thông báo Auto-Settle khi kết thúc trận */}
            {autoSettled && (
                <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-950/40 p-3 text-xs text-emerald-300">
                    <div className="flex items-center justify-between">
                        <span className="font-bold">
                            ✨ ĐÃ TỰ ĐỘNG ĐỐI SOÁT CUỐI TRẬN (AUTO-SETTLE)
                        </span>
                        <span className="rounded bg-emerald-500/20 px-2 py-0.5 font-bold uppercase">
                            {autoSettled.summaryOutcome === 'win'
                                ? '🏆 THẮNG (WIN)'
                                : autoSettled.summaryOutcome === 'lose'
                                    ? '❌ THUA (LOSS)'
                                    : '🤝 HÒA (PUSH)'}
                        </span>
                    </div>
                    <p className="mt-1 text-emerald-200/80">
                        Tỷ số FT: <strong>{autoSettled.score.ftHome} - {autoSettled.score.ftAway}</strong>
                        {autoSettled.corners && ` · Phạt góc: ${autoSettled.corners.total} (${autoSettled.corners.home}-${autoSettled.corners.away})`}
                        {' '}· Lợi nhuận: <strong className={autoSettled.totalProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                            {autoSettled.totalProfit >= 0 ? '+' : ''}{autoSettled.totalProfit.toFixed(2)} đv
                        </strong>
                    </p>
                    <p className="mt-1 text-[11px] text-emerald-400/70">
                        Đã lưu vĩnh viễn vào danh sách <code className="bg-black/30 px-1 py-0.5 rounded text-white">settled_matches</code> trên Upstash Redis.
                    </p>
                </div>
            )}

            {settling && (
                <div className="mt-2 text-center text-xs text-amber-300 animate-pulse">
                    ⏳ Trận đấu đã FT — Đang tự động đối soát kèo và lưu vào Redis...
                </div>
            )}

            {settleError && (
                <div className="mt-2 text-center text-xs text-rose-400">
                    ⚠️ {settleError}
                </div>
            )}
        </div>
    )
}
