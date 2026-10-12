/**
 * API-Football Service (https://v3.football.api-sports.io)
 * ─────────────────────────────────────────────────────────────────────────────
 * • Dùng 100% API-Football v3 chính thức với Header: x-apisports-key.
 * • Enforce one-shot snapshot workflow — không background polling.
 * • Cache Redis (Upstash) thông minh theo trạng thái trận (live: 30-60s, FT: 24h)
 *   để bảo tồn quota 100 req/ngày.
 */

import { env } from '../env.js'
import { keys, redis } from '../redis.js'
import type {
    LiveMatchData,
    DetailedMatchStatistics,
    MatchEventItem,
    MatchRecord,
    ExternalCallLog,
    ProviderStatusCode,
} from '../../src/lib/types.js'

export const API_FOOTBALL_BASE_URL = 'https://v3.football.api-sports.io'

/**
 * Chuẩn hóa và làm sạch API key API-Football:
 * Loại bỏ khoảng trắng, dấu ngoặc kép/đơn, và tiền tố markdown list (- , * , • )
 * tránh triệt để lỗi HTTP 403 "Invalid API key".
 */
export function sanitizeApiFootballKey(key?: string | null): string {
    if (!key) return ''
    return String(key)
        .trim()
        .replace(/^['"]+|['"]+$/g, '')
        .replace(/^[-*•\s]+/, '')
        .trim()
}
export interface ApiFootballResponse<T> {
    get: string
    parameters: Record<string, string | number>
    errors: Record<string, string> | string[]
    results: number
    paging: { current: number; total: number }
    response: T
}

export interface ApiFootballFixtureItem {
    fixture: {
        id: number
        referee?: string | null
        timezone?: string
        date: string
        timestamp: number
        periods?: { first?: number | null; second?: number | null }
        venue?: { id?: number | null; name?: string | null; city?: string | null }
        status: {
            long: string
            short: string
            elapsed?: number | null
            extra?: number | null
        }
    }
    league: {
        id: number
        name: string
        country?: string
        logo?: string
        flag?: string
        season?: number
        round?: string
    }
    teams: {
        home: { id: number; name: string; logo?: string; winner?: boolean | null }
        away: { id: number; name: string; logo?: string; winner?: boolean | null }
    }
    goals: {
        home?: number | null
        away?: number | null
    }
    score: {
        halftime?: { home?: number | null; away?: number | null }
        fulltime?: { home?: number | null; away?: number | null }
        extratime?: { home?: number | null; away?: number | null }
        penalty?: { home?: number | null; away?: number | null }
    }
}

export interface ApiFootballStatItem {
    type: string
    value: number | string | null
}

export interface ApiFootballTeamStats {
    team: { id: number; name: string; logo?: string }
    statistics: ApiFootballStatItem[]
}

export interface ApiFootballEventItem {
    time: { elapsed: number; extra?: number | null }
    team: { id: number; name: string; logo?: string }
    player?: { id?: number | null; name?: string | null }
    assist?: { id?: number | null; name?: string | null }
    type: string
    detail: string
    comments?: string | null
}

export interface FootballIncident {
    incidentType: 'goal' | 'card' | 'corner' | 'shot' | 'sub' | 'var' | 'attack'
    isHome: boolean
    time: number
    addedTime?: number
    text: string
    homeScore?: number
    awayScore?: number
    player?: { name?: string }
    detail?: string
}

export interface MatchStatistics {
    corners: { home: number; away: number; total: number }
    cards: { yellowHome: number; yellowAway: number; redHome: number; redAway: number }
    shotsOnTarget: { home: number; away: number }
    shotsTotal: { home: number; away: number }
    possession: { home: number; away: number }
    fouls: { home: number; away: number }
    accuratePasses: { home: number; away: number }
}

export interface H2HResult {
    eventId?: number
    events: ApiFootballFixtureItem[]
    h2hText: string
    n: number
    avgGoals: number
    bttsRate: number
}

/** Chuẩn hóa tên đội để so khớp không dấu và bỏ qua các tiền tố FC, SC, Club... */
export function normalizeTeam(name: string): string {
    return (name || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\b(fc|sc|ac|cf|afc|fk|sv|united|utd|city|club|de|la|el|the)\b/gi, '')
        .replace(/[^a-z0-9]/g, '')
        .trim()
}

export function isTeamMatch(target: string, candidate: string): boolean {
    const t = normalizeTeam(target)
    const c = normalizeTeam(candidate)
    if (!t || !c) return false
    return t === c || t.includes(c) || c.includes(t)
}

// Short TTLs per specification:
export const TTL_MATCH_RESULTS = 6 * 3600 // 6 hours (21600s)
export const TTL_LINEUPS_INJURIES = 30 * 60 // 30 minutes (1800s)
export const TTL_LIVE_STATUS = 30 // 30 seconds

export interface ApiFootballQuota {
    remaining: number | null
    limit: number | null
    perMinute: number | null
    lastUpdated: number
    isSuspended: boolean
    message?: string
    suspendedMessage?: string
}

let currentQuota: ApiFootballQuota = {
    remaining: null,
    limit: null,
    perMinute: null,
    lastUpdated: 0,
    isSuspended: false,
}

export function getApiFootballQuota(): ApiFootballQuota {
    return { ...currentQuota }
}

export function setApiFootballQuota(update: Partial<ApiFootballQuota>): void {
    currentQuota = { ...currentQuota, ...update, lastUpdated: Date.now() }
}

export function resetApiFootballQuota(): void {
    currentQuota = {
        remaining: null,
        limit: null,
        perMinute: null,
        lastUpdated: 0,
        isSuspended: false,
    }
    apiFootballLimiter.reset()
}

/**
 * Concurrency Throttle & Rate Limiter cho API-Football
 * Tuân thủ nghiêm ngặt giới hạn Free Plan: 10 requests / phút.
 */
export interface RateLimiterOptions {
    maxPerMinute?: number
    maxConcurrency?: number
    minDelayMs?: number
    maxQueueWaitMs?: number
}

export class ApiFootballRateLimiter {
    private requestTimestamps: number[] = []
    private maxPerMinute: number
    private maxConcurrency: number
    private minDelayMs: number
    private maxQueueWaitMs: number
    private activeCount = 0
    private lastRequestTime = 0
    private queue: Array<() => void> = []

    constructor(options: RateLimiterOptions = {}) {
        this.maxPerMinute = options.maxPerMinute ?? 10
        this.maxConcurrency = options.maxConcurrency ?? 1
        this.minDelayMs = options.minDelayMs ?? 200
        this.maxQueueWaitMs = options.maxQueueWaitMs ?? 8000
    }

    public getTimestampsInWindow(windowMs = 60000): number[] {
        const now = Date.now()
        this.requestTimestamps = this.requestTimestamps.filter((t) => now - t < windowMs)
        return [...this.requestTimestamps]
    }

    public async acquire(): Promise<boolean> {
        // Kiểm tra quota trước khi xếp hàng
        if (currentQuota.isSuspended) return false
        if (currentQuota.remaining !== null && currentQuota.remaining <= 0) return false
        if (currentQuota.perMinute !== null && currentQuota.perMinute <= 0) return false

        const now = Date.now()
        this.getTimestampsInWindow()

        // 1. Nếu đã đạt 10 requests / phút: tính thời gian chờ
        if (this.requestTimestamps.length >= this.maxPerMinute) {
            const oldest = this.requestTimestamps[0]
            const waitMs = oldest + 60000 - now + 50
            if (waitMs > this.maxQueueWaitMs) {
                console.warn(
                    `[api-football] Rate limit window full (${this.requestTimestamps.length}/${this.maxPerMinute} reqs/min). Wait time ${waitMs}ms exceeds max wait (${this.maxQueueWaitMs}ms). Falling back to search.`,
                )
                return false
            }
            if (waitMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, waitMs))
            }
        }

        // 2. Concurrency Throttle: chỉ cho phép maxConcurrency (mặc định 1) request đồng thời
        if (this.activeCount >= this.maxConcurrency) {
            await new Promise<void>((resolve) => {
                this.queue.push(resolve)
            })
        }

        // 3. Giãn cách tối thiểu giữa 2 request mạng (chống burst spike)
        const timeSinceLast = Date.now() - this.lastRequestTime
        if (timeSinceLast < this.minDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, this.minDelayMs - timeSinceLast))
        }

        this.activeCount++
        const reqTime = Date.now()
        this.lastRequestTime = reqTime
        this.requestTimestamps.push(reqTime)
        return true
    }

    public release(): void {
        this.activeCount = Math.max(0, this.activeCount - 1)
        if (this.queue.length > 0) {
            const next = this.queue.shift()
            next?.()
        }
    }

    public reset(): void {
        this.requestTimestamps = []
        this.activeCount = 0
        this.lastRequestTime = 0
        this.queue = []
    }
}

