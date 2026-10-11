import { useState } from 'react'
import { motion } from 'framer-motion'
import { GlassCard } from '../components/ui/GlassCard'
import { Button } from '../components/ui/Button'
import { Field, TextInput } from '../components/ui/Field'
import { useAuth } from '../hooks/useAuth'
import { ApiError } from '../lib/api'

type Mode = 'login' | 'signup'

export function LoginPage() {
    const { login, signup } = useAuth()
    const [mode, setMode] = useState<Mode>('login')
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const submit = async () => {
        setError(null)
        setBusy(true)
        try {
            if (mode === 'login') await login(email.trim(), password)
            else await signup(email.trim(), password)
        } catch (e) {
            if (e instanceof ApiError) setError(e.message)
            else setError('Không kết nối được máy chủ. Kiểm tra backend đã chạy chưa.')
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="flex min-h-dvh items-center justify-center px-4">
            <motion.div
                initial={{ opacity: 0, y: 16, filter: 'blur(8px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                className="w-full max-w-md"
            >
                <GlassCard className="!p-6">
                    <p className="text-[11px] uppercase tracking-[0.2em] text-ink-500">
                        Football Quant
                    </p>
                    <h1 className="mt-1 font-display text-2xl font-bold tracking-tight">
                        <span className="text-gradient">
                            {mode === 'login' ? 'Đăng nhập' : 'Tạo tài khoản'}
                        </span>
                    </h1>
                    <p className="mt-2 text-sm text-ink-500">
                        Phiên đăng nhập dùng cookie HttpOnly — không lưu token trong trình duyệt.
                    </p>

                    <form
                        className="mt-5 flex flex-col gap-3"
                        onSubmit={(e) => {
                            e.preventDefault()
                            void submit()
                        }}
                    >
                        <Field label="Email">
                            <TextInput
                                type="email"
                                autoComplete="username"
                                inputMode="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                            />
                        </Field>
                        <Field
                            label="Mật khẩu"
                            hint={mode === 'signup' ? 'Tối thiểu 8 ký tự.' : undefined}
                        >
                            <TextInput
                                type="password"
                                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                            />
                        </Field>

                        {error && (
                            <div className="rounded-xl border border-danger-400/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-400">
                                {error}
                            </div>
                        )}

                        <Button refract type="submit" disabled={busy} className="mt-1 w-full">
                            {busy
                                ? 'Đang xử lý…'
                                : mode === 'login'
                                    ? 'Đăng nhập'
                                    : 'Đăng ký'}
                        </Button>
                    </form>

                    <button
                        type="button"
                        className="mt-4 w-full text-center text-sm text-violet-400 hover:text-violet-300"
                        onClick={() => {
                            setMode((m) => (m === 'login' ? 'signup' : 'login'))
                            setError(null)
                        }}
                    >
                        {mode === 'login'
                            ? 'Chưa có tài khoản? Đăng ký'
                            : 'Đã có tài khoản? Đăng nhập'}
                    </button>
                </GlassCard>
            </motion.div>
        </div>
    )
}