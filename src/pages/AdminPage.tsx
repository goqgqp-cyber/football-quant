import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { GlassCard } from '../components/ui/GlassCard'
import { Button } from '../components/ui/Button'
import { Field, TextInput } from '../components/ui/Field'
import { useAuth } from '../hooks/useAuth'
import { api, type AdminOverview, type AdminUserItem, ApiError } from '../lib/api'

export function AdminPage() {
    const { user: currentUser } = useAuth()
    const [overview, setOverview] = useState<AdminOverview | null>(null)
    const [users, setUsers] = useState<AdminUserItem[]>([])
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)
    const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null)

    // Form thêm user mới
    const [showCreateModal, setShowCreateModal] = useState(false)
    const [createEmail, setCreateEmail] = useState('')
    const [createPassword, setCreatePassword] = useState('')
    const [createRole, setCreateRole] = useState<'user' | 'admin'>('user')
    const [createBankroll, setCreateBankroll] = useState('0')
    const [creating, setCreating] = useState(false)

    // Form đổi mật khẩu
    const [targetUserForPassword, setTargetUserForPassword] = useState<AdminUserItem | null>(null)
    const [newPassword, setNewPassword] = useState('')
    const [updatingPassword, setUpdatingPassword] = useState(false)

    // Unlock email form
    const [unlockEmail, setUnlockEmail] = useState('')
    const [unlocking, setUnlocking] = useState(false)

    // Deep health test
    const [deepDiag, setDeepDiag] = useState<Record<string, unknown> | null>(null)
    const [testingHealth, setTestingHealth] = useState(false)

    // Search filter
    const [searchQuery, setSearchQuery] = useState('')

    const loadData = async (silent = false) => {
        if (!silent) setLoading(true)
        else setRefreshing(true)
        try {
            const [ov, uList] = await Promise.all([api.adminOverview(), api.adminListUsers()])
            setOverview(ov)
            setUsers(uList.users)
        } catch (e) {
            setFeedback({
                ok: false,
                message: e instanceof ApiError ? e.message : 'Không tải được dữ liệu quản trị.',
            })
        } finally {
            setLoading(false)
            setRefreshing(false)
        }
    }

    useEffect(() => {
        void loadData()
    }, [])

    const handleToggleSignup = async () => {
        try {
            const res = await api.adminToggleSignup()
            setOverview((prev) => (prev ? { ...prev, allowPublicSignup: res.allowPublicSignup } : null))
            setFeedback({
                ok: true,
                message: `Đã ${res.allowPublicSignup ? 'MỞ' : 'ĐÓNG'} đăng ký công khai thành công.`,
            })
        } catch (e) {
            setFeedback({
                ok: false,
                message: e instanceof ApiError ? e.message : 'Lỗi chuyển trạng thái đăng ký.',
            })
        }
    }

    const handleCreateUser = async (e: React.FormEvent) => {
        e.preventDefault()
        setCreating(true)
        setFeedback(null)
        try {
            const res = await api.adminCreateUser({
                email: createEmail.trim(),
                password: createPassword,
                role: createRole,
                bankroll: Number(createBankroll) || 0,
            })
            setUsers((prev) => [res.user, ...prev])
            setOverview((prev) =>
                prev
                    ? {
                        ...prev,
                        usersCount: prev.usersCount + 1,
                        adminsCount: createRole === 'admin' ? prev.adminsCount + 1 : prev.adminsCount,
                    }
                    : null,
            )
            setFeedback({ ok: true, message: `Đã tạo tài khoản '${res.user.email}' thành công.` })
            setCreateEmail('')
            setCreatePassword('')
            setCreateBankroll('0')
            setShowCreateModal(false)
        } catch (err) {
            setFeedback({
                ok: false,
                message: err instanceof ApiError ? err.message : 'Không tạo được người dùng.',
            })
        } finally {
            setCreating(false)
        }
    }

    const handleToggleRole = async (u: AdminUserItem) => {
        if (u.userId === currentUser?.userId) {
            setFeedback({ ok: false, message: 'Không thể tự hạ quyền quản trị của chính mình.' })
            return
        }
        const nextRole = u.role === 'admin' ? 'user' : 'admin'
        if (
            !window.confirm(
                `Bạn có chắc muốn chuyển vai trò của ${u.email} sang '${nextRole.toUpperCase()}'?`,
            )
        ) {
            return
        }
        try {
            const res = await api.adminUpdateUser(u.userId, { role: nextRole })
            setUsers((prev) => prev.map((item) => (item.userId === u.userId ? res.user : item)))
            setOverview((prev) =>
                prev
                    ? {
                        ...prev,
                        adminsCount:
                            nextRole === 'admin' ? prev.adminsCount + 1 : prev.adminsCount - 1,
                    }
                    : null,
            )
            setFeedback({
                ok: true,
                message: `Đã đổi vai trò của '${u.email}' thành '${nextRole.toUpperCase()}'.`,
            })
        } catch (err) {
            setFeedback({
                ok: false,
                message: err instanceof ApiError ? err.message : 'Lỗi cập nhật vai trò.',
            })
        }
    }

    const handleSetPassword = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!targetUserForPassword) return
        setUpdatingPassword(true)
        setFeedback(null)
        try {
            await api.adminUpdateUser(targetUserForPassword.userId, { newPassword })
            setFeedback({
                ok: true,
                message: `Đã cập nhật mật khẩu mới cho '${targetUserForPassword.email}'.`,
            })
            setTargetUserForPassword(null)
            setNewPassword('')
        } catch (err) {
            setFeedback({
                ok: false,
                message: err instanceof ApiError ? err.message : 'Không đổi được mật khẩu.',
            })
        } finally {
            setUpdatingPassword(false)
        }
    }

    const handleDeleteUser = async (u: AdminUserItem) => {
        if (u.userId === currentUser?.userId) {
            setFeedback({ ok: false, message: 'Bạn không thể tự xóa tài khoản của chính mình.' })
            return
        }
        if (!window.confirm(`XÁC NHẬN: Xóa vĩnh viễn tài khoản '${u.email}' và toàn bộ phiên?`)) {
            return
        }
        try {
            await api.adminDeleteUser(u.userId)
            setUsers((prev) => prev.filter((item) => item.userId !== u.userId))
            setOverview((prev) =>
                prev
                    ? {
                        ...prev,
                        usersCount: prev.usersCount - 1,
                        adminsCount: u.role === 'admin' ? prev.adminsCount - 1 : prev.adminsCount,
                    }
                    : null,
            )
            setFeedback({ ok: true, message: `Đã xóa tài khoản '${u.email}'.` })
        } catch (err) {
            setFeedback({
                ok: false,
                message: err instanceof ApiError ? err.message : 'Không xóa được tài khoản.',
            })
        }
    }

    const handleUnlockEmail = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!unlockEmail.trim()) return
        setUnlocking(true)
        setFeedback(null)
        try {
            const res = await api.adminUnlockEmail(unlockEmail.trim())
            setFeedback({ ok: true, message: res.message })
            setUnlockEmail('')
        } catch (err) {
            setFeedback({
                ok: false,
                message: err instanceof ApiError ? err.message : 'Lỗi mở khóa tài khoản.',
            })
        } finally {
            setUnlocking(false)
        }
    }

    const handleTestHealth = async () => {
        setTestingHealth(true)
        setDeepDiag(null)
        try {
            const res = await fetch('/api/health?deep=1', { credentials: 'include' })
            const data = await res.json()
            setDeepDiag(data)
        } catch (err) {
            setDeepDiag({ error: String(err) })
        } finally {
            setTestingHealth(false)
        }
    }

    const filteredUsers = users.filter((u) => {
        const q = searchQuery.toLowerCase().trim()
        if (!q) return true
        return u.email.toLowerCase().includes(q) || u.role.toLowerCase().includes(q)
    })

    if (loading) {
        return (
            <div className="flex h-64 items-center justify-center">
                <span className="flex items-center gap-2 text-sm text-ink-500">
                    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-r-transparent" />
                    Đang tải dữ liệu quản trị…
                </span>
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-6">
            {/* Header info bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 backdrop-blur-md">
                <div className="flex items-center gap-2">
                    <span className="flex h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
                    <span className="text-xs font-semibold text-emerald-300">Quản trị viên:</span>
                    <span className="text-xs text-ink-100">{currentUser?.email}</span>
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        variant="ghost"
                        className="!py-1.5 !px-3 !text-xs"
                        onClick={() => void loadData(true)}
                        disabled={refreshing}
                    >
                        {refreshing ? 'Đang làm mới…' : 'Làm mới'}
                    </Button>
                </div>
            </div>

            {/* Notification banner */}
            <AnimatePresence>
                {feedback && (
                    <motion.div
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        className={`flex items-center justify-between rounded-xl border px-4 py-3 text-sm ${feedback.ok
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                            : 'border-danger-500/30 bg-danger-500/10 text-danger-300'
                            }`}
                    >
                        <span>{feedback.message}</span>
                        <button
                            type="button"
                            onClick={() => setFeedback(null)}
                            className="text-xs opacity-70 hover:opacity-100"
                        >
                            ✕
                        </button>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* KPI Cards */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <GlassCard className="!p-4">
                    <p className="text-[11px] uppercase tracking-wider text-ink-500">Người dùng</p>
                    <p className="mt-1 font-display text-2xl font-bold text-white">
                        {overview?.usersCount ?? 0}
                    </p>
                    <p className="mt-1 text-xs text-ink-500">
                        {overview?.adminsCount ?? 0} quản trị viên (Admin)
                    </p>
                </GlassCard>

                <GlassCard className="!p-4">
                    <p className="text-[11px] uppercase tracking-wider text-ink-500">Bộ nhớ / Cache</p>
                    <div className="mt-1 flex items-center gap-2">
                        <span
                            className={`h-2 w-2 rounded-full ${overview?.redisConnected ? 'bg-emerald-400' : 'bg-amber-400'
                                }`}
                        />
                        <span className="font-display text-base font-bold text-white">
                            {overview?.usingMemoryStore ? 'In-Memory (Dev)' : 'Upstash Redis'}
                        </span>
                    </div>
                    <p className="mt-1 text-xs text-ink-500">
                        {overview?.redisConnected ? 'Kết nối sẵn sàng' : 'Chưa kết nối'}
                    </p>
                </GlassCard>

                <GlassCard className="!p-4">
                    <p className="text-[11px] uppercase tracking-wider text-ink-500">Gemini AI Engine</p>
                    <p className="mt-1 truncate font-display text-base font-bold text-white" title={overview?.geminiModel}>
                        {overview?.geminiModel ?? 'gemini-flash-latest'}
                    </p>
                    <p className="mt-1 text-xs text-ink-500">
                        {overview?.geminiConfigured ? 'Đã cài đặt API Key' : 'Chưa có key (Mặc định)'}
                    </p>
                </GlassCard>

                <GlassCard className="!p-4">
                    <div className="flex items-center justify-between">
                        <p className="text-[11px] uppercase tracking-wider text-ink-500">Đăng ký công khai</p>
                        <button
                            type="button"
                            onClick={handleToggleSignup}
                            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${overview?.allowPublicSignup ? 'bg-emerald-500' : 'bg-neutral-700'
                                }`}
                        >
                            <span
                                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${overview?.allowPublicSignup ? 'translate-x-4' : 'translate-x-0'
                                    }`}
                            />
                        </button>
                    </div>
                    <p className="mt-1 font-display text-lg font-bold text-white">
                        {overview?.allowPublicSignup ? 'Đang MỞ' : 'Đang ĐÓNG'}
                    </p>
                    <p className="mt-1 text-xs text-ink-500">
                        {overview?.allowPublicSignup
                            ? 'Mọi người có thể tự tạo tài khoản'
                            : 'Chỉ Admin được cấp tài khoản'}
                    </p>
                </GlassCard>
            </div>

            {/* Quick Operations Section */}
            <div className="grid gap-4 md:grid-cols-2">
                <GlassCard className="!p-5">
                    <h2 className="font-display text-sm font-bold text-ink-100">
                        Mở khóa tài khoản (Brute-force unlock)
                    </h2>
                    <p className="mt-1 text-xs text-ink-500">
                        Xóa số lần đăng nhập sai nếu một email/username bị khóa tạm thời sau 5 lần gõ sai.
                    </p>
                    <form onSubmit={handleUnlockEmail} className="mt-3 flex gap-2">
                        <TextInput
                            type="text"
                            placeholder="Email hoặc tên đăng nhập cần mở khóa"
                            value={unlockEmail}
                            onChange={(e) => setUnlockEmail(e.target.value)}
                            className="flex-1 text-xs"
                            required
                        />
                        <Button type="submit" className="!py-1.5 !px-3 !text-xs" disabled={unlocking}>
                            {unlocking ? 'Đang mở…' : 'Mở khóa'}
                        </Button>
                    </form>
                </GlassCard>

                <GlassCard className="!p-5">
                    <div className="flex items-center justify-between">
                        <div>
                            <h2 className="font-display text-sm font-bold text-ink-100">
                                Chẩn đoán máy chủ (Deep Health)
                            </h2>
                            <p className="mt-1 text-xs text-ink-500">
                                Kiểm tra sâu kết nối Redis/KV, thời gian phản hồi và cấu hình máy chủ.
                            </p>
                        </div>
                        <Button
                            variant="ghost"
                            className="!py-1.5 !px-3 !text-xs"
                            onClick={handleTestHealth}
                            disabled={testingHealth}
                        >
                            {testingHealth ? 'Đang test…' : 'Chạy kiểm tra'}
                        </Button>
                    </div>
                    {deepDiag ? (
                        <div className="mt-3 max-h-32 overflow-y-auto rounded-lg border border-white/10 bg-black/40 p-2 text-[11px] font-mono text-ink-300">
                            <pre>{JSON.stringify(deepDiag, null, 2)}</pre>
                        </div>
                    ) : null}
                </GlassCard>
            </div>

            {/* User Management Section */}
            <GlassCard className="!p-5">
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                    <div>
                        <h2 className="font-display text-base font-bold text-white">
                            Quản lý Người dùng ({filteredUsers.length})
                        </h2>
                        <p className="mt-0.5 text-xs text-ink-500">
                            Danh sách người dùng, vai trò, số dư vốn và quyền đăng nhập trong hệ thống.
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <TextInput
                            type="search"
                            placeholder="Tìm theo email, role…"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full text-xs sm:w-48 !py-1.5"
                        />
                        <Button className="!py-1.5 !px-3 !text-xs" onClick={() => setShowCreateModal(true)}>
                            + Thêm tài khoản
                        </Button>
                    </div>
                </div>

                <div className="mt-4 overflow-x-auto rounded-xl border border-white/10">
                    <table className="min-w-full text-left text-sm">
                        <thead className="border-b border-white/10 bg-white/5 text-[11px] uppercase tracking-wider text-ink-500">
                            <tr>
                                <th className="px-4 py-3">Tài khoản (Email)</th>
                                <th className="px-4 py-3">Vai trò</th>
                                <th className="px-4 py-3">Tổng vốn</th>
                                <th className="px-4 py-3">Ngày tạo</th>
                                <th className="px-4 py-3 text-right">Thao tác</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {filteredUsers.length === 0 ? (
                                <tr>
                                    <td colSpan={5} className="px-4 py-8 text-center text-xs text-ink-500">
                                        Không tìm thấy người dùng nào phù hợp.
                                    </td>
                                </tr>
                            ) : (
                                filteredUsers.map((u) => {
                                    const isSelf = u.userId === currentUser?.userId
                                    return (
                                        <tr key={u.userId} className="transition-colors hover:bg-white/[0.02]">
                                            <td className="px-4 py-3">
                                                <div className="flex items-center gap-2">
                                                    <span className="font-medium text-white">{u.email}</span>
                                                    {isSelf && (
                                                        <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-ink-300">
                                                            Bạn
                                                        </span>
                                                    )}
                                                </div>
                                                <span className="text-[10px] text-ink-600">{u.userId}</span>
                                            </td>
                                            <td className="px-4 py-3">
                                                <span
                                                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${u.role === 'admin'
                                                        ? 'border border-violet-400/30 bg-violet-500/20 text-violet-300'
                                                        : 'border border-white/10 bg-white/5 text-ink-400'
                                                        }`}
                                                >
                                                    {u.role.toUpperCase()}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-ink-300">
                                                {u.bankroll ? u.bankroll.toLocaleString('vi-VN') : '0'}
                                            </td>
                                            <td className="px-4 py-3 text-xs text-ink-500">
                                                {new Date(u.createdAt).toLocaleDateString('vi-VN')}
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                                <div className="flex items-center justify-end gap-1.5">
                                                    <button
                                                        type="button"
                                                        onClick={() => handleToggleRole(u)}
                                                        disabled={isSelf}
                                                        title="Đổi vai trò user <-> admin"
                                                        className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-ink-300 transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
                                                    >
                                                        {u.role === 'admin' ? 'Hạ User' : 'Lên Admin'}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => setTargetUserForPassword(u)}
                                                        title="Đặt lại mật khẩu"
                                                        className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-ink-300 transition hover:bg-white/15"
                                                    >
                                                        Đổi MK
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleDeleteUser(u)}
                                                        disabled={isSelf}
                                                        title="Xóa tài khoản"
                                                        className="rounded-lg border border-danger-500/20 bg-danger-500/10 px-2 py-1 text-xs text-danger-400 transition hover:bg-danger-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                                                    >
                                                        Xóa
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    )
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            </GlassCard>

            {/* Modal Tạo người dùng */}
            <AnimatePresence>
                {showCreateModal && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            onClick={() => setShowCreateModal(false)}
                            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                        />
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95, y: 12 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 12 }}
                            className="relative w-full max-w-md"
                        >
                            <GlassCard className="!p-6">
                                <h3 className="font-display text-lg font-bold text-white">Thêm tài khoản mới</h3>
                                <p className="mt-1 text-xs text-ink-500">
                                    Tạo người dùng hoặc quản trị viên trực tiếp từ dashboard.
                                </p>
                                <form onSubmit={handleCreateUser} className="mt-4 flex flex-col gap-3">
                                    <Field label="Email hoặc Tên đăng nhập">
                                        <TextInput
                                            type="text"
                                            placeholder="vd: quant_user hoặc user@domain.com"
                                            value={createEmail}
                                            onChange={(e) => setCreateEmail(e.target.value)}
                                            required
                                        />
                                    </Field>
                                    <Field label="Mật khẩu (tối thiểu 8 ký tự)">
                                        <TextInput
                                            type="password"
                                            placeholder="Nhập mật khẩu an toàn…"
                                            value={createPassword}
                                            onChange={(e) => setCreatePassword(e.target.value)}
                                            required
                                            minLength={8}
                                        />
                                    </Field>
                                    <div className="grid grid-cols-2 gap-3">
                                        <Field label="Vai trò">
                                            <select
                                                value={createRole}
                                                onChange={(e) => setCreateRole(e.target.value as 'user' | 'admin')}
                                                className="w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-ink-100 outline-none backdrop-blur-md transition focus:border-white/40"
                                            >
                                                <option value="user" className="bg-neutral-900 text-white">
                                                    User (Người dùng)
                                                </option>
                                                <option value="admin" className="bg-neutral-900 text-white">
                                                    Admin (Quản trị)
                                                </option>
                                            </select>
                                        </Field>
                                        <Field label="Tổng vốn ban đầu">
                                            <TextInput
                                                type="number"
                                                value={createBankroll}
                                                onChange={(e) => setCreateBankroll(e.target.value)}
                                            />
                                        </Field>
                                    </div>

                                    <div className="mt-3 flex items-center justify-end gap-2">
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setShowCreateModal(false)}
                                        >
                                            Hủy
                                        </Button>
                                        <Button type="submit" disabled={creating}>
                                            {creating ? 'Đang tạo…' : 'Xác nhận tạo'}
                                        </Button>
                                    </div>
                                </form>
                            </GlassCard>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>

            {/* Modal Đổi mật khẩu */}
            <AnimatePresence>
                {targetUserForPassword && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            onClick={() => setTargetUserForPassword(null)}
                            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                        />
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95, y: 12 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 12 }}
                            className="relative w-full max-w-md"
                        >
                            <GlassCard className="!p-6">
                                <h3 className="font-display text-lg font-bold text-white">
                                    Đổi mật khẩu: {targetUserForPassword.email}
                                </h3>
                                <p className="mt-1 text-xs text-ink-500">
                                    Đặt mật khẩu mới cho tài khoản này (tối thiểu 8 ký tự).
                                </p>
                                <form onSubmit={handleSetPassword} className="mt-4 flex flex-col gap-3">
                                    <Field label="Mật khẩu mới">
                                        <TextInput
                                            type="password"
                                            placeholder="Nhập mật khẩu mới…"
                                            value={newPassword}
                                            onChange={(e) => setNewPassword(e.target.value)}
                                            required
                                            minLength={8}
                                        />
                                    </Field>
                                    <div className="mt-3 flex items-center justify-end gap-2">
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setTargetUserForPassword(null)}
                                        >
                                            Hủy
                                        </Button>
                                        <Button type="submit" disabled={updatingPassword}>
                                            {updatingPassword ? 'Đang cập nhật…' : 'Lưu mật khẩu'}
                                        </Button>
                                    </div>
                                </form>
                            </GlassCard>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>
        </div>
    )
}
