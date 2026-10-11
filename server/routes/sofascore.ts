/**
 * SofaScore Proxy Router (/api/sofascore).
 *
 * Cho phép Frontend gọi trực tiếp các endpoint công khai của SofaScore:
 * 1. GET /api/sofascore/event/:eventId/statistics — Chi tiết trận & Thống kê
 * 2. GET /api/sofascore/event/:eventId/incidents — Diễn biến, bàn thắng, thẻ, phạt góc
 * 3. GET /api/sofascore/event/:eventId — Thông tin trận & tỉ số
 * 4. GET /api/sofascore/* — Proxy tất cả các endpoint khác của SofaScore API v1.
 *
 * Mọi request đều được server thêm header giả lập trình duyệt và cache qua Upstash Redis (TTL = 15s).
 */

import { Hono } from 'hono'
import {
    computeMinute,
    fetchSofaScore,
    getEventH2H,
    getEventStatsAndIncidents,
    searchSofaMatch,
    type RawEvent,
} from '../services/sofascore.js'

export const sofascoreApp = new Hono()

// GET /api/sofascore/search?q=... or ?home=...&away=...
sofascoreApp.get('/search', async (c) => {
    const q = c.req.query('q') || ''
    const home = c.req.query('home') || ''
    const away = c.req.query('away') || ''
    const searchQuery = q || (home && away ? `${home} ${away}` : home || away)
    if (!searchQuery) {
        return c.json({ error: 'missing_query', message: 'Vui lòng cung cấp từ khóa tìm kiếm (q hoặc home/away).' }, 400)
    }
    const match = await searchSofaMatch(searchQuery, home, away)
    if (!match) {
        return c.json({ found: false, message: 'Không tìm thấy trận đấu phù hợp trên SofaScore.' }, 404)
    }
    return c.json({
        found: true,
        eventId: match.eventId,
        homeTeam: match.event.homeTeam?.name,
        awayTeam: match.event.awayTeam?.name,
        league: match.event.tournament?.name,
        kickoff: match.event.startTimestamp ? new Date(match.event.startTimestamp * 1000).toISOString() : undefined,
        event: match.event,
    })
})

// GET /api/sofascore/h2h?eventId=... hoặc /api/sofascore/h2h/:eventId
sofascoreApp.get('/h2h', async (c) => {
    const eventIdParam = c.req.query('eventId')
    const eventId = Number(eventIdParam)
    if (!eventId || isNaN(eventId)) {
        return c.json({ error: 'missing_eventId', message: 'Vui lòng cung cấp eventId hợp lệ.' }, 400)
    }
    const h2h = await getEventH2H(eventId)
    return c.json(h2h)
})

sofascoreApp.get('/h2h/:eventId', async (c) => {
    const eventId = Number(c.req.param('eventId'))
    if (!eventId || isNaN(eventId)) {
        return c.json({ error: 'missing_eventId', message: 'Vui lòng cung cấp eventId hợp lệ.' }, 400)
    }
    const h2h = await getEventH2H(eventId)
    return c.json(h2h)
})

// GET /api/sofascore/stats?eventId=... hoặc /api/sofascore/stats/:eventId
sofascoreApp.get('/stats', async (c) => {
    const eventIdParam = c.req.query('eventId')
    const eventId = Number(eventIdParam)
    if (!eventId || isNaN(eventId)) {
        return c.json({ error: 'missing_eventId', message: 'Vui lòng cung cấp eventId hợp lệ.' }, 400)
    }
    const statsData = await getEventStatsAndIncidents(eventId)
    return c.json(statsData)
})

sofascoreApp.get('/stats/:eventId', async (c) => {
    const eventId = Number(c.req.param('eventId'))
    if (!eventId || isNaN(eventId)) {
        return c.json({ error: 'missing_eventId', message: 'Vui lòng cung cấp eventId hợp lệ.' }, 400)
    }
    const statsData = await getEventStatsAndIncidents(eventId)
    return c.json(statsData)
})

