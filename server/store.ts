import { createHash, randomUUID } from 'node:crypto'
import { keys, redis } from './redis.js'
import type { ActualResult, AnalysisResult, SettledPick, Pick } from '../src/lib/types.js'
import { settlePick, totalProfit, buildCalibration } from '../src/lib/settle.js'

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
    }
    /** Input thuần (dùng để tính lại khi cần). */
    analysis: AnalysisResult
    /** Các pick đã sinh ra (snapshot tại thời điểm phân tích). */
    picks: Pick[]
    /** Kết quả thực tế (null = chưa quyết toán). */
    result: (ActualResult & { note?: string }) | null
    /** Văn bản giải thích 4 phần do Gemini viết (null nếu chưa/bỏ qua). */
    explanation?: import('../src/lib/types.js').Explanation | null
}

function keyHash(s: string): string {
    return createHash('sha256').update(s).digest('hex').slice(0, 12)
}

export async function saveHistory(
    userId: string,
    record: Omit<HistoryRecord, 'id' | 'createdAt'>,
): Promise<HistoryRecord> {
    const id = `h_${randomUUID().slice(0, 8)}_${keyHash(String(Date.now()))}`
    const row: HistoryRecord = { ...record, id, createdAt: Date.now() }
    await redis.set(keys.historyItem(userId, id), row)
    await redis.lpush(keys.historyIds(userId), id)
    return row
}

export async function listHistory(userId: string, limit = 100): Promise<HistoryRecord[]> {
    const raw: unknown = await redis.lrange(keys.historyIds(userId), 0, limit - 1)
    const ids = (Array.isArray(raw) ? raw : []) as string[]
    if (ids.length === 0) return []
    const rows = await Promise.all(
        ids.map(async (id) => (await redis.get(keys.historyItem(userId, id))) as unknown as HistoryRecord | null),
    )
    return rows.filter((r): r is HistoryRecord => r != null)
}

export async function getHistoryItem(
    userId: string,
    id: string,
): Promise<HistoryRecord | null> {
    return (await redis.get(keys.historyItem(userId, id))) as unknown as HistoryRecord | null
}

export async function settleHistory(
    userId: string,
    id: string,
    r: { htHome?: number; htAway?: number; ftHome: number; ftAway: number },
): Promise<HistoryRecord | null> {
    const row = await getHistoryItem(userId, id)
    if (!row) return null
    row.result = {
        htHome: r.htHome ?? 0,
        htAway: r.htAway ?? 0,
        ftHome: r.ftHome,
        ftAway: r.ftAway,
    }
    await redis.set(keys.historyItem(userId, id), row)
    return row
}

export async function deleteHistory(userId: string, id: string): Promise<boolean> {
    const exists = await getHistoryItem(userId, id)
    if (!exists) return false
    await redis.del(keys.historyItem(userId, id))
    await redis.lrem(keys.historyIds(userId), 0, id)
    return true
}

/** Thống kê gộp — đọc hết history và tính lại (với vài trăm bản ghi vẫn nhanh). */
export async function computeStats(userId: string): Promise<{
    settled: SettledPick[]
    profit: number
    calibration: ReturnType<typeof buildCalibration>
}> {
    const rows = await listHistory(userId, 500)
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
    return {
        settled,
        profit: totalProfit(staked),
        calibration: buildCalibration(settled),
    }
}