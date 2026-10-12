/**
 * Configuration constants for Football Probability Engine (Spec Section 6.1)
 */

export interface EngineConfig {
    DECAY: number
    SHRINK_K: number
    STREAM_WEIGHTS: {
        H_venue: number
        H_all: number
        A_venue: number
        A_all: number
        X: number
    }
    X_RECENCY_FACTOR_STALE: number
    NEWS_ADJUST_CAP_PP: number
    MARKET_BLEND_WEIGHT: number
    BLOCK_NEGATIVE_VALUE: boolean
    MIN_ODDS: number
    DECISION_THRESHOLD: number
}

export const ENGINE_CONFIG: EngineConfig = {
    /** Weight multiplier per match going back in time (1.0 for the newest) */
    DECAY: 0.85,

    /** Pseudo-count toward the prior (Bayesian shrinkage) */
    SHRINK_K: 4,

    /** Base weights for the 5 sample streams */
    STREAM_WEIGHTS: {
        H_venue: 0.25, // Home team's last up to 8 home matches
        H_all: 0.15,   // Home team's last up to 10 matches all competitions
        A_venue: 0.25, // Away team's last up to 8 away matches
        A_all: 0.15,   // Away team's last up to 10 matches all competitions
        X: 0.20,       // Head-to-head, last up to 6 meetings
    },

    /** Recency multiplier for H2H stream if mean meeting age > 3 years */
    X_RECENCY_FACTOR_STALE: 0.5,

    /** Max total team news adjustment in percentage points (+/- 5 pp) */
    NEWS_ADJUST_CAP_PP: 5,

    /** Weight given to market no-vig probability when odds are provided */
    MARKET_BLEND_WEIGHT: 0.30,

    /** When true, downgrades picks with negative value (P_final < break_even) to NO_BET */
    BLOCK_NEGATIVE_VALUE: false,

    /** Minimum odds threshold for recommended picks */
    MIN_ODDS: 1.50,

    /** Decision probability threshold: below 50% is strictly NO_BET */
    DECISION_THRESHOLD: 0.50,
}
