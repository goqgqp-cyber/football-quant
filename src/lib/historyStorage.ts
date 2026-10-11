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

        // Deduplicate: 1 fixture = 1 unique entry
        const seen = new Set<string>()
        const deduplicated: HistoryItem[] = []
        for (const item of parsed) {
            const fixId = item.fixtureId || item.meta?.eventId
            const key = fixId
                ? `fix:${fixId}`
                : `${(item.meta?.home || '').trim().toLowerCase()}_vs_${(item.meta?.away || '').trim().toLowerCase()}_${item.id}`
            if (!seen.has(key)) {
                seen.add(key)
                deduplicated.push(item)
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
        const filtered = current.filter((x) => {
            if (x.id === item.id) return false
            const xFixId = x.fixtureId || x.meta?.eventId
            if (targetFixId && xFixId && xFixId === targetFixId) return false
            if (
                x.meta?.home &&
                item.meta?.home &&
                x.meta?.away &&
                item.meta?.away &&
                x.meta.home.trim().toLowerCase() === item.meta.home.trim().toLowerCase() &&
                x.meta.away.trim().toLowerCase() === item.meta.away.trim().toLowerCase()
            ) {
                return false
            }
            return true
        })
        const updated = [item, ...filtered].slice(0, 150)
        saveLocalHistory(updated)
        window.dispatchEvent(new CustomEvent(HISTORY_UPDATE_EVENT, { detail: item }))
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
