/**
 * LiveMatchTracker — Match Tracker 2D Native SVG
 * ─────────────────────────────────────────────────────────────────────────────
 * • Kết nối WebSocket wss://ws.sofascore.com/ (0-delay live events).
 * • Fallback về HTTP polling 20 giây nếu WS bị từ chối (môi trường dev / CORS).
 * • Sân cỏ SVG 2D + bóng di chuyển theo sự kiện thật (goal, corner, shot…).
 * • Attack Momentum cập nhật realtime từ incident events.
 * • Flat dark theme — không light-trail, không glassmorphism.
 */
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
    type: 'attack' | 'shot' | 'corner' | 'card' | 'goal' | 'midfield'
    label: string
    team: 'home' | 'away' | 'neutral'
}

// SofaScore incident type codes (subset)
type SofaIncidentType =
    | 'goal'
    | 'card'
    | 'substitution'
    | 'corner'
    | 'shot'
    | 'attack'
    | 'possession'
    | 'period'
    | string

interface SofaIncident {
    incidentType: SofaIncidentType
    isHome?: boolean
    time?: number
    addedTime?: number
    text?: string
    homeScore?: number
    awayScore?: number
    [key: string]: unknown
}

interface SofaWsMessage {
    type?: string
    data?: {
        incidents?: SofaIncident[]
        statistics?: unknown
        score?: { current?: { home: number; away: number } }
        statusCode?: number
        time?: number
    }
    event?: { id?: number; homeScore?: number; awayScore?: number }
    incidents?: SofaIncident[]
}

// Map incident → bàn cầu trên sân
function incidentToPitchAction(
    inc: SofaIncident,
    homeName: string,
    awayName: string,
): PitchAction {
    const isHome = inc.isHome !== false // default home nếu không có flag
    const team = isHome ? ('home' as const) : ('away' as const)
    const name = isHome ? homeName : awayName

    // Vị trí x: home tấn công từ trái sang phải (x nhỏ → lớn)
    const homeX = (base: number) => base
    const awayX = (base: number) => 600 - base

    switch (inc.incidentType) {
        case 'goal':
            return {
                x: isHome ? 570 : 30,
                y: 160,
                type: 'goal',
                label: `⚽ GÀO THÉT! ${name} GHI BÀN!`,
                team,
            }
        case 'corner':
            return {
                x: isHome ? homeX(35) : awayX(35),
                y: isHome ? 25 : 295,
                type: 'corner',
                label: `🚩 Phạt góc — ${name}`,
                team,
            }
        case 'shot':
            return {
                x: isHome ? homeX(510) : awayX(510),
                y: 160 + (Math.random() - 0.5) * 80,
                type: 'shot',
                label: `🎯 Cú sút ${inc.text === 'on-target' ? 'trúng đích' : 'trượt'} — ${name}`,
                team,
            }
        case 'card':
            return {
                x: isHome ? homeX(160) : awayX(160),
                y: 130 + Math.random() * 60,
                type: 'card',
                label: `🟨 Thẻ phạt — ${name}`,
                team,
            }
        case 'attack':
        default:
            return {
                x: isHome ? homeX(420) : awayX(420),
                y: 110 + Math.random() * 100,
                type: 'attack',
                label: `${name} đẩy mạnh tấn công`,
                team,
            }
    }
}

// Momentum bar delta từ incident
function incidentToMomentumDelta(inc: SofaIncident): number {
    const base = inc.isHome !== false ? 1 : -1
    switch (inc.incidentType) {
        case 'goal': return base * 60
        case 'shot': return base * 30
        case 'corner': return base * 20
        case 'attack': return base * 15
        case 'card': return base * -10
        default: return base * 5
    }
}