export const apiFootballLimiter = new ApiFootballRateLimiter()

/** Kiểm tra xem trận đấu có trong vòng 3 giờ trước/sau giờ thi đấu hay không */
export function isWithin3HoursOfKickoff(kickoff?: string | null): boolean {
    if (!kickoff) return false
    const t = new Date(kickoff).getTime()
    if (isNaN(t)) return false
    const diff = t - Date.now()
    return diff <= 3 * 3600 * 1000 && diff >= -3 * 3600 * 1000
}

export interface ApiFootballFetchOptions {
    params?: Record<string, string | number>
    ttlSec?: number
    forceRefresh?: boolean
    kickoff?: string | null
    purpose?: string
    auditLogger?: (log: ExternalCallLog) => void
}

export interface ApiFootballCallResult<T> {
    data: T | null
    success: boolean
    status: ProviderStatusCode
    statusCode?: number
    errorMessage?: string
    resultsCount: number
    servedFromCache: boolean
    fetchedAt: string
}

/**
 * Gọi API-Football với kiểm tra lỗi payload, quota tracking, và quản lý cache nghiêm ngặt.
 */
export async function fetchApiFootballDetailed<T = unknown>(
    endpoint: string,
    options: ApiFootballFetchOptions = {},
): Promise<ApiFootballCallResult<T>> {
    const cleanEndpoint = endpoint.replace(/^\/+/, '')
    const searchParams = new URLSearchParams()
    for (const [k, v] of Object.entries(options.params || {})) {
        if (v !== undefined && v !== null && v !== '') {
            searchParams.set(k, String(v))
        }
    }
    const queryString = searchParams.toString()
    const pathWithQuery = queryString ? `${cleanEndpoint}?${queryString}` : cleanEndpoint
    const cacheKey = keys.footballCache(pathWithQuery)
    const startTime = Date.now()
    const fetchedAt = new Date().toISOString()
    const ttlSec = options.ttlSec ?? 60

    // 0. Quota Guard: Nếu quota bằng 0 hoặc tài khoản bị khóa, dừng gọi ngay lập tức
    if (currentQuota.isSuspended || (currentQuota.remaining !== null && currentQuota.remaining <= 0)) {
        const errorMsg = currentQuota.isSuspended
            ? (currentQuota.suspendedMessage || currentQuota.message || 'Tài khoản API-Football bị tạm khóa')
            : 'Hết quota API-Football (0 requests remaining)'
        const res: ApiFootballCallResult<T> = {
            data: null,
            success: false,
            status: 'ERROR',
            errorMessage: errorMsg,
            resultsCount: 0,
            servedFromCache: false,
            fetchedAt,
        }
        options.auditLogger?.({
            provider: 'api-football',
            purpose: options.purpose || cleanEndpoint,
            requestSummary: pathWithQuery,
            startTime,
            durationMs: 0,
            resultCount: 0,
            errorMessage: errorMsg,
            servedFromCache: false,
        })
        return res
    }

    // 1. Kiểm tra cache Redis (Bỏ qua cache nếu forceRefresh hoặc trận trong vòng 3h kickoff)
    const shouldBypassCache = Boolean(options.forceRefresh || isWithin3HoursOfKickoff(options.kickoff))
    if (!shouldBypassCache) {
        try {
            const cached = await redis.get<T>(cacheKey)
            if (cached !== null && cached !== undefined) {
                const resultsCount = Array.isArray(cached) ? cached.length : 1
                const res: ApiFootballCallResult<T> = {
                    data: cached,
                    success: true,
                    status: 'OK',
                    resultsCount,
                    servedFromCache: true,
                    fetchedAt,
                }
                options.auditLogger?.({
                    provider: 'api-football',
                    purpose: options.purpose || cleanEndpoint,
                    requestSummary: pathWithQuery,
                    startTime,
                    durationMs: Date.now() - startTime,
                    httpStatus: 200,
                    resultCount: resultsCount,
                    servedFromCache: true,
                })
                return res
            }
        } catch {
            /* bỏ qua lỗi cache */
        }
    }

    // 2. Concurrency Throttle & Rate Limiter: Tối đa 10 requests / phút (Free Plan)
    const acquired = await apiFootballLimiter.acquire()
    if (!acquired) {
        const errorMsg = currentQuota.isSuspended
            ? (currentQuota.suspendedMessage || currentQuota.message || 'Tài khoản API-Football bị tạm khóa')
            : (currentQuota.remaining !== null && currentQuota.remaining <= 0
                ? 'Hết quota API-Football (0 requests remaining)'
                : 'Đã chạm giới hạn tần suất API-Football (10 requests/phút). Đang kích hoạt Web Search Fallback.')
        const failResult: ApiFootballCallResult<T> = {
            data: null,
            success: false,
            status: 'ERROR',
            errorMessage: errorMsg,
            resultsCount: 0,
            servedFromCache: false,
            fetchedAt,
        }
        options.auditLogger?.({
            provider: 'api-football',
            purpose: options.purpose || cleanEndpoint,
            requestSummary: pathWithQuery,
            startTime,
            durationMs: Date.now() - startTime,
            resultCount: 0,
            errorMessage: errorMsg,
            servedFromCache: false,
        })
        return failResult
    }

    try {
        // 3. Chuẩn bị gọi API-Football (Direct Web api-football.com)
        const apiKey = sanitizeApiFootballKey(env.apiFootballKey)
        if (!apiKey) {
            const errorMsg = 'API-Football key chưa được cấu hình hoặc rỗng (API_FOOTBALL_KEY missing)'
            const failResult: ApiFootballCallResult<T> = {
                data: null,
                success: false,
                status: 'ERROR',
                errorMessage: errorMsg,
                resultsCount: 0,
                servedFromCache: false,
                fetchedAt,
            }
            options.auditLogger?.({
                provider: 'api-football',
                purpose: options.purpose || cleanEndpoint,
                requestSummary: pathWithQuery,
                startTime,
                durationMs: 0,
                resultCount: 0,
                errorMessage: errorMsg,
                servedFromCache: false,
            })
            return failResult
        }
        const url = `${API_FOOTBALL_BASE_URL}/${pathWithQuery}`

        let httpStatus: number | undefined
        let rawResponse: Response | null = null
        let retryAttempts = 0
        const maxRetries = 1

        while (retryAttempts <= maxRetries) {
            try {
                rawResponse = await fetch(url, {
                    headers: {
                        'x-apisports-key': apiKey,
                        Accept: 'application/json',
                    },
                })
                httpStatus = rawResponse.status

                // Retry CHỈ khi gặp 429 hoặc 5xx
                if ((httpStatus === 429 || httpStatus >= 500) && retryAttempts < maxRetries) {
                    retryAttempts++
                    await new Promise((r) => setTimeout(r, 600 * retryAttempts))
                    continue
                }
                break
            } catch (netErr) {
                if (retryAttempts < maxRetries) {
                    retryAttempts++
                    await new Promise((r) => setTimeout(r, 600 * retryAttempts))
                    continue
                }
                const errMsg = netErr instanceof Error ? netErr.message : String(netErr)
                const failResult: ApiFootballCallResult<T> = {
                    data: null,
                    success: false,
                    status: 'ERROR',
                    errorMessage: `Lỗi kết nối API-Football: ${errMsg}`,
                    resultsCount: 0,
                    servedFromCache: false,
                    fetchedAt,
                }
                options.auditLogger?.({
                    provider: 'api-football',
                    purpose: options.purpose || cleanEndpoint,
                    requestSummary: pathWithQuery,
                    startTime,
                    durationMs: Date.now() - startTime,
                    resultCount: 0,
                    errorMessage: failResult.errorMessage,
                    servedFromCache: false,
                })
                return failResult
            }
        }

    if (!rawResponse) {
        return {
            data: null,
            success: false,
            status: 'ERROR',
            errorMessage: 'Không nhận được phản hồi từ API-Football',
            resultsCount: 0,
            servedFromCache: false,
            fetchedAt,
        }
    }

    // 3. Đọc quota headers từ response
    const remainingHdr = rawResponse.headers.get('x-ratelimit-requests-remaining')
    const limitHdr = rawResponse.headers.get('x-ratelimit-requests-limit')
    const perMinuteHdr =
        rawResponse.headers.get('x-ratelimit-remaining-minute') ||
        rawResponse.headers.get('x-ratelimit-remaining')
    if (remainingHdr !== null) {
        const rem = parseInt(remainingHdr, 10)
        const lim = limitHdr ? parseInt(limitHdr, 10) : null
        const pm = perMinuteHdr ? parseInt(perMinuteHdr, 10) : null
        setApiFootballQuota({
            remaining: isNaN(rem) ? null : rem,
            limit: lim !== null && !isNaN(lim) ? lim : null,
            perMinute: pm !== null && !isNaN(pm) ? pm : null,
        })
    }

    if (!rawResponse.ok) {
        const errorText = await rawResponse.text().catch(() => '')
        const errorMsg = `API-Football HTTP ${rawResponse.status}: ${errorText.slice(0, 150)}`
        options.auditLogger?.({
            provider: 'api-football',
            purpose: options.purpose || cleanEndpoint,
            requestSummary: pathWithQuery,
            startTime,
            durationMs: Date.now() - startTime,
            httpStatus: rawResponse.status,
            resultCount: 0,
            errorMessage: errorMsg,
            servedFromCache: false,
        })
        return {
            data: null,
            success: false,
            status: 'ERROR',
            statusCode: rawResponse.status,
            errorMessage: errorMsg,
            resultsCount: 0,
            servedFromCache: false,
            fetchedAt,
        }
    }

    let parsedBody: ApiFootballResponse<T>
    try {
        parsedBody = (await rawResponse.json()) as ApiFootballResponse<T>
    } catch {
        const errorMsg = 'Lỗi parse JSON phản hồi từ API-Football'
        return {
            data: null,
            success: false,
            status: 'ERROR',
            errorMessage: errorMsg,
            resultsCount: 0,
            servedFromCache: false,
            fetchedAt,
        }
    }

    // 4. BẮT BUỘC: Xử lý HTTP 200 kèm payload errors là FAILURE
    const rawErrors = parsedBody.errors as unknown
    const hasErrors = Boolean(
        rawErrors &&
            ((typeof rawErrors === 'object' && Object.keys(rawErrors as object).length > 0) ||
                (Array.isArray(rawErrors) && rawErrors.length > 0) ||
                (typeof rawErrors === 'string' && (rawErrors as string).trim().length > 0)),
    )

    if (hasErrors) {
        let errMessage = ''
        if (typeof rawErrors === 'object' && rawErrors !== null && !Array.isArray(rawErrors)) {
            const errObj = rawErrors as Record<string, unknown>
            errMessage = Object.entries(errObj)
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ')
            if (errObj.access && String(errObj.access).toLowerCase().includes('suspended')) {
                setApiFootballQuota({ isSuspended: true, message: String(errObj.access) })
            }
        } else if (Array.isArray(rawErrors)) {
            errMessage = rawErrors.join(', ')
        } else {
            errMessage = String(rawErrors)
        }

        console.warn(`[api-football] Provider error payload:`, errMessage)

        // TUYỆT ĐỐI KHÔNG ghi cache lỗi (hoặc tối đa không lưu)
        options.auditLogger?.({
            provider: 'api-football',
            purpose: options.purpose || cleanEndpoint,
            requestSummary: pathWithQuery,
            startTime,
            durationMs: Date.now() - startTime,
            httpStatus: 200,
            resultCount: 0,
            errorMessage: errMessage,
            servedFromCache: false,
        })

        return {
            data: null,
            success: false,
            status: 'ERROR',
            errorMessage: errMessage,
            resultsCount: 0,
            servedFromCache: false,
            fetchedAt,
        }
    }

    // Nếu gọi endpoint 'status', trích xuất chi tiết gói cước và request count để cập nhật quota chính xác
    if (cleanEndpoint === 'status' && parsedBody.response && typeof parsedBody.response === 'object') {
        const respObj = parsedBody.response as Record<string, unknown>
        const reqs = respObj.requests as { current?: number; limit_day?: number } | undefined
        const sub = respObj.subscription as { active?: boolean; plan?: string } | undefined
        if (reqs && reqs.limit_day !== undefined && reqs.current !== undefined) {
            const lim = Number(reqs.limit_day)
            const cur = Number(reqs.current)
            const rem = !isNaN(lim) && !isNaN(cur) ? Math.max(0, lim - cur) : null
            setApiFootballQuota({
                remaining: rem,
                limit: isNaN(lim) ? null : lim,
                isSuspended: sub?.active === false,
                message: sub?.active === false ? 'Tài khoản API-Football đã bị khóa hoặc hết hạn' : undefined,
            })
        }
    }

    // 5. Kiểm tra kết quả rỗng (results == 0 hoặc response là mảng rỗng)
    const isResponseArray = Array.isArray(parsedBody.response)
    const hasObjectResponse =
        !isResponseArray &&
        parsedBody.response !== null &&
        typeof parsedBody.response === 'object' &&
        Object.keys(parsedBody.response as object).length > 0
    const resultsCount =
        parsedBody.results !== undefined && parsedBody.results > 0
            ? parsedBody.results
            : (isResponseArray ? (parsedBody.response as unknown as unknown[]).length : (hasObjectResponse ? 1 : 0))

    if (resultsCount === 0 && !hasObjectResponse) {
        // TUYỆT ĐỐI KHÔNG cache kết quả rỗng
        options.auditLogger?.({
            provider: 'api-football',
            purpose: options.purpose || cleanEndpoint,
            requestSummary: pathWithQuery,
            startTime,
            durationMs: Date.now() - startTime,
            httpStatus: 200,
            resultCount: 0,
            servedFromCache: false,
        })
        return {
            data: parsedBody.response,
            success: false,
            status: 'EMPTY',
            resultsCount: 0,
            errorMessage: 'Không tìm thấy dữ liệu trên API-Football (results: 0)',
            servedFromCache: false,
            fetchedAt,
        }
    }

    // 6. Ghi cache kết quả thành công hợp lệ
    const payload = parsedBody.response
    if (payload !== undefined && payload !== null) {
        try {
            await redis.set(cacheKey, payload, { ex: ttlSec })
        } catch {
            /* bỏ qua lỗi set cache */
        }
    }

    options.auditLogger?.({
        provider: 'api-football',
        purpose: options.purpose || cleanEndpoint,
        requestSummary: pathWithQuery,
        startTime,
        durationMs: Date.now() - startTime,
        httpStatus: 200,
        resultCount: resultsCount,
        servedFromCache: false,
    })

        return {
            data: payload,
            success: true,
            status: 'OK',
            resultsCount,
            servedFromCache: false,
            fetchedAt,
        }
    } finally {
        apiFootballLimiter.release()
    }
}

