/**
 * Kiểu dữ liệu dùng chung cho toàn app.
 * G1 dùng dữ liệu giả (mock) theo đúng schema này; G2+ thay bằng dữ liệu thật.
 */

export type {
    TeamInfo,
    MatchScore,
    MatchDetailedStats,
    ExtractedOddsLine,
    QuantRecommendation,
} from '../types/football'

/** Số liệu một đội (từ AI hoặc từ ảnh đã xác nhận). Trường thiếu = null. */
export interface TeamStats {
    /** Bàn thắng kỳ vọng mỗi trận (nếu có nguồn xG) */
    xgf: number | null
    /** Bàn thua kỳ vọng mỗi trận (nếu có nguồn xG) */
    xga: number | null
    /** Bàn thắng trung bình/trận */
    goals_for: number | null
    /** Bàn thua trung bình/trận */
    goals_against: number | null
    /** Số trận dùng để tính mẫu */
    n: number
    /** Danh sách chấn thương/treo giò */
    injuries: string[]
    /** Đội hình dự kiến đã xác nhận hay chưa */
    lineup_confirmed: boolean
}

export interface H2H {
    n: number
    avg_goals: number | null
    btts_rate: number | null
}

export interface Source {
    url: string
    title: string
    fetched_at: string
}

/** JSON chuẩn hoá ở Bước A (xKiro AI Engine). */
export interface MatchData {
    home: TeamStats
    away: TeamStats
    h2h: H2H
    sources: Source[]
    conflicts: string[]
    missing: string[]
    /** Nguồn gốc dữ liệu: 'search' | 'image' | 'manual' */
    origin?: 'search' | 'image' | 'manual'
}

/** Đầu vào một trận (do người dùng nhập / xác nhận). */
export interface MatchInput {
    homeTeam: string
    awayTeam: string
    league: string
    kickoff: string // ISO 8601
    /** Tham số giải (ghi đè mặc định lg_home/lg_away) */
    lg_home?: number
    lg_away?: number
}

/** Loại kèo */
export type MarketKind = 'totals' | 'ah' | 'corners'

/** Một dòng odds người dùng nhập. */
export interface OddsLine {
    id: string
    kind: MarketKind
    /** totals: 'over' | 'under'; ah: 'home' | 'away' */
    side: 'over' | 'under' | 'home' | 'away'
    /** Mốc: 2.5, 3.0, ... hoặc chấp: -0.25, 0, +0.5 ... (từ góc nhìn đội nhà) */
    line: number
    /** Tỉ lệ cược thập phân (>= 1.01) */
    odds: number
    /** Hiệp thi đấu: 'h1' | 'ft' (mặc định 'ft') */
    period?: 'ft' | 'ht' | '1h' | string
    /** Đối tượng kèo: 'goals' (bàn thắng) | 'corners' (phạt góc) */
    object?: 'goals' | 'corners' | string
}

/**
 * Hierarchy of Truth for Match Minute & Clamping Guard:
 * 1. Primary: OCR Minute from screenshot (nếu đọc được phút thật)
 * 2. Secondary: API-Football fixture.status.elapsed
 * 3. TUYỆT ĐỐI KHÔNG dùng Date.now() - kickoffTime cho trận đang đá (tránh lệch múi giờ sinh ra 128')
 * 4. Kẹp chặn: Trận thông thường không thể vượt quá 100 phút (trừ hiệp phụ AET / PEN)
 */
export function resolveMatchMinute(
    ocrMinute?: number | string | null,
    apiElapsed?: number | string | null,
    fixtureStatus?: string | null,
): number | string {
    const statusUpper = (fixtureStatus || '').toUpperCase()
    if (statusUpper === 'FT' || statusUpper === 'AET' || statusUpper === 'PEN' || statusUpper === 'FINISHED') {
        return 'FT'
    }
    if (statusUpper === 'HT') {
        return 'HT'
    }

    const parseMin = (val: unknown): number | null => {
        if (typeof val === 'number' && !isNaN(val)) return val
        if (typeof val === 'string') {
            const clean = val.replace(/[^0-9]/g, '').trim()
            if (clean) {
                const n = parseInt(clean, 10)
                if (!isNaN(n)) return n
            }
        }
        return null
    }

    // 1. Primary: OCR Minute from screenshot
    const ocrParsed = parseMin(ocrMinute)
    const apiParsed = parseMin(apiElapsed)

    let minVal: number | null = null
    if (ocrParsed != null && ocrParsed > 0) {
        minVal = ocrParsed
    } else if (apiParsed != null && apiParsed > 0) {
        // 2. Secondary: API-Football fixture.status.elapsed
        minVal = apiParsed
    }

    if (minVal != null) {
        // Clamping guard: Regular match cannot exceed 100 minutes
        if (minVal > 100 && statusUpper !== 'AET' && statusUpper !== 'PEN') {
            minVal = 90
        }
        return minVal
    }

    if (typeof ocrMinute === 'string' && (ocrMinute.toUpperCase() === 'HT' || ocrMinute.toUpperCase() === 'FT')) {
        return ocrMinute.toUpperCase()
    }
    if (typeof apiElapsed === 'string' && (apiElapsed.toUpperCase() === 'HT' || apiElapsed.toUpperCase() === 'FT')) {
        return apiElapsed.toUpperCase()
    }

    return '—'
}

