/**
 * Script CLI để khởi tạo hoặc đặt lại tài khoản admin.
 * Chạy: npx tsx scripts/seed-admin.ts
 */
import '../server/dotenv.js'
import { ensureAdminUser, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD } from '../server/auth.js'

async function main() {
    console.log('[seed-admin] Đang khởi tạo tài khoản admin...')
    const admin = await ensureAdminUser()
    console.log(`[seed-admin] ✅ Thành công!`)
    console.log(`- Email / Username : ${admin.email} (hoặc đăng nhập bằng 'admin')`)
    console.log(`- Mật khẩu          : ${DEFAULT_ADMIN_PASSWORD}`)
    console.log(`- Vai trò          : ${admin.role}`)
    console.log(`- User ID          : ${admin.userId}`)
    process.exit(0)
}

main().catch((err) => {
    console.error('[seed-admin] ❌ Thất bại:', err)
    process.exit(1)
})
