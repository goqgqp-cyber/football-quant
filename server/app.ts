import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { env, missingRequired } from './env.js'
import { csrfProtect } from './middleware.js'
import { pingRedis, redisDiag } from './redis.js'
import { authApp, handleSignup } from './routes/auth.js'
import { adminApp } from './routes/admin.js'
import { dataApp } from './routes/data.js'
import { extractApp } from './routes/extract.js'
import { streamApp } from './routes/stream.js'
import { footballApp } from './routes/football.js'
import { ensureAdminUser } from './auth.js'

// Khởi tạo đảm bảo tài khoản admin luôn sẵn sàng
void ensureAdminUser().catch((e) => console.error('[admin] seed error', e))

/**
 * App API chính.
 * - Frontend KHÔNG BAO GIỜ gọi xKiro/Upstash trực tiếp — mọi khóa nằm ở server.
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

/**
 * Chốt cấu hình: nếu thiếu biến bắt buộc (vd `JWT_SECRET` trên Vercel) thì trả JSON
 * 500 kèm hướng dẫn — tránh chạy với secret rỗng (không an toàn) mà cũng không để
 * function crash im lặng thành "Lỗi 500" trống. `/api/health` được miễn trừ để còn
 * chẩn đoán được (nó liệt kê `missing`).
 */
app.use('/api/*', async (c, next) => {
    if (missingRequired.length > 0 && !c.req.path.startsWith('/api/health')) {
        return c.json(
            {
                error: 'config',
                message: `Máy chủ thiếu biến môi trường: ${missingRequired.join(', ')}. Thêm trên Vercel rồi redeploy.`,
                missing: missingRequired,
            },
            500,
        )
    }
    await next()
})

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

// CSRF cho mọi method ghi (trừ login/signup/register/refresh/logout — các route này tự xử lý)
app.use('*', async (c, next) => {
    const p = c.req.path
    if (
        p.includes('/auth/login') ||
        p.includes('/auth/signup') ||
        p.includes('/auth/register') ||
        p.includes('/auth/refresh') ||
        p.includes('/auth/logout') ||
        p.includes('/auth/csrf') ||
        p === '/api/login' ||
        p === '/api/signup' ||
        p === '/api/register'
    ) {
        return next()
    }
    return csrfProtect(c, next)
})

// ---- Routes ----
app.get('/api/health', async (c) => {
    const redisOk = await pingRedis()
    const base = {
        ok: true,
        redis: redisOk ? 'ok' : 'down',
        // Biến bắt buộc còn thiếu (vd `JWT_SECRET`) — hiển thị để chẩn đoán deploy.
        missing: missingRequired,
        time: new Date().toISOString(),
    }
    // `?deep=1` trả thêm chẩn đoán Redis kèm thông báo lỗi thật (không lộ token).
    if (c.req.query('deep') === '1') {
        const diag = await redisDiag()
        return c.json({ ...base, redisDiag: diag })
    }
    return c.json(base)
})

// Đích của rewrite trên Vercel — trả thông tin nhận diện thay vì 404
// (vercel.json rewrite `/api/(.*)` → `/api` nên request `/api` cũng phải có handler).
app.all('/api', (c) => c.json({ ok: true, service: 'football-quant-api' }))

// Auth routes: nhận cả /api/auth/* và /auth/* (nếu serverless tước tiền tố /api)
app.route('/api/auth', authApp)
app.route('/auth', authApp)
app.post('/api/signup', handleSignup)
app.post('/api/register', handleSignup)

app.route('/api', dataApp)
app.route('', dataApp)
app.route('/api', extractApp)
app.route('', extractApp)
app.route('/api', streamApp)
app.route('', streamApp)
app.route('/api/admin', adminApp)
app.route('/admin', adminApp)
app.route('/api/football', footballApp)
app.route('/football', footballApp)

app.notFound((c) => c.json({ error: 'not_found' }, 404))
app.onError((err, c) => {
    console.error('[api]', err)
    return c.json({ error: 'internal', message: 'Lỗi máy chủ.' }, 500)
})