/** Wrapper giữ tương thích ngược */
export async function fetchApiFootball<T = unknown>(
    endpoint: string,
    params: Record<string, string | number> = {},
    ttlSec = 60,
): Promise<T | null> {
    const res = await fetchApiFootballDetailed<T>(endpoint, { params, ttlSec })
    return res.data
}

/**
 * Chuyển đổi đối tượng Fixture từ API-Football thành MatchRecord chuẩn hóa có Provenance.
 * Chỉ nhận các trận đã kết thúc (FT, AET, PEN). Bỏ qua hoãn/hủy (PPD, CANC, ABD).
 */
export function fixtureToMatchRecord(
    item: ApiFootballFixtureItem,
    fetchedAt = new Date().toISOString(),
): MatchRecord | null {
    const statusShort = (item.fixture?.status?.short || '').toUpperCase()
    // Chỉ tính các trận đã hoàn thành
    const isFinished = ['FT', 'AET', 'PEN'].includes(statusShort)
    if (!isFinished) return null

    const ftHome = Number(item.goals?.home ?? item.score?.fulltime?.home ?? 0)
    const ftAway = Number(item.goals?.away ?? item.score?.fulltime?.away ?? 0)
    const htHome = item.score?.halftime?.home != null ? Number(item.score.halftime.home) : undefined
    const htAway = item.score?.halftime?.away != null ? Number(item.score.halftime.away) : undefined

    let gender: 'men' | 'women' | undefined
    let ageGroup: 'senior' | 'u19' | 'u21' | 'u23' | undefined

    const combinedName = `${item.league?.name || ''} ${item.teams?.home?.name || ''} ${item.teams?.away?.name || ''}`.toLowerCase()
    if (combinedName.includes('women') || combinedName.includes(' w') || combinedName.includes('(w)') || combinedName.includes('females')) {
        gender = 'women'
    } else {
        gender = 'men'
    }

    if (combinedName.includes('u19') || combinedName.includes('u-19') || combinedName.includes('under 19')) {
        ageGroup = 'u19'
    } else if (combinedName.includes('u21') || combinedName.includes('u-21')) {
        ageGroup = 'u21'
    } else if (combinedName.includes('u23') || combinedName.includes('u-23')) {
        ageGroup = 'u23'
    } else {
        ageGroup = 'senior'
    }

    return {
        id: item.fixture.id,
        date: item.fixture.date?.split('T')[0] || item.fixture.date,
        competition: item.league?.name || 'Unknown Competition',
        homeTeam: item.teams?.home?.name || 'Home Team',
        awayTeam: item.teams?.away?.name || 'Away Team',
        homeTeamId: item.teams?.home?.id,
        awayTeamId: item.teams?.away?.id,
        gender,
        ageGroup,
        ftScore: { home: ftHome, away: ftAway },
        htScore: htHome != null && htAway != null ? { home: htHome, away: htAway } : undefined,
        status: statusShort,
        source: 'api-football',
        provenance: {
            source: `api-football:fixtures?id=${item.fixture.id}`,
            fetchedAt,
            verified: true,
        },
    }
}

