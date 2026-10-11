/**
 * Script kiểm chứng nhanh luồng auth bằng cách gọi trực tiếp app.fetch
 * (không cần mở cổng). Chạy: npx tsx scripts/smoke-auth.ts
 *
 * Script này dùng store in-memory nên mỗi lần chạy là một "database" mới.
 */
import '../server/dotenv.js'
import { app } from '../server/app.js'

function show(label: string, res: Response, body: string) {
    console.log(`${label} -> ${res.status} ${body.slice(0, 200)}`)
}

async function main() {
    // 1. health
    const health = await app.fetch(new Request('http://local/api/health'))
    show('health', health, await health.text())

    // 1b. health chẩn đoán sâu (kiểm tra Redis kèm thông báo lỗi thật)
    const deep = await app.fetch(new Request('http://local/api/health?deep=1'))
    show('health?deep=1', deep, await deep.text())

    // 1c. đích rewrite của Vercel
    const root = await app.fetch(new Request('http://local/api'))
    show('api-root', root, await root.text())

    // 2. csrf (cấp cookie double-submit)
    const csrfRes = await app.fetch(new Request('http://local/api/auth/csrf'))
    const csrfBody = (await csrfRes.json()) as { csrfToken: string }
    const csrfCookie = (csrfRes.headers.getSetCookie?.() ?? [])
        .map((c) => c.split(';')[0])
        .join('; ')
    show('csrf', csrfRes, `cookie=${csrfCookie || '(none)'}`)

    // 3. signup (có thể bị chặn nếu ALLOW_PUBLIC_SIGNUP=false)
    const signupBody = JSON.stringify({ email: 'smoke@test.local', password: 'Abc12345!' })
    const signupRes = await app.fetch(
        new Request('http://local/api/auth/signup', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Cookie: csrfCookie,
                'x-csrf-token': csrfBody.csrfToken,
            },
            body: signupBody,
        }),
    )
    const signupText = await signupRes.text()
    show('signup', signupRes, signupText)

    const cookies = (signupRes.headers.getSetCookie?.() ?? [])
        .map((c) => c.split(';')[0])
        .join('; ')

    // 4. login lại bằng account vừa tạo
    const loginRes = await app.fetch(
        new Request('http://local/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookies },
            body: JSON.stringify({ email: 'smoke@test.local', password: 'Abc12345!' }),
        }),
    )
    show('login', loginRes, await loginRes.text())
}

main().catch((e) => {
    console.error('SMOKE FAIL:', e)
    process.exit(1)
})