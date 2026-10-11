/**
 * SVG filter tạo hiệu ứng khúc xạ cong ở rìa kính (feTurbulence + feDisplacementMap).
 * Dùng cho các thành phần nổi bật (thẻ kết quả chính, nút chính).
 * Trình duyệt không hỗ trợ sẽ bỏ qua filter (CSS fallback đã có trong .glass).
 */
export function RefractionFilter() {
    return (
        <svg
            aria-hidden="true"
            focusable="false"
            width="0"
            height="0"
            style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
        >
            <defs>
                <filter id="refraction" x="-20%" y="-20%" width="140%" height="140%">
                    <feTurbulence
                        type="fractalNoise"
                        baseFrequency="0.008 0.014"
                        numOctaves="2"
                        seed="7"
                        result="noise"
                    />
                    <feGaussianBlur in="noise" stdDeviation="2" result="blurredNoise" />
                    <feDisplacementMap
                        in="SourceGraphic"
                        in2="blurredNoise"
                        scale="14"
                        xChannelSelector="R"
                        yChannelSelector="B"
                    />
                </filter>
            </defs>
        </svg>
    )
}

/** Skeleton dạng kính cho vùng đang tải. */
export function Skeleton({ className = '' }: { className?: string }) {
    return <div className={`skeleton ${className}`} aria-hidden="true" />
}