// GET /api/sofascore/event/:eventId/statistics
sofascoreApp.get('/event/:eventId/statistics', async (c) => {
    const eventId = c.req.param('eventId')
    const data = await fetchSofaScore(`event/${eventId}/statistics`, 15)
    if (!data) {
        return c.json({ error: 'not_found', message: 'Không tìm thấy thống kê trận đấu.' }, 404)
    }
    return c.json(data)
})

// GET /api/sofascore/event/:eventId/incidents
sofascoreApp.get('/event/:eventId/incidents', async (c) => {
    const eventId = c.req.param('eventId')
    const data = await fetchSofaScore(`event/${eventId}/incidents`, 15)
    if (!data) {
        return c.json({ error: 'not_found', message: 'Không tìm thấy diễn biến trận đấu.' }, 404)
    }
    return c.json(data)
})

// GET /api/sofascore/event/:eventId/live — Lấy toàn bộ trạng thái trực tiếp: info, statistics & incidents
sofascoreApp.get('/event/:eventId/live', async (c) => {
    const eventIdParam = c.req.param('eventId')
    const eventId = Number(eventIdParam)
    if (!eventId || isNaN(eventId)) {
        return c.json({ error: 'missing_eventId', message: 'Vui lòng cung cấp eventId hợp lệ.' }, 400)
    }
    const [eventData, statsIncidents] = await Promise.all([
        fetchSofaScore<{ event?: RawEvent }>(`event/${eventId}`, 15),
        getEventStatsAndIncidents(eventId),
    ])

    const ev = eventData?.event
    if (!ev && (!statsIncidents || (!statsIncidents.statistics && statsIncidents.incidents.length === 0))) {
        return c.json({ error: 'not_found', message: 'Không tìm thấy dữ liệu trực tiếp của trận đấu.' }, 404)
    }

    const statusType = (ev?.status?.type || '').toLowerCase()
    const statusDesc = ev?.status?.description || ''
    const isFinished =
        statusType === 'finished' ||
        /ended|finished|ft/i.test(statusDesc) ||
        (ev?.status?.code ?? 0) === 100

    const homeScoreVal = Number(ev?.homeScore?.current ?? ev?.homeScore?.display ?? 0)
    const awayScoreVal = Number(ev?.awayScore?.current ?? ev?.awayScore?.display ?? 0)
    const htHome = ev?.homeScore?.period1
    const htAway = ev?.awayScore?.period1
    const ftHome = isFinished ? homeScoreVal : undefined
    const ftAway = isFinished ? awayScoreVal : undefined

    let minute: number | string = '—'
    if (isFinished) {
        minute = 'FT'
    } else if (ev) {
        minute = computeMinute(ev.time, statusDesc)
    }

    return c.json({
        found: true,
        eventId,
        homeTeam: ev?.homeTeam?.name,
        awayTeam: ev?.awayTeam?.name,
        league: ev?.tournament?.name,
        status: isFinished ? 'finished' : statusType === 'inprogress' ? 'inprogress' : 'notstarted',
        statusDescription: statusDesc,
        minute,
        score: { home: homeScoreVal, away: awayScoreVal },
        periodScore: { htHome, htAway, ftHome, ftAway },
        matchStats: statsIncidents.statistics,
        incidents: statsIncidents.incidents,
        isFinished,
        lastUpdated: Date.now(),
    })
})


// Proxy wildcard cho các endpoint SofaScore khác (search, live events...)
sofascoreApp.get('/*', async (c) => {
    const path = c.req.path.replace(/^\/api\/sofascore\//, '').replace(/^\/sofascore\//, '')
    const query = c.req.url.includes('?') ? c.req.url.slice(c.req.url.indexOf('?')) : ''
    const subpath = `${path}${query}`
    const data = await fetchSofaScore(subpath, 15)
    if (!data) {
        return c.json({ error: 'not_found' }, 404)
    }
    return c.json(data)
})
