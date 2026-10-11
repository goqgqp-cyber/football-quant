import { createHash, randomBytes, randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { SignJWT, jwtVerify } from 'jose'
import type { Context } from 'hono'
import { env, isProd } from './env.js'
import { keys, redis } from './redis.js'

// ---------------------------------------------------------------------------
// Kiểu dữ liệu
// ---------------------------------------------------------------------------

export interface UserRecord {
    userId: string
    email: string
    passwordHash: string
    role: 'user' | 'admin'
    createdAt: number
    bankroll: number
}

export interface SessionRecord {
    sessionId: string
    userId: string
    /** SHA-256 của refresh token — KHÔNG lưu bản gốc. */
    refreshHash: string
    createdAt: number
    expiresAt: number
    userAgent: string
    ip: string
}

export interface AuthUser {
    userId: string
    email: string
    role: 'user' | 'admin'
}

// ---------------------------------------------------------------------------
// JWT access token (15 phút)
// ---------------------------------------------------------------------------

const secret = new TextEncoder().encode(env.jwtSecret)

export async function signAccessToken(user: AuthUser): Promise<string> {
    return new SignJWT({ email: user.email, role: user.role })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(user.userId)
        .setIssuedAt()
        .setExpirationTime(`${env.accessTtlSec}s`)
        .sign(secret)
}

export async function verifyAccessToken(token: string): Promise<AuthUser | null> {
    try {
        const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] })
        if (!payload.sub || typeof payload.email !== 'string') return null
        return {
            userId: payload.sub,
            email: payload.email,
            role: payload.role === 'admin' ? 'admin' : 'user',
        }
    } catch {
        return null
    }
}

// ---------------------------------------------------------------------------
// Refresh token (opaque, random) — chỉ hash mới lưu vào Redis
// ---------------------------------------------------------------------------

export function newRefreshToken(): string {
    return randomBytes(48).toString('base64url')
}

export function hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex')
}

// ---------------------------------------------------------------------------
// Cookie HttpOnly
// ---------------------------------------------------------------------------

export const ACCESS_COOKIE = 'fq_at'
export const REFRESH_COOKIE = 'fq_rt'
export const CSRF_COOKIE = 'fq_csrf'
export const CSRF_HEADER = 'x-csrf-token'

interface CookieOpts {
    maxAge: number
    httpOnly: boolean
}

function baseCookie(name: string, value: string, o: CookieOpts): string {
    const parts = [
        `${name}=${value}`,
        'Path=/',
        `Max-Age=${o.maxAge}`,
        'SameSite=Lax',
        `HttpOnly=${o.httpOnly ? 'true' : 'false'}`,
    ]
    // Secure chỉ bật ở production (HTTPS) — ở local http sẽ bị trình duyệt chặn cookie
    if (isProd) parts.push('Secure')
    return parts.join('; ')
}

export function accessCookie(token: string): string {
    return baseCookie(ACCESS_COOKIE, token, {
        maxAge: env.accessTtlSec,
        httpOnly: true,
    })
}

export function refreshCookie(token: string): string {
    return baseCookie(REFRESH_COOKIE, token, {
        maxAge: env.refreshTtlSec,
        httpOnly: true,
    })
}

/** Cookie CSRF cố ý KHÔNG HttpOnly để JS đọc được rồi gửi lại qua header. */
export function csrfCookie(token: string): string {
    return baseCookie(CSRF_COOKIE, token, {
        maxAge: env.refreshTtlSec,
        httpOnly: false,
    })
}

export function clearAuthCookies(): string[] {
    const opts = 'Path=/; Max-Age=0; SameSite=Lax'
    const secure = isProd ? '; Secure' : ''
    return [
        `${ACCESS_COOKIE}=; ${opts}${secure}`,
        `${REFRESH_COOKIE}=; ${opts}${secure}`,
        `${CSRF_COOKIE}=; ${opts}${secure}`,
    ]
}

// ---------------------------------------------------------------------------
// Người dùng
// ---------------------------------------------------------------------------

export async function getUserByEmail(email: string): Promise<UserRecord | null> {
    const uid = await redis.get<string>(keys.userByEmail(email))
    if (!uid) return null
    return getUserById(uid)
}

export async function getUserById(userId: string): Promise<UserRecord | null> {
    return redis.get<UserRecord>(keys.user(userId))
}

export async function createUser(
    email: string,
    password: string,
    role: 'user' | 'admin' = 'user',
): Promise<UserRecord> {
    const normalized = email.trim().toLowerCase()
    const userId = `u_${randomUUID()}`
    const passwordHash = await bcrypt.hash(password, 12)
    const user: UserRecord = {
        userId,
        email: normalized,
        passwordHash,
        role,
        createdAt: Date.now(),
        bankroll: 0,
    }
    // Ghi user trước, rồi tạo chỉ mục email → uid
    await redis.set(keys.user(userId), user)
    await redis.set(keys.userByEmail(normalized), userId)
    return user
}

