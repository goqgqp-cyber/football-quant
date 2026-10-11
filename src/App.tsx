import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Starfield } from './components/Starfield'
import { RefractionFilter } from './components/ui/RefractionFilter'
import { Nav, Sidebar } from './components/Nav'
import { Footer } from './components/Footer'
import { useHashRoute, type Route } from './hooks/useHashRoute'
import { AnalyzePage } from './pages/AnalyzePage'
import { HistoryPage } from './pages/HistoryPage'
import { PerformancePage } from './pages/PerformancePage'
import { AccountPage } from './pages/AccountPage'

const TITLES: Record<Route, string> = {
    analyze: 'Phân tích',
    history: 'Lịch sử',
    performance: 'Hiệu suất',
    account: 'Tài khoản',
}

export default function App() {
    const [route] = useHashRoute()
    const reduced = useReducedMotion()

    return (
        <div className="relative min-h-dvh">
            <Starfield />
            <RefractionFilter />

            <div className="mx-auto flex w-full max-w-7xl">
                <Sidebar route={route} />

                <main className="flex min-h-dvh w-full flex-col px-4 pb-28 pt-5 md:px-8 md:pb-10 md:pt-8">
                    <header className="mb-5 flex items-center justify-between">
                        <div>
                            <p className="text-[11px] uppercase tracking-[0.2em] text-ink-500">
                                Football Quant
                            </p>
                            <h1 className="font-display text-2xl font-bold tracking-tight md:text-3xl">
                                <span className="text-gradient">{TITLES[route]}</span>
                            </h1>
                        </div>
                        <div className="hidden items-center gap-2 md:flex">
                            <span className="rounded-full border border-violet-400/30 bg-violet-500/10 px-3 py-1 text-xs text-violet-400">
                                G1 · dữ liệu giả
                            </span>
                        </div>
                    </header>

                    <div className="flex-1">
                        <AnimatePresence mode="wait">
                            <motion.div
                                key={route}
                                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12, filter: 'blur(6px)' }}
                                animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, filter: 'blur(0px)' }}
                                exit={reduced ? { opacity: 0 } : { opacity: 0, y: -8, filter: 'blur(6px)' }}
                                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                                className="will-animate"
                            >
                                {route === 'analyze' && <AnalyzePage />}
                                {route === 'history' && <HistoryPage />}
                                {route === 'performance' && <PerformancePage />}
                                {route === 'account' && <AccountPage />}
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