/**
 * Khử trùng lặp danh sách trận đấu giữa API-Football và Web:
 * Khử trùng theo (date, team ids). Ưu tiên tỷ số từ API-Football;
 * đánh dấu verified = true khi nguồn web đối soát đồng thuận về tỷ số.
 */
export function deduplicateMatchRecords(records: MatchRecord[]): MatchRecord[] {
    const map = new Map<string, MatchRecord>()
    for (const r of records) {
        const teamKey = r.homeTeamId && r.awayTeamId
            ? `${r.homeTeamId}_${r.awayTeamId}`
            : `${normalizeTeam(r.homeTeam)}_${normalizeTeam(r.awayTeam)}`
        const key = `${r.date}_${teamKey}`

        const existing = map.get(key)
        if (!existing) {
            map.set(key, { ...r })
        } else {
            // Khi cả API-Football và web cùng có trận này:
            if (existing.source === 'api-football' && r.source !== 'api-football') {
                if (
                    r.ftScore &&
                    existing.ftScore &&
                    r.ftScore.home === existing.ftScore.home &&
                    r.ftScore.away === existing.ftScore.away
                ) {
                    existing.provenance.verified = true
                }
            } else if (existing.source !== 'api-football' && r.source === 'api-football') {
                const webAgrees = Boolean(
                    existing.ftScore &&
                    r.ftScore &&
                    existing.ftScore.home === r.ftScore.home &&
                    existing.ftScore.away === r.ftScore.away
                )
                const updated = { ...r }
                if (webAgrees) {
                    updated.provenance.verified = true
                }
                map.set(key, updated)
            }
        }
    }
    return Array.from(map.values())
}

/**
 * Lấy danh sách trận đấu gần đây đã kết thúc của một đội (theo teamId) từ API-Football.
 * Tự động thích ứng với giới hạn plan: nếu `last` bị từ chối, chuyển sang query theo mùa giải.
 */
export async function getTeamRecentFixtures(
    teamId: number,
    options: {
        season?: number
        kickoff?: string | null
        forceRefresh?: boolean
        auditLogger?: (log: ExternalCallLog) => void
    } = {},
): Promise<{
    matches: MatchRecord[]
    excludedMatches?: Array<{ id: number; date: string; status: string; teams: string; reason: string }>
    fetchedAt: string
    status: ProviderStatusCode
    errorMessage?: string
}> {
    const fetchedAt = new Date().toISOString()
    if (!teamId || teamId <= 0) {
        return { matches: [], excludedMatches: [], fetchedAt, status: 'NOT_CALLED' }
    }

    const currentYear = options.season || (options.kickoff ? new Date(options.kickoff).getFullYear() : new Date().getFullYear())

    // 1. Thử gọi với team + status: FT theo mùa giải (tương thích cả Free lẫn Pro plans)
    let callRes = await fetchApiFootballDetailed<ApiFootballFixtureItem[]>('fixtures', {
        params: { team: teamId, season: currentYear, status: 'FT' },
        ttlSec: TTL_MATCH_RESULTS,
        forceRefresh: options.forceRefresh,
        kickoff: options.kickoff,
        purpose: `team_${teamId}_recent_fixtures`,
        auditLogger: options.auditLogger,
    })

    // 2. Nếu mùa giải hiện tại chưa có trận (e.g. đầu năm), thử mùa giải trước đó
    if ((!callRes.success || callRes.resultsCount === 0) && !callRes.errorMessage?.includes('suspended')) {
        const prevYear = currentYear - 1
        const fallbackRes = await fetchApiFootballDetailed<ApiFootballFixtureItem[]>('fixtures', {
            params: { team: teamId, season: prevYear, status: 'FT' },
            ttlSec: TTL_MATCH_RESULTS,
            forceRefresh: options.forceRefresh,
            kickoff: options.kickoff,
            purpose: `team_${teamId}_fallback_prev_season`,
            auditLogger: options.auditLogger,
        })
        if (fallbackRes.success && fallbackRes.resultsCount > 0) {
            callRes = fallbackRes
        }
    }

    if (!callRes.success || !callRes.data || !Array.isArray(callRes.data)) {
        return {
            matches: [],
            excludedMatches: [],
            fetchedAt,
            status: callRes.status,
            errorMessage: callRes.errorMessage,
        }
    }

    // Chuyển đổi và phân loại trận đã hoàn thành vs trận bị hoãn/hủy
    const records: MatchRecord[] = []
    const excludedMatches: Array<{ id: number; date: string; status: string; teams: string; reason: string }> = []

    for (const item of callRes.data) {
        const statusShort = (item.fixture?.status?.short || '').toUpperCase()
        if (['FT', 'AET', 'PEN'].includes(statusShort)) {
            const rec = fixtureToMatchRecord(item, callRes.fetchedAt)
            if (rec) records.push(rec)
        } else if (['PPD', 'CANC', 'ABD', 'AWD', 'WO', 'INT'].includes(statusShort)) {
            let reason = 'Không hoàn thành'
            if (statusShort === 'PPD') reason = 'Hoãn thi đấu (Postponed)'
            else if (statusShort === 'CANC') reason = 'Hủy trận (Cancelled)'
            else if (statusShort === 'ABD') reason = 'Bị gián đoạn giữa chừng (Abandoned)'
            excludedMatches.push({
                id: item.fixture.id,
                date: item.fixture.date?.split('T')[0] || item.fixture.date,
                status: statusShort,
                teams: `${item.teams?.home?.name || 'Home'} vs ${item.teams?.away?.name || 'Away'}`,
                reason,
            })
        }
    }

    // Sắp xếp thời gian giảm dần (mới nhất lên đầu), lấy tối đa 10 trận
    records.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    const slice = records.slice(0, 10)

    return {
        matches: slice,
        excludedMatches,
        fetchedAt: callRes.fetchedAt,
        status: slice.length > 0 ? 'OK' : 'EMPTY',
    }
}

/**
 * Lấy bảng xếp hạng (Standings) từ API-Football:
 * Chỉ áp dụng cho các giải đấu cấp cao (senior leagues), bỏ qua các giải trẻ/giao hữu không có BXH.
 */
export async function getLeagueStandings(
    leagueId: number,
    season: number,
    isSeniorLeague = true,
    options: {
        forceRefresh?: boolean
        auditLogger?: (log: ExternalCallLog) => void
    } = {},
): Promise<{
    data: unknown | null
    status: ProviderStatusCode
    errorMessage?: string
    fetchedAt: string
}> {
    const fetchedAt = new Date().toISOString()
    if (!isSeniorLeague || !leagueId || !season) {
        return { data: null, status: 'NOT_CALLED', fetchedAt }
    }
    const res = await fetchApiFootballDetailed('standings', {
        params: { league: leagueId, season },
        ttlSec: TTL_MATCH_RESULTS,
        forceRefresh: options.forceRefresh,
        purpose: `league_${leagueId}_standings`,
        auditLogger: options.auditLogger,
    })
    return {
        data: res.data,
        status: res.status,
        errorMessage: res.errorMessage,
        fetchedAt: res.fetchedAt,
    }
}

