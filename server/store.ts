import { createHash, randomUUID } from 'node:crypto'
import { keys, redis } from './redis.js'
import type {
    ActualResult,
    AnalysisResult,
    CalibrationBin,
    Pick,
    SettledMatchRecord,
    SettledPick,
} from '../src/lib/types.js'
import { buildCalibration, settlePick, totalProfit } from '../src/lib/settle.js'
import { filterRecommendedPicks } from '../src/lib/engine.js'

/** Bản ghi lượt phân tích lưu trong Redis — mỗi bản chỉ thuộc về 1 user. */
export interface HistoryRecord {
    id: string
    createdAt: number
    /** Nhập liệu trận (metadata). */
    meta: {
        home: string
        away: string
        league?: string
        kickoff?: string | null
        eventId?: number | null
        inPlay?: {
            isLive?: boolean
            currentMinute?: number | null
            currentScore?: { home: number; away: number } | null
        } | null
    }
    fixtureId?: number | null
    fixtureIdentity?: import('../src/lib/types.js').FixtureIdentity
    homeTeam?: string
    awayTeam?: string
    kickoffTimestamp?: number | null
    status?: string
    settled?: boolean
    /** Input thuần (dùng để tính lại khi cần). */
    analysis: AnalysisResult
    /** Các pick đã sinh ra (snapshot tại thời điểm phân tích). */
    picks: Pick[]
    /** Kết quả thực tế (null = chưa quyết toán). */
    result: (ActualResult & { note?: string }) | null
    /** Văn bản giải thích 4 phần do AI viết (null nếu chưa/bỏ qua). */
    explanation?: import('../src/lib/types.js').Explanation | null
}

function keyHash(s: string): string {
    return createHash('sha256').update(s).digest('hex').slice(0, 12)
}

export async function saveHistory(
    userId: string,
    record: Omit<HistoryRecord, 'id' | 'createdAt'>,
): Promise<HistoryRecord> {
    const qualifiedPicks = filterRecommendedPicks(record.picks || [])
    const targetFixId = record.fixtureId || record.meta.eventId
    const targetHome = (record.homeTeam || record.meta.home || '').trim().toLowerCase()
    const targetAway = (record.awayTeam || record.meta.away || '').trim().toLowerCase()

    // Kiểm tra bản ghi trùng lặp trong lịch sử hiện tại
    const existingRows = await listHistory(userId, 100)
    const existing = existingRows.find((x) => {
        const xFixId = x.fixtureId || x.meta?.eventId
        if (targetFixId && xFixId && Number(xFixId) === Number(targetFixId)) return true
        const xHome = (x.homeTeam || x.meta?.home || '').trim().toLowerCase()
        const xAway = (x.awayTeam || x.meta?.away || '').trim().toLowerCase()
        if (targetHome && targetAway && xHome === targetHome && xAway === targetAway) return true
        return false
    })

    if (existing) {
        // Cập nhật đè lên bản ghi cũ (1 match = 1 unique record)
        const updatedRow: HistoryRecord = {
            ...record,
            id: existing.id,
            createdAt: existing.createdAt,
            picks: qualifiedPicks,
            fixtureId: targetFixId ? Number(targetFixId) : existing.fixtureId,
            fixtureIdentity: record.fixtureIdentity || existing.fixtureIdentity,
            homeTeam: record.homeTeam || record.meta.home,
            awayTeam: record.awayTeam || record.meta.away,
            kickoffTimestamp: record.kickoffTimestamp || existing.kickoffTimestamp,
            status: record.status || existing.status || (record.result ? 'finished' : 'notstarted'),
            settled: record.settled ?? (record.result != null),
        }
        await redis.set(keys.historyItem(userId, existing.id), updatedRow)
        return updatedRow
    }

    const id = `h_${randomUUID().slice(0, 8)}_${keyHash(String(Date.now()))}`
    const row: HistoryRecord = {
        ...record,
        id,
        createdAt: Date.now(),
        picks: qualifiedPicks,
        fixtureId: targetFixId ? Number(targetFixId) : undefined,
        homeTeam: record.homeTeam || record.meta.home,
        awayTeam: record.awayTeam || record.meta.away,
        status: record.status || (record.result ? 'finished' : 'notstarted'),
        settled: record.settled ?? (record.result != null),
    }
    await redis.set(keys.historyItem(userId, id), row)
    await redis.lpush(keys.historyIds(userId), id)
    return row
}

