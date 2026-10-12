/**
 * API-Football Service (https://v3.football.api-sports.io)
 * ─────────────────────────────────────────────────────────────────────────────
 * • Dùng 100% API-Football v3 chính thức với Header: x-apisports-key.
 * • Enforce one-shot snapshot workflow — không background polling.
 * • Cache Redis (Upstash) thông minh theo trạng thái trận (live: 30-60s, FT: 24h)
 *   để bảo tồn quota 100 req/ngày.
 */

import { env } from '../env.js'
import { keys, redis } from '../redis.js'
import type { LiveMatchData, DetailedMatchStatistics, MatchEventItem } from '../../src/lib/types.js'

export const API_FOOTBALL_BASE_URL = 'https://v3.football.api-sports.io'

export interface ApiFootballResponse<T> {
    get: string
    parameters: Record<string, string | number>
    errors: Record<string, string> | string[]
    results: number
    paging: { current: number; total: number }
    response: T
}

export interface ApiFootballFixtureItem {
    fixture: {
        id: number
        referee?: string | null
        timezone?: string
        date: string
        timestamp: number
        periods?: { first?: number | null; second?: number | null }
        venue?: { id?: number | null; name?: string | null; city?: string | null }
        status: {
            long: string
            short: string
            elapsed?: number | null
            extra?: number | null
        }
    }
    league: {
        id: number
        name: string
        country?: string
        logo?: string
        flag?: string
        season?: number
        round?: string
    }
    teams: {
        home: { id: number; name: string; logo?: string; winner?: boolean | null }
        away: { id: number; name: string; logo?: string; winner?: boolean | null }
    }
    goals: {
        home?: number | null
        away?: number | null
    }
    score: {
        halftime?: { home?: number | null; away?: number | null }
        fulltime?: { home?: number | null; away?: number | null }
        extratime?: { home?: number | null; away?: number | null }
        penalty?: { home?: number | null; away?: number | null }
    }
}

export interface ApiFootballStatItem {
    type: string
    value: number | string | null
}

export interface ApiFootballTeamStats {
    team: { id: number; name: string; logo?: string }
    statistics: ApiFootballStatItem[]
}

export interface ApiFootballEventItem {
    time: { elapsed: number; extra?: number | null }
    team: { id: number; name: string; logo?: string }
    player?: { id?: number | null; name?: string | null }
    assist?: { id?: number | null; name?: string | null }
    type: string // "Goal", "Card", "subst", "Var"
    detail: string // "Normal Goal", "Yellow Card", "Red Card", "Penalty", etc.
    comments?: string | null
}

export interface FootballIncident {
    incidentType: 'goal' | 'card' | 'corner' | 'shot' | 'sub' | 'var' | 'attack'
    isHome: boolean
    time: number
    addedTime?: number
    text: string
    homeScore?: number
    awayScore?: number
    player?: { name?: string }
    detail?: string
}

export interface MatchStatistics {
    corners: { home: number; away: number; total: number }
    cards: { yellowHome: number; yellowAway: number; redHome: number; redAway: number }
    shotsOnTarget: { home: number; away: number }
    shotsTotal: { home: number; away: number }
    possession: { home: number; away: number }
    fouls: { home: number; away: number }
    accuratePasses: { home: number; away: number }
}

export interface H2HResult {
    eventId: number
    events: ApiFootballFixtureItem[]
    h2hText: string
    n: number
    avgGoals: number
    bttsRate: number
}

/** Chuẩn hóa tên đội để so khớp không dấu và bỏ qua các tiền tố FC, SC, Club... */
export function normalizeTeam(name: string): string {
    return (name || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\b(fc|sc|ac|cf|afc|fk|sv|united|utd|city|club|de|la|el|the)\b/gi, '')
        .replace(/[^a-z0-9]/g, '')
        .trim()
}

export function isTeamMatch(target: string, candidate: string): boolean {
    const t = normalizeTeam(target)
    const c = normalizeTeam(candidate)
    if (!t || !c) return false
    return t === c || t.includes(c) || c.includes(t)
}

/**
 * Gọi API-Football với cache Upstash Redis.
 */
