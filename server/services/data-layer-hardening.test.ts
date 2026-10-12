import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    fetchApiFootballDetailed,
    getApiFootballQuota,
    resetApiFootballQuota,
    setApiFootballQuota,
    fixtureToMatchRecord,
    isWithin3HoursOfKickoff,
    testApiFootballConnection,
    deduplicateMatchRecords,
    getLeagueStandings,
    getTeamRecentFixtures,
    apiFootballLimiter,
    type ApiFootballFixtureItem,
} from './apiFootball.js'
import { testSearchProviderConnection, extractMatchesFromSearchSnippets } from './search.js'
import { buildProviderSummaries } from './xkiro.js'
import {
    checkDataGate,
    evaluateCountSelection,
    validateSampleStreamsProvenance,
    MissingProvenanceError,
    type MatchRecord as EngineMatchRecord,
    type SampleStreams,
} from '../../src/lib/engine/count-engine.js'
import { analyzeMatch } from '../../src/lib/engine.js'
import { redis, keys } from '../redis.js'
import type { ExternalCallLog, MatchData } from '../../src/lib/types.js'

describe('Antigravity Fix Prompt 2: Data Layer Hardening Tests (Section 6)', () => {
    const originalFetch = global.fetch

    beforeEach(() => {
        resetApiFootballQuota()
    })

    afterEach(() => {
        global.fetch = originalFetch
        resetApiFootballQuota()
        vi.restoreAllMocks()
    })

    // -------------------------------------------------------------------------
    // TEST 1: Mock API-Football returning HTTP 200 with errors: {plan: "..."} and empty response
    // -> provider status error, analysis DATA_UNAVAILABLE or INSUFFICIENT_DATA, message shown, no picks.
    // -------------------------------------------------------------------------
    it('1. Mock API-Football returning HTTP 200 with errors: {plan: "..."} and empty response -> provider status error, analysis DATA_UNAVAILABLE/INSUFFICIENT_DATA, message shown, no picks', async () => {
        const mockErrorPayload = {
            get: 'fixtures',
            parameters: { team: '123' },
            errors: { plan: 'Free plans do not have access to the Last parameter.' },
            results: 0,
            paging: { current: 1, total: 1 },
            response: [],
        }

        global.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify(mockErrorPayload), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        )

        const callRes = await fetchApiFootballDetailed('fixtures', {
            params: { team: 123 },
            forceRefresh: true,
        })

        // Provider status must be ERROR, not success
        expect(callRes.success).toBe(false)
        expect(callRes.status).toBe('ERROR')
        expect(callRes.errorMessage).toContain('Free plans do not have access to the Last parameter.')

        // When fed into the engine with empty/failed matches:
        const emptyMatchData: MatchData = {
            homeTeam: 'Team A',
            awayTeam: 'Team B',
            league: 'Test League',
            matchRecords: [],
            providerSummaries: [
                {
                    provider: 'api-football',
                    status: 'ERROR',
                    errorMessage: callRes.errorMessage,
                },
            ],
        }

        const analysis = analyzeMatch(emptyMatchData)
        expect(analysis.status).toBe('DATA_UNAVAILABLE')
        expect(analysis.dataGatePassed).toBe(false)
        expect(analysis.picks).toEqual([])
        expect(analysis.noBet).toBe(true)
        expect(analysis.dataCounts.homeMatches).toBe(0)
        expect(analysis.dataCounts.awayMatches).toBe(0)
    })

    // -------------------------------------------------------------------------
    // TEST 2: Mock empty response is not cached (second call hits the provider again)
    // -------------------------------------------------------------------------
    it('2. Mock empty response is not cached (second call hits the provider again)', async () => {
        const mockEmptyPayload = {
            get: 'fixtures',
            parameters: { team: '999' },
            errors: {},
            results: 0,
            paging: { current: 1, total: 1 },
            response: [],
        }

        const fetchSpy = vi.fn().mockImplementation(async () => {
            return new Response(JSON.stringify(mockEmptyPayload), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        })
        global.fetch = fetchSpy

        // Call 1
        const res1 = await fetchApiFootballDetailed('fixtures', {
            params: { team: 999 },
            forceRefresh: false,
        })
        expect(res1.status).toBe('EMPTY')
        expect(res1.resultsCount).toBe(0)
        expect(fetchSpy).toHaveBeenCalledTimes(1)

        // Call 2 without forceRefresh - must NOT be served from cache, hits provider again!
        const res2 = await fetchApiFootballDetailed('fixtures', {
            params: { team: 999 },
            forceRefresh: false,
        })
        expect(res2.status).toBe('EMPTY')
        expect(res2.servedFromCache).toBe(false)
        expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    // -------------------------------------------------------------------------
    // TEST 3: Quota header at 0 -> calls stop and the UI shows quota exhausted
    // -------------------------------------------------------------------------
    it('3. Quota header at 0 -> calls stop immediately and shows quota exhausted', async () => {
        const fetchSpy = vi.fn()
        global.fetch = fetchSpy

        // Set quota remaining to 0
        setApiFootballQuota({
            requestsRemainingDay: 0,
            requestsLimitDay: 100,
            rateLimitRemainingMinute: 0,
            remaining: 0,
        })

        const res = await fetchApiFootballDetailed('fixtures', {
            params: { team: 123 },
        })

        // Guard must halt execution immediately WITHOUT invoking fetch
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(res.success).toBe(false)
        expect(res.status).toBe('ERROR')
        expect(res.errorMessage).toContain('Hết quota API-Football')

        const currentQuota = getApiFootballQuota()
        expect(currentQuota.remaining).toBe(0)
    })

    // -------------------------------------------------------------------------
    // TEST 4: Team ids taken from the fixture object; name-only lookup is never used
    // -------------------------------------------------------------------------
    it('4. Team ids taken from the fixture object; name-only lookup is never used for the match being analysed', () => {
        const rawFixture: ApiFootballFixtureItem = {
            fixture: {
                id: 1145229,
                date: '2026-03-05T14:00:00+00:00',
                status: { short: 'FT' },
            },
            league: {
                id: 852,
                name: "Women's U19 International Friendly",
                season: 2026,
            },
            teams: {
                home: { id: 18452, name: 'Croatia U19 W' },
                away: { id: 18453, name: 'Poland U19 W' },
            },
            goals: { home: 1, away: 2 },
            score: {
                halftime: { home: 0, away: 1 },
                fulltime: { home: 1, away: 2 },
            },
        }

        const matchRecord = fixtureToMatchRecord(rawFixture, '2026-03-05T16:00:00Z')

        // Identity must preserve exact integer IDs from API-Football
        expect(matchRecord).not.toBeNull()
        expect(matchRecord?.homeTeamId).toBe(18452)
        expect(matchRecord?.awayTeamId).toBe(18453)
        expect(matchRecord?.homeTeam).toBe('Croatia U19 W')
        expect(matchRecord?.awayTeam).toBe('Poland U19 W')
        expect(matchRecord?.source).toBe('api-football')
        expect(matchRecord?.provenance.source).toBe('api-football:fixtures?id=1145229')
        expect(matchRecord?.provenance.fetchedAt).toBe('2026-03-05T16:00:00Z')
        expect(matchRecord?.provenance.verified).toBe(true)
    })

    // -------------------------------------------------------------------------
    // TEST 5: Provider log contains every call; "Đã tra web" summary is correct
    // -------------------------------------------------------------------------
    it('5. Provider log contains every call; "Đã tra web" summary is correct for: web searched, web not searched, web failed', () => {
        // Case A: Web searched successfully
        const logsA: ExternalCallLog[] = [
            {
                provider: 'api-football',
                purpose: 'fixture_h2h',
                requestSummary: 'fixtures/headtohead?h2h=18452-18453',
                startTime: Date.now() - 500,
                durationMs: 120,
                httpStatus: 200,
                resultCount: 3,
                servedFromCache: false,
            },
            {
                provider: 'brave',
                purpose: 'h2h_discovery',
                requestSummary: 'Croatia U19 W vs Poland U19 W result',
                startTime: Date.now() - 300,
                durationMs: 80,
                httpStatus: 200,
                resultCount: 6,
                servedFromCache: false,
            },
            {
                provider: 'tavily',
                purpose: 'team_news_extract',
                requestSummary: 'Croatia U19 W lineup news',
                startTime: Date.now() - 200,
                durationMs: 95,
                httpStatus: 200,
                resultCount: 5,
                servedFromCache: false,
            },
        ]
        const summariesA = buildProviderSummaries(logsA)
        expect(summariesA.webSearchSummary.text).toContain('Đã tra web: CÓ')
        expect(summariesA.webSearchSummary.text).toContain('Brave')
        expect(summariesA.webSearchSummary.text).toContain('Tavily')
        expect(summariesA.providerSummaries.find((p) => p.provider === 'brave')?.status).toBe('OK')
        expect(summariesA.providerSummaries.find((p) => p.provider === 'tavily')?.status).toBe('OK')

        // Case B: Web not searched
        const logsB: ExternalCallLog[] = [
            {
                provider: 'api-football',
                purpose: 'fixture_details',
                requestSummary: 'fixtures?id=123',
                startTime: Date.now() - 200,
                durationMs: 50,
                httpStatus: 200,
                resultCount: 1,
                servedFromCache: true,
            },
        ]
        const summariesB = buildProviderSummaries(logsB)
        expect(summariesB.webSearchSummary.text).toContain('Đã tra web: KHÔNG')

        // Case C: Web searched but failed
        const logsC: ExternalCallLog[] = [
            {
                provider: 'brave',
                purpose: 'h2h_discovery',
                requestSummary: 'Brave query',
                startTime: Date.now() - 200,
                durationMs: 50,
                httpStatus: 422,
                resultCount: 0,
                errorMessage: 'SUBSCRIPTION_TOKEN_INVALID',
                servedFromCache: false,
            },
            {
                provider: 'tavily',
                purpose: 'h2h_discovery',
                requestSummary: 'Tavily query',
                startTime: Date.now() - 100,
                durationMs: 40,
                httpStatus: 401,
                resultCount: 0,
                errorMessage: 'Unauthorized',
                servedFromCache: false,
            },
        ]
        const summariesC = buildProviderSummaries(logsC)
        expect(summariesC.webSearchSummary.text).toContain('Đã tra web: THẤT BẠI')
        expect(summariesC.providerSummaries.find((p) => p.provider === 'brave')?.status).toBe('ERROR')
        expect(summariesC.providerSummaries.find((p) => p.provider === 'tavily')?.status).toBe('ERROR')
    })

    // -------------------------------------------------------------------------
    // TEST 6: Self-test reports a broken key as red with the error text
    // -------------------------------------------------------------------------
    it('6. Self-test reports a broken key as red with the error text', async () => {
        // Mock Brave API returning HTTP 401 Unauthorized
        global.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
            const urlStr = String(url)
            if (urlStr.includes('api.search.brave.com')) {
                return new Response(JSON.stringify({ error: { message: 'Token is invalid' } }), {
                    status: 401,
                    headers: { 'Content-Type': 'application/json' },
                })
            }
            if (urlStr.includes('api-sports.io')) {
                return new Response(
                    JSON.stringify({
                        errors: { token: 'Error: API key is suspended or invalid' },
                        results: 0,
                        response: [],
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                )
            }
            return new Response('Not found', { status: 404 })
        })

        // Test Brave provider self-test
        const braveTest = await testSearchProviderConnection('brave')
        expect(braveTest.success).toBe(false)
        expect(braveTest.error).toBeDefined()
        expect(braveTest.error).toContain('401')

        // Test API-Football self-test
        const apiFootballTest = await testApiFootballConnection()
        expect(apiFootballTest.success).toBe(false)
        expect(apiFootballTest.error).toBeDefined()
        expect(apiFootballTest.error).toContain('API key is suspended or invalid')
    })

    // -------------------------------------------------------------------------
    // TEST 7: Engine throws on a sample without provenance; gate returns INSUFFICIENT_DATA for 4 matches and passes for 5
    // -------------------------------------------------------------------------
    it('7. Engine throws on a sample without provenance; gate returns INSUFFICIENT_DATA for 4 matches and passes for 5', () => {
        function makeMatch(scoreH: number, scoreA: number, hasProvenance = true): EngineMatchRecord {
            return {
                date: '2026-03-01',
                home_team: 'Team A',
                away_team: 'Team B',
                home_goals_ft: scoreH,
                away_goals_ft: scoreA,
                source: hasProvenance ? 'api-football' : ('' as any),
                fetchedAt: hasProvenance ? '2026-03-01T12:00:00Z' : ('' as any),
                verified: true,
            }
        }

        // Sub-test 7A: Engine throws MissingProvenanceError if sample lacks provenance
        const invalidSample: SampleStreams = {
            H_venue: [makeMatch(1, 0, false)], // missing provenance!
            H_all: [makeMatch(1, 0, false)],
            A_venue: [makeMatch(0, 1, false)],
            A_all: [makeMatch(0, 1, false)],
            X: [],
        }

        expect(() => validateSampleStreamsProvenance(invalidSample)).toThrow(MissingProvenanceError)

        // Sub-test 7B: Gate returns INSUFFICIENT_DATA for 4 matches
        const fourMatches = [
            makeMatch(1, 0),
            makeMatch(2, 0),
            makeMatch(1, 1),
            makeMatch(0, 0),
        ]
        const sample4: SampleStreams = {
            H_venue: fourMatches,
            H_all: fourMatches, // 4 matches < 5 threshold
            A_venue: fourMatches,
            A_all: [...fourMatches, makeMatch(1, 0)],
            X: [],
        }
        expect(checkDataGate(sample4)).toBe(false)
        const eval4 = evaluateCountSelection(sample4, { market: '1x2', side: 'home' }, 'home')
        expect(eval4.status).toBe('INSUFFICIENT_DATA')
        expect(eval4.headlineWinProb).toBe(0)
        expect(eval4.edge).toBe(0)
        expect(eval4.ev).toBe(0)
        expect(eval4.stakePct).toBe(0)

        // Sub-test 7C: Gate passes for 5 matches
        const fiveMatches = [...fourMatches, makeMatch(2, 1)]
        const sample5: SampleStreams = {
            H_venue: fiveMatches,
            H_all: fiveMatches, // 5 matches >= 5 threshold
            A_venue: fiveMatches,
            A_all: fiveMatches,
            X: fiveMatches,
        }
        expect(checkDataGate(sample5)).toBe(true)
        const eval5 = evaluateCountSelection(
            sample5,
            { market: '1x2', side: 'home', odds: 2.0 },
            'home',
        )
        expect(eval5.status).not.toBe('INSUFFICIENT_DATA')
    })

    // -------------------------------------------------------------------------
    // TEST 8: Force refresh bypasses cache; fixtures within 3 hours of kickoff bypass cache automatically
    // -------------------------------------------------------------------------
    it('8. Force refresh bypasses cache; fixtures within 3 hours of kickoff bypass cache automatically', async () => {
        const cachePath = 'fixtures?id=88888'
        const cacheKey = keys.footballCache(cachePath)
        const cachedData = [{ fixture: { id: 88888 } }]

        // Pre-populate cache in redis
        await redis.set(cacheKey, cachedData, { ex: 3600 })

        const fetchSpy = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    results: 1,
                    response: [{ fixture: { id: 88888, live: true } }],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        )
        global.fetch = fetchSpy

        // 8A. Normal call hits cache
        const resCached = await fetchApiFootballDetailed('fixtures', {
            params: { id: 88888 },
            forceRefresh: false,
            kickoff: new Date(Date.now() + 10 * 3600 * 1000).toISOString(), // 10 hours away
        })
        expect(resCached.servedFromCache).toBe(true)
        expect(fetchSpy).not.toHaveBeenCalled()

        // 8B. forceRefresh: true bypasses cache
        const resForce = await fetchApiFootballDetailed('fixtures', {
            params: { id: 88888 },
            forceRefresh: true,
        })
        expect(resForce.servedFromCache).toBe(false)
        expect(fetchSpy).toHaveBeenCalledTimes(1)

        // 8C. Match within 3 hours of kickoff (e.g., 1 hour in the future) bypasses cache automatically
        fetchSpy.mockClear()
        const kickoffIn1Hour = new Date(Date.now() + 1 * 3600 * 1000).toISOString()
        expect(isWithin3HoursOfKickoff(kickoffIn1Hour)).toBe(true)

        const resNearKickoff = await fetchApiFootballDetailed('fixtures', {
            params: { id: 88888 },
            forceRefresh: false, // Not forced, but near kickoff!
            kickoff: kickoffIn1Hour,
        })
        expect(resNearKickoff.servedFromCache).toBe(false)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    // -------------------------------------------------------------------------
    // TEST 9: Deduplication of matches by (date, team ids) prefers API-Football and marks verified
    // -------------------------------------------------------------------------
    it('9. Deduplication of matches by (date, team ids) prefers API-Football scores and marks verified when web agrees', () => {
        const matchWeb = {
            id: 'web-1',
            date: '2026-03-01',
            competition: 'Friendly',
            homeTeam: 'Croatia U19 W',
            awayTeam: 'Poland U19 W',
            homeTeamId: 18452,
            awayTeamId: 18453,
            ftScore: { home: 1, away: 2 },
            status: 'FT',
            source: 'web' as const,
            provenance: { source: 'web:soccerpunter', fetchedAt: '2026-03-01T12:00:00Z', verified: false },
        }

        const matchApi = {
            id: 1145229,
            date: '2026-03-01',
            competition: "Women's U19 International Friendly",
            homeTeam: 'Croatia U19 W',
            awayTeam: 'Poland U19 W',
            homeTeamId: 18452,
            awayTeamId: 18453,
            ftScore: { home: 1, away: 2 },
            status: 'FT',
            source: 'api-football' as const,
            provenance: { source: 'api-football:fixtures?id=1145229', fetchedAt: '2026-03-01T12:30:00Z', verified: true },
        }

        // When web comes first, then API-Football
        const deduplicated1 = deduplicateMatchRecords([matchWeb, matchApi])
        expect(deduplicated1.length).toBe(1)
        expect(deduplicated1[0].source).toBe('api-football')
        expect(deduplicated1[0].provenance.verified).toBe(true)

        // When API-Football comes first, then web
        const deduplicated2 = deduplicateMatchRecords([matchApi, matchWeb])
        expect(deduplicated2.length).toBe(1)
        expect(deduplicated2[0].source).toBe('api-football')
        expect(deduplicated2[0].provenance.verified).toBe(true)
    })

    // -------------------------------------------------------------------------
    // TEST 10: Standings requested only for senior leagues; non-finished matches are excluded
    // -------------------------------------------------------------------------
    it('10. Standings requested only for senior leagues; postponed/cancelled matches are excluded', async () => {
        // 10A: Non-senior league (isSeniorLeague = false) returns NOT_CALLED without fetch
        const fetchSpy = vi.fn()
        global.fetch = fetchSpy

        const juniorRes = await getLeagueStandings(852, 2026, false)
        expect(juniorRes.status).toBe('NOT_CALLED')
        expect(fetchSpy).not.toHaveBeenCalled()

        // 10B: Postponed / cancelled matches are excluded and tracked
        const mockFixturesWithPpd = {
            results: 2,
            response: [
                {
                    fixture: { id: 101, date: '2026-02-01', status: { short: 'FT' } },
                    league: { id: 10, name: 'League 1', season: 2026 },
                    teams: { home: { id: 100, name: 'Team A' }, away: { id: 200, name: 'Team B' } },
                    goals: { home: 2, away: 1 },
                },
                {
                    fixture: { id: 102, date: '2026-02-15', status: { short: 'PPD' } },
                    league: { id: 10, name: 'League 1', season: 2026 },
                    teams: { home: { id: 100, name: 'Team A' }, away: { id: 300, name: 'Team C' } },
                    goals: { home: null, away: null },
                },
            ],
        }

        global.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify(mockFixturesWithPpd), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        )

        const teamFixtures = await getTeamRecentFixtures(100, { season: 2026, forceRefresh: true })
        expect(teamFixtures.matches.length).toBe(1)
        expect(teamFixtures.matches[0].id).toBe(101)
        expect(teamFixtures.excludedMatches).toBeDefined()
        expect(teamFixtures.excludedMatches?.length).toBe(1)
        expect(teamFixtures.excludedMatches?.[0].status).toBe('PPD')
        expect(teamFixtures.excludedMatches?.[0].reason).toContain('Postponed')
    })

    // -------------------------------------------------------------------------
    // TEST 11: Fixture identity & call logs preserved end-to-end with analysis
    // -------------------------------------------------------------------------
    it('11. Fixture identity & call logs preserved end-to-end with analysis', () => {
        const fixtureIdentity = {
            fixtureId: 1145229,
            homeTeamId: 18452,
            awayTeamId: 18453,
            leagueId: 852,
            season: 2026,
            status: 'FT',
            kickoff: '2026-03-05T14:00:00Z',
        }

        const callLogs: ExternalCallLog[] = [
            {
                provider: 'api-football',
                purpose: 'fixture_lookup',
                requestSummary: 'fixtures?id=1145229',
                startTime: 1000,
                durationMs: 50,
                httpStatus: 200,
                resultCount: 1,
                servedFromCache: false,
            },
        ]

        const testMatchData: MatchData = {
            homeTeam: 'Croatia U19 W',
            awayTeam: 'Poland U19 W',
            league: "Women's U19 Friendly",
            fixtureIdentity,
            callLogs,
            providerSummaries: [
                {
                    provider: 'api-football',
                    status: 'OK',
                    summary: '1 bản ghi',
                    resultCount: 1,
                    queryCount: 1,
                },
            ],
            matchRecords: {
                home: [],
                away: [],
                h2h: [],
            },
        }

        const analysis = analyzeMatch(testMatchData, [])
        expect(analysis.fixtureIdentity).toEqual(fixtureIdentity)
        expect(analysis.callLogs).toEqual(callLogs)
        expect(analysis.providerSummaries?.length).toBe(1)
    })

    // -------------------------------------------------------------------------
    // TEST 12: apiFootballLimiter enforces strict 10 requests / minute rate limit
    // -------------------------------------------------------------------------
    it('12. apiFootballLimiter enforces strict 10 requests / minute rate limit and serializes concurrency', async () => {
        apiFootballLimiter.reset()

        // 10 acquisitions should succeed
        for (let i = 0; i < 10; i++) {
            const ok = await apiFootballLimiter.acquire()
            expect(ok).toBe(true)
            apiFootballLimiter.release()
        }

        const timestamps = apiFootballLimiter.getTimestampsInWindow()
        expect(timestamps.length).toBe(10)

        // 11th acquisition should be throttled (wait > maxQueueWaitMs returns false when window is full)
        const eleventh = await apiFootballLimiter.acquire()
        expect(eleventh).toBe(false)

        apiFootballLimiter.reset()
    })

    // -------------------------------------------------------------------------
    // TEST 13: extractMatchesFromSearchSnippets extracts match records with provenance
    // -------------------------------------------------------------------------
    it('13. extractMatchesFromSearchSnippets extracts match records with verified provenance', () => {
        const mockSnippets = [
            {
                title: 'Arsenal vs Chelsea result: Arsenal 2-1 Chelsea',
                url: 'https://example.com/match/1',
                snippet: 'Arsenal secured a 2-1 victory over Chelsea at Emirates Stadium on 2026-04-12.',
                provider: 'serper' as const,
            },
            {
                title: 'Premier League: Everton 0 - 2 Arsenal',
                url: 'https://example.com/match/2',
                snippet: 'Everton suffered a 0 - 2 defeat against Arsenal with goals in both halves.',
                provider: 'serper' as const,
            },
        ]

        const matches = extractMatchesFromSearchSnippets('Arsenal', mockSnippets, 'serper')
        expect(matches.length).toBe(2)
        expect(matches[0].homeTeam).toBe('Arsenal')
        expect(matches[0].awayTeam).toBe('Chelsea')
        expect(matches[0].ftScore).toEqual({ home: 2, away: 1 })
        expect(matches[0].provenance.source).toBe('serper:https://example.com/match/1')
        expect(matches[0].provenance.verified).toBe(true)
        expect(matches[0].source).toBe('web')

        expect(matches[1].homeTeam).toBe('Everton')
        expect(matches[1].awayTeam).toBe('Arsenal')
        expect(matches[1].ftScore).toEqual({ home: 0, away: 2 })

        // Validate provenance using the engine's strict validator
        expect(() => validateSampleStreamsProvenance(matches)).not.toThrow()
    })

    // -------------------------------------------------------------------------
    // TEST 14: testApiFootballConnection with mock successful status returns green OK and active quota
    // -------------------------------------------------------------------------
    it('14. testApiFootballConnection with mock successful status returns green OK and active quota', async () => {
        global.fetch = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    get: 'status',
                    errors: [],
                    results: 0,
                    response: {
                        account: { email: 'goqgqp@gmail.com' },
                        subscription: { plan: 'Free', active: true },
                        requests: { current: 1, limit_day: 100 },
                    },
                }),
                {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'x-ratelimit-requests-remaining': '99',
                        'x-ratelimit-requests-limit': '100',
                        'x-ratelimit-remaining-minute': '9',
                    },
                },
            ),
        )

        const result = await testApiFootballConnection()
        expect(result.success).toBe(true)
        expect(result.quota?.remaining).toBe(99)
        expect(result.quota?.limit).toBe(100)
        expect(result.quota?.perMinute).toBe(9)
    })
})
