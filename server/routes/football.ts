/**
 * API-Football Proxy Router (/api/football).
 * ─────────────────────────────────────────────────────────────────────────────
 * • Endpoint chính thức: https://v3.football.api-sports.io
 * • Header: x-apisports-key
 * • Enforce one-shot snapshot workflow với zero background polling.
 * • Cache Redis (Upstash) tự động để tối ưu quota 100 req/ngày.
 */

import { Hono } from 'hono'
import {
    extractDetailedFixtureStatistics,
    extractFixtureEvents,
    extractFixtureStatistics,
    extractStructuredFixtureEvents,
    fetchApiFootball,
    findFixture,
    getFixtureH2H,
    getMatchLiveStatus,
    searchFootballMatch,
    type ApiFootballFixtureItem,
} from '../services/apiFootball.js'
import { getMatchGrounding } from '../services/search.js'

export const footballApp = new Hono()

// GET /api/football/grounding?home=...&away=...&league=...
footballApp.get('/grounding', async (c) => {
    const home = c.req.query('home') || ''
    const away = c.req.query('away') || ''
    const league = c.req.query('league') || ''
    const kickoff = c.req.query('kickoff') || ''
    const force = c.req.query('force') === '1' || c.req.query('force') === 'true'

    if (!home || !away) {
        return c.json(
            { error: 'missing_teams', message: 'Vui lòng cung cấp tên hai đội (home & away).' },
            400,
        )
    }

    const grounding = await getMatchGrounding(home, away, {
        league: league || undefined,
        kickoff: kickoff || undefined,
        forceRefresh: force,
    })
    return c.json(grounding)
})


// GET /api/football/search?q=... or ?home=...&away=...
footballApp.get('/search', async (c) => {
    const q = c.req.query('q') || ''
    const home = c.req.query('home') || ''
    const away = c.req.query('away') || ''
    const searchQuery = q || (home && away ? `${home} vs ${away}` : home || away)

    if (!searchQuery) {
        return c.json(
            { error: 'missing_query', message: 'Vui lòng cung cấp từ khóa tìm kiếm (q hoặc home/away).' },
            400,
        )
    }

    const match = await searchFootballMatch(searchQuery, home, away)
    if (!match) {
        return c.json({ found: false, message: 'Không tìm thấy trận đấu phù hợp trên API-Football.' }, 404)
    }

    const f = match.fixture
    const kickoffTimestamp = f.fixture?.timestamp
        ? f.fixture.timestamp * 1000
        : f.fixture?.date
            ? new Date(f.fixture.date).getTime()
            : Date.now()

    return c.json({
        found: true,
        eventId: match.fixtureId,
        fixtureId: match.fixtureId,
        homeTeam: f.teams?.home?.name,
        awayTeam: f.teams?.away?.name,
        league: f.league?.name,
        kickoff: f.fixture?.date,
        kickoffTimestamp,
        fixture: f,
    })
})

// GET /api/football/h2h?fixtureId=... or ?team1=...&team2=...
footballApp.get('/h2h', async (c) => {
    const fixtureIdParam = c.req.query('fixtureId') || c.req.query('eventId')
    const team1Param = c.req.query('team1')
    const team2Param = c.req.query('team2')

    let t1 = Number(team1Param)
    let t2 = Number(team2Param)

    if ((!t1 || !t2) && fixtureIdParam) {
        const fixId = Number(fixtureIdParam)
        if (fixId && !isNaN(fixId)) {
            const list = await fetchApiFootball<ApiFootballFixtureItem[]>('fixtures', { id: fixId }, 3600)
            if (list && list.length > 0) {
                t1 = list[0].teams?.home?.id
                t2 = list[0].teams?.away?.id
            }
        }
    }

    if (!t1 || !t2 || isNaN(t1) || isNaN(t2)) {
        return c.json({ error: 'missing_teams', message: 'Vui lòng cung cấp team1 và team2 hoặc fixtureId.' }, 400)
    }

    const h2h = await getFixtureH2H(t1, t2)
    return c.json(h2h)
})

