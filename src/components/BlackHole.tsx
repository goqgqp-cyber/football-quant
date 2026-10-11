import { useEffect, useRef } from 'react'

/* ==========================================================================
   HỐ ĐEN — GLSL gravitational lensing (phong cách Gargantua / Interstellar)
   --------------------------------------------------------------------------
   Kỹ thuật: raymarch trong không gian, mỗi bước lệch vector hướng về tâm
   (mô phỏng uốn ánh sáng), xen kẽ bắt giao điểm với mặt phẳng đĩa để vẽ
   "cầu vồng" đĩa hấp dẫn phía trên (lensing) — hiệu ứng đặc trưng của
   hố đen quay. Doppler beaming: một bên đĩa tiến về phía người xem sáng
   hơn, một bên lui xa tối hơn.
   Đơn sắc tuyệt đối: mọi màu đều là thang xám lạnh (bạch kim).
   ========================================================================== */

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
    vUv = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
}`

/** `steps` được nội suy lúc biên dịch để cân bằng giữa chất lượng và FPS. */
const frag = (steps: number) => `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2  uRes;
uniform float uTime;
uniform vec2  uPointer;   // -1..1, chuẩn hoá
uniform float uLensAmt;   // 0..1 cường độ méo quanh con trỏ

// --- hằng số vật lý (đơn vị quang học) ---
const float RS       = 0.62;   // bán kính chân trời sự kiện (event horizon)
const float DISK_IN  = 0.95;   // mặt trong đĩa hấp dẫn (ISCO)
const float DISK_OUT = 3.40;   // mặt ngoài
const float BEND     = 0.62;   // hằng số uốn quang học
const float C_LIGHT  = 1.30;   // hằng số Doppler

// ---------- tiện ích ----------
float hash31(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
    float s = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
        s += a * noise2(p);
        p *= 2.03;
        a *= 0.5;
    }
    return s;
}

// ---------- nền sao (cũng bị uốn theo hố đen) ----------
vec3 starField(vec3 rd) {
    vec3 p  = rd * 140.0;
    vec3 id = floor(p);
    vec3 f  = fract(p) - 0.5;

    float n  = hash31(id);
    float sp = step(0.9955, n);
    float b  = 0.35 + 0.65 * hash31(id + 11.3);
    float d  = length(f);
    float pt = smoothstep(0.30, 0.0, d) * sp;

    // Sương ngân hà cực mờ, đơn sắc
    float neb = fbm(vec2(atan(rd.z, rd.x) * 1.7, rd.y * 2.6));
    neb = smoothstep(0.42, 1.0, neb) * 0.028;

    vec3 col = vec3(0.96, 0.975, 1.0) * pt * b;
    col += vec3(0.85, 0.88, 0.95) * neb;
    return col;
}

// ---------- mật độ đĩa hấp dẫn ----------
// r  : bán kính trong mặt phẳng đĩa
// th : góc cực
float diskDensity(float r, float th, float t) {
    if (r < DISK_IN || r > DISK_OUT) return 0.0;
    float rn = (r - DISK_IN) / (DISK_OUT - DISK_IN);

    // Hồ sơ bán kính: dày trong, mỏng dần ra ngoài
    float radial = pow(1.0 - rn, 1.7) * smoothstep(0.0, 0.14, rn);
    radial *= smoothstep(1.0, 0.82, rn);          // cắt mềm rìa ngoài

    // Tốc độ quay Kepler: omega ~ r^-1.5
    float omega = 1.05 / pow(r, 1.5);
    float ang   = th - omega * t * 2.4;

    // Dải xoáy ốc + nhiễu turbulence (chuyển động liên tục, không seam)
    float bands  = fbm(vec2(ang * 2.1 + rn * 7.0, rn * 3.2 - t * 0.12));
    float spiral = 0.42 + 0.78 * bands;
    float fine   = 0.80 + 0.36 * fbm(vec2(ang * 8.5, rn * 15.0 - t * 0.38));

    return radial * spiral * fine;
}

