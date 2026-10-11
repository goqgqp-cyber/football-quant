/**
 * LiveMatchTracker — Match Tracker 2D Native SVG (100% Số liệu thật từ API-Football)
 * ─────────────────────────────────────────────────────────────────────────────
 * • Kết nối trực tiếp API-Football (thông qua server proxy /api/football có cache Redis).
 * • Tuân thủ triệt để One-Shot Snapshot workflow: Zero background polling, Zero WebSocket.
 * • Tuyệt đối KHÔNG DÙNG dữ liệu ngẫu nhiên (Math.random) hay mock animation giả lập.
 * • Hiển thị 100% số liệu thực tế: Tỉ số, Cầm bóng, Phạt góc, Thẻ phạt, Sút trúng đích / Tổng sút, Phạm lỗi.
 * • Diễn biến trên sân (bóng & sự kiện) phản ánh chính xác các incidents thực tế từ API-Football.
 */
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

interface PitchAction {
    x: number
    y: number
    type: 'attack' | 'shot' | 'corner' | 'card' | 'goal' | 'midfield' | 'sub'
    label: string
    team: 'home' | 'away' | 'neutral'
}

export interface FootballIncident {
    incidentType: string
    isHome?: boolean
    time?: number
    addedTime?: number
    text?: string
    homeScore?: number
    awayScore?: number
    player?: { name?: string }
    incidentClass?: string
    [key: string]: unknown
}

/** Chuyển đổi sự kiện thật từ API-Football thành hành động trực quan trên sân 2D */
function incidentToPitchAction(
    inc: FootballIncident,
    homeName: string,
    awayName: string,
): PitchAction {
    const isHome = inc.isHome !== false
    const team = isHome ? ('home' as const) : ('away' as const)
    const name = isHome ? homeName : awayName
    const minute = inc.time ? `${inc.time}'` : ''
    const playerName = inc.player?.name ? ` (${inc.player.name})` : ''

    // Tọa độ cố định chuẩn xác trên sân SVG (viewBox: 600 x 320)
    // Đội nhà tấn công sang bên phải (x lớn), Đội khách tấn công sang bên trái (x nhỏ)
    switch (inc.incidentType) {
        case 'goal':
            return {
                x: isHome ? 575 : 25,
                y: 160,
                type: 'goal',
                label: `⚽ ${minute} VÀO! ${name} GHI BÀN!${playerName}`,
                team,
            }
        case 'corner':
            return {
                x: isHome ? 565 : 35,
                y: isHome ? 32 : 295,
                type: 'corner',
                label: `🚩 ${minute} Phạt góc cho ${name}`,
                team,
            }
        case 'shot':
            return {
                x: isHome ? 515 : 85,
                y: 160,
                type: 'shot',
                label: `🎯 ${minute} Cú sút ${inc.text === 'on-target' ? 'trúng đích' : ''} — ${name}${playerName}`,
                team,
            }
        case 'card':
            return {
                x: isHome ? 220 : 380,
                y: 160,
                type: 'card',
                label: `🟨 ${minute} Thẻ phạt — ${name}${playerName}`,
                team,
            }
        case 'substitution':
        case 'sub':
            return {
                x: 300,
                y: 290,
                type: 'sub',
                label: `🔄 ${minute} Thay người — ${name}${playerName}`,
                team,
            }
        case 'period':
            return {
                x: 300,
                y: 160,
                type: 'midfield',
                label: `⏱ ${inc.text || 'Chuyển hiệp thi đấu'}`,
                team: 'neutral',
            }
        default:
            return {
                x: isHome ? 420 : 180,
                y: 160,
                type: 'attack',
                label: `${minute} ${name} phát động tấn công${playerName}`,
                team,
            }
    }
}

/** Tính toán delta cho Attack Momentum từ incident thật */
function incidentToMomentumDelta(inc: FootballIncident): number {
    const base = inc.isHome !== false ? 1 : -1
    switch (inc.incidentType) {
        case 'goal': return base * 60
        case 'shot': return base * 35
        case 'corner': return base * 25
        case 'attack': return base * 18
        case 'card': return base * -12
        default: return base * 8
    }
}

