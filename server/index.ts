import './dotenv.js'
import { serve } from '@hono/node-server'
import { app } from './app.js'
import { env, isProd } from './env.js'
import { pingRedis } from './redis.js'
import { runSystemSelfTest } from './routes/admin.js'

async function main() {
    const redisOk = await pingRedis()
    if (!redisOk) {
        console.warn('[server] CẢNH BÁO: không kết nối được Upstash Redis. Kiểm tra .env')
    } else {
        console.log('[server] Upstash Redis: OK')
    }

    // Tự động kiểm tra kết nối với các provider khi khởi động máy chủ (Admin debug log)
    void runSystemSelfTest()
        .then((report) => {
            console.log(
                `[server][self-test] Khởi động: Kiểm tra kết nối dịch vụ ngoài:\n` +
                `  - API-Football: ${report.apiFootball.status} (${report.apiFootball.latencyMs}ms)${report.apiFootball.error ? ` [Lỗi: ${report.apiFootball.error}]` : ''}\n` +
                `  - Brave Search: ${report.brave.status} (${report.brave.latencyMs}ms)${report.brave.error ? ` [Lỗi: ${report.brave.error}]` : ''}\n` +
                `  - Tavily Search: ${report.tavily.status} (${report.tavily.latencyMs}ms)${report.tavily.error ? ` [Lỗi: ${report.tavily.error}]` : ''}\n` +
                `  - xKiro AI (Qwen): ${report.qwen.status} (${report.qwen.latencyMs}ms)${report.qwen.error ? ` [Lỗi: ${report.qwen.error}]` : ''}`,
            )
        })
        .catch((err) => {
            console.error('[server][self-test] Lỗi khi tự kiểm tra kết nối khi khởi động:', err)
        })

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