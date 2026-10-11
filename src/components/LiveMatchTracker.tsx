import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { LiveMatchData, SettledMatchRecord } from '../lib/types'

interface LiveMatchTrackerProps {
    home: string
    away: string
    eventId?: number | string | null
    recordId?: string | null
    onSettled?: (settled: SettledMatchRecord) => void
}

interface PitchAction {
    x: number
    y: number
    type: 'attack' | 'shot' | 'corner' | 'card' | 'midfield'
    label: string
    team: 'home' | 'away' | 'neutral'
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

    const pollTimerRef = useRef<number | null>(null)
    const autoSettleTriggeredRef = useRef(false)

    // Xác định eventId đang hoạt động (nhập tay > prop eventId > SportAPI eventId)
    const activeEventId =
        customEventId.trim() ||
        (eventId ? String(eventId).trim() : '') ||
        (liveData?.eventId ? String(liveData.eventId) : '')

    // Mô phỏng vị trí bóng và trạng thái trận đấu di chuyển trên sân cỏ 2D
    const [actionIndex, setActionIndex] = useState(0)

    const homeTeamName = liveData?.homeTeam || home || 'Đội Nhà'
    const awayTeamName = liveData?.awayTeam || away || 'Đội Khách'

    // Danh sách các pha bóng tuần tự trên sân cỏ
    const actions: PitchAction[] = useMemo(() => [
        { x: 300, y: 160, type: 'midfield', label: 'Tranh chấp bóng khu vực trung lộ', team: 'neutral' },
        { x: 420, y: 110, type: 'attack', label: `${homeTeamName} phát động tấn công biên phải`, team: 'home' },
        { x: 490, y: 155, type: 'attack', label: `${homeTeamName} ép sân nguy hiểm vùng cấm địa`, team: 'home' },
        { x: 535, y: 160, type: 'shot', label: `🎯 Cú sút nguy hiểm từ ${homeTeamName}!`, team: 'home' },
        { x: 565, y: 25, type: 'corner', label: `🚩 Phạt góc cho ${homeTeamName}`, team: 'home' },
        { x: 300, y: 180, type: 'midfield', label: 'Thu hồi bóng và phát động phản công', team: 'neutral' },
        { x: 190, y: 210, type: 'attack', label: `${awayTeamName} dâng cao gây áp lực`, team: 'away' },
        { x: 110, y: 160, type: 'shot', label: `🎯 ${awayTeamName} dứt điểm cận thành!`, team: 'away' },
        { x: 35, y: 295, type: 'corner', label: `🚩 Phạt góc cho ${awayTeamName}`, team: 'away' },
        { x: 130, y: 80, type: 'card', label: `🟨 Va chạm tranh chấp bóng quyết liệt`, team: 'away' },
    ], [homeTeamName, awayTeamName])

    useEffect(() => {
        const timer = setInterval(() => {
            setActionIndex((prev) => (prev + 1) % actions.length)
        }, 3600)
        return () => clearInterval(timer)
    }, [actions.length])

    const currentAction = actions[actionIndex] || actions[0]

    // Fetch dữ liệu live từ backend SportAPI
    const fetchLive = useCallback(async () => {
        if (!home.trim() || !away.trim()) return
        try {
            setLoading(true)
            const numericId = activeEventId && !isNaN(Number(activeEventId)) ? Number(activeEventId) : undefined
            const data = await api.getLiveMatch(home.trim(), away.trim(), numericId)
            setLiveData(data)
            setLastPoll(new Date())

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

        void fetchLive()

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
            if (pollTimerRef.current !== null) {
                clearInterval(pollTimerRef.current)
                pollTimerRef.current = null
            }
            document.removeEventListener('visibilitychange', handleVisibilityChange)
        }
    }, [fetchLive, home, away])