export async function fetchApiFootball<T = unknown>(
    endpoint: string,
    params: Record<string, string | number> = {},
    ttlSec = 60,
): Promise<T | null> {
    const cleanEndpoint = endpoint.replace(/^\/+/, '')
    const searchParams = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') {
            searchParams.set(k, String(v))
        }
    }
    const queryString = searchParams.toString()
    const pathWithQuery = queryString ? `${cleanEndpoint}?${queryString}` : cleanEndpoint
    const cacheKey = keys.footballCache(pathWithQuery)

    // 1. Kiểm tra cache Redis
    try {
        const cached = await redis.get<T>(cacheKey)
        if (cached) {
            return cached
        }
    } catch {
        /* bỏ qua lỗi cache */
    }

    // 2. Gọi API-Football
    const apiKey = (env.apiFootballKey || '32ef4117471d08b60402e551a089faff').trim()
    const url = `${API_FOOTBALL_BASE_URL}/${pathWithQuery}`

    try {
        const res = await fetch(url, {
            headers: {
                'x-apisports-key': apiKey,
                Accept: 'application/json',
            },
        })

        if (!res.ok) {
            console.warn(`[api-football] HTTP ${res.status} khi gọi ${url}`)
            return null
        }

        const data = (await res.json()) as ApiFootballResponse<T>
        if (data.errors && Object.keys(data.errors).length > 0) {
            console.warn(`[api-football] Lỗi phản hồi từ API-Football:`, data.errors)
        }

        const payload = data.response

        // 3. Ghi cache Redis nếu có dữ liệu hợp lệ
        if (payload !== undefined && payload !== null) {
            try {
                await redis.set(cacheKey, payload, { ex: ttlSec })
            } catch {
                /* bỏ qua lỗi set cache */
            }
        }

        return payload
    } catch (e) {
        console.warn(`[api-football] Lỗi kết nối ${url}:`, e instanceof Error ? e.message : e)
        return null
    }
}

/**
 * Tìm kiếm Fixture trên API-Football:
 * 1. Nếu có fixtureId cụ thể: gọi /fixtures?id=...
 * 2. Tìm trong các trận đang Live (/fixtures?live=all)
 * 3. Tìm trong các trận ngày hôm nay (/fixtures?date=YYYY-MM-DD)
 * 4. Tìm kiếm đội bóng (/teams?search=...) rồi lấy H2H
 */
export async function findFixture(
    home: string,
    away: string,
    preferredFixtureId?: number,
): Promise<ApiFootballFixtureItem | null> {
    // 1. Nếu có ID cụ thể, tra cứu trực tiếp
    if (preferredFixtureId && preferredFixtureId > 0) {
        const list = await fetchApiFootball<ApiFootballFixtureItem[]>('fixtures', { id: preferredFixtureId }, 30)
        if (list && list.length > 0) return list[0]
    }

    const cleanHome = home.trim()
    const cleanAway = away.trim()
    if (!cleanHome && !cleanAway) return null

    // 2. Tra cứu trong các trận đang Live
    const liveList = await fetchApiFootball<ApiFootballFixtureItem[]>('fixtures', { live: 'all' }, 30)
    if (liveList && liveList.length > 0) {
        for (const item of liveList) {
            const hName = item.teams?.home?.name || ''
            const aName = item.teams?.away?.name || ''
            if (isTeamMatch(cleanHome, hName) && isTeamMatch(cleanAway, aName)) {
                return item
            }
        }
    }

    // 3. Tra cứu trong lịch thi đấu hôm nay
    const today = new Date().toISOString().split('T')[0]
    const todayList = await fetchApiFootball<ApiFootballFixtureItem[]>('fixtures', { date: today }, 60)
    if (todayList && todayList.length > 0) {
        for (const item of todayList) {
            const hName = item.teams?.home?.name || ''
            const aName = item.teams?.away?.name || ''
            if (isTeamMatch(cleanHome, hName) && isTeamMatch(cleanAway, aName)) {
                return item
            }
        }
    }

    // 4. Tra cứu theo ngày hôm qua (cho các trận vừa kết thúc cần đối soát)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const yesterdayList = await fetchApiFootball<ApiFootballFixtureItem[]>('fixtures', { date: yesterday }, 120)
    if (yesterdayList && yesterdayList.length > 0) {
        for (const item of yesterdayList) {
            const hName = item.teams?.home?.name || ''
            const aName = item.teams?.away?.name || ''
            if (isTeamMatch(cleanHome, hName) && isTeamMatch(cleanAway, aName)) {
                return item
            }
        }
    }

    return null
}

