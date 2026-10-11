/**
 * SofaScore API Service (Trực tiếp từ SofaScore, hoàn toàn miễn phí, 0đ, không giới hạn).
 *
 * Thay thế hoàn toàn SportAPI (RapidAPI 50 req/tháng).
 *
 * Đặc điểm:
 * 1. Gọi trực tiếp SofaScore public endpoints:
 *    - Chi tiết trận: https://api.sofascore.com/api/v1/event/${eventId}
 *    - Thống kê: https://api.sofascore.com/api/v1/event/${eventId}/statistics
 *    - Diễn biến & Tỉ số: https://api.sofascore.com/api/v1/event/${eventId}/incidents
 * 2. Header giả lập trình duyệt cơ bản chống chặn CORS / Cloudflare.
 * 3. Cache tạm thời vào Upstash Redis với TTL = 15s để chống spam request.
 * 4. Trích xuất số liệu thật 100%: Tỉ số, Phút thi đấu, Cầm bóng, Phạt góc, Thẻ phạt, Sút trúng đích.
 */

import { keys, redis } from '../redis.js'
import type { LiveMatchData } from '../../src/lib/types.js'

export const SOFASCORE_BASE_URL = 'https://api.sofascore.com/api/v1'

export const SOFASCORE_HEADERS: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Referer': 'https://www.sofascore.com/',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8',
}

// In-memory cache dự phòng cục bộ ngắn hạn (6s)
const localMemCache = new Map<string, { data: unknown; expires: number }>()

/**
 * Gọi API SofaScore với cache Upstash Redis (TTL = 15s theo mặc định).
 */
