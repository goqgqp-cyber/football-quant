/**
 * Entry serverless cho Vercel (Node runtime).
 *
 * Vercel load file này cho mọi request `/api/*` (xem `vercel.json`:
 * rewrite `/api/(.*)` -> `/api/index`). Adapter `hono/vercel` chuyển
 * cặp req/res của Node sang Fetch `Request`/`Response` rồi gọi `app.fetch`
 * nên toàn bộ route Hono giữ nguyên, không phải đổi code server.
 *
 * `../server/dotenv.js` chỉ đọc `.env` khi file tồn tại (môi trường dev);
 * trên Vercel, biến môi trường do platform bơm trực tiếp nên loader là no-op.
 */
import '../server/dotenv.js'
import { handle } from 'hono/vercel'
import { app } from '../server/app.js'

export default handle(app)
