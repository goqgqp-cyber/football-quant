/**
 * SportAPI Service (RapidAPI - sportapi7).
 *
 * Cung cấp:
 * 1. Lấy danh sách trận bóng đá đang đá trực tiếp (live matches).
 * 2. Tra cứu chi tiết trận theo tên 2 đội (home / away) hoặc event ID.
 * 3. Trích xuất chỉ số thời gian thực: Tỷ số, Phút thi đấu, Phạt góc, Thẻ phạt,
 *    Sút trúng đích (shots on target), Kiểm soát bóng (possession).
 * 4. Nhận diện trạng thái kết thúc ('finished' / 'FT') kèm tỷ số và phạt góc chính thức.
 */

import { env } from '../env.js'
import type { LiveMatchData } from '../../src/lib/types.js'

interface RapidHeaders {
    'x-rapidapi-key': string
    'x-rapidapi-host': string
    [key: string]: string
}

function getHeaders(): RapidHeaders {
    return {
        'x-rapidapi-key': env.sportApiKey,
        'x-rapidapi-host': env.sportApiHost,
    }
}

/** Chuẩn hóa tên đội bóng để so khớp tên tiếng Việt / viết tắt / đầy đủ */
export function normalizeTeamName(name: string): string {
    if (!name) return ''
    return name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // Bỏ dấu tiếng Việt / ký tự đặc biệt
        .replace(/\b(fc|afc|cf|sc|as|ac|ss|bv|sv|fk|sk|cd|ud|rb|u17|u19|u21|u23)\b/gi, '')
        .replace(/[^a-z0-9]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

/** So khớp hai tên đội */
export function isTeamMatch(inputName: string, targetName: string): boolean {
    const a = normalizeTeamName(inputName)
    const b = normalizeTeamName(targetName)
    if (!a || !b) return false
    if (a === b) return true
    if (a.includes(b) || b.includes(a)) return true

    // So khớp theo từng từ khóa chính (ví dụ "man city" vs "manchester city")
    const wordsA = a.split(' ').filter((w) => w.length > 2)
    const wordsB = b.split(' ').filter((w) => w.length > 2)
    return wordsA.some((wa) => wordsB.some((wb) => wa.includes(wb) || wb.includes(wa)))
}

// In-memory cache 12s cho các lời gọi API tránh chạm rate limit RapidAPI
const cache = new Map<string, { data: unknown; expires: number }>()

async function cachedFetch<T>(url: string, ttlMs = 12000): Promise<T | null> {
    const now = Date.now()
    const hit = cache.get(url)
    if (hit && hit.expires > now) {
        return hit.data as T
    }

    try {
        const res = await fetch(url, {
            headers: getHeaders(),
            signal: AbortSignal.timeout(12000),
        })
        if (!res.ok) {
            console.warn(`[sportapi] HTTP ${res.status} khi gọi ${url}`)
            return null
        }
        const data = (await res.json()) as T
        cache.set(url, { data, expires: now + ttlMs })
        return data
    } catch (e) {
        console.warn(`[sportapi] Lỗi kết nối ${url}:`, e instanceof Error ? e.message : e)
        return null
    }
}

/** Tính phút thi đấu từ time timestamp */
function computeMinute(time: Record<string, unknown> | undefined, statusDesc: string): string | number {
    if (!time) {
        if (/ht|halftime/i.test(statusDesc)) return 'HT'
        if (/ft|ended|finished/i.test(statusDesc)) return 'FT'
        return statusDesc || '—'
    }

    const curPeriod = Number(time.currentPeriodStartTimestamp)
    if (curPeriod && Number.isFinite(curPeriod) && curPeriod > 0) {
        const elapsedSec = Math.max(0, Math.floor(Date.now() / 1000 - curPeriod))
        const is2nd = /2nd|h2/i.test(statusDesc)
        const baseMin = is2nd ? 45 : 0
        const min = baseMin + Math.floor(elapsedSec / 60)
        return Math.min(120, Math.max(1, min))
    }

    if (typeof time.initial === 'number') {
        return Math.floor(time.initial / 60)
    }

    if (/ht|halftime/i.test(statusDesc)) return 'HT'
    if (/ft|ended|finished/i.test(statusDesc)) return 'FT'
    return statusDesc || '—'
}

interface RawStatItem {
    name: string
    key: string
    home: string | number
    away: string | number
    homeValue?: number
    awayValue?: number
}

interface RawStatGroup {
    groupName: string
    statisticsItems: RawStatItem[]
}

interface RawStatPeriod {
    period: string
    groups: RawStatGroup[]
}

interface RawStatsResponse {
    statistics?: RawStatPeriod[]
}

/** Trích xuất số liệu thống kê trận đấu */
async function extractEventStatistics(eventId: number): Promise<{
    corners: { home: number; away: number; total: number }
    cards: { yellowHome: number; yellowAway: number; redHome: number; redAway: number }
    shotsOnTarget: { home: number; away: number }
    possession: { home: number; away: number }
}> {
    const url = `${env.sportApiBaseUrl}/event/${eventId}/statistics`
    const statsRes = await cachedFetch<RawStatsResponse>(url, 15000)

    let corners = { home: 0, away: 0, total: 0 }
    let cards = { yellowHome: 0, yellowAway: 0, redHome: 0, redAway: 0 }
    let shotsOnTarget = { home: 0, away: 0 }
    let possession = { home: 50, away: 50 }

    if (!statsRes?.statistics || !Array.isArray(statsRes.statistics)) {
        return { corners, cards, shotsOnTarget, possession }
    }

    const all = statsRes.statistics.find((s) => s.period === 'ALL') || statsRes.statistics[0]
    if (!all?.groups) {
        return { corners, cards, shotsOnTarget, possession }
    }

    const items = all.groups.flatMap((g) => g.statisticsItems || [])

    for (const item of items) {
        const k = (item.key || '').toLowerCase()
        const n = (item.name || '').toLowerCase()

        // Phạt góc (corners)
        if (k === 'cornerkicks' || n.includes('corner')) {
            const h = Number(item.homeValue ?? item.home) || 0
            const a = Number(item.awayValue ?? item.away) || 0
            corners = { home: h, away: a, total: h + a }
        }

        // Cú sút trúng đích (shots on target / shots on goal)
        if (k === 'shotsongoal' || k === 'shotsontarget' || n.includes('shots on target') || n.includes('shots on goal')) {
            const h = Number(item.homeValue ?? item.home) || 0
            const a = Number(item.awayValue ?? item.away) || 0
            shotsOnTarget = { home: h, away: a }
        }

        // Tỷ lệ kiểm soát bóng (possession)
        if (k === 'ballpossession' || n.includes('possession')) {
            const hStr = String(item.home || '').replace('%', '').trim()
            const aStr = String(item.away || '').replace('%', '').trim()
            const h = Number(hStr) || 50
            const a = Number(aStr) || 50
            possession = { home: h, away: a }
        }

        // Thẻ vàng (yellow cards)
        if (k === 'yellowcards' || n.includes('yellow')) {
            const h = Number(item.homeValue ?? item.home) || 0
            const a = Number(item.awayValue ?? item.away) || 0
            cards.yellowHome = h
            cards.yellowAway = a
        }

        // Thẻ đỏ (red cards)
        if (k === 'redcards' || n.includes('red')) {
            const h = Number(item.homeValue ?? item.home) || 0
            const a = Number(item.awayValue ?? item.away) || 0
            cards.redHome = h
            cards.redAway = a
        }
    }

    return { corners, cards, shotsOnTarget, possession }
}

interface RawEvent {
    id: number
    homeTeam?: { name: string; id?: number }
    awayTeam?: { name: string; id?: number }
    tournament?: { name: string }
    status?: { code?: number; description?: string; type?: string }
    homeScore?: { current?: number; display?: number; period1?: number; normaltime?: number }
    awayScore?: { current?: number; display?: number; period1?: number; normaltime?: number }
    time?: Record<string, unknown>
}

interface LiveEventsResponse {
    events?: RawEvent[]
}

interface SearchResponse {
    results?: Array<{
        entity?: {
            id: number
            name: string
            type: number
            sport?: { id: number; slug: string }
        }
    }>
}

interface TeamEventsResponse {
    events?: RawEvent[]
}

/**
 * Tìm kiếm event trên SportAPI dựa vào tên đội nhà và đội khách.
 */
export async function findSportApiEvent(
    home: string,
    away: string,
    preferredEventId?: number,
): Promise<RawEvent | null> {
    // 1. Nếu có ID cụ thể, gọi thẳng
    if (preferredEventId && preferredEventId > 0) {
        const url = `${env.sportApiBaseUrl}/event/${preferredEventId}`
        const res = await cachedFetch<{ event?: RawEvent }>(url, 15000)
        if (res?.event) return res.event
    }

    // 2. Tra cứu trong danh sách Live Events trước
    const liveUrl = `${env.sportApiBaseUrl}/sport/football/events/live`
    const liveData = await cachedFetch<LiveEventsResponse>(liveUrl, 10000)
    const liveEvents = liveData?.events || []

    for (const ev of liveEvents) {
        const evHome = ev.homeTeam?.name || ''
        const evAway = ev.awayTeam?.name || ''
        if (isTeamMatch(home, evHome) && isTeamMatch(away, evAway)) {
            return ev
        }
    }

    // 3. Nếu không có trong Live Events, tìm kiếm team qua /search/all
    const searchUrl = `${env.sportApiBaseUrl}/search/all?q=${encodeURIComponent(home)}`
    const searchData = await cachedFetch<SearchResponse>(searchUrl, 60000)
    const teamEntity = searchData?.results?.find(
        (r) => r.entity && (r.entity.sport?.id === 1 || r.entity.sport?.slug === 'football'),
    )?.entity

    if (teamEntity?.id) {
        // Tìm trong last events (vừa kết thúc) và next events
        const lastUrl = `${env.sportApiBaseUrl}/team/${teamEntity.id}/events/last/0`
        const lastData = await cachedFetch<TeamEventsResponse>(lastUrl, 30000)
        const lastList = lastData?.events || []
        for (const ev of lastList) {
            const evHome = ev.homeTeam?.name || ''
            const evAway = ev.awayTeam?.name || ''
            if (
                (isTeamMatch(home, evHome) && isTeamMatch(away, evAway)) ||
                (isTeamMatch(home, evAway) && isTeamMatch(away, evHome))
            ) {
                return ev
            }
        }

        const nextUrl = `${env.sportApiBaseUrl}/team/${teamEntity.id}/events/next/0`
        const nextData = await cachedFetch<TeamEventsResponse>(nextUrl, 30000)
        const nextList = nextData?.events || []
        for (const ev of nextList) {
            const evHome = ev.homeTeam?.name || ''
            const evAway = ev.awayTeam?.name || ''
            if (
                (isTeamMatch(home, evHome) && isTeamMatch(away, evAway)) ||
                (isTeamMatch(home, evAway) && isTeamMatch(away, evHome))
            ) {
                return ev
            }
        }
    }

    return null
}

/**
 * Lấy trạng thái thời gian thực của trận đấu.
 */
export async function getMatchLiveStatus(
    home: string,
    away: string,
    preferredEventId?: number,
): Promise<LiveMatchData> {
    const emptyResult: LiveMatchData = {
        found: false,
        score: { home: 0, away: 0 },
        corners: { home: 0, away: 0, total: 0 },
        cards: { yellowHome: 0, yellowAway: 0, redHome: 0, redAway: 0 },
        shotsOnTarget: { home: 0, away: 0 },
        possession: { home: 50, away: 50 },
        isFinished: false,
        lastUpdated: Date.now(),
    }

    if (!home || !away) return emptyResult

    const ev = await findSportApiEvent(home, away, preferredEventId)
    if (!ev) {
        return emptyResult
    }

    const statusType = (ev.status?.type || '').toLowerCase()
    const statusDesc = ev.status?.description || ''
    const isFinished =
        statusType === 'finished' ||
        /ended|finished|ft/i.test(statusDesc) ||
        (ev.status?.code ?? 0) === 100

    const homeScoreVal = Number(ev.homeScore?.current ?? ev.homeScore?.display ?? 0)
    const awayScoreVal = Number(ev.awayScore?.current ?? ev.awayScore?.display ?? 0)

    const htHome = ev.homeScore?.period1
    const htAway = ev.awayScore?.period1
    const ftHome = isFinished ? homeScoreVal : undefined
    const ftAway = isFinished ? awayScoreVal : undefined

    const minute = isFinished ? 'FT' : computeMinute(ev.time, statusDesc)

    // Lấy thống kê chi tiết phạt góc, sút, kiểm soát bóng
    const stats = await extractEventStatistics(ev.id)

    return {
        found: true,
        eventId: ev.id,
        homeTeam: ev.homeTeam?.name || home,
        awayTeam: ev.awayTeam?.name || away,
        league: ev.tournament?.name,
        status: isFinished ? 'finished' : statusType === 'inprogress' ? 'inprogress' : 'notstarted',
        statusDescription: statusDesc,
        minute,
        score: { home: homeScoreVal, away: awayScoreVal },
        periodScore: { htHome, htAway, ftHome, ftAway },
        corners: stats.corners,
        cards: stats.cards,
        shotsOnTarget: stats.shotsOnTarget,
        possession: stats.possession,
        isFinished,
        lastUpdated: Date.now(),
    }
}
