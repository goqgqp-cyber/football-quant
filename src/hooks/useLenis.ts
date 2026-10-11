import { useEffect } from 'react'

/* ==========================================================================
   CUỘN QUÁN TÍNH (Lenis-style, không phụ thuộc ngoài)
   --------------------------------------------------------------------------
   - Bắt wheel + touch, tích luỹ vận tốc rồi nội suy scrollY (lerp) mỗi frame
     => chuyển động cuộn có đà mượt như Lenis/Locomotive.
   - Bỏ qua khi prefers-reduced-motion (trả về cuộn gốc của trình duyệt).
   - Không can thiệp khi con trỏ nằm trong vùng cuộn riêng
     (textarea, .overflow-auto/.overflow-y-auto, [data-lenis-prevent]).
   ========================================================================== */

function isInsideNestedScroller(target: EventTarget | null): boolean {
    let el = target as HTMLElement | null
    while (el && el !== document.body) {
        if (el.dataset && el.dataset.lenisPrevent !== undefined) return true
        const style = window.getComputedStyle(el)
        const oy = style.overflowY
        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 4) {
            return true
        }
        el = el.parentElement
    }
    return false
}

export function useLenis(enabled = true) {
    useEffect(() => {
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
        if (!enabled || mq.matches) return
        // Không chạy trên thiết bị cảm ứng (cuộn gốc đã rất mượt)
        if (window.matchMedia('(hover: none)').matches) return

        let current = window.scrollY
        let target = window.scrollY
        let raf = 0
        let active = true

        const clampTarget = () => {
            const max = document.documentElement.scrollHeight - window.innerHeight
            target = Math.max(0, Math.min(max, target))
        }

        const onWheel = (e: WheelEvent) => {
            if (isInsideNestedScroller(e.target)) return
            e.preventDefault()
            target += e.deltaY * (e.deltaMode === 1 ? 16 : 1) * 1.05
            clampTarget()
        }

        const onResize = () => clampTarget()

        const loop = () => {
            raf = requestAnimationFrame(loop)
            if (!active) return
            const diff = target - current
            if (Math.abs(diff) < 0.4) {
                current = target
            } else {
                current += diff * 0.12
            }
            window.scrollTo(0, current)
        }

        window.addEventListener('wheel', onWheel, { passive: false })
        window.addEventListener('resize', onResize)
        raf = requestAnimationFrame(loop)

        return () => {
            active = false
            cancelAnimationFrame(raf)
            window.removeEventListener('wheel', onWheel)
            window.removeEventListener('resize', onResize)
        }
    }, [enabled])
}