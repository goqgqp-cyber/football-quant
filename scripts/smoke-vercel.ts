/**
 * Smoke test cho adapter Vercel NODE (server/vercel.ts).
 * --------------------------------------------------------------------------
 * Dựng một HTTP server thật rồi trỏ vào handler của function, sau đó gọi
 * các endpoint auth quan trọng. Mục đích: bắt lỗi kiểu
 * `this.raw.headers.get is not a function` và kiểm tra cookie/SSE.
 *
 * Chạy:  npx tsx scripts/smoke-vercel.ts
 */
import { createServer } from 'node:http'
import handler from '../server/vercel.js'

async function main() {
    const server = createServer((req, res) => {
        void handler(req, res)
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const base = `http://127.0.0.1:${port}`

    const call = async (label: string, path: string, init?: RequestInit) => {
        try {
            const res = await fetch(`${base}${path}`, init)
            const text = await res.text()
            const setCookie = res.headers.get('set-cookie')
            console.log(
                `${label} -> ${res.status} ${text.slice(0, 160)}` +
                (setCookie ? `  [cookie: ${setCookie.slice(0, 60)}…]` : ''),
            )
            return { status: res.status, text, setCookie }
        } catch (e) {
            console.log(`${label} -> LỖI ${e instanceof Error ? e.message : String(e)}`)
            return { status: 0, text: '', setCookie: null }
        }
    }

    try {
        await call('health', '/api/health')
        await call('health?deep=1', '/api/health?deep=1')
        await call('api-root', '/api')
        await call('csrf', '/api/auth/csrf')
        await call('me (chưa đăng nhập)', '/api/me')
        await call('login (sai mật khẩu)', '/api/auth/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'nobody@example.com', password: 'sai-mat-khau' }),
        })
        await call('signup (/api/auth/signup)', '/api/auth/signup', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'new@example.com', password: 'matkhau123' }),
        })
        await call('register (/api/auth/register)', '/api/auth/register', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'new2@example.com', password: 'matkhau123' }),
        })
        await call('signup đường dẫn tước /api (/auth/signup)', '/auth/signup', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'new3@example.com', password: 'matkhau123' }),
        })
        await call('register đường dẫn tước /api (/auth/register)', '/auth/register', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'new4@example.com', password: 'matkhau123' }),
        })

        // Test admin login & admin endpoints
        const adminLogin = await call('login admin (bằng email)', '/api/auth/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'admin@footballquant.local', password: 'vodanh.280987' }),
        })
        await call('login admin (bằng username)', '/api/auth/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'admin', password: 'vodanh.280987' }),
        })

        if (adminLogin.setCookie) {
            await call('admin overview', '/api/admin/overview', {
                headers: { cookie: adminLogin.setCookie },
            })
            await call('admin users list', '/api/admin/users', {
                headers: { cookie: adminLogin.setCookie },
            })
        }

        await call('route không tồn tại', '/api/khong-ton-tai')
    } finally {
        server.close()
    }
}

main().catch((e) => {
    console.error('smoke-vercel thất bại:', e)
    process.exit(1)
})