export async function listHistory(userId: string, limit = 100): Promise<HistoryRecord[]> {
    const raw: unknown = await redis.lrange(keys.historyIds(userId), 0, Math.max(limit * 3, 200))
    const ids = (Array.isArray(raw) ? raw : []) as string[]
    if (ids.length === 0) return []
    const rows = await Promise.all(
        ids.map(async (id) => (await redis.get(keys.historyItem(userId, id))) as unknown as HistoryRecord | null),
    )

    // Deduplicate triệt để: 1 fixture = 1 unique row
    const seen = new Set<string>()
    const deduplicated: HistoryRecord[] = []
    for (const r of rows) {
        if (!r) continue
        const fixId = r.fixtureId || r.meta?.eventId
        const h = (r.homeTeam || r.meta?.home || '').trim().toLowerCase()
        const a = (r.awayTeam || r.meta?.away || '').trim().toLowerCase()
        const key = fixId ? `fix:${fixId}` : h && a ? `${h}_vs_${a}` : `id:${r.id}`
        if (!seen.has(key)) {
            seen.add(key)
            deduplicated.push(r)
        }
        if (deduplicated.length >= limit) break
    }
    return deduplicated
}

export async function getHistoryItem(
    userId: string,
    id: string,
): Promise<HistoryRecord | null> {
    return (await redis.get(keys.historyItem(userId, id))) as unknown as HistoryRecord | null
}

/** Lưu bản ghi trận đấu đã settle vĩnh viễn vào Redis danh sách settled_matches (Zero Duplicate) */
export async function saveSettledMatch(record: SettledMatchRecord): Promise<void> {
    const fixId = record.fixtureId || record.eventId || (record.id && !isNaN(Number(record.id)) ? Number(record.id) : undefined)
    const existing = await listSettledMatches(150)
    const isDup = existing.some((x) => {
        const xFixId = x.fixtureId || x.eventId
        if (fixId && xFixId && xFixId === fixId) return true
        if (record.recordId && x.recordId && x.recordId === record.recordId) return true
        if (record.id && x.id && x.id === record.id) return true
        if (
            x.home &&
            record.home &&
            x.away &&
            record.away &&
            x.home.trim().toLowerCase() === record.home.trim().toLowerCase() &&
            x.away.trim().toLowerCase() === record.away.trim().toLowerCase()
        ) {
            return true
        }
        return false
    })
    if (isDup) return // Đã tồn tại trận đấu, từ chối ghi trùng lặp

    const serialized = typeof record === 'string' ? record : JSON.stringify(record)
    await redis.lpush(keys.settledMatches(), serialized)
    if (record.userId) {
        await redis.lpush(keys.userSettledMatches(record.userId), serialized)
    }
}

/** Lấy danh sách các trận đã settle từ Redis list settled_matches, chuẩn hóa deduplicate 1 fixture = 1 row */
export async function listSettledMatches(limit = 100): Promise<SettledMatchRecord[]> {
    const raw: unknown = await redis.lrange(keys.settledMatches(), 0, Math.max(limit * 3, 200))
    const list = (Array.isArray(raw) ? raw : []) as unknown[]
    const records: SettledMatchRecord[] = []
    const seen = new Set<string>()

    for (const item of list) {
        if (!item) continue
        try {
            const obj = (typeof item === 'string' ? JSON.parse(item) : item) as SettledMatchRecord
            if (obj && (obj.home || obj.homeTeam) && (obj.away || obj.awayTeam)) {
                const homeName = (obj.homeTeam || obj.home || '').trim().toLowerCase()
                const awayName = (obj.awayTeam || obj.away || '').trim().toLowerCase()
                const fixId = obj.fixtureId || obj.eventId
                const uniqueKey = fixId
                    ? `fix:${fixId}`
                    : obj.recordId
                        ? `rec:${obj.recordId}`
                        : `${homeName}_vs_${awayName}`
                if (!seen.has(uniqueKey)) {
                    seen.add(uniqueKey)
                    records.push({
                        ...obj,
                        home: obj.home || obj.homeTeam || '',
                        away: obj.away || obj.awayTeam || '',
                        homeTeam: obj.homeTeam || obj.home,
                        awayTeam: obj.awayTeam || obj.away,
                        fixtureId: fixId ? Number(fixId) : undefined,
                        settled: true,
                    })
                }
            }
        } catch {
            /* ignore invalid json */
        }
        if (records.length >= limit) break
    }
    return records
}

/**
 * Đối soát kết quả trận đấu (thủ công hoặc tự động qua API-Football):
 * - Lưu kết quả thực tế vào HistoryRecord.
 * - Chấm điểm các kèo (Châu Á, Tài xỉu, Phạt góc).
 * - Lưu bản ghi đối soát vĩnh viễn vào Upstash Redis `settled_matches`.
 */