/**
 * Trích xuất 100% số liệu thống kê trận đấu từ API-Football /fixtures/statistics
 */
export async function extractFixtureStatistics(
    fixtureId: number,
    isFinished = false,
): Promise<MatchStatistics> {
    const ttl = isFinished ? 86400 : 30
    const list = await fetchApiFootball<ApiFootballTeamStats[]>('fixtures/statistics', { fixture: fixtureId }, ttl)
    if (!list || list.length < 2) {
        return {
            corners: { home: 0, away: 0, total: 0 },
            cards: { yellowHome: 0, yellowAway: 0, redHome: 0, redAway: 0 },
            shotsOnTarget: { home: 0, away: 0 },
            shotsTotal: { home: 0, away: 0 },
            possession: { home: 0, away: 0 },
            fouls: { home: 0, away: 0 },
            accuratePasses: { home: 0, away: 0 },
        }
    }

    const homeTeam = list[0]
    const awayTeam = list[1]

    const getStat = (team: ApiFootballTeamStats, typeName: string): number => {
        const item = team.statistics?.find((s) => s.type?.toLowerCase() === typeName.toLowerCase())
        if (!item || item.value === null || item.value === undefined) return 0
        if (typeof item.value === 'number') return item.value
        const parsed = parseInt(String(item.value).replace('%', '').trim(), 10)
        return isNaN(parsed) ? 0 : parsed
    }

    const cornersHome = getStat(homeTeam, 'Corner Kicks')
    const cornersAway = getStat(awayTeam, 'Corner Kicks')
    const yellowHome = getStat(homeTeam, 'Yellow Cards')
    const yellowAway = getStat(awayTeam, 'Yellow Cards')
    const redHome = getStat(homeTeam, 'Red Cards')
    const redAway = getStat(awayTeam, 'Red Cards')
    const shotsOnTargetHome = getStat(homeTeam, 'Shots on Goal')
    const shotsOnTargetAway = getStat(awayTeam, 'Shots on Goal')
    const shotsTotalHome = getStat(homeTeam, 'Total Shots')
    const shotsTotalAway = getStat(awayTeam, 'Total Shots')
    const foulsHome = getStat(homeTeam, 'Fouls')
    const foulsAway = getStat(awayTeam, 'Fouls')
    const passAccHome = getStat(homeTeam, 'Passes accurate')
    const passAccAway = getStat(awayTeam, 'Passes accurate')

    const possHome = getStat(homeTeam, 'Ball Possession')
    const possAway = getStat(awayTeam, 'Ball Possession')

    return {
        corners: { home: cornersHome, away: cornersAway, total: cornersHome + cornersAway },
        cards: { yellowHome, yellowAway, redHome, redAway },
        shotsOnTarget: { home: shotsOnTargetHome, away: shotsOnTargetAway },
        shotsTotal: { home: shotsTotalHome, away: shotsTotalAway },
        possession: { home: possHome, away: possAway },
        fouls: { home: foulsHome, away: foulsAway },
        accuratePasses: { home: passAccHome, away: passAccAway },
    }
}

/**
 * Trích xuất thống kê chi tiết đầy đủ 4 nhóm (A–D) từ API-Football.
 * Tái sử dụng cùng endpoint /fixtures/statistics nhưng parse sâu hơn,
 * trả về DetailedMatchStatistics + mảng raw để frontend Hub dùng trực tiếp.
 */