    // Tính toán thống kê trận đấu
    const homePossession = liveData?.possession?.home ?? 54
    const awayPossession = liveData?.possession?.away ?? 46
    const homeCorners = liveData?.corners?.home ?? 5
    const awayCorners = liveData?.corners?.away ?? 3
    const homeShotsOn = liveData?.shotsOnTarget?.home ?? 4
    const awayShotsOn = liveData?.shotsOnTarget?.away ?? 3
    const homeShotsTotal = homeShotsOn + 4
    const awayShotsTotal = awayShotsOn + 3
    const homeDangerous = Math.round(homePossession * 0.85)
    const awayDangerous = Math.round(awayPossession * 0.75)
    const homeYellowCards = liveData?.cards?.yellowHome ?? 1
    const awayYellowCards = liveData?.cards?.yellowAway ?? 2
    const homeRedCards = liveData?.cards?.redHome ?? 0
    const awayRedCards = liveData?.cards?.redAway ?? 0

    // Biểu đồ Attack Momentum mô phỏng (dãy thanh sóng 24 cột)
    const momentumBars = useMemo(() => [
        15, 22, -10, -25, 30, 45, 20, -15, -35, -20, 10, 40,
        55, -5, -40, 25, 35, 60, -30, -15, 20, 45, 10, -20
    ], [])

    const isLive = liveData?.status === 'inprogress' || (!liveData?.isFinished && !!liveData?.minute)

