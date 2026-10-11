import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ApiError, api, type MeResponse } from '../lib/api'

export type AuthUser = MeResponse['user']

interface AuthState {
    user: AuthUser | null
    loading: boolean
    /** Gọi sau khi đã có user hoặc để làm mới trạng thái. */
    refreshMe: () => Promise<void>
    login: (email: string, password: string) => Promise<void>
    signup: (email: string, password: string) => Promise<void>
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
            if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
                setUser(null)
            }
        }
    }, [])

    useEffect(() => {
        refreshMe().finally(() => setLoading(false))
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

    const value = useMemo<AuthState>(
        () => ({ user, loading, refreshMe, login, signup, logout, setBankroll }),
        [user, loading, refreshMe, login, signup, logout, setBankroll],
    )

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
    const ctx = useContext(AuthContext)
    if (!ctx) throw new Error('useAuth phải dùng trong <AuthProvider>')
    return ctx
}