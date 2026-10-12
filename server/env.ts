/**
 * Bien moi truong phia server.
 * TUYET DOI khong duoc import file nay tu code frontend (src/).
 */

function optional(name: string, fallback: string): string {
    return (process.env[name] || fallback).trim()
}

function cleanKey(val: string): string {
    return val
        .trim()
        .replace(/^['"]+|['"]+$/g, '')
        .replace(/^[-*•\s]+/, '')
        .trim()
}

/**
 * Tra ve gia tri dau tien khong rong trong danh sach ten bien (nhan nhieu alias).
 * Luon cleanKey de tranh trailing whitespace/newline hoac dau gach noi markdown "- "
 * gay HTTP 401/403 khi gui request len cac API ben ngoai.
 */
function firstOf(names: string[], fallback = ''): string {
    for (const n of names) {
        const v = process.env[n]
        if (v !== undefined) {
            const cleaned = cleanKey(v)
            if (cleaned) return cleaned
        }
    }
    return cleanKey(fallback)
}

/**
 * URL REST phai la http(s)://. `KV_URL`/`REDIS_URL` la chuoi TCP `rediss://`
 * nen KHONG dung duoc voi client REST - chi nhan khi dung dang http(s).
 */
function firstHttpUrl(names: string[], fallback = ''): string {
    for (const n of names) {
        const v = process.env[n]?.trim()
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

let runtimeAllowPublicSignup = bool('ALLOW_PUBLIC_SIGNUP', false)

export const env = {
    nodeEnv: optional('NODE_ENV', 'development'),
    port: int('PORT', 8787),

    /**
     * Khong dung `required()` o day: neu thieu, viec nem loi ngay luc import
     * se lam ca function Vercel crash => client chi thay "Loi 500" vo nghia.
     * Thay vao do de rong roi bao loi cau hinh ro rang o `missingRequired`.
     */
    jwtSecret: optional('JWT_SECRET', ''),
    accessTtlSec: int('ACCESS_TTL_SEC', 15 * 60), // 15 phut
    refreshTtlSec: int('REFRESH_TTL_SEC', 30 * 24 * 60 * 60), // 30 ngay

    /**
     * Redis REST URL/TOKEN - chap nhan nhieu ten de deploy khong phai doi bien:
     * - Upstash:   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
     * - Vercel KV: KV_REST_API_URL / KV_REST_API_TOKEN
     * - He thong:  KV_URL / REDIS_URL (chi la URL)
     */
    upstashUrl: firstHttpUrl(
        ['UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL', 'KV_URL', 'REDIS_URL'],
        '',
    ),
    upstashToken: firstOf(
        ['UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN', 'REDIS_TOKEN'],
        '',
    ),

    adminEmail: optional('ADMIN_EMAIL', 'admin@footballquant.local').toLowerCase(),
    get allowPublicSignup() {
        return runtimeAllowPublicSignup
    },
    setAllowPublicSignup(val: boolean) {
        runtimeAllowPublicSignup = val
    },

    /**
     * xKiro API - Chuan OpenAI format (Qwen 3.8 Max).
     * Fallback hardcoded chi dung cho moi truong dev cuc bo chua set bien.
     * Tren Vercel Production: set XKIRO_API_KEY trong Environment Variables.
     */
    xkiroApiKey: firstOf(
        ['XKIRO_API_KEY'],
        'sk-xl-589f55ae70854e45cae40b670eca7e0eef5d895e60fc903e',
    ),
    xkiroBaseUrl: firstOf(
        ['XKIRO_BASE_URL'],
        'https://api.xkiro.com/v1',
    ),
    xkiroModel: firstOf(
        ['XKIRO_MODEL'],
        'qwen/qwen3.8-max:free',
    ),

    /**
     * API-Football (v3.football.api-sports.io / api-football.com)
     * Header: x-apisports-key
     */
    apiFootballKey: firstOf(
        ['API_FOOTBALL_KEY', 'API_SPORTS_KEY', 'VITE_API_FOOTBALL_KEY', 'NEXT_PUBLIC_API_FOOTBALL_KEY'],
        '',
    ),

    /**
     * Multi-Tier Search Failover Credentials (Serper -> Tavily -> Brave -> DuckDuckGo)
     */
    serperApiKey: firstOf(
        ['SERPER_API_KEY'],
        '42d9837058349ec9886c385e717ee13b49a33610',
    ),
    tavilyApiKey: firstOf(
        ['TAVILY_API_KEY'],
        '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',
    ),
    braveApiKey: firstOf(
        ['BRAVE_SEARCH_API_KEY', 'BRAVE_API_KEY'],
        'BSARDBF9RQ1mIP3PQN7X1LfQ5jzGG_x',
    ),


    storeOriginalImages: bool('STORE_ORIGINAL_IMAGES', false),

    /** Origin frontend duoc phep goi API (dung cho CORS). */
    corsOrigins: optional('CORS_ORIGINS', 'http://localhost:5173')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),

    /** Chong brute-force */
    maxLoginFails: int('MAX_LOGIN_FAILS', 5),
    loginLockSec: int('LOGIN_LOCK_SEC', 15 * 60),
} as const

export const isProd = env.nodeEnv === 'production'

/**
 * Cac bien bat buoc con thieu. Middleware trong `app.ts` dung danh sach nay de
 * tra JSON 500 kem huong dan thay vi de function chet luc khoi dong.
 */
export const missingRequired: string[] = []
if (!env.jwtSecret) missingRequired.push('JWT_SECRET')