import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'framer-motion'
import type { ReactNode, PointerEvent } from 'react'

interface GlassCardProps {
    children: ReactNode
    className?: string
    /** Vệt sáng phản chiếu theo con trỏ */
    specular?: boolean
    /** Viền sáng gradient bạch kim mảnh */
    edge?: boolean
    /** Nâng nhẹ khi hover */
    interactive?: boolean
    /** Hút nhẹ về phía con trỏ (magnetic) */
    magnetic?: boolean
    /** Nghiêng 3D theo con trỏ */
    tilt?: boolean
    /** Hiệu ứng khúc xạ cong ở rìa (SVG #refraction) */
    refract?: boolean
    onClick?: () => void
}

/**
 * Thẻ kính lỏng bạch kim.
 * - Specular + sheen theo con trỏ qua CSS var --mx/--my/--sx/--sy.
 * - Tilt 3D + magnetic dùng spring physics của Framer Motion.
 * - Tự tắt hiệu ứng khi prefers-reduced-motion.
 */
export function GlassCard({
    children,
    className = '',
    specular = true,
    edge = true,
    interactive = false,
    magnetic = false,
    tilt = false,
    refract = false,
    onClick,
}: GlassCardProps) {
    const reduced = useReducedMotion()

    const nx = useMotionValue(0)
    const ny = useMotionValue(0)
    const sx = useSpring(nx, { stiffness: 260, damping: 26, mass: 0.4 })
    const sy = useSpring(ny, { stiffness: 260, damping: 26, mass: 0.4 })

    const rotateX = useTransform(sy, [-0.5, 0.5], ['5deg', '-5deg'])
    const rotateY = useTransform(sx, [-0.5, 0.5], ['-5deg', '5deg'])
    const tx = useTransform(sx, [-0.5, 0.5], ['-7px', '7px'])
    const ty = useTransform(sy, [-0.5, 0.5], ['-5px', '5px'])

    const handleMove = (e: PointerEvent<HTMLDivElement>) => {
        const el = e.currentTarget
        const rect = el.getBoundingClientRect()
        const px = (e.clientX - rect.left) / rect.width
        const py = (e.clientY - rect.top) / rect.height

        if (specular) {
            el.style.setProperty('--mx', `${px * 100}%`)
            el.style.setProperty('--my', `${py * 100}%`)
        }
        el.style.setProperty('--sx', `${px * 100}%`)
        el.style.setProperty('--sy', `${py * 100}%`)

        if (!reduced && (tilt || magnetic)) {
            nx.set(px - 0.5)
            ny.set(py - 0.5)
        }
    }

    const handleLeave = () => {
        nx.set(0)
        ny.set(0)
    }

    const live3d = !reduced && (tilt || magnetic)

    return (
        <motion.div
            onPointerMove={handleMove}
            onPointerLeave={handleLeave}
            onClick={onClick}
            whileHover={interactive && !reduced ? { y: -3 } : undefined}
            whileTap={interactive && !reduced ? { scale: 0.99 } : undefined}
            style={{
                ...(live3d
                    ? {
                        rotateX: tilt ? rotateX : 0,
                        rotateY: tilt ? rotateY : 0,
                        x: magnetic ? tx : 0,
                        y: magnetic ? ty : 0,
                        transformPerspective: 1000,
                    }
                    : {}),
                ...(refract ? { filter: 'url(#refraction)' } : {}),
            }}
            transition={{ type: 'spring', stiffness: 420, damping: 30 }}
            className={[
                'glass',
                specular ? 'glass--specular' : '',
                edge ? 'glass--edge' : '',
                'glass--sheen',
                interactive ? 'cursor-pointer' : '',
                'p-4',
                className,
            ].join(' ')}
        >
            {children}
        </motion.div>
    )
}