export async function extractDetailedFixtureStatistics(
    fixtureId: number,
    isFinished = false,
): Promise<{ detailed: DetailedMatchStatistics | null; raw: ApiFootballTeamStats[] }> {
    const ttl = isFinished ? 86400 : 30
    const list = await fetchApiFootball<ApiFootballTeamStats[]>('fixtures/statistics', { fixture: fixtureId }, ttl)

    if (!list || list.length < 2 || !list[0].statistics || list[0].statistics.length === 0) {
        return { detailed: null, raw: list || [] }
    }

    const ht = list[0]
    const at = list[1]

    const n = (team: ApiFootballTeamStats, t: string): number => {
        const it = team.statistics.find((s) => s.type.toLowerCase() === t.toLowerCase())
        if (!it || it.value === null || it.value === undefined) return 0
        if (typeof it.value === 'number') return it.value
        const p = parseInt(String(it.value).replace('%', '').trim(), 10)
        return isNaN(p) ? 0 : p
    }
    const pct = (team: ApiFootballTeamStats, t: string): number => {
        const it = team.statistics.find((s) => s.type.toLowerCase() === t.toLowerCase())
        if (!it || it.value === null || it.value === undefined) return 0
        const p = parseFloat(String(it.value).replace('%', '').trim())
        return isNaN(p) ? 0 : p
    }

    const possH = n(ht, 'Ball Possession'), possA = n(at, 'Ball Possession')

    const passH = n(ht, 'Passes accurate'), passA = n(at, 'Passes accurate')
    const passPctH = pct(ht, 'Passes %'), passPctA = pct(at, 'Passes %')

    const crossH = n(ht, 'Accurate Crosses') || n(ht, 'Crosses')
    const crossA = n(at, 'Accurate Crosses') || n(at, 'Crosses')
    const crossTH = n(ht, 'Total Crosses') || crossH
    const crossTA = n(at, 'Total Crosses') || crossA

    const lbH = n(ht, 'Accurate Long Balls') || n(ht, 'Long Balls')
    const lbA = n(at, 'Accurate Long Balls') || n(at, 'Long Balls')
    const lbTH = n(ht, 'Total Long Balls') || lbH
    const lbTA = n(at, 'Total Long Balls') || lbA

    const xgH = n(ht, 'expected_goals') || n(ht, 'Expected Goals')
    const xgA = n(at, 'expected_goals') || n(at, 'Expected Goals')

    const dwH = n(ht, 'Duels won'), dwA = n(at, 'Duels won')
    const dtH = n(ht, 'Total Duels') || (dwH + dwA), dtA = n(at, 'Total Duels') || (dwH + dwA)
    const adwH = n(ht, 'Aerials won') || n(ht, 'Aerial Duels won')
    const adwA = n(at, 'Aerials won') || n(at, 'Aerial Duels won')
    const adtH = n(ht, 'Total Aerials') || (adwH + adwA), adtA = n(at, 'Total Aerials') || (adwH + adwA)

    const totalPassH = n(ht, 'Total passes'), totalPassA = n(at, 'Total passes')
    const shotsTotH = n(ht, 'Total Shots'), shotsTotA = n(at, 'Total Shots')
    const cornersH = n(ht, 'Corner Kicks'), cornersA = n(at, 'Corner Kicks')

    // Nếu không có bất kỳ dữ liệu chuyền bóng, sút hay phạt góc nào, đây là giải đấu không có live stats
    if (totalPassH === 0 && totalPassA === 0 && shotsTotH === 0 && shotsTotA === 0 && cornersH === 0 && cornersA === 0 && possH === 0 && possA === 0) {
        return { detailed: null, raw: list }
    }

    const detailed: DetailedMatchStatistics = {
        possession: { home: possH, away: possA },
        totalPasses: { home: totalPassH, away: totalPassA },
        accuratePasses: { homeCount: passH, homePct: passPctH, awayCount: passA, awayPct: passPctA },
        accurateCrosses: {
            homeCount: crossH, homePct: crossTH > 0 ? Math.round(crossH / crossTH * 100) : 0,
            awayCount: crossA, awayPct: crossTA > 0 ? Math.round(crossA / crossTA * 100) : 0,
        },
        accurateLongBalls: {
            homeCount: lbH, homePct: lbTH > 0 ? Math.round(lbH / lbTH * 100) : 0,
            awayCount: lbA, awayPct: lbTA > 0 ? Math.round(lbA / lbTA * 100) : 0,
        },
        shotsTotal: { home: n(ht, 'Total Shots'), away: n(at, 'Total Shots') },
        shotsOnGoal: { home: n(ht, 'Shots on Goal'), away: n(at, 'Shots on Goal') },
        shotsOffGoal: { home: n(ht, 'Shots off Goal'), away: n(at, 'Shots off Goal') },
        shotsBlocked: { home: n(ht, 'Blocked Shots'), away: n(at, 'Blocked Shots') },
        shotsInsideBox: { home: n(ht, 'Shots insidebox'), away: n(at, 'Shots insidebox') },
        shotsOutsideBox: { home: n(ht, 'Shots outsidebox'), away: n(at, 'Shots outsidebox') },
        penalties: { home: n(ht, 'Penalties') || n(ht, 'Penalty'), away: n(at, 'Penalties') || n(at, 'Penalty') },
        keyPasses: { home: n(ht, 'Key Passes') || n(ht, 'Key passes'), away: n(at, 'Key Passes') || n(at, 'Key passes') },
        duelsWon: {
            homeCount: dwH, homePct: dtH > 0 ? Math.round((dwH / dtH) * 100) : 50,
            awayCount: dwA, awayPct: dtA > 0 ? Math.round((dwA / dtA) * 100) : 50,
        },
        aerialDuelsWon: {
            homeCount: adwH, homePct: adtH > 0 ? Math.round((adwH / adtH) * 100) : 50,
            awayCount: adwA, awayPct: adtA > 0 ? Math.round((adwA / adtA) * 100) : 50,
        },
        goalkeeperSaves: { home: n(ht, 'Goalkeeper Saves') || n(ht, 'Saves'), away: n(at, 'Goalkeeper Saves') || n(at, 'Saves') },
        ...(xgH > 0 || xgA > 0 ? { expectedGoals: { home: xgH, away: xgA } } : {}),
        corners: { home: n(ht, 'Corner Kicks'), away: n(at, 'Corner Kicks') },
        fouls: { home: n(ht, 'Fouls'), away: n(at, 'Fouls') },
        yellowCards: { home: n(ht, 'Yellow Cards'), away: n(at, 'Yellow Cards') },
        redCards: { home: n(ht, 'Red Cards'), away: n(at, 'Red Cards') },
        offsides: { home: n(ht, 'Offsides'), away: n(at, 'Offsides') },
        tackles: { home: n(ht, 'Tackles'), away: n(at, 'Tackles') },
        interceptions: { home: n(ht, 'Interceptions') || n(ht, 'Interception'), away: n(at, 'Interceptions') || n(at, 'Interception') },
        clearances: { home: n(ht, 'Clearances') || n(ht, 'Clearance'), away: n(at, 'Clearances') || n(at, 'Clearance') },
    }

    return { detailed, raw: list }
}

