/**
 * MatchLiveStatsHub — Advanced Match Statistics Hub
 * ─────────────────────────────────────────────────────────────────────────────
 * • Giao diện số liệu chuyên sâu & Match Events Timeline.
 * • Tích hợp MatchHeader: logo câu lạc bộ, phong độ 5 trận gần nhất (W/D/L), tỉ số, phút.
 * • Bố cục Responsive 2 cột trên Desktop (md:grid-cols-2) và 1 cột trên Mobile.
 * • Chia 4 nhóm chỉ số chuẩn tham chiếu:
 *     1. Sút bóng & Khung thành (Attacking & Goal Frame)
 *     2. Chuyền bóng & Kiến tạo (Passing & Playmaking)
 *     3. Tranh chấp & Phòng ngự (Duels & Defense)
 *     4. Kỷ luật & Cố định (Discipline & Set Pieces)
 * • Refresh thủ công với cooldown 45 giây (bảo vệ quota API-Football).
 * • Zero background polling / setInterval.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccurateWithPct, DetailedMatchStatistics, LiveMatchData } from '../lib/types'
import { api } from '../lib/api'
import { MatchHeader } from './MatchHeader'
import { MatchEventsTimeline } from './MatchEventsTimeline'

export interface ActiveMatchHubInfo {
    home: string
    away: string
    score: { home: number; away: number }
    elapsed?: number | string
    status?: 'notstarted' | 'inprogress' | 'finished'
    isLive?: boolean
    period?: string
    league?: string
    homeLogo?: string
    awayLogo?: string
    homeForm?: string[]
    awayForm?: string[]
    corners?: { home: number | null; away: number | null; source?: 'ocr' | 'api' } | null
    shotsOnTarget?: { home: number | null; away: number | null; source?: 'ocr' | 'api' } | null
    shotsTotal?: { home: number | null; away: number | null; source?: 'ocr' | 'api' } | null
    possession?: { home: number | null; away: number | null; source?: 'ocr' | 'api' } | null
    ocrCorners?: { home: number; away: number } | null
    ocrShots?: { home: number; away: number } | null
    fixtureId?: number | string | null
}

interface MatchLiveStatsHubProps {
    home: string
    away: string
    fixtureId?: number | string | null
    /** Dữ liệu live đã được hook useLiveMatchSync fetch lần đầu */
    initialLiveData?: LiveMatchData | null
    activeMatch?: ActiveMatchHubInfo
    onFixtureResolved?: (fixtureId: number) => void
}

const COOLDOWN_SEC = 30

