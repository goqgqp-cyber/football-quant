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
 * vào `api/[...route].js` để function không còn phụ thuộc vào việc
 * resolve module lúc chạy.
 *
 * Lưu ý tên file: Vercel Functions dùng catch-all `[...route]` (MỘT cặp
 * ngoặc vuông). Cú pháp `[[...route]]` là của Next.js, Vercel sẽ từ chối
 * config ngay khi validate → deploy lỗi tức thì.
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
