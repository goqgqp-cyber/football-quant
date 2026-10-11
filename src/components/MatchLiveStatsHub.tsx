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

interface MatchLiveStatsHubProps {
    home: string
    away: string
    fixtureId?: number | string | null
    /** Dữ liệu live đã được hook useLiveMatchSync fetch lần đầu */
    initialLiveData?: LiveMatchData | null
}

const COOLDOWN_SEC = 45

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

// ── StatBar ───────────────────────────────────────────────────────────────────

interface StatBarProps {
    label: string
    homeVal: number
    awayVal: number
    homeDisplay: string
    awayDisplay: string
    /** true = kiểm soát bóng */
    isPossession?: boolean
    highlight?: 'none' | 'home' | 'away'
}

function StatBar({
    label,
    homeVal,
    awayVal,
    homeDisplay,
    awayDisplay,
    isPossession,
    highlight = 'none',
}: StatBarProps) {
    const homeW = isPossession ? homeVal : pct(homeVal, awayVal)
    const awayW = 100 - homeW

    const homeEdge = homeVal > awayVal ? 'text-sky-300 font-bold' : 'text-slate-300'
    const awayEdge = awayVal > homeVal ? 'text-amber-300 font-bold' : 'text-slate-300'

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
                </span>
                <span className={`min-w-[3.5rem] text-left text-xs font-semibold tabular-nums ${awayEdge} ${highlightAway}`}>
                    {awayDisplay}
                </span>
            </div>
            <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                    className="h-full rounded-full bg-gradient-to-r from-sky-500 to-sky-400 transition-all duration-700"
                    style={{ width: `${homeW}%` }}
                />
                <div
                    className="h-full flex-1 rounded-full bg-gradient-to-l from-amber-500 to-amber-400 transition-all duration-700"
                    style={{ width: `${awayW}%` }}
                />
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

export function MatchLiveStatsHub({ home, away, fixtureId, initialLiveData }: MatchLiveStatsHubProps) {
    const [liveData, setLiveData] = useState<LiveMatchData | null>(initialLiveData ?? null)
    const [activeTab, setActiveTab] = useState<'stats' | 'events'>('stats')
    const [loading, setLoading] = useState(false)
    const [cooldown, setCooldown] = useState(0)
    const [lastSync, setLastSync] = useState<Date | null>(null)
    const [error, setError] = useState<string | null>(null)
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

    // Đồng bộ prop initialLiveData vào state khi thay đổi trận
    useEffect(() => {
        if (initialLiveData) setLiveData(initialLiveData)
    }, [initialLiveData])

    const startCooldown = useCallback(() => {
        setCooldown(COOLDOWN_SEC)
        if (timerRef.current) clearInterval(timerRef.current)
        timerRef.current = setInterval(() => {
            setCooldown((prev) => {
                if (prev <= 1) {
                    if (timerRef.current) clearInterval(timerRef.current)
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

    const refresh = useCallback(async () => {
        if (loading || cooldown > 0) return
        const numId = fixtureId ? Number(fixtureId) : null
        if (!numId || isNaN(numId)) {
            setError('Chưa có Fixture ID. Nhập ID trận đấu để cập nhật số liệu.')
            return
        }
        setLoading(true)
        setError(null)
        try {
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
                    possession: mStats?.possession ?? { home: 50, away: 50 },
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
            } else {
                setError('Không tìm thấy dữ liệu trận đấu. Kiểm tra lại Fixture ID.')
            }
        } catch {
            setError('Lỗi kết nối API-Football. Vui lòng thử lại sau.')
        } finally {
            setLoading(false)
            startCooldown()
        }
    }, [loading, cooldown, fixtureId, home, away, startCooldown])

    const ds: DetailedMatchStatistics | undefined = liveData?.detailedStats
    const score = liveData?.score ?? { home: 0, away: 0 }
    const periodScore = liveData?.periodScore
    const minute = liveData?.minute
    const homeTeamName = liveData?.homeTeam || home
    const awayTeamName = liveData?.awayTeam || away
    const homeTag = homeTeamName.slice(0, 10)
    const awayTag = awayTeamName.slice(0, 10)

    const hasData = !!ds

    // Fallbacks từ matchStats cấp 1 nếu detailedStats chưa tải
    const fallbackPoss = liveData?.possession ?? { home: 50, away: 50 }
    const fallbackCorners = liveData?.corners ?? { home: 0, away: 0, total: 0 }
    const fallbackCards = liveData?.cards ?? { yellowHome: 0, yellowAway: 0, redHome: 0, redAway: 0 }
    const fallbackShots = liveData?.shotsOnTarget ?? { home: 0, away: 0 }
    const fallbackShotsTotal = liveData?.shotsTotal ?? { home: 0, away: 0 }
    const fallbackFouls = liveData?.fouls ?? { home: 0, away: 0 }
    const fallbackPasses = liveData?.accuratePasses ?? { home: 0, away: 0 }

    const shotsOnGoalHome = hasData ? ds!.shotsOnGoal.home : fallbackShots.home
    const shotsOnGoalAway = hasData ? ds!.shotsOnGoal.away : fallbackShots.away

    return (
        <div className="space-y-4">
            {/* ── 1. Match Header (Logos, Form Badges, Score, Minute) ── */}
            <MatchHeader
                homeTeam={homeTeamName}
                awayTeam={awayTeamName}
                homeLogo={liveData?.homeLogo}
                awayLogo={liveData?.awayLogo}
                score={score}
                minute={minute}
                periodScore={periodScore}
                status={liveData?.status}
                league={liveData?.league}
                homeForm={liveData?.homeForm}
                awayForm={liveData?.awayForm}
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

                {/* Manual Refresh Button with 45s Cooldown */}
                <button
                    onClick={refresh}
                    disabled={loading || cooldown > 0 || !fixtureId}
                    className={[
                        'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all shadow-sm',
                        loading || cooldown > 0 || !fixtureId
                            ? 'cursor-not-allowed bg-white/5 text-slate-500 border border-white/5'
                            : 'bg-sky-500/20 text-sky-300 border border-sky-500/40 hover:bg-sky-500/30 active:scale-95',
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
                    {loading ? 'Đang tải...' : cooldown > 0 ? `Chờ ${cooldown}s` : 'Cập nhật số liệu'}
                </button>
            </div>

            {/* Error Banner */}
            {error && (
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-300">
                    {error}
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
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4 w-full">
                        {/* ── NHÓM 1: Sút bóng & Khung thành (Attacking & Goal Frame) ── */}
                        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-3.5 shadow-xl backdrop-blur-md">
                            <GroupHeader icon="🎯" title="Sút bóng & Khung thành" homeTag={homeTag} awayTag={awayTag} />

                            {/* Tỷ lệ kiểm soát bóng */}
                            <StatBar
                                label="Kiểm soát bóng"
                                homeVal={hasData ? ds!.possession.home : fallbackPoss.home}
                                awayVal={hasData ? ds!.possession.away : fallbackPoss.away}
                                homeDisplay={`${hasData ? ds!.possession.home : fallbackPoss.home}%`}
                                awayDisplay={`${hasData ? ds!.possession.away : fallbackPoss.away}%`}
                                isPossession
                            />

                            {/* Tổng số cú sút */}
                            <StatBar
                                label="Tổng số cú sút"
                                homeVal={hasData ? ds!.shotsTotal.home : fallbackShotsTotal.home}
                                awayVal={hasData ? ds!.shotsTotal.away : fallbackShotsTotal.away}
                                homeDisplay={display(hasData ? ds!.shotsTotal.home : fallbackShotsTotal.home)}
                                awayDisplay={display(hasData ? ds!.shotsTotal.away : fallbackShotsTotal.away)}
                            />

                            {/* Visual Goal Frame (Sút trúng khung thành) */}
                            <div className="my-3 rounded-xl border border-sky-500/20 bg-sky-950/20 p-2.5">
                                <div className="mb-1.5 flex items-center justify-between text-xs font-semibold text-slate-400">
                                    <span className="font-bold text-sky-400 tabular-nums">{shotsOnGoalHome}</span>
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-300">
                                        🥅 Sút trúng khung thành
                                    </span>
                                    <span className="font-bold text-amber-400 tabular-nums">{shotsOnGoalAway}</span>
                                </div>
                                <div className="relative mx-auto flex h-11 w-full max-w-[200px] items-center justify-between rounded-t-sm border-t-2 border-l-2 border-r-2 border-white/40 bg-gradient-to-b from-white/[0.06] to-transparent px-5">
                                    <span className="font-mono text-base font-black text-sky-300 tabular-nums">
                                        {shotsOnGoalHome}
                                    </span>
                                    <span className="h-4 w-px bg-white/20" />
                                    <span className="font-mono text-base font-black text-amber-300 tabular-nums">
                                        {shotsOnGoalAway}
                                    </span>
                                </div>
                            </div>

                            {/* Sút trượt khung thành */}
                            {hasData && (
                                <StatBar
                                    label="Sút trượt khung thành"
                                    homeVal={ds!.shotsOffGoal.home}
                                    awayVal={ds!.shotsOffGoal.away}
                                    homeDisplay={display(ds!.shotsOffGoal.home)}
                                    awayDisplay={display(ds!.shotsOffGoal.away)}
                                />
                            )}

                            {/* Cú sút bị cản phá */}
                            {hasData && (
                                <StatBar
                                    label="Cú sút bị cản phá"
                                    homeVal={ds!.shotsBlocked.home}
                                    awayVal={ds!.shotsBlocked.away}
                                    homeDisplay={display(ds!.shotsBlocked.home)}
                                    awayDisplay={display(ds!.shotsBlocked.away)}
                                />
                            )}

                            {/* Dứt điểm trong vòng cấm */}
                            {hasData && ds!.shotsInsideBox && (
                                <StatBar
                                    label="Dứt điểm trong vòng cấm"
                                    homeVal={ds!.shotsInsideBox.home}
                                    awayVal={ds!.shotsInsideBox.away}
                                    homeDisplay={display(ds!.shotsInsideBox.home)}
                                    awayDisplay={display(ds!.shotsInsideBox.away)}
                                />
                            )}

                            {/* Dứt điểm ngoài vòng cấm */}
                            {hasData && ds!.shotsOutsideBox && (
                                <StatBar
                                    label="Dứt điểm ngoài vòng cấm"
                                    homeVal={ds!.shotsOutsideBox.home}
                                    awayVal={ds!.shotsOutsideBox.away}
                                    homeDisplay={display(ds!.shotsOutsideBox.home)}
                                    awayDisplay={display(ds!.shotsOutsideBox.away)}
                                />
                            )}

                            {/* Quả phạt đền được hưởng */}
                            {hasData && ds!.penalties && (
                                <StatBar
                                    label="Quả phạt đền được hưởng"
                                    homeVal={ds!.penalties.home}
                                    awayVal={ds!.penalties.away}
                                    homeDisplay={display(ds!.penalties.home)}
                                    awayDisplay={display(ds!.penalties.away)}
                                />
                            )}

                            {/* xG nếu có */}
                            {hasData && ds!.expectedGoals && (
                                <StatBar
                                    label="Bàn thắng kỳ vọng (xG)"
                                    homeVal={ds!.expectedGoals.home}
                                    awayVal={ds!.expectedGoals.away}
                                    homeDisplay={ds!.expectedGoals.home.toFixed(2)}
                                    awayDisplay={ds!.expectedGoals.away.toFixed(2)}
                                />
                            )}
                        </div>

                        {/* ── NHÓM 2: Chuyền bóng & Kiến tạo (Passing & Playmaking) ── */}
                        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-3.5 shadow-xl backdrop-blur-md">
                            <GroupHeader icon="⚡" title="Chuyền bóng & Kiến tạo" homeTag={homeTag} awayTag={awayTag} />

                            {hasData ? (
                                <>
                                    <StatBar
                                        label="Tổng số đường chuyền"
                                        homeVal={ds!.totalPasses.home}
                                        awayVal={ds!.totalPasses.away}
                                        homeDisplay={display(ds!.totalPasses.home)}
                                        awayDisplay={display(ds!.totalPasses.away)}
                                    />

                                    {ds!.keyPasses && (
                                        <StatBar
                                            label="Đường chuyền quyết định (Key passes)"
                                            homeVal={ds!.keyPasses.home}
                                            awayVal={ds!.keyPasses.away}
                                            homeDisplay={display(ds!.keyPasses.home)}
                                            awayDisplay={display(ds!.keyPasses.away)}
                                        />
                                    )}

                                    <StatBar
                                        label="Đường chuyền chính xác"
                                        homeVal={ds!.accuratePasses.homeCount}
                                        awayVal={ds!.accuratePasses.awayCount}
                                        homeDisplay={safeDiv(ds!.accuratePasses.homeCount, ds!.totalPasses.home)}
                                        awayDisplay={safeDiv(ds!.accuratePasses.awayCount, ds!.totalPasses.away)}
                                    />

                                    <StatBar
                                        label="Quả tạt chính xác"
                                        homeVal={ds!.accurateCrosses.homeCount}
                                        awayVal={ds!.accurateCrosses.awayCount}
                                        homeDisplay={
                                            ds!.accurateCrosses.homeCount > 0
                                                ? `${ds!.accurateCrosses.homeCount} (${ds!.accurateCrosses.homePct}%)`
                                                : '—'
                                        }
                                        awayDisplay={
                                            ds!.accurateCrosses.awayCount > 0
                                                ? `${ds!.accurateCrosses.awayCount} (${ds!.accurateCrosses.awayPct}%)`
                                                : '—'
                                        }
                                    />

                                    <StatBar
                                        label="Bóng dài chính xác"
                                        homeVal={ds!.accurateLongBalls.homeCount}
                                        awayVal={ds!.accurateLongBalls.awayCount}
                                        homeDisplay={
                                            ds!.accurateLongBalls.homeCount > 0
                                                ? `${ds!.accurateLongBalls.homeCount} (${ds!.accurateLongBalls.homePct}%)`
                                                : '—'
                                        }
                                        awayDisplay={
                                            ds!.accurateLongBalls.awayCount > 0
                                                ? `${ds!.accurateLongBalls.awayCount} (${ds!.accurateLongBalls.awayPct}%)`
                                                : '—'
                                        }
                                    />
                                </>
                            ) : (
                                <StatBar
                                    label="Chuyền chính xác"
                                    homeVal={fallbackPasses.home}
                                    awayVal={fallbackPasses.away}
                                    homeDisplay={display(fallbackPasses.home)}
                                    awayDisplay={display(fallbackPasses.away)}
                                />
                            )}
                        </div>

                        {/* ── NHÓM 3: Tranh chấp & Phòng ngự (Duels & Defense) ── */}
                        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-3.5 shadow-xl backdrop-blur-md">
                            <GroupHeader icon="🛡️" title="Tranh chấp & Phòng ngự" homeTag={homeTag} awayTag={awayTag} />

                            {hasData && ds!.duelsWon && (
                                <StatBar
                                    label="Tranh chấp thắng"
                                    homeVal={ds!.duelsWon.homeCount}
                                    awayVal={ds!.duelsWon.awayCount}
                                    homeDisplay={accurateDisplay(ds!.duelsWon).home}
                                    awayDisplay={accurateDisplay(ds!.duelsWon).away}
                                />
                            )}

                            {hasData && ds!.aerialDuelsWon && (
                                <StatBar
                                    label="Tranh chấp bóng bổng thắng"
                                    homeVal={ds!.aerialDuelsWon.homeCount}
                                    awayVal={ds!.aerialDuelsWon.awayCount}
                                    homeDisplay={accurateDisplay(ds!.aerialDuelsWon).home}
                                    awayDisplay={accurateDisplay(ds!.aerialDuelsWon).away}
                                />
                            )}

                            {hasData && (
                                <>
                                    <StatBar
                                        label="Tắc bóng"
                                        homeVal={ds!.tackles.home}
                                        awayVal={ds!.tackles.away}
                                        homeDisplay={display(ds!.tackles.home)}
                                        awayDisplay={display(ds!.tackles.away)}
                                    />
                                    <StatBar
                                        label="Cắt bóng"
                                        homeVal={ds!.interceptions.home}
                                        awayVal={ds!.interceptions.away}
                                        homeDisplay={display(ds!.interceptions.home)}
                                        awayDisplay={display(ds!.interceptions.away)}
                                    />
                                    <StatBar
                                        label="Giải nguy"
                                        homeVal={ds!.clearances.home}
                                        awayVal={ds!.clearances.away}
                                        homeDisplay={display(ds!.clearances.home)}
                                        awayDisplay={display(ds!.clearances.away)}
                                    />
                                </>
                            )}

                            <StatBar
                                label="Phạm luật"
                                homeVal={hasData ? ds!.fouls.home : fallbackFouls.home}
                                awayVal={hasData ? ds!.fouls.away : fallbackFouls.away}
                                homeDisplay={display(hasData ? ds!.fouls.home : fallbackFouls.home)}
                                awayDisplay={display(hasData ? ds!.fouls.away : fallbackFouls.away)}
                            />

                            {hasData && (
                                <StatBar
                                    label="Cứu bóng (Thủ môn)"
                                    homeVal={ds!.goalkeeperSaves.home}
                                    awayVal={ds!.goalkeeperSaves.away}
                                    homeDisplay={display(ds!.goalkeeperSaves.home)}
                                    awayDisplay={display(ds!.goalkeeperSaves.away)}
                                />
                            )}
                        </div>

                        {/* ── NHÓM 4: Kỷ luật & Cố định (Discipline & Set Pieces) ── */}
                        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-3.5 shadow-xl backdrop-blur-md">
                            <GroupHeader icon="🚩" title="Kỷ luật & Cố định" homeTag={homeTag} awayTag={awayTag} />

                            <StatBar
                                label="Phạt góc"
                                homeVal={hasData ? ds!.corners.home : fallbackCorners.home}
                                awayVal={hasData ? ds!.corners.away : fallbackCorners.away}
                                homeDisplay={display(hasData ? ds!.corners.home : fallbackCorners.home)}
                                awayDisplay={display(hasData ? ds!.corners.away : fallbackCorners.away)}
                            />

                            {hasData && (
                                <StatBar
                                    label="Việt vị"
                                    homeVal={ds!.offsides.home}
                                    awayVal={ds!.offsides.away}
                                    homeDisplay={display(ds!.offsides.home)}
                                    awayDisplay={display(ds!.offsides.away)}
                                />
                            )}

                            <StatBar
                                label="Thẻ vàng 🟨"
                                homeVal={hasData ? ds!.yellowCards.home : fallbackCards.yellowHome}
                                awayVal={hasData ? ds!.yellowCards.away : fallbackCards.yellowAway}
                                homeDisplay={display(hasData ? ds!.yellowCards.home : fallbackCards.yellowHome)}
                                awayDisplay={display(hasData ? ds!.yellowCards.away : fallbackCards.yellowAway)}
                            />

                            <StatBar
                                label="Thẻ đỏ 🟥"
                                homeVal={hasData ? ds!.redCards.home : fallbackCards.redHome}
                                awayVal={hasData ? ds!.redCards.away : fallbackCards.redAway}
                                homeDisplay={display(hasData ? ds!.redCards.home : fallbackCards.redHome)}
                                awayDisplay={display(hasData ? ds!.redCards.away : fallbackCards.redAway)}
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
                                  : 'Bấm "Cập nhật số liệu" để tải dữ liệu'}
                        </span>
                        <span className="text-slate-600 font-semibold">API-Football · Quota bảo toàn</span>
                    </div>
                </div>
            )}
        </div>
    )
}
