/**
 * Storage and Persistence Module
 * ─────────────────────────────────────────────────────────────────────────────
 * Enforces 1 match = 1 unique record keyed by fixtureId in localStorage.
 * Guarantees required fields: fixtureId, homeTeam, awayTeam, kickoffTimestamp, status, settled.
 */

import type { HistoryItem } from './api'
import {
    getLocalHistory,
    saveLocalHistory,
    prependLocalHistoryItem,
    updateLocalHistoryItem,
    removeLocalHistoryItem,
    HISTORY_UPDATE_EVENT,
} from './historyStorage'

export interface MatchPersistenceRecord {
    fixtureId?: number | null
    homeTeam: string
    awayTeam: string
    kickoffTimestamp: number
    status: 'notstarted' | 'inprogress' | 'finished' | string
    settled: boolean
    [key: string]: unknown
}

/**
 * Deduplicate an array of matches strictly by fixtureId or normalized home/away team names.
 */
export function deduplicateMatches<T extends { fixtureId?: number | null; homeTeam?: string; awayTeam?: string; meta?: { home?: string; away?: string; eventId?: number | null } }>(
    matches: T[],
): T[] {
    const seen = new Set<string>()
    const result: T[] = []

    for (const m of matches) {
        if (!m) continue
        const fixId = m.fixtureId || m.meta?.eventId
        const h = (m.homeTeam || m.meta?.home || '').trim().toLowerCase()
        const a = (m.awayTeam || m.meta?.away || '').trim().toLowerCase()
        const key = fixId ? `fix:${fixId}` : h && a ? `${h}_vs_${a}` : `unknown:${JSON.stringify(m).slice(0, 30)}`

        if (!seen.has(key)) {
            seen.add(key)
            result.push(m)
        }
    }
    return result
}

export {
    getLocalHistory,
    saveLocalHistory,
    prependLocalHistoryItem,
    updateLocalHistoryItem,
    removeLocalHistoryItem,
    HISTORY_UPDATE_EVENT,
}
export type { HistoryItem }