/**
 * Tìm kiếm Fixture trên API-Football:
 * 1. Nếu có fixtureId cụ thể: gọi /fixtures?id=...
 * 2. Tìm trong các trận đang Live (/fixtures?live=all)
 * 3. Tìm trong lịch thi đấu ngày kickoff (hoặc hôm nay/hôm qua)
 * Trả về fixture item kèm các ID định danh để tái sử dụng.
 */
export async function findFixture(
    home: string,
    away: string,
    preferredFixtureId?: number,
    options: {
        kickoff?: string | null
        forceRefresh?: boolean
        auditLogger?: (log: ExternalCallLog) => void
    } = {},
): Promise<ApiFootballFixtureItem | null> {
    // 1. Nếu có ID cụ thể, tra cứu trực tiếp bằng ID
    if (preferredFixtureId && preferredFixtureId > 0) {
        const res = await fetchApiFootballDetailed<ApiFootballFixtureItem[]>('fixtures', {
            params: { id: preferredFixtureId },
            ttlSec: TTL_LIVE_STATUS,
            forceRefresh: options.forceRefresh,
            kickoff: options.kickoff,
            purpose: `fixture_lookup_id_${preferredFixtureId}`,
            auditLogger: options.auditLogger,
        })
        if (res.success && res.data && res.data.length > 0) return res.data[0]
    }

    const cleanHome = home.trim()
    const cleanAway = away.trim()
    if (!cleanHome && !cleanAway) return null

    // 2. Tra cứu trong các trận đang Live
    const liveRes = await fetchApiFootballDetailed<ApiFootballFixtureItem[]>('fixtures', {
        params: { live: 'all' },
        ttlSec: TTL_LIVE_STATUS,
        forceRefresh: options.forceRefresh,
        purpose: 'fixtures_live_all',
        auditLogger: options.auditLogger,
    })
    if (liveRes.success && liveRes.data && liveRes.data.length > 0) {
        for (const item of liveRes.data) {
            const hName = item.teams?.home?.name || ''
            const aName = item.teams?.away?.name || ''
            if (isTeamMatch(cleanHome, hName) && isTeamMatch(cleanAway, aName)) {
                return item
            }
        }
    }

    // 3. Tra cứu theo ngày kickoff (nếu có ngày kickoff cụ thể)
    if (options.kickoff) {
        const kDate = options.kickoff.split('T')[0]
        const kRes = await fetchApiFootballDetailed<ApiFootballFixtureItem[]>('fixtures', {
            params: { date: kDate },
            ttlSec: TTL_MATCH_RESULTS,
            forceRefresh: options.forceRefresh,
            kickoff: options.kickoff,
            purpose: `fixtures_date_${kDate}`,
            auditLogger: options.auditLogger,
        })
        if (kRes.success && kRes.data && kRes.data.length > 0) {
            for (const item of kRes.data) {
                const hName = item.teams?.home?.name || ''
                const aName = item.teams?.away?.name || ''
                if (isTeamMatch(cleanHome, hName) && isTeamMatch(cleanAway, aName)) {
                    return item
                }
            }
        }
    }

    // 4. Tra cứu trong lịch thi đấu hôm nay
    const today = new Date().toISOString().split('T')[0]
    const todayRes = await fetchApiFootballDetailed<ApiFootballFixtureItem[]>('fixtures', {
        params: { date: today },
        ttlSec: 60,
        forceRefresh: options.forceRefresh,
        purpose: `fixtures_date_today`,
        auditLogger: options.auditLogger,
    })
    if (todayRes.success && todayRes.data && todayRes.data.length > 0) {
        for (const item of todayRes.data) {
            const hName = item.teams?.home?.name || ''
            const aName = item.teams?.away?.name || ''
            if (isTeamMatch(cleanHome, hName) && isTeamMatch(cleanAway, aName)) {
                return item
            }
        }
    }

    // 5. Tra cứu theo ngày hôm qua
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const yesterdayRes = await fetchApiFootballDetailed<ApiFootballFixtureItem[]>('fixtures', {
        params: { date: yesterday },
        ttlSec: 120,
        forceRefresh: options.forceRefresh,
        purpose: `fixtures_date_yesterday`,
        auditLogger: options.auditLogger,
    })
    if (yesterdayRes.success && yesterdayRes.data && yesterdayRes.data.length > 0) {
        for (const item of yesterdayRes.data) {
            const hName = item.teams?.home?.name || ''
            const aName = item.teams?.away?.name || ''
            if (isTeamMatch(cleanHome, hName) && isTeamMatch(cleanAway, aName)) {
                return item
            }
        }
    }

    return null
}

/**
 * Lấy thông tin đội hình (Lineups) của trận đấu từ API-Football
 */
export async function getFixtureLineups(
    fixtureId: number,
    options: {
        forceRefresh?: boolean
        kickoff?: string | null
        auditLogger?: (log: ExternalCallLog) => void
    } = {},
): Promise<{
    data: unknown | null
    status: ProviderStatusCode
    errorMessage?: string
    fetchedAt: string
}> {
    const res = await fetchApiFootballDetailed('fixtures/lineups', {
        params: { fixture: fixtureId },
        ttlSec: TTL_LINEUPS_INJURIES,
        forceRefresh: options.forceRefresh,
        kickoff: options.kickoff,
        purpose: `fixture_${fixtureId}_lineups`,
        auditLogger: options.auditLogger,
    })
    return {
        data: res.data,
        status: res.status,
        errorMessage: res.errorMessage,
        fetchedAt: res.fetchedAt,
    }
}

/**
 * Lấy thông tin danh sách chấn thương (Injuries) của trận đấu từ API-Football
 */
export async function getFixtureInjuries(
    fixtureId: number,
    options: {
        forceRefresh?: boolean
        kickoff?: string | null
        auditLogger?: (log: ExternalCallLog) => void
    } = {},
): Promise<{
    data: unknown | null
    status: ProviderStatusCode
    errorMessage?: string
    fetchedAt: string
}> {
    const res = await fetchApiFootballDetailed('injuries', {
        params: { fixture: fixtureId },
        ttlSec: TTL_LINEUPS_INJURIES,
        forceRefresh: options.forceRefresh,
        kickoff: options.kickoff,
        purpose: `fixture_${fixtureId}_injuries`,
        auditLogger: options.auditLogger,
    })
    return {
        data: res.data,
        status: res.status,
        errorMessage: res.errorMessage,
        fetchedAt: res.fetchedAt,
    }
}

/**
 * Trích xuất 100% số liệu thống kê trận đấu từ API-Football /fixtures/statistics
 */
