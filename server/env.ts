/**
 * Biến môi trường phía server.
 * TUYỆT ĐỐI không được import file này từ code frontend (src/).
 */

function required(name: string): string {
    const v = process.env[name]
    if (!v) {
        throw new Error(
            `Thiếu biến môi trường ${name}. Hãy copy .env.example thành .env và điền giá trị.`,
        )
    }
    return v
}

function optional(name: string, fallback: string): string {
    return process.env[name] || fallback
}

function bool(name: string, fallback: boolean): boolean {
    const v = process.env[name]
    if (v === undefined) return fallback
    return v === '1' || v.toLowerCase() === 'true'
}

function int(name: string, fallback: number): number {
    const v = process.env[name]
    if (!v) return fallback
    const n = Number.parseInt(v, 10)
    return Number.isFinite(n) ? n : fallback
}

export const env = {
    nodeEnv: optional('NODE_ENV', 'development'),
    port: int('PORT', 8787),

    jwtSecret: required('JWT_SECRET'),
    accessTtlSec: int('ACCESS_TTL_SEC', 15 * 60), // 15 phút
    refreshTtlSec: int('REFRESH_TTL_SEC', 30 * 24 * 60 * 60), // 30 ngày

    // Thiếu thì server/redis.ts tự chuyển sang store in-memory (chỉ hợp cho DEV).
    upstashUrl: optional('UPSTASH_REDIS_REST_URL', ''),
    upstashToken: optional('UPSTASH_REDIS_REST_TOKEN', ''),

    adminEmail: optional('ADMIN_EMAIL', '').toLowerCase(),
    allowPublicSignup: bool('ALLOW_PUBLIC_SIGNUP', false),

    geminiApiKey: optional('GEMINI_API_KEY', ''),
    geminiModel: optional('GEMINI_MODEL', 'gemini-flash-latest'),
    storeOriginalImages: bool('STORE_ORIGINAL_IMAGES', false),

    /** Origin frontend được phép gọi API (dùng cho CORS). */
    corsOrigins: optional('CORS_ORIGINS', 'http://localhost:5173')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),

    /** Chống brute-force: số lần sai tối đa trước khi khóa tài khoản. */
    maxLoginFails: int('MAX_LOGIN_FAILS', 5),
    loginLockSec: int('LOGIN_LOCK_SEC', 15 * 60),
} as const

export const isProd = env.nodeEnv === 'production'