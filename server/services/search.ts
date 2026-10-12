/**
 * Multi-Tier Search Failover Service (Serper -> Tavily -> Brave -> DuckDuckGo)
 * ─────────────────────────────────────────────────────────────────────────────
 * Cung cấp cơ chế tìm kiếm 4 tầng dạng thác nước (waterfall cascade) phục vụ
 * đối soát dữ liệu bóng đá thời gian thực (real-time match grounding:
 * đội hình xuất phát, chấn thương, tin tức lực lượng).
 *
 * Quy chuẩn thác nước:
 * 1. Tier 1: Serper (Google Search API)
 * 2. Tier 2: Tavily (AI Search Engine API)
 * 3. Tier 3: Brave (Brave Web Search API)
 * 4. Tier 4: DuckDuckGo (Không cần API key, zero-quota resilient fallback)
 *
 * Điều kiện tự động nhảy cấp (seamless failover):
 * - Quá thời gian 6s (6000ms timeout)
 * - Lỗi HTTP 429 (Rate limit / Quota exhausted)
 * - Lỗi HTTP 401 / 403 (Unauthorized / Forbidden / Hết credit)
 * - Mọi mã lỗi HTTP 5xx hoặc network error
 * - Không có kết quả tìm kiếm (empty results)
 */

import { env } from '../env.js'
import type { Source } from '../../src/lib/types.js'

export type SearchProvider = 'serper' | 'tavily' | 'brave' | 'duckduckgo'

export interface SearchResultItem {
    title: string
    url: string
    snippet: string
    publishedDate?: string
    provider: SearchProvider
}

export interface FallbackAttempt {
    provider: SearchProvider
    tier: number
    reason: string
    statusCode?: number
    latencyMs: number
}

export interface SearchGroundingResponse {
    provider: SearchProvider
    tier: 1 | 2 | 3 | 4
    query: string
    results: SearchResultItem[]
    latencyMs: number
    fallbacksAttempted: FallbackAttempt[]
    groundingText: string
    sources: Source[]
    lineupConfirmedHint: boolean
    injuriesHint: string[]
}

const PROVIDER_TIMEOUT_MS = 6000

// Bộ nhớ cache tạm thời (10 phút) tránh gọi trùng lặp khi người dùng chuyển tab nhanh
interface CacheEntry {
    data: SearchGroundingResponse
    expiresAt: number
}
const searchCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 10 * 60 * 1000

function decodeHtmlEntities(str: string): string {
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/<[^>]+>/g, '')
        .trim()
}

/**
 * Tạo fetch có timeout tối đa 6 giây.
 */
async function fetchWith6sTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS)
    try {
        const res = await fetch(url, {
            ...init,
            signal: controller.signal,
        })
        return res
    } finally {
        clearTimeout(timer)
    }
}

// ============================================================================
// TIER 1: SERPER (Google Search API)
// ============================================================================
async function searchSerper(query: string, apiKey: string): Promise<SearchResultItem[]> {
    if (!apiKey) {
        throw new Error('SERPER_API_KEY is not configured')
    }

    const res = await fetchWith6sTimeout('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
            'X-API-KEY': apiKey.trim(),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            q: query,
            num: 6,
            gl: 'en',
            hl: 'en',
        }),
    })

    if (!res.ok) {
        const errText = await res.text().catch(() => '')
        const err = new Error(`Serper HTTP ${res.status}: ${errText.slice(0, 150)}`)
        ;(err as unknown as { status: number }).status = res.status
        throw err
    }

    const data = (await res.json()) as {
        organic?: Array<{ title?: string; link?: string; snippet?: string; date?: string }>
        news?: Array<{ title?: string; link?: string; snippet?: string; date?: string }>
    }

    const items: SearchResultItem[] = []
    const combined = [...(data.organic || []), ...(data.news || [])]

    for (const item of combined) {
        if (item.title && item.link) {
            items.push({
                title: decodeHtmlEntities(item.title),
                url: item.link,
                snippet: decodeHtmlEntities(item.snippet || ''),
                publishedDate: item.date,
                provider: 'serper',
            })
        }
    }

    if (items.length === 0) {
        throw new Error('Serper returned 0 results')
    }

    return items
}

