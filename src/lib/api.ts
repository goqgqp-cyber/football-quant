/**
 * Client gọi API của backend.
 * - KHÔNG lưu token ở localStorage/sessionStorage. Access/refresh nằm trong cookie HttpOnly.
 * - CSRF token lấy từ cookie fq_csrf (đọc được) và gửi qua header x-csrf-token.
 */

import type {
    ActualResult,
    AnalysisResult,
    CalibrationBin,
    Explanation,
    MatchData,
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

/** Sự kiện phát ra từ `POST /api/collect/stream` (SSE). */
export type CollectEvent =
    | { type: 'step'; id: string; status: 'active' | 'done' | 'error' }
    | { type: 'delta'; text: string }
    | { type: 'data'; matchData: MatchData }
    | { type: 'explanation'; explanation: Explanation }
    | { type: 'result'; result: AnalysisResult; recordId: string }
    | { type: 'error'; message: string }

/**
 * Chạy Bước A + tính toán qua SSE. Không dùng EventSource vì cần gửi
 * header CSRF và body JSON; thay vào đó đọc ReadableStream của fetch.
 *
 * @returns hàm huỷ (abort) để người dùng có thể dừng giữa chừng.
 */
export function collectStream(
    payload: AnalyzePayload,
    onEvent: (e: CollectEvent) => void,
): { abort: () => void } {
    const controller = new AbortController()

    const run = async () => {
        let res: Response
        try {
            res = await fetch(`${BASE}/collect/stream`, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': readCsrfToken() ?? '',
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            })
        } catch (e) {
            if (!controller.signal.aborted) {
                onEvent({ type: 'error', message: 'Không kết nối được máy chủ.' })
            }
            void e
            return
        }

        if (!res.ok || !res.body) {
            let msg = `Lỗi ${res.status}`
            try {
                const j = (await res.json()) as { message?: string }
                if (j.message) msg = j.message
            } catch {
                /* ignore */
            }
            onEvent({ type: 'error', message: msg })
            return
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        try {
            for (; ;) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })

                let idx: number
                // SSE: các khối ngăn cách bởi dòng trống
                while ((idx = buffer.indexOf('\n\n')) !== -1) {
                    const block = buffer.slice(0, idx)
                    buffer = buffer.slice(idx + 2)

                    let eventName = 'message'
                    let dataLine = ''
                    for (const raw of block.split('\n')) {
                        const line = raw.trimEnd()
                        if (line.startsWith('event:')) eventName = line.slice(6).trim()
                        else if (line.startsWith('data:')) dataLine += line.slice(5).trim()
                    }
                    if (!dataLine) continue

                    let parsed: unknown
                    try {
                        parsed = JSON.parse(dataLine)
                    } catch {
                        continue
                    }
                    const o = parsed as Record<string, unknown>
                    switch (eventName) {
                        case 'step':
                            onEvent({
                                type: 'step',
                                id: String(o.id ?? ''),
                                status: (o.status as 'active' | 'done' | 'error') ?? 'active',
                            })
                            break
                        case 'delta':
                            onEvent({ type: 'delta', text: String(o.text ?? '') })
                            break
                        case 'data':
                            onEvent({ type: 'data', matchData: o.matchData as MatchData })
                            break
                        case 'explanation':
                            onEvent({
                                type: 'explanation',
                                explanation: o.explanation as Explanation,
                            })
                            break
                        case 'result':
                            onEvent({
                                type: 'result',
                                result: o.result as AnalysisResult,
                                recordId: String(o.recordId ?? ''),
                            })
                            break
                        case 'error':
                            onEvent({ type: 'error', message: String(o.message ?? 'Lỗi không xác định.') })
                            break
                    }
                }
            }
        } catch (e) {
            if (!controller.signal.aborted) {
                onEvent({
                    type: 'error',
                    message: e instanceof Error ? e.message : 'Luồng bị ngắt.',
                })
            }
        }
    }

    void run()
    return { abort: () => controller.abort() }
}

/**
 * Bọc fetch với timeout để KHÔNG BAO GIỜ treo vô hạn.
 * Nếu máy chủ không phản hồi (mạng đứng / function lỗi), promise sẽ reject
 * sau `ms` — nhờ đó UI luôn thoát khỏi trạng thái "đang tải".
 */
async function fetchWithTimeout(
    input: string,
    init: RequestInit = {},
    ms = 20000,
): Promise<Response> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), ms)
    try {
        return await fetch(input, { ...init, signal: ctrl.signal })
    } finally {
        clearTimeout(timer)
    }
}

/** Gọi /api/auth/refresh, gộp nhiều request đồng thời vào một lần. */
async function doRefresh(): Promise<boolean> {
    if (!refreshPromise) {
        refreshPromise = fetchWithTimeout(
            `${BASE}/auth/refresh`,
            {
                method: 'POST',
                credentials: 'include',
                headers: { 'x-csrf-token': readCsrfToken() ?? '' },
            },
            8000,
        )
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
    /** Thời gian chờ tối đa (ms) trước khi huỷ request. Mặc định 20s. */
    timeoutMs?: number
}

export async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const { body, skipRefresh, timeoutMs = 20000, headers, ...rest } = opts

    const send = async (): Promise<Response> => {
        const h = new Headers(headers)
        if (body !== undefined && !(body instanceof FormData)) {
            h.set('Content-Type', 'application/json')
        }
        const csrf = readCsrfToken()
        if (csrf) h.set('x-csrf-token', csrf)

        return fetchWithTimeout(
            `${BASE}${path}`,
            {
                ...rest,
                headers: h,
                credentials: 'include',
                body:
                    body === undefined
                        ? undefined
                        : body instanceof FormData
                            ? body
                            : JSON.stringify(body),
            },
            timeoutMs,
        )
    }

    let res: Response
    try {
        res = await send()
    } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
            throw new ApiError(408, 'Máy chủ không phản hồi (hết thời gian chờ).')
        }
        throw new ApiError(0, 'Không kết nối được máy chủ.')
    }

    // Access token hết hạn (15 phút) → refresh một lần rồi thử lại
    if (res.status === 401 && !skipRefresh) {
        const ok = await doRefresh()
        if (ok) {
            try {
                res = await send()
            } catch {
                throw new ApiError(0, 'Không kết nối được máy chủ.')
            }
        }
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
    /** Văn giải thích 4 phần (Bước C) — null nếu chưa/bỏ qua. */
    explanation?: Explanation | null
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
