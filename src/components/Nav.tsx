import { motion } from 'framer-motion'
import type { Route } from '../hooks/useHashRoute'

const ITEMS: { id: Route; label: string; icon: string }[] = [
    { id: 'analyze', label: 'Phân tích', icon: '⚽' },
    { id: 'history', label: 'Lịch sử', icon: '📜' },
    { id: 'performance', label: 'Hiệu suất', icon: '📈' },
    { id: 'account', label: 'Tài khoản', icon: '👤' },
]

function hrefOf(r: Route) {
    return `#/${r}`
}

/** Thanh nav dưới trên mobile. */
export function Nav({ route }: { route: Route }) {
    return (
        <nav
            aria-label="Điều hướng chính"
            className="glass fixed bottom-3 left-3 right-3 z-40 border-t pb-safe md:hidden"
        >
            <ul className="grid grid-cols-4 gap-1 p-2">
                {ITEMS.map((it) => {
                    const active = route === it.id
                    return (
                        <li key={it.id}>
                            <a
                                href={hrefOf(it.id)}
                                className={`relative flex flex-col items-center gap-0.5 rounded-xl px-2 py-2 text-[11px] font-semibold transition-colors ${active ? 'text-ink-100' : 'text-ink-500'
                                    }`}
                                aria-current={active ? 'page' : undefined}
                            >
                                {active && (
                                    <motion.span
                                        layoutId="mobileNavPill"
                                        className="absolute inset-0 rounded-xl bg-violet-500/25"
                                        transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                                    />
                                )}
                                <span className="relative text-lg">{it.icon}</span>
                                <span className="relative">{it.label}</span>
                            </a>
                        </li>
                    )
                })}
            </ul>
        </nav>
    )
}

/** Thanh bên fixed trên desktop. */
export function Sidebar({ route }: { route: Route }) {
    return (
        <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col p-5 md:flex">
            <div className="glass glass--specular p-4">
                <p className="font-display text-lg font-bold">
                    <span className="text-gradient">⚽ Football Quant</span>
                </p>
                <p className="mt-1 text-xs text-ink-500">Poisson · Dixon-Coles · Gemini</p>
            </div>
            <nav aria-label="Điều hướng chính" className="mt-4">
                <ul className="flex flex-col gap-1.5">
                    {ITEMS.map((it) => {
                        const active = route === it.id
                        return (
                            <li key={it.id}>
                                <a
                                    href={hrefOf(it.id)}
                                    className={`relative flex items-center gap-3 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${active ? 'text-ink-100' : 'text-ink-500 hover:text-ink-300'
                                        }`}
                                    aria-current={active ? 'page' : undefined}
                                >
                                    {active && (
                                        <motion.span
                                            layoutId="desktopNavPill"
                                            className="absolute inset-0 rounded-xl border border-violet-400/30 bg-violet-500/20"
                                            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                                        />
                                    )}
                                    <span className="relative text-lg">{it.icon}</span>
                                    <span className="relative">{it.label}</span>
                                </a>
                            </li>
                        )
                    })}
                </ul>
            </nav>
            <div className="mt-auto rounded-2xl border border-white/10 bg-white/5 p-3 text-[11px] leading-relaxed text-ink-500">
                Đây là phân tích xác suất, không bảo đảm kết quả. Chỉ cược số tiền bạn chấp nhận mất.
            </div>
        </aside>
    )
}
