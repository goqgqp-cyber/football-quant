import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Starfield } from './components/Starfield'
import { RefractionFilter } from './components/ui/RefractionFilter'
import { Nav, Sidebar } from './components/Nav'
import { Footer } from './components/Footer'
import { useHashRoute, type Route } from './hooks/useHashRoute'
import { useAuth } from './hooks/useAuth'
import { useLenis } from './hooks/useLenis'
import { AnalyzePage } from './pages/AnalyzePage'
import { HistoryPage } from './pages/HistoryPage'
import { PerformancePage } from './pages/PerformancePage'
import { AccountPage } from './pages/AccountPage'
import { AdminPage } from './pages/AdminPage'
import { LoginPage } from './pages/LoginPage'

const TITLES: Record<Route, string> = {
    analyze: 'Phân tích',
    history: 'Lịch sử',
    performance: 'Hiệu suất',
    account: 'Tài khoản',
    admin: 'Quản trị hệ thống',
}

/** Nền vũ trụ dùng chung: bầu trời sao + sao băng (canvas 2D, rất nhẹ). */
function Cosmos() {
    return (
        <>
            <Starfield />
            <div aria-hidden="true" className="star-vignette" />
        </>
    )
}

export default function App() {
    const [route] = useHashRoute()
    const reduced = useReducedMotion()
    const { user, loading, logout } = useAuth()

    // Cuộn quán tính (Lenis-style) cho toàn bộ các lớp UI
    useLenis(true)

    // Chờ xác thực cookie lần đầu (tránh nháy trang Đăng nhập)
    if (loading) {
        return (
            <div className="relative flex min-h-dvh items-center justify-center">
                <Cosmos />
                <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="ui-layer text-sm text-ink-500"
                >
                    Đang kiểm tra phiên đăng nhập…
                </motion.p>
            </div>
        )
    }

    if (!user) {
        return (
            <div className="relative min-h-dvh">
                <Cosmos />
                <RefractionFilter />
                <div className="ui-layer">
                    <LoginPage />
                </div>
            </div>
        )
    }

    return (
        <div className="relative min-h-dvh">
            <Cosmos />
            <RefractionFilter />

            <div className="ui-layer mx-auto flex w-full max-w-7xl">
                <Sidebar route={route} />

                <main className="flex min-h-dvh w-full flex-col px-4 pb-28 pt-5 md:px-8 md:pb-10 md:pt-8">
                    <header className="mb-5 flex items-center justify-between">
                        <div>
                            <p className="eyebrow">Football Quant</p>
                            <h1 className="font-display text-2xl font-bold tracking-tight md:text-3xl">
                                <span className="text-gradient">{TITLES[route]}</span>
                            </h1>
                        </div>
                        <div className="hidden items-center gap-2 md:flex">
                            {user.role === 'admin' && (
                                <span className="rounded-full border border-violet-400/40 bg-violet-500/20 px-2 py-0.5 text-[10px] font-bold text-violet-300">
                                    Admin
                                </span>
                            )}
                            <span
                                className="max-w-[16rem] truncate rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs text-ink-300 backdrop-blur-md"
                                title={user.email}
                            >
                                {user.email}
                            </span>
                            <button
                                type="button"
                                onClick={() => void logout()}
                                className="rounded-full border border-white/12 bg-white/5 px-3 py-1 text-xs text-ink-500 transition-colors hover:border-white/40 hover:text-ink-100"
                            >
                                Đăng xuất
                            </button>
                        </div>
                    </header>

                    <div className="flex-1">
                        <AnimatePresence mode="wait">
                            <motion.div
                                key={route}
                                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
                                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                                
                            >
                                {route === 'analyze' && <AnalyzePage />}
                                {route === 'history' && <HistoryPage />}
                                {route === 'performance' && <PerformancePage />}
                                {route === 'account' && <AccountPage />}
                                {route === 'admin' && (user.role === 'admin' ? <AdminPage /> : <AnalyzePage />)}
                            </motion.div>
                        </AnimatePresence>
                    </div>

                    <Footer />
                </main>
            </div>

            <Nav route={route} />
        </div>
    )
}
