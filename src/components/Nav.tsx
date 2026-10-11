import { motion } from 'framer-motion'
import type { Route } from '../hooks/useHashRoute'
import { useAuth } from '../hooks/useAuth'

/** Icon nét mảnh (monochrome, dùng currentColor) — không dùng emoji màu. */
function Icon({ id, className = '' }: { id: Route; className?: string }) {
    const common = {
        className,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round' as const,
        strokeLinejoin: 'round' as const,
        'aria-hidden': true,
    }
    switch (id) {
        case 'analyze':
            return (
                <svg {...common}>
                    <circle cx="12" cy="12" r="8" />
                    <circle cx="12" cy="12" r="3" />
                    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                </svg>
            )
        case 'history':
            return (
                <svg {...common}>
                    <circle cx="12" cy="12" r="8.5" />
                    <path d="M12 7.5V12l3 2" />
                </svg>
            )
        case 'performance':
            return (
                <svg {...common}>
                    <path d="M4 19V5M4 19h16" />
                    <path d="M7 15l3.5-4 3 2.5L20 7" />
                </svg>
            )
        case 'account':
            return (
                <svg {...common}>
                    <circle cx="12" cy="8.5" r="3.5" />
                    <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" />
                </svg>
            )
        case 'admin':
            return (
                <svg {...common}>
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    <circle cx="12" cy="11" r="3" />
                </svg>
            )
    }
}

const BASE_ITEMS: { id: Route; label: string }[] = [
    { id: 'analyze', label: 'Phân tích' },
    { id: 'history', label: 'Lịch sử' },
    { id: 'performance', label: 'Hiệu suất' },
    { id: 'account', label: 'Tài khoản' },
]

function hrefOf(r: Route) {
    return `#/${r}`
}

/** Thanh nav dưới trên mobile. */
export function Nav({ route }: { route: Route }) {
    const { user } = useAuth()
    const isAdmin = user?.role === 'admin'
    const items = isAdmin
        ? [...BASE_ITEMS, { id: 'admin' as Route, label: 'Quản trị' }]
        : BASE_ITEMS

    return (
        <nav
            aria-label="Điều hướng chính"
            className="glass glass--specular fixed bottom-3 left-3 right-3 z-40 md:hidden"
        >
            <ul className={`grid ${isAdmin ? 'grid-cols-5' : 'grid-cols-4'} gap-1 p-2`}>
                {items.map((it) => {
                    const active = route === it.id
                    return (
                        <li key={it.id}>
                            <a
                                href={hrefOf(it.id)}
                                className={`relative flex flex-col items-center gap-1 rounded-xl px-1.5 py-2 text-[10px] font-semibold transition-colors ${active ? 'text-white' : 'text-ink-500'
                                    }`}
                                aria-current={active ? 'page' : undefined}
                            >
                                {active && (
                                    <motion.span
                                        layoutId="mobileNavPill"
                                        className="absolute inset-0 rounded-xl border border-white/20 bg-white/10"
                                        transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                                    />
                                )}
                                <Icon id={it.id} className="relative h-5 w-5" />
                                <span className="relative tracking-wide">{it.label}</span>
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
    const { user } = useAuth()
    const isAdmin = user?.role === 'admin'
    const items = isAdmin
        ? [...BASE_ITEMS, { id: 'admin' as Route, label: 'Quản trị' }]
        : BASE_ITEMS

    return (
        <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col p-5 md:flex">
            <div className="glass glass--specular glass--sheen p-4">
                <p className="font-display text-lg font-bold tracking-tight">
                    <span className="text-gradient">Football Quant</span>
                </p>
                <p className="mt-1 text-[11px] uppercase tracking-[0.2em] text-ink-500">
                    POISSON · DIXON-COLES · QWEN
                </p>
            </div>
            <nav aria-label="Điều hướng chính" className="mt-4">
                <ul className="flex flex-col gap-1.5">
                    {items.map((it) => {
                        const active = route === it.id
                        return (
                            <li key={it.id}>
                                <a
                                    href={hrefOf(it.id)}
                                    className={`relative flex items-center justify-between rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${active ? 'text-white' : 'text-ink-500 hover:text-ink-300'
                                        }`}
                                    aria-current={active ? 'page' : undefined}
                                >
                                    {active && (
                                        <motion.span
                                            layoutId="desktopNavPill"
                                            className="absolute inset-0 rounded-xl border border-white/25 bg-white/12"
                                            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                                        />
                                    )}
                                    <div className="relative flex items-center gap-3">
                                        <Icon id={it.id} className="h-5 w-5" />
                                        <span className="tracking-wide">{it.label}</span>
                                    </div>
                                    {it.id === 'admin' && (
                                        <span className="relative rounded-full border border-violet-400/30 bg-violet-500/20 px-1.5 py-0.5 text-[9px] font-bold text-violet-300">
                                            ADM
                                        </span>
                                    )}
                                </a>
                            </li>
                        )
                    })}
                </ul>
            </nav>
            <div className="mt-auto rounded-2xl border border-white/10 bg-white/5 p-3 text-[11px] leading-relaxed text-ink-500 backdrop-blur-md">
                Đây là phân tích xác suất, không bảo đảm kết quả. Chỉ cược số tiền bạn chấp nhận mất.
            </div>
        </aside>
    )
}