/**
 * Lấy phong độ 5 trận gần nhất của một đội từ API-Football:
 * Endpoint: /fixtures?team={teamId}&last=5&status=FT
 * Trả về mảng 5 ký tự ['W', 'D', 'L', ...], cache 24h (86400s)
 */
export async function getTeamRecentForm(teamId: number): Promise<string[]> {
    if (!teamId || teamId <= 0) return []
    try {
        const list = await fetchApiFootball<ApiFootballFixtureItem[]>(
            'fixtures',
            { team: teamId, last: 5, status: 'FT' },
            86400,
        )
        if (!list || !Array.isArray(list) || list.length === 0) return []

        const form: string[] = []
        for (const item of list) {
            const isHome = item.teams?.home?.id === teamId
            const myGoals = isHome
                ? Number(item.goals?.home ?? item.score?.fulltime?.home ?? 0)
                : Number(item.goals?.away ?? item.score?.fulltime?.away ?? 0)
            const oppGoals = isHome
                ? Number(item.goals?.away ?? item.score?.fulltime?.away ?? 0)
                : Number(item.goals?.home ?? item.score?.fulltime?.home ?? 0)

            if (myGoals > oppGoals) {
                form.push('W')
            } else if (myGoals === oppGoals) {
                form.push('D')
            } else {
                form.push('L')
            }
        }
        return form.slice(0, 5)
    } catch {
        return []
    }
}