/** Bộ ba xác suất của một kèo. */
export interface Triple {
    win: number
    push: number
    lose: number
}

export type MarketStatus = 'value' | 'trap' | 'rejected' | 'no_bet'
export type Confidence = 'high' | 'medium' | 'low'

export interface Pick {
    oddsLineId: string
    kind: MarketKind
    period?: 'ft' | 'ht' | '1h' | string
    object?: 'goals' | 'corners' | string
    side: string
    line: number
    odds: number
    /** xác suất mô hình (đã gồm cả phần push nếu kèo chia) */
    pWin: number
    pPush: number
    pLose: number
    /** xác suất ngụ ý từ odds thô */
    pImplied: number
    /** xác suất ngụ ý đã loại vig (nếu có đủ 2 đầu) */
    pImpliedNoVig: number | null
    /** Lợi thế kỳ vọng trên mỗi đơn vị odds: EV/odds */
    edge: number
    /** Giá trị kỳ vọng trên mỗi 1 đơn vị đặt cược */
    ev: number
    confidence: Confidence
    /** % tổng vốn đề xuất (0 nếu không đủ điều kiện) */
    stakePct: number
    status: MarketStatus
    flags: string[]
    /** lệch giữa xác suất mô hình và thị trường (điểm %) */
    marketDelta: number
    /** Điểm xếp hạng tổng hợp EV (60%) + Edge (40%) */
    compositeScore?: number
    /** Nhãn xếp hạng bắt buộc: Top 1 tối ưu hoặc Top 2 dự phòng */
    rankLabel?: '[KÈO TỐI ƯU NHẤT - TOP 1 VALUE]' | '[KÈO DỰ PHÒNG - TOP 2]'
}

/** Kết quả tính toán cho một trận. */
export interface AnalysisResult {
    lambdaHome: number
    lambdaAway: number
    lambdaModel?: { home: number; away: number }
    lambdaMarket?: { home: number; away: number }
    weightModel?: number
    blendReason?: string
    matrix: number[][]
    topScorelines: { score: string; p: number }[]
    picks: Pick[]
    noBet: boolean
    noBetReasons: string[]
}

/** Đầu vào đối soát kết quả sau trận. */
export interface ActualResult {
    htHome: number
    htAway: number
    ftHome: number
    ftAway: number
    cornersHome?: number
    cornersAway?: number
    shotsHome?: number
    shotsAway?: number
    status?: string
    settledAt?: number
}

export interface SettledPick {
    pick: Pick
    outcome: 'win' | 'win_half' | 'push' | 'lose_half' | 'lose'
    /** lợi nhuận theo đơn vị (1 đơn vị = stake) */
    profit: number
}

export interface AccurateWithPct {
    homeCount: number
    homePct: number
    awayCount: number
    awayPct: number
}

/** Thống kê chi tiết chuyên sâu chia 4 nhóm theo layout chuẩn API-Football */
export interface DetailedMatchStatistics {
    // Nhóm 1: Sút bóng & Khung thành (Attacking & Goal Frame)
    possession: { home: number; away: number }
    shotsTotal: { home: number; away: number }
    shotsOnGoal: { home: number; away: number }
    shotsOffGoal: { home: number; away: number }
    shotsBlocked: { home: number; away: number }
    shotsInsideBox?: { home: number; away: number }
    shotsOutsideBox?: { home: number; away: number }
    penalties?: { home: number; away: number }
    expectedGoals?: { home: number; away: number }

    // Nhóm 2: Chuyền bóng & Kiến tạo (Passing & Playmaking)
    totalPasses: { home: number; away: number }
    keyPasses?: { home: number; away: number }
    accuratePasses: AccurateWithPct
    accurateCrosses: AccurateWithPct
    accurateLongBalls: AccurateWithPct

