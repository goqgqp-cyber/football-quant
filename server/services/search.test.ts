import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    getMatchGrounding,
    performMultiTierSearch,
} from './search.js'

describe('Multi-Tier Search Failover Service', () => {
    const originalFetch = global.fetch

    afterEach(() => {
        global.fetch = originalFetch
        vi.restoreAllMocks()
    })

    it('Tier 1: Trả về kết quả từ Serper khi Serper hoạt động bình thường', async () => {
        const mockSerperResponse = {
            organic: [
                {
                    title: 'Arsenal vs Chelsea: Lineup, Injuries and Team News',
                    link: 'https://example.com/arsenal-chelsea-lineup',
                    snippet: 'Arteta confirms Saka is fit to start. Martinelli sidelined with injury.',
                    date: '2 hours ago',
                },
                {
                    title: 'Confirmed Starting XI: Arsenal host Chelsea at Emirates',
                    link: 'https://example.com/confirmed-xi',
                    snippet: 'Official lineup announced for Premier League derby.',
                    date: '1 hour ago',
                },
            ],
        }

        global.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
            const urlStr = String(url)
            if (urlStr.includes('google.serper.dev')) {
                return new Response(JSON.stringify(mockSerperResponse), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
            }
            return new Response('Not found', { status: 404 })
        })

        const res = await performMultiTierSearch('Arsenal vs Chelsea lineup', { forceRefresh: true })

        expect(res.provider).toBe('serper')
        expect(res.tier).toBe(1)
        expect(res.results.length).toBe(2)
        expect(res.results[0].title).toBe('Arsenal vs Chelsea: Lineup, Injuries and Team News')
        expect(res.results[0].provider).toBe('serper')
        expect(res.sources.length).toBe(2)
        expect(res.lineupConfirmedHint).toBe(true)
        expect(res.fallbacksAttempted.length).toBe(0)
    })

    it('Tier 1 -> Tier 2: Tự động chuyển từ Serper sang Tavily khi Serper lỗi HTTP 429 Quota Exhausted', async () => {
        const mockTavilyResponse = {
            answer: 'Arsenal have confirmed their squad with Rice and Saka starting.',
            results: [
                {
                    title: 'Tavily News: Arsenal vs Chelsea injury update',
                    url: 'https://tavily.com/arsenal-chelsea',
                    content: 'Gabriel Jesus ruled out due to knee injury.',
                },
            ],
        }

        global.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
            const urlStr = String(url)
            if (urlStr.includes('google.serper.dev')) {
                return new Response(JSON.stringify({ message: 'Rate limit exceeded' }), {
                    status: 429,
                    statusText: 'Too Many Requests',
                })
            }
            if (urlStr.includes('api.tavily.com')) {
                return new Response(JSON.stringify(mockTavilyResponse), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
            }
            return new Response('Not found', { status: 404 })
        })

        const res = await performMultiTierSearch('Arsenal vs Chelsea injury update', { forceRefresh: true })

        expect(res.provider).toBe('tavily')
        expect(res.tier).toBe(2)
        expect(res.fallbacksAttempted.length).toBe(1)
        expect(res.fallbacksAttempted[0].provider).toBe('serper')
        expect(res.fallbacksAttempted[0].statusCode).toBe(429)
        expect(res.results.length).toBeGreaterThanOrEqual(1)
        expect(res.groundingText).toContain('TAVILY')
    })

    it('Tier 1 -> Tier 2 -> Tier 3: Chuyển tiếp tới Brave khi Serper 401 và Tavily 403', async () => {
        const mockBraveResponse = {
            web: {
                results: [
                    {
                        title: 'Brave Search: Arsenal vs Chelsea Predicted Starting XI',
                        url: 'https://brave.com/sports/arsenal-chelsea',
                        description: 'Chelsea will miss Reece James who is sidelined with hamstring strain.',
                        page_age: '3 hours ago',
                    },
                ],
            },
        }

        global.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
            const urlStr = String(url)
            if (urlStr.includes('google.serper.dev')) {
                return new Response('Unauthorized', { status: 401 })
            }
            if (urlStr.includes('api.tavily.com')) {
                return new Response('Forbidden / Credit exhausted', { status: 403 })
            }
            if (urlStr.includes('api.search.brave.com')) {
                return new Response(JSON.stringify(mockBraveResponse), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
            }
            return new Response('Not found', { status: 404 })
        })

        const res = await performMultiTierSearch('Arsenal vs Chelsea team news', { forceRefresh: true })

        expect(res.provider).toBe('brave')
        expect(res.tier).toBe(3)
        expect(res.fallbacksAttempted.length).toBe(2)
        expect(res.fallbacksAttempted[0].provider).toBe('serper')
        expect(res.fallbacksAttempted[0].statusCode).toBe(401)
        expect(res.fallbacksAttempted[1].provider).toBe('tavily')
        expect(res.fallbacksAttempted[1].statusCode).toBe(403)
        expect(res.results[0].title).toContain('Brave Search')
    })

    it('Tier 1 -> 2 -> 3 -> Tier 4: Nhảy cấp xuống DuckDuckGo khi cả 3 API trả phí đều lỗi / hết quota', async () => {
        const mockDdgHtml = `
            <!DOCTYPE html>
            <html>
                <body>
                    <div class="result">
                        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffootball.com%2Fmatch-preview&rut=1">Arsenal vs Chelsea Full Team News</a>
                        <a class="result__snippet">Confirmed lineup announced. Havertz starts as striker.</a>
                    </div>
                </body>
            </html>
        `

        global.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
            const urlStr = String(url)
            if (urlStr.includes('google.serper.dev')) {
                return new Response('Quota exceeded', { status: 429 })
            }
            if (urlStr.includes('api.tavily.com')) {
                return new Response('Quota exceeded', { status: 429 })
            }
            if (urlStr.includes('api.search.brave.com')) {
                return new Response('Rate limit', { status: 429 })
            }
            if (urlStr.includes('duckduckgo.com/html')) {
                return new Response(mockDdgHtml, {
                    status: 200,
                    headers: { 'Content-Type': 'text/html' },
                })
            }
            return new Response('Not found', { status: 404 })
        })

        const res = await performMultiTierSearch('Arsenal vs Chelsea final match news', { forceRefresh: true })

        expect(res.provider).toBe('duckduckgo')
        expect(res.tier).toBe(4)
        expect(res.fallbacksAttempted.length).toBe(3)
        expect(res.fallbacksAttempted.map((f) => f.provider)).toEqual(['serper', 'tavily', 'brave'])
        expect(res.results.length).toBe(1)
        expect(res.results[0].title).toBe('Arsenal vs Chelsea Full Team News')
        expect(res.results[0].url).toBe('https://football.com/match-preview')
        expect(res.results[0].snippet).toContain('Havertz starts')
    })

    it('Xử lý timeout 6s và chuyển cấp suôn sẻ sang provider tiếp theo', async () => {
        global.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
            const urlStr = String(url)
            if (urlStr.includes('google.serper.dev')) {
                // Giả lập timeout bằng cách kiểm tra tín hiệu hủy hoặc ném AbortError
                throw new Error('The operation was aborted due to timeout')
            }
            if (urlStr.includes('api.tavily.com')) {
                return new Response(
                    JSON.stringify({
                        results: [
                            {
                                title: 'Tavily Recovered Search',
                                url: 'https://example.com/recovered',
                                content: 'Lineup recovered successfully after tier 1 timeout.',
                            },
                        ],
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                )
            }
            return new Response('Not found', { status: 404 })
        })

        const res = await performMultiTierSearch('Arsenal timeout test', { forceRefresh: true })

        expect(res.provider).toBe('tavily')
        expect(res.tier).toBe(2)
        expect(res.fallbacksAttempted[0].reason).toContain('timeout')
    })

    it('getMatchGrounding tạo query và cấu trúc đối soát đầy đủ', async () => {
        global.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
            const urlStr = String(url)
            if (urlStr.includes('google.serper.dev')) {
                return new Response(
                    JSON.stringify({
                        organic: [
                            {
                                title: 'Liverpool vs Man City Lineup and Injury Report',
                                link: 'https://sports.example.com/lfc-mcfc',
                                snippet: 'Confirmed starting XI released: Salah, Diaz start. Alisson ruled out due to hamstring injury.',
                            },
                        ],
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                )
            }
            return new Response('Not found', { status: 404 })
        })

        const grounding = await getMatchGrounding('Liverpool', 'Man City', {
            league: 'Premier League',
            forceRefresh: true,
        })

        expect(grounding.query).toBe('Liverpool vs Man City Premier League lineup injury team news')
        expect(grounding.provider).toBe('serper')
        expect(grounding.lineupConfirmedHint).toBe(true)
        expect(grounding.groundingText).toContain('Search Grounding')
        expect(grounding.sources[0].url).toBe('https://sports.example.com/lfc-mcfc')
    })
})