export const fetchTeamRecentForm = getTeamRecentForm

/**
 * Trích xuất các sự kiện diễn biến trong trận từ API-Football /fixtures/events
 */
export async function extractFixtureEvents(
    fixtureId: number,
    homeTeamId?: number,
    isFinished = false,
): Promise<FootballIncident[]> {
    const ttl = isFinished ? 86400 : 30
    const list = await fetchApiFootball<ApiFootballEventItem[]>('fixtures/events', { fixture: fixtureId }, ttl)
    if (!list || !Array.isArray(list)) return []

    const incidents: FootballIncident[] = []

    for (const item of list) {
        const isHome = homeTeamId ? item.team?.id === homeTeamId : true
        const typeLower = (item.type || '').toLowerCase()
        const detail = item.detail || ''

        let incidentType: FootballIncident['incidentType'] = 'attack'
        let text = detail

        if (typeLower === 'goal') {
            incidentType = 'goal'
            text = detail.toLowerCase().includes('penalty') ? 'Bàn thắng (Penalty)' : 'Bàn thắng'
        } else if (typeLower === 'card') {
            incidentType = 'card'
            text = detail.toLowerCase().includes('red') ? 'Thẻ đỏ' : 'Thẻ vàng'
        } else if (typeLower === 'subst') {
            incidentType = 'sub'
            text = 'Thay người'
        } else if (typeLower === 'var') {
            incidentType = 'var'
            text = `VAR: ${detail}`
        }

        incidents.push({
            incidentType,
            isHome,
            time: item.time?.elapsed || 0,
            addedTime: item.time?.extra ?? undefined,
            text,
            player: item.player?.name ? { name: item.player.name } : undefined,
            detail,
        })
    }

    return incidents
}

/**
 * Trích xuất các sự kiện diễn biến chi tiết trong trận theo format MatchEventItem
 * Dùng cho component Timeline sự kiện (Bàn thắng, thẻ phạt, thay người, VAR, mốc HT/FT).
 */
export async function extractStructuredFixtureEvents(
    fixtureId: number,
    homeTeamId?: number,
    isFinished = false,
): Promise<MatchEventItem[]> {
    const ttl = isFinished ? 86400 : 30
    const list = await fetchApiFootball<ApiFootballEventItem[]>('fixtures/events', { fixture: fixtureId }, ttl)
    if (!list || !Array.isArray(list)) return []

    // Sắp xếp thứ tự thời gian tăng dần
    const sorted = [...list].sort((a, b) => {
        const timeA = (a.time?.elapsed || 0) + (a.time?.extra || 0) * 0.1
        const timeB = (b.time?.elapsed || 0) + (b.time?.extra || 0) * 0.1
        return timeA - timeB
    })

    const events: MatchEventItem[] = []
    let scoreHome = 0
    let scoreAway = 0

    for (const item of sorted) {
        const isHome = homeTeamId ? item.team?.id === homeTeamId : true
        const typeLower = (item.type || '').toLowerCase()
        const detail = item.detail || ''
        const detailLower = detail.toLowerCase()

        let formattedType = typeLower
        let formattedDetail = detail
        let playerIn: string | undefined = undefined
        let playerOut: string | undefined = undefined
        let currentScoreStr: string | undefined = undefined

        if (typeLower === 'goal') {
            if (detailLower.includes('missed')) {
                formattedType = 'goal_missed'
                formattedDetail = 'Sút hỏng phạt đền'
            } else if (detailLower.includes('own goal')) {
                formattedType = 'goal'
                formattedDetail = 'Bàn thắng (Phản lưới nhà)'
                if (isHome) scoreAway++
                else scoreHome++
                currentScoreStr = `${scoreHome} - ${scoreAway}`
            } else if (detailLower.includes('penalty')) {
                formattedType = 'goal'
                formattedDetail = 'Bàn thắng (Pen)'
                if (isHome) scoreHome++
                else scoreAway++
                currentScoreStr = `${scoreHome} - ${scoreAway}`
            } else {
                formattedType = 'goal'
                formattedDetail = 'Bàn thắng'
                if (isHome) scoreHome++
                else scoreAway++
                currentScoreStr = `${scoreHome} - ${scoreAway}`
            }
        } else if (typeLower === 'card') {
            formattedType = 'card'
            formattedDetail = detailLower.includes('red') ? 'Thẻ đỏ' : 'Thẻ vàng'
        } else if (typeLower === 'subst') {
            formattedType = 'subst'
            formattedDetail = 'Thay người'
            playerOut = item.player?.name || undefined
            playerIn = item.assist?.name || undefined
        } else if (typeLower === 'var') {
            formattedType = 'var'
            formattedDetail = `VAR: ${detail}`
        }

        events.push({
            time: item.time?.elapsed || 0,
            addedTime: item.time?.extra ?? undefined,
            type: formattedType,
            detail: formattedDetail,
            isHome,
            teamName: item.team?.name,
            teamLogo: item.team?.logo,
            player: item.player?.name || undefined,
            assist: item.assist?.name || undefined,
            score: currentScoreStr,
            playerIn,
            playerOut,
            comments: item.comments || undefined,
        })
    }

    return events
}

