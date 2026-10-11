import { useCallback, useEffect, useState } from 'react'

export interface Settings {
    bankroll: number
    /** tham số theo giải: lg_home / lg_away */
    leagueParams: Record<string, { lg_home: number; lg_away: number }>
}

const KEY = 'fq:settings'

const DEFAULT_SETTINGS: Settings = {
    bankroll: 10_000_000,
    leagueParams: {
        'Premier League': { lg_home: 1.45, lg_away: 1.15 },
        'La Liga': { lg_home: 1.4, lg_away: 1.1 },
        'Serie A': { lg_home: 1.4, lg_away: 1.15 },
        'Bundesliga': { lg_home: 1.6, lg_away: 1.3 },
    },
}

/**
 * Cài đặt người dùng (G1: lưu localStorage cục bộ).
 * LƯU Ý: chỉ lưu cấu hình không nhạy cảm. Token KHÔNG bao giờ lưu ở đây.
 * G2 sẽ đồng bộ lên Upstash qua backend.
 */
export function useSettings() {
    const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)

    useEffect(() => {
        try {
            const raw = localStorage.getItem(KEY)
            if (raw) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) })
        } catch {
            /* bỏ qua */
        }
    }, [])

    const update = useCallback((patch: Partial<Settings>) => {
        setSettings((prev) => {
            const next = { ...prev, ...patch }
            try {
                localStorage.setItem(KEY, JSON.stringify(next))
            } catch {
                /* bỏ qua */
            }
            return next
        })
    }, [])

    return { settings, update }
}
