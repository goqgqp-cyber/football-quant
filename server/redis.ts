import { Redis } from '@upstash/redis'
import { env } from './env.js'

/**
 * Client Upstash Redis qua REST.
 * Chỉ dùng ở server. Không bao giờ lộ URL/TOKEN ra frontend.
 */
export const redis = new Redis({
    url: env.upstashUrl,
    token: env.upstashToken,
    automaticDeserialization: true,
})

/**
 * Quy ước khóa — MỌI dữ liệu người dùng đều nằm dưới tiền tố `u:{userId}:`
 * để bảo đảm cô lập dữ liệu giữa các tài khoản (yêu cầu bảo mật của spec).
 */
export const keys = {
    // ---- Toàn cục ----
    userByEmail: (email: string) => `email2uid:${email.toLowerCase()}`,
    user: (userId: string) => `user:${userId}`,
    loginFails: (email: string) => `loginfail:${email.toLowerCase()}`,

    // ---- Phiên đăng nhập ----
    /** Hash thông tin 1 phiên: hash refresh token, userId, createdAt, ua, ip. */
    session: (userId: string, sessionId: string) => `u:${userId}:session:${sessionId}`,
    /** Tập hợp các sessionId đang hoạt động của user (để thu hồi toàn bộ). */
    sessionSet: (userId: string) => `u:${userId}:sessions`,
    /** Đánh dấu refresh token đã dùng (phát hiện reuse). */
    refreshUsed: (userId: string, sessionId: string) =>
        `u:${userId}:refresh_used:${sessionId}`,

    // ---- Dữ liệu phân tích ----
    /** Danh sách id các lượt phân tích, mới nhất ở đầu (LPUSH). */
    historyIds: (userId: string) => `u:${userId}:history:ids`,
    /** Bản ghi 1 lượt phân tích (kèm pick + trạng thái). */
    historyItem: (userId: string, id: string) => `u:${userId}:history:item:${id}`,
    /** Kết quả thực tế để quyết toán. */
    settleItem: (userId: string, id: string) => `u:${userId}:settle:${id}`,
    /** Chỉ số hiệu suất tổng hợp (hash). */
    stats: (userId: string) => `u:${userId}:stats`,
    /** Bins calibration theo loại kèo (hash). */
    calibration: (userId: string) => `u:${userId}:calibration`,
} as const

/** Đảm bảo kết nối Redis hoạt động (dùng ở health check). */
export async function pingRedis(): Promise<boolean> {
    try {
        const pong = await redis.ping()
        return pong === 'PONG'
    } catch {
        return false
    }
}