// GET /api/football/fixtures/:id/statistics
footballApp.get('/fixtures/:id/statistics', async (c) => {
    const id = Number(c.req.param('id'))
    if (!id || isNaN(id)) {
        return c.json({ error: 'invalid_id', message: 'ID trận đấu không hợp lệ.' }, 400)
    }
    const [stats, { detailed, raw }] = await Promise.all([
        extractFixtureStatistics(id),
        extractDetailedFixtureStatistics(id),
    ])
    return c.json({ fixtureId: id, statistics: stats, detailedStats: detailed, rawStatistics: raw })
})

// GET /api/football/fixtures/:id/events
footballApp.get('/fixtures/:id/events', async (c) => {
    const id = Number(c.req.param('id'))
    if (!id || isNaN(id)) {
        return c.json({ error: 'invalid_id', message: 'ID trận đấu không hợp lệ.' }, 400)
    }
    const [structuredEvents, incidents] = await Promise.all([
        extractStructuredFixtureEvents(id),
        extractFixtureEvents(id),
    ])
    return c.json({ fixtureId: id, events: structuredEvents, incidents })
})

// GET /api/football/fixtures/:id/live — Snapshot toàn diện (Live Status, Stats & Incidents)
footballApp.get('/fixtures/:id/live', async (c) => {
    const id = Number(c.req.param('id'))
    if (!id || isNaN(id)) {
        return c.json({ error: 'invalid_id', message: 'ID trận đấu không hợp lệ.' }, 400)
    }

    const isFinishedHint = false // không biết trước, để cache ngắn
    const [statusData, structuredEvents, incidentsData, detailedResult] = await Promise.all([
        getMatchLiveStatus('', '', id),
        extractStructuredFixtureEvents(id),
        extractFixtureEvents(id),
        extractDetailedFixtureStatistics(id, isFinishedHint),
    ])

    if (!statusData.found) {
        return c.json({ error: 'not_found', message: 'Không tìm thấy thông tin trận đấu trên API-Football.' }, 404)
    }

    return c.json({
        found: true,
        eventId: id,
        fixtureId: id,
        homeTeam: statusData.homeTeam,
        awayTeam: statusData.awayTeam,
        homeLogo: statusData.homeLogo,
        awayLogo: statusData.awayLogo,
        homeTeamId: statusData.homeTeamId,
        awayTeamId: statusData.awayTeamId,
        homeForm: statusData.homeForm,
        awayForm: statusData.awayForm,
        league: statusData.league,
        kickoff: statusData.kickoff,
        kickoffTimestamp: statusData.kickoffTimestamp,
        status: statusData.status,
        statusDescription: statusData.statusDescription,
        minute: statusData.minute,
        score: statusData.score,
        periodScore: statusData.periodScore,
        matchStats: {
            corners: statusData.corners,
            cards: statusData.cards,
            shotsOnTarget: statusData.shotsOnTarget,
            shotsTotal: statusData.shotsTotal,
            possession: statusData.possession,
            fouls: statusData.fouls,
            accuratePasses: statusData.accuratePasses,
        },
        detailedStats: detailedResult.detailed,
        rawStatistics: detailedResult.raw,
        incidents: incidentsData,
        events: structuredEvents,
        isFinished: statusData.isFinished,
        lastUpdated: statusData.lastUpdated,
    })
})

// GET /api/football/fixtures/:id — Chi tiết fixture
footballApp.get('/fixtures/:id', async (c) => {
    const id = Number(c.req.param('id'))
    if (!id || isNaN(id)) {
        return c.json({ error: 'invalid_id', message: 'ID trận đấu không hợp lệ.' }, 400)
    }
    const item = await findFixture('', '', id)
    if (!item) {
        return c.json({ error: 'not_found', message: 'Không tìm thấy fixture.' }, 404)
    }
    return c.json(item)
})

// Proxy wildcard cho các endpoint API-Football khác
footballApp.get('/*', async (c) => {
    const path = c.req.path.replace(/^\/api\/football\//, '').replace(/^\/football\//, '')
    const query = c.req.url.includes('?') ? c.req.url.slice(c.req.url.indexOf('?')) : ''
    const subpath = `${path}${query}`
    const data = await fetchApiFootball(subpath, {}, 60)
    if (!data) {
        return c.json({ error: 'not_found' }, 404)
    }
    return c.json(data)
})