// ============================================================================
// TIER 2: TAVILY (AI Search Engine API)
// ============================================================================
async function searchTavily(query: string, apiKey: string): Promise<SearchResultItem[]> {
    if (!apiKey) {
        throw new Error('TAVILY_API_KEY is not configured')
    }

    const res = await fetchWith6sTimeout('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            api_key: apiKey.trim(),
            query,
            max_results: 6,
            search_depth: 'basic',
            include_answer: true,
        }),
    })

    if (!res.ok) {
        const errText = await res.text().catch(() => '')
        const err = new Error(`Tavily HTTP ${res.status}: ${errText.slice(0, 150)}`)
        ;(err as unknown as { status: number }).status = res.status
        throw err
    }

    const data = (await res.json()) as {
        results?: Array<{ title?: string; url?: string; content?: string }>
        answer?: string
    }

    const items: SearchResultItem[] = []
    if (data.answer) {
        items.push({
            title: 'Tavily AI Synthesis Answer',
            url: 'https://tavily.com',
            snippet: decodeHtmlEntities(data.answer),
            provider: 'tavily',
        })
    }

    for (const r of data.results || []) {
        if (r.title && r.url) {
            items.push({
                title: decodeHtmlEntities(r.title),
                url: r.url,
                snippet: decodeHtmlEntities(r.content || ''),
                provider: 'tavily',
            })
        }
    }

    if (items.length === 0) {
        throw new Error('Tavily returned 0 results')
    }

    return items
}

// ============================================================================
// TIER 3: BRAVE (Brave Web Search API)
// ============================================================================
async function searchBrave(query: string, apiKey: string): Promise<SearchResultItem[]> {
    if (!apiKey) {
        throw new Error('BRAVE_SEARCH_API_KEY is not configured')
    }

    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=6`
    const res = await fetchWith6sTimeout(url, {
        headers: {
            'X-Subscription-Token': apiKey.trim(),
            'Accept': 'application/json',
        },
    })

    if (!res.ok) {
        const errText = await res.text().catch(() => '')
        const err = new Error(`Brave HTTP ${res.status}: ${errText.slice(0, 150)}`)
        ;(err as unknown as { status: number }).status = res.status
        throw err
    }

    const data = (await res.json()) as {
        web?: {
            results?: Array<{
                title?: string
                url?: string
                description?: string
                page_age?: string
                age?: string
            }>
        }
    }

    const items: SearchResultItem[] = []
    for (const r of data.web?.results || []) {
        if (r.title && r.url) {
            items.push({
                title: decodeHtmlEntities(r.title),
                url: r.url,
                snippet: decodeHtmlEntities(r.description || ''),
                publishedDate: r.page_age || r.age,
                provider: 'brave',
            })
        }
    }

    if (items.length === 0) {
        throw new Error('Brave returned 0 results')
    }

    return items
}

// ============================================================================
// TIER 4: DUCKDUCKGO (Zero-Quota, Zero-Auth Fallback)
// ============================================================================
async function searchDuckDuckGo(query: string): Promise<SearchResultItem[]> {
    // Thử endpoint HTML chính thức trước
    try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
        const res = await fetchWith6sTimeout(url, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
        })

        if (res.ok) {
            const html = await res.text()
            const linkRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g
            const snippetRegex = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g

            const links: Array<{ url: string; title: string }> = []
            let m: RegExpExecArray | null
            while ((m = linkRegex.exec(html)) !== null) {
                let rawUrl = m[1]
                const uddgMatch = rawUrl.match(/uddg=([^&]+)/)
                if (uddgMatch) {
                    try {
                        rawUrl = decodeURIComponent(uddgMatch[1])
                    } catch {
                        /* giữ nguyên */
                    }
                }
                const title = decodeHtmlEntities(m[2])
                if (rawUrl && title) {
                    links.push({ url: rawUrl, title })
                }
            }

            const snippets: string[] = []
            while ((m = snippetRegex.exec(html)) !== null) {
                snippets.push(decodeHtmlEntities(m[1]))
            }

            if (links.length > 0) {
                const items: SearchResultItem[] = []
                for (let i = 0; i < Math.min(links.length, 6); i++) {
                    items.push({
                        title: links[i].title,
                        url: links[i].url,
                        snippet: snippets[i] || '',
                        provider: 'duckduckgo',
                    })
                }
                return items
            }
        }
    } catch {
        /* Chuyển qua lite/instant answer */
    }

    // Fallback 1: DuckDuckGo Lite
    try {
        const resLite = await fetchWith6sTimeout('https://lite.duckduckgo.com/lite/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            },
            body: `q=${encodeURIComponent(query)}`,
        })

        if (resLite.ok) {
            const liteHtml = await resLite.text()
            const linkRegex = /<a[^>]+class="result-link"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g
            const snipRegex = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g

            const links: Array<{ url: string; title: string }> = []
            let m: RegExpExecArray | null
            while ((m = linkRegex.exec(liteHtml)) !== null) {
                links.push({ url: m[1], title: decodeHtmlEntities(m[2]) })
            }
            const snips: string[] = []
            while ((m = snipRegex.exec(liteHtml)) !== null) {
                snips.push(decodeHtmlEntities(m[1]))
            }

            if (links.length > 0) {
                const items: SearchResultItem[] = []
                for (let i = 0; i < Math.min(links.length, 6); i++) {
                    items.push({
                        title: links[i].title,
                        url: links[i].url,
                        snippet: snips[i] || '',
                        provider: 'duckduckgo',
                    })
                }
                return items
            }
        }
    } catch {
        /* Chuyển qua Instant Answer */
    }

    // Fallback 2: DuckDuckGo Instant Answer API
    const resApi = await fetchWith6sTimeout(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`,
        {},
    )
    if (!resApi.ok) {
        throw new Error(`DuckDuckGo API HTTP ${resApi.status}`)
    }

    const data = (await resApi.json()) as {
        Heading?: string
        AbstractText?: string
        AbstractURL?: string
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>
    }

    const items: SearchResultItem[] = []
    if (data.AbstractText && data.AbstractURL) {
        items.push({
            title: data.Heading || query,
            url: data.AbstractURL,
            snippet: data.AbstractText,
            provider: 'duckduckgo',
        })
    }

    for (const topic of data.RelatedTopics || []) {
        if (topic.Text && topic.FirstURL) {
            items.push({
                title: topic.Text.slice(0, 80),
                url: topic.FirstURL,
                snippet: topic.Text,
                provider: 'duckduckgo',
            })
        }
    }

    if (items.length === 0) {
        throw new Error('DuckDuckGo returned 0 results')
    }

    return items
}

