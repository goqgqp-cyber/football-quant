/**
 * POST /api/collect/stream — chạy Bước A (Gemini + Google Search grounding)
 * rồi tính toán engine, phát tiến trình qua Server-Sent Events.
 *
 * Vì sao không dùng EventSource: EventSource không gửi được header
 * `x-csrf-token` và không dùng cookie POST body. Client dùng fetch() +
 * ReadableStream để đọc SSE — vẫn là text/event-stream chuẩn.
 *
 * Chuỗi sự kiện:
 *   event: step   → {"id":"collect","status":"active"}
 *   event: delta  → {"text":"..."}        (text thô Gemini phát ra, để UI thấy tiến trình)
 *   event: data   → {"matchData":{...}}   (dữ liệu nền đã chuẩn hoá + nguồn)
 *   event: result → {"result":{...},"recordId":"..."}
 *   event: error  → {"message":"..."}
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { GeminiError, streamCollectMatchData } from '../gemini.js'
import { requireAuth, type Vars } from '../middleware.js'
import { saveHistory } from '../store.js'
import { analyzeMatch } from '../../src/lib/engine.js'
import type { MatchData, OddsLine } from '../../src/lib/types.js'

export const streamApp = new Hono<{ Variables: Vars }>()

streamApp.use('*', requireAuth)

const oddsLineSchema = z.object({
    id: z.string().min(1),
    kind: z.enum(['totals', 'ah']),
    side: z.enum(['over', 'under', 'home', 'away']),
    line: z.number(),
    odds: z.coerce.number().min(1.01).max(500),
})

const collectSchema = z.object({
    home: z.string().min(1).max(80),
    away: z.string().min(1).max(80),
    league: z.string().max(80).optional().default(''),
    kickoff: z.string().max(64).nullable().optional().default(null),
    lg_home: z.coerce.number().positive().optional(),
    lg_away: z.coerce.number().positive().optional(),
    oddsLines: z.array(oddsLineSchema).max(60).default([]),
})

streamApp.post('/collect/stream', async (c) => {
    const auth = c.get('user')
    const body = await c.req.json().catch(() => null)
    const parsed = collectSchema.safeParse(body)
    if (!parsed.success) {
        return c.json({ error: 'validation', issues: parsed.error.flatten() }, 400)
    }
    const input = parsed.data
    const userId = auth.userId

    return streamSSE(c, async (stream) => {
        const step = async (id: string, status: 'active' | 'done' | 'error') => {
            await stream.writeSSE({
                event: 'step',
                data: JSON.stringify({ id, status }),
            })
        }

        try {
            // ---- Bước A: thu thập dữ liệu nền (Gemini + grounding) ----
            await step('collect', 'active')
            const matchData: MatchData = await streamCollectMatchData(
                {
                    home: input.home,
                    away: input.away,
                    league: input.league || undefined,
                    kickoff: input.kickoff,
                },
                (chunk) => {
                    // Không chờ: delta chỉ để UI thấy có tiến trình
                    void stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: chunk }) })
                },
            )
            await stream.writeSSE({
                event: 'data',
                data: JSON.stringify({ matchData }),
            })
            await step('collect', 'done')

            // ---- Trích xuất số liệu: client đã xác nhận odds ở G3 ----
            await step('extract', 'active')
            await step('extract', 'done')

            // ---- Tính toán engine thuần TS (không LLM) ----
            await step('compute', 'active')
            const result = analyzeMatch(
                matchData,
                input.oddsLines as OddsLine[],
                input.lg_home ?? undefined,
                input.lg_away ?? undefined,
            )
            await step('compute', 'done')

            // ---- Lưu lịch sử ----
            const record = await saveHistory(userId, {
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

            // ---- Giải thích: G5 sẽ thay bằng Gemini viết văn ----
            await step('explain', 'active')
            await step('explain', 'done')

            await stream.writeSSE({
                event: 'result',
                data: JSON.stringify({ result, recordId: record.id }),
            })
        } catch (e) {
            const message =
                e instanceof GeminiError
                    ? e.message
                    : e instanceof Error
                        ? e.message
                        : 'Lỗi không xác định khi phân tích.'
            console.error('[collect/stream]', e)
            await stream.writeSSE({ event: 'error', data: JSON.stringify({ message }) })
        }
    })
})