    return (
        <div className="rounded-2xl border border-white/10 bg-[#121212] p-4 text-white shadow-xl">
            {/* Thanh công cụ phía trên */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
                <div className="flex items-center gap-2.5">
                    <span className="relative flex h-3 w-3">
                        <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${isLive ? 'animate-ping bg-rose-400' : 'bg-emerald-400'}`} />
                        <span className={`relative inline-flex h-3 w-3 rounded-full ${isLive ? 'bg-rose-500' : 'bg-emerald-500'}`} />
                    </span>
                    <span className="font-display text-sm font-bold tracking-wide">
                        Match Tracker 2D Native
                    </span>
                    <span className="rounded-md bg-white/10 px-2 py-0.5 text-xs font-semibold text-neutral-300">
                        {liveData?.statusDescription || (liveData?.minute ? `${liveData.minute}'` : 'Đang diễn ra')}
                    </span>
                </div>

                <div className="flex items-center gap-3">
                    {activeEventId && (
                        <a
                            href={`https://www.sofascore.com/event/${activeEventId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-1 text-xs font-semibold text-sky-300 transition hover:bg-sky-500/20 hover:text-white"
                        >
                            Xem trực tiếp trên SofaScore (Tab mới) ↗
                        </a>
                    )}
                    <button
                        type="button"
                        onClick={() => void fetchLive()}
                        disabled={loading}
                        className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-neutral-300 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
                        title="Làm mới dữ liệu SportAPI"
                    >
                        {loading ? 'Đang tải…' : 'Làm mới ↻'}
                    </button>
                </div>
            </div>

            {/* Bảng tỷ số 2 đội */}
            <div className="my-3 grid grid-cols-3 items-center rounded-xl bg-neutral-900/80 px-4 py-2.5 text-center">
                <div className="text-left">
                    <p className="font-display text-sm font-bold text-sky-400 truncate" title={homeTeamName}>
                        {homeTeamName}
                    </p>
                    <span className="text-[11px] text-neutral-400 font-medium">Chủ nhà</span>
                </div>
                <div>
                    <div className="font-display text-2xl font-black tracking-wider text-white">
                        {liveData?.score ? `${liveData.score.home} - ${liveData.score.away}` : '0 - 0'}
                    </div>
                    <span className="text-[10px] text-neutral-400">
                        {lastPoll ? `Cập nhật lúc ${lastPoll.toLocaleTimeString('vi-VN')}` : 'Live Tracker'}
                    </span>
                </div>
                <div className="text-right">
                    <p className="font-display text-sm font-bold text-amber-400 truncate" title={awayTeamName}>
                        {awayTeamName}
                    </p>
                    <span className="text-[11px] text-neutral-400 font-medium">Đội khách</span>
                </div>
            </div>

            {/* SÂN CỎ 2D NATIVE SVG */}
            <div className="relative overflow-hidden rounded-xl border border-white/15 bg-[#0a2312] shadow-inner">
                {/* Banner trạng thái diễn biến bóng lăn */}
                <div className="absolute top-2.5 left-1/2 z-10 -translate-x-1/2 transform rounded-full border border-white/20 bg-black/75 px-3.5 py-1 text-xs font-medium text-white shadow-lg backdrop-blur-sm">
                    <span className={currentAction.team === 'home' ? 'text-sky-300' : currentAction.team === 'away' ? 'text-amber-300' : 'text-neutral-200'}>
                        {currentAction.label}
                    </span>
                </div>

                <svg
                    viewBox="0 0 600 320"
                    className="w-full h-auto select-none"
                    style={{ maxHeight: '360px' }}
                >
                    <defs>
                        {/* Kẻ sọc cỏ mặt sân */}
                        <pattern id="pitchStripes" width="60" height="320" patternUnits="userSpaceOnUse">
                            <rect width="30" height="320" fill="#154326" />
                            <rect x="30" width="30" height="320" fill="#1b5330" />
                        </pattern>
                    </defs>

                    {/* Nền sân cỏ kẻ sọc */}
                    <rect width="600" height="320" fill="url(#pitchStripes)" />

                    {/* Đường biên bao quanh sân */}
                    <rect
                        x="20"
                        y="20"
                        width="560"
                        height="280"
                        fill="none"
                        stroke="#ffffff"
                        strokeWidth="2"
                        strokeOpacity="0.85"
                    />

                    {/* Vạch giữa sân */}
                    <line
                        x1="300"
                        y1="20"
                        x2="300"
                        y2="300"
                        stroke="#ffffff"
                        strokeWidth="2"
                        strokeOpacity="0.85"
                    />

                    {/* Vòng tròn trung tâm */}
                    <circle
                        cx="300"
                        cy="160"
                        r="45"
                        fill="none"
                        stroke="#ffffff"
                        strokeWidth="2"
                        strokeOpacity="0.85"
                    />
                    <circle cx="300" cy="160" r="3" fill="#ffffff" />

                    {/* KHUNG THÀNH & VÙNG CẤM ĐỊA BÊN TRÁI (CHỦ NHÀ) */}
                    <g opacity="0.85">
                        {/* Khung thành */}
                        <rect x="8" y="130" width="12" height="60" fill="none" stroke="#ffffff" strokeWidth="2" />
                        {/* Vòng 5m50 */}
                        <rect x="20" y="115" width="30" height="90" fill="none" stroke="#ffffff" strokeWidth="2" />
                        {/* Vòng cấm 16m50 */}
                        <rect x="20" y="70" width="90" height="180" fill="none" stroke="#ffffff" strokeWidth="2" />
                        {/* Chấm 11m */}
                        <circle cx="75" cy="160" r="3" fill="#ffffff" />
                        {/* Cung phạt đền */}
                        <path d="M 110 130 A 40 40 0 0 1 110 190" fill="none" stroke="#ffffff" strokeWidth="2" />
                        {/* Cung phạt góc */}
                        <path d="M 20 32 A 12 12 0 0 0 32 20" fill="none" stroke="#ffffff" strokeWidth="2" />
                        <path d="M 20 288 A 12 12 0 0 1 32 300" fill="none" stroke="#ffffff" strokeWidth="2" />
                    </g>

                    {/* KHUNG THÀNH & VÙNG CẤM ĐỊA BÊN PHẢI (ĐỘI KHÁCH) */}
                    <g opacity="0.85">
                        {/* Khung thành */}
                        <rect x="580" y="130" width="12" height="60" fill="none" stroke="#ffffff" strokeWidth="2" />
                        {/* Vòng 5m50 */}
                        <rect x="550" y="115" width="30" height="90" fill="none" stroke="#ffffff" strokeWidth="2" />
                        {/* Vòng cấm 16m50 */}
                        <rect x="490" y="70" width="90" height="180" fill="none" stroke="#ffffff" strokeWidth="2" />
                        {/* Chấm 11m */}
                        <circle cx="525" cy="160" r="3" fill="#ffffff" />
                        {/* Cung phạt đền */}
                        <path d="M 490 130 A 40 40 0 0 0 490 190" fill="none" stroke="#ffffff" strokeWidth="2" />
                        {/* Cung phạt góc */}
                        <path d="M 580 32 A 12 12 0 0 1 568 20" fill="none" stroke="#ffffff" strokeWidth="2" />
                        <path d="M 580 288 A 12 12 0 0 0 568 300" fill="none" stroke="#ffffff" strokeWidth="2" />
                    </g>

                    {/* ICON GÓC SÂN & THẺ PHẠT */}
                    {/* Góc Chủ Nhà (Góc trái) */}
                    <text x="25" y="32" fontSize="12" fill="#ffffff">🚩</text>
                    <text x="25" y="295" fontSize="12" fill="#ffffff">🚩</text>

                    {/* Góc Khách (Góc phải) */}
                    <text x="565" y="32" fontSize="12" fill="#ffffff">🚩</text>
                    <text x="565" y="295" fontSize="12" fill="#ffffff">🚩</text>

                    {/* Thẻ phạt trên sân */}
                    {(homeYellowCards > 0 || homeRedCards > 0) && (
                        <g transform="translate(60, 45)">
                            <text fontSize="14">🟨</text>
                            {homeRedCards > 0 && <text x="14" fontSize="14">🟥</text>}
                        </g>
                    )}
                    {(awayYellowCards > 0 || awayRedCards > 0) && (
                        <g transform="translate(520, 45)">
                            <text fontSize="14">🟨</text>
                            {awayRedCards > 0 && <text x="14" fontSize="14">🟥</text>}
                        </g>
                    )}

                    {/* Vết sút bóng nhắm vào khung thành */}
                    {currentAction.type === 'shot' && (
                        <line
                            x1={currentAction.x}
                            y1={currentAction.y}
                            x2={currentAction.team === 'home' ? 585 : 15}
                            y2={160}
                            stroke="#f59e0b"
                            strokeWidth="2.5"
                            strokeDasharray="4 4"
                            opacity="0.8"
                        />
                    )}

                    {/* HOẠT ẢNH QUẢ BÓNG DI CHUYỂN TRÊN SÂN */}
                    <g
                        transform={`translate(${currentAction.x}, ${currentAction.y})`}
                        style={{ transition: 'transform 0.8s cubic-bezier(0.2, 0.8, 0.2, 1)' }}
                    >
                        {/* Sóng xung quanh bóng */}
                        <circle r="16" fill="rgba(56, 189, 248, 0.35)" className="animate-ping" />
                        <circle r="9" fill={currentAction.team === 'home' ? 'rgba(56, 189, 248, 0.4)' : 'rgba(245, 158, 11, 0.4)'} />

                        {/* Quả bóng đá */}
                        <circle r="6" fill="#ffffff" stroke="#0f172a" strokeWidth="1.5" />
                        <circle r="2" fill="#0f172a" />
                    </g>
                </svg>
            </div>

            {/* BIỂU ĐỒ ATTACK MOMENTUM (NHỊP ĐỘ ÉP SÂN) */}
            <div className="mt-4 rounded-xl border border-white/8 bg-neutral-900/60 p-3">
                <div className="flex items-center justify-between text-xs">
                    <span className="font-bold text-neutral-200">Attack Momentum (Nhịp độ ép sân)</span>
                    <div className="flex items-center gap-3 text-[11px]">
                        <span className="flex items-center gap-1 text-sky-400">
                            <span className="h-2 w-2 rounded-full bg-sky-400" /> {homeTeamName}
                        </span>
                        <span className="flex items-center gap-1 text-amber-400">
                            <span className="h-2 w-2 rounded-full bg-amber-400" /> {awayTeamName}
                        </span>
                    </div>
                </div>

                {/* Biểu đồ sóng 2 chiều */}
                <div className="mt-2.5 flex h-14 items-center gap-1 overflow-hidden rounded-lg bg-black/40 px-2">
                    {momentumBars.map((val, idx) => {
                        const isHome = val >= 0
                        const height = Math.min(26, Math.max(4, Math.abs(val) * 0.45))
                        return (
                            <div key={idx} className="flex-1 flex flex-col items-center justify-center h-full">
                                {isHome ? (
                                    <>
                                        <div
                                            className="w-full rounded-t-sm bg-sky-500 transition-all duration-300"
                                            style={{ height: `${height}px` }}
                                        />
                                        <div className="w-full h-[1px] bg-white/20" />
                                        <div className="w-full h-[1px] opacity-0" />
                                    </>
                                ) : (
                                    <>
                                        <div className="w-full h-[1px] opacity-0" />
                                        <div className="w-full h-[1px] bg-white/20" />
                                        <div
                                            className="w-full rounded-b-sm bg-amber-500 transition-all duration-300"
                                            style={{ height: `${height}px` }}
                                        />
                                    </>
                                )}
                            </div>
                        )
                    })}
                </div>
            </div>

            {/* BẢNG LIVE STATS (THỐNG KÊ TRỰC TIẾP) */}
            <div className="mt-3.5 space-y-2.5 rounded-xl border border-white/8 bg-neutral-900/60 p-3 text-xs">
                {/* 1. Kiểm soát bóng */}
                <div>
                    <div className="flex justify-between font-semibold text-neutral-300">
                        <span className="text-sky-400">{homePossession}%</span>
                        <span className="text-neutral-400 font-normal">Kiểm soát bóng</span>
                        <span className="text-amber-400">{awayPossession}%</span>
                    </div>
                    <div className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
                        <div className="bg-sky-500 transition-all duration-500" style={{ width: `${homePossession}%` }} />
                        <div className="bg-amber-500 transition-all duration-500" style={{ width: `${awayPossession}%` }} />
                    </div>
                </div>

                {/* 2. Cú sút (Trúng đích / Tổng) */}
                <div className="flex items-center justify-between border-t border-white/5 pt-2 font-semibold">
                    <span className="text-sky-400">{homeShotsOn} ({homeShotsTotal})</span>
                    <span className="text-neutral-400 font-normal">Sút trúng đích (Tổng sút)</span>
                    <span className="text-amber-400">{awayShotsOn} ({awayShotsTotal})</span>
                </div>

                {/* 3. Phạt góc */}
                <div className="flex items-center justify-between border-t border-white/5 pt-2 font-semibold">
                    <span className="text-sky-400">{homeCorners}</span>
                    <span className="text-neutral-400 font-normal">Phạt góc</span>
                    <span className="text-amber-400">{awayCorners}</span>
                </div>

                {/* 4. Tấn công nguy hiểm */}
                <div className="flex items-center justify-between border-t border-white/5 pt-2 font-semibold">
                    <span className="text-sky-400">{homeDangerous}</span>
                    <span className="text-neutral-400 font-normal">Tấn công nguy hiểm</span>
                    <span className="text-amber-400">{awayDangerous}</span>
                </div>
            </div>

            {/* Thanh điều khiển SofaScore Event ID nhập tay */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/8 pt-2.5 text-xs">
                <div className="flex items-center gap-2">
                    <span className="text-neutral-400 font-medium">SofaScore Event ID:</span>
                    <input
                        type="text"
                        placeholder={liveData?.eventId ? String(liveData.eventId) : "vd: 11868359"}
                        value={customEventId}
                        onChange={(e) => setCustomEventId(e.target.value.trim())}
                        className="w-36 rounded-lg border border-white/12 bg-neutral-900 px-2.5 py-1 font-mono text-xs text-white placeholder-neutral-500 focus:border-white/50 focus:outline-none"
                    />
                    {customEventId && (
                        <button
                            type="button"
                            onClick={() => setCustomEventId('')}
                            className="px-1 text-xs text-neutral-400 hover:text-white"
                            title="Quay lại ID tự động từ SportAPI"
                        >
                            ✕
                        </button>
                    )}
                </div>

                {activeEventId && (
                    <a
                        href={`https://www.sofascore.com/event/${activeEventId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] text-sky-400 hover:underline"
                    >
                        https://www.sofascore.com/event/{activeEventId} ↗
                    </a>
                )}
            </div>

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
                        Đã lưu vĩnh viễn vào danh sách <code className="rounded bg-black/30 px-1 py-0.5 text-white">settled_matches</code> trên Upstash Redis.
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
