import { serve } from '@hono/node-server'
import { app } from './app.js'
import { env, isProd } from './env.js'
import { pingRedis } from './redis.js'

async function main() {
    const redisOk = await pingRedis()
    if (!redisOk) {
        console.warn('[server] CẢNH BÁO: không kết nối được Upstash Redis. Kiểm tra .env')
    } else {
        console.log('[server] Upstash Redis: OK')
    }

    serve({ fetch: app.fetch, port: env.port }, (info) => {
        console.log(
            `[server] Football Quant API chạy tại http://localhost:${info.port} (${isProd ? 'production' : 'development'})`,
        )
    })
}

main().catch((err) => {
    console.error('[server] Khởi động thất bại:', err)
    process.exit(1)
})