/**
 * BẦU TRỜI SAO BĂNG — canvas 2D thuần (KHÔNG WebGL, không GPU nặng).
 * --------------------------------------------------------------------------
 * Thay thế hố đen WebGL: rất nhẹ, chạy mượt trên máy yếu và không làm nóng GPU.
 *  - Trường sao nhấp nháy (twinkle) với parallax theo con trỏ.
 *  - Sao băng (meteor) xuất hiện ngẫu nhiên, vệt mờ dần ở đuôi.
 *  - Tôn trọng prefers-reduced-motion (đứng yên, không sao băng).
 *  - Tạm dừng khi tab ẩn; DPR kẹp ≤ 2 (≤ 1.5 trên mobile); dọn sạch listener.
 */
import { useEffect, useRef } from 'react'

interface Star {
    x: number
    y: number
    z: number // 0..1 độ sâu (parallax)
    r: number
    a: number // alpha nền
    tw: number // pha nhấp nháy
    lum: number // độ sáng cơ bản (đơn sắc, hơi ngả xanh lạnh)
}

interface Meteor {
    x: number
    y: number
    vx: number
    vy: number
    len: number
    w: number
    t: number // thời gian sống
    dur: number // tổng thời gian
    a: number
}

export function Starfield() {
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

        const stars: Star[] = []
        const meteors: Meteor[] = []

        const rand = (a: number, b: number) => a + Math.random() * (b - a)

        const makeStar = (): Star => {
            const z = Math.random()
            return {
                x: Math.random() * w,
                y: Math.random() * h,
                z,
                r: z < 0.82 ? rand(0.5, 0.95) : rand(1.0, 1.7),
                a: rand(0.18, 0.85),
                tw: Math.random() * Math.PI * 2,
                lum: 198 + Math.round(Math.random() * 57),
            }
        }

        const build = () => {
            stars.length = 0
            const density = isSmall ? 15000 : 9000
            const target = Math.min(Math.round((w * h) / density), isSmall ? 140 : 320)
            for (let i = 0; i < target; i++) stars.push(makeStar())
        }

        const spawnMeteor = () => {
            const fromLeft = Math.random() < 0.5
            const speed = rand(0.55, 1.05)
            const ang = rand(0.38, 0.62) // hướng chéo xuống
            const dir = fromLeft ? 1 : -1
            meteors.push({
                x: fromLeft ? rand(-0.1, 0.55) * w : rand(0.45, 1.1) * w,
                y: rand(-0.15, 0.35) * h,
                vx: Math.cos(ang) * speed * 1.35 * dir,
                vy: Math.sin(ang) * speed * 1.35,
                len: rand(90, 240) * (isSmall ? 0.7 : 1),
                w: rand(1, 2.2),
                t: 0,
                dur: rand(0.7, 1.5),
                a: rand(0.45, 0.95),
            })
        }

        const resize = () => {
            w = canvas.clientWidth
            h = canvas.clientHeight
            dpr = Math.min(window.devicePixelRatio || 1, maxDpr)
            canvas.width = Math.max(1, Math.floor(w * dpr))
            canvas.height = Math.max(1, Math.floor(h * dpr))
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
            build()
        }
        resize()
        window.addEventListener('resize', resize)

        const running = { on: true }
        let raf = 0
        let last = performance.now()
        const start = last
        let nextMeteor = rand(0.6, 2.4)

        const draw = (now: number) => {
            raf = requestAnimationFrame(draw)
            if (!running.on) return

            const dt = Math.min(0.05, (now - last) / 1000)
            last = now

            const px = 0
            const py = 0

            ctx.clearRect(0, 0, w, h)

            const t = (now - start) / 1000

            // --- Trường sao ---
            for (const s of stars) {
                const sx = s.x + px * s.z
                const sy = s.y + py * s.z
                if (sx < -4 || sx > w + 4 || sy < -4 || sy > h + 4) continue

                const tw = reduced ? 0.85 : 0.55 + 0.45 * Math.sin(t * 0.9 + s.tw)
                const lum = Math.min(255, s.lum + Math.round(s.z * 30))
                ctx.globalAlpha = s.a * tw
                ctx.fillStyle = `rgb(${lum},${lum},${Math.min(255, lum + 10)})`

                if (s.r < 1.1) {
                    // Sao nhỏ: hình chữ nhật 1–2px rẻ hơn arc rất nhiều
                    ctx.fillRect(sx, sy, s.r * 2, s.r * 2)
                } else {
                    ctx.beginPath()
                    ctx.arc(sx, sy, s.r, 0, Math.PI * 2)
                    ctx.fill()
                }
            }
            ctx.globalAlpha = 1

            // --- Sao băng ---
            if (!reduced) {
                nextMeteor -= dt
                if (nextMeteor <= 0 && meteors.length < 3) {
                    spawnMeteor()
                    nextMeteor = rand(1.4, 5.2)
                }
            }

            for (let i = meteors.length - 1; i >= 0; i--) {
                const m = meteors[i]
                m.t += dt
                m.x += m.vx * dt * 420
                m.y += m.vy * dt * 420

                const p = m.t / m.dur
                if (p >= 1 || m.x < -420 || m.x > w + 420 || m.y > h + 420) {
                    meteors.splice(i, 1)
                    continue
                }

                const fade = Math.sin(Math.min(1, p) * Math.PI) // mờ ở cả hai đầu
                const sp = Math.hypot(m.vx, m.vy) || 1
                const tx = m.x - (m.vx / sp) * m.len
                const ty = m.y - (m.vy / sp) * m.len

                const g = ctx.createLinearGradient(m.x, m.y, tx, ty)
                g.addColorStop(0, `rgba(255,255,255,${0.95 * fade * m.a})`)
                g.addColorStop(0.35, `rgba(214,226,255,${0.45 * fade * m.a})`)
                g.addColorStop(1, 'rgba(255,255,255,0)')

                ctx.strokeStyle = g
                ctx.lineWidth = m.w
                ctx.lineCap = 'round'
                ctx.beginPath()
                ctx.moveTo(m.x, m.y)
                ctx.lineTo(tx, ty)
                ctx.stroke()

                // Đầu sao băng sáng
                ctx.beginPath()
                ctx.arc(m.x, m.y, m.w * 0.9, 0, Math.PI * 2)
                ctx.fillStyle = `rgba(255,255,255,${fade * m.a})`
                ctx.fill()
            }
        }
        raf = requestAnimationFrame(draw)

        const onVisibility = () => {
            running.on = !document.hidden
            last = performance.now()
        }
        document.addEventListener('visibilitychange', onVisibility)

        return () => {
            cancelAnimationFrame(raf)
            window.removeEventListener('resize', resize)
            document.removeEventListener('visibilitychange', onVisibility)
            mq.removeEventListener?.('change', onMq)
        }
    }, [])

    return <canvas ref={canvasRef} aria-hidden="true" className="star-layer h-full w-full" />
}