export async function extractFixtureStatistics(
    fixtureId: number,
    isFinished = false,
): Promise<MatchStatistics> {
    const ttl = isFinished ? 86400 : 30
    const list = await fetchApiFootball<ApiFootballTeamStats[]>('fixtures/statistics', { fixture: fixtureId }, ttl)
    if (!list || list.length < 2) {
        return {
            corners: { home: 0, away: 0, total: 0 },
            cards: { yellowHome: 0, yellowAway: 0, redHome: 0, redAway: 0 },
            shotsOnTarget: { home: 0, away: 0 },
            shotsTotal: { home: 0, away: 0 },
            possession: { home: 0, away: 0 },
            fouls: { home: 0, away: 0 },
            accuratePasses: { home: 0, away: 0 },
        }
    }

    const homeTeam = list[0]
    const awayTeam = list[1]

    const getStat = (team: ApiFootballTeamStats, typeName: string): number => {
        const item = team.statistics?.find((s) => s.type?.toLowerCase() === typeName.toLowerCase())
        if (!item || item.value === null || item.value === undefined) return 0
        if (typeof item.value === 'number') return item.value
        const parsed = parseInt(String(item.value).replace('%', '').trim(), 10)
        return isNaN(parsed) ? 0 : parsed
    }

    const cornersHome = getStat(homeTeam, 'Corner Kicks')
    const cornersAway = getStat(awayTeam, 'Corner Kicks')
    const yellowHome = getStat(homeTeam, 'Yellow Cards')
    const yellowAway = getStat(awayTeam, 'Yellow Cards')
    const redHome = getStat(homeTeam, 'Red Cards')
    const redAway = getStat(awayTeam, 'Red Cards')
    const shotsOnTargetHome = getStat(homeTeam, 'Shots on Goal')
    const shotsOnTargetAway = getStat(awayTeam, 'Shots on Goal')
    const shotsTotalHome = getStat(homeTeam, 'Total Shots')
    const shotsTotalAway = getStat(awayTeam, 'Total Shots')
    const foulsHome = getStat(homeTeam, 'Fouls')
    const foulsAway = getStat(awayTeam, 'Fouls')
    const passAccHome = getStat(homeTeam, 'Passes accurate')
    const passAccAway = getStat(awayTeam, 'Passes accurate')

    const possHome = getStat(homeTeam, 'Ball Possession')
    const possAway = getStat(awayTeam, 'Ball Possession')

    return {
        corners: { home: cornersHome, away: cornersAway, total: cornersHome + cornersAway },
        cards: { yellowHome, yellowAway, redHome, redAway },
        shotsOnTarget: { home: shotsOnTargetHome, away: shotsOnTargetAway },
        shotsTotal: { home: shotsTotalHome, away: shotsTotalAway },
        possession: { home: possHome, away: possAway },
        fouls: { home: foulsHome, away: foulsAway },
        accuratePasses: { home: passAccHome, away: passAccAway },
    }
}

/**
 * Trích xuất thống kê chi tiết đầy đủ 4 nhóm (A–D) từ API-Football.
 * Tái sử dụng cùng endpoint /fixtures/statistics nhưng parse sâu hơn,
 * trả về DetailedMatchStatistics + mảng raw để frontend Hub dùng trực tiếp.
 */
export async function extractDetailedFixtureStatistics(
    fixtureId: number,
    isFinished = false,
): Promise<{ detailed: DetailedMatchStatistics | null; raw: ApiFootballTeamStats[] }> {
    const ttl = isFinished ? 86400 : 30
    const list = await fetchApiFootball<ApiFootballTeamStats[]>('fixtures/statistics', { fixture: fixtureId }, ttl)

    if (!list || list.length < 2 || !list[0].statistics || list[0].statistics.length === 0) {
        return { detailed: null, raw: list || [] }
    }

    const ht = list[0]
    const at = list[1]

    const n = (team: ApiFootballTeamStats, t: string): number => {
        const it = team.statistics.find((s) => s.type.toLowerCase() === t.toLowerCase())
        if (!it || it.value === null || it.value === undefined) return 0
        if (typeof it.value === 'number') return it.value
        const p = parseInt(String(it.value).replace('%', '').trim(), 10)
        return isNaN(p) ? 0 : p
    }
    const pct = (team: ApiFootballTeamStats, t: string): number => {
        const it = team.statistics.find((s) => s.type.toLowerCase() === t.toLowerCase())
        if (!it || it.value === null || it.value === undefined) return 0
        const p = parseFloat(String(it.value).replace('%', '').trim())
        return isNaN(p) ? 0 : p
    }

    const possH = n(ht, 'Ball Possession'), possA = n(at, 'Ball Possession')

    const passH = n(ht, 'Passes accurate'), passA = n(at, 'Passes accurate')
    const passPctH = pct(ht, 'Passes %'), passPctA = pct(at, 'Passes %')

    const crossH = n(ht, 'Accurate Crosses') || n(ht, 'Crosses')
    const crossA = n(at, 'Accurate Crosses') || n(at, 'Crosses')
    const crossTH = n(ht, 'Total Crosses') || crossH
    const crossTA = n(at, 'Total Crosses') || crossA

    const lbH = n(ht, 'Accurate Long Balls') || n(ht, 'Long Balls')
    const lbA = n(at, 'Accurate Long Balls') || n(at, 'Long Balls')
    const lbTH = n(ht, 'Total Long Balls') || lbH
    const lbTA = n(at, 'Total Long Balls') || lbA

    const xgH = n(ht, 'expected_goals') || n(ht, 'Expected Goals')
    const xgA = n(at, 'expected_goals') || n(at, 'Expected Goals')

    const dwH = n(ht, 'Duels won'), dwA = n(at, 'Duels won')
    const dtH = n(ht, 'Total Duels') || (dwH + dwA), dtA = n(at, 'Total Duels') || (dwH + dwA)
    const adwH = n(ht, 'Aerials won') || n(ht, 'Aerial Duels won')
    const adwA = n(at, 'Aerials won') || n(at, 'Aerial Duels won')
    const adtH = n(ht, 'Total Aerials') || (adwH + adwA), adtA = n(at, 'Total Aerials') || (adwH + adwA)

    const totalPassH = n(ht, 'Total passes'), totalPassA = n(at, 'Total passes')
    const shotsTotH = n(ht, 'Total Shots'), shotsTotA = n(at, 'Total Shots')
    const cornersH = n(ht, 'Corner Kicks'), cornersA = n(at, 'Corner Kicks')

    // Nếu không có bất kỳ dữ liệu chuyền bóng, sút hay phạt góc nào, đây là giải đấu không có live stats
    if (totalPassH === 0 && totalPassA === 0 && shotsTotH === 0 && shotsTotA === 0 && cornersH === 0 && cornersA === 0 && possH === 0 && possA === 0) {
        return { detailed: null, raw: list }
    }

    const detailed: DetailedMatchStatistics = {
        possession: { home: possH, away: possA },
        totalPasses: { home: totalPassH, away: totalPassA },
        accuratePasses: { homeCount: passH, homePct: passPctH, awayCount: passA, awayPct: passPctA },
        accurateCrosses: {
            homeCount: crossH, homePct: crossTH > 0 ? Math.round(crossH / crossTH * 100) : 0,
            awayCount: crossA, awayPct: crossTA > 0 ? Math.round(crossA / crossTA * 100) : 0,
        },
        accurateLongBalls: {
            homeCount: lbH, homePct: lbTH > 0 ? Math.round(lbH / lbTH * 100) : 0,
            awayCount: lbA, awayPct: lbTA > 0 ? Math.round(lbA / lbTA * 100) : 0,
        },
        shotsTotal: { home: n(ht, 'Total Shots'), away: n(at, 'Total Shots') },
        shotsOnGoal: { home: n(ht, 'Shots on Goal'), away: n(at, 'Shots on Goal') },
        shotsOffGoal: { home: n(ht, 'Shots off Goal'), away: n(at, 'Shots off Goal') },
        shotsBlocked: { home: n(ht, 'Blocked Shots'), away: n(at, 'Blocked Shots') },
        shotsInsideBox: { home: n(ht, 'Shots insidebox'), away: n(at, 'Shots insidebox') },
        shotsOutsideBox: { home: n(ht, 'Shots outsidebox'), away: n(at, 'Shots outsidebox') },
        penalties: { home: n(ht, 'Penalties') || n(ht, 'Penalty'), away: n(at, 'Penalties') || n(at, 'Penalty') },
        keyPasses: { home: n(ht, 'Key Passes') || n(ht, 'Key passes'), away: n(at, 'Key Passes') || n(at, 'Key passes') },
        duelsWon: {
            homeCount: dwH, homePct: dtH > 0 ? Math.round((dwH / dtH) * 100) : 50,
            awayCount: dwA, awayPct: dtA > 0 ? Math.round((dwA / dtA) * 100) : 50,
        },
        aerialDuelsWon: {
            homeCount: adwH, homePct: adtH > 0 ? Math.round((adwH / adtH) * 100) : 50,
            awayCount: adwA, awayPct: adtA > 0 ? Math.round((adwA / adtA) * 100) : 50,
        },
        goalkeeperSaves: { home: n(ht, 'Goalkeeper Saves') || n(ht, 'Saves'), away: n(at, 'Goalkeeper Saves') || n(at, 'Saves') },
        ...(xgH > 0 || xgA > 0 ? { expectedGoals: { home: xgH, away: xgA } } : {}),
        corners: { home: n(ht, 'Corner Kicks'), away: n(at, 'Corner Kicks') },
        fouls: { home: n(ht, 'Fouls'), away: n(at, 'Fouls') },
        yellowCards: { home: n(ht, 'Yellow Cards'), away: n(at, 'Yellow Cards') },
        redCards: { home: n(ht, 'Red Cards'), away: n(at, 'Red Cards') },
        offsides: { home: n(ht, 'Offsides'), away: n(at, 'Offsides') },
        tackles: { home: n(ht, 'Tackles'), away: n(at, 'Tackles') },
        interceptions: { home: n(ht, 'Interceptions') || n(ht, 'Interception'), away: n(at, 'Interceptions') || n(at, 'Interception') },
        clearances: { home: n(ht, 'Clearances') || n(ht, 'Clearance'), away: n(at, 'Clearances') || n(at, 'Clearance') },
    }

    return { detailed, raw: list }
}

