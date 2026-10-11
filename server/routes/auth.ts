import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { getCookie } from 'hono/cookie'
import { env } from '../env.js'
import {
    ACCESS_COOKIE,
    CSRF_COOKIE,
    REFRESH_COOKIE,
    accessCookie,
    clearAuthCookies,
    clearFails,
    createSession,
    createUser,
    csrfCookie,
    destroySession,
    getSession,
    getUserByEmail,
    isLocked,
    newRefreshToken,
    recordFail,
    refreshCookie,
    revokeAllSessions,
    rotateSession,
    signAccessToken,
    updateSessionHash,
    verifyPassword,
    type AuthUser,
} from '../auth.js'

const emailSchema = z.string().trim().toLowerCase().email().max(120)
const passwordSchema = z.string().min(8).max(128)

const signupSchema = z.object({ email: emailSchema, password: passwordSchema })
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) })

export const authApp = new Hono()

/** Cookie refresh chứa base64url của `userId.sessionId.refreshRaw`. */
function encodeSession(userId: string, sessionId: string, refreshRaw: string): string {
    return Buffer.from(`${userId}.${sessionId}.${refreshRaw}`, 'utf8').toString('base64url')
}

export function decodeSession(cookieValue: string | undefined): {
    userId: string
    sessionId: string
    refreshRaw: string
} | null {
    if (!cookieValue) return null
    try {
        const decoded = Buffer.from(cookieValue, 'base64url').toString('utf8')
        const first = decoded.indexOf('.')
        const second = decoded.indexOf('.', first + 1)
        if (first < 0 || second < 0) return null
        return {
            userId: decoded.slice(0, first),
            sessionId: decoded.slice(first + 1, second),
            refreshRaw: decoded.slice(second + 1),
        }
    } catch {
        return null
    }
}

/** Cấp access token + refresh token (rotation mới) + CSRF, ghi 3 cookie. */
async function issueSession(c: Context, user: AuthUser): Promise<string> {
    const access = await signAccessToken(user)
    const refresh = newRefreshToken()
    const session = await createSession(user.userId, refresh, c)
    const csrf = randomBytes(32).toString('base64url')

    c.header('Set-Cookie', accessCookie(access), { append: true })
    c.header(
        'Set-Cookie',
        refreshCookie(encodeSession(user.userId, session.sessionId, refresh)),
        { append: true },
    )
    c.header('Set-Cookie', csrfCookie(csrf), { append: true })
    return csrf
}

/** POST /api/auth/signup */
authApp.post('/signup', async (c) => {
    const body = await c.req.json().catch(() => null)
    const parsed = signupSchema.safeParse(body)
    if (!parsed.success) {
        return c.json({ error: 'validation', issues: parsed.error.flatten() }, 400)
    }
    const { email, password } = parsed.data

    if (await getUserByEmail(email)) {
        return c.json({ error: 'exists', message: 'Email đã được dùng.' }, 409)
    }

    const isAdmin = env.adminEmail !== '' && email === env.adminEmail
    if (!env.allowPublicSignup && !isAdmin) {
        return c.json({ error: 'forbidden', message: 'Đăng ký công khai đang tắt.' }, 403)
    }

    const user = await createUser(email, password, isAdmin ? 'admin' : 'user')
    const csrfToken = await issueSession(c, {
        userId: user.userId,
        email: user.email,
        role: user.role,
    })
    return c.json(
        {
            user: { userId: user.userId, email: user.email, role: user.role },
            csrfToken,
        },
        201,
    )
})

/** POST /api/auth/login */
authApp.post('/login', async (c) => {
    const body = await c.req.json().catch(() => null)
    const parsed = loginSchema.safeParse(body)
    if (!parsed.success) {
        return c.json({ error: 'validation', issues: parsed.error.flatten() }, 400)
    }
    const { email, password } = parsed.data

    if (await isLocked(email)) {
        return c.json(
            {
                error: 'locked',
                message: `Sai quá ${env.maxLoginFails} lần. Thử lại sau ${Math.round(env.loginLockSec / 60)} phút.`,
            },
            429,
        )
    }

    const user = await getUserByEmail(email)
    if (!user || !(await verifyPassword(user, password))) {
        const fails = await recordFail(email)
        const left = Math.max(0, env.maxLoginFails - fails)
        return c.json(
            { error: 'invalid', message: `Sai email hoặc mật khẩu. Còn ${left} lần thử.` },
            401,
        )
    }

    await clearFails(email)
    const csrfToken = await issueSession(c, {
        userId: user.userId,
        email: user.email,
        role: user.role,
    })
    return c.json({
        user: { userId: user.userId, email: user.email, role: user.role },
        csrfToken,
    })
})

/** POST /api/auth/refresh — đọc refresh token từ cookie, xoay vòng. */
authApp.post('/refresh', async (c) => {
    const sess = decodeSession(getCookie(c, REFRESH_COOKIE))
    if (!sess) {
        return c.json({ error: 'invalid', message: 'Refresh token không hợp lệ.' }, 401)
    }

    const outcome = await rotateSession(sess.userId, sess.sessionId, sess.refreshRaw)
    if (!outcome.ok) {
        for (const h of clearAuthCookies()) c.header('Set-Cookie', h, { append: true })
        return c.json(
            {
                error: outcome.reason,
                message:
                    outcome.reason === 'reuse'
                        ? 'Phiên bị thu hồi vì phát hiện dùng lại token. Hãy đăng nhập lại.'
                        : 'Phiên đã hết hạn. Hãy đăng nhập lại.',
            },
            outcome.reason === 'reuse' ? 403 : 401,
        )
    }

    const session = await getSession(sess.userId, sess.sessionId)
    if (!session) {
        for (const h of clearAuthCookies()) c.header('Set-Cookie', h, { append: true })
        return c.json({ error: 'invalid', message: 'Phiên không tồn tại.' }, 401)
    }

    const access = await signAccessToken(outcome.user)
    const nextRefresh = newRefreshToken()
    await updateSessionHash(sess.userId, sess.sessionId, nextRefresh, session)
    const csrf = randomBytes(32).toString('base64url')

    c.header('Set-Cookie', accessCookie(access), { append: true })
    c.header(
        'Set-Cookie',
        refreshCookie(encodeSession(sess.userId, sess.sessionId, nextRefresh)),
        { append: true },
    )
    c.header('Set-Cookie', csrfCookie(csrf), { append: true })
    return c.json({ user: outcome.user, csrfToken: csrf })
})

/** POST /api/auth/logout — hủy phiên hiện tại. */
authApp.post('/logout', async (c) => {
    const sess = decodeSession(getCookie(c, REFRESH_COOKIE))
    if (sess) await destroySession(sess.userId, sess.sessionId)
    for (const h of clearAuthCookies()) c.header('Set-Cookie', h, { append: true })
    return c.json({ ok: true })
})

/** POST /api/auth/logout-all — thu hồi mọi phiên (mọi thiết bị). */
authApp.post('/logout-all', async (c) => {
    const sess = decodeSession(getCookie(c, REFRESH_COOKIE))
    if (sess) await revokeAllSessions(sess.userId)
    for (const h of clearAuthCookies()) c.header('Set-Cookie', h, { append: true })
    return c.json({ ok: true })
})

/** GET /api/auth/csrf — cấp CSRF token cho client (trước login/signup). */
authApp.get('/csrf', async (c) => {
    const token = randomBytes(32).toString('base64url')
    c.header('Set-Cookie', csrfCookie(token), { append: true })
    return c.json({ csrfToken: token })
})

export { ACCESS_COOKIE, REFRESH_COOKIE, CSRF_COOKIE }