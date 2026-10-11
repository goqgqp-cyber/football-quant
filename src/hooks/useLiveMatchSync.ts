/**
 * useLiveMatchSync — Hook lấy Snapshot trận đấu thời gian thực từ API-Football.
 * ─────────────────────────────────────────────────────────────────────────────
 * • Tuân thủ triệt để One-Shot Snapshot workflow: KHÔNG background polling, KHÔNG setInterval.
 * • Chỉ fetch 1 lần khi mount / đổi trận đấu hoặc khi người dùng chủ động bấm Làm Mới.
 * • Bảo toàn tuyệt đối quota 100 req/ngày của API-Football.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { api } from '../lib/api'
import type { LiveMatchData } from '../lib/types'

export interface LiveMatchSyncOptions {
    home: string
    away: string
    eventId?: number | string | null
    fixtureId?: number | string | null
    isLive?: boolean
    onScoreChange?: (
        newScore: { home: number; away: number },
        prevScore: { home: number; away: number } | null,
        currentMinute: number | null,
    ) => void
    onStatsUpdate?: (liveData: LiveMatchData) => void
}

export function useLiveMatchSync({
    home,
    away,
    eventId,
    fixtureId,
    onScoreChange,
    onStatsUpdate,
}: LiveMatchSyncOptions) {
    const [liveData, setLiveData] = useState<LiveMatchData | null>(null)
    const [loading, setLoading] = useState(false)
    const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null)
    const [error, setError] = useState<string | null>(null)

    const prevScoreRef = useRef<{ home: number; away: number } | null>(null)
    const onScoreChangeRef = useRef(onScoreChange)
    const onStatsUpdateRef = useRef(onStatsUpdate)

    useEffect(() => {
        onScoreChangeRef.current = onScoreChange
        onStatsUpdateRef.current = onStatsUpdate
    })

    const targetId = fixtureId ?? eventId

    const syncSnapshot = useCallback(async () => {
        const cleanHome = home.trim()
        const cleanAway = away.trim()
        const numericId = targetId ? Number(targetId) : undefined

        if (!numericId && (!cleanHome || !cleanAway)) {
            return
        }

        try {
            setLoading(true)
            let fetched: LiveMatchData | null = null

            if (numericId && !isNaN(numericId)) {
                // Ưu tiên snapshot từ /api/football/fixtures/:id/live
                try {
                    const fullLive = await api.footballFixtureLive(numericId)
                    if (fullLive?.found) {
                        const mStats = fullLive.matchStats
                        fetched = {
                            found: true,
                            eventId: fullLive.eventId,
                            fixtureId: fullLive.fixtureId,
                            homeTeam: fullLive.homeTeam || cleanHome,
                            awayTeam: fullLive.awayTeam || cleanAway,
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
                    }
                } catch {
                    // Fallback to getLiveMatch
                }
            }

            if (!fetched) {
                fetched = await api.getLiveMatch(cleanHome, cleanAway, numericId)
            }

            if (fetched && fetched.found) {
                setLiveData(fetched)
                setLastSyncTime(new Date())
                setError(null)
                onStatsUpdateRef.current?.(fetched)

                // Kiểm tra thay đổi tỉ số
                const newScore = fetched.score
                const prevScore = prevScoreRef.current
                if (
                    prevScore !== null &&
                    (newScore.home !== prevScore.home || newScore.away !== prevScore.away)
                ) {
                    const parsedMinute =
                        typeof fetched.minute === 'number'
                            ? fetched.minute
                            : typeof fetched.minute === 'string' && !isNaN(parseInt(fetched.minute, 10))
                              ? parseInt(fetched.minute, 10)
                              : null
                    onScoreChangeRef.current?.(newScore, prevScore, parsedMinute)
                }
                prevScoreRef.current = newScore
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Lỗi nạp snapshot từ API-Football.')
        } finally {
            setLoading(false)
        }
    }, [home, away, targetId])

    // One-shot fetch: Chạy đúng 1 lần khi có thông tin trận đấu (không background interval)
    useEffect(() => {
        const numericId = targetId ? Number(targetId) : undefined
        if (!numericId && (!home.trim() || !away.trim())) {
            return
        }

        void syncSnapshot()
    }, [syncSnapshot, targetId, home, away])

    return {
        liveData,
        loading,
        lastSyncTime,
        error,
        manualRefresh: syncSnapshot,
        refreshSnapshot: syncSnapshot,
    }
}