/**
 * Lấy trạng thái thời gian thực của trận đấu từ API-Football (100% dữ liệu thật, One-shot Snapshot).
 */
export async function getMatchLiveStatus(
    home: string,
    away: string,
    preferredFixtureId?: number,
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

    if (!home && !away && (!preferredFixtureId || preferredFixtureId <= 0)) {
        return emptyResult
    }

    const item = await findFixture(home, away, preferredFixtureId)
    if (!item) {
        return emptyResult
    }

    const fix = item.fixture
    const statusShort = (fix.status?.short || '').toUpperCase()
    const statusLong = fix.status?.long || ''

    // Các trạng thái kết thúc chính thức: FT (Full Time), AET, PEN
    const isFinished = ['FT', 'AET', 'PEN', 'PPD', 'CANC', 'ABD', 'AWD', 'WO'].includes(statusShort)
    const isLive = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE'].includes(statusShort)

    const homeScoreVal = Number(item.goals?.home ?? item.score?.fulltime?.home ?? 0)
    const awayScoreVal = Number(item.goals?.away ?? item.score?.fulltime?.away ?? 0)

    const htHome = item.score?.halftime?.home ?? undefined
    const htAway = item.score?.halftime?.away ?? undefined
    const ftHome = isFinished ? homeScoreVal : undefined
    const ftAway = isFinished ? awayScoreVal : undefined

    let minute: number | string = '—'
    if (isFinished) {
        minute = 'FT'
    } else if (statusShort === 'HT') {
        minute = 'HT'
    } else if (fix.status?.elapsed != null) {
        let el = Number(fix.status.elapsed)
        if (el > 100 && statusShort !== 'AET' && statusShort !== 'PEN') {
            el = 90
        }
        minute = el
    } else {
        minute = statusShort || 'NS'
    }

    const kickoff = fix.date
    const kickoffTimestamp = fix.timestamp
        ? fix.timestamp * 1000
        : fix.date
            ? new Date(fix.date).getTime()
            : Date.now()
    const homeId = item.teams?.home?.id
    const awayId = item.teams?.away?.id

    // Lấy thống kê chi tiết trận đấu và phong độ 5 trận gần nhất
    const [stats, homeForm, awayForm] = await Promise.all([
        extractFixtureStatistics(fix.id, isFinished),
        homeId ? getTeamRecentForm(homeId) : Promise.resolve([]),
        awayId ? getTeamRecentForm(awayId) : Promise.resolve([]),
    ])

    return {
        found: true,
        eventId: fix.id,
        fixtureId: fix.id,
        homeTeam: item.teams?.home?.name || home,
        awayTeam: item.teams?.away?.name || away,
        homeLogo: item.teams?.home?.logo,
        awayLogo: item.teams?.away?.logo,
        homeTeamId: homeId,
        awayTeamId: awayId,
        homeForm: homeForm,
        awayForm: awayForm,
        league: item.league?.name,
        kickoff,
        kickoffTimestamp,
        status: isFinished ? 'finished' : isLive ? 'inprogress' : 'notstarted',
        statusDescription: statusLong || statusShort,
        minute,
        score: { home: homeScoreVal, away: awayScoreVal },
        periodScore: { htHome, htAway, ftHome, ftAway },
        corners: stats.corners,
        cards: stats.cards,
        shotsOnTarget: stats.shotsOnTarget,
        shotsTotal: stats.shotsTotal,
        possession: stats.possession,
        fouls: stats.fouls,
        accuratePasses: stats.accuratePasses,
        isFinished,
        lastUpdated: Date.now(),
    }
}

