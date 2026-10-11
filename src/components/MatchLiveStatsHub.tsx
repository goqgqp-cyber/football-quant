/**
 * MatchLiveStatsHub — Advanced Match Statistics Hub
 * ─────────────────────────────────────────────────────────────────────────────
 * • Thay thế LiveMatchTracker 2D SVG bằng giao diện số liệu chuyên sâu.
 * • Chia 4 nhóm chỉ số: Kiểm soát/Chuyền bóng · Tấn công · Cố định/Kỷ luật · Phòng ngự.
 * • Refresh thủ công với cooldown 45 giây (bảo vệ quota 100 req/ngày).
 * • Zero background polling / setInterval.
 * • 100% số liệu thật từ API-Football.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DetailedMatchStatistics, LiveMatchData } from '../lib/types'
import { api } from '../lib/api'

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

function safeDiv(a: number, b: number): string {
    if (b === 0) return '—'
    return `${a} (${Math.round((a / b) * 100)}%)`
}

function display(v: number | undefined | null): string {
    if (v === undefined || v === null) return '—'
    return String(v)
}

// ── StatBar ───────────────────────────────────────────────────────────────────

interface StatBarProps {
    label: string
    homeVal: number
    awayVal: number
    homeDisplay: string
    awayDisplay: string
    /** true = kiểm soát bóng — tổng không cần bằng nhau */
    isPossession?: boolean
    highlight?: 'none' | 'home' | 'away'
}