/**
 * Lấy phong độ 5 trận gần nhất của một đội từ API-Football:
 * Endpoint: /fixtures?team={teamId}&last=5&status=FT
 * Trả về mảng 5 ký tự ['W', 'D', 'L', ...], cache 24h (86400s)
 */
export async function getTeamRecentForm(teamId: number): Promise<string[]> {
    if (!teamId || teamId <= 0) return []
    try {
        const list = await fetchApiFootball<ApiFootballFixtureItem[]>(
            'fixtures',
            { team: teamId, last: 5, status: 'FT' },
            86400,
        )
        if (!list || !Array.isArray(list) || list.length === 0) return []

        const form: string[] = []
        for (const item of list) {
            const isHome = item.teams?.home?.id === teamId
            const myGoals = isHome
                ? Number(item.goals?.home ?? item.score?.fulltime?.home ?? 0)
                : Number(item.goals?.away ?? item.score?.fulltime?.away ?? 0)
            const oppGoals = isHome
                ? Number(item.goals?.away ?? item.score?.fulltime?.away ?? 0)
                : Number(item.goals?.home ?? item.score?.fulltime?.home ?? 0)

            if (myGoals > oppGoals) {
                form.push('W')
            } else if (myGoals === oppGoals) {
                form.push('D')
            } else {
                form.push('L')
            }
        }
        return form.slice(0, 5)
    } catch {
        return []
    }
}

export const fetchTeamRecentForm = getTeamRecentForm

/**
 * Trích xuất các sự kiện diễn biến trong trận từ API-Football /fixtures/events
 */
export async function extractFixtureEvents(
    fixtureId: number,
    homeTeamId?: number,
    isFinished = false,
): Promise<FootballIncident[]> {
    const ttl = isFinished ? 86400 : 30
    const list = await fetchApiFootball<ApiFootballEventItem[]>('fixtures/events', { fixture: fixtureId }, ttl)
    if (!list || !Array.isArray(list)) return []

    const incidents: FootballIncident[] = []

    for (const item of list) {
        const isHome = homeTeamId ? item.team?.id === homeTeamId : true
        const typeLower = (item.type || '').toLowerCase()
        const detail = item.detail || ''

        let incidentType: FootballIncident['incidentType'] = 'attack'
        let text = detail

        if (typeLower === 'goal') {
            incidentType = 'goal'
            text = detail.toLowerCase().includes('penalty') ? 'Bàn thắng (Penalty)' : 'Bàn thắng'
        } else if (typeLower === 'card') {
            incidentType = 'card'
            text = detail.toLowerCase().includes('red') ? 'Thẻ đỏ' : 'Thẻ vàng'
        } else if (typeLower === 'subst') {
            incidentType = 'sub'
            text = 'Thay người'
        } else if (typeLower === 'var') {
            incidentType = 'var'
            text = `VAR: ${detail}`
        }

        incidents.push({
            incidentType,
            isHome,
            time: item.time?.elapsed || 0,
            addedTime: item.time?.extra ?? undefined,
            text,
            player: item.player?.name ? { name: item.player.name } : undefined,
            detail,
        })
    }

    return incidents
}

/**
 * Trích xuất các sự kiện diễn biến chi tiết trong trận theo format MatchEventItem
 * Dùng cho component Timeline sự kiện (Bàn thắng, thẻ phạt, thay người, VAR, mốc HT/FT).
 */
export async function extractStructuredFixtureEvents(
    fixtureId: number,
    homeTeamId?: number,
    isFinished = false,
): Promise<MatchEventItem[]> {
    const ttl = isFinished ? 86400 : 30
    const list = await fetchApiFootball<ApiFootballEventItem[]>('fixtures/events', { fixture: fixtureId }, ttl)
    if (!list || !Array.isArray(list)) return []

    // Sắp xếp thứ tự thời gian tăng dần
    const sorted = [...list].sort((a, b) => {
        const timeA = (a.time?.elapsed || 0) + (a.time?.extra || 0) * 0.1
        const timeB = (b.time?.elapsed || 0) + (b.time?.extra || 0) * 0.1
        return timeA - timeB
    })

    const events: MatchEventItem[] = []
    let scoreHome = 0
    let scoreAway = 0

    for (const item of sorted) {
        const isHome = homeTeamId ? item.team?.id === homeTeamId : true
        const typeLower = (item.type || '').toLowerCase()
        const detail = item.detail || ''
        const detailLower = detail.toLowerCase()

        let formattedType = typeLower
        let formattedDetail = detail
        let playerIn: string | undefined = undefined
        let playerOut: string | undefined = undefined
        let currentScoreStr: string | undefined = undefined

        if (typeLower === 'goal') {
            if (detailLower.includes('missed')) {
                formattedType = 'goal_missed'
                formattedDetail = 'Sút hỏng phạt đền'
            } else if (detailLower.includes('own goal')) {
                formattedType = 'goal'
                formattedDetail = 'Bàn thắng (Phản lưới nhà)'
                if (isHome) scoreAway++
                else scoreHome++
                currentScoreStr = `${scoreHome} - ${scoreAway}`
            } else if (detailLower.includes('penalty')) {
                formattedType = 'goal'
                formattedDetail = 'Bàn thắng (Pen)'
                if (isHome) scoreHome++
                else scoreAway++
                currentScoreStr = `${scoreHome} - ${scoreAway}`
            } else {
                formattedType = 'goal'
                formattedDetail = 'Bàn thắng'
                if (isHome) scoreHome++
                else scoreAway++
                currentScoreStr = `${scoreHome} - ${scoreAway}`
            }
        } else if (typeLower === 'card') {
            formattedType = 'card'
            formattedDetail = detailLower.includes('red') ? 'Thẻ đỏ' : 'Thẻ vàng'
        } else if (typeLower === 'subst') {
            formattedType = 'subst'
            formattedDetail = 'Thay người'
            playerOut = item.player?.name || undefined
            playerIn = item.assist?.name || undefined
        } else if (typeLower === 'var') {
            formattedType = 'var'
            formattedDetail = `VAR: ${detail}`
        }

        events.push({
            time: item.time?.elapsed || 0,
            addedTime: item.time?.extra ?? undefined,
            type: formattedType,
            detail: formattedDetail,
            isHome,
            teamName: item.team?.name,
            teamLogo: item.team?.logo,
            player: item.player?.name || undefined,
            assist: item.assist?.name || undefined,
            score: currentScoreStr,
            playerIn,
            playerOut,
            comments: item.comments || undefined,
        })
    }

    return events
}

/**
 * Lấy trạng thái thời gian thực của trận đấu từ API-Football (100% dữ liệu thật, One-shot Snapshot).
 */
