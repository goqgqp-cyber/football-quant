import { useEffect, useRef, useState, useCallback } from 'react'
import { api } from '../lib/api'
import type { LiveMatchData } from '../lib/types'

export interface LiveMatchSyncOptions {
    home: string
    away: string
    eventId?: number | string | null
    isLive: boolean
    pollIntervalMs?: number // Mặc định 15000ms (15s)
    onScoreChange?: (newScore: { home: number; away: number }, prevScore: { home: number; away: number } | null, currentMinute: number | null) => void
    onStatsUpdate?: (liveData: LiveMatchData) => void
}

export function useLiveMatchSync({
    home,
    away,
    eventId,
    isLive,
    pollIntervalMs = 15000,
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

    const syncTick = useCallback(async () => {
        const cleanHome = home.trim()
        const cleanAway = away.trim()
        const numericEventId = eventId ? Number(eventId) : undefined

        // Chỉ poll khi có ít nhất eventId hoặc tên 2 đội
        if (!numericEventId && (!cleanHome || !cleanAway)) {
            return
        }

        try {
            setLoading(true)
            let fetched: LiveMatchData | null = null

            if (numericEventId && !isNaN(numericEventId)) {
                // Ưu tiên endpoint /api/sofascore/event/:eventId/live
                try {
                    const fullLive = await api.getSofaEventLive(numericEventId)
                    if (fullLive?.found) {
                        const mStats = fullLive.matchStats
                        fetched = {
                            found: true,
                            eventId: fullLive.eventId,
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
                fetched = await api.getLiveMatch(cleanHome, cleanAway, numericEventId)
            }

            if (fetched && fetched.found) {
                setLiveData(fetched)
                setLastSyncTime(new Date())
                setError(null)
                onStatsUpdateRef.current?.(fetched)

                // Kiểm tra thay đổi tỉ số (Live Goal Trigger)
                const newScore = fetched.score
                const prevScore = prevScoreRef.current
                if (
                    prevScore !== null &&
                    (newScore.home !== prevScore.home || newScore.away !== prevScore.away)
                ) {
                    const parsedMinute = typeof fetched.minute === 'number' 
                        ? fetched.minute 
                        : typeof fetched.minute === 'string' && !isNaN(parseInt(fetched.minute, 10))
                            ? parseInt(fetched.minute, 10)
                            : null
                    onScoreChangeRef.current?.(newScore, prevScore, parsedMinute)
                }
                prevScoreRef.current = newScore
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Lỗi đồng bộ trực tiếp SofaScore.')
        } finally {
            setLoading(false)
        }
    }, [home, away, eventId])

    useEffect(() => {
        // Chỉ chạy polling định kỳ nếu trận đấu đang diễn ra hoặc có eventId và được đánh dấu isLive
        const numericEventId = eventId ? Number(eventId) : undefined
        if (!numericEventId && (!home.trim() || !away.trim())) {
            return
        }

        // Tự động fetch ngay lập tức khi hook mount / đổi trận
        void syncTick()

        // Định kỳ 15s nếu isLive hoặc có active match
        const timer = setInterval(() => {
            if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
                void syncTick()
            }
        }, pollIntervalMs)

        return () => clearInterval(timer)
    }, [syncTick, pollIntervalMs, isLive, eventId, home, away])

    return {
        liveData,
        loading,
        lastSyncTime,
        error,
        manualRefresh: syncTick,
    }
}
