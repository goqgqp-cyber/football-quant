import type { HistoryItem } from './api'

const LOCAL_HISTORY_KEY = 'fq_local_history'
export const HISTORY_UPDATE_EVENT = 'fq_history_updated'

export function getLocalHistory(): HistoryItem[] {
    if (typeof window === 'undefined' || !window.localStorage) return []
    try {
        const raw = localStorage.getItem(LOCAL_HISTORY_KEY)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []

        // Deduplicate: 1 fixture = 1 unique entry (loại bỏ triệt để các bản ghi trùng lặp)
        const seen = new Set<string>()
        const deduplicated: HistoryItem[] = []
        for (const rawItem of parsed) {
            if (!rawItem) continue
            const fixId = rawItem.fixtureId || rawItem.meta?.eventId
            const home = rawItem.homeTeam || rawItem.meta?.home || ''
            const away = rawItem.awayTeam || rawItem.meta?.away || ''
            const normHome = home.trim().toLowerCase()
            const normAway = away.trim().toLowerCase()
            const key = fixId ? `fix:${fixId}` : `${normHome}_vs_${normAway}`

            if (!seen.has(key)) {
                seen.add(key)
                let kickoffTimestamp = rawItem.kickoffTimestamp
                if (!kickoffTimestamp && rawItem.meta?.kickoff) {
                    const parsedKo = new Date(rawItem.meta.kickoff).getTime()
                    if (!isNaN(parsedKo)) kickoffTimestamp = parsedKo
                }
                const isSettled = rawItem.settled === true || rawItem.result != null
                const status = rawItem.status || (isSettled ? 'finished' : (rawItem.isLive ? 'inprogress' : 'notstarted'))

                deduplicated.push({
                    ...rawItem,
                    fixtureId: fixId ? Number(fixId) : undefined,
                    homeTeam: home,
                    awayTeam: away,
                    kickoffTimestamp: kickoffTimestamp || rawItem.createdAt || Date.now(),
                    status,
                    settled: isSettled,
                })
            }
        }
        return deduplicated
    } catch {
        return []
    }
}

export function saveLocalHistory(items: HistoryItem[]): void {
    if (typeof window === 'undefined' || !window.localStorage) return
    try {
        localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(items.slice(0, 150)))
    } catch {
        /* ignore localStorage quota errors */
    }
}

export function prependLocalHistoryItem(item: HistoryItem): void {
    if (typeof window === 'undefined' || !window.localStorage) return
    try {
        const current = getLocalHistory()
        const targetFixId = item.fixtureId || item.meta?.eventId
        const targetHome = (item.homeTeam || item.meta?.home || '').trim().toLowerCase()
        const targetAway = (item.awayTeam || item.meta?.away || '').trim().toLowerCase()

        let kickoffTimestamp = item.kickoffTimestamp
        if (!kickoffTimestamp && item.meta?.kickoff) {
            const parsedKo = new Date(item.meta.kickoff).getTime()
            if (!isNaN(parsedKo)) kickoffTimestamp = parsedKo
        }

        const normalizedItem: HistoryItem = {
            ...item,
            fixtureId: targetFixId ? Number(targetFixId) : undefined,
            homeTeam: item.homeTeam || item.meta?.home,
            awayTeam: item.awayTeam || item.meta?.away,
            kickoffTimestamp: kickoffTimestamp || item.createdAt || Date.now(),
            status: item.status || (item.result ? 'finished' : item.isLive ? 'inprogress' : 'notstarted'),
            settled: item.settled ?? (item.result != null),
        }

        const filtered = current.filter((x) => {
            if (x.id === normalizedItem.id) return false
            const xFixId = x.fixtureId || x.meta?.eventId
            if (targetFixId && xFixId && Number(xFixId) === Number(targetFixId)) return false
            const xHome = (x.homeTeam || x.meta?.home || '').trim().toLowerCase()
            const xAway = (x.awayTeam || x.meta?.away || '').trim().toLowerCase()
            if (targetHome && targetAway && xHome === targetHome && xAway === targetAway) {
                return false
            }
            return true
        })
        const updated = [normalizedItem, ...filtered].slice(0, 150)
        saveLocalHistory(updated)
        window.dispatchEvent(new CustomEvent(HISTORY_UPDATE_EVENT, { detail: normalizedItem }))
    } catch {
        /* ignore */
    }
}

export function updateLocalHistoryItem(item: HistoryItem): void {
    if (typeof window === 'undefined' || !window.localStorage) return
    try {
        const current = getLocalHistory()
        const idx = current.findIndex((x) => x.id === item.id)
        let updated: HistoryItem[]
        if (idx >= 0) {
            updated = [...current]
            updated[idx] = item
        } else {
            updated = [item, ...current].slice(0, 150)
        }
        saveLocalHistory(updated)
        window.dispatchEvent(new CustomEvent(HISTORY_UPDATE_EVENT, { detail: item }))
    } catch {
        /* ignore */
    }
}

export function removeLocalHistoryItem(id: string): void {
    if (typeof window === 'undefined' || !window.localStorage) return
    try {
        const current = getLocalHistory()
        const updated = current.filter((x) => x.id !== id)
        saveLocalHistory(updated)
    } catch {
        /* ignore */
    }
}
