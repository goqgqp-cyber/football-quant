import { Hono } from 'hono'
import { z } from 'zod'
import { requireAuth, type Vars } from '../middleware.js'
import { keys, redis } from '../redis.js'
import {
    computeStats,
    deleteHistory,
    getHistoryItem,
    listHistory,
    listSettledMatches,
    saveHistory,
    settleHistory,
} from '../store.js'
import { getUserById } from '../auth.js'
import { analyzeMatch, suggestedLines } from '../../src/lib/engine.js'
import { MOCK_MATCH_DATA } from '../../src/lib/mock.js'
import type { Explanation, MatchData, OddsLine } from '../../src/lib/types.js'

import { env } from '../env.js'
import { generateExplanation, sanitizeCleanText } from '../services/xkiro.js'
import { getMatchLiveStatus } from '../services/sofascore.js'

export const dataApp = new Hono<{ Variables: Vars }>()

// Mọi route trong đây đều yêu cầu đăng nhập
dataApp.use('*', requireAuth)

const oddsLineSchema = z
    .object({
        id: z.string().min(1).max(100),
        kind: z.enum(['totals', 'ah', 'corners']),
        side: z.enum(['over', 'under', 'home', 'away']),
        line: z.number(),
        odds: z.coerce.number().min(1.01).max(500),
    })
    .strip()

const analyzeSchema = z
    .object({
        home: z.string().min(1).max(80),
        away: z.string().min(1).max(80),
        league: z.string().max(80).optional().default(''),
        kickoff: z.string().max(64).nullable().optional().default(null),
        lg_home: z.coerce.number().positive().optional(),
        lg_away: z.coerce.number().positive().optional(),
        oddsLines: z.array(oddsLineSchema).max(60).default([]),
        /** Dữ liệu nền (Bước A). Nếu không có sẽ dùng mock an toàn. */
        matchData: z.unknown().optional(),
        withExplanation: z.boolean().optional().default(false),
    })
    .strip()

/** GET /api/me */
dataApp.get('/me', async (c) => {
    const auth = c.get('user')
    const user = await getUserById(auth.userId)
    if (!user) return c.json({ error: 'not_found' }, 404)
    return c.json({
        user: {
            userId: user.userId,
            email: user.email,
            role: user.role,
            bankroll: user.bankroll,
            createdAt: user.createdAt,
        },
    })
})

/** PATCH /api/me — cập nhật tổng vốn. */
dataApp.patch('/me', async (c) => {
    const auth = c.get('user')
    const body = await c.req.json().catch(() => null)
    const parsed = z.object({ bankroll: z.coerce.number().min(0).max(1e12) }).safeParse(body)
    if (!parsed.success) return c.json({ error: 'validation' }, 400)

    const user = await getUserById(auth.userId)
    if (!user) return c.json({ error: 'not_found' }, 404)
    user.bankroll = parsed.data.bankroll
    await redis.set(keys.user(user.userId), user)
    return c.json({ user: { userId: user.userId, email: user.email, role: user.role, bankroll: user.bankroll } })
})

/** GET /api/suggested-lines — gợi ý mốc kèo phổ biến. */
dataApp.get('/suggested-lines', (c) => c.json({ lines: suggestedLines() }))

/** GET /api/history — danh sách lượt phân tích. */
dataApp.get('/history', async (c) => {
    const auth = c.get('user')
    const limit = Math.min(200, Number.parseInt(c.req.query('limit') ?? '100', 10) || 100)
    const rows = await listHistory(auth.userId, limit)
    return c.json({ items: rows })
})

/** GET /api/history/:id */
dataApp.get('/history/:id', async (c) => {
    const auth = c.get('user')
    const row = await getHistoryItem(auth.userId, c.req.param('id'))
    if (!row) return c.json({ error: 'not_found' }, 404)
    return c.json({ item: row })
})

/** DELETE /api/history/:id */
dataApp.delete('/history/:id', async (c) => {
    const auth = c.get('user')
    const ok = await deleteHistory(auth.userId, c.req.param('id'))
    if (!ok) return c.json({ error: 'not_found' }, 404)
    return c.json({ ok: true })
})

/** POST /api/analyze — tính toán bằng engine thuần TS rồi lưu lịch sử. */
dataApp.post('/analyze', async (c) => {
    const auth = c.get('user')
    const body = await c.req.json().catch(() => null)
    const parsed = analyzeSchema.safeParse(body)
    if (!parsed.success) {
        return c.json({ error: 'validation', issues: parsed.error.flatten() }, 400)
    }
    const input = parsed.data

    // Làm sạch text đầu vào, loại bỏ triệt để chuỗi base64 hoặc blob nhị phân
    const home = sanitizeCleanText(input.home)
    const away = sanitizeCleanText(input.away)
    const league = sanitizeCleanText(input.league ?? '')

    // Nếu client không gửi matchData → dùng mock có nhãn rõ.
    const matchData = (input.matchData as MatchData | undefined) ?? MOCK_MATCH_DATA
    const oddsLines = input.oddsLines as OddsLine[]

    const result = analyzeMatch(
        matchData,
        oddsLines,
        input.lg_home ?? undefined,
        input.lg_away ?? undefined,
    )

    let explanation: Explanation | null = null
    if (input.withExplanation && env.xkiroApiKey) {
        try {
            explanation = await generateExplanation(
                { home, away, league },
                matchData,
                result,
            )
        } catch (e) {
            console.error('[analyze] Bước C sinh giải thích gặp lỗi:', e)
        }
    }

    const record = await saveHistory(auth.userId, {
        meta: {
            home,
            away,
            league,
            kickoff: input.kickoff,
        },
        analysis: result,
        picks: result.picks,
        result: null,
        explanation,
    })

    return c.json({ result, recordId: record.id, explanation })
})

