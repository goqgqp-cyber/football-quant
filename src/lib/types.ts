/**
 * Kiểu dữ liệu dùng chung cho toàn app.
 * G1 dùng dữ liệu giả (mock) theo đúng schema này; G2+ thay bằng dữ liệu thật.
 */

/** Số liệu một đội (từ Gemini hoặc từ ảnh đã xác nhận). Trường thiếu = null. */
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

/** JSON chuẩn hoá ở Bước A (Gemini + Google Search grounding). */
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
export type MarketKind = 'totals' | 'ah'

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
}

/** Kết quả tính toán cho một trận. */
export interface AnalysisResult {
    lambdaHome: number
    lambdaAway: number
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
}

export interface SettledPick {
    pick: Pick
    outcome: 'win' | 'win_half' | 'push' | 'lose_half' | 'lose'
    /** lợi nhuận theo đơn vị (1 đơn vị = stake) */
    profit: number
}

export interface CalibrationBin {
    label: string
    n: number
    sumPred: number
    wins: number
}