    // Nhóm 3: Tranh chấp & Phòng ngự (Duels & Defense)
    duelsWon?: AccurateWithPct
    aerialDuelsWon?: AccurateWithPct
    tackles: { home: number; away: number }
    interceptions: { home: number; away: number }
    clearances: { home: number; away: number }
    fouls: { home: number; away: number }
    goalkeeperSaves: { home: number; away: number }

    // Nhóm 4: Kỷ luật & Cố định (Discipline & Set Pieces)
    corners: { home: number; away: number }
    offsides: { home: number; away: number }
    yellowCards: { home: number; away: number }
    redCards: { home: number; away: number }
}

/** Dữ liệu sự kiện diễn biến trận đấu */
export interface MatchEventItem {
    time: number
    addedTime?: number
    type: 'goal' | 'card' | 'subst' | 'var' | string
    detail: string
    isHome: boolean
    teamName?: string
    teamLogo?: string
    player?: string
    assist?: string
    score?: string
    playerIn?: string
    playerOut?: string
    comments?: string
}

/** Dữ liệu trận đấu thời gian thực từ API-Football (v3.football.api-sports.io). */
export interface LiveMatchData {
    found: boolean
    eventId?: number
    fixtureId?: number
    homeTeam?: string
    awayTeam?: string
    homeLogo?: string
    awayLogo?: string
    homeTeamId?: number
    awayTeamId?: number
    homeForm?: string[]
    awayForm?: string[]
    league?: string
    status?: 'notstarted' | 'inprogress' | 'finished'
    statusDescription?: string
    minute?: number | string
    score: { home: number; away: number }
    periodScore?: { htHome?: number; htAway?: number; ftHome?: number; ftAway?: number }
    corners: { home: number; away: number; total: number }
    cards: { yellowHome: number; yellowAway: number; redHome: number; redAway: number }
    shotsOnTarget: { home: number; away: number }
    shotsTotal?: { home: number; away: number }
    possession: { home: number; away: number }
    fouls?: { home: number; away: number }
    accuratePasses?: { home: number; away: number }
    detailedStats?: DetailedMatchStatistics
    rawStatistics?: Array<{
        team: { id: number; name: string; logo?: string }
        statistics: Array<{ type: string; value: number | string | null }>
    }>
    incidents?: Array<Record<string, unknown>>
    events?: MatchEventItem[]
    isFinished: boolean
    kickoff?: string
    kickoffTimestamp?: number
    lastUpdated: number
}


/** Bản ghi trận đấu đã tự động đối soát (Auto-Settle) lưu trong Redis. */
export interface SettledMatchRecord {
    id: string
    userId?: string
    recordId?: string
    eventId?: number
    fixtureId?: number
    home: string
    away: string
    homeTeam?: string
    awayTeam?: string
    league?: string
    kickoff?: string
    kickoffTimestamp?: number
    status?: string
    settled?: boolean
    settledAt: number
    score: { htHome: number; htAway: number; ftHome: number; ftAway: number }
    corners?: { home: number; away: number; total: number }
    cards?: { yellowHome: number; yellowAway: number; redHome: number; redAway: number }
    picks: Array<{
        kind: MarketKind
        side: string
        line: number
        odds: number
        outcome: 'win' | 'win_half' | 'push' | 'lose_half' | 'lose'
        profit: number
        staked: boolean
    }>
    totalProfit: number
    summaryOutcome: 'win' | 'push' | 'lose'
}

export interface CalibrationBin {
    label: string
    n: number
    sumPred: number
    wins: number
}

/**
 * Phân tích văn bản do AI (Qwen) viết ở Bước C (G5).
 *
 * Ranh giới bắt buộc: MỌI con số trong `parts` đều đến từ engine, không phải từ LLM.
 * AI chỉ được viết văn và chèn token `{{U1}}`, `{{U2}}`…; server thay token
 * bằng số đã tính sẵn, rồi kiểm tra lại toàn bộ số trong văn bản (verifyNumbers).
 */
export interface Explanation {
    /** 4 phần: (1) đối soát chỉ số, (2) chiến thuật & nhân sự, (3) đánh giá kèo & kịch bản thua, (4) tổng kết */
    parts: [string, string, string, string]
    /** true nếu mọi con số trong văn bản đều khớp với số engine tính ra. */
    verified: boolean
    /** Các con số không truy được về engine (số thừa, số bịa) — hiển thị cảnh báo cho người dùng. */
    unverifiedNumbers: string[]
    /** Ghi chú về dữ liệu thiếu/mâu thuẫn mà AI nêu. */
    caveats: string[]
    model: string
}
