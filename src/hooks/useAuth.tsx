import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, type MeResponse } from '../lib/api'

export type AuthUser = MeResponse['user']

interface AuthState {
    user: AuthUser | null
    loading: boolean
    /** Gọi sau khi đã có user hoặc để làm mới trạng thái. */
    refreshMe: () => Promise<void>
    login: (email: string, password: string) => Promise<void>
    signup: (email: string, password: string) => Promise<void>
    register: (email: string, password: string) => Promise<void>
    logout: () => Promise<void>
    setBankroll: (n: number) => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<AuthUser | null>(null)
    const [loading, setLoading] = useState(true)

    const refreshMe = useCallback(async () => {
        try {
            const { user: u } = await api.me()
            setUser(u)
        } catch (e) {
            // 401/403 = chưa đăng nhập; 0/408 = mạng/timeout.
            // Mọi trường hợp đều coi như chưa đăng nhập để KHÔNG kẹt màn "đang kiểm tra".
            void e
            setUser(null)
        }
    }, [])

    useEffect(() => {
        let cancelled = false
        // Chốt an toàn: nếu mạng/function treo, tối đa 8s phải thoát màn "Đang kiểm tra phiên…"
        const guard = window.setTimeout(() => {
            if (!cancelled) setLoading(false)
        }, 8000)
        refreshMe()
            .catch(() => {
                /* đã xử lý trong refreshMe */
            })
            .finally(() => {
                if (!cancelled) {
                    clearTimeout(guard)
                    setLoading(false)
                }
            })
        return () => {
            cancelled = true
            clearTimeout(guard)
        }
    }, [refreshMe])

    const login = useCallback(async (email: string, password: string) => {
        const { user: u } = await api.login(email, password)
        setUser(u)
    }, [])

    const signup = useCallback(async (email: string, password: string) => {
        const { user: u } = await api.signup(email, password)
        setUser(u)
    }, [])

    const logout = useCallback(async () => {
        await api.logout()
        setUser(null)
    }, [])

    const setBankroll = useCallback(async (n: number) => {
        const { user: u } = await api.updateMe(n)
        setUser(u)
    }, [])

    const register = signup

    const value = useMemo<AuthState>(
        () => ({ user, loading, refreshMe, login, signup, register, logout, setBankroll }),
        [user, loading, refreshMe, login, signup, register, logout, setBankroll],
    )

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
    const ctx = useContext(AuthContext)
    if (!ctx) throw new Error('useAuth phải dùng trong <AuthProvider>')
    return ctx
}