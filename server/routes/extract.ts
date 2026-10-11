/**
 * POST /api/extract — đọc ảnh bảng kèo → JSON có confidence.
 *
 * Nhận 2 định dạng (đều yêu cầu đăng nhập + CSRF):
 * 1. application/json: { images: [{ mimeType, data(base64) }], home?, away?, league? }
 * 2. multipart/form-data: field `images` (1..4 file), kèm home/away/league tùy chọn
 *
 * Giới hạn: tối đa 4 ảnh, mỗi ảnh ≤ 8 MB, chỉ JPEG/PNG/WebP.
 * Kết quả luôn là gợi ý để NGƯỜI DÙNG xác nhận lại, không tự chạy phân tích.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { GeminiError, extractOddsFromImages, type ImageInput } from '../gemini.js'
import { requireAuth, type Vars } from '../middleware.js'

export const extractApp = new Hono<{ Variables: Vars }>()

extractApp.use('*', requireAuth)

const MAX_IMAGES = 4
const MAX_BYTES = 8 * 1024 * 1024 // 8 MB / ảnh
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp'])

const jsonSchema = z.object({
    images: z
        .array(
            z.object({
                mimeType: z.string().min(1).max(64),
                /** base64 thuần (không có tiền tố data:) */
                data: z.string().min(1),
            }),
        )
        .min(1)
        .max(MAX_IMAGES),
    home: z.string().max(80).optional(),
    away: z.string().max(80).optional(),
    league: z.string().max(80).optional(),
})

/** Ước lượng số byte của chuỗi base64. */
function base64Bytes(b64: string): number {
    const clean = b64.replace(/=+$/, '')
    return Math.floor((clean.length * 3) / 4)
}

function validateImages(images: ImageInput[]): string | null {
    if (images.length === 0) return 'Cần ít nhất 1 ảnh.'
    if (images.length > MAX_IMAGES) return `Tối đa ${MAX_IMAGES} ảnh.`
    for (const img of images) {
        if (!ALLOWED.has(img.mimeType)) return 'Chỉ nhận ảnh JPEG/PNG/WebP.'
        if (base64Bytes(img.data) > MAX_BYTES) return 'Mỗi ảnh tối đa 8 MB.'
    }
    return null
}

extractApp.post('/extract', async (c) => {
    const contentType = c.req.header('content-type') ?? ''
    let images: ImageInput[] = []
    let home: string | undefined
    let away: string | undefined
    let league: string | undefined

    try {
        if (contentType.includes('multipart/form-data')) {
            const form = await c.req.parseBody({ all: true })
            const rawFiles = form['images']
            const list = (Array.isArray(rawFiles) ? rawFiles : [rawFiles]).filter(
                (f): f is File => typeof f !== 'string' && f instanceof File,
            )
            if (list.length > MAX_IMAGES) return c.json({ error: 'too_many_images' }, 400)

            for (const file of list) {
                if (!ALLOWED.has(file.type)) {
                    return c.json({ error: 'bad_type', message: 'Chỉ nhận ảnh JPEG/PNG/WebP.' }, 400)
                }
                if (file.size > MAX_BYTES) {
                    return c.json({ error: 'too_large', message: 'Mỗi ảnh tối đa 8 MB.' }, 400)
                }
                const buf = Buffer.from(await file.arrayBuffer())
                images.push({ mimeType: file.type, data: buf.toString('base64') })
            }

            if (typeof form['home'] === 'string') home = form['home'].slice(0, 80)
            if (typeof form['away'] === 'string') away = form['away'].slice(0, 80)
            if (typeof form['league'] === 'string') league = form['league'].slice(0, 80)
        } else {
            const body = await c.req.json().catch(() => null)
            const parsed = jsonSchema.safeParse(body)
            if (!parsed.success) {
                return c.json({ error: 'validation', issues: parsed.error.flatten() }, 400)
            }
            images = parsed.data.images
            home = parsed.data.home
            away = parsed.data.away
            league = parsed.data.league
        }
    } catch {
        return c.json({ error: 'bad_request', message: 'Không đọc được dữ liệu gửi lên.' }, 400)
    }

    const invalid = validateImages(images)
    if (invalid) return c.json({ error: 'invalid_images', message: invalid }, 400)

    try {
        const result = await extractOddsFromImages(images, { home, away, league })
        return c.json(result)
    } catch (e) {
        if (e instanceof GeminiError) {
            return c.json({ error: 'gemini', message: e.message }, e.status as 400)
        }
        console.error('[extract]', e)
        return c.json({ error: 'internal', message: 'Trích xuất ảnh thất bại.' }, 500)
    }
})