export function verifyPassword(user: UserRecord, password: string): Promise<boolean> {
    return bcrypt.compare(password, user.passwordHash)
}

// ---------------------------------------------------------------------------
// Phiên (session) — refresh rotation + phát hiện reuse
// ---------------------------------------------------------------------------

export async function createSession(
    userId: string,
    refreshRaw: string,
    ctx: Context,
): Promise<SessionRecord> {
    const sessionId = randomUUID()
    const now = Date.now()
    const session: SessionRecord = {
        sessionId,
        userId,
        refreshHash: hashToken(refreshRaw),
        createdAt: now,
        expiresAt: now + env.refreshTtlSec * 1000,
        userAgent: ctx.req.header('user-agent')?.slice(0, 200) ?? '',
        ip:
            ctx.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
            ctx.req.header('x-real-ip') ??
            '',
    }
    await redis.set(keys.session(userId, sessionId), session, {
        ex: env.refreshTtlSec,
    })
    await redis.sadd(keys.sessionSet(userId), sessionId)
    await redis.expire(keys.sessionSet(userId), env.refreshTtlSec)
    return session
}

export async function getSession(
    userId: string,
    sessionId: string,
): Promise<SessionRecord | null> {
    return redis.get<SessionRecord>(keys.session(userId, sessionId))
}

export type RefreshOutcome =
    | { ok: true; user: AuthUser }
    | { ok: false; reason: 'invalid' | 'expired' | 'reuse' }

/**
 * Xác thực refresh token và XOAY VÒ (rotation).
 *
 * - Token lạ / không tìm thấy phiên → 'invalid'
 * - Token đã từng được dùng (nằm trong refresh_used) → 'reuse':
 *     đây là dấu hiệu bị đánh cắp cookie, ta thu hồi TOÀN BỘ phiên của user.
 * - Hash không khớp → 'reuse' (giả mạo).
 */
export async function rotateSession(
    userId: string,
    sessionId: string,
    presentedRaw: string,
): Promise<RefreshOutcome> {
    const session = await getSession(userId, sessionId)
    if (!session) return { ok: false, reason: 'invalid' }

    if (Date.now() > session.expiresAt) {
        await destroySession(userId, sessionId)
        return { ok: false, reason: 'expired' }
    }

    // Đã dùng rồi → reuse detection
    const used = await redis.get<string>(keys.refreshUsed(userId, sessionId))
    if (used) {
        await revokeAllSessions(userId)
        return { ok: false, reason: 'reuse' }
    }

    if (hashToken(presentedRaw) !== session.refreshHash) {
        await revokeAllSessions(userId)
        return { ok: false, reason: 'reuse' }
    }

    const user = await getUserById(userId)
    if (!user) return { ok: false, reason: 'invalid' }

    // Ghi dấu token cũ đã dùng, rồi cấp token mới cho cùng sessionId
    await redis.set(keys.refreshUsed(userId, sessionId), '1', {
        ex: Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000)),
    })

    return {
        ok: true,
        user: { userId: user.userId, email: user.email, role: user.role },
    }
}

export async function updateSessionHash(
    userId: string,
    sessionId: string,
    refreshRaw: string,
    session: SessionRecord,
): Promise<void> {
    const next: SessionRecord = {
        ...session,
        refreshHash: hashToken(refreshRaw),
    }
    await redis.set(keys.session(userId, sessionId), next, {
        ex: Math.max(1, Math.floor((next.expiresAt - Date.now()) / 1000)),
    })
}

export async function destroySession(userId: string, sessionId: string): Promise<void> {
    await redis.del(keys.session(userId, sessionId))
    await redis.srem(keys.sessionSet(userId), sessionId)
}

export async function revokeAllSessions(userId: string): Promise<void> {
    const ids = await redis.smembers<string[]>(keys.sessionSet(userId))
    if (ids.length) {
        await redis.del(...ids.map((id) => keys.session(userId, id)))
    }
    await redis.del(keys.sessionSet(userId))
}

// ---------------------------------------------------------------------------
// Chống brute-force
// ---------------------------------------------------------------------------

export async function isLocked(email: string): Promise<boolean> {
    const n = await redis.get<number>(keys.loginFails(email))
    return typeof n === 'number' && n >= env.maxLoginFails
}

export async function recordFail(email: string): Promise<number> {
    const key = keys.loginFails(email)
    const n = (await redis.get<number>(key)) ?? 0
    const next = n + 1
    await redis.set(key, next, { ex: env.loginLockSec })
    return next
}

export async function clearFails(email: string): Promise<void> {
    await redis.del(keys.loginFails(email))
}