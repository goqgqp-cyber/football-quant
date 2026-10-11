import { Hono } from 'hono'
import { z } from 'zod'
import { requireAuth, type Vars } from '../middleware.js'
import { keys, redis } from '../redis.js'
import {
    computeStats,
    deleteHistory,
    getHistoryItem,
    listHistory,
    saveHistory,
    settleHistory,
} from '../store.js'
import { getUserById } from '../auth.js'
import { analyzeMatch, suggestedLines } from '../../src/lib/engine.js'
import { MOCK_MATCH_DATA } from '../../src/lib/mock.js'
import type { MatchData, OddsLine } from '../../src/lib/types.js'

export const dataApp = new Hono<{ Variables: Vars }>()

// Mọi route trong đây đều yêu cầu đăng nhập
dataApp.use('*', requireAuth)

const oddsLineSchema = z.object({
    id: z.string().min(1),
    kind: z.enum(['totals', 'ah']),
    side: z.enum(['over', 'under', 'home', 'away']),
    line: z.number(),
    odds: z.coerce.number().min(1.01).max(500),
})

const analyzeSchema = z.object({
    home: z.string().min(1).max(80),
    away: z.string().min(1).max(80),
    league: z.string().max(80).optional().default(''),
    kickoff: z.string().max(64).nullable().optional().default(null),
    lg_home: z.coerce.number().positive().optional(),
    lg_away: z.coerce.number().positive().optional(),
    oddsLines: z.array(oddsLineSchema).max(60).default([]),
    /** Dữ liệu nền (Bước A). Chưa có Gemini ở G2 nên có thể bỏ trống → dùng mock. */
    matchData: z.unknown().optional(),
})

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

    // G2 chưa có Bước A (Gemini). Nếu client không gửi matchData → dùng mock có nhãn rõ.
    const matchData = (input.matchData as MatchData | undefined) ?? MOCK_MATCH_DATA
    const oddsLines = input.oddsLines as OddsLine[]

    const result = analyzeMatch(
        matchData,
        oddsLines,
        input.lg_home ?? undefined,
        input.lg_away ?? undefined,
    )

    const record = await saveHistory(auth.userId, {
        meta: {
            home: input.home,
            away: input.away,
            league: input.league,
            kickoff: input.kickoff,
        },
        analysis: result,
        picks: result.picks,
        result: null,
    })

    return c.json({ result, recordId: record.id })
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
        })
        .safeParse(body)
    if (!parsed.success) {
        return c.json({ error: 'validation', issues: parsed.error.flatten() }, 400)
    }
    const { id, htHome, htAway, ftHome, ftAway } = parsed.data
    const row = await settleHistory(auth.userId, id, { htHome, htAway, ftHome, ftAway })
    if (!row) return c.json({ error: 'not_found' }, 404)
    return c.json({ item: row })
})

/** GET /api/stats — hiệu suất + calibration. */
dataApp.get('/stats', async (c) => {
    const auth = c.get('user')
    const stats = await computeStats(auth.userId)
    return c.json(stats)
})