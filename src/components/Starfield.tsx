import { useEffect, useRef } from 'react'

interface Star {
    x: number
    y: number
    z: number // depth 0..1 (nhỏ = xa)
    r: number
    tw: number // pha nhấp nháy
}

interface Meteor {
    x: number
    y: number
    vx: number
    vy: number
    life: number
    max: number
}

/**
 * Nền vũ trụ: trường sao canvas 2D + parallax nhẹ theo chuột/nghiêng thiết bị
 * + thỉnh thoảng sao băng. Tôn trọng prefers-reduced-motion (chỉ nền tĩnh).
 * Tạm dừng khi tab ẩn. Giảm mật độ hạt trên mobile/thiết bị yếu.
 */
export function Starfield() {
    const canvasRef = useRef<HTMLCanvasElement | null>(null)
    const rafRef = useRef<number | null>(null)
    const starsRef = useRef<Star[]>([])
    const meteorsRef = useRef<Meteor[]>([])
    const pointerRef = useRef({ x: 0.5, y: 0.5 })
    const offsetRef = useRef({ x: 0, y: 0 })
    const runningRef = useRef(true)
    const reducedRef = useRef(false)

    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d', { alpha: true })
        if (!ctx) return

        const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
        reducedRef.current = mq.matches
        const onMq = () => {
            reducedRef.current = mq.matches
        }
        mq.addEventListener?.('change', onMq)

        const isSmall = window.innerWidth < 768
        const dpr = Math.min(window.devicePixelRatio || 1, isSmall ? 1.5 : 2)

        let w = 0
        let h = 0

        const buildStars = () => {
            const area = w * h
            // Mật độ thấp hơn trên mobile
            const base = isSmall ? 9000 : 6000
            const count = Math.min(Math.round(area / base), isSmall ? 140 : 340)
            const stars: Star[] = []
            for (let i = 0; i < count; i++) {
                const z = Math.random()
                stars.push({
                    x: Math.random() * w,
                    y: Math.random() * h,
                    z,
                    r: 0.4 + z * 1.5,
                    tw: Math.random() * Math.PI * 2,
                })
            }
            starsRef.current = stars
        }

        const resize = () => {
            w = canvas.clientWidth
            h = canvas.clientHeight
            canvas.width = Math.floor(w * dpr)
            canvas.height = Math.floor(h * dpr)
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
            buildStars()
        }

        resize()
        window.addEventListener('resize', resize)

        const onPointer = (e: PointerEvent) => {
            pointerRef.current.x = e.clientX / window.innerWidth
            pointerRef.current.y = e.clientY / window.innerHeight
        }
        window.addEventListener('pointermove', onPointer, { passive: true })

        const onOrient = (e: DeviceOrientationEvent) => {
            const g = e.gamma ?? 0 // -90..90 trái/phải
            const b = e.beta ?? 0 // -180..180 trước/sau
            pointerRef.current.x = 0.5 + Math.max(-0.5, Math.min(0.5, g / 90))
            pointerRef.current.y = 0.5 + Math.max(-0.5, Math.min(0.5, (b - 45) / 90))
        }
        window.addEventListener('deviceorientation', onOrient, { passive: true })

        let lastMeteor = performance.now()

        const spawnMeteor = () => {
            const startX = Math.random() * w * 0.9
            const speed = 0.55 + Math.random() * 0.5
            meteorsRef.current.push({
                x: startX,
                y: -40,
                vx: 3.2 * speed,
                vy: 2.1 * speed,
                life: 0,
                max: 900 + Math.random() * 500,
            })
        }

        const draw = (now: number) => {
            if (!runningRef.current) {
                rafRef.current = requestAnimationFrame(draw)
                return
            }
            const reduced = reducedRef.current

            // Lerp offset để parallax mượt
            const targetX = (pointerRef.current.x - 0.5) * (reduced ? 0 : 26)
            const targetY = (pointerRef.current.y - 0.5) * (reduced ? 0 : 18)
            offsetRef.current.x += (targetX - offsetRef.current.x) * 0.06
            offsetRef.current.y += (targetY - offsetRef.current.y) * 0.06

            ctx.clearRect(0, 0, w, h)

            // Tinh vân mờ
            const g1 = ctx.createRadialGradient(w * 0.2, h * 0.15, 0, w * 0.2, h * 0.15, Math.max(w, h) * 0.6)
            g1.addColorStop(0, 'rgba(124,58,237,0.16)')
            g1.addColorStop(1, 'rgba(124,58,237,0)')
            ctx.fillStyle = g1
            ctx.fillRect(0, 0, w, h)

            const g2 = ctx.createRadialGradient(w * 0.85, h * 0.1, 0, w * 0.85, h * 0.1, Math.max(w, h) * 0.5)
            g2.addColorStop(0, 'rgba(217,70,239,0.10)')
            g2.addColorStop(1, 'rgba(217,70,239,0)')
            ctx.fillStyle = g2
            ctx.fillRect(0, 0, w, h)

            // Sao
            const t = now / 1000
            for (const s of starsRef.current) {
                const px = s.x + offsetRef.current.x * s.z
                const py = s.y + offsetRef.current.y * s.z
                const alpha = reduced ? 0.7 : 0.45 + 0.45 * Math.sin(t * 1.4 + s.tw)
                const color = s.z > 0.66 ? `rgba(214,200,255,${alpha})` : `rgba(255,255,255,${alpha})`
                ctx.beginPath()
                ctx.arc(px, py, s.r, 0, Math.PI * 2)
                ctx.fillStyle = color
                ctx.fill()
            }

            // Sao băng
            if (!reduced && now - lastMeteor > 5200 && Math.random() < 0.5) {
                lastMeteor = now
                spawnMeteor()
            }
            const alive: Meteor[] = []
            for (const m of meteorsRef.current) {
                m.x += m.vx
                m.y += m.vy
                m.life += 16
                const p = m.life / m.max
                if (p < 1 && m.y < h + 60 && m.x < w + 60) {
                    const grad = ctx.createLinearGradient(m.x, m.y, m.x - m.vx * 26, m.y - m.vy * 26)
                    grad.addColorStop(0, `rgba(255,255,255,${0.85 * (1 - p)})`)
                    grad.addColorStop(0.4, `rgba(217,70,239,${0.45 * (1 - p)})`)
                    grad.addColorStop(1, 'rgba(217,70,239,0)')
                    ctx.strokeStyle = grad
                    ctx.lineWidth = 2
                    ctx.beginPath()
                    ctx.moveTo(m.x, m.y)
                    ctx.lineTo(m.x - m.vx * 26, m.y - m.vy * 26)
                    ctx.stroke()
                    alive.push(m)
                }
            }
            meteorsRef.current = alive

            rafRef.current = requestAnimationFrame(draw)
        }

        rafRef.current = requestAnimationFrame(draw)

        const onVisibility = () => {
            runningRef.current = !document.hidden
        }
        document.addEventListener('visibilitychange', onVisibility)

        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current)
            window.removeEventListener('resize', resize)
            window.removeEventListener('pointermove', onPointer)
            window.removeEventListener('deviceorientation', onOrient)
            document.removeEventListener('visibilitychange', onVisibility)
            mq.removeEventListener?.('change', onMq)
        }
    }, [])

    return (
        <canvas
            ref={canvasRef}
            aria-hidden="true"
            className="pointer-events-none fixed inset-0 -z-10 h-full w-full"
        />
    )
}
