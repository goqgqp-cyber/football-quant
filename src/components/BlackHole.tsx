import { useEffect, useRef } from 'react'

/* ==========================================================================
   HỐ ĐEN — dựng theo ảnh tham chiếu Gargantua (Interstellar)
   --------------------------------------------------------------------------
   Khác biệt so với bản cũ: dùng TÍCH PHÂN TRẮC ĐỊA đúng cho tia sáng
   (null geodesic) trong không-thời gian Schwarzschild thay vì "uốn nhẹ":

       a = -1.5 * h² * r_vec / |r|^5      (h² = |r × v|², bảo toàn)

   Nhờ đó ánh sáng từ MẶT XA của đĩa bồi tụ bị bẻ cong vòng LÊN TRÊN và
   XUỐNG DƯỚI hố đen, tạo "vòm" đặc trưng + VÒNG PHOTON mảnh rực sáng ôm
   sát bóng đen. Đĩa nhìn gần như cạnh (edge-on), kéo dài hết khung, quay
   Kepler LIÊN TỤC (omega ~ r^-1.5) nên không bao giờ đứng yên.

   Đơn sắc tuyệt đối: mọi ánh sáng đều là thang xám lạnh (bạch kim).
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

// --- hằng số hình học (RS = 1 cho gọn đơn vị) ---
const float RS       = 1.60;   // bán kính chân trời sự kiện
const float DISK_IN  = 3.20;   // mặt trong đĩa (ISCO)
const float DISK_OUT = 11.00;  // mặt ngoài đĩa

// ---------- nhiễu ----------
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
    for (int i = 0; i < 6; i++) {
        s += a * noise2(p);
        p = p * 2.03 + vec2(17.3, 9.1);
        a *= 0.5;
    }
    return s;
}

// ---------- nền sao ----------
vec3 starField(vec3 rd) {
    vec3 p  = rd * 160.0;
    vec3 id = floor(p);
    vec3 f  = fract(p) - 0.5;

    float n  = hash31(id);
    float sp = step(0.9945, n);
    float b  = 0.30 + 0.70 * hash31(id + 11.3);
    float d  = length(f);
    float pt = smoothstep(0.34, 0.0, d) * sp;

    // Sương ngân hà cực mờ, đơn sắc
    float neb = fbm(vec2(atan(rd.z, rd.x) * 1.6, rd.y * 2.4));
    neb = smoothstep(0.45, 1.0, neb) * 0.030;

    vec3 col = vec3(0.96, 0.975, 1.0) * pt * b;
    col += vec3(0.85, 0.88, 0.95) * neb;
    return col;
}

// ---------- hồ sơ bán kính đĩa ----------
float diskProfile(float r) {
    if (r < DISK_IN || r > DISK_OUT) return 0.0;
    float t = (r - DISK_IN) / (DISK_OUT - DISK_IN);
    float inner = smoothstep(0.0, 0.035, t);     // bờ trong sắc như dao (ISCO)
    float outer = smoothstep(1.0, 0.55, t);      // mờ dần ra rìa ngoài
    float bright = pow(1.0 - t, 1.35);           // sáng nhất ở vành trong
    return inner * outer * (0.30 + bright);
}

// ---------- mật độ vân đĩa (quay Kepler liên tục) ----------
float diskNoise(float r, float phi, float t) {
    float omega = 1.55 / pow(r, 1.5);            // omega ~ r^-1.5
    float a = phi - omega * t;                   // kéo vân theo góc quay
    float n1 = fbm(vec2(a * 2.1 + r * 1.0, r * 1.7 - t * 0.07));
    float n2 = fbm(vec2(a * 6.2 - r * 1.8, r * 4.6 - t * 0.20));
    float n3 = fbm(vec2(a * 14.0 + r * 4.4, r * 10.0 - t * 0.45));
    return 0.50 + 0.95 * n1 + 0.42 * n2 + 0.24 * n3;
}

// ---------- Doppler beaming ----------
float doppler(vec3 pc, vec3 dir) {
    float r = length(pc.xz);
    float beta = clamp(0.62 / sqrt(max(r, 1.0)), 0.0, 0.62);
    vec3  vhat = normalize(vec3(-pc.z, 0.0, pc.x));   // vận tốc tiếp tuyến
    float mu   = dot(vhat, -normalize(dir));
    float del  = clamp(1.0 - beta * mu, 0.30, 1.70);
    return pow(del, -2.4);                            // bên tiến về phía ta sáng hơn
}

void main() {
    // ---- Tọa độ pixel, khớp aspect ----
    vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;

    // ---- Méo không gian cục bộ quanh con trỏ (thấu kính) ----
    vec2 pw = uPointer * vec2(uRes.x / uRes.y, 1.0) * 0.5;
    vec2 toP = uv - pw;
    float pd = length(toP);
    float lens = uLensAmt * 0.10 * exp(-pd * pd * 9.0);
    uv -= normalize(toP + 1e-6) * lens;

    // ---- Máy quay nằm gần mặt phẳng đĩa (edge-on), nghiêng nhẹ ----
    vec3 ro = vec3(0.0, 1.15, 9.0);
    vec3 rd = normalize(vec3(uv.x, uv.y + 0.050, -2.20));

    // ---- Nghiêng theo con trỏ (pitch + yaw nhẹ) ----
    float tiltX = uPointer.y * 0.22;
    float tiltY = uPointer.x * 0.18;
    float cx = cos(tiltX), sx = sin(tiltX);
    rd = vec3(rd.x, rd.y * cx - rd.z * sx, rd.y * sx + rd.z * cx);
    ro = vec3(ro.x, ro.y * cx - ro.z * sx, ro.y * sx + ro.z * cx);
    float cy = cos(tiltY), sy = sin(tiltY);
    rd = vec3(rd.x * cy + rd.z * sy, rd.y, -rd.x * sy + rd.z * cy);
    ro = vec3(ro.x * cy + ro.z * sy, ro.y, -ro.x * sy + ro.z * cy);

    // ---- Tích phân trắc địa (null geodesic, Schwarzschild) ----
    vec3 p = ro;
    vec3 v = rd;
    vec3 hv = cross(p, v);
    float h2 = dot(hv, hv);          // hằng số bảo toàn của tia

    vec3  col = vec3(0.0);
    float trans = 1.0;               // độ truyền qua đĩa
    float ringGlow = 0.0;            // quầng photon
    bool  captured = false;          // rơi vào chân trời sự kiện

    float dt = 0.055;

    for (int i = 0; i < ${steps}; i++) {
        vec3 pPrev = p;

        // Gia tốc trắc địa: a = -1.5 h² r / |r|^5
        float r2 = dot(p, p);
        vec3 a = -1.5 * h2 * p / (r2 * r2 * sqrt(r2));

        v += a * dt;
        p += v * dt;

        float r = length(p);

        // Rơi vào chân trời -> bóng tối tuyệt đối
        if (r < RS) { captured = true; break; }
        if (r > 90.0) break;

        // --- Vòng photon: tia quay quanh r ~ 1.5 RS càng lâu càng sáng ---
        float pr = (r - 1.5 * RS) / (0.16 * RS);
        ringGlow += exp(-pr * pr) * dt * 0.85 * trans;

        // --- Giao với mặt phẳng đĩa (y = 0) ---
        if (pPrev.y * p.y < 0.0) {
            float f = pPrev.y / (pPrev.y - p.y);
            vec3  pc = mix(pPrev, p, f);
            float rr = length(pc.xz);
            float prof = diskProfile(rr);

            if (prof > 0.001) {
                float phi = atan(pc.z, pc.x);
                float dens = prof * diskNoise(rr, phi, uTime);
                float dop  = doppler(pc, v);
                float shift = 1.0 / sqrt(max(1.0 - RS / rr, 0.10));  // dịch đỏ hấp dẫn
                float emis = dens * dop * shift;

                col += vec3(1.0, 1.0, 1.0) * emis * trans * 0.115;
                trans *= exp(-dens * 0.85);
            }
        }

        // Bước tiến thích ứng: xa thì bước lớn, gần thì mịn
        dt = clamp(dt * 1.012, 0.045, 0.22);
    }

    // Quầng photon (bạch kim lạnh)
    col += vec3(0.92, 0.95, 1.0) * ringGlow * 0.16;

    // Nền sao phía sau (bị méo bởi hố đen, tắt nếu bị nuốt)
    col += starField(normalize(v)) * (captured ? 0.0 : 1.0);

    // Bloom mềm cho vùng sáng rực
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col += col * smoothstep(0.40, 2.0, lum) * 0.60;

    // Vignette giữ tương phản cực đại
    vec2 vv = gl_FragCoord.xy / uRes;
    float vig = smoothstep(1.20, 0.28, length(vv - 0.5) * 1.55);
    col *= mix(0.32, 1.0, vig);

    // Dither loại bỏ banding trên nền tối
    float dither = (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
    fragColor = vec4(pow(max(col, 0.0), vec3(0.94)) + dither, 1.0);
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
        const steps = isSmall ? 150 : 240

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
            gl.uniform1f(uTime, reduced ? 12.0 : (now - start) / 1000)
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