/** Xây dựng 24 thanh Attack Momentum thực tế từ danh sách incidents của API-Football */
function buildMomentumFromIncidents(incs: FootballIncident[]): number[] {
    const bars: number[] = Array(24).fill(0)
    if (!incs || incs.length === 0) return bars

    for (const inc of incs) {
        const minute = Number(inc.time) || 0
        const slot = Math.min(23, Math.max(0, Math.floor((minute / 95) * 24)))
        const delta = incidentToMomentumDelta(inc)
        bars[slot] = Math.max(-65, Math.min(65, bars[slot] + delta))
    }
    return bars
}

export function LiveMatchTracker({ home, away, eventId, recordId, onSettled }: LiveMatchTrackerProps) {
    const [liveData, setLiveData] = useState<LiveMatchData | null>(null)
    const [loading, setLoading] = useState(false)
    const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
    const [autoSettled, setAutoSettled] = useState<SettledMatchRecord | null>(null)
    const [settling, setSettling] = useState(false)
    const [settleError, setSettleError] = useState<string | null>(null)

    // API-Football Fixture ID
    const [customFixtureId, setCustomFixtureId] = useState<string>('')
    const [recentIncidents, setRecentIncidents] = useState<FootballIncident[]>([])

    const autoSettleTriggeredRef = useRef(false)

    const activeFixtureId =
        customFixtureId.trim() ||
        (eventId ? String(eventId).trim() : '') ||
        (liveData?.eventId ? String(liveData.eventId) : '')

    // Ưu tiên tên đội từ props (AnalyzePage / OCR / API-Football)
    const homeTeamName = (home && home.trim()) || (liveData?.homeTeam && liveData.homeTeam.trim()) || 'Đội Nhà'
    const awayTeamName = (away && away.trim()) || (liveData?.awayTeam && liveData.awayTeam.trim()) || 'Đội Khách'

    // Reset dữ liệu live khi đổi trận đấu
    useEffect(() => {
        setLiveData(null)
        setRecentIncidents([])
        setCurrentAction({
            x: 300,
            y: 160,
            type: 'midfield',
            label: `Trận đấu: ${home || 'Đội Nhà'} vs ${away || 'Đội Khách'}`,
            team: 'neutral',
        })
    }, [home, away])

    // ─── Pitch action state (Phản ánh 100% sự kiện thật từ API-Football) ──────
    const [currentAction, setCurrentAction] = useState<PitchAction>({
        x: 300,
        y: 160,
        type: 'midfield',
        label: `Trận đấu: ${home || 'Đội Nhà'} vs ${away || 'Đội Khách'}`,
        team: 'neutral',
    })

    // ─── Attack Momentum bars (100% tính từ incidents thật) ────────────────
    const [momentumBars, setMomentumBars] = useState<number[]>(() => Array(24).fill(0))

    // ─── Live stats: 100% số liệu thật, không sinh số ngẫu nhiên ─────────
    const homePossession = liveData?.possession?.home ?? 50
    const awayPossession = liveData?.possession?.away ?? 50
    const homeCorners = liveData?.corners?.home ?? 0
    const awayCorners = liveData?.corners?.away ?? 0
    const totalCorners = liveData?.corners?.total ?? (homeCorners + awayCorners)
    const homeCards = (liveData?.cards?.yellowHome ?? 0) + (liveData?.cards?.redHome ?? 0)
    const awayCards = (liveData?.cards?.yellowAway ?? 0) + (liveData?.cards?.redAway ?? 0)
    const homeShots = liveData?.shotsTotal?.home ?? liveData?.shotsOnTarget?.home ?? 0
    const awayShots = liveData?.shotsTotal?.away ?? liveData?.shotsOnTarget?.away ?? 0
    const homeSOT = liveData?.shotsOnTarget?.home ?? 0
    const awaySOT = liveData?.shotsOnTarget?.away ?? 0
    const isLive = liveData?.status === 'inprogress'

    // Cập nhật mô tả hành động trực quan trên sân từ dữ liệu thật
    useEffect(() => {
        if (!liveData || !liveData.found) {
            setCurrentAction({
                x: 300,
                y: 160,
                type: 'midfield',
                label: 'Chưa có thông tin trận đấu',
                team: 'neutral',
            })
            return
        }

        if (liveData.isFinished) {
            setCurrentAction({
                x: 300,
                y: 160,
                type: 'midfield',
                label: `Còi mãn cuộc · Trận đấu kết thúc (FT: ${liveData.score.home}-${liveData.score.away})`,
                team: 'neutral',
            })
            return
        }

        if (liveData.status === 'notstarted') {
            setCurrentAction({
                x: 300,
                y: 160,
                type: 'midfield',
                label: 'Trận đấu chưa diễn ra · Chờ bóng lăn',
                team: 'neutral',
            })
            return
        }

        // Trận đang diễn ra: nếu có sự kiện gần nhất, định vị bóng tại đó
        if (recentIncidents.length > 0) {
            const latest = recentIncidents[0]
            setCurrentAction(incidentToPitchAction(latest, homeTeamName, awayTeamName))
        } else {
            setCurrentAction({
                x: 300,
                y: 160,
                type: 'midfield',
                label: `Đang thi đấu (${liveData.minute ? `${liveData.minute}'` : 'Live'})`,
                team: 'neutral',
            })
        }
    }, [liveData, recentIncidents, homeTeamName, awayTeamName])

    // ─── Auto-settle logic ────────────────────────────────────────────────────
    const triggerAutoSettle = useCallback(async (data: LiveMatchData) => {
        if (!recordId || autoSettleTriggeredRef.current || autoSettled) return
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
            setSettleError(err instanceof Error ? err.message : 'Tự động đối soát thất bại.')
        } finally {
            setSettling(false)
        }
    }, [recordId, autoSettled, home, away, onSettled])

    // ─── HTTP fetch Snapshot (One-shot Snapshot từ API-Football) ──────────────
    const fetchLiveSnapshot = useCallback(async () => {
        if (!home.trim() && !away.trim() && !activeFixtureId) return
        try {
            setLoading(true)
            const numericId = activeFixtureId && !isNaN(Number(activeFixtureId)) ? Number(activeFixtureId) : undefined
            let data: LiveMatchData | null = null

            if (numericId) {
                try {
                    const fullLive = await api.footballFixtureLive(numericId)
                    if (fullLive?.found) {
                        const mStats = fullLive.matchStats
                        data = {
                            found: true,
                            eventId: fullLive.eventId,
                            fixtureId: fullLive.fixtureId,
                            homeTeam: fullLive.homeTeam || homeTeamName,
                            awayTeam: fullLive.awayTeam || awayTeamName,
                            league: fullLive.league,
                            status: fullLive.status,
                            statusDescription: fullLive.statusDescription,
                            minute: fullLive.minute,
                            score: fullLive.score,
                            periodScore: fullLive.periodScore,
                            corners: mStats?.corners ?? { home: 0, away: 0, total: 0 },
                            cards: mStats?.cards ?? { yellowHome: 0, yellowAway: 0, redHome: 0, redAway: 0 },
                            shotsOnTarget: mStats?.shotsOnTarget ?? { home: 0, away: 0 },
                            shotsTotal: mStats?.shotsTotal ?? { home: 0, away: 0 },
                            possession: mStats?.possession ?? { home: 50, away: 50 },
                            fouls: mStats?.fouls ?? { home: 0, away: 0 },
                            accuratePasses: mStats?.accuratePasses ?? { home: 0, away: 0 },
                            isFinished: fullLive.isFinished,
                            lastUpdated: fullLive.lastUpdated || Date.now(),
                        }
                        if (fullLive.incidents && fullLive.incidents.length > 0) {
                            const incs = fullLive.incidents as FootballIncident[]
                            setRecentIncidents([...incs].reverse())
                            setMomentumBars(buildMomentumFromIncidents(incs))
                        }
                    }
                } catch {
                    /* fallback to getLiveMatch */
                }
            }

            if (!data) {
                data = await api.getLiveMatch(home.trim(), away.trim(), numericId)
            }

            setLiveData(data)
            setLastUpdate(new Date())

            if (data?.found && data.isFinished) {
                void triggerAutoSettle(data)
            }
        } catch {
            // Mạng chập chờn — giữ data cũ, không làm gián đoạn UI
        } finally {
            setLoading(false)
        }
    }, [home, away, activeFixtureId, homeTeamName, awayTeamName, triggerAutoSettle])

    // ─── One-shot Effect: Chỉ fetch khi mount hoặc thay đổi trận (Zero polling) ──
    useEffect(() => {
        if (!home.trim() && !away.trim() && !activeFixtureId) {
            setLiveData(null)
            return
        }

        autoSettleTriggeredRef.current = false
        setAutoSettled(null)
        setSettleError(null)

        // One-shot snapshot
        void fetchLiveSnapshot()
    }, [home, away, activeFixtureId, fetchLiveSnapshot])

    if (!liveData || !liveData.found || (!home.trim() && !away.trim() && !activeFixtureId)) {
        return (
            <div className="rounded-xl border border-dashed border-white/10 bg-[#111111]/80 p-8 text-center text-neutral-400">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-white/5 text-xl">
                    ⚽
                </div>
                <h4 className="font-display text-sm font-semibold text-neutral-200">
                    Chưa có dữ liệu trận đấu. Hãy tải ảnh bảng cược để bắt đầu phân tích.
                </h4>
                {loading && (
                    <p className="mt-2 text-xs text-sky-400 animate-pulse">
                        Đang kết nối và lấy dữ liệu trận đấu từ API-Football…
                    </p>
                )}
            </div>
        )
    }

    return (
        <div className="rounded-xl border border-white/10 bg-[#111111] p-4 text-white shadow-lg">

            {/* ── Toolbar ── */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
                <div className="flex items-center gap-2.5">
                    <span className="relative flex h-3 w-3">
                        <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${isLive ? 'animate-ping bg-rose-400' : 'bg-emerald-400'}`} />
                        <span className={`relative inline-flex h-3 w-3 rounded-full ${isLive ? 'bg-rose-500' : 'bg-emerald-500'}`} />
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-bold tracking-wide text-white">{homeTeamName} vs {awayTeamName}</span>
                        <span className="text-[11px] text-neutral-400 font-medium">· Match Tracker 2D</span>
                    </div>
                    <span className="rounded-md bg-white/8 px-2 py-0.5 text-xs font-semibold text-neutral-300">
                        {liveData?.statusDescription || (liveData?.minute ? `${liveData.minute}'` : 'Live')}
                    </span>
                    <span className="rounded-md border px-2 py-0.5 text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border-emerald-500/30">
                        API-Football Live Snapshot
                    </span>
                </div>

                <div className="flex items-center gap-2">
                    {activeFixtureId && (
                        <span className="inline-flex items-center gap-1 rounded-lg border border-sky-500/30 bg-sky-500/8 px-2.5 py-1 text-xs font-semibold text-sky-300">
                            Fixture #{activeFixtureId}
                        </span>
                    )}
                    <button
                        type="button"
                        onClick={() => void fetchLiveSnapshot()}
                        disabled={loading}
                        className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-neutral-300 transition hover:bg-white/10 disabled:opacity-40"
                    >
                        {loading ? 'Đang nạp…' : 'Làm mới Snapshot ↻'}
                    </button>
                </div>
            </div>

            {/* ── Bảng Tỷ Số ── */}
            <div className="my-3 grid grid-cols-3 items-center rounded-lg bg-neutral-900 px-4 py-2.5 text-center">
                <div className="text-left">
                    <p className="truncate text-sm font-bold text-sky-400" title={homeTeamName}>{homeTeamName}</p>
                    <span className="text-[11px] text-neutral-500">Chủ nhà</span>
                </div>
                <div>
                    <div className="font-mono text-2xl font-black tracking-wider text-white">
                        {liveData?.score ? `${liveData.score.home} - ${liveData.score.away}` : '0 - 0'}
                    </div>
                    <span className="text-[10px] text-neutral-500">
                        {lastUpdate ? `Snapshot lúc ${lastUpdate.toLocaleTimeString('vi-VN')}` : 'Chờ dữ liệu'}
                    </span>
                </div>
                <div className="text-right">
                    <p className="truncate text-sm font-bold text-amber-400" title={awayTeamName}>{awayTeamName}</p>
                    <span className="text-[11px] text-neutral-500">Đội khách</span>
                </div>
            </div>

            {/* ── Mặt Sân 2D SVG (Tọa độ chính xác theo sự kiện thực tế) ── */}
            <div className="relative overflow-hidden rounded-lg border border-white/10 bg-[#0a2312]">
                {/* Thanh thông báo sự kiện trên sân */}
                <div className="absolute left-1/2 top-2.5 z-10 -translate-x-1/2 rounded-full border border-white/15 bg-black/80 px-3.5 py-1 text-xs font-medium text-white backdrop-blur-sm max-w-[90%] truncate">
                    <span className={
                        currentAction.team === 'home' ? 'text-sky-300 font-semibold' :
                        currentAction.team === 'away' ? 'text-amber-300 font-semibold' :
                        'text-neutral-200'
                    }>
                        {currentAction.label}
                    </span>
                </div>

                <svg viewBox="0 0 600 320" className="h-auto w-full select-none" style={{ maxHeight: '360px' }}>
                    <defs>
                        <pattern id="pitchStripes" width="60" height="320" patternUnits="userSpaceOnUse">
                            <rect width="30" height="320" fill="#154326" />
                            <rect x="30" width="30" height="320" fill="#1b5330" />
                        </pattern>
                    </defs>

                    {/* Mặt cỏ */}
                    <rect width="600" height="320" fill="url(#pitchStripes)" />

                    {/* Đường biên vạch vôi */}
                    <rect x="20" y="20" width="560" height="280" fill="none" stroke="#fff" strokeWidth="2" strokeOpacity="0.8" />

                    {/* Vạch giữa sân */}
                    <line x1="300" y1="20" x2="300" y2="300" stroke="#fff" strokeWidth="2" strokeOpacity="0.8" />

                    {/* Vòng tròn trung tâm */}
                    <circle cx="300" cy="160" r="45" fill="none" stroke="#fff" strokeWidth="2" strokeOpacity="0.8" />
                    <circle cx="300" cy="160" r="3" fill="#fff" />

                    {/* Khu vực cầu môn ĐỘI NHÀ */}
                    <g opacity="0.8">
                        <rect x="8"  y="130" width="12" height="60"  fill="none" stroke="#fff" strokeWidth="2" />
                        <rect x="20" y="100" width="45" height="120" fill="none" stroke="#fff" strokeWidth="2" />
                        <rect x="20" y="65"  width="100" height="190" fill="none" stroke="#fff" strokeWidth="2" />
                        <circle cx="85" cy="160" r="2.5" fill="#fff" />
                    </g>

                    {/* Khu vực cầu môn ĐỘI KHÁCH */}
                    <g opacity="0.8">
                        <rect x="580" y="130" width="12" height="60"  fill="none" stroke="#fff" strokeWidth="2" />
                        <rect x="535" y="100" width="45" height="120" fill="none" stroke="#fff" strokeWidth="2" />
                        <rect x="480" y="65"  width="100" height="190" fill="none" stroke="#fff" strokeWidth="2" />
                        <circle cx="515" cy="160" r="2.5" fill="#fff" />
                    </g>

                    {/* Góc sân (Corners) */}
                    <path d="M 20 28 A 8 8 0 0 0 28 20" fill="none" stroke="#fff" strokeWidth="2" opacity="0.8" />
                    <path d="M 20 292 A 8 8 0 0 1 28 300" fill="none" stroke="#fff" strokeWidth="2" opacity="0.8" />
                    <path d="M 580 28 A 8 8 0 0 1 572 20" fill="none" stroke="#fff" strokeWidth="2" opacity="0.8" />
                    <path d="M 580 292 A 8 8 0 0 0 572 300" fill="none" stroke="#fff" strokeWidth="2" opacity="0.8" />

                    {/* Vị trí bóng chuyển động trên sân theo tọa độ thật */}
                    <g style={{
                        transform: `translate(${currentAction.x}px, ${currentAction.y}px)`,
                        transition: 'transform 0.6s cubic-bezier(0.2, 0.8, 0.2, 1)'
                    }}>
                        <circle
                            r="14"
                            fill={
                                currentAction.team === 'home' ? 'rgba(56, 189, 248, 0.35)' :
                                currentAction.team === 'away' ? 'rgba(251, 191, 36, 0.35)' :
                                'rgba(255, 255, 255, 0.3)'
                            }
                            className="animate-ping"
                        />
                        <circle r="7" fill="#fff" stroke="#111" strokeWidth="1.5" />
                        <circle
                            r="3"
                            fill={
                                currentAction.team === 'home' ? '#38bdf8' :
                                currentAction.team === 'away' ? '#fbbf24' :
                                '#22c55e'
                            }
                        />
                    </g>
                </svg>

                {/* Tên đội ở 2 góc sân */}
                <div className="pointer-events-none absolute bottom-2 left-3 text-[11px] font-bold text-sky-300/80 bg-black/40 px-2 py-0.5 rounded">
                    ◀ {homeTeamName}
                </div>
                <div className="pointer-events-none absolute bottom-2 right-3 text-[11px] font-bold text-amber-300/80 bg-black/40 px-2 py-0.5 rounded">
                    {awayTeamName} ▶
                </div>
            </div>

            {/* ── Attack Momentum (Biểu đồ áp lực tấn công thời gian thực) ── */}
            <div className="mt-3 rounded-lg bg-neutral-900 p-3">
                <div className="mb-1.5 flex items-center justify-between text-xs font-semibold text-neutral-300">
                    <span className="text-sky-400">▲ Áp lực {homeTeamName}</span>
                    <span className="text-[11px] text-neutral-500 font-mono">Attack Momentum</span>
                    <span className="text-amber-400">▼ Áp lực {awayTeamName}</span>
                </div>
                <div className="flex h-16 items-center justify-between gap-1 overflow-hidden rounded bg-black/40 px-2 py-1">
                    {momentumBars.map((val, idx) => {
                        const isHome = val >= 0
                        const heightPct = Math.min(100, Math.max(10, (Math.abs(val) / 65) * 100))
                        return (
                            <div key={idx} className="flex h-full flex-1 flex-col justify-center">
                                <div className="relative h-full w-full">
                                    <div
                                        className={`absolute w-full rounded-sm transition-all duration-300 ${
                                            isHome ? 'bottom-1/2 bg-sky-500/80' : 'top-1/2 bg-amber-500/80'
                                        }`}
                                        style={{ height: `${heightPct / 2}%` }}
                                    />
                                </div>
                            </div>
                        )
                    })}
                </div>
            </div>

            {/* ── Thống kê 100% Số liệu thật từ API-Football ── */}
            <div className="mt-3 space-y-2.5 rounded-lg bg-neutral-900 p-3 text-xs">
                {/* Cầm bóng */}
                <div>
                    <div className="mb-1 flex justify-between font-medium">
                        <span className="text-sky-400">{homePossession}%</span>
                        <span className="text-neutral-400">Kiểm soát bóng</span>
                        <span className="text-amber-400">{awayPossession}%</span>
                    </div>
                    <div className="flex h-2 overflow-hidden rounded-full bg-neutral-800">
                        <div className="bg-sky-500 transition-all duration-500" style={{ width: `${homePossession}%` }} />
                        <div className="bg-amber-500 transition-all duration-500" style={{ width: `${awayPossession}%` }} />
                    </div>
                </div>

                {/* Sút trúng đích / Tổng số cú sút */}
                <div>
                    <div className="mb-1 flex justify-between font-medium">
                        <span className="text-sky-400">{homeSOT} / {homeShots}</span>
                        <span className="text-neutral-400">Sút trúng đích / Tổng sút</span>
                        <span className="text-amber-400">{awaySOT} / {awayShots}</span>
                    </div>
                    <div className="flex h-2 overflow-hidden rounded-full bg-neutral-800">
                        <div
                            className="bg-sky-500 transition-all duration-500"
                            style={{ width: `${(homeShots / Math.max(1, homeShots + awayShots)) * 100}%` }}
                        />
                        <div
                            className="bg-amber-500 transition-all duration-500"
                            style={{ width: `${(awayShots / Math.max(1, homeShots + awayShots)) * 100}%` }}
                        />
                    </div>
                </div>

                {/* Phạt góc & Thẻ phạt */}
                <div className="grid grid-cols-2 gap-3 pt-1 border-t border-white/5">
                    <div className="rounded bg-black/30 p-2 text-center">
                        <span className="text-[11px] text-neutral-400">Phạt góc</span>
                        <div className="mt-0.5 font-mono text-sm font-bold text-white">
                            <span className="text-sky-400">{homeCorners}</span>
                            <span className="mx-1 text-neutral-500">-</span>
                            <span className="text-amber-400">{awayCorners}</span>
                            <span className="ml-1.5 text-[10px] text-neutral-500 font-normal">({totalCorners})</span>
                        </div>
                    </div>
                    <div className="rounded bg-black/30 p-2 text-center">
                        <span className="text-[11px] text-neutral-400">Thẻ phạt</span>
                        <div className="mt-0.5 font-mono text-sm font-bold text-white">
                            <span className="text-sky-400">{homeCards}</span>
                            <span className="mx-1 text-neutral-500">-</span>
                            <span className="text-amber-400">{awayCards}</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* ── Danh sách sự kiện gần nhất (Recent Incidents) ── */}
            {recentIncidents.length > 0 && (
                <div className="mt-3 rounded-lg bg-neutral-900 p-3">
                    <h5 className="mb-2 text-xs font-semibold text-neutral-400">Diễn biến gần nhất ({recentIncidents.length} sự kiện)</h5>
                    <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1 text-xs">
                        {recentIncidents.slice(0, 10).map((inc, i) => (
                            <div key={i} className="flex items-center justify-between rounded bg-black/30 px-2 py-1">
                                <div className="flex items-center gap-1.5 truncate">
                                    <span className="font-mono text-neutral-500">{inc.time}&apos;</span>
                                    <span>
                                        {inc.incidentType === 'goal' ? '⚽' :
                                         inc.incidentType === 'card' ? '🟨' :
                                         inc.incidentType === 'corner' ? '🚩' :
                                         inc.incidentType === 'substitution' || inc.incidentType === 'sub' ? '🔄' : '⏱'}
                                    </span>
                                    <span className={inc.isHome !== false ? 'text-sky-300' : 'text-amber-300'}>
                                        {inc.player?.name || (inc.isHome !== false ? homeTeamName : awayTeamName)}
                                    </span>
                                    <span className="text-neutral-400">
                                        {inc.incidentType === 'goal' ? 'ghi bàn' :
                                         inc.incidentType === 'card' ? (inc.incidentClass === 'red' ? 'thẻ đỏ' : 'thẻ vàng') :
                                         inc.incidentType === 'substitution' || inc.incidentType === 'sub' ? 'thay người' :
                                         inc.text || inc.incidentType}
                                    </span>
                                </div>
                                {inc.homeScore != null && inc.awayScore != null && (
                                    <span className="font-mono font-bold text-white bg-black/40 px-1.5 py-0.5 rounded">
                                        {inc.homeScore} - {inc.awayScore}
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* ── Fixture ID control ── */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/8 pt-2.5 text-xs">
                <div className="flex items-center gap-2">
                    <span className="font-medium text-neutral-500">API-Football Fixture ID:</span>
                    <input
                        type="text"
                        placeholder={liveData?.eventId ? String(liveData.eventId) : 'vd: 1570405'}
                        value={customFixtureId}
                        onChange={(e) => setCustomFixtureId(e.target.value.trim())}
                        className="w-36 rounded-lg border border-white/10 bg-neutral-900 px-2.5 py-1 font-mono text-xs text-white placeholder-neutral-600 focus:border-white/40 focus:outline-none"
                    />
                    {customFixtureId && (
                        <button
                            type="button"
                            onClick={() => setCustomFixtureId('')}
                            className="text-xs text-neutral-500 hover:text-white"
                            title="Quay lại ID tự động"
                        >✕</button>
                    )}
                </div>

                {activeFixtureId && (
                    <span className="text-[11px] text-sky-400">
                        api-sports.io/fixtures #{activeFixtureId}
                    </span>
                )}
            </div>

            {/* ── Auto-settle result ── */}
            {autoSettled && (
                <div className="mt-3 rounded-lg border border-emerald-500/25 bg-emerald-950/30 p-3 text-xs text-emerald-300">
                    <div className="flex items-center justify-between">
                        <span className="font-bold">✨ TỰ ĐỘNG ĐỐI SOÁT (AUTO-SETTLE)</span>
                        <span className="rounded bg-emerald-500/15 px-2 py-0.5 font-bold uppercase">
                            {autoSettled.summaryOutcome === 'win'
                                ? '🏆 THẮNG'
                                : autoSettled.summaryOutcome === 'lose'
                                    ? '❌ THUA'
                                    : '🤝 HÒA'}
                        </span>
                    </div>
                    <p className="mt-1 text-emerald-200/75">
                        Tỷ số FT: <strong>{autoSettled.score.ftHome} - {autoSettled.score.ftAway}</strong>
                        {autoSettled.corners && ` · Phạt góc: ${autoSettled.corners.total} (${autoSettled.corners.home}-${autoSettled.corners.away})`}
                        {' '}· Lợi nhuận:{' '}
                        <strong className={autoSettled.totalProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                            {autoSettled.totalProfit >= 0 ? '+' : ''}{autoSettled.totalProfit.toFixed(2)} đv
                        </strong>
                    </p>
                </div>
            )}

            {settling && (
                <div className="mt-2 animate-pulse text-center text-xs text-amber-300">
                    ⏳ Trận đấu FT — Đang tự động đối soát và lưu vào Redis…
                </div>
            )}

            {settleError && (
                <div className="mt-2 text-center text-xs text-rose-400">⚠️ {settleError}</div>
            )}
        </div>
    )
}
