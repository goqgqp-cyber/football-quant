/**
 * Entry cho Vercel Serverless Function (runtime NODE, không phải Edge).
 * --------------------------------------------------------------------------
 * Vercel Node runtime gọi handler bằng `(req: IncomingMessage, res: ServerResponse)`
 * — KHÔNG phải Web `Request`/`Response`. Vì vậy `hono/vercel` (adapter Edge) sẽ
 * crash với lỗi `this.raw.headers.get is not a function`.
 *
 * Ở đây tự chuyển đổi:
 *   IncomingMessage  → Web Request   (method, url, headers, body)
 *   Web Response     → ServerResponse(status, headers, body)
 *
 * Body được STREAM từng chunk về `res` để endpoint SSE
 * (`/api/collect/stream`) vẫn đẩy dữ liệu về client theo thời gian thực.
 */
import './dotenv.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { app } from './app.js'

export const maxDuration = 60; // Extend Vercel serverless timeout to 60s
export const dynamic = 'force-dynamic';

/** Đọc toàn bộ body của request Node thành Buffer (rỗng với GET/HEAD). */
async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
    const method = (req.method ?? 'GET').toUpperCase()
    if (method === 'GET' || method === 'HEAD') return undefined
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    return chunks.length > 0 ? Buffer.concat(chunks) : undefined
}

/** Dựng URL tuyệt đối từ request Node (Vercel luôn có x-forwarded-*). */
function buildUrl(req: IncomingMessage): string {
    const host = (req.headers['x-forwarded-host'] as string) ?? req.headers.host ?? 'localhost'
    const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https'

    // Ưu tiên x-matched-path hoặc x-invoke-path nếu có trên Vercel
    const matchedPath = (req.headers['x-matched-path'] as string) || (req.headers['x-invoke-path'] as string)
    let rawUrl = (matchedPath && !matchedPath.includes('[...route]')) ? matchedPath : (req.url ?? '/')

    // Nếu Vercel rewrite biến rawUrl thành chứa [...route], khôi phục lại route gốc từ query param
    if (rawUrl.includes('[...route]')) {
        try {
            const parsed = new URL(rawUrl, `${proto}://${host}`)
            const routeParam = parsed.searchParams.get('route')
            if (routeParam) {
                parsed.searchParams.delete('route')
                const search = parsed.searchParams.toString()
                rawUrl = `/api/${routeParam}${search ? `?${search}` : ''}`
            }
        } catch {
            // fallback
        }
    }

    // Nếu runtime Serverless của Vercel tước bỏ tiền tố '/api' khi gọi function trong thư mục api/,
    // tự động bù lại để Hono định tuyến chính xác các route /api/*.
    if (!rawUrl.startsWith('/api/') && rawUrl !== '/api') {
        rawUrl = '/api' + (rawUrl.startsWith('/') ? rawUrl : '/' + rawUrl)
    }
    return `${proto}://${host}${rawUrl}`
}

/** Chuyển header Node (có thể là mảng) sang Web Headers. */
function toHeaders(req: IncomingMessage): Headers {
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue
        if (Array.isArray(value)) {
            for (const v of value) headers.append(key, v)
        } else {
            headers.set(key, value)
        }
    }
    return headers
}

/** Lấy danh sách Set-Cookie (giữ được NHIỀU cookie, vd fq_at + fq_rt + fq_csrf). */
function getSetCookies(res: Response): string[] {
    const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] }
    if (typeof anyHeaders.getSetCookie === 'function') return anyHeaders.getSetCookie()
    const single = res.headers.get('set-cookie')
    return single ? [single] : []
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
        const body = await readBody(req)
        const request = new Request(buildUrl(req), {
            method: req.method,
            headers: toHeaders(req),
            body: body ? new Uint8Array(body) : undefined,
            redirect: 'manual',
        })

        const response = await app.fetch(request)

        res.statusCode = response.status

        response.headers.forEach((value, key) => {
            // set-cookie xử lý riêng bên dưới để không bị gộp thành 1 dòng
            if (key.toLowerCase() === 'set-cookie') return
            res.setHeader(key, value)
        })

        const cookies = getSetCookies(response)
        if (cookies.length > 0) res.setHeader('set-cookie', cookies)

        // Stream body (hỗ trợ SSE); không có body thì kết thúc ngay.
        if (response.body) {
            const reader = response.body.getReader()
            for (; ;) {
                const { done, value } = await reader.read()
                if (done) break
                if (value) res.write(Buffer.from(value))
            }
        }
        res.end()
    } catch (err) {
        console.error('[api] handler error', err)
        if (!res.headersSent) {
            res.statusCode = 500
            res.setHeader('content-type', 'application/json; charset=utf-8')
        }
        res.end(JSON.stringify({ error: 'internal', message: 'Lỗi máy chủ.' }))
    }
}
