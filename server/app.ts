import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { env } from './env.js'
import { csrfProtect } from './middleware.js'
import { pingRedis } from './redis.js'
import { authApp } from './routes/auth.js'
import { dataApp } from './routes/data.js'

/**
 * App API chính.
 * - Frontend KHÔNG BAO GIỜ gọi Gemini/Upstash trực tiếp — mọi khóa nằm ở server.
 * - Auth dùng cookie HttpOnly (fq_at, fq_rt) + double-submit CSRF cho các method ghi.
 */
export const app = new Hono()

app.use(
    '*',
    cors({
        origin: (origin) => {
            if (!origin) return origin
            return env.corsOrigins.includes(origin) ? origin : null
        },
        credentials: true,
        allowHeaders: ['Content-Type', 'x-csrf-token'],
        allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
)

// Rate-limit thô theo IP (chống spam/burst) — ghi nhớ trong bộ nhớ process
const hits = new Map<string, { n: number; resetAt: number }>()
const WINDOW_MS = 60_000
const LIMIT_PER_MIN = 240
app.use('*', async (c, next) => {
    const ip =
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? 'local'
    const now = Date.now()
    const rec = hits.get(ip)
    if (!rec || now > rec.resetAt) {
        hits.set(ip, { n: 1, resetAt: now + WINDOW_MS })
    } else {
        rec.n += 1
        if (rec.n > LIMIT_PER_MIN) {
            return c.json({ error: 'rate_limited', message: 'Quá nhiều yêu cầu. Thử lại sau.' }, 429)
        }
    }
    await next()
})

// CSRF cho mọi method ghi (trừ login/signup/refresh/logout — các route này tự xử lý)
app.use('/api/*', async (c, next) => {
    const p = c.req.path
    if (
        p.startsWith('/api/auth/login') ||
        p.startsWith('/api/auth/signup') ||
        p.startsWith('/api/auth/refresh') ||
        p.startsWith('/api/auth/logout') ||
        p.startsWith('/api/auth/csrf')
    ) {
        return next()
    }
    return csrfProtect(c, next)
})

// ---- Routes ----
app.get('/api/health', async (c) => {
    const redisOk = await pingRedis()
    return c.json({ ok: true, redis: redisOk ? 'ok' : 'down', time: new Date().toISOString() })
})

app.route('/api/auth', authApp)
app.route('/api', dataApp)

app.notFound((c) => c.json({ error: 'not_found' }, 404))
app.onError((err, c) => {
    console.error('[api]', err)
    return c.json({ error: 'internal', message: 'Lỗi máy chủ.' }, 500)
})