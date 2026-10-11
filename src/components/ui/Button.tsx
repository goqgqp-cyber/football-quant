import { motion, useMotionValue, useReducedMotion, useSpring } from 'framer-motion'
import type { PointerEvent, ReactNode } from 'react'

type Variant = 'primary' | 'ghost' | 'danger' | 'value'

interface ButtonProps {
    children: ReactNode
    onClick?: () => void
    type?: 'button' | 'submit'
    variant?: Variant
    disabled?: boolean
    className?: string
    /** Bật hiệu ứng khúc xạ cong ở rìa (dùng filter SVG) */
    refract?: boolean
    /** Hút nhẹ về phía con trỏ (magnetic) */
    magnetic?: boolean
    ariaLabel?: string
}

/* Đơn sắc: primary = trắng phát sáng, value = bạch kim đặc */
const variants: Record<Variant, string> = {
    primary:
        'bg-white text-black border-white/30 shadow-[0_14px_40px_-16px_rgba(255,255,255,0.65)] hover:bg-platinum-300',
    ghost: 'bg-white/5 text-ink-300 border-white/10 hover:text-ink-100 hover:border-white/25',
    danger: 'bg-transparent text-ink-300 border-white/20 hover:border-white/45 hover:text-ink-100',
    value: 'bg-platinum-500 text-black border-white/25 hover:bg-platinum-300',
}

/** Nút spring physics + magnetic cursor + vệt sheen bạch kim. */
export function Button({
    children,
    onClick,
    type = 'button',
    variant = 'primary',
    disabled = false,
    className = '',
    refract = false,
    magnetic = true,
    ariaLabel,
}: ButtonProps) {
    const reduced = useReducedMotion()

    const nx = useMotionValue(0)
    const ny = useMotionValue(0)
    const x = useSpring(nx, { stiffness: 320, damping: 22, mass: 0.3 })
    const y = useSpring(ny, { stiffness: 320, damping: 22, mass: 0.3 })

    const handleMove = (e: PointerEvent<HTMLButtonElement>) => {
        const el = e.currentTarget
        const rect = el.getBoundingClientRect()
        const px = (e.clientX - rect.left) / rect.width
        const py = (e.clientY - rect.top) / rect.height
        el.style.setProperty('--sx', `${px * 100}%`)
        el.style.setProperty('--sy', `${py * 100}%`)
        if (!reduced && magnetic && !disabled) {
            nx.set((px - 0.5) * 10)
            ny.set((py - 0.5) * 8)
        }
    }

    const handleLeave = () => {
        nx.set(0)
        ny.set(0)
    }

    return (
        <motion.button
            type={type}
            aria-label={ariaLabel}
            onClick={onClick}
            disabled={disabled}
            onPointerMove={handleMove}
            onPointerLeave={handleLeave}
            style={{
                ...(!reduced && magnetic ? { x, y } : {}),
                ...(refract ? { filter: 'url(#refraction)' } : {}),
            }}
            whileHover={!disabled && !reduced ? { scale: 1.02 } : undefined}
            whileTap={!disabled && !reduced ? { scale: 0.97 } : undefined}
            transition={{ type: 'spring', stiffness: 500, damping: 28 }}
            className={[
                'group relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-2xl border px-4 py-2.5',
                'text-sm font-semibold font-display tracking-wide select-none',
                'backdrop-blur-xl saturate-150 transition-colors',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                variants[variant],
                className,
            ].join(' ')}
        >
            {/* Vệt sheen lỏng chạy theo con trỏ */}
            {variant === 'primary' || variant === 'value' ? (
                <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                    style={{
                        background:
                            'radial-gradient(140px 90px at var(--sx, 50%) var(--sy, 50%), rgba(255,255,255,0.55), transparent 60%)',
                        mixBlendMode: 'screen',
                    }}
                />
            ) : null}
            <span className="relative z-10 inline-flex items-center gap-2">{children}</span>
        </motion.button>
    )
}
