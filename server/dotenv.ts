/**
 * Nạp file `.env` ở thư mục project vào `process.env` (nếu có).
 * File này phải được import ĐẦU TIÊN trong `index.ts`, vì `env.ts`
 * đọc biến môi trường ngay lúc import.
 * Không ghi đè biến đã có sẵn (ưu tiên môi trường deploy như Vercel/Cloud Run).
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function parseDotenv(src: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const raw of src.split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const eq = line.indexOf('=')
        if (eq === -1) continue
        const key = line.slice(0, eq).trim()
        let value = line.slice(eq + 1).trim()
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1)
        }
        if (key) out[key] = value
    }
    return out
}

try {
    for (const file of ['.env.local', '.env']) {
        const envPath = join(process.cwd(), file)
        if (existsSync(envPath)) {
            const parsed = parseDotenv(readFileSync(envPath, 'utf8'))
            for (const [k, v] of Object.entries(parsed)) {
                if (process.env[k] === undefined) process.env[k] = v
            }
        }
    }
} catch {
    // Không có/không đọc được .env thì bỏ qua — env.ts sẽ báo biến thiếu rõ ràng.
}
