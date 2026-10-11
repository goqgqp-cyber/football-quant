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

/** Trả về giá trị đầu tiên không rỗng trong danh sách tên biến (nhận nhiều alias). */
function firstOf(names: string[], fallback = ''): string {
    for (const n of names) {
        const v = process.env[n]
        if (v) return v
    }
    return fallback
}

/**
 * URL REST phải là http(s)://. `KV_URL`/`REDIS_URL` là chuỗi TCP `rediss://`
 * nên KHÔNG dùng được với client REST — chỉ nhận khi đúng dạng http(s).
 */
function firstHttpUrl(names: string[], fallback = ''): string {
    for (const n of names) {
        const v = process.env[n]
        if (v && /^https?:\/\//i.test(v)) return v
    }
    return fallback
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

    /**
     * Redis REST URL/TOKEN — chấp nhận nhiều tên để deploy không phải đổi biến:
     * - Upstash:  UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
     * - Vercel KV: KV_REST_API_URL / KV_REST_API_TOKEN
     * - Một số biến hệ thống: KV_URL / REDIS_URL (chỉ là URL)
     * TOKEN phải là token GHI/XÓA; `KV_REST_API_READ_ONLY_TOKEN` không dùng được
     * vì app cần ghi history/session/settle. Thiếu thì server/redis.ts tự chuyển
     * sang store in-memory (chỉ hợp cho DEV).
     */
    upstashUrl: firstHttpUrl(
        ['UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL', 'KV_URL', 'REDIS_URL'],
        '',
    ),
    upstashToken: firstOf(
        ['UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN', 'REDIS_TOKEN'],
        '',
    ),

    adminEmail: optional('ADMIN_EMAIL', '').toLowerCase(),
    allowPublicSignup: bool('ALLOW_PUBLIC_SIGNUP', false),

    /** Nhận cả tên Google/Generative AI để linh hoạt khi deploy. */
    geminiApiKey: firstOf(
        ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
        '',
    ),
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
