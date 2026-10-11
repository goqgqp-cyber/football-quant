import { useEffect, useRef } from 'react'

/* ==========================================================================
   TRƯỜNG BỤI VŨ TRỤ — hạt bị hút về kỳ dị (Newtonian gravity + vector field)
   --------------------------------------------------------------------------
   Lớp canvas 2D nằm TRÊN hố đen (z-index 1), DƯỚI nội dung UI.
   - Hạt trôi chậm, chịu lực hút ~ 1/r² về tâm hố đen.
   - Hạt tới gần chân trời thì bị "nuốt" và tái sinh ở rìa (giữ mật độ ổn định).
   - Parallax theo con trỏ + độ sâu (z) tạo cảm giác 3D.
   - Đơn sắc: trắng nguyệt → bạc → xám, alpha theo độ sâu.
   - Tôn trọng prefers-reduced-motion; tạm dừng khi tab ẩn; DPR kẹp ≤ 2.
   ========================================================================== */

interface Dust {
    x: number
    y: number
    vx: number
    vy: number
    z: number // 0..1 độ sâu (nhỏ = xa)
    r: number
    a: number // alpha nền
    tw: number // pha nhấp nháy
}

export function CosmicDust() {
    const canvasRef = useRef<HTMLCanvasElement | null>(null)

    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d', { alpha: true })
        if (!ctx) return

        const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
        let reduced = mq.matches
        const onMq = () => {
            reduced = mq.matches
        }
        mq.addEventListener?.('change', onMq)

        const isSmall = window.innerWidth < 768
        const maxDpr = isSmall ? 1.5 : 2
        let dpr = Math.min(window.devicePixelRatio || 1, maxDpr)

        let w = 0
        let h = 0
        let cx = 0
        let cy = 0
        let horizon = 0 // bán kính "chân trời" (px) — hạt vào trong thì bị nuốt

        const particles: Dust[] = []

        const spawn = (edge: boolean): Dust => {
            const z = Math.random()
            // Tái sinh ở rìa xa để không hiện đột ngột gần tâm
            const ang = Math.random() * Math.PI * 2
            const rad = edge ? Math.max(w, h) * (0.62 + Math.random() * 0.5) : Math.random() * Math.max(w, h) * 0.6
            const x = cx + Math.cos(ang) * rad
            const y = cy + Math.sin(ang) * rad * 0.62
            return {
                x,
                y,
                vx: (Math.random() - 0.5) * 0.06,
                vy: (Math.random() - 0.5) * 0.06,
                z,
                r: 0.35 + z * 1.25,
                a: 0.25 + Math.random() * 0.55,
                tw: Math.random() * Math.PI * 2,
            }
        }

        const build = () => {
            particles.length = 0
            const target = Math.min(Math.round((w * h) / (isSmall ? 11000 : 7000)), isSmall ? 120 : 300)
            for (let i = 0; i < target; i++) particles.push(spawn(false))
        }

        const resize = () => {
            w = canvas.clientWidth
            h = canvas.clientHeight
            dpr = Math.min(window.devicePixelRatio || 1, maxDpr)
            canvas.width = Math.max(1, Math.floor(w * dpr))
            canvas.height = Math.max(1, Math.floor(h * dpr))
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
            cx = w * 0.5
            cy = h * 0.42 // hố đen hơi cao hơn tâm để chừa chỗ cho đĩa + UI
            horizon = Math.min(w, h) * 0.085
            build()
        }
        resize()
        window.addEventListener('resize', resize)

        // Con trỏ nội suy (parallax)
        const ptr = { x: 0.5, y: 0.5, sx: 0.5, sy: 0.5 }
        const onPointer = (e: PointerEvent) => {
            ptr.x = e.clientX / window.innerWidth
            ptr.y = e.clientY / window.innerHeight
        }
        window.addEventListener('pointermove', onPointer, { passive: true })

        const onOrient = (e: DeviceOrientationEvent) => {
            const g = e.gamma ?? 0
            const b = e.beta ?? 0
            ptr.x = 0.5 + Math.max(-0.5, Math.min(0.5, g / 90))
            ptr.y = 0.5 + Math.max(-0.5, Math.min(0.5, (b - 45) / 90))
        }
        window.addEventListener('deviceorientation', onOrient, { passive: true })

        const running = { on: true }
        let raf = 0
        const start = performance.now()

        const draw = (now: number) => {
            raf = requestAnimationFrame(draw)
            if (!running.on) return

            ptr.sx += (ptr.x - ptr.sx) * 0.05
            ptr.sy += (ptr.y - ptr.sy) * 0.05
            const px = (ptr.sx - 0.5) * 24
            const py = (ptr.sy - 0.5) * 18

            ctx.clearRect(0, 0, w, h)

            const t = (now - start) / 1000
            const G = reduced ? 0 : 5200 // hằng số hấp dẫn (px³/s²)

            for (const d of particles) {
                if (!reduced) {
                    const dx = cx - d.x
                    const dy = cy - d.y
                    const dist2 = dx * dx + dy * dy
                    const dist = Math.sqrt(dist2) + 0.001
                    // Gia tốc ~ G / r², kẹp để không nổ số gần tâm
                    const acc = Math.min(G / Math.max(dist2, 900), 1.6) * (0.4 + d.z * 0.9)
                    d.vx += (dx / dist) * acc * 0.016
                    d.vy += (dy / dist) * acc * 0.016
                    // Cản nhẹ để hạt không tăng tốc vô hạn
                    d.vx *= 0.995
                    d.vy *= 0.995
                    d.x += d.vx * (0.4 + d.z)
                    d.y += d.vy * (0.4 + d.z)

                    // Bị nuốt qua chân trời -> tái sinh ở rìa
                    if (dist < horizon) {
                        Object.assign(d, spawn(true))
                        continue
                    }
                }

                const sx = d.x + px * d.z
                const sy = d.y + py * d.z
                if (sx < -60 || sx > w + 60 || sy < -60 || sy > h + 60) continue

                const twinkle = reduced ? 0.8 : 0.6 + 0.4 * Math.sin(t * 1.3 + d.tw)
                // Càng gần tâm càng sáng (ánh sáng bị bẻ cong đổ về chân trời)
                const dxc = sx - cx
                const dyc = sy - cy
                const near = Math.max(0, 1 - Math.hypot(dxc, dyc) / (Math.max(w, h) * 0.5))
                const alpha = Math.min(0.95, d.a * twinkle * (0.35 + near * 0.9))
                const lum = 150 + Math.round(near * 90 + d.z * 20)

                ctx.beginPath()
                ctx.arc(sx, sy, d.r, 0, Math.PI * 2)
                ctx.fillStyle = `rgba(${lum},${lum},${Math.min(255, lum + 12)},${alpha})`
                ctx.fill()
            }
        }
        raf = requestAnimationFrame(draw)

        const onVisibility = () => {
            running.on = !document.hidden
        }
        document.addEventListener('visibilitychange', onVisibility)

        return () => {
            cancelAnimationFrame(raf)
            window.removeEventListener('resize', resize)
            window.removeEventListener('pointermove', onPointer)
            window.removeEventListener('deviceorientation', onOrient)
            document.removeEventListener('visibilitychange', onVisibility)
            mq.removeEventListener?.('change', onMq)
        }
    }, [])

    return (
        <canvas ref={canvasRef} aria-hidden="true" className="dust-layer h-full w-full" />
    )
}