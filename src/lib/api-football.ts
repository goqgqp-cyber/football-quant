/**
 * Trích xuất phong độ 5 trận gần nhất trực tiếp từ API-Football
 */
export async function fetchTeamRecentForm(teamId: number): Promise<string[]> {
    if (!teamId || teamId <= 0) return []
    try {
        const apiKey =
            typeof process !== 'undefined' && process.env?.API_FOOTBALL_KEY
                ? process.env.API_FOOTBALL_KEY
                : '32ef4117471d08b60402e551a089faff'

        const res = await fetch(`https://v3.football.api-sports.io/fixtures?team=${teamId}&last=5&status=FT`, {
            headers: { 'x-apisports-key': apiKey },
        })
        const data = await res.json()
        if (!data.response || !Array.isArray(data.response) || data.response.length === 0) return []

        return data.response.map((f: any) => {
            const isHome = f.teams?.home?.id === teamId
            const myGoals = Number(isHome ? (f.goals?.home ?? f.score?.fulltime?.home ?? 0) : (f.goals?.away ?? f.score?.fulltime?.away ?? 0))
            const oppGoals = Number(isHome ? (f.goals?.away ?? f.score?.fulltime?.away ?? 0) : (f.goals?.home ?? f.score?.fulltime?.home ?? 0))
            if (myGoals > oppGoals) return 'W'
            if (myGoals === oppGoals) return 'D'
            return 'L'
        })
    } catch {
        return []
    }
}