/**
 * Trích xuất các manh mối về chấn thương và đội hình chính thức từ kết quả tìm kiếm.
 */
function analyzeGroundingSnippets(items: SearchResultItem[]): {
    lineupConfirmed: boolean
    injuries: string[]
} {
    let lineupConfirmed = false
    const injuriesSet = new Set<string>()

    const confirmedPatterns = [
        /confirmed lineup/i,
        /confirmed starting xi/i,
        /official lineup/i,
        /starting xi announced/i,
        /đội hình chính thức/i,
        /đội hình ra sân chính thức/i,
        /team sheet confirmed/i,
    ]

    const injuryKeywords = [
        /(?:ruled out|sidelined|injured|injury|hamstring|knee|ankle|groin|suspended|doubtful|vắng mặt|chấn thương|treo giò)[\s\w,.'"-]{3,40}/gi,
    ]

    for (const item of items) {
        const text = `${item.title} ${item.snippet}`
        if (!lineupConfirmed && confirmedPatterns.some((p) => p.test(text))) {
            lineupConfirmed = true
        }

        for (const pattern of injuryKeywords) {
            const matches = text.match(pattern)
            if (matches) {
                for (const m of matches) {
                    const cleaned = m.replace(/[\r\n]+/g, ' ').trim()
                    if (cleaned.length > 5 && cleaned.length < 50) {
                        injuriesSet.add(cleaned)
                    }
                }
            }
        }
    }

    return {
        lineupConfirmed,
        injuries: Array.from(injuriesSet).slice(0, 10),
    }
}

/**
 * Format văn bản grounding súc tích, chuyên nghiệp cho engine & prompt Qwen.
 */
function buildGroundingText(
    provider: SearchProvider,
    tier: number,
    query: string,
    items: SearchResultItem[],
    analysis: { lineupConfirmed: boolean; injuries: string[] },
): string {
    const lines: string[] = [
        `[Search Grounding - Tier ${tier} (${provider.toUpperCase()})] Từ khóa: "${query}"`,
        `Trạng thái đội hình: ${analysis.lineupConfirmed ? 'ĐÃ CÔNG BỐ CHÍNH THỨC (Confirmed Starting XI)' : 'DỰ KIẾN (Predicted / Chưa công bố)'}`,
    ]

    if (analysis.injuries.length > 0) {
        lines.push(`Ghi nhận vắng mặt / chấn thương: ${analysis.injuries.join('; ')}`)
    }

    lines.push('Chi tiết nguồn tin đã xác thực:')
    items.slice(0, 5).forEach((item, idx) => {
        lines.push(
            `${idx + 1}. [${item.title}] (${item.url})\n   Trích đoạn: "${item.snippet.slice(0, 250)}"`,
        )
    })

    return lines.join('\n')
}

// ============================================================================
// MULTI-TIER SEARCH FAILOVER ORCHESTRATOR
// ============================================================================

export interface MultiTierSearchOptions {
    forceRefresh?: boolean
    league?: string
    kickoff?: string
}

/**
 * Thực hiện tìm kiếm 4 tầng dạng thác nước (Serper -> Tavily -> Brave -> DuckDuckGo).
 * Tự động chuyển cấp ngay lập tức nếu lỗi timeout 6s, 429, 401, 403 hoặc lỗi mạng.
 */
export async function performMultiTierSearch(
    query: string,
    options: MultiTierSearchOptions = {},
): Promise<SearchGroundingResponse> {
    const cleanQuery = query.trim()
    const cacheKey = cleanQuery.toLowerCase()

    if (!options.forceRefresh) {
        const cached = searchCache.get(cacheKey)
        if (cached && cached.expiresAt > Date.now()) {
            return cached.data
        }
    }

    const fallbacksAttempted: FallbackAttempt[] = []
    const startTime = Date.now()

    // Cấu hình 4 tầng thác nước
    const tiers: Array<{
        provider: SearchProvider
        tierNumber: 1 | 2 | 3 | 4
        execute: () => Promise<SearchResultItem[]>
    }> = [
        {
            provider: 'serper',
            tierNumber: 1,
            execute: () => searchSerper(cleanQuery, env.serperApiKey),
        },
        {
            provider: 'tavily',
            tierNumber: 2,
            execute: () => searchTavily(cleanQuery, env.tavilyApiKey),
        },
        {
            provider: 'brave',
            tierNumber: 3,
            execute: () => searchBrave(cleanQuery, env.braveApiKey),
        },
        {
            provider: 'duckduckgo',
            tierNumber: 4,
            execute: () => searchDuckDuckGo(cleanQuery),
        },
    ]

    for (const tier of tiers) {
        const tierStart = Date.now()
        try {
            const results = await tier.execute()
            if (results && results.length > 0) {
                const latencyMs = Date.now() - tierStart
                const analysis = analyzeGroundingSnippets(results)
                const groundingText = buildGroundingText(
                    tier.provider,
                    tier.tierNumber,
                    cleanQuery,
                    results,
                    analysis,
                )

                const sources: Source[] = results.map((r) => ({
                    url: r.url,
                    title: r.title,
                    fetched_at: new Date().toISOString(),
                }))

                const response: SearchGroundingResponse = {
                    provider: tier.provider,
                    tier: tier.tierNumber,
                    query: cleanQuery,
                    results,
                    latencyMs,
                    fallbacksAttempted,
                    groundingText,
                    sources,
                    lineupConfirmedHint: analysis.lineupConfirmed,
                    injuriesHint: analysis.injuries,
                }

                // Lưu cache
                searchCache.set(cacheKey, {
                    data: response,
                    expiresAt: Date.now() + CACHE_TTL_MS,
                })

                return response
            }
            throw new Error('Empty result list')
        } catch (err: unknown) {
            const tierLatency = Date.now() - tierStart
            const statusCode = (err as { status?: number })?.status
            const reason = err instanceof Error ? err.message : String(err)

            console.warn(
                `[Search-Failover] Tier ${tier.tierNumber} (${tier.provider}) thất bại (${tierLatency}ms, code: ${statusCode ?? 'N/A'}): ${reason}. Đang chuyển tiếp sang Tier tiếp theo...`,
            )

            fallbacksAttempted.push({
                provider: tier.provider,
                tier: tier.tierNumber,
                reason,
                statusCode,
                latencyMs: tierLatency,
            })
        }
    }

    // Trường hợp xấu nhất: cả 4 tầng đều không trả về kết quả
    const totalLatency = Date.now() - startTime
    console.error('[Search-Failover] Toàn bộ 4 tầng tìm kiếm đều thất bại.')

    const emptyResponse: SearchGroundingResponse = {
        provider: 'duckduckgo',
        tier: 4,
        query: cleanQuery,
        results: [],
        latencyMs: totalLatency,
        fallbacksAttempted,
        groundingText: `[Search Grounding] Không thu thập được dữ liệu trực tuyến cho truy vấn: "${cleanQuery}".`,
        sources: [],
        lineupConfirmedHint: false,
        injuriesHint: [],
    }

    return emptyResponse
}

/**
 * API chuyên dụng cho phân tích bóng đá: Tạo câu truy vấn tối ưu và lấy dữ liệu grounding đối soát.
 */
export async function getMatchGrounding(
    home: string,
    away: string,
    options: { league?: string; kickoff?: string; forceRefresh?: boolean } = {},
): Promise<SearchGroundingResponse> {
    const query = [
        home,
        'vs',
        away,
        options.league || '',
        'lineup injury team news',
    ]
        .filter(Boolean)
        .join(' ')

    return performMultiTierSearch(query, options)
}