export async function getMatchLiveStatus(
    home: string,
    away: string,
    preferredFixtureId?: number,
): Promise<LiveMatchData> {
    const emptyResult: LiveMatchData = {
        found: false,
        score: { home: 0, away: 0 },
        corners: { home: 0, away: 0, total: 0 },
        cards: { yellowHome: 0, yellowAway: 0, redHome: 0, redAway: 0 },
        shotsOnTarget: { home: 0, away: 0 },
        shotsTotal: { home: 0, away: 0 },
        possession: { home: 50, away: 50 },
        fouls: { home: 0, away: 0 },
        isFinished: false,
        lastUpdated: Date.now(),
    }

    if (!home && !away && (!preferredFixtureId || preferredFixtureId <= 0)) {
        return emptyResult
    }

    const item = await findFixture(home, away, preferredFixtureId)
    if (!item) {
        return emptyResult
    }

    const fix = item.fixture
    const statusShort = (fix.status?.short || '').toUpperCase()
    const statusLong = fix.status?.long || ''

    // Các trạng thái kết thúc chính thức: FT (Full Time), AET, PEN
    const isFinished = ['FT', 'AET', 'PEN', 'PPD', 'CANC', 'ABD', 'AWD', 'WO'].includes(statusShort)
    const isLive = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE'].includes(statusShort)

    const homeScoreVal = Number(item.goals?.home ?? item.score?.fulltime?.home ?? 0)
    const awayScoreVal = Number(item.goals?.away ?? item.score?.fulltime?.away ?? 0)

    const htHome = item.score?.halftime?.home ?? undefined
    const htAway = item.score?.halftime?.away ?? undefined
    const ftHome = isFinished ? homeScoreVal : undefined
    const ftAway = isFinished ? awayScoreVal : undefined

    let minute: number | string = '—'
    if (isFinished) {
        minute = 'FT'
    } else if (statusShort === 'HT') {
        minute = 'HT'
    } else if (fix.status?.elapsed != null) {
        let el = Number(fix.status.elapsed)
        if (el > 100 && statusShort !== 'AET' && statusShort !== 'PEN') {
            el = 90
        }
        minute = el
    } else {
        minute = statusShort || 'NS'
    }

    const kickoff = fix.date
    const kickoffTimestamp = fix.timestamp
        ? fix.timestamp * 1000
        : fix.date
            ? new Date(fix.date).getTime()
            : Date.now()
    const homeId = item.teams?.home?.id
    const awayId = item.teams?.away?.id

    // Lấy thống kê chi tiết trận đấu và phong độ 5 trận gần nhất
    const [stats, homeForm, awayForm] = await Promise.all([
        extractFixtureStatistics(fix.id, isFinished),
        homeId ? getTeamRecentForm(homeId) : Promise.resolve([]),
        awayId ? getTeamRecentForm(awayId) : Promise.resolve([]),
    ])

    return {
        found: true,
        eventId: fix.id,
        fixtureId: fix.id,
        homeTeam: item.teams?.home?.name || home,
        awayTeam: item.teams?.away?.name || away,
        homeLogo: item.teams?.home?.logo,
        awayLogo: item.teams?.away?.logo,
        homeTeamId: homeId,
        awayTeamId: awayId,
        homeForm: homeForm,
        awayForm: awayForm,
        league: item.league?.name,
        kickoff,
        kickoffTimestamp,
        status: isFinished ? 'finished' : isLive ? 'inprogress' : 'notstarted',
        statusDescription: statusLong || statusShort,
        minute,
        score: { home: homeScoreVal, away: awayScoreVal },
        periodScore: { htHome, htAway, ftHome, ftAway },
        corners: stats.corners,
        cards: stats.cards,
        shotsOnTarget: stats.shotsOnTarget,
        shotsTotal: stats.shotsTotal,
        possession: stats.possession,
        fouls: stats.fouls,
        accuratePasses: stats.accuratePasses,
        isFinished,
        lastUpdated: Date.now(),
    }
}

export interface DetailedH2HResult extends H2HResult {
    matches: MatchRecord[]
    status: ProviderStatusCode
    errorMessage?: string
    fetchedAt: string
}

/**
 * Lấy lịch sử đối đầu (H2H) từ API-Football:
 * Endpoint: /fixtures/headtohead?h2h={team1}-{team2}
 */
export async function getFixtureH2H(
    team1Id: number,
    team2Id: number,
    options: {
        kickoff?: string | null
        forceRefresh?: boolean
        auditLogger?: (log: ExternalCallLog) => void
    } = {},
): Promise<DetailedH2HResult> {
    const fetchedAt = new Date().toISOString()
    const emptyResult: DetailedH2HResult = {
        eventId: 0,
        events: [],
        matches: [],
        h2hText: 'THỰC TẾ LỊCH SỬ ĐỐI ĐẦU (H2H API-Football):\n- Chưa có dữ liệu đối đầu gần đây trên API-Football.',
        n: 0,
        avgGoals: 0,
        bttsRate: 0,
        status: 'EMPTY',
        fetchedAt,
    }

    if (!team1Id || !team2Id) {
        return { ...emptyResult, status: 'NOT_CALLED' }
    }

    const pair = `${team1Id}-${team2Id}`
    const callRes = await fetchApiFootballDetailed<ApiFootballFixtureItem[]>('fixtures/headtohead', {
        params: { h2h: pair },
        ttlSec: TTL_MATCH_RESULTS,
        forceRefresh: options.forceRefresh,
        kickoff: options.kickoff,
        purpose: `h2h_${team1Id}_vs_${team2Id}`,
        auditLogger: options.auditLogger,
    })

    if (!callRes.success || !callRes.data || !Array.isArray(callRes.data)) {
        return {
            ...emptyResult,
            status: callRes.status,
            errorMessage: callRes.errorMessage,
            fetchedAt: callRes.fetchedAt,
        }
    }

    const list = callRes.data.slice(0, 10)
    if (list.length === 0) {
        return { ...emptyResult, status: 'EMPTY', fetchedAt: callRes.fetchedAt }
    }

    let totalGoals = 0
    let bttsCount = 0
    const lines: string[] = ['THỰC TẾ LỊCH SỬ ĐỐI ĐẦU (H2H API-Football):']
    const matches: MatchRecord[] = []

    for (const item of list) {
        const dateStr = item.fixture?.date ? item.fixture.date.split('T')[0] : 'Gần đây'
        const league = item.league?.name || 'League'
        const hName = item.teams?.home?.name || 'Home'
        const aName = item.teams?.away?.name || 'Away'

        const ftHome = Number(item.goals?.home ?? item.score?.fulltime?.home ?? 0)
        const ftAway = Number(item.goals?.away ?? item.score?.fulltime?.away ?? 0)
        const htHome = Number(item.score?.halftime?.home ?? 0)
        const htAway = Number(item.score?.halftime?.away ?? 0)

        totalGoals += ftHome + ftAway
        if (ftHome > 0 && ftAway > 0) {
            bttsCount++
        }

        lines.push(`- ${dateStr} ${league}: ${hName} ${ftHome} - ${ftAway} ${aName} (HT: ${htHome} - ${htAway})`)

        const rec = fixtureToMatchRecord(item, callRes.fetchedAt)
        if (rec) matches.push(rec)
    }

    const n = list.length
    const avgGoals = Number((totalGoals / n).toFixed(2))
    const bttsRate = Number((bttsCount / n).toFixed(2))

    return {
        eventId: list[0]?.fixture?.id || 0,
        events: list,
        matches,
        h2hText: lines.join('\n'),
        n,
        avgGoals,
        bttsRate,
        status: 'OK',
        fetchedAt: callRes.fetchedAt,
    }
}

/**
 * Tìm kiếm trận đấu trên API-Football dựa theo từ khóa hoặc tên 2 đội.
 */
export async function searchFootballMatch(
    query: string,
    home?: string,
    away?: string,
): Promise<{ fixtureId: number; fixture: ApiFootballFixtureItem } | null> {
    const h = home?.trim() || ''
    const a = away?.trim() || ''

    if (h && a) {
        const item = await findFixture(h, a)
        if (item) {
            return { fixtureId: item.fixture.id, fixture: item }
        }
    }

    if (query.trim()) {
        const parts = query.trim().split(/\s+(?:vs|v|-)\s+/i)
        if (parts.length === 2) {
            const item = await findFixture(parts[0], parts[1])
            if (item) {
                return { fixtureId: item.fixture.id, fixture: item }
            }
        }
    }

    return null
}

/**
 * Kiểm tra kết nối API-Football (dùng cho nút Self-Test).
 */
export async function testApiFootballConnection(): Promise<{
    success: boolean
    latencyMs: number
    quota?: ApiFootballQuota
    error?: string
}> {
    const startTime = Date.now()
    try {
        const res = await fetchApiFootballDetailed('status', { ttlSec: 0, forceRefresh: true, purpose: 'self_test' })
        if (!res.success) {
            return {
                success: false,
                latencyMs: Date.now() - startTime,
                quota: getApiFootballQuota(),
                error: res.errorMessage || 'Không thể kết nối API-Football',
            }
        }
        return {
            success: true,
            latencyMs: Date.now() - startTime,
            quota: getApiFootballQuota(),
        }
    } catch (e) {
        return {
            success: false,
            latencyMs: Date.now() - startTime,
            quota: getApiFootballQuota(),
            error: e instanceof Error ? e.message : String(e),
        }
    }
}
