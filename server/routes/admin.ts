import { Hono } from 'hono'
import { z } from 'zod'
import { requireAdmin, type Vars } from '../middleware.js'
import {
    listAllUsers,
    createUser,
    updateUser,
    deleteUser,
    clearFails,
    getUserByEmail,
    type AuthUser,
} from '../auth.js'
import { env } from '../env.js'
import { redisDiag, usingMemoryStore } from '../redis.js'

export const adminApp = new Hono<{ Variables: Vars }>()

// Mọi route trong adminApp bắt buộc quyền admin
adminApp.use('*', requireAdmin)

/**
 * GET /api/admin/overview
 * Tổng quan hệ thống, tài khoản, trạng thái kết nối DB/Redis và xKiro AI (Qwen).
 */
adminApp.get('/overview', async (c) => {
    const users = await listAllUsers()
    const redisStatus = await redisDiag()

    return c.json({
        usersCount: users.length,
        adminsCount: users.filter((u) => u.role === 'admin').length,
        usingMemoryStore,
        redisConnected: redisStatus.ok,
        redisMode: redisStatus.mode,
        allowPublicSignup: env.allowPublicSignup,
        xkiroConfigured: Boolean(env.xkiroApiKey),
        xkiroModel: env.xkiroModel,
        nodeEnv: env.nodeEnv,
        uptime: Math.round(process.uptime()),
        serverTime: new Date().toISOString(),
    })
})

/**
 * GET /api/admin/users
 * Danh sách người dùng hệ thống (ẩn hash mật khẩu).
 */
adminApp.get('/users', async (c) => {
    const users = await listAllUsers()
    return c.json({
        users: users.map((u) => ({
            userId: u.userId,
            email: u.email,
            role: u.role,
            bankroll: u.bankroll,
            createdAt: u.createdAt,
        })),
    })
})

const createUserSchema = z.object({
    email: z.string().trim().toLowerCase().min(3).max(120),
    password: z.string().min(8).max(128),
    role: z.enum(['user', 'admin']).default('user'),
    bankroll: z.number().default(0),
})

/**
 * POST /api/admin/users
 * Admin chủ động tạo tài khoản người dùng hoặc admin mới.
 */
adminApp.post('/users', async (c) => {
    const body = await c.req.json().catch(() => null)
    const parsed = createUserSchema.safeParse(body)
    if (!parsed.success) {
        return c.json({ error: 'validation', issues: parsed.error.flatten() }, 400)
    }

    const { email: rawEmail, password, role, bankroll } = parsed.data
    const email = rawEmail.includes('@') ? rawEmail : `${rawEmail}@footballquant.local`

    const existing = await getUserByEmail(email)
    if (existing) {
        return c.json({ error: 'exists', message: `Email/tài khoản '${email}' đã tồn tại.` }, 409)
    }

    const user = await createUser(email, password, role)
    if (bankroll !== 0) {
        await updateUser(user.userId, { bankroll })
        user.bankroll = bankroll
    }

    return c.json(
        {
            user: {
                userId: user.userId,
                email: user.email,
                role: user.role,
                bankroll: user.bankroll,
                createdAt: user.createdAt,
            },
        },
        201,
    )
})

const patchUserSchema = z.object({
    role: z.enum(['user', 'admin']).optional(),
    bankroll: z.number().optional(),
    newPassword: z.string().min(8).max(128).optional(),
})

/**
 * PATCH /api/admin/users/:userId
 * Cập nhật vai trò (user ↔ admin), vốn, hoặc reset mật khẩu cho người dùng.
 */
adminApp.patch('/users/:userId', async (c) => {
    const userId = c.req.param('userId')
    const body = await c.req.json().catch(() => null)
    const parsed = patchUserSchema.safeParse(body)
    if (!parsed.success) {
        return c.json({ error: 'validation', issues: parsed.error.flatten() }, 400)
    }

    const updated = await updateUser(userId, parsed.data)
    if (!updated) {
        return c.json({ error: 'not_found', message: 'Không tìm thấy người dùng.' }, 404)
    }

    return c.json({
        user: {
            userId: updated.userId,
            email: updated.email,
            role: updated.role,
            bankroll: updated.bankroll,
            createdAt: updated.createdAt,
        },
    })
})

/**
 * DELETE /api/admin/users/:userId
 * Xóa tài khoản người dùng và thu hồi mọi phiên làm việc.
 */
adminApp.delete('/users/:userId', async (c) => {
    const userId = c.req.param('userId')
    const currentUser = c.get('user') as AuthUser

    if (currentUser.userId === userId) {
        return c.json(
            { error: 'forbidden', message: 'Bạn không thể tự xóa tài khoản của chính mình.' },
            400,
        )
    }

    const success = await deleteUser(userId)
    if (!success) {
        return c.json({ error: 'not_found', message: 'Không tìm thấy người dùng.' }, 404)
    }

    return c.json({ ok: true, message: 'Đã xóa người dùng thành công.' })
})

/**
 * POST /api/admin/toggle-signup
 * Bật hoặc tắt tính năng đăng ký tài khoản công khai.
 */
adminApp.post('/toggle-signup', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const target = typeof body.allowed === 'boolean' ? body.allowed : !env.allowPublicSignup
    env.setAllowPublicSignup(target)
    return c.json({ allowPublicSignup: env.allowPublicSignup })
})

const unlockSchema = z.object({
    email: z.string().trim().toLowerCase().min(1),
})

/**
 * POST /api/admin/unlock-email
 * Mở khóa tài khoản bị khóa do đăng nhập sai mật khẩu quá 5 lần.
 */
adminApp.post('/unlock-email', async (c) => {
    const body = await c.req.json().catch(() => null)
    const parsed = unlockSchema.safeParse(body)
    if (!parsed.success) {
        return c.json({ error: 'validation', issues: parsed.error.flatten() }, 400)
    }

    const raw = parsed.data.email
    const email = raw.includes('@') ? raw : `${raw}@footballquant.local`
    await clearFails(email)

    return c.json({ ok: true, message: `Đã mở khóa các lần đăng nhập sai của '${email}'.` })
})
