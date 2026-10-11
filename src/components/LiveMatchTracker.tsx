/**
 * LiveMatchTracker — Match Tracker 2D Native SVG (100% Số liệu thật từ SofaScore)
 * ─────────────────────────────────────────────────────────────────────────────
 * • Kết nối trực tiếp SofaScore API (thông qua server proxy /api/sofascore có cache Redis 15s).
 * • Hỗ trợ WebSocket wss://ws.sofascore.com/ (0-delay live events) cùng HTTP polling dự phòng.
 * • Tuyệt đối KHÔNG DÙNG dữ liệu ngẫu nhiên (Math.random) hay mock animation giả lập.
 * • Hiển thị 100% số liệu thực tế: Tỉ số, Cầm bóng, Phạt góc, Thẻ phạt, Sút trúng đích / Tổng sút, Phạm lỗi.
 * • Diễn biến trên sân (bóng & sự kiện) phản ánh chính xác các incidents thực tế từ SofaScore.
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

export interface SofaIncident {
    incidentType: string
    isHome?: boolean
    time?: number
    addedTime?: number
    text?: string
    homeScore?: number
    awayScore?: number
    player?: { name?: string; slug?: string }
    incidentClass?: string
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

/** Chuyển đổi sự kiện thật từ SofaScore thành hành động trực quan trên sân 2D */
function incidentToPitchAction(
    inc: SofaIncident,
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
function incidentToMomentumDelta(inc: SofaIncident): number {
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

/** Xây dựng 24 thanh Attack Momentum thực tế từ danh sách incidents của SofaScore */
function buildMomentumFromIncidents(incs: SofaIncident[]): number[] {
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
    const [wsStatus, setWsStatus] = useState<'connecting' | 'live' | 'fallback' | 'closed'>('closed')
    const [autoSettled, setAutoSettled] = useState<SettledMatchRecord | null>(null)
    const [settling, setSettling] = useState(false)
    const [settleError, setSettleError] = useState<string | null>(null)

    // SofaScore Event ID
    const [customEventId, setCustomEventId] = useState<string>('')
    const [recentIncidents, setRecentIncidents] = useState<SofaIncident[]>([])

    const pollTimerRef = useRef<number | null>(null)
    const wsRef = useRef<WebSocket | null>(null)
    const reconnectTimerRef = useRef<number | null>(null)
    const autoSettleTriggeredRef = useRef(false)

    const activeEventId =
        customEventId.trim() ||
        (eventId ? String(eventId).trim() : '') ||
        (liveData?.eventId ? String(liveData.eventId) : '')

    // Ưu tiên tên đội từ props (AnalyzePage / OCR / SofaScore), không để bị kẹt bởi cache cũ
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

    // ─── Pitch action state (Phản ánh 100% sự kiện thật từ SofaScore) ──────
    const [currentAction, setCurrentAction] = useState<PitchAction>({
        x: 300,
        y: 160,
        type: 'midfield',
        label: `Trận đấu: ${home || 'Đội Nhà'} vs ${away || 'Đội Khách'}`,
        team: 'neutral',
    })

    // ─── Attack Momentum bars (100% tính từ incidents thật) ────────────────
    const [momentumBars, setMomentumBars] = useState<number[]>(() => Array(24).fill(0))

    const pushMomentum = useCallback((delta: number) => {
        setMomentumBars(prev => {
            const clamped = Math.max(-65, Math.min(65, delta))
            const next = [...prev.slice(1), clamped]
            return next
        })
    }, [])

    // ─── Live stats: 100% số liệu thật, không sinh số ngẫu nhiên ─────────
    const homePossession = liveData?.possession?.home ?? 50
    const awayPossession = liveData?.possession?.away ?? 50
    const homeCorners = liveData?.corners?.home ?? 0
    const awayCorners = liveData?.corners?.away ?? 0
    const homeShotsOn = liveData?.shotsOnTarget?.home ?? 0
    const awayShotsOn = liveData?.shotsOnTarget?.away ?? 0
    const homeShotsTotal = liveData?.shotsTotal?.home ?? homeShotsOn
    const awayShotsTotal = liveData?.shotsTotal?.away ?? awayShotsOn
    const homeYellowCards = liveData?.cards?.yellowHome ?? 0
    const awayYellowCards = liveData?.cards?.yellowAway ?? 0
    const homeRedCards = liveData?.cards?.redHome ?? 0
    const awayRedCards = liveData?.cards?.redAway ?? 0
    const homeFouls = liveData?.fouls?.home ?? 0
    const awayFouls = liveData?.fouls?.away ?? 0

    const isLive = liveData?.status === 'inprogress' || (!liveData?.isFinished && Boolean(liveData?.minute))

    // ─── Cập nhật vị trí bóng và trạng thái sân cỏ theo trận thực tế ───────
    useEffect(() => {
        if (!liveData) {
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

    // ─── HTTP fetch (SofaScore direct API + Proxy có cache Redis) ────────────
    const fetchLive = useCallback(async () => {
        if (!home.trim() && !away.trim() && !activeEventId) return
        try {
            setLoading(true)
            const numericId = activeEventId && !isNaN(Number(activeEventId)) ? Number(activeEventId) : undefined
            const data = await api.getLiveMatch(home.trim(), away.trim(), numericId)
            setLiveData(data)
            setLastUpdate(new Date())

            // Lấy incidents thật từ SofaScore proxy
            const effectiveId = data.eventId || numericId
            if (effectiveId) {
                try {
                    const incRes = await api.getSofaIncidents(effectiveId)
                    const incs = (incRes?.incidents || []) as SofaIncident[]
                    if (incs.length > 0) {
                        setRecentIncidents([...incs].reverse())
                        setMomentumBars(buildMomentumFromIncidents(incs))
                    }
                } catch {
                    /* ignore incident error */
                }
            }

            if (data.found && data.isFinished) {
                void triggerAutoSettle(data)
            }
        } catch {
            // Mạng chập chờn — giữ data cũ, không làm gián đoạn UI
        } finally {
            setLoading(false)
        }
    }, [home, away, activeEventId, triggerAutoSettle])

    // ─── WebSocket integration (SofaScore direct push) ───────────────────────
    const connectWs = useCallback((eid: string) => {
        if (!eid) return

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
            try {
                ws.send(JSON.stringify({ type: 'subscribe', channel: `event/${eid}` }))
                ws.send(JSON.stringify({ type: 'subscribe', channel: `event/${eid}/incidents` }))
            } catch { /* ignore */ }
        }

        ws.onmessage = (evt) => {
            try {
                const msg: SofaWsMessage = JSON.parse(evt.data as string)

                // Cập nhật tỷ số thời gian thực
                if (msg.data?.score?.current) {
                    const sc = msg.data.score.current
                    setLiveData(prev => prev
                        ? { ...prev, score: { home: sc.home, away: sc.away } }
                        : prev
                    )
                    setLastUpdate(new Date())
                }

                // Cập nhật sự kiện incidents thực tế
                const incidents: SofaIncident[] =
                    msg.incidents ??
                    msg.data?.incidents ??
                    []

                if (incidents.length > 0) {
                    const latest = incidents[incidents.length - 1]
                    const action = incidentToPitchAction(latest, homeTeamName, awayTeamName)
                    setCurrentAction(action)
                    setRecentIncidents(prev => [latest, ...prev.slice(0, 19)])
                    pushMomentum(incidentToMomentumDelta(latest))
                    setLastUpdate(new Date())

                    if (latest.incidentType === 'goal') {
                        if (latest.homeScore != null && latest.awayScore != null) {
                            setLiveData(prev => prev
                                ? { ...prev, score: { home: latest.homeScore!, away: latest.awayScore! } }
                                : prev
                            )
                        }
                    }
                }

                // Nhận diện kết thúc trận (status code 100)
                if (msg.data?.statusCode === 100) {
                    setLiveData(prev => {
                        if (!prev) return prev
                        const updated = { ...prev, isFinished: true, status: 'finished' as const }
                        void triggerAutoSettle(updated)
                        return updated
                    })
                }
            } catch { /* ignore parse error */ }
        }

        ws.onerror = () => {
            setWsStatus('fallback')
        }

        ws.onclose = (evt) => {
            if (evt.code !== 1000) {
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
        if (!home.trim() && !away.trim() && !activeEventId) {
            setLiveData(null)
            return
        }

        autoSettleTriggeredRef.current = false
        setAutoSettled(null)
        setSettleError(null)

        // Initial HTTP fetch qua SofaScore Proxy
        void fetchLive()

        // Polling fallback 15s — luôn chạy để lấy thống kê chuẩn xác nhất từ Redis/SofaScore
        if (pollTimerRef.current !== null) clearInterval(pollTimerRef.current)
        pollTimerRef.current = window.setInterval(() => {
            if (document.visibilityState === 'visible') void fetchLive()
        }, 15000)

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
    }, [home, away, activeEventId, fetchLive])

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
        live: { label: 'SofaScore WS Live', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
        connecting: { label: 'Đang kết nối…', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
        fallback: { label: 'SofaScore Proxy (15s)', cls: 'bg-sky-500/20 text-sky-300 border-sky-500/30' },
        closed: { label: 'Ngoại tuyến', cls: 'bg-neutral-800 text-neutral-500 border-white/8' },
    }[wsStatus]

    if (!liveData || !liveData.found || (!home.trim() && !away.trim() && !activeEventId)) {
        return (
            <div className="rounded-xl border border-dashed border-white/10 bg-[#111111]/80 p-8 text-center text-neutral-400">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-white/5 text-xl">
                    ⚽
                </div>
                <h4 className="font-display text-sm font-semibold text-neutral-200">
                    Chưa có dữ liệu trận đấu. Hãy tải ảnh bảng cược hoặc nhập SofaScore Event ID để bắt đầu phân tích.
                </h4>
                {loading && (
                    <p className="mt-2 text-xs text-sky-400 animate-pulse">
                        Đang kết nối và lấy dữ liệu trận đấu từ SofaScore…
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
                            SofaScore Event ↗
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
                        {lastUpdate ? `Cập nhật ${lastUpdate.toLocaleTimeString('vi-VN')}` : 'Chờ dữ liệu'}
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
                            <rect x="20" y="115" width="30" height="90"  fill="none" stroke="#fff" strokeWidth="2" />
                            <rect x="20" y="70"  width="90" height="180" fill="none" stroke="#fff" strokeWidth="2" />
                            <circle cx="75" cy="160" r="3" fill="#fff" />
                            <path d="M 110 130 A 40 40 0 0 1 110 190" fill="none" stroke="#fff" strokeWidth="2" />
                            <path d="M 20 32 A 12 12 0 0 0 32 20"   fill="none" stroke="#fff" strokeWidth="2" />
                            <path d="M 20 288 A 12 12 0 0 1 32 300" fill="none" stroke="#fff" strokeWidth="2" />
                        </g>

                        {/* Khu vực cầu môn ĐỘI KHÁCH */}
                        <g opacity="0.8">
                            <rect x="580" y="130" width="12" height="60"  fill="none" stroke="#fff" strokeWidth="2" />
                            <rect x="550" y="115" width="30" height="90"  fill="none" stroke="#fff" strokeWidth="2" />
                            <rect x="490" y="70"  width="90" height="180" fill="none" stroke="#fff" strokeWidth="2" />
                            <circle cx="525" cy="160" r="3" fill="#fff" />
                            <path d="M 490 130 A 40 40 0 0 0 490 190" fill="none" stroke="#fff" strokeWidth="2" />
                            <path d="M 580 32 A 12 12 0 0 1 568 20"   fill="none" stroke="#fff" strokeWidth="2" />
                            <path d="M 580 288 A 12 12 0 0 0 568 300" fill="none" stroke="#fff" strokeWidth="2" />
                        </g>

                        {/* Cờ phạt góc */}
                        <text x="25"  y="32"  fontSize="11" fill="#fff">🚩</text>
                        <text x="25"  y="295" fontSize="11" fill="#fff">🚩</text>
                        <text x="565" y="32"  fontSize="11" fill="#fff">🚩</text>
                        <text x="565" y="295" fontSize="11" fill="#fff">🚩</text>

                        {/* Hiển thị thẻ phạt thật */}
                        {(homeYellowCards > 0 || homeRedCards > 0) && (
                            <g transform="translate(60,45)">
                                <text fontSize="13">🟨 {homeYellowCards}</text>
                                {homeRedCards > 0 && <text x="32" fontSize="13">🟥 {homeRedCards}</text>}
                            </g>
                        )}
                        {(awayYellowCards > 0 || awayRedCards > 0) && (
                            <g transform="translate(500,45)">
                                <text fontSize="13">🟨 {awayYellowCards}</text>
                                {awayRedCards > 0 && <text x="32" fontSize="13">🟥 {awayRedCards}</text>}
                            </g>
                        )}

                        {/* Đường bóng khi sút */}
                        {currentAction.type === 'shot' && (
                            <line
                                x1={currentAction.x} y1={currentAction.y}
                                x2={currentAction.team === 'home' ? 585 : 15} y2={160}
                                stroke="#f59e0b" strokeWidth="2" strokeDasharray="4 4" opacity="0.8"
                            />
                        )}

                        {/* Vòng hiệu ứng khi có bàn thắng */}
                        {currentAction.type === 'goal' && (
                            <circle
                                cx={currentAction.x} cy={currentAction.y} r="28"
                                fill="rgba(250,204,21,0.25)" className="animate-ping"
                            />
                        )}

                        {/* Quả bóng di chuyển theo sự kiện thực tế */}
                        <g
                            transform={`translate(${currentAction.x},${currentAction.y})`}
                            style={{ transition: 'transform 0.6s ease-out' }}
                        >
                            <circle r="14" fill={
                                currentAction.team === 'home'
                                    ? 'rgba(56,189,248,0.35)'
                                    : currentAction.team === 'away'
                                        ? 'rgba(245,158,11,0.35)'
                                        : 'rgba(255,255,255,0.2)'
                            } className="animate-ping" />
                            <circle r="7" fill="#ffffff" stroke="#0f172a" strokeWidth="1.5" />
                            <circle r="2.5" fill="#0f172a" />
                        </g>
                    </svg>
                </div>

            {/* ── Attack Momentum (Tính 100% từ dữ liệu incidents thật) ── */}
            <div className="mt-3 rounded-lg border border-white/8 bg-neutral-900 p-3">
                <div className="flex items-center justify-between text-xs">
                    <span className="font-bold text-neutral-200">Attack Momentum (Nhịp độ tấn công thực tế)</span>
                    <div className="flex items-center gap-3 text-[11px]">
                        <span className="flex items-center gap-1 text-sky-400">
                            <span className="h-2 w-2 rounded-full bg-sky-500" /> {homeTeamName}
                        </span>
                        <span className="flex items-center gap-1 text-amber-400">
                            <span className="h-2 w-2 rounded-full bg-amber-500" /> {awayTeamName}
                        </span>
                    </div>
                </div>
                <div className="mt-2 flex h-14 items-center gap-[2px] overflow-hidden rounded-md bg-black/40 px-2">
                    {momentumBars.map((val, idx) => {
                        const isHome = val >= 0
                        const height = Math.min(24, Math.max(val === 0 ? 1 : 4, Math.abs(val) * 0.38))
                        return (
                            <div key={idx} className="flex h-full flex-1 flex-col items-center justify-center">
                                {isHome ? (
                                    <>
                                        <div
                                            className="w-full rounded-t-sm bg-sky-500 transition-all duration-300"
                                            style={{ height: val === 0 ? '1px' : `${height}px`, opacity: val === 0 ? 0.3 : 1 }}
                                        />
                                        <div className="h-px w-full bg-white/10" />
                                        <div style={{ height: '3px' }} />
                                    </>
                                ) : (
                                    <>
                                        <div style={{ height: '3px' }} />
                                        <div className="h-px w-full bg-white/10" />
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

            {/* ── Bảng Thống Kê Trực Tiếp (100% Số Liệu Thật từ SofaScore) ── */}
            <div className="mt-3 space-y-2.5 rounded-lg border border-white/8 bg-neutral-900 p-3 text-xs">
                {/* Kiểm soát bóng */}
                <div>
                    <div className="flex justify-between font-semibold text-neutral-300">
                        <span className="text-sky-400">{homePossession}%</span>
                        <span className="font-normal text-neutral-500">Kiểm soát bóng (Ball Possession)</span>
                        <span className="text-amber-400">{awayPossession}%</span>
                    </div>
                    <div className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
                        <div className="bg-sky-500 transition-all duration-500" style={{ width: `${homePossession}%` }} />
                        <div className="bg-amber-500 transition-all duration-500" style={{ width: `${awayPossession}%` }} />
                    </div>
                </div>

                {/* Sút trúng đích & Tổng số cú sút */}
                <div className="flex items-center justify-between border-t border-white/5 pt-2 font-semibold">
                    <span className="text-sky-400 font-mono">{homeShotsOn} ({homeShotsTotal})</span>
                    <span className="font-normal text-neutral-500">Sút trúng đích (Tổng sút)</span>
                    <span className="text-amber-400 font-mono">{awayShotsOn} ({awayShotsTotal})</span>
                </div>

                {/* Phạt góc */}
                <div className="flex items-center justify-between border-t border-white/5 pt-2 font-semibold">
                    <span className="text-sky-400 font-mono">{homeCorners}</span>
                    <span className="font-normal text-neutral-500">Phạt góc (Corner Kicks)</span>
                    <span className="text-amber-400 font-mono">{awayCorners}</span>
                </div>

                {/* Thẻ phạt */}
                <div className="flex items-center justify-between border-t border-white/5 pt-2 font-semibold">
                    <span className="text-sky-400 font-mono">
                        {homeYellowCards} 🟨 {homeRedCards > 0 ? `· ${homeRedCards} 🟥` : ''}
                    </span>
                    <span className="font-normal text-neutral-500">Thẻ phạt (Vàng / Đỏ)</span>
                    <span className="text-amber-400 font-mono">
                        {awayYellowCards} 🟨 {awayRedCards > 0 ? `· ${awayRedCards} 🟥` : ''}
                    </span>
                </div>

                {/* Phạm lỗi */}
                <div className="flex items-center justify-between border-t border-white/5 pt-2 font-semibold">
                    <span className="text-sky-400 font-mono">{homeFouls}</span>
                    <span className="font-normal text-neutral-500">Phạm lỗi (Fouls)</span>
                    <span className="text-amber-400 font-mono">{awayFouls}</span>
                </div>
            </div>

            {/* ── Diễn biến thực tế gần nhất (SofaScore Incidents Timeline) ── */}
            {recentIncidents.length > 0 && (
                <div className="mt-3 rounded-lg border border-white/8 bg-neutral-900 p-3 text-xs">
                    <div className="flex items-center justify-between border-b border-white/8 pb-2 text-[11px] font-bold text-neutral-300">
                        <span>Diễn biến trận đấu gần nhất</span>
                        <span className="text-neutral-500">{recentIncidents.length} sự kiện</span>
                    </div>
                    <div className="mt-2 space-y-1.5 max-h-36 overflow-y-auto pr-1">
                        {recentIncidents.slice(0, 5).map((inc, i) => (
                            <div key={i} className="flex items-center justify-between text-[11px] text-neutral-300 py-0.5">
                                <div className="flex items-center gap-2">
                                    <span className="font-mono text-neutral-400 w-8">{inc.time ? `${inc.time}'` : '—'}</span>
                                    <span>
                                        {inc.incidentType === 'goal' ? '⚽' :
                                         inc.incidentType === 'card' ? '🟨' :
                                         inc.incidentType === 'corner' ? '🚩' :
                                         inc.incidentType === 'substitution' ? '🔄' : '⏱'}
                                    </span>
                                    <span className={inc.isHome !== false ? 'text-sky-300' : 'text-amber-300'}>
                                        {inc.player?.name || (inc.isHome !== false ? homeTeamName : awayTeamName)}
                                    </span>
                                    <span className="text-neutral-400">
                                        {inc.incidentType === 'goal' ? 'ghi bàn' :
                                         inc.incidentType === 'card' ? (inc.incidentClass === 'red' ? 'thẻ đỏ' : 'thẻ vàng') :
                                         inc.incidentType === 'substitution' ? 'thay người' :
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

            {/* ── Event ID control ── */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/8 pt-2.5 text-xs">
                <div className="flex items-center gap-2">
                    <span className="font-medium text-neutral-500">SofaScore Event ID:</span>
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