// ---------- Doppler beaming ----------
// Ánh sáng bị tăng cường khi vật chất chuyển về phía người xem (và giảm khi đi xa).
float doppler(vec3 p, vec3 dir) {
    float r = length(p.xz);
    float v = 0.42 / sqrt(max(r, 0.4));                 // |v| tương đối
    vec3  vhat = normalize(vec3(-p.z, 0.0, p.x));        // hướng tốc độ tiếp tuyến
    float beta = clamp(v / C_LIGHT, 0.0, 0.72);
    float mu   = dot(vhat, -dir);                        // cos góc giữa v và hướng nhìn
    float del  = clamp(1.0 - beta * mu, 0.22, 2.0);
    return pow(del, -3.2);                               // cường độ ~ delta^-3..4
}

void main() {
    // ---- Tọa độ pixel, khớp aspect ----
    vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;

    // ---- Máy quay nhìn chếch xuống đĩa ----
    vec3 ro = vec3(0.0, 0.42, -3.30);
    vec3 rd = normalize(vec3(uv.x, uv.y, 1.35));

    // ---- Nghiêng mặt phẳng đĩa theo con trỏ ----
    float tiltX = uPointer.y * 0.26;
    float tiltY = uPointer.x * 0.20;
    float cx = cos(tiltX), sx = sin(tiltX);
    rd = vec3(rd.x, rd.y * cx - rd.z * sx, rd.y * sx + rd.z * cx);
    ro = vec3(ro.x, ro.y * cx - ro.z * sx, ro.y * sx + ro.z * cx);
    float cy = cos(tiltY), sy = sin(tiltY);
    rd = vec3(rd.x * cy + rd.z * sy, rd.y, -rd.x * sy + rd.z * cy);
    ro = vec3(ro.x * cy + ro.z * sy, ro.y, -ro.x * sy + ro.z * cy);

    // ---- Méo không gian cục bộ quanh con trỏ ----
    vec2 pw = uPointer * vec2(uRes.x / uRes.y, 1.0) * 0.5;
    vec2 toP = uv - pw;
    float pd = length(toP);
    float lens = uLensAmt * 0.09 * exp(-pd * pd * 9.0);
    uv -= normalize(toP + 1e-6) * lens;

    vec3 col = vec3(0.0);
    float trans = 1.0;      // truyền qua đĩa
    float diskGlow = 0.0;   // quầng quang học quanh chân trời sự kiện

    vec3  p = ro;
    vec3  dir = rd;
    vec3  pPrev = p;
    float t = 0.0;
    float dt = 0.035;
    bool  insideHorizon = false;

    for (int i = 0; i < ${steps}; i++) {
        pPrev = p;
        p += dir * dt;
        t += dt;

        float r = length(p);

        // Rơi vào chân trời sự kiện -> bóng tối tuyệt đối
        if (r < RS) { insideHorizon = true; break; }
        if (r > 42.0) break;

        // --- Uốn quang học: hướng tia bị lệch về tâm theo ~ 1/r^2 ---
        vec3 g = p / max(r, 1e-3);
        dir = normalize(dir - g * (BEND * dt / (r * r)));

        // --- Quầng photon: hào quang sáng ngay ngoài chân trời ---
        float ring = smoothstep(RS * 1.02, RS * 1.06, r) * smoothstep(RS * 2.10, RS * 1.30, r);
        diskGlow += ring * dt * 2.2 * trans;

        // --- Giao với mặt phẳng đĩa (y = 0) ---
        if (p.y * pPrev.y < 0.0) {
            float f = pPrev.y / (pPrev.y - p.y);
            vec3  pc = mix(pPrev, p, f);
            float rd2 = length(pc.xz);

            float th = atan(pc.z, pc.x);
            float dens = diskDensity(rd2, th, uTime);

            if (dens > 0.001) {
                float dop = doppler(pc, dir);
                // Ánh sáng bị hấp thụ + xung quang học gần chân trời
                float shift = 1.0 / sqrt(max(1.0 - 2.0 * RS / rd2, 0.15));
                float emis = dens * dop * shift;

                // Màu đơn sắc, hơi lệch sang bạch kim lạnh
                vec3 emitCol = vec3(1.0, 1.0, 1.0) * emis;
                col += emitCol * trans * 0.135;
                trans *= exp(-dens * 0.55);
            }
        }

        dt = clamp(dt * 1.022, 0.030, 0.16);
    }

    // Nền sao phía sau (bị méo bởi hố đen)
    vec3 bg = starField(dir) * (insideHorizon ? 0.0 : 1.0);

    // Quầng quang học viền chân trời (bạch kim)
    col += vec3(0.92, 0.95, 1.0) * diskGlow * 0.10;

    // Ánh sáng toàn cảnh rò ra từ đĩa
    col += bg;

    // Bloom mềm: toàn bộ ánh sáng được nhấp nháy mờ
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col += col * smoothstep(0.35, 1.6, lum) * 0.55;

    // Vignette + gamma nhẹ để giữ tương phản cực đại
    vec2 vv = gl_FragCoord.xy / uRes;
    float vig = smoothstep(1.15, 0.25, length(vv - 0.5) * 1.55);
    col *= mix(0.35, 1.0, vig);

    // Dither để loại bỏ banding trên nền tối
    float dither = (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
    fragColor = vec4(pow(max(col, 0.0), vec3(0.92)) + dither, 1.0);
}`

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
    const sh = gl.createShader(type)
    if (!sh) throw new Error('Không tạo được shader')
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh)
        gl.deleteShader(sh)
        throw new Error(`Lỗi biên dịch shader: ${log ?? 'không rõ'}`)
    }
    return sh
}

/**
 * Nền hố đen toàn màn hình.
 * - DPR kẹp ở 2 (1.5 trên mobile) để kiểm soát chi phí fill-rate.
 * - Số bước raymarch giảm trên màn hình nhỏ / thiết bị yếu.
 * - Tạm dừng khi tab ẩn; tôn trọng prefers-reduced-motion (đóng băng động).
 * - Giải phóng toàn bộ tài nguyên GPU khi unmount.
 */
export function BlackHole() {
    const canvasRef = useRef<HTMLCanvasElement | null>(null)

    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return

        const gl = canvas.getContext('webgl2', {
            alpha: false,
            antialias: false,
            depth: false,
            stencil: false,
            powerPreference: 'high-performance',
        })
        // Không có WebGL2 -> bỏ nền hố đen, UI vẫn dùng được nhờ fallback nền đen
        if (!gl) return

        let program: WebGLProgram | null = null
        let buf: WebGLBuffer | null = null

        const isSmall = window.matchMedia('(max-width: 768px)').matches
        const steps = isSmall ? 90 : 150

        try {
            const vs = compile(gl, gl.VERTEX_SHADER, VERT)
            const fs = compile(gl, gl.FRAGMENT_SHADER, frag(steps))
            program = gl.createProgram()
            if (!program) return
            gl.attachShader(program, vs)
            gl.attachShader(program, fs)
            gl.linkProgram(program)
            gl.deleteShader(vs)
            gl.deleteShader(fs)
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                throw new Error(`Lỗi link chương trình: ${gl.getProgramInfoLog(program) ?? ''}`)
            }
        } catch (err) {
            console.warn('[blackhole]', err)
            gl.getExtension('WEBGL_lose_context')?.loseContext()
            return
        }

        // Toàn màn hình từ 1 tam giác (ít vertex hơn quad)
        buf = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, buf)
        gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array([-1, -1, 3, -1, -1, 3]),
            gl.STATIC_DRAW,
        )
        gl.useProgram(program)
        const loc = gl.getAttribLocation(program, 'aPos')
        gl.enableVertexAttribArray(loc)
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

        const uRes = gl.getUniformLocation(program, 'uRes')
        const uTime = gl.getUniformLocation(program, 'uTime')
        const uPointer = gl.getUniformLocation(program, 'uPointer')
        const uLensAmt = gl.getUniformLocation(program, 'uLensAmt')

        const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
        let reduced = mq.matches
        const onMq = () => {
            reduced = mq.matches
        }
        mq.addEventListener?.('change', onMq)

        // DPR kẹp: tránh render ở 3x trên điện thoại
        const maxDpr = isSmall ? 1.5 : 2
        let dpr = Math.min(window.devicePixelRatio || 1, maxDpr)
        let w = 0
        let h = 0

        const resize = () => {
            w = canvas.clientWidth
            h = canvas.clientHeight
            dpr = Math.min(window.devicePixelRatio || 1, maxDpr)
            canvas.width = Math.max(1, Math.floor(w * dpr))
            canvas.height = Math.max(1, Math.floor(h * dpr))
            gl.viewport(0, 0, canvas.width, canvas.height)
        }
        resize()
        window.addEventListener('resize', resize)

        // Con trỏ đã nội suy (lerp) để phản ứng mềm mại
        const ptr = { x: 0, y: 0, tx: 0, ty: 0, lens: 0, tlens: 0 }
        const onPointer = (e: PointerEvent) => {
            ptr.tx = (e.clientX / window.innerWidth) * 2 - 1
            ptr.ty = -((e.clientY / window.innerHeight) * 2 - 1)
            ptr.tlens = 1
        }
        window.addEventListener('pointermove', onPointer, { passive: true })

        // Thiết bị yếu: nới bước raymarch xuống để giữ 60fps
        let quality = 1
        let frames = 0
        let acc = 0
        let lastT = performance.now()

        let raf = 0
        const start = performance.now()
        const running = { on: true }

        const draw = (now: number) => {
            raf = requestAnimationFrame(draw)
            if (!running.on) return

            // Theo dõi FPS và hạ chất lượng nếu tụt dưới ~50fps
            const dtMs = now - lastT
            lastT = now
            acc += dtMs
            frames++
            if (acc > 1000) {
                const fps = (frames * 1000) / acc
                if (fps < 45) quality = Math.max(0.45, quality - 0.12)
                else if (fps > 58) quality = Math.min(1, quality + 0.06)
                frames = 0
                acc = 0
            }

            ptr.x += (ptr.tx - ptr.x) * 0.055
            ptr.y += (ptr.ty - ptr.y) * 0.055
            ptr.lens += (ptr.tlens - ptr.lens) * 0.05

            gl.useProgram(program)
            gl.uniform2f(uRes, canvas.width, canvas.height)
            gl.uniform1f(uTime, reduced ? 6.0 : (now - start) / 1000)
            gl.uniform2f(uPointer, ptr.x, ptr.y)
            gl.uniform1f(uLensAmt, reduced ? 0 : ptr.lens * quality)

            // Khi giảm chất lượng: render ở buffer nhỏ rồi để GPU phóng lên
            const rw = Math.max(1, Math.floor(canvas.width * quality))
            const rh = Math.max(1, Math.floor(canvas.height * quality))
            gl.viewport(0, 0, rw, rh)
            gl.uniform2f(uRes, rw, rh)

            gl.drawArrays(gl.TRIANGLES, 0, 3)
        }
        raf = requestAnimationFrame(draw)

        const onVisibility = () => {
            running.on = !document.hidden
            lastT = performance.now()
        }
        document.addEventListener('visibilitychange', onVisibility)

        return () => {
            cancelAnimationFrame(raf)
            window.removeEventListener('resize', resize)
            window.removeEventListener('pointermove', onPointer)
            document.removeEventListener('visibilitychange', onVisibility)
            mq.removeEventListener?.('change', onMq)
            if (buf) gl.deleteBuffer(buf)
            if (program) gl.deleteProgram(program)
            gl.getExtension('WEBGL_lose_context')?.loseContext()
        }
    }, [])

    return (
        <div className="bh-root" aria-hidden="true">
            <canvas ref={canvasRef} className="bh-canvas" />
            <div className="bh-vignette" />
        </div>
    )
}