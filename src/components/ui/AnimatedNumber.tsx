import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'framer-motion'

interface AnimatedNumberProps {
    value: number
    /** số chữ số thập phân */
    digits?: number
    /** hậu tố, ví dụ '%' */
    suffix?: string
    /** tiền tố, ví dụ '+' */
    prefix?: string
    /** nhân trước khi hiển thị (ví dụ value là 0.53 -> hiện 53) */
    scale?: number
    durationMs?: number
    className?: string
}

/**
 * Số đếm lên từ 0 bằng requestAnimationFrame. Tôn trọng prefers-reduced-motion
 * (hiển thị thẳng giá trị cuối).
 */
export function AnimatedNumber({
    value,
    digits = 1,
    suffix = '',
    prefix = '',
    scale = 1,
    durationMs = 700,
    className = '',
}: AnimatedNumberProps) {
    const reduced = useReducedMotion()
    const [display, setDisplay] = useState(reduced ? value : 0)
    const rafRef = useRef<number | null>(null)
    const startRef = useRef<number>(0)
    const fromRef = useRef<number>(0)

    useEffect(() => {
        if (reduced) {
            setDisplay(value)
            return
        }
        fromRef.current = display
        startRef.current = performance.now()
        const tick = (now: number) => {
            const t = Math.min(1, (now - startRef.current) / durationMs)
            // easeOutQuint
            const eased = 1 - Math.pow(1 - t, 5)
            setDisplay(fromRef.current + (value - fromRef.current) * eased)
            if (t < 1) rafRef.current = requestAnimationFrame(tick)
        }
        rafRef.current = requestAnimationFrame(tick)
        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value, reduced, durationMs])

    const shown = display * scale
    return (
        <span className={`font-display tabular-nums ${className}`}>
            {prefix}
            {shown.toFixed(digits)}
            {suffix}
        </span>
    )
}
