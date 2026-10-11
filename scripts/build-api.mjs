/**
 * Bundle entry function Vercel thành MỘT file JS self-contained.
 *
 * Vì sao cần: các file server import tương đối kiểu NodeNext
 * (`./app.js` → thực tế là `app.ts`). Vercel transpile `api/*.ts` nhưng
 * KHÔNG bundle các import tương đối, nên lúc runtime Node không tìm thấy
 * `server/app.js` → function crash ngay khi khởi tạo → client chỉ nhận
 * chuỗi "Lỗi 500" rỗng (body không phải JSON).
 *
 * esbuild bundle toàn bộ (hono, jose, bcryptjs, zod, @upstash/redis…)
 * vào MỘT file để function không còn phụ thuộc vào việc resolve module
 * lúc chạy.
 *
 * Tên file: `api/[...route].js` — catch-all của Vercel Functions, khớp MỌI
 * đường dẫn dưới `/api/*` và GIỮ NGUYÊN path gốc (vd `/api/auth/login`)
 * nên Hono định tuyến đúng. KHÔNG cần `rewrites` trong vercel.json, và
 * KHÔNG dùng `[[...route]]` (cú pháp Next.js, Vercel từ chối).
 *
 * File output được COMMIT (không gitignore) để Vercel luôn thấy handler.
 */
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const outfile = 'api/[...route].js'

await mkdir(dirname(outfile), { recursive: true })

await build({
    entryPoints: ['server/vercel.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    // Vài dependency CJS gọi `require` động lúc runtime → shim lại.
    banner: {
        js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    logLevel: 'info',
})

console.log(`[build-api] wrote ${outfile}`)