/** GET /api/live/match — lấy chỉ số thời gian thực từ SofaScore API */
dataApp.get('/live/match', async (c) => {
    const home = (c.req.query('home') || '').trim()
    const away = (c.req.query('away') || '').trim()
    const eventIdStr = c.req.query('eventId')
    const eventId = eventIdStr ? Number(eventIdStr) : undefined
    const data = await getMatchLiveStatus(home, away, eventId)
    return c.json(data)
})

/** POST /api/live/auto-settle — tự động đối soát kèo khi trận đấu kết thúc (FT) */
dataApp.post('/live/auto-settle', async (c) => {
    const auth = c.get('user')
    const body = await c.req.json().catch(() => null)
    const parsed = z
        .object({
            recordId: z.string().min(1),
            eventId: z.coerce.number().optional(),
            home: z.string().optional(),
            away: z.string().optional(),
        })
        .safeParse(body)
    if (!parsed.success) {
        return c.json({ error: 'validation', issues: parsed.error.flatten() }, 400)
    }
    const { recordId, eventId, home, away } = parsed.data
    const rec = await getHistoryItem(auth.userId, recordId)
    if (!rec) return c.json({ error: 'not_found' }, 404)

    const h = home || rec.meta.home
    const a = away || rec.meta.away
    const live = await getMatchLiveStatus(h, a, eventId)

    // Nếu trận đã kết thúc hoặc có điểm số FT chính thức
    const ftHome = live.periodScore?.ftHome ?? (live.isFinished ? live.score.home : undefined)
    const ftAway = live.periodScore?.ftAway ?? (live.isFinished ? live.score.away : undefined)

    if (ftHome === undefined || ftAway === undefined) {
        return c.json(
            {
                error: 'not_finished',
                message: 'Trận đấu chưa kết thúc (chưa có tỷ số FT chính thức).',
                live,
            },
            400,
        )
    }

    const settled = await settleHistory(auth.userId, recordId, {
        htHome: live.periodScore?.htHome ?? 0,
        htAway: live.periodScore?.htAway ?? 0,
        ftHome,
        ftAway,
        cornersHome: live.corners.home,
        cornersAway: live.corners.away,
        eventId: live.eventId,
    })

    if (!settled) return c.json({ error: 'settle_failed' }, 500)
    return c.json({ ok: true, item: settled.record, settledMatch: settled.settledMatch })
})

/** GET /api/settled — danh sách các trận đã settle lưu trong Upstash Redis */
dataApp.get('/settled', async (c) => {
    const limit = Math.min(200, Number.parseInt(c.req.query('limit') ?? '100', 10) || 100)
    const matches = await listSettledMatches(limit)
    return c.json({ matches })
})

/** POST /api/settle — nhập tỉ số thực tế cho một lượt phân tích. */
dataApp.post('/settle', async (c) => {
    const auth = c.get('user')
    const body = await c.req.json().catch(() => null)
    const parsed = z
        .object({
            id: z.string().min(1),
            htHome: z.coerce.number().int().min(0).max(30).optional(),
            htAway: z.coerce.number().int().min(0).max(30).optional(),
            ftHome: z.coerce.number().int().min(0).max(30),
            ftAway: z.coerce.number().int().min(0).max(30),
            cornersHome: z.coerce.number().int().min(0).max(100).optional(),
            cornersAway: z.coerce.number().int().min(0).max(100).optional(),
            eventId: z.coerce.number().optional(),
        })
        .safeParse(body)
    if (!parsed.success) {
        return c.json({ error: 'validation', issues: parsed.error.flatten() }, 400)
    }
    const { id, htHome, htAway, ftHome, ftAway, cornersHome, cornersAway, eventId } = parsed.data
    const res = await settleHistory(auth.userId, id, {
        htHome,
        htAway,
        ftHome,
        ftAway,
        cornersHome,
        cornersAway,
        eventId,
    })
    if (!res) return c.json({ error: 'not_found' }, 404)
    return c.json({ item: res.record, settledMatch: res.settledMatch })
})

/** GET /api/stats — hiệu suất + calibration. */
dataApp.get('/stats', async (c) => {
    const auth = c.get('user')
    const stats = await computeStats(auth.userId)
    return c.json(stats)
})