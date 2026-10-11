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
import { fetchSofaScore } from '../services/sofascore.js'

export const sofascoreApp = new Hono()

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

// GET /api/sofascore/event/:eventId
sofascoreApp.get('/event/:eventId', async (c) => {
    const eventId = c.req.param('eventId')
    const data = await fetchSofaScore(`event/${eventId}`, 15)
    if (!data) {
        return c.json({ error: 'not_found', message: 'Không tìm thấy thông tin trận đấu.' }, 404)
    }
    return c.json(data)
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
