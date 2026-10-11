import type { ReactNode } from 'react'

interface GlassCardProps {
    children: ReactNode
    className?: string
    interactive?: boolean
    onClick?: () => void
    /** Props giữ tương thích ngược không kích hoạt hiệu ứng chuột */
    specular?: boolean
    edge?: boolean
    magnetic?: boolean
    tilt?: boolean
    refract?: boolean
}

/**
 * Thẻ khung phẳng tối màu cố định (Flat Dark Theme).
 * Không có vệt sáng spotlight theo con trỏ chuột, không phát sáng loang lổ.
 */
export function GlassCard({
    children,
    className = '',
    interactive = false,
    onClick,
}: GlassCardProps) {
    return (
        <div
            onClick={onClick}
            className={[
                'glass',
                interactive ? 'cursor-pointer hover:border-white/20 transition-colors' : '',
                'p-4',
                className,
            ].filter(Boolean).join(' ')}
        >
            {children}
        </div>
    )
}