async function resolveFixtureByTeams(homeName: string, awayName: string): Promise<number | null> {
    const h = homeName.trim()
    const a = awayName.trim()
    if (!h && !a) return null
    try {
        const searchRes = await api.footballSearch(h, a)
        if (searchRes?.found && searchRes.fixtureId) {
            return Number(searchRes.fixtureId)
        }
    } catch (err) {
        console.warn('[Refresh] api.footballSearch failed:', err)
    }
    return null
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pct(a: number, b: number): number {
    const t = a + b
    if (t === 0) return 50
    return Math.round((a / t) * 100)
}

function safeDiv(count: number, total: number): string {
    if (total === 0) return '—'
    return `${count} (${Math.round((count / total) * 100)}%)`
}

function display(v: number | undefined | null): string {
    if (v === undefined || v === null) return '—'
    return String(v)
}

function accurateDisplay(data?: AccurateWithPct): { home: string; away: string } {
    if (!data || (data.homeCount === 0 && data.awayCount === 0)) {
        return { home: '—', away: '—' }
    }
    const home = `${data.homeCount} (${data.homePct}%)`
    const away = `${data.awayCount} (${data.awayPct}%)`
    return { home, away }
}

function getStat(teamStats: Array<{ type?: string; value?: any }> | undefined, typeName: string): number | null {
    if (!teamStats || !Array.isArray(teamStats)) return null
    const item = teamStats.find((s) => s.type?.toLowerCase() === typeName.toLowerCase())
    if (!item || item.value === null || item.value === undefined) return null
    if (typeof item.value === 'string') {
        const clean = item.value.replace('%', '').trim()
        const parsed = parseInt(clean, 10)
        return isNaN(parsed) ? null : parsed
    }
    if (typeof item.value === 'number') {
        return item.value
    }
    return null
}

// ── StatBar ───────────────────────────────────────────────────────────────────

interface StatBarProps {
    label: string
    homeVal: number | null | undefined
    awayVal: number | null | undefined
    homeDisplay: string
    awayDisplay: string
    /** true = kiểm soát bóng */
    isPossession?: boolean
    highlight?: 'none' | 'home' | 'away'
    tag?: string
}

function StatBar({
    label,
    homeVal,
    awayVal,
    homeDisplay,
    awayDisplay,
    isPossession,
    highlight = 'none',
    tag,
}: StatBarProps) {
    const isNull = homeVal === null || homeVal === undefined || awayVal === null || awayVal === undefined
    const homeW = isNull ? 50 : isPossession ? homeVal : pct(homeVal, awayVal)
    const awayW = 100 - homeW

    const homeEdge = !isNull && homeVal > awayVal ? 'text-sky-300 font-bold' : 'text-slate-300'
    const awayEdge = !isNull && awayVal > homeVal ? 'text-amber-300 font-bold' : 'text-slate-300'

    const highlightHome = highlight === 'home' ? 'ring-1 ring-sky-400/60 rounded px-1 bg-sky-500/10' : ''
    const highlightAway = highlight === 'away' ? 'ring-1 ring-amber-400/60 rounded px-1 bg-amber-500/10' : ''

    return (
        <div className="mb-2.5 last:mb-0">
            <div className="mb-1 flex items-center justify-between gap-2">
                <span className={`min-w-[3.5rem] text-right text-xs font-semibold tabular-nums ${homeEdge} ${highlightHome}`}>
                    {homeDisplay}
                </span>
                <span className="flex-1 text-center text-[11px] font-medium text-slate-400 leading-none">
                    {label}
                    {tag && <span className="ml-1 text-[10px] text-sky-400 font-normal">({tag})</span>}
                </span>
                <span className={`min-w-[3.5rem] text-left text-xs font-semibold tabular-nums ${awayEdge} ${highlightAway}`}>
                    {awayDisplay}
                </span>
            </div>
            <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                {isNull ? (
                    <div className="h-full w-full bg-slate-800/80" />
                ) : (
                    <>
                        <div
                            className="h-full rounded-full bg-gradient-to-r from-sky-500 to-sky-400 transition-all duration-700"
                            style={{ width: `${homeW}%` }}
                        />
                        <div
                            className="h-full flex-1 rounded-full bg-gradient-to-l from-amber-500 to-amber-400 transition-all duration-700"
                            style={{ width: `${awayW}%` }}
                        />
                    </>
                )}
            </div>
        </div>
    )
}

// ── GroupHeader ───────────────────────────────────────────────────────────────

function GroupHeader({
    icon,
    title,
    homeTag,
    awayTag,
}: {
    icon: string
    title: string
    homeTag: string
    awayTag: string
}) {
    return (
        <div className="mb-3 flex items-center justify-between border-b border-white/10 pb-2">
            <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-300">
                <span>{icon}</span>
                {title}
            </span>
            <div className="flex gap-2.5 text-[10px] font-bold">
                <span className="text-sky-400">{homeTag}</span>
                <span className="text-amber-400">{awayTag}</span>
            </div>
        </div>
    )
}

// ── Main Component ────────────────────────────────────────────────────────────

export function MatchLiveStatsHub({ home, away, fixtureId, initialLiveData, activeMatch, onFixtureResolved }: MatchLiveStatsHubProps) {
    const [liveData, setLiveData] = useState<LiveMatchData | null>(initialLiveData ?? null)
    const [activeTab, setActiveTab] = useState<'stats' | 'events'>('stats')
    const [loading, setLoading] = useState(false)
    const [cooldown, setCooldown] = useState(0)
    const [lastSync, setLastSync] = useState<Date | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [successMsg, setSuccessMsg] = useState<string | null>(null)
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

    // Đồng bộ prop initialLiveData vào state khi thay đổi trận
    useEffect(() => {
        if (initialLiveData) setLiveData(initialLiveData)
    }, [initialLiveData])

    const startCooldown = useCallback((seconds: number = COOLDOWN_SEC) => {
        setCooldown(seconds)
        if (timerRef.current) clearInterval(timerRef.current)
        timerRef.current = setInterval(() => {
            setCooldown((prev) => {
                if (prev <= 1) {
                    if (timerRef.current) clearInterval(timerRef.current)
                    timerRef.current = null
                    return 0
                }
                return prev - 1
            })
        }, 1000)
    }, [])

    useEffect(() => {
        return () => {
            if (timerRef.current) clearInterval(timerRef.current)
        }
    }, [])

    const handleManualRefresh = useCallback(async () => {
        if (loading || cooldown > 0) return

        setLoading(true)
        setError(null)
        setSuccessMsg(null)
        try {
            // Step A: If fixtureId is missing, resolve it dynamically by team names
            let currentFixtureId: number | string | null | undefined =
                fixtureId ?? activeMatch?.fixtureId ?? liveData?.fixtureId

            if (!currentFixtureId) {
                console.log('[Refresh] Missing fixtureId, resolving via API-Football search...')
                const hTeam = (liveData?.homeTeam || activeMatch?.home || home || '').trim()
                const aTeam = (liveData?.awayTeam || activeMatch?.away || away || '').trim()
                if (hTeam || aTeam) {
                    const resolvedId = await resolveFixtureByTeams(hTeam, aTeam)
                    if (resolvedId) {
                        currentFixtureId = resolvedId
                        onFixtureResolved?.(resolvedId)
                    }
                }
            }

            if (!currentFixtureId) {
                setError('Không tìm thấy trận đấu này trên API-Football. Hãy kiểm tra lại tên đội.')
                setLoading(false)
                return
            }

            // Step B: Fetch latest stats and fixture details
            const numId = Number(currentFixtureId)
            const fullLive = await api.footballFixtureLive(numId)
            if (fullLive?.found) {
                const mStats = fullLive.matchStats
                setLiveData({
                    found: true,
                    eventId: fullLive.eventId,
                    fixtureId: fullLive.fixtureId,
                    homeTeam: fullLive.homeTeam || home,
                    awayTeam: fullLive.awayTeam || away,
                    homeLogo: fullLive.homeLogo,
                    awayLogo: fullLive.awayLogo,
                    homeTeamId: fullLive.homeTeamId,
                    awayTeamId: fullLive.awayTeamId,
                    homeForm: fullLive.homeForm,
                    awayForm: fullLive.awayForm,
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
                    possession: mStats?.possession ?? { home: 0, away: 0 },
                    fouls: mStats?.fouls ?? { home: 0, away: 0 },
                    accuratePasses: mStats?.accuratePasses ?? { home: 0, away: 0 },
                    detailedStats: fullLive.detailedStats,
                    rawStatistics: fullLive.rawStatistics,
                    incidents: fullLive.incidents,
                    events: fullLive.events,
                    isFinished: fullLive.isFinished,
                    lastUpdated: fullLive.lastUpdated || Date.now(),
                })
                setLastSync(new Date())
                setSuccessMsg('Đã cập nhật số liệu mới nhất!')
                setTimeout(() => setSuccessMsg(null), 4000)

                // Step C: Start clear 30-second cooldown
                startCooldown(30)
            } else {
                setError('Không tìm thấy dữ liệu thống kê từ API-Football cho trận này.')
            }
        } catch (err) {
            console.error('[Refresh Error]:', err)
            setError('Lỗi khi tải dữ liệu mới. Vui lòng thử lại sau.')
        } finally {
            setLoading(false)
        }
    }, [loading, cooldown, fixtureId, activeMatch, liveData, home, away, onFixtureResolved, startCooldown])

    const ds: DetailedMatchStatistics | undefined | null = liveData?.detailedStats
    const score = liveData?.score ?? activeMatch?.score ?? { home: 0, away: 0 }
    const periodScore = liveData?.periodScore
    const minute = liveData?.minute ?? activeMatch?.elapsed
    const homeTeamName = liveData?.homeTeam || activeMatch?.home || home
    const awayTeamName = liveData?.awayTeam || activeMatch?.away || away
    const homeLogo = liveData?.homeLogo ?? activeMatch?.homeLogo
    const awayLogo = liveData?.awayLogo ?? activeMatch?.awayLogo
    const homeForm = liveData?.homeForm ?? activeMatch?.homeForm
    const awayForm = liveData?.awayForm ?? activeMatch?.awayForm
    const status = liveData?.status ?? activeMatch?.status ?? (activeMatch?.isLive ? 'inprogress' : 'notstarted')
    const league = liveData?.league ?? activeMatch?.league
    const homeTag = homeTeamName.slice(0, 10)
    const awayTag = awayTeamName.slice(0, 10)

    // Kiểm tra xem API có trả về số liệu chi tiết thực tế hay không
    const hasDetailedData = Boolean(
        ds &&
        (ds.totalPasses.home > 0 ||
         ds.totalPasses.away > 0 ||
         ds.shotsTotal.home > 0 ||
         ds.shotsTotal.away > 0 ||
         ds.tackles.home > 0 ||
         ds.tackles.away > 0)
    )

    // Xác định danh sách thống kê raw theo đội
    const homeTeamId = liveData?.homeTeamId
    const awayTeamId = liveData?.awayTeamId
    let homeStatsList = liveData?.rawStatistics?.[0]?.statistics
    let awayStatsList = liveData?.rawStatistics?.[1]?.statistics
    if (homeTeamId && liveData?.rawStatistics && liveData.rawStatistics.length >= 2) {
        const foundHome = liveData.rawStatistics.find((r) => r.team?.id === homeTeamId)
        const foundAway = liveData.rawStatistics.find((r) => r.team?.id === awayTeamId)
        if (foundHome) homeStatsList = foundHome.statistics
        if (foundAway) awayStatsList = foundAway.statistics
    }

    // ── DATA SOURCE HIERARCHY WATERFALL ──────────────────────────────────────

    // 1. Phạt góc (Corners)
    let resolvedCorners: { home: number | null; away: number | null; source?: 'ocr' | 'api' } = { home: null, away: null }
    if (activeMatch?.ocrCorners && (activeMatch.ocrCorners.home !== null || activeMatch.ocrCorners.away !== null)) {
        resolvedCorners = { home: activeMatch.ocrCorners.home, away: activeMatch.ocrCorners.away, source: 'ocr' }
    } else if (activeMatch?.corners && activeMatch.corners.source === 'ocr') {
        resolvedCorners = { home: activeMatch.corners.home, away: activeMatch.corners.away, source: 'ocr' }
    } else {
        const apiHomeCorners = getStat(homeStatsList, 'Corner Kicks')
        const apiAwayCorners = getStat(awayStatsList, 'Corner Kicks')
        if (apiHomeCorners !== null && apiAwayCorners !== null) {
            resolvedCorners = { home: apiHomeCorners, away: apiAwayCorners, source: 'api' }
        } else if (ds?.corners && (ds.corners.home > 0 || ds.corners.away > 0)) {
            resolvedCorners = { home: ds.corners.home, away: ds.corners.away, source: 'api' }
        } else if (liveData?.corners && (liveData.corners.home > 0 || liveData.corners.away > 0)) {
            resolvedCorners = { home: liveData.corners.home, away: liveData.corners.away, source: 'api' }
        } else if (activeMatch?.corners && activeMatch.corners.home !== null && activeMatch.corners.away !== null) {
            resolvedCorners = { home: activeMatch.corners.home, away: activeMatch.corners.away, source: activeMatch.corners.source || 'api' }
        }
    }

    // 2. Kiểm soát bóng (Possession)
    let resolvedPoss: { home: number | null; away: number | null; source?: 'api' } = { home: null, away: null }
    const apiHomePoss = getStat(homeStatsList, 'Ball Possession')
    const apiAwayPoss = getStat(awayStatsList, 'Ball Possession')
    if (apiHomePoss !== null && apiAwayPoss !== null) {
        resolvedPoss = { home: apiHomePoss, away: apiAwayPoss, source: 'api' }
    } else if (ds?.possession && (ds.possession.home > 0 || ds.possession.away > 0) && !(ds.possession.home === 50 && ds.possession.away === 50 && !activeMatch?.isLive)) {
        resolvedPoss = { home: ds.possession.home, away: ds.possession.away, source: 'api' }
    } else if (liveData?.possession && (liveData.possession.home > 0 || liveData.possession.away > 0) && !(liveData.possession.home === 50 && liveData.possession.away === 50 && !activeMatch?.isLive)) {
        resolvedPoss = { home: liveData.possession.home, away: liveData.possession.away, source: 'api' }
    } else if (activeMatch?.possession && activeMatch.possession.home !== null && activeMatch.possession.away !== null) {
        resolvedPoss = { home: activeMatch.possession.home, away: activeMatch.possession.away, source: 'api' }
    }

    // 3. Tổng số cú sút (Shots Total)
    let resolvedShotsTotal: { home: number | null; away: number | null; source?: 'ocr' | 'api' } = { home: null, away: null }
    if (activeMatch?.ocrShots && (activeMatch.ocrShots.home !== null || activeMatch.ocrShots.away !== null)) {
        resolvedShotsTotal = { home: activeMatch.ocrShots.home, away: activeMatch.ocrShots.away, source: 'ocr' }
    } else if (activeMatch?.shotsTotal && activeMatch.shotsTotal.source === 'ocr') {
        resolvedShotsTotal = { home: activeMatch.shotsTotal.home, away: activeMatch.shotsTotal.away, source: 'ocr' }
    } else {
        const apiHomeShots = getStat(homeStatsList, 'Total Shots')
        const apiAwayShots = getStat(awayStatsList, 'Total Shots')
        if (apiHomeShots !== null && apiAwayShots !== null) {
            resolvedShotsTotal = { home: apiHomeShots, away: apiAwayShots, source: 'api' }
        } else if (ds?.shotsTotal && (ds.shotsTotal.home > 0 || ds.shotsTotal.away > 0)) {
            resolvedShotsTotal = { home: ds.shotsTotal.home, away: ds.shotsTotal.away, source: 'api' }
        } else if (liveData?.shotsTotal && (liveData.shotsTotal.home > 0 || liveData.shotsTotal.away > 0)) {
            resolvedShotsTotal = { home: liveData.shotsTotal.home, away: liveData.shotsTotal.away, source: 'api' }
        } else if (activeMatch?.shotsTotal && activeMatch.shotsTotal.home !== null && activeMatch.shotsTotal.away !== null) {
            resolvedShotsTotal = { home: activeMatch.shotsTotal.home, away: activeMatch.shotsTotal.away, source: activeMatch.shotsTotal.source || 'api' }
        }
    }

    // 4. Sút trúng đích (Shots on Goal)
    let resolvedShotsOnGoal: { home: number | null; away: number | null; source?: 'ocr' | 'api' } = { home: null, away: null }
    if (activeMatch?.shotsOnTarget && activeMatch.shotsOnTarget.source === 'ocr') {
        resolvedShotsOnGoal = { home: activeMatch.shotsOnTarget.home, away: activeMatch.shotsOnTarget.away, source: 'ocr' }
    } else {
        const apiHomeOnGoal = getStat(homeStatsList, 'Shots on Goal')
        const apiAwayOnGoal = getStat(awayStatsList, 'Shots on Goal')
        if (apiHomeOnGoal !== null && apiAwayOnGoal !== null) {
            resolvedShotsOnGoal = { home: apiHomeOnGoal, away: apiAwayOnGoal, source: 'api' }
        } else if (ds?.shotsOnGoal && (ds.shotsOnGoal.home > 0 || ds.shotsOnGoal.away > 0)) {
            resolvedShotsOnGoal = { home: ds.shotsOnGoal.home, away: ds.shotsOnGoal.away, source: 'api' }
        } else if (liveData?.shotsOnTarget && (liveData.shotsOnTarget.home > 0 || liveData.shotsOnTarget.away > 0)) {
            resolvedShotsOnGoal = { home: liveData.shotsOnTarget.home, away: liveData.shotsOnTarget.away, source: 'api' }
        } else if (activeMatch?.shotsOnTarget && activeMatch.shotsOnTarget.home !== null && activeMatch.shotsOnTarget.away !== null) {
            resolvedShotsOnGoal = { home: activeMatch.shotsOnTarget.home, away: activeMatch.shotsOnTarget.away, source: activeMatch.shotsOnTarget.source || 'api' }
        }
    }

    // 5. Phạm lỗi (Fouls)
    let resolvedFouls: { home: number | null; away: number | null } = { home: null, away: null }
    const apiHomeFouls = getStat(homeStatsList, 'Fouls')
    const apiAwayFouls = getStat(awayStatsList, 'Fouls')
    if (apiHomeFouls !== null && apiAwayFouls !== null) {
        resolvedFouls = { home: apiHomeFouls, away: apiAwayFouls }
    } else if (ds?.fouls && (ds.fouls.home > 0 || ds.fouls.away > 0)) {
        resolvedFouls = { home: ds.fouls.home, away: ds.fouls.away }
    } else if (liveData?.fouls && (liveData.fouls.home > 0 || liveData.fouls.away > 0)) {
        resolvedFouls = { home: liveData.fouls.home, away: liveData.fouls.away }
    }

    // 6. Thẻ phạt (Cards)
    let resolvedYellowCards: { home: number | null; away: number | null } = { home: null, away: null }
    const apiHomeYellow = getStat(homeStatsList, 'Yellow Cards')
    const apiAwayYellow = getStat(awayStatsList, 'Yellow Cards')
    if (apiHomeYellow !== null && apiAwayYellow !== null) {
        resolvedYellowCards = { home: apiHomeYellow, away: apiAwayYellow }
    } else if (ds?.yellowCards && (ds.yellowCards.home > 0 || ds.yellowCards.away > 0)) {
        resolvedYellowCards = { home: ds.yellowCards.home, away: ds.yellowCards.away }
    } else if (liveData?.cards && (liveData.cards.yellowHome > 0 || liveData.cards.yellowAway > 0)) {
        resolvedYellowCards = { home: liveData.cards.yellowHome, away: liveData.cards.yellowAway }
    }

    let resolvedRedCards: { home: number | null; away: number | null } = { home: null, away: null }
    const apiHomeRed = getStat(homeStatsList, 'Red Cards')
    const apiAwayRed = getStat(awayStatsList, 'Red Cards')
    if (apiHomeRed !== null && apiAwayRed !== null) {
        resolvedRedCards = { home: apiHomeRed, away: apiAwayRed }
    } else if (ds?.redCards && (ds.redCards.home > 0 || ds.redCards.away > 0)) {
        resolvedRedCards = { home: ds.redCards.home, away: ds.redCards.away }
    } else if (liveData?.cards && (liveData.cards.redHome > 0 || liveData.cards.redAway > 0)) {
        resolvedRedCards = { home: liveData.cards.redHome, away: liveData.cards.redAway }
    }

    const hasOcrData = Boolean(
        resolvedCorners.source === 'ocr' ||
        resolvedShotsTotal.source === 'ocr' ||
        resolvedShotsOnGoal.source === 'ocr' ||
        activeMatch?.ocrCorners ||
        activeMatch?.ocrShots
    )

    return (
        <div className="space-y-4">
            {/* ── 1. Match Header (Logos, Form Badges, Score, Minute) ── */}
            <MatchHeader
                homeTeam={homeTeamName}
                awayTeam={awayTeamName}
                homeLogo={homeLogo}
                awayLogo={awayLogo}
                score={score}
                minute={minute}
                periodScore={periodScore}
                status={status}
                league={league}
                homeForm={homeForm}
                awayForm={awayForm}
            />

            {/* ── 2. Hub Control Bar (Tabs & Refresh Action) ── */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-slate-900/60 p-2.5 backdrop-blur-md">
                {/* Tabs */}
                <div className="flex items-center gap-1.5">
                    <button
                        onClick={() => setActiveTab('stats')}
                        className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
                            activeTab === 'stats'
                                ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30 shadow-sm'
                                : 'text-slate-400 hover:text-white'
                        }`}
                    >
                        <span>📊</span>
                        <span>Số liệu chuyên sâu</span>
                    </button>
                    <button
                        onClick={() => setActiveTab('events')}
                        className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
                            activeTab === 'events'
                                ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30 shadow-sm'
                                : 'text-slate-400 hover:text-white'
                        }`}
                    >
                        <span>⏱️</span>
                        <span>Sự kiện trận đấu</span>
                        {liveData?.events && liveData.events.length > 0 && (
                            <span className="rounded-full bg-sky-500/30 px-1.5 py-0.2 text-[10px] text-sky-200">
                                {liveData.events.length}
                            </span>
                        )}
                    </button>
                </div>

                {/* Manual Refresh Button with 30s Cooldown */}
                <button
                    onClick={handleManualRefresh}
                    disabled={loading || cooldown > 0}
                    className={[
                        'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all shadow-sm',
                        loading || cooldown > 0
                            ? 'cursor-not-allowed bg-white/5 text-slate-500 border border-white/5'
                            : 'bg-sky-500/20 text-sky-300 border border-sky-500/40 hover:bg-sky-500/30 active:scale-95 cursor-pointer',
                    ].join(' ')}
                >
                    <svg
                        className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                    >
                        <path d="M23 4v6h-6" />
                        <path d="M1 20v-6h6" />
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                    </svg>
                    <span>{loading ? 'Đang tải...' : cooldown > 0 ? `Chờ ${cooldown}s` : 'Cập nhật số liệu'}</span>
                </button>
            </div>

            {/* Error Banner */}
            {error && (
                <div className="flex items-center justify-between gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-300">
                    <div className="flex items-center gap-2">
                        <span>⚠️</span>
                        <span>{error}</span>
                    </div>
                    <button onClick={() => setError(null)} className="text-rose-400 hover:text-white text-xs">✕</button>
                </div>
            )}

            {/* Success Banner */}
            {successMsg && (
                <div className="flex items-center justify-between gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2 text-xs text-emerald-300">
                    <div className="flex items-center gap-2">
                        <span>✅</span>
                        <span>{successMsg}</span>
                    </div>
                    <button onClick={() => setSuccessMsg(null)} className="text-emerald-400 hover:text-white text-xs">✕</button>
                </div>
            )}

            {/* ── 3. Tab Content: Events Timeline ── */}
            {activeTab === 'events' && (
                <MatchEventsTimeline
                    events={liveData?.events}
                    homeTeam={homeTeamName}
                    awayTeam={awayTeamName}
                    periodScore={periodScore}
                    score={score}
                />
            )}

            {/* ── 4. Tab Content: 2-Column Responsive Stats Grid (Desktop 2-Col vs Mobile 1-Col) ── */}
            {activeTab === 'stats' && (
                <div className="space-y-3">
                    {/* Missing / Unsupported League Fallback Notice Badge */}
                    {!hasDetailedData && (
                        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200">
                            <div className="flex items-center gap-2">
                                <span className="text-base leading-none">⚠️</span>
                                <span className="font-semibold">Giải đấu này không hỗ trợ dữ liệu thống kê trực tiếp chi tiết</span>
                            </div>
                            {resolvedCorners.source === 'ocr' && resolvedCorners.home !== null && resolvedCorners.away !== null && (
                                <span className="rounded-md border border-sky-400/40 bg-sky-500/20 px-2 py-0.5 text-[11px] font-bold text-sky-300">
                                    Phạt góc: {resolvedCorners.home} - {resolvedCorners.away} (từ ảnh cược)
                                </span>
                            )}
                        </div>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4 w-full">
                        {/* ── NHÓM 1: Sút bóng & Khung thành (Attacking & Goal Frame) ── */}
                        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-3.5 shadow-xl backdrop-blur-md">
                            <GroupHeader icon="🎯" title="Sút bóng & Khung thành" homeTag={homeTag} awayTag={awayTag} />

                            {/* Tỷ lệ kiểm soát bóng */}
                            <StatBar
                                label="Kiểm soát bóng"
                                homeVal={resolvedPoss.home}
                                awayVal={resolvedPoss.away}
                                homeDisplay={resolvedPoss.home !== null ? `${resolvedPoss.home}%` : '—'}
                                awayDisplay={resolvedPoss.away !== null ? `${resolvedPoss.away}%` : '—'}
                                isPossession
                            />

                            {/* Tổng số cú sút */}
                            <StatBar
                                label="Tổng số cú sút"
                                homeVal={resolvedShotsTotal.home}
                                awayVal={resolvedShotsTotal.away}
                                homeDisplay={display(resolvedShotsTotal.home)}
                                awayDisplay={display(resolvedShotsTotal.away)}
                                tag={resolvedShotsTotal.source === 'ocr' ? 'từ ảnh cược' : undefined}
                            />

                            {/* Visual Goal Frame (Sút trúng khung thành) */}
                            <div className="my-3 rounded-xl border border-sky-500/20 bg-sky-950/20 p-2.5">
                                <div className="mb-1.5 flex items-center justify-between text-xs font-semibold text-slate-400">
                                    <span className="font-bold text-sky-400 tabular-nums">{display(resolvedShotsOnGoal.home)}</span>
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-300">
                                        🥅 Sút trúng khung thành
                                        {resolvedShotsOnGoal.source === 'ocr' && (
                                            <span className="ml-1 text-[10px] font-normal text-sky-400">(từ ảnh cược)</span>
                                        )}
                                    </span>
                                    <span className="font-bold text-amber-400 tabular-nums">{display(resolvedShotsOnGoal.away)}</span>
                                </div>
                                <div className="relative mx-auto flex h-11 w-full max-w-[200px] items-center justify-between rounded-t-sm border-t-2 border-l-2 border-r-2 border-white/40 bg-gradient-to-b from-white/[0.06] to-transparent px-5">
                                    <span className="font-mono text-base font-black text-sky-300 tabular-nums">
                                        {display(resolvedShotsOnGoal.home)}
                                    </span>
                                    <span className="h-4 w-px bg-white/20" />
                                    <span className="font-mono text-base font-black text-amber-300 tabular-nums">
                                        {display(resolvedShotsOnGoal.away)}
                                    </span>
                                </div>
                            </div>

                            {/* Sút trượt khung thành */}
                            {hasDetailedData && ds?.shotsOffGoal && (
                                <StatBar
                                    label="Sút trượt khung thành"
                                    homeVal={ds.shotsOffGoal.home}
                                    awayVal={ds.shotsOffGoal.away}
                                    homeDisplay={display(ds.shotsOffGoal.home)}
                                    awayDisplay={display(ds.shotsOffGoal.away)}
                                />
                            )}

                            {/* Cú sút bị cản phá */}
                            {hasDetailedData && ds?.shotsBlocked && (
                                <StatBar
                                    label="Cú sút bị cản phá"
                                    homeVal={ds.shotsBlocked.home}
                                    awayVal={ds.shotsBlocked.away}
                                    homeDisplay={display(ds.shotsBlocked.home)}
                                    awayDisplay={display(ds.shotsBlocked.away)}
                                />
                            )}

                            {/* Dứt điểm trong vòng cấm */}
                            {hasDetailedData && ds?.shotsInsideBox && (
                                <StatBar
                                    label="Dứt điểm trong vòng cấm"
                                    homeVal={ds.shotsInsideBox.home}
                                    awayVal={ds.shotsInsideBox.away}
                                    homeDisplay={display(ds.shotsInsideBox.home)}
                                    awayDisplay={display(ds.shotsInsideBox.away)}
                                />
                            )}

                            {/* Dứt điểm ngoài vòng cấm */}
                            {hasDetailedData && ds?.shotsOutsideBox && (
                                <StatBar
                                    label="Dứt điểm ngoài vòng cấm"
                                    homeVal={ds.shotsOutsideBox.home}
                                    awayVal={ds.shotsOutsideBox.away}
                                    homeDisplay={display(ds.shotsOutsideBox.home)}
                                    awayDisplay={display(ds.shotsOutsideBox.away)}
                                />
                            )}

                            {/* Quả phạt đền được hưởng */}
                            {hasDetailedData && ds?.penalties && (
                                <StatBar
                                    label="Quả phạt đền được hưởng"
                                    homeVal={ds.penalties.home}
                                    awayVal={ds.penalties.away}
                                    homeDisplay={display(ds.penalties.home)}
                                    awayDisplay={display(ds.penalties.away)}
                                />
                            )}

                            {/* xG nếu có */}
                            {hasDetailedData && ds?.expectedGoals && (
                                <StatBar
                                    label="Bàn thắng kỳ vọng (xG)"
                                    homeVal={ds.expectedGoals.home}
                                    awayVal={ds.expectedGoals.away}
                                    homeDisplay={ds.expectedGoals.home.toFixed(2)}
                                    awayDisplay={ds.expectedGoals.away.toFixed(2)}
                                />
                            )}
                        </div>

                        {/* ── NHÓM 2: Chuyền bóng & Kiến tạo (Passing & Playmaking) ── */}
                        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-3.5 shadow-xl backdrop-blur-md">
                            <GroupHeader icon="⚡" title="Chuyền bóng & Kiến tạo" homeTag={homeTag} awayTag={awayTag} />

                            {hasDetailedData && ds ? (
                                <>
                                    <StatBar
                                        label="Tổng số đường chuyền"
                                        homeVal={ds.totalPasses.home}
                                        awayVal={ds.totalPasses.away}
                                        homeDisplay={display(ds.totalPasses.home)}
                                        awayDisplay={display(ds.totalPasses.away)}
                                    />

                                    {ds.keyPasses && (
                                        <StatBar
                                            label="Đường chuyền quyết định (Key passes)"
                                            homeVal={ds.keyPasses.home}
                                            awayVal={ds.keyPasses.away}
                                            homeDisplay={display(ds.keyPasses.home)}
                                            awayDisplay={display(ds.keyPasses.away)}
                                        />
                                    )}

                                    <StatBar
                                        label="Đường chuyền chính xác"
                                        homeVal={ds.accuratePasses.homeCount}
                                        awayVal={ds.accuratePasses.awayCount}
                                        homeDisplay={safeDiv(ds.accuratePasses.homeCount, ds.totalPasses.home)}
                                        awayDisplay={safeDiv(ds.accuratePasses.awayCount, ds.totalPasses.away)}
                                    />

                                    <StatBar
                                        label="Quả tạt chính xác"
                                        homeVal={ds.accurateCrosses.homeCount}
                                        awayVal={ds.accurateCrosses.awayCount}
                                        homeDisplay={
                                            ds.accurateCrosses.homeCount > 0
                                                ? `${ds.accurateCrosses.homeCount} (${ds.accurateCrosses.homePct}%)`
                                                : '—'
                                        }
                                        awayDisplay={
                                            ds.accurateCrosses.awayCount > 0
                                                ? `${ds.accurateCrosses.awayCount} (${ds.accurateCrosses.awayPct}%)`
                                                : '—'
                                        }
                                    />

                                    <StatBar
                                        label="Bóng dài chính xác"
                                        homeVal={ds.accurateLongBalls.homeCount}
                                        awayVal={ds.accurateLongBalls.awayCount}
                                        homeDisplay={
                                            ds.accurateLongBalls.homeCount > 0
                                                ? `${ds.accurateLongBalls.homeCount} (${ds.accurateLongBalls.homePct}%)`
                                                : '—'
                                        }
                                        awayDisplay={
                                            ds.accurateLongBalls.awayCount > 0
                                                ? `${ds.accurateLongBalls.awayCount} (${ds.accurateLongBalls.awayPct}%)`
                                                : '—'
                                        }
                                    />
                                </>
                            ) : (
                                <div className="space-y-3">
                                    <StatBar
                                        label="Chuyền chính xác"
                                        homeVal={null}
                                        awayVal={null}
                                        homeDisplay="—"
                                        awayDisplay="—"
                                    />
                                    <div className="rounded-xl border border-dashed border-white/10 bg-white/5 p-3.5 text-center">
                                        <p className="text-xs font-semibold text-slate-300">Chuyền bóng: Chưa hỗ trợ giải này</p>
                                        <p className="mt-1 text-[11px] text-slate-500">
                                            Giải đấu này không cung cấp số liệu phân tích đường chuyền trực tiếp từ API.
                                        </p>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* ── NHÓM 3: Tranh chấp & Phòng ngự (Duels & Defense) ── */}
                        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-3.5 shadow-xl backdrop-blur-md">
                            <GroupHeader icon="🛡️" title="Tranh chấp & Phòng ngự" homeTag={homeTag} awayTag={awayTag} />

                            {hasDetailedData && ds?.duelsWon && (
                                <StatBar
                                    label="Tranh chấp thắng"
                                    homeVal={ds.duelsWon.homeCount}
                                    awayVal={ds.duelsWon.awayCount}
                                    homeDisplay={accurateDisplay(ds.duelsWon).home}
                                    awayDisplay={accurateDisplay(ds.duelsWon).away}
                                />
                            )}

                            {hasDetailedData && ds?.aerialDuelsWon && (
                                <StatBar
                                    label="Tranh chấp bóng bổng thắng"
                                    homeVal={ds.aerialDuelsWon.homeCount}
                                    awayVal={ds.aerialDuelsWon.awayCount}
                                    homeDisplay={accurateDisplay(ds.aerialDuelsWon).home}
                                    awayDisplay={accurateDisplay(ds.aerialDuelsWon).away}
                                />
                            )}

                            {hasDetailedData && ds && (
                                <>
                                    <StatBar
                                        label="Tắc bóng"
                                        homeVal={ds.tackles.home}
                                        awayVal={ds.tackles.away}
                                        homeDisplay={display(ds.tackles.home)}
                                        awayDisplay={display(ds.tackles.away)}
                                    />
                                    <StatBar
                                        label="Cắt bóng"
                                        homeVal={ds.interceptions.home}
                                        awayVal={ds.interceptions.away}
                                        homeDisplay={display(ds.interceptions.home)}
                                        awayDisplay={display(ds.interceptions.away)}
                                    />
                                    <StatBar
                                        label="Giải nguy"
                                        homeVal={ds.clearances.home}
                                        awayVal={ds.clearances.away}
                                        homeDisplay={display(ds.clearances.home)}
                                        awayDisplay={display(ds.clearances.away)}
                                    />
                                </>
                            )}

                            <StatBar
                                label="Phạm luật"
                                homeVal={resolvedFouls.home}
                                awayVal={resolvedFouls.away}
                                homeDisplay={display(resolvedFouls.home)}
                                awayDisplay={display(resolvedFouls.away)}
                            />

                            {hasDetailedData && ds?.goalkeeperSaves && (
                                <StatBar
                                    label="Cứu bóng (Thủ môn)"
                                    homeVal={ds.goalkeeperSaves.home}
                                    awayVal={ds.goalkeeperSaves.away}
                                    homeDisplay={display(ds.goalkeeperSaves.home)}
                                    awayDisplay={display(ds.goalkeeperSaves.away)}
                                />
                            )}

                            {!hasDetailedData && (
                                <div className="mt-2 text-center text-[11px] text-slate-500 italic">
                                    Tranh chấp & phòng ngự: Chỉ hiển thị các chỉ số được hỗ trợ
                                </div>
                            )}
                        </div>

                        {/* ── NHÓM 4: Kỷ luật & Cố định (Discipline & Set Pieces) ── */}
                        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-3.5 shadow-xl backdrop-blur-md">
                            <GroupHeader icon="🚩" title="Kỷ luật & Cố định" homeTag={homeTag} awayTag={awayTag} />

                            <StatBar
                                label="Phạt góc"
                                homeVal={resolvedCorners.home}
                                awayVal={resolvedCorners.away}
                                homeDisplay={display(resolvedCorners.home)}
                                awayDisplay={display(resolvedCorners.away)}
                                tag={resolvedCorners.source === 'ocr' ? 'từ ảnh cược' : undefined}
                            />

                            {hasDetailedData && ds?.offsides && (
                                <StatBar
                                    label="Việt vị"
                                    homeVal={ds.offsides.home}
                                    awayVal={ds.offsides.away}
                                    homeDisplay={display(ds.offsides.home)}
                                    awayDisplay={display(ds.offsides.away)}
                                />
                            )}

                            <StatBar
                                label="Thẻ vàng 🟨"
                                homeVal={resolvedYellowCards.home}
                                awayVal={resolvedYellowCards.away}
                                homeDisplay={display(resolvedYellowCards.home)}
                                awayDisplay={display(resolvedYellowCards.away)}
                            />

                            <StatBar
                                label="Thẻ đỏ 🟥"
                                homeVal={resolvedRedCards.home}
                                awayVal={resolvedRedCards.away}
                                homeDisplay={display(resolvedRedCards.home)}
                                awayDisplay={display(resolvedRedCards.away)}
                            />
                        </div>
                    </div>

                    {/* Footer Info */}
                    <div className="flex flex-wrap items-center justify-between gap-1 border-t border-white/10 pt-2.5 text-[11px] text-slate-500">
                        <span>
                            {lastSync
                                ? `Cập nhật lần cuối: ${lastSync.toLocaleTimeString('vi-VN', {
                                      hour: '2-digit',
                                      minute: '2-digit',
                                      second: '2-digit',
                                  })}`
                                : liveData?.lastUpdated
                                  ? `Dữ liệu snapshot lúc ${new Date(liveData.lastUpdated).toLocaleTimeString('vi-VN', {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                    })}`
                                  : hasOcrData
                                    ? 'Đã đồng bộ số liệu trực tiếp từ ảnh cược (OCR)'
                                    : 'Chưa có dữ liệu thống kê trực tiếp'}
                        </span>
                        <span className="text-slate-600 font-semibold">API-Football · Quota bảo toàn</span>
                    </div>
                </div>
            )}
        </div>
    )
}