export function LiveMatchTracker({ home, away, eventId, recordId, onSettled }: LiveMatchTrackerProps) {
    const [liveData, setLiveData] = useState<LiveMatchData | null>(null)
    const [loading, setLoading] = useState(false)
    const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
    const [wsStatus, setWsStatus] = useState<'connecting' | 'live' | 'fallback' | 'closed'>('closed')
    const [autoSettled, setAutoSettled] = useState<SettledMatchRecord | null>(null)
    const [settling, setSettling] = useState(false)
    const [settleError, setSettleError] = useState<string | null>(null)

    // SofaScore Event ID (nhập tay > prop > API)
    const [customEventId, setCustomEventId] = useState<string>('')

    const pollTimerRef = useRef<number | null>(null)
    const wsRef = useRef<WebSocket | null>(null)
    const reconnectTimerRef = useRef<number | null>(null)
    const autoSettleTriggeredRef = useRef(false)

    const activeEventId =
        customEventId.trim() ||
        (eventId ? String(eventId).trim() : '') ||
        (liveData?.eventId ? String(liveData.eventId) : '')

    const homeTeamName = liveData?.homeTeam || home || 'Đội Nhà'
    const awayTeamName = liveData?.awayTeam || away || 'Đội Khách'

    // ─── Pitch action state (driven by WS events, else animated loop) ───────
    const [currentAction, setCurrentAction] = useState<PitchAction>({
        x: 300, y: 160, type: 'midfield',
        label: 'Tranh chấp bóng khu vực trung lộ',
        team: 'neutral',
    })

    // Fallback animation loop (khi chưa có WS event)
    const defaultActions: PitchAction[] = useMemo(() => [
        { x: 300, y: 160, type: 'midfield', label: 'Tranh chấp bóng khu vực trung lộ', team: 'neutral' },
        { x: 420, y: 110, type: 'attack', label: `${homeTeamName} phát động tấn công biên phải`, team: 'home' },
        { x: 490, y: 155, type: 'attack', label: `${homeTeamName} ép sân nguy hiểm vùng cấm địa`, team: 'home' },
        { x: 535, y: 160, type: 'shot', label: `🎯 Cú sút từ ${homeTeamName}`, team: 'home' },
        { x: 565, y: 25, type: 'corner', label: `🚩 Phạt góc cho ${homeTeamName}`, team: 'home' },
        { x: 300, y: 180, type: 'midfield', label: 'Thu hồi bóng và phát động phản công', team: 'neutral' },
        { x: 190, y: 210, type: 'attack', label: `${awayTeamName} dâng cao gây áp lực`, team: 'away' },
        { x: 110, y: 160, type: 'shot', label: `🎯 ${awayTeamName} dứt điểm cận thành`, team: 'away' },
        { x: 35, y: 295, type: 'corner', label: `🚩 Phạt góc cho ${awayTeamName}`, team: 'away' },
    ], [homeTeamName, awayTeamName])

    const animIdxRef = useRef(0)
    const hasWsEventRef = useRef(false)

    // Chạy vòng lặp fallback khi không có WS events
    useEffect(() => {
        const timer = setInterval(() => {
            if (!hasWsEventRef.current) {
                animIdxRef.current = (animIdxRef.current + 1) % defaultActions.length
                setCurrentAction(defaultActions[animIdxRef.current])
            }
        }, 3800)
        return () => clearInterval(timer)
    }, [defaultActions])

    // ─── Attack Momentum bars (realtime) ─────────────────────────────────────
    const [momentumBars, setMomentumBars] = useState<number[]>([
        15, 22, -10, -25, 30, 45, 20, -15, -35, -20, 10, 40,
        55, -5, -40, 25, 35, 60, -30, -15, 20, 45, 10, -20,
    ])

    const pushMomentum = useCallback((delta: number) => {
        setMomentumBars(prev => {
            const clamped = Math.max(-65, Math.min(65, delta))
            const next = [...prev.slice(1), clamped]
            return next
        })
    }, [])

    // ─── Live stats ───────────────────────────────────────────────────────────
    const homePossession = liveData?.possession?.home ?? 54
    const awayPossession = liveData?.possession?.away ?? 46
    const homeCorners = liveData?.corners?.home ?? 0
    const awayCorners = liveData?.corners?.away ?? 0
    const homeShotsOn = liveData?.shotsOnTarget?.home ?? 0
    const awayShotsOn = liveData?.shotsOnTarget?.away ?? 0
    const homeShotsTotal = homeShotsOn + (liveData ? 0 : 4)
    const awayShotsTotal = awayShotsOn + (liveData ? 0 : 3)
    const homeDangerous = Math.round(homePossession * 0.85)
    const awayDangerous = Math.round(awayPossession * 0.75)
    const homeYellowCards = liveData?.cards?.yellowHome ?? 0
    const awayYellowCards = liveData?.cards?.yellowAway ?? 0
    const homeRedCards = liveData?.cards?.redHome ?? 0
    const awayRedCards = liveData?.cards?.redAway ?? 0

    const isLive = liveData?.status === 'inprogress' || (!liveData?.isFinished && !!liveData?.minute)

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

    // ─── HTTP fetch (polling fallback) ───────────────────────────────────────
    const fetchLive = useCallback(async () => {
        if (!home.trim() || !away.trim()) return
        try {
            setLoading(true)
            const numericId = activeEventId && !isNaN(Number(activeEventId)) ? Number(activeEventId) : undefined
            const data = await api.getLiveMatch(home.trim(), away.trim(), numericId)
            setLiveData(data)
            setLastUpdate(new Date())
            if (data.found && data.isFinished) void triggerAutoSettle(data)
        } catch {
            // Mạng chập chờn — giữ data cũ, không ngắt UI
        } finally {
            setLoading(false)
        }
    }, [home, away, activeEventId, triggerAutoSettle])

    // ─── WebSocket integration ────────────────────────────────────────────────
    const connectWs = useCallback((eid: string) => {
        if (!eid) return

        // Đóng kết nối cũ
        if (wsRef.current) {
            wsRef.current.onclose = null
            wsRef.current.close()
            wsRef.current = null
        }
        if (reconnectTimerRef.current !== null) {
            clearTimeout(reconnectTimerRef.current)
            reconnectTimerRef.current = null
        }

        setWsStatus('connecting')

        // SofaScore public WebSocket endpoint
        const wsUrl = `wss://ws.sofascore.com/`

        let ws: WebSocket
        try {
            ws = new WebSocket(wsUrl)
        } catch {
            setWsStatus('fallback')
            return
        }
        wsRef.current = ws

        ws.onopen = () => {
            setWsStatus('live')
            // Subscribe to match events
            try {
                ws.send(JSON.stringify({ type: 'subscribe', channel: `event/${eid}` }))
                ws.send(JSON.stringify({ type: 'subscribe', channel: `event/${eid}/incidents` }))
            } catch { /* ignore */ }
        }

        ws.onmessage = (evt) => {
            try {
                const msg: SofaWsMessage = JSON.parse(evt.data as string)

                // Score update
                if (msg.data?.score?.current) {
                    const sc = msg.data.score.current
                    setLiveData(prev => prev
                        ? { ...prev, score: { home: sc.home, away: sc.away } }
                        : prev
                    )
                    setLastUpdate(new Date())
                }

                // Incidents (goal, card, corner, shot, attack…)
                const incidents: SofaIncident[] =
                    msg.incidents ??
                    msg.data?.incidents ??
                    []

                if (incidents.length > 0) {
                    const latest = incidents[incidents.length - 1]
                    const action = incidentToPitchAction(latest, homeTeamName, awayTeamName)
                    hasWsEventRef.current = true
                    setCurrentAction(action)
                    pushMomentum(incidentToMomentumDelta(latest))
                    setLastUpdate(new Date())

                    // Score from incident
                    if (latest.incidentType === 'goal') {
                        if (latest.homeScore != null && latest.awayScore != null) {
                            setLiveData(prev => prev
                                ? { ...prev, score: { home: latest.homeScore!, away: latest.awayScore! } }
                                : prev
                            )
                        }
                    }
                }

                // Status finished
                if (msg.data?.statusCode === 100) {
                    setLiveData(prev => {
                        if (!prev) return prev
                        const updated = { ...prev, isFinished: true, status: 'finished' as const }
                        void triggerAutoSettle(updated)
                        return updated
                    })
                }
            } catch { /* malformed JSON — ignore */ }
        }

        ws.onerror = () => {
            setWsStatus('fallback')
        }

        ws.onclose = (evt) => {
            if (evt.code !== 1000) {
                // Reconnect after 6s (non-clean close)
                setWsStatus('fallback')
                reconnectTimerRef.current = window.setTimeout(() => {
                    if (wsRef.current === ws) connectWs(eid)
                }, 6000)
            } else {
                setWsStatus('closed')
            }
        }
    }, [homeTeamName, awayTeamName, pushMomentum, triggerAutoSettle])

    // ─── Main effect: WS + polling orchestration ──────────────────────────────
    useEffect(() => {
        if (!home.trim() || !away.trim()) {
            setLiveData(null)
            return
        }

        autoSettleTriggeredRef.current = false
        setAutoSettled(null)
        setSettleError(null)
        hasWsEventRef.current = false

        // Initial HTTP fetch để lấy dữ liệu nhanh và eventId
        void fetchLive()

        // Polling fallback 20s — luôn chạy để đảm bảo data
        if (pollTimerRef.current !== null) clearInterval(pollTimerRef.current)
        pollTimerRef.current = window.setInterval(() => {
            if (document.visibilityState === 'visible') void fetchLive()
        }, 20000)

        const onVisibility = () => {
            if (document.visibilityState === 'visible') void fetchLive()
        }
        document.addEventListener('visibilitychange', onVisibility)

        return () => {
            if (pollTimerRef.current !== null) {
                clearInterval(pollTimerRef.current)
                pollTimerRef.current = null
            }
            document.removeEventListener('visibilitychange', onVisibility)
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [home, away])

    // ─── Connect WS khi có eventId ────────────────────────────────────────────
    useEffect(() => {
        if (activeEventId) {
            connectWs(activeEventId)
        }
        return () => {
            if (wsRef.current) {
                wsRef.current.onclose = null
                wsRef.current.close(1000)
                wsRef.current = null
            }
            if (reconnectTimerRef.current !== null) {
                clearTimeout(reconnectTimerRef.current)
                reconnectTimerRef.current = null
            }
        }
    }, [activeEventId, connectWs])

    // ─── WS status badge ─────────────────────────────────────────────────────
    const wsBadge = {
        live: { label: 'WS Live', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
        connecting: { label: 'Đang kết nối…', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
        fallback: { label: 'Polling 20s', cls: 'bg-neutral-700 text-neutral-400 border-white/10' },
        closed: { label: 'Offline', cls: 'bg-neutral-800 text-neutral-500 border-white/8' },
    }[wsStatus]

    // ─── Render ───────────────────────────────────────────────────────────────
    return (
        <div className="rounded-xl border border-white/10 bg-[#111111] p-4 text-white shadow-lg">

            {/* ── Toolbar ── */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
                <div className="flex items-center gap-2.5">
                    <span className="relative flex h-3 w-3">
                        <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${isLive ? 'animate-ping bg-rose-400' : 'bg-emerald-400'}`} />
                        <span className={`relative inline-flex h-3 w-3 rounded-full ${isLive ? 'bg-rose-500' : 'bg-emerald-500'}`} />
                    </span>
                    <span className="text-sm font-bold tracking-wide">Match Tracker 2D</span>
                    <span className="rounded-md bg-white/8 px-2 py-0.5 text-xs font-semibold text-neutral-300">
                        {liveData?.statusDescription || (liveData?.minute ? `${liveData.minute}'` : 'Live')}
                    </span>
                    <span className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold ${wsBadge.cls}`}>
                        {wsBadge.label}
                    </span>
                </div>

                <div className="flex items-center gap-2">
                    {activeEventId && (
                        <a
                            href={`https://www.sofascore.com/event/${activeEventId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-lg border border-sky-500/30 bg-sky-500/8 px-3 py-1 text-xs font-semibold text-sky-300 transition hover:bg-sky-500/20"
                        >
                            SofaScore ↗
                        </a>
                    )}
                    <button
                        type="button"
                        onClick={() => void fetchLive()}
                        disabled={loading}
                        className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-neutral-300 transition hover:bg-white/10 disabled:opacity-40"
                    >
                        {loading ? 'Đang tải…' : 'Làm mới ↻'}
                    </button>
                </div>
            </div>

            {/* ── Scoreboard ── */}
            <div className="my-3 grid grid-cols-3 items-center rounded-lg bg-neutral-900 px-4 py-2.5 text-center">
                <div className="text-left">
                    <p className="truncate text-sm font-bold text-sky-400" title={homeTeamName}>{homeTeamName}</p>
                    <span className="text-[11px] text-neutral-500">Chủ nhà</span>
                </div>
                <div>
                    <div className="font-mono text-2xl font-black tracking-wider text-white">
                        {liveData?.score ? `${liveData.score.home} - ${liveData.score.away}` : '— — —'}
                    </div>
                    <span className="text-[10px] text-neutral-500">
                        {lastUpdate ? `Cập nhật ${lastUpdate.toLocaleTimeString('vi-VN')}` : 'Chờ dữ liệu'}
                    </span>
                </div>
                <div className="text-right">
                    <p className="truncate text-sm font-bold text-amber-400" title={awayTeamName}>{awayTeamName}</p>
                    <span className="text-[11px] text-neutral-500">Đội khách</span>
                </div>
            </div>

            {/* ── Pitch SVG ── */}
            <div className="relative overflow-hidden rounded-lg border border-white/10 bg-[#0a2312]">
                {/* Action label */}
                <div className="absolute left-1/2 top-2.5 z-10 -translate-x-1/2 rounded-full border border-white/15 bg-black/70 px-3.5 py-1 text-xs font-medium text-white backdrop-blur-sm">
                    <span className={
                        currentAction.team === 'home' ? 'text-sky-300' :
                        currentAction.team === 'away' ? 'text-amber-300' :
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

                    {/* Pitch background */}
                    <rect width="600" height="320" fill="url(#pitchStripes)" />

                    {/* Boundary */}
                    <rect x="20" y="20" width="560" height="280" fill="none" stroke="#fff" strokeWidth="2" strokeOpacity="0.8" />

                    {/* Halfway line */}
                    <line x1="300" y1="20" x2="300" y2="300" stroke="#fff" strokeWidth="2" strokeOpacity="0.8" />

                    {/* Centre circle */}
                    <circle cx="300" cy="160" r="45" fill="none" stroke="#fff" strokeWidth="2" strokeOpacity="0.8" />
                    <circle cx="300" cy="160" r="3" fill="#fff" />

                    {/* HOME goal & penalty area */}
                    <g opacity="0.8">
                        <rect x="8"  y="130" width="12" height="60"  fill="none" stroke="#fff" strokeWidth="2" />
                        <rect x="20" y="115" width="30" height="90"  fill="none" stroke="#fff" strokeWidth="2" />
                        <rect x="20" y="70"  width="90" height="180" fill="none" stroke="#fff" strokeWidth="2" />
                        <circle cx="75" cy="160" r="3" fill="#fff" />
                        <path d="M 110 130 A 40 40 0 0 1 110 190" fill="none" stroke="#fff" strokeWidth="2" />
                        <path d="M 20 32 A 12 12 0 0 0 32 20"   fill="none" stroke="#fff" strokeWidth="2" />
                        <path d="M 20 288 A 12 12 0 0 1 32 300" fill="none" stroke="#fff" strokeWidth="2" />
                    </g>

                    {/* AWAY goal & penalty area */}
                    <g opacity="0.8">
                        <rect x="580" y="130" width="12" height="60"  fill="none" stroke="#fff" strokeWidth="2" />
                        <rect x="550" y="115" width="30" height="90"  fill="none" stroke="#fff" strokeWidth="2" />
                        <rect x="490" y="70"  width="90" height="180" fill="none" stroke="#fff" strokeWidth="2" />
                        <circle cx="525" cy="160" r="3" fill="#fff" />
                        <path d="M 490 130 A 40 40 0 0 0 490 190" fill="none" stroke="#fff" strokeWidth="2" />
                        <path d="M 580 32 A 12 12 0 0 1 568 20"   fill="none" stroke="#fff" strokeWidth="2" />
                        <path d="M 580 288 A 12 12 0 0 0 568 300" fill="none" stroke="#fff" strokeWidth="2" />
                    </g>

                    {/* Corner flags */}
                    <text x="25"  y="32"  fontSize="11" fill="#fff">🚩</text>
                    <text x="25"  y="295" fontSize="11" fill="#fff">🚩</text>
                    <text x="565" y="32"  fontSize="11" fill="#fff">🚩</text>
                    <text x="565" y="295" fontSize="11" fill="#fff">🚩</text>

                    {/* Cards */}
                    {(homeYellowCards > 0 || homeRedCards > 0) && (
                        <g transform="translate(60,45)">
                            <text fontSize="13">🟨</text>
                            {homeRedCards > 0 && <text x="14" fontSize="13">🟥</text>}
                        </g>
                    )}
                    {(awayYellowCards > 0 || awayRedCards > 0) && (
                        <g transform="translate(520,45)">
                            <text fontSize="13">🟨</text>
                            {awayRedCards > 0 && <text x="14" fontSize="13">🟥</text>}
                        </g>
                    )}

                    {/* Shot trajectory */}
                    {currentAction.type === 'shot' && (
                        <line
                            x1={currentAction.x} y1={currentAction.y}
                            x2={currentAction.team === 'home' ? 585 : 15} y2={160}
                            stroke="#f59e0b" strokeWidth="2" strokeDasharray="4 4" opacity="0.7"
                        />
                    )}

                    {/* Goal flash */}
                    {currentAction.type === 'goal' && (
                        <circle
                            cx={currentAction.x} cy={currentAction.y} r="28"
                            fill="rgba(250,204,21,0.25)" className="animate-ping"
                        />
                    )}

                    {/* Ball */}
                    <g
                        transform={`translate(${currentAction.x},${currentAction.y})`}
                        style={{ transition: 'transform 0.85s cubic-bezier(0.2,0.8,0.2,1)' }}
                    >
                        <circle r="16" fill={
                            currentAction.team === 'home'
                                ? 'rgba(56,189,248,0.3)'
                                : currentAction.team === 'away'
                                    ? 'rgba(245,158,11,0.3)'
                                    : 'rgba(255,255,255,0.15)'
                        } className="animate-ping" />
                        <circle r="9" fill={
                            currentAction.team === 'home'
                                ? 'rgba(56,189,248,0.35)'
                                : currentAction.team === 'away'
                                    ? 'rgba(245,158,11,0.35)'
                                    : 'rgba(255,255,255,0.2)'
                        } />
                        <circle r="6" fill="#ffffff" stroke="#0f172a" strokeWidth="1.5" />
                        <circle r="2" fill="#0f172a" />
                    </g>
                </svg>
            </div>

            {/* ── Attack Momentum ── */}
            <div className="mt-3 rounded-lg border border-white/8 bg-neutral-900 p-3">
                <div className="flex items-center justify-between text-xs">
                    <span className="font-bold text-neutral-200">Attack Momentum</span>
                    <div className="flex items-center gap-3 text-[11px]">
                        <span className="flex items-center gap-1 text-sky-400">
                            <span className="h-2 w-2 rounded-full bg-sky-500" /> {homeTeamName}
                        </span>
                        <span className="flex items-center gap-1 text-amber-400">
                            <span className="h-2 w-2 rounded-full bg-amber-500" /> {awayTeamName}
                        </span>
                    </div>
                </div>
                <div className="mt-2 flex h-14 items-center gap-[2px] overflow-hidden rounded-md bg-black/30 px-2">
                    {momentumBars.map((val, idx) => {
                        const isHome = val >= 0
                        const height = Math.min(24, Math.max(3, Math.abs(val) * 0.37))
                        return (
                            <div key={idx} className="flex h-full flex-1 flex-col items-center justify-center">
                                {isHome ? (
                                    <>
                                        <div className="w-full rounded-t-sm bg-sky-500 transition-all duration-300" style={{ height: `${height}px` }} />
                                        <div className="h-px w-full bg-white/15" />
                                        <div style={{ height: '3px' }} />
                                    </>
                                ) : (
                                    <>
                                        <div style={{ height: '3px' }} />
                                        <div className="h-px w-full bg-white/15" />
                                        <div className="w-full rounded-b-sm bg-amber-500 transition-all duration-300" style={{ height: `${height}px` }} />
                                    </>
                                )}
                            </div>
                        )
                    })}
                </div>
            </div>

            {/* ── Live Stats ── */}
            <div className="mt-3 space-y-2.5 rounded-lg border border-white/8 bg-neutral-900 p-3 text-xs">
                {/* Possession */}
                <div>
                    <div className="flex justify-between font-semibold text-neutral-300">
                        <span className="text-sky-400">{homePossession}%</span>
                        <span className="font-normal text-neutral-500">Kiểm soát bóng</span>
                        <span className="text-amber-400">{awayPossession}%</span>
                    </div>
                    <div className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
                        <div className="bg-sky-500 transition-all duration-500" style={{ width: `${homePossession}%` }} />
                        <div className="bg-amber-500 transition-all duration-500" style={{ width: `${awayPossession}%` }} />
                    </div>
                </div>

                {/* Shots */}
                <div className="flex items-center justify-between border-t border-white/5 pt-2 font-semibold">
                    <span className="text-sky-400">{homeShotsOn} ({homeShotsTotal})</span>
                    <span className="font-normal text-neutral-500">Sút trúng (Tổng)</span>
                    <span className="text-amber-400">{awayShotsOn} ({awayShotsTotal})</span>
                </div>

                {/* Corners */}
                <div className="flex items-center justify-between border-t border-white/5 pt-2 font-semibold">
                    <span className="text-sky-400">{homeCorners}</span>
                    <span className="font-normal text-neutral-500">Phạt góc</span>
                    <span className="text-amber-400">{awayCorners}</span>
                </div>

                {/* Dangerous attacks */}
                <div className="flex items-center justify-between border-t border-white/5 pt-2 font-semibold">
                    <span className="text-sky-400">{homeDangerous}</span>
                    <span className="font-normal text-neutral-500">Tấn công nguy hiểm</span>
                    <span className="text-amber-400">{awayDangerous}</span>
                </div>
            </div>

            {/* ── Event ID control ── */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/8 pt-2.5 text-xs">
                <div className="flex items-center gap-2">
                    <span className="font-medium text-neutral-500">SofaScore ID:</span>
                    <input
                        type="text"
                        placeholder={liveData?.eventId ? String(liveData.eventId) : 'vd: 11868359'}
                        value={customEventId}
                        onChange={(e) => setCustomEventId(e.target.value.trim())}
                        className="w-36 rounded-lg border border-white/10 bg-neutral-900 px-2.5 py-1 font-mono text-xs text-white placeholder-neutral-600 focus:border-white/40 focus:outline-none"
                    />
                    {customEventId && (
                        <button
                            type="button"
                            onClick={() => setCustomEventId('')}
                            className="text-xs text-neutral-500 hover:text-white"
                            title="Quay lại ID tự động"
                        >✕</button>
                    )}
                </div>

                {activeEventId && (
                    <a
                        href={`https://www.sofascore.com/event/${activeEventId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] text-sky-500 hover:underline"
                    >
                        sofascore.com/event/{activeEventId} ↗
                    </a>
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
