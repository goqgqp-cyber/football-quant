import { useEffect, useState, useCallback } from 'react'

export type Route = 'analyze' | 'history' | 'performance' | 'account'

const ROUTES: Route[] = ['analyze', 'history', 'performance', 'account']

function parseHash(): Route {
    const h = window.location.hash.replace(/^#\/?/, '')
    const first = h.split('/')[0] as Route
    return ROUTES.includes(first) ? first : 'analyze'
}

/**
 * Router tối giản dựa trên hash — đủ cho 4 trang, không cần thêm dependency.
 */
export function useHashRoute(): [Route, (r: Route) => void] {
    const [route, setRoute] = useState<Route>(() =>
        typeof window === 'undefined' ? 'analyze' : parseHash(),
    )

    useEffect(() => {
        const onHash = () => setRoute(parseHash())
        window.addEventListener('hashchange', onHash)
        if (!window.location.hash) window.location.hash = '#/analyze'
        return () => window.removeEventListener('hashchange', onHash)
    }, [])

    const navigate = useCallback((r: Route) => {
        window.location.hash = `#/${r}`
        window.scrollTo({ top: 0, behavior: 'smooth' })
    }, [])

    return [route, navigate]
}
