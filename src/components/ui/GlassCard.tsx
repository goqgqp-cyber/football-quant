import { motion, useReducedMotion } from 'framer-motion'
import type { ReactNode, PointerEvent } from 'react'

interface GlassCardProps {
    children: ReactNode
    className?: string
    /** Bật vệt sáng phản chiếu theo con trỏ */
    specular?: boolean
    /** Bật viền sáng gradient mảnh */
    edge?: boolean
    /** Bật hiệu ứng nâng nhẹ khi hover */
    interactive?: boolean
    onClick?: () => void
}

/**
 * Thẻ kính lỏng. Specular highlight theo con trỏ qua CSS var --mx/--my.
 */
export function GlassCard({
    children,
    className = '',
    specular = true,
    edge = true,
    interactive = false,
    onClick,
}: GlassCardProps) {
    const reduced = useReducedMotion()

    const handleMove = (e: PointerEvent<HTMLDivElement>) => {
        if (!specular) return
        const el = e.currentTarget
        const rect = el.getBoundingClientRect()
        const mx = ((e.clientX - rect.left) / rect.width) * 100
        const my = ((e.clientY - rect.top) / rect.height) * 100
        el.style.setProperty('--mx', `${mx}%`)
        el.style.setProperty('--my', `${my}%`)
    }

    return (
        <motion.div
            onPointerMove={handleMove}
            onClick={onClick}
            whileHover={interactive && !reduced ? { y: -3 } : undefined}
            whileTap={interactive && !reduced ? { scale: 0.99 } : undefined}
            transition={{ type: 'spring', stiffness: 420, damping: 30 }}
            className={[
                'glass',
                specular ? 'glass--specular' : '',
                edge ? 'glass--edge' : '',
                interactive ? 'cursor-pointer' : '',
                'p-4',
                className,
            ].join(' ')}
        >
            {children}
        </motion.div>
    )
}
