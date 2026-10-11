/**
 * Client gọi API của backend.
 * - KHÔNG lưu token ở localStorage/sessionStorage. Access/refresh nằm trong cookie HttpOnly.
 * - CSRF token lấy từ cookie fq_csrf (đọc được) và gửi qua header x-csrf-token.
 */

import type {
    ActualResult,
    AnalysisResult,
    CalibrationBin,
    OddsLine,
    Pick,
    SettledPick,
} from './types'

const BASE = '/api'

export class ApiError extends Error {
    status: number
    data: unknown
    constructor(status: number, message: string, data?: unknown) {
        super(message)
        this.status = status
        this.data = data
    }
}

function readCsrfToken(): string | undefined {
    const m = document.cookie.match(/(?:^|;\s*)fq_csrf=([^;]+)/)
    return m ? decodeURIComponent(m[1]) : undefined
}

let refreshPromise: Promise<boolean> | null = null

/** Gọi /api/auth/refresh, gộp nhiều request đồng thời vào một lần. */
async function doRefresh(): Promise<boolean> {
    if (!refreshPromise) {
        refreshPromise = fetch(`${BASE}/auth/refresh`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'x-csrf-token': readCsrfToken() ?? '' },
        })
            .then((r) => r.ok)
            .catch(() => false)
            .finally(() => {
                // Cho phép lần refresh kế tiếp chạy lại
                setTimeout(() => {
                    refreshPromise = null
                }, 0)
            })
    }
    return refreshPromise
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
    body?: unknown
    /** Bỏ qua bước tự refresh khi gặp 401 (dùng cho chính endpoint refresh). */
    skipRefresh?: boolean
}

export async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const { body, skipRefresh, headers, ...rest } = opts

    const send = async (): Promise<Response> => {
        const h = new Headers(headers)
        if (body !== undefined && !(body instanceof FormData)) {
            h.set('Content-Type', 'application/json')
        }
        const csrf = readCsrfToken()
        if (csrf) h.set('x-csrf-token', csrf)

        return fetch(`${BASE}${path}`, {
            ...rest,
            headers: h,
            credentials: 'include',
            body:
                body === undefined
                    ? undefined
                    : body instanceof FormData
                        ? body
                        : JSON.stringify(body),
        })
    }

    let res = await send()

    // Access token hết hạn (15 phút) → refresh một lần rồi thử lại
    if (res.status === 401 && !skipRefresh) {
        const ok = await doRefresh()
        if (ok) res = await send()
    }

    if (!res.ok) {
        let payload: { message?: string; error?: string } | null = null
        try {
            payload = await res.json()
        } catch {
            /* ignore */
        }
        const msg =
            payload?.message ??
            (payload?.error === 'validation'
                ? 'Dữ liệu gửi lên không hợp lệ.'
                : `Lỗi ${res.status}`)
        throw new ApiError(res.status, msg, payload)
    }

    if (res.status === 204) return undefined as T
    return (await res.json()) as T
}

// ---------------------------------------------------------------------------
// Kiểu dữ liệu trả về (khớp với server/store.ts)
// ---------------------------------------------------------------------------

export interface AuthUser {
    userId: string
    email: string
    role: 'user' | 'admin'
    bankroll: number
    createdAt: number
}

export interface MeResponse {
    user: AuthUser
}

/** Một bản ghi lịch sử phân tích. */
export interface HistoryItem {
    id: string
    createdAt: number
    meta: {
        home: string
        away: string
        league?: string
        kickoff?: string | null
    }
    analysis: AnalysisResult
    picks: Pick[]
    result: (ActualResult & { note?: string }) | null
}

export interface StatsResponse {
    settled: SettledPick[]
    profit: number
    calibration: CalibrationBin[]
}

export interface AnalyzePayload {
    home: string
    away: string
    league?: string
    kickoff?: string | null
    lg_home?: number
    lg_away?: number
    oddsLines: OddsLine[]
}

/** Một dòng kèo Gemini đọc được từ ảnh, kèm mức tin cậy của model. */
export interface ExtractedRow {
    kind: 'totals' | 'ah'
    side: 'over' | 'under' | 'home' | 'away'
    line: number
    odds: number
    /** 0..1 — dưới 0.8 UI sẽ cảnh báo người dùng kiểm tra lại. */
    confidence: number
    note?: string
}

export interface ExtractResponse {
    rows: ExtractedRow[]
    meta: {
        home?: string
        away?: string
        league?: string
        kickoff?: string | null
        confidence?: number
    }
    lowConfidence: boolean
    note?: string
    model: string
}

// ---------------------------------------------------------------------------
// Endpoint helpers
// ---------------------------------------------------------------------------

export const api = {
    login: (email: string, password: string) =>
        apiFetch<{ user: AuthUser; csrfToken: string }>('/auth/login', {
            method: 'POST',
            body: { email, password },
            skipRefresh: true,
        }),

    signup: (email: string, password: string) =>
        apiFetch<{ user: AuthUser; csrfToken: string }>('/auth/signup', {
            method: 'POST',
            body: { email, password },
            skipRefresh: true,
        }),

    logout: () => apiFetch<{ ok: true }>('/auth/logout', { method: 'POST' }),

    logoutAll: () => apiFetch<{ ok: true }>('/auth/logout-all', { method: 'POST' }),

    me: () => apiFetch<MeResponse>('/me'),

    updateMe: (bankroll: number) =>
        apiFetch<MeResponse>('/me', { method: 'PATCH', body: { bankroll } }),

    analyze: (payload: AnalyzePayload) =>
        apiFetch<{ result: AnalysisResult; recordId: string }>('/analyze', {
            method: 'POST',
            body: payload,
        }),

    history: (limit = 100) => apiFetch<{ items: HistoryItem[] }>(`/history?limit=${limit}`),

    settle: (payload: {
        id: string
        htHome?: number
        htAway?: number
        ftHome: number
        ftAway: number
    }) => apiFetch<{ item: HistoryItem }>('/settle', { method: 'POST', body: payload }),

    deleteHistory: (id: string) => apiFetch<{ ok: true }>(`/history/${id}`, { method: 'DELETE' }),

    stats: () => apiFetch<StatsResponse>('/stats'),

    suggestedLines: () => apiFetch<{ lines: OddsLine[] }>('/suggested-lines'),

    /** Gửi ảnh bảng kèo lên server để Gemini đọc (G3). */
    extract: (files: File[], hint: { home?: string; away?: string; league?: string }) => {
        const fd = new FormData()
        for (const f of files) fd.append('images', f)
        if (hint.home) fd.append('home', hint.home)
        if (hint.away) fd.append('away', hint.away)
        if (hint.league) fd.append('league', hint.league)
        return apiFetch<ExtractResponse>('/extract', { method: 'POST', body: fd })
    },
}
