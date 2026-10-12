import { describe, expect, it } from 'vitest'
import { getMatchGrounding, performMultiTierSearch } from './search.js'
import { env } from '../env.js'

describe('Live Multi-Tier Search Integration', () => {
    it('Tier 1 Live: Lấy dữ liệu đối soát trực tiếp từ Serper', async () => {
        const result = await getMatchGrounding('Arsenal', 'Chelsea', {
            league: 'Premier League',
            forceRefresh: true,
        })

        console.log('[Tier 1 Serper Live]:', {
            provider: result.provider,
            tier: result.tier,
            latencyMs: result.latencyMs,
            sourcesCount: result.sources.length,
            fallbacks: result.fallbacksAttempted.length,
        })

        expect(result.provider).toBe('serper')
        expect(result.tier).toBe(1)
        expect(result.sources.length).toBeGreaterThan(0)
    }, 15000)

    it('Tier 2 Live: Tự động cascade sang Tavily khi Serper key không hợp lệ / lỗi', async () => {
        const originalKey = env.serperApiKey
        try {
            // Đặt key Serper không hợp lệ để ép lỗi HTTP 403 / 401
            (env as { serperApiKey: string }).serperApiKey = 'invalid_serper_key_test'
            const result = await performMultiTierSearch('Real Madrid vs Barcelona lineup injury news', {
                forceRefresh: true,
            })

            console.log('[Tier 2 Tavily Live]:', {
                provider: result.provider,
                tier: result.tier,
                latencyMs: result.latencyMs,
                sourcesCount: result.sources.length,
                fallbacks: result.fallbacksAttempted.map((f) => ({ p: f.provider, s: f.statusCode })),
            })

            expect(result.provider).toBe('tavily')
            expect(result.tier).toBe(2)
            expect(result.fallbacksAttempted.length).toBe(1)
            expect(result.fallbacksAttempted[0].provider).toBe('serper')
        } finally {
            ;(env as { serperApiKey: string }).serperApiKey = originalKey
        }
    }, 15000)

    it('Tier 3 Live: Tự động cascade sang Brave khi Serper & Tavily đều lỗi', async () => {
        const origSerper = env.serperApiKey
        const origTavily = env.tavilyApiKey
        try {
            (env as { serperApiKey: string }).serperApiKey = 'invalid_serper_key'
            ;(env as { tavilyApiKey: string }).tavilyApiKey = 'invalid_tavily_key'
            const result = await performMultiTierSearch('Liverpool vs Man City team news lineup', {
                forceRefresh: true,
            })

            console.log('[Tier 3 Brave Live]:', {
                provider: result.provider,
                tier: result.tier,
                latencyMs: result.latencyMs,
                sourcesCount: result.sources.length,
                fallbacks: result.fallbacksAttempted.map((f) => ({ p: f.provider, s: f.statusCode })),
            })

            expect(result.provider).toBe('brave')
            expect(result.tier).toBe(3)
            expect(result.fallbacksAttempted.length).toBe(2)
        } finally {
            ;(env as { serperApiKey: string }).serperApiKey = origSerper
            ;(env as { tavilyApiKey: string }).tavilyApiKey = origTavily
        }
    }, 15000)

    it('Tier 4 Live: Tự động cascade sang DuckDuckGo khi cả 3 key API đều lỗi / cạn quota', async () => {
        const origSerper = env.serperApiKey
        const origTavily = env.tavilyApiKey
        const origBrave = env.braveApiKey
        try {
            (env as { serperApiKey: string }).serperApiKey = 'invalid_serper_key'
            ;(env as { tavilyApiKey: string }).tavilyApiKey = 'invalid_tavily_key'
            ;(env as { braveApiKey: string }).braveApiKey = 'invalid_brave_key'
            const result = await performMultiTierSearch('Bayern Munich vs Dortmund lineup injury news', {
                forceRefresh: true,
            })

            console.log('[Tier 4 DuckDuckGo Live]:', {
                provider: result.provider,
                tier: result.tier,
                latencyMs: result.latencyMs,
                sourcesCount: result.sources.length,
                fallbacks: result.fallbacksAttempted.map((f) => ({ p: f.provider, s: f.statusCode })),
            })

            expect(result.provider).toBe('duckduckgo')
            expect(result.tier).toBe(4)
            expect(result.fallbacksAttempted.length).toBe(3)
            expect(result.sources.length).toBeGreaterThan(0)
        } finally {
            ;(env as { serperApiKey: string }).serperApiKey = origSerper
            ;(env as { tavilyApiKey: string }).tavilyApiKey = origTavily
            ;(env as { braveApiKey: string }).braveApiKey = origBrave
        }
    }, 20000)
})
