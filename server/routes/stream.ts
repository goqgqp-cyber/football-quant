/**
 * POST /api/collect/stream — chạy Bước A (xKiro AI Engine)
 * rồi tính toán engine, phát tiến trình qua Server-Sent Events.
 *
 * Vì sao không dùng EventSource: EventSource không gửi được header
 * `x-csrf-token` và không dùng cookie POST body. Client dùng fetch() +
 * ReadableStream để đọc SSE — vẫn là text/event-stream chuẩn.
 *
 * Chuỗi sự kiện:
 *   event: step        → {"id":"collect","status":"active"}
 *   event: delta       → {"text":"..."}         (text thô AI phát ra, để UI thấy tiến trình)
 *   event: data        → {"matchData":{...}}    (dữ liệu nền đã chuẩn hoá + nguồn)
 *   event: explanation → {"explanation":{...}}  (Bước C: 4 phần + kiểm chứng số)
 *   event: result      → {"result":{...},"recordId":"..."}
 *   event: error       → {"message":"..."}
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { XKiroError, generateExplanation, sanitizeCleanText, streamCollectMatchData } from '../services/xkiro.js'
import { requireAuth, type Vars } from '../middleware.js'
import { saveHistory } from '../store.js'
import { analyzeMatch } from '../../src/lib/engine.js'
import type { Explanation, MatchData, OddsLine } from '../../src/lib/types.js'

export const streamApp = new Hono<{ Variables: Vars }>()

streamApp.use('*', requireAuth)

const oddsLineSchema = z
    .object({
        id: z.string().min(1).max(100),
        kind: z.enum(['totals', 'ah', 'corners']),
        side: z.enum(['over', 'under', 'home', 'away']),
        line: z.number(),
        odds: z.coerce.number().min(1.01).max(500),
    })
    .strip()

const collectSchema = z
    .object({
        home: z.string().min(1).max(80),
        away: z.string().min(1).max(80),
        league: z.string().max(80).optional().default(''),
        kickoff: z.string().max(64).nullable().optional().default(null),
        lg_home: z.coerce.number().positive().optional(),
        lg_away: z.coerce.number().positive().optional(),
        oddsLines: z.array(oddsLineSchema).max(60).default([]),
    })
    .strip()

streamApp.post('/collect/stream', async (c) => {
    const auth = c.get('user')
    const body = await c.req.json().catch(() => null)
    const parsed = collectSchema.safeParse(body)
    if (!parsed.success) {
        return c.json({ error: 'validation', issues: parsed.error.flatten() }, 400)
    }
    const input = parsed.data
    const userId = auth.userId

    // Làm sạch text đầu vào, loại bỏ hoàn toàn chuỗi base64 hoặc blob
    const home = sanitizeCleanText(input.home)
    const away = sanitizeCleanText(input.away)
    const league = sanitizeCleanText(input.league ?? '')

    return streamSSE(c, async (stream) => {
        const step = async (id: string, status: 'active' | 'done' | 'error') => {
            await stream.writeSSE({
                event: 'step',
                data: JSON.stringify({ id, status }),
            })
        }

        try {
            // ---- Bước A: phân tích định lượng & thu thập số liệu (xKiro) ----
            await step('collect', 'active')
            const matchData: MatchData = await streamCollectMatchData(
                {
                    home,
                    away,
                    league: league || undefined,
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

            // ---- Bước C: xKiro viết 4 phần, số do engine cấp qua token ----
            await step('explain', 'active')
            let explanation: Explanation | null = null
            try {
                explanation = await generateExplanation(
                    { home, away, league },
                    matchData,
                    result,
                    (chunk) => {
                        void stream.writeSSE({
                            event: 'delta',
                            data: JSON.stringify({ text: chunk }),
                        })
                    },
                )
                await stream.writeSSE({
                    event: 'explanation',
                    data: JSON.stringify({ explanation }),
                })
                await step('explain', 'done')
            } catch (e) {
                // Bước C lỗi KHÔNG được làm hỏng kết quả tính toán đã có
                console.error('[collect/stream] step C', e)
                await step('explain', 'error')
            }

            // ---- Lưu lịch sử (kèm giải thích nếu có) ----
            const record = await saveHistory(userId, {
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

            await stream.writeSSE({
                event: 'result',
                data: JSON.stringify({ result, recordId: record.id }),
            })
        } catch (e) {
            const message =
                e instanceof XKiroError
                    ? e.message
                    : e instanceof Error
                        ? e.message
                        : 'Lỗi không xác định khi phân tích.'
            console.error('[collect/stream]', e)
            await stream.writeSSE({ event: 'error', data: JSON.stringify({ message }) })
        }
    })
})