function StatBar({ label, homeVal, awayVal, homeDisplay, awayDisplay, isPossession, highlight = 'none' }: StatBarProps) {
    const homeW = isPossession ? homeVal : pct(homeVal, awayVal)
    const awayW = 100 - homeW

    const homeEdge = homeVal > awayVal ? 'text-sky-300' : 'text-slate-300'
    const awayEdge = awayVal > homeVal ? 'text-amber-300' : 'text-slate-300'

    const highlightHome = highlight === 'home' ? 'ring-1 ring-sky-400/60 rounded' : ''
    const highlightAway = highlight === 'away' ? 'ring-1 ring-amber-400/60 rounded' : ''

    return (
        <div className="mb-3 last:mb-0">
            <div className="mb-1 flex items-center justify-between gap-2">
                <span className={`min-w-[3.5rem] text-right text-[13px] font-semibold tabular-nums ${homeEdge} ${highlightHome} px-0.5`}>
                    {homeDisplay}
                </span>
                <span className="flex-1 text-center text-[11px] text-slate-400 leading-none">{label}</span>
                <span className={`min-w-[3.5rem] text-left text-[13px] font-semibold tabular-nums ${awayEdge} ${highlightAway} px-0.5`}>
                    {awayDisplay}
                </span>
            </div>
            <div className="flex h-[5px] w-full overflow-hidden rounded-full bg-white/10">
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

function GroupHeader({ icon, title, homeTag, awayTag }: { icon: string; title: string; homeTag: string; awayTag: string }) {
    return (
        <div className="mb-3 flex items-center justify-between border-b border-white/10 pb-2">
            <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-slate-400">
                <span>{icon}</span>
                {title}
            </span>
            <div className="flex gap-3 text-[10px] font-semibold">
                <span className="text-sky-400">{homeTag}</span>
                <span className="text-amber-400">{awayTag}</span>
            </div>
        </div>
    )
}

// ── Main Component ────────────────────────────────────────────────────────────

export function MatchLiveStatsHub({ home, away, fixtureId, initialLiveData }: MatchLiveStatsHubProps) {
    const [liveData, setLiveData] = useState<LiveMatchData | null>(initialLiveData ?? null)
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

    const minuteLabel = (() => {
        if (minute === 'FT') return 'Kết thúc'
        if (minute === 'HT') return 'Nghỉ giữa hiệp'
        if (typeof minute === 'number') return `Phút ${minute}'`
        if (typeof minute === 'string' && minute) return minute
        return '—'
    })()

    const htLabel = periodScore?.htHome !== undefined && periodScore?.htAway !== undefined
        ? `HT: ${periodScore.htHome} - ${periodScore.htAway}`
        : null

    const hasData = !!ds

    // Fallback simple stats từ matchStats nếu detailedStats chưa có
    const fallbackPoss = liveData?.possession ?? { home: 50, away: 50 }
    const fallbackCorners = liveData?.corners ?? { home: 0, away: 0, total: 0 }
    const fallbackCards = liveData?.cards ?? { yellowHome: 0, yellowAway: 0, redHome: 0, redAway: 0 }
    const fallbackShots = liveData?.shotsOnTarget ?? { home: 0, away: 0 }
    const fallbackShotsTotal = liveData?.shotsTotal ?? { home: 0, away: 0 }
    const fallbackFouls = liveData?.fouls ?? { home: 0, away: 0 }
    const fallbackPasses = liveData?.accuratePasses ?? { home: 0, away: 0 }

    return (
        <div className="glass p-4">
            {/* ── Header ─────────────────────────────────────── */}
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                    <div className="flex items-center gap-2">
                        <p className="font-display text-sm font-bold text-white">Số liệu trận đấu</p>
                        {liveData?.status === 'inprogress' && (
                            <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
                                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                LIVE
                            </span>
                        )}
                        {liveData?.status === 'finished' && (
                            <span className="rounded-full bg-slate-700/60 px-2 py-0.5 text-[10px] font-semibold text-slate-400">
                                FT
                            </span>
                        )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                        {liveData?.league && <span className="mr-1">{liveData.league} ·</span>}
                        API-Football · One-Shot Snapshot
                    </p>
                </div>
                <button
                    onClick={refresh}
                    disabled={loading || cooldown > 0 || !fixtureId}
                    className={[
                        'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-all',
                        loading || cooldown > 0 || !fixtureId
                            ? 'cursor-not-allowed bg-white/5 text-slate-500'
                            : 'bg-sky-500/15 text-sky-400 hover:bg-sky-500/25 active:scale-95',
                    ].join(' ')}
                >
                    <svg className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                        <path d="M23 4v6h-6" /><path d="M1 20v-6h6" />
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                    </svg>
                    {loading ? 'Đang tải...' : cooldown > 0 ? `Chờ ${cooldown}s` : 'Cập nhật số liệu'}
                </button>
            </div>

            {/* ── Score Banner ─────────────────────────────────── */}
            <div className="mb-4 rounded-xl bg-gradient-to-r from-sky-900/30 via-slate-800/40 to-amber-900/30 p-3">
                <div className="flex items-center justify-between gap-2">
                    <div className="flex-1">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-sky-400/80">{homeTeamName}</p>
                    </div>
                    <div className="text-center">
                        <p className="font-display text-3xl font-extrabold tracking-tight text-white">
                            {score.home} <span className="text-slate-500">–</span> {score.away}
                        </p>
                        <div className="flex items-center justify-center gap-2 text-[10px] text-slate-500">
                            <span>{minuteLabel}</span>
                            {htLabel && <span>· {htLabel}</span>}
                        </div>
                    </div>
                    <div className="flex-1 text-right">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-400/80">{awayTeamName}</p>
                    </div>
                </div>
            </div>

            {/* ── Error ──────────────────────────────────────── */}
            {error && (
                <div className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-400">
                    {error}
                </div>
            )}

            {/* ── No Fixture ID state ─────────────────────────── */}
            {!fixtureId && (
                <div className="flex flex-col items-center gap-2 py-6 text-center">
                    <p className="text-sm text-slate-400">Nhập Fixture ID bên dưới để tải số liệu chi tiết từ API-Football.</p>
                </div>
            )}

            {/* ── Stats Grid ──────────────────────────────────── */}
            {fixtureId && (
                <>
                    {/* Legend */}
                    <div className="mb-4 flex items-center justify-between text-[10px] font-bold uppercase tracking-widest">
                        <span className="text-sky-400">{homeTeamName}</span>
                        <span className="text-slate-600">vs</span>
                        <span className="text-amber-400">{awayTeamName}</span>
                    </div>

                    {/* NHÓM A — Kiểm soát bóng & Phân phối */}
                    <div className="mb-5 rounded-xl bg-white/[0.03] p-3">
                        <GroupHeader icon="⚡" title="Kiểm soát bóng & Phân phối" homeTag={homeTeamName.slice(0, 10)} awayTag={awayTeamName.slice(0, 10)} />
                        <StatBar
                            label="Kiểm soát bóng"
                            homeVal={hasData ? ds!.possession.home : fallbackPoss.home}
                            awayVal={hasData ? ds!.possession.away : fallbackPoss.away}
                            homeDisplay={`${hasData ? ds!.possession.home : fallbackPoss.home}%`}
                            awayDisplay={`${hasData ? ds!.possession.away : fallbackPoss.away}%`}
                            isPossession
                        />
                        {hasData && (
                            <>
                                <StatBar
                                    label="Tổng đường chuyền"
                                    homeVal={ds!.totalPasses.home}
                                    awayVal={ds!.totalPasses.away}
                                    homeDisplay={display(ds!.totalPasses.home)}
                                    awayDisplay={display(ds!.totalPasses.away)}
                                />
                                <StatBar
                                    label="Chuyền chính xác"
                                    homeVal={ds!.accuratePasses.homeCount}
                                    awayVal={ds!.accuratePasses.awayCount}
                                    homeDisplay={safeDiv(ds!.accuratePasses.homeCount, ds!.totalPasses.home)}
                                    awayDisplay={safeDiv(ds!.accuratePasses.awayCount, ds!.totalPasses.away)}
                                />
                                <StatBar
                                    label="Chuyền ngang chính xác"
                                    homeVal={ds!.accurateCrosses.homeCount}
                                    awayVal={ds!.accurateCrosses.awayCount}
                                    homeDisplay={ds!.accurateCrosses.homeCount > 0
                                        ? `${ds!.accurateCrosses.homeCount} (${ds!.accurateCrosses.homePct}%)`
                                        : '—'}
                                    awayDisplay={ds!.accurateCrosses.awayCount > 0
                                        ? `${ds!.accurateCrosses.awayCount} (${ds!.accurateCrosses.awayPct}%)`
                                        : '—'}
                                />
                                <StatBar
                                    label="Bóng dài chính xác"
                                    homeVal={ds!.accurateLongBalls.homeCount}
                                    awayVal={ds!.accurateLongBalls.awayCount}
                                    homeDisplay={ds!.accurateLongBalls.homeCount > 0
                                        ? `${ds!.accurateLongBalls.homeCount} (${ds!.accurateLongBalls.homePct}%)`
                                        : '—'}
                                    awayDisplay={ds!.accurateLongBalls.awayCount > 0
                                        ? `${ds!.accurateLongBalls.awayCount} (${ds!.accurateLongBalls.awayPct}%)`
                                        : '—'}
                                />
                            </>
                        )}
                        {!hasData && (
                            <StatBar
                                label="Chuyền chính xác"
                                homeVal={fallbackPasses.home}
                                awayVal={fallbackPasses.away}
                                homeDisplay={display(fallbackPasses.home)}
                                awayDisplay={display(fallbackPasses.away)}
                            />
                        )}
                    </div>

                    {/* NHÓM B — Tấn công & Dứt điểm */}
                    <div className="mb-5 rounded-xl bg-white/[0.03] p-3">
                        <GroupHeader icon="🎯" title="Tấn công & Dứt điểm" homeTag={homeTeamName.slice(0, 10)} awayTag={awayTeamName.slice(0, 10)} />
                        <StatBar
                            label="Tổng số cú sút"
                            homeVal={hasData ? ds!.shotsTotal.home : fallbackShotsTotal.home}
                            awayVal={hasData ? ds!.shotsTotal.away : fallbackShotsTotal.away}
                            homeDisplay={display(hasData ? ds!.shotsTotal.home : fallbackShotsTotal.home)}
                            awayDisplay={display(hasData ? ds!.shotsTotal.away : fallbackShotsTotal.away)}
                        />
                        <StatBar
                            label="Sút trúng đích ⭐"
                            homeVal={hasData ? ds!.shotsOnGoal.home : fallbackShots.home}
                            awayVal={hasData ? ds!.shotsOnGoal.away : fallbackShots.away}
                            homeDisplay={display(hasData ? ds!.shotsOnGoal.home : fallbackShots.home)}
                            awayDisplay={display(hasData ? ds!.shotsOnGoal.away : fallbackShots.away)}
                            highlight={hasData
                                ? ds!.shotsOnGoal.home > ds!.shotsOnGoal.away ? 'home'
                                : ds!.shotsOnGoal.away > ds!.shotsOnGoal.home ? 'away' : 'none'
                                : 'none'}
                        />
                        {hasData && (
                            <>
                                <StatBar
                                    label="Sút ngoài khung gỗ"
                                    homeVal={ds!.shotsOffGoal.home}
                                    awayVal={ds!.shotsOffGoal.away}
                                    homeDisplay={display(ds!.shotsOffGoal.home)}
                                    awayDisplay={display(ds!.shotsOffGoal.away)}
                                />
                                <StatBar
                                    label="Sút bị cản phá"
                                    homeVal={ds!.shotsBlocked.home}
                                    awayVal={ds!.shotsBlocked.away}
                                    homeDisplay={display(ds!.shotsBlocked.home)}
                                    awayDisplay={display(ds!.shotsBlocked.away)}
                                />
                                <StatBar
                                    label="Cứu thua thủ môn"
                                    homeVal={ds!.goalkeeperSaves.home}
                                    awayVal={ds!.goalkeeperSaves.away}
                                    homeDisplay={display(ds!.goalkeeperSaves.home)}
                                    awayDisplay={display(ds!.goalkeeperSaves.away)}
                                />
                                {ds!.expectedGoals && (
                                    <StatBar
                                        label="xG (expected goals)"
                                        homeVal={ds!.expectedGoals.home}
                                        awayVal={ds!.expectedGoals.away}
                                        homeDisplay={ds!.expectedGoals.home.toFixed(2)}
                                        awayDisplay={ds!.expectedGoals.away.toFixed(2)}
                                    />
                                )}
                            </>
                        )}
                    </div>

                    {/* NHÓM C — Tình huống cố định & Kỷ luật */}
                    <div className="mb-5 rounded-xl bg-white/[0.03] p-3">
                        <GroupHeader icon="🚩" title="Tình huống cố định & Kỷ luật" homeTag={homeTeamName.slice(0, 10)} awayTag={awayTeamName.slice(0, 10)} />
                        <StatBar
                            label="Phạt góc"
                            homeVal={hasData ? ds!.corners.home : fallbackCorners.home}
                            awayVal={hasData ? ds!.corners.away : fallbackCorners.away}
                            homeDisplay={display(hasData ? ds!.corners.home : fallbackCorners.home)}
                            awayDisplay={display(hasData ? ds!.corners.away : fallbackCorners.away)}
                        />
                        <StatBar
                            label="Phạm lỗi"
                            homeVal={hasData ? ds!.fouls.home : fallbackFouls.home}
                            awayVal={hasData ? ds!.fouls.away : fallbackFouls.away}
                            homeDisplay={display(hasData ? ds!.fouls.home : fallbackFouls.home)}
                            awayDisplay={display(hasData ? ds!.fouls.away : fallbackFouls.away)}
                        />
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
                        {hasData && (
                            <StatBar
                                label="Việt vị"
                                homeVal={ds!.offsides.home}
                                awayVal={ds!.offsides.away}
                                homeDisplay={display(ds!.offsides.home)}
                                awayDisplay={display(ds!.offsides.away)}
                            />
                        )}
                    </div>

                    {/* NHÓM D — Phòng ngự & Thu hồi bóng */}
                    {hasData && (ds!.tackles.home > 0 || ds!.tackles.away > 0
                        || ds!.interceptions.home > 0 || ds!.interceptions.away > 0
                        || ds!.clearances.home > 0 || ds!.clearances.away > 0) && (
                        <div className="mb-3 rounded-xl bg-white/[0.03] p-3">
                            <GroupHeader icon="🛡️" title="Phòng ngự & Thu hồi bóng" homeTag={homeTeamName.slice(0, 10)} awayTag={awayTeamName.slice(0, 10)} />
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
                                label="Phá bóng"
                                homeVal={ds!.clearances.home}
                                awayVal={ds!.clearances.away}
                                homeDisplay={display(ds!.clearances.home)}
                                awayDisplay={display(ds!.clearances.away)}
                            />
                        </div>
                    )}

                    {/* ── Footer ─────────────────────────────────── */}
                    <div className="flex flex-wrap items-center justify-between gap-1 border-t border-white/10 pt-2 text-[10px] text-slate-600">
                        <span>
                            {lastSync
                                ? `Cập nhật lần cuối: ${lastSync.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
                                : liveData?.lastUpdated
                                    ? `Dữ liệu snapshot lúc ${new Date(liveData.lastUpdated).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`
                                    : 'Bấm "Cập nhật số liệu" để tải dữ liệu'}
                        </span>
                        <span className="text-slate-700">API-Football · Quota bảo toàn</span>
                    </div>
                </>
            )}
        </div>
    )
}
