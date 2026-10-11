import { useEffect, useState, useCallback } from 'react'

export type Route = 'analyze' | 'history' | 'performance' | 'account'

const ROUTES: Route[] = ['analyze', 'history', 'performance', 'account']

function parseRoute(): Route {
    if (typeof window === 'undefined') return 'analyze'

    // Ưu tiên hash (e.g. #/history hoặc #history)
    const h = window.location.hash.replace(/^#\/?/, '')
    const firstHash = h.split('/')[0] as Route
    if (ROUTES.includes(firstHash)) return firstHash

    // Hỗ trợ fallback qua pathname nếu người dùng mở trực tiếp /history
    const p = window.location.pathname.replace(/^\//, '').split('/')[0] as Route
    if (ROUTES.includes(p)) return p

    return 'analyze'
}

/**
 * Router tối giản dựa trên hash — đủ cho 4 trang, không cần thêm dependency.
 * Hỗ trợ fallback từ pathname và tự động chuẩn hoá hash trên thanh địa chỉ.
 */
export function useHashRoute(): [Route, (r: Route) => void] {
    const [route, setRoute] = useState<Route>(() => parseRoute())

    useEffect(() => {
        const onHash = () => setRoute(parseRoute())
        window.addEventListener('hashchange', onHash)

        const initial = parseRoute()
        if (window.location.hash !== `#/${initial}`) {
            window.location.hash = `#/${initial}`
        }

        return () => window.removeEventListener('hashchange', onHash)
    }, [])

    const navigate = useCallback((r: Route) => {
        window.location.hash = `#/${r}`
        window.scrollTo({ top: 0, behavior: 'smooth' })
    }, [])

    return [route, navigate]
}
