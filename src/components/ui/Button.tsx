import { motion, useReducedMotion } from 'framer-motion'
import type { ReactNode } from 'react'

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
    ariaLabel?: string
}

const variants: Record<Variant, string> = {
    primary:
        'bg-gradient-to-br from-violet-500 to-violet-600 text-ink-100 border-white/20 shadow-[0_10px_30px_-10px_rgba(124,58,237,0.8)]',
    ghost: 'bg-white/5 text-ink-300 border-white/10 hover:text-ink-100',
    danger: 'bg-gradient-to-br from-danger-500 to-danger-400 text-white border-white/20',
    value: 'bg-gradient-to-br from-value-500 to-value-400 text-void-900 border-white/20',
}

/** Nút có spring physics + phát sáng tím khi hover. */
export function Button({
    children,
    onClick,
    type = 'button',
    variant = 'primary',
    disabled = false,
    className = '',
    refract = false,
    ariaLabel,
}: ButtonProps) {
    const reduced = useReducedMotion()
    return (
        <motion.button
            type={type}
            aria-label={ariaLabel}
            onClick={onClick}
            disabled={disabled}
            whileHover={!disabled && !reduced ? { y: -2, scale: 1.01 } : undefined}
            whileTap={!disabled && !reduced ? { scale: 0.97 } : undefined}
            transition={{ type: 'spring', stiffness: 500, damping: 28 }}
            className={[
                'relative inline-flex items-center justify-center gap-2 rounded-2xl border px-4 py-2.5',
                'text-sm font-semibold font-display tracking-wide select-none',
                'backdrop-blur-xl saturate-150 transition-colors',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                variants[variant],
                className,
            ].join(' ')}
            style={refract ? { filter: 'url(#refraction)' } : undefined}
        >
            {children}
        </motion.button>
    )
}