/**
 * Lấy lịch sử đối đầu (H2H) từ API-Football:
 * Endpoint: /fixtures/headtohead?h2h={team1}-{team2}
 */
export async function getFixtureH2H(team1Id: number, team2Id: number): Promise<H2HResult> {
    const emptyResult: H2HResult = {
        eventId: 0,
        events: [],
        h2hText: 'THỰC TẾ LỊCH SỬ ĐỐI ĐẦU (H2H API-Football):\n- Chưa có dữ liệu đối đầu gần đây trên API-Football.',
        n: 0,
        avgGoals: 0,
        bttsRate: 0,
    }

    if (!team1Id || !team2Id) return emptyResult

    const pair = `${team1Id}-${team2Id}`
    const rawEvents = await fetchApiFootball<ApiFootballFixtureItem[]>('fixtures/headtohead', { h2h: pair }, 3600)
    const list = (rawEvents || []).slice(0, 10)

    if (list.length === 0) return emptyResult

    let totalGoals = 0
    let bttsCount = 0
    const lines: string[] = ['THỰC TẾ LỊCH SỬ ĐỐI ĐẦU (H2H API-Football):']

    for (const item of list) {
        const dateStr = item.fixture?.date ? item.fixture.date.split('T')[0] : 'Gần đây'
        const league = item.league?.name || 'League'
        const hName = item.teams?.home?.name || 'Home'
        const aName = item.teams?.away?.name || 'Away'

        const ftHome = Number(item.goals?.home ?? item.score?.fulltime?.home ?? 0)
        const ftAway = Number(item.goals?.away ?? item.score?.fulltime?.away ?? 0)
        const htHome = Number(item.score?.halftime?.home ?? 0)
        const htAway = Number(item.score?.halftime?.away ?? 0)

        totalGoals += ftHome + ftAway
        if (ftHome > 0 && ftAway > 0) {
            bttsCount++
        }

        lines.push(`- ${dateStr} ${league}: ${hName} ${ftHome} - ${ftAway} ${aName} (HT: ${htHome} - ${htAway})`)
    }

    const n = list.length
    const avgGoals = Number((totalGoals / n).toFixed(2))
    const bttsRate = Number((bttsCount / n).toFixed(2))

    return {
        eventId: list[0]?.fixture?.id || 0,
        events: list,
        h2hText: lines.join('\n'),
        n,
        avgGoals,
        bttsRate,
    }
}

/**
 * Tìm kiếm trận đấu trên API-Football dựa theo từ khóa hoặc tên 2 đội.
 */
export async function searchFootballMatch(
    query: string,
    home?: string,
    away?: string,
): Promise<{ fixtureId: number; fixture: ApiFootballFixtureItem } | null> {
    const h = home?.trim() || ''
    const a = away?.trim() || ''

    if (h && a) {
        const item = await findFixture(h, a)
        if (item) {
            return { fixtureId: item.fixture.id, fixture: item }
        }
    }

    if (query.trim()) {
        const parts = query.trim().split(/\s+(?:vs|v|-)\s+/i)
        if (parts.length === 2) {
            const item = await findFixture(parts[0], parts[1])
            if (item) {
                return { fixtureId: item.fixture.id, fixture: item }
            }
        }
    }

    return null
}