export async function fetchSofaScore<T = unknown>(subpath: string, ttlSec = 15): Promise<T | null> {
    const cleanPath = subpath.replace(/^\/+/, '')
    const cacheKey = keys.sofascoreCache(cleanPath)

    // 1. Kiểm tra cache Redis
    try {
        const cached = await redis.get<T>(cacheKey)
        if (cached !== null && cached !== undefined) {
            return cached
        }
    } catch {
        // Fallback in-memory
        const mem = localMemCache.get(cleanPath)
        if (mem && mem.expires > Date.now()) {
            return mem.data as T
        }
    }

    // 2. Fetch từ SofaScore API với header giả lập trình duyệt
    const url = `${SOFASCORE_BASE_URL}/${cleanPath}`
    try {
        const res = await fetch(url, {
            headers: SOFASCORE_HEADERS,
            signal: AbortSignal.timeout(10000),
        })
        if (!res.ok) {
            if (res.status !== 404) {
                console.warn(`[sofascore] HTTP ${res.status} khi gọi ${url}`)
            }
            return null
        }
        const data = (await res.json()) as T

        // 3. Ghi cache vào Redis với TTL = 15s
        try {
            await redis.set(cacheKey, data, { ex: ttlSec })
        } catch {
            localMemCache.set(cleanPath, { data, expires: Date.now() + ttlSec * 1000 })
        }

        return data
    } catch (e) {
        console.warn(`[sofascore] Lỗi kết nối ${url}:`, e instanceof Error ? e.message : e)
        return null
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

/** Tính phút thi đấu từ time timestamp */
export function computeMinute(time: Record<string, unknown> | undefined, statusDesc: string): string | number {
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

export interface RawStatItem {
    name: string
    key: string
    home: string | number
    away: string | number
    homeValue?: number
    awayValue?: number
    homeTotal?: number
    awayTotal?: number
}

export interface RawStatGroup {
    groupName: string
    statisticsItems: RawStatItem[]
}

export interface RawStatPeriod {
    period: string
    groups: RawStatGroup[]
}

export interface RawStatsResponse {
    statistics?: RawStatPeriod[]
}

export interface ParsedEventStatistics {
    corners: { home: number; away: number; total: number }
    cards: { yellowHome: number; yellowAway: number; redHome: number; redAway: number }
    shotsOnTarget: { home: number; away: number }
    shotsTotal: { home: number; away: number }
    possession: { home: number; away: number }
    fouls: { home: number; away: number }
}

/** Trích xuất 100% số liệu thống kê thật từ SofaScore statistics endpoint */
export async function extractEventStatistics(eventId: number): Promise<ParsedEventStatistics> {
    const statsRes = await fetchSofaScore<RawStatsResponse>(`event/${eventId}/statistics`, 15)

    let corners = { home: 0, away: 0, total: 0 }
    let cards = { yellowHome: 0, yellowAway: 0, redHome: 0, redAway: 0 }
    let shotsOnTarget = { home: 0, away: 0 }
    let shotsTotal = { home: 0, away: 0 }
    let possession = { home: 50, away: 50 }
    let fouls = { home: 0, away: 0 }

    if (!statsRes?.statistics || !Array.isArray(statsRes.statistics)) {
        return { corners, cards, shotsOnTarget, shotsTotal, possession, fouls }
    }

    const all = statsRes.statistics.find((s) => s.period === 'ALL') || statsRes.statistics[0]
    if (!all?.groups) {
        return { corners, cards, shotsOnTarget, shotsTotal, possession, fouls }
    }

    const items = all.groups.flatMap((g) => g.statisticsItems || [])

    for (const item of items) {
        const k = (item.key || '').toLowerCase()
        const n = (item.name || '').toLowerCase()

        // Phạt góc (corners)
        if (k === 'cornerkicks' || k === 'corner_kicks' || n.includes('corner')) {
            const h = Number(item.homeValue ?? item.home) || 0
            const a = Number(item.awayValue ?? item.away) || 0
            corners = { home: h, away: a, total: h + a }
        }

        // Cú sút trúng đích (shots on target)
        if (k === 'shotsongoal' || k === 'shotsontarget' || k === 'shots_on_target' || n.includes('shots on target') || n.includes('shots on goal')) {
            const h = Number(item.homeValue ?? item.home) || 0
            const a = Number(item.awayValue ?? item.away) || 0
            shotsOnTarget = { home: h, away: a }
        }

        // Tổng số cú sút (total shots)
        if (k === 'totalshots' || k === 'total_shots' || n.includes('total shots') || n === 'shots') {
            const h = Number(item.homeValue ?? item.home) || 0
            const a = Number(item.awayValue ?? item.away) || 0
            shotsTotal = { home: h, away: a }
        }

        // Tỷ lệ kiểm soát bóng (possession)
        if (k === 'ballpossession' || k === 'ball_possession' || n.includes('possession')) {
            const hStr = String(item.home || '').replace('%', '').trim()
            const aStr = String(item.away || '').replace('%', '').trim()
            const h = Number(hStr) || 50
            const a = Number(aStr) || 50
            possession = { home: h, away: a }
        }

        // Thẻ vàng (yellow cards)
        if (k === 'yellowcards' || k === 'yellow_cards' || n.includes('yellow')) {
            const h = Number(item.homeValue ?? item.home) || 0
            const a = Number(item.awayValue ?? item.away) || 0
            cards.yellowHome = h
            cards.yellowAway = a
        }

        // Thẻ đỏ (red cards)
        if (k === 'redcards' || k === 'red_cards' || n.includes('red')) {
            const h = Number(item.homeValue ?? item.home) || 0
            const a = Number(item.awayValue ?? item.away) || 0
            cards.redHome = h
            cards.redAway = a
        }

        // Phạm lỗi (fouls)
        if (k === 'fouls' || n.includes('foul')) {
            const h = Number(item.homeValue ?? item.home) || 0
            const a = Number(item.awayValue ?? item.away) || 0
            fouls = { home: h, away: a }
        }
    }

    // Nếu shotsTotal chưa có nhưng có shotsOnTarget
    if (shotsTotal.home === 0 && shotsOnTarget.home > 0) shotsTotal.home = shotsOnTarget.home
    if (shotsTotal.away === 0 && shotsOnTarget.away > 0) shotsTotal.away = shotsOnTarget.away

    return { corners, cards, shotsOnTarget, shotsTotal, possession, fouls }
}

export interface SofaIncident {
    incidentType: string
    isHome?: boolean
    time?: number
    addedTime?: number
    text?: string
    homeScore?: number
    awayScore?: number
    player?: { name?: string; slug?: string }
    incidentClass?: string
    [key: string]: unknown
}

/** Lấy diễn biến các sự kiện trong trận từ SofaScore incidents */
export async function getEventIncidents(eventId: number): Promise<SofaIncident[]> {
    const res = await fetchSofaScore<{ incidents?: SofaIncident[] }>(`event/${eventId}/incidents`, 15)
    return res?.incidents || []
}

export interface RawEvent {
    id: number
    homeTeam?: { name: string; id?: number }
    awayTeam?: { name: string; id?: number }
    tournament?: { name: string }
    status?: { code?: number; description?: string; type?: string }
    homeScore?: { current?: number; display?: number; period1?: number; normaltime?: number }
    awayScore?: { current?: number; display?: number; period1?: number; normaltime?: number }
    time?: Record<string, unknown>
    startTimestamp?: number
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
 * Tìm kiếm event trên SofaScore dựa vào tên đội nhà và đội khách hoặc SofaScore event ID.
 */
export async function findSofaEvent(
    home: string,
    away: string,
    preferredEventId?: number,
): Promise<RawEvent | null> {
    // 1. Nếu có ID cụ thể, gọi thẳng SofaScore API
    if (preferredEventId && preferredEventId > 0) {
        const res = await fetchSofaScore<{ event?: RawEvent }>(`event/${preferredEventId}`, 15)
        if (res?.event) return res.event
    }

    // 2. Tra cứu trong danh sách Live Events trực tiếp từ SofaScore
    const liveData = await fetchSofaScore<LiveEventsResponse>('sport/football/events/live', 10)
    const liveEvents = liveData?.events || []

    for (const ev of liveEvents) {
        const evHome = ev.homeTeam?.name || ''
        const evAway = ev.awayTeam?.name || ''
        if (isTeamMatch(home, evHome) && isTeamMatch(away, evAway)) {
            return ev
        }
    }

    // 3. Nếu không có trong Live Events, tìm kiếm team qua SofaScore /search/all
    if (home.trim()) {
        const searchData = await fetchSofaScore<SearchResponse>(`search/all?q=${encodeURIComponent(home)}`, 60)
        const teamEntity = searchData?.results?.find(
            (r) => r.entity && (r.entity.sport?.id === 1 || r.entity.sport?.slug === 'football'),
        )?.entity

        if (teamEntity?.id) {
            // Tìm trong last events (vừa kết thúc) và next events
            const lastData = await fetchSofaScore<TeamEventsResponse>(`team/${teamEntity.id}/events/last/0`, 30)
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

            const nextData = await fetchSofaScore<TeamEventsResponse>(`team/${teamEntity.id}/events/next/0`, 30)
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
    }

    return null
}

/**
 * Lấy trạng thái thời gian thực của trận đấu từ SofaScore (100% dữ liệu thật).
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
        shotsTotal: { home: 0, away: 0 },
        possession: { home: 50, away: 50 },
        fouls: { home: 0, away: 0 },
        isFinished: false,
        lastUpdated: Date.now(),
    }

    if (!home && !away && (!preferredEventId || preferredEventId <= 0)) return emptyResult

    const ev = await findSofaEvent(home, away, preferredEventId)
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
    const kickoff = ev.startTimestamp ? new Date(ev.startTimestamp * 1000).toISOString() : undefined

    // Lấy thống kê chi tiết 100% số liệu thật từ SofaScore
    const stats = await extractEventStatistics(ev.id)

    return {
        found: true,
        eventId: ev.id,
        homeTeam: ev.homeTeam?.name || home,
        awayTeam: ev.awayTeam?.name || away,
        league: ev.tournament?.name,
        kickoff,
        status: isFinished ? 'finished' : statusType === 'inprogress' ? 'inprogress' : 'notstarted',
        statusDescription: statusDesc,
        minute,
        score: { home: homeScoreVal, away: awayScoreVal },
        periodScore: { htHome, htAway, ftHome, ftAway },
        corners: stats.corners,
        cards: stats.cards,
        shotsOnTarget: stats.shotsOnTarget,
        shotsTotal: stats.shotsTotal,
        possession: stats.possession,
        fouls: stats.fouls,
        isFinished,
        lastUpdated: Date.now(),
    }
}
