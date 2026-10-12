/**
 * Trích xuất phong độ 5 trận gần nhất trực tiếp từ API-Football (api-football.com / v3.football.api-sports.io)
 * Tự động làm sạch key, loại bỏ tiền tố markdown "- ", hỗ trợ direct client call và server proxy fallback.
 */

export function sanitizeApiFootballKey(key?: string | null): string {
    if (!key) return ''
    return String(key)
        .trim()
        .replace(/^['"]+|['"]+$/g, '')
        .replace(/^[-*•\s]+/, '')
        .trim()
}

const metaEnv =
    typeof import.meta !== 'undefined'
        ? (import.meta as unknown as { env?: Record<string, string> }).env
        : undefined

const RAW_API_KEY =
    (typeof process !== 'undefined' &&
        (process.env?.API_FOOTBALL_KEY || process.env?.NEXT_PUBLIC_API_FOOTBALL_KEY)) ||
    metaEnv?.VITE_API_FOOTBALL_KEY ||
    metaEnv?.API_FOOTBALL_KEY ||
    metaEnv?.NEXT_PUBLIC_API_FOOTBALL_KEY ||
    'fcbc53a3d31e0c893167b8da80e7f846'

export const CLEAN_API_KEY =
    sanitizeApiFootballKey(RAW_API_KEY) || 'fcbc53a3d31e0c893167b8da80e7f846'

export function getApiFootballHeaders() {
    return {
        'x-apisports-key': CLEAN_API_KEY,
    }
}

export async function fetchTeamRecentForm(teamId: number): Promise<string[]> {
    if (!teamId || teamId <= 0) return []
    try {
        const apiKey = CLEAN_API_KEY

        // 1. Thử gọi trực tiếp v3.football.api-sports.io với headers chuẩn hóa
        if (apiKey) {
            try {
                const res = await fetch(
                    `https://v3.football.api-sports.io/fixtures?team=${teamId}&last=5&status=FT`,
                    {
                        headers: {
                            ...getApiFootballHeaders(),
                            Accept: 'application/json',
                        },
                    },
                )
                if (res.ok) {
                    const data = await res.json()
                    if (data.response && Array.isArray(data.response) && data.response.length > 0) {
                        return data.response.map((f: any) => {
                            const isHome = f.teams?.home?.id === teamId
                            const myGoals = Number(
                                isHome
                                    ? (f.goals?.home ?? f.score?.fulltime?.home ?? 0)
                                    : (f.goals?.away ?? f.score?.fulltime?.away ?? 0),
                            )
                            const oppGoals = Number(
                                isHome
                                    ? (f.goals?.away ?? f.score?.fulltime?.away ?? 0)
                                    : (f.goals?.home ?? f.score?.fulltime?.home ?? 0),
                            )
                            if (myGoals > oppGoals) return 'W'
                            if (myGoals === oppGoals) return 'D'
                            return 'L'
                        })
                    }
                }
            } catch {
                // Fallback xuống server proxy bên dưới
            }
        }

        // 2. Fallback: gọi qua server proxy /api/football có tích hợp cache và bảo mật key
        const proxyRes = await fetch(`/api/football/fixtures?team=${teamId}&last=5&status=FT`, {
            headers: { Accept: 'application/json' },
        })
        if (proxyRes.ok) {
            const data = await proxyRes.json()
            const list = Array.isArray(data) ? data : data.response
            if (Array.isArray(list) && list.length > 0) {
                return list.map((f: any) => {
                    const isHome = f.teams?.home?.id === teamId
                    const myGoals = Number(
                        isHome
                            ? (f.goals?.home ?? f.score?.fulltime?.home ?? 0)
                            : (f.goals?.away ?? f.score?.fulltime?.away ?? 0),
                    )
                    const oppGoals = Number(
                        isHome
                            ? (f.goals?.away ?? f.score?.fulltime?.away ?? 0)
                            : (f.goals?.home ?? f.score?.fulltime?.home ?? 0),
                    )
                    if (myGoals > oppGoals) return 'W'
                    if (myGoals === oppGoals) return 'D'
                    return 'L'
                })
            }
        }

        return []
    } catch {
        return []
    }
}
