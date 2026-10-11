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
    /** Props giữ tương thích ngược */
    refract?: boolean
    magnetic?: boolean
    ariaLabel?: string
}

/* Đơn sắc chuẩn flat dark */
const variants: Record<Variant, string> = {
    primary:
        'bg-white text-black font-semibold border-white/40 shadow-sm hover:bg-neutral-100',
    ghost: 'bg-white/8 text-slate-100 border-white/14 hover:bg-white/16 hover:text-white',
    danger: 'bg-rose-500/20 text-rose-300 border-rose-500/40 hover:bg-rose-500/30 hover:text-rose-200',
    value: 'bg-emerald-500 text-black font-bold border-emerald-400/40 hover:bg-emerald-400 shadow-md shadow-emerald-500/20',
}

/** Nút bấm phẳng không có vệt sáng chuột. */
export function Button({
    children,
    onClick,
    type = 'button',
    variant = 'primary',
    disabled = false,
    className = '',
    ariaLabel,
}: ButtonProps) {
    const reduced = useReducedMotion()

    return (
        <motion.button
            type={type}
            aria-label={ariaLabel}
            onClick={onClick}
            disabled={disabled}
            whileHover={!disabled && !reduced ? { scale: 1.02 } : undefined}
            whileTap={!disabled && !reduced ? { scale: 0.97 } : undefined}
            transition={{ type: 'spring', stiffness: 500, damping: 28 }}
            className={[
                'group relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-2xl border px-4 py-2.5',
                'text-sm font-semibold font-display tracking-wide select-none',
                'transition-colors',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                variants[variant],
                className,
            ].join(' ')}
        >
            <span className="relative z-10 inline-flex items-center gap-2">{children}</span>
        </motion.button>
    )
}
