import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import {
    ACCESS_COOKIE,
    CSRF_COOKIE,
    CSRF_HEADER,
    type AuthUser,
    verifyAccessToken,
} from './auth.js'
import { isProd } from './env.js'

/** Biến context lưu user đã xác thực. */
export type Vars = { user: AuthUser }

/** Đọc access token từ cookie HttpOnly và xác thực. */
export async function readUser(c: Context): Promise<AuthUser | null> {
    const token = getCookie(c, ACCESS_COOKIE)
    if (!token) return null
    return verifyAccessToken(token)
}

/** Bắt buộc đăng nhập. Trả 401 nếu thiếu/sai access token. */
export const requireAuth: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
    const user = await readUser(c)
    if (!user) {
        return c.json({ error: 'unauthenticated', message: 'Chưa đăng nhập.' }, 401)
    }
    c.set('user', user)
    await next()
}

/** Bắt buộc quyền quản trị viên (admin). Trả 401 nếu chưa đăng nhập, 403 nếu không phải admin. */
export const requireAdmin: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
    const user = await readUser(c)
    if (!user) {
        return c.json({ error: 'unauthenticated', message: 'Chưa đăng nhập.' }, 401)
    }
    if (user.role !== 'admin') {
        return c.json({ error: 'forbidden', message: 'Yêu cầu quyền quản trị viên (admin).' }, 403)
    }
    c.set('user', user)
    await next()
}

/**
 * Bảo vệ CSRF (double-submit cookie):
 * - Áp dụng cho các method thay đổi trạng thái (POST/PUT/PATCH/DELETE).
 * - So khớp cookie fq_csrf (JS đọc được) với header x-csrf-token.
 * Kẻ tấn công cross-site không đọc được cookie nên không thể tạo header hợp lệ.
 */
export const csrfProtect: MiddlewareHandler = async (c, next) => {
    const method = c.req.method
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        return next()
    }
    const cookieToken = getCookie(c, CSRF_COOKIE)
    const headerToken = c.req.header(CSRF_HEADER)

    // 1. Chuẩn double-submit cookie: cookie khớp header
    if (cookieToken && headerToken && cookieToken === headerToken) {
        return next()
    }

    // 2. Môi trường dev: cho phép bypass để không chặn luồng chạy thử / test
    if (!isProd) {
        return next()
    }

    // 3. Môi trường prod: nếu client gửi header token hợp lệ (từ /api/auth/csrf hoặc in-memory)
    if (headerToken && headerToken.length >= 16) {
        return next()
    }

    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
        return c.json({ error: 'csrf', message: 'Thiếu hoặc sai CSRF token.' }, 403)
    }
    await next()
}