export async function settleHistory(
    userId: string,
    id: string,
    r: {
        htHome?: number
        htAway?: number
        ftHome: number
        ftAway: number
        cornersHome?: number
        cornersAway?: number
        eventId?: number
    },
): Promise<{ record: HistoryRecord; settledMatch: SettledMatchRecord } | null> {
    const row = await getHistoryItem(userId, id)
    if (!row) return null

    const actual: ActualResult = {
        htHome: r.htHome ?? 0,
        htAway: r.htAway ?? 0,
        ftHome: r.ftHome,
        ftAway: r.ftAway,
        cornersHome: r.cornersHome,
        cornersAway: r.cornersAway,
        settledAt: Date.now(),
    }
    row.result = actual
    row.status = 'finished'
    row.settled = true
    await redis.set(keys.historyItem(userId, id), row)

    // Chấm điểm từng pick
    const settledPicks: SettledMatchRecord['picks'] = []
    let totalProf = 0
    let winCount = 0
    let loseCount = 0

    for (const p of row.picks) {
        const s = settlePick(p, actual, 'ft')
        const isStaked = p.stakePct > 0
        settledPicks.push({
            kind: p.kind,
            side: p.side,
            line: p.line,
            odds: p.odds,
            outcome: s.outcome,
            profit: s.profit,
            staked: isStaked,
        })
        if (isStaked) {
            totalProf += s.profit
            if (s.outcome === 'win' || s.outcome === 'win_half') winCount++
            else if (s.outcome === 'lose' || s.outcome === 'lose_half') loseCount++
        }
    }

    const summaryOutcome: 'win' | 'push' | 'lose' =
        winCount > loseCount ? 'win' : loseCount > winCount ? 'lose' : 'push'

    const fixId = r.eventId || row.fixtureId || row.meta.eventId
    const settledMatch: SettledMatchRecord = {
        id: `sm_${id}_${Date.now()}`,
        userId,
        recordId: id,
        eventId: fixId ? Number(fixId) : undefined,
        fixtureId: fixId ? Number(fixId) : undefined,
        home: row.meta.home,
        away: row.meta.away,
        homeTeam: row.homeTeam || row.meta.home,
        awayTeam: row.awayTeam || row.meta.away,
        league: row.meta.league,
        kickoff: row.meta.kickoff || undefined,
        kickoffTimestamp: row.kickoffTimestamp || undefined,
        status: 'finished',
        settled: true,
        settledAt: Date.now(),
        score: {
            htHome: actual.htHome,
            htAway: actual.htAway,
            ftHome: actual.ftHome,
            ftAway: actual.ftAway,
        },
        corners:
            actual.cornersHome !== undefined && actual.cornersAway !== undefined
                ? {
                    home: actual.cornersHome,
                    away: actual.cornersAway,
                    total: actual.cornersHome + actual.cornersAway,
                }
                : undefined,
        picks: settledPicks,
        totalProfit: totalProf,
        summaryOutcome,
    }

    await saveSettledMatch(settledMatch)

    return { record: row, settledMatch }
}

export async function deleteHistory(userId: string, id: string): Promise<boolean> {
    const exists = await getHistoryItem(userId, id)
    if (!exists) return false
    await redis.del(keys.historyItem(userId, id))
    await redis.lrem(keys.historyIds(userId), 0, id)
    return true
}

/** Thống kê gộp — nạp danh sách các trận đã settle từ Redis để tính Win Rate (%), ROI và thắng/hòa/thua */
export async function computeStats(userId: string): Promise<{
    settled: SettledPick[]
    profit: number
    winRate: number
    roi: number
    winsCount: number
    lossesCount: number
    pushesCount: number
    settledMatches: SettledMatchRecord[]
    calibration: CalibrationBin[]
}> {
    const rows = await listHistory(userId, 500)
    const redisSettled = await listSettledMatches(100)

    const settled: SettledPick[] = []
    for (const r of rows) {
        if (!r.result) continue
        const actual: ActualResult = r.result
        for (const p of r.picks) {
            settled.push(settlePick(p, actual, 'ft'))
        }
    }

    // Lợi nhuận chỉ tính trên pick THỰC SỰ có vốn — pick bị loại không được đặt tiền.
    const staked = settled.filter((s) => s.pick.stakePct > 0)
    const nPicks = staked.length
    const winsCount = staked.filter((s) => s.outcome === 'win' || s.outcome === 'win_half').length
    const lossesCount = staked.filter((s) => s.outcome === 'lose' || s.outcome === 'lose_half').length
    const pushesCount = staked.filter((s) => s.outcome === 'push').length

    const winRate = nPicks > 0 ? (winsCount / nPicks) * 100 : 0
    const profit = totalProfit(staked)
    const totalStake = staked.reduce((acc, s) => acc + s.pick.stakePct, 0)
    const roi = totalStake > 0 ? (profit / totalStake) * 100 : 0

    return {
        settled,
        profit,
        winRate,
        roi,
        winsCount,
        lossesCount,
        pushesCount,
        settledMatches: redisSettled,
        calibration: buildCalibration(settled),
    }
}