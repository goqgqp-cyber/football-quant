import { useEffect, useState } from 'react'
import { GlassCard } from '../components/ui/GlassCard'
import { Button } from '../components/ui/Button'
import { Field, TextInput } from '../components/ui/Field'
import { useSettings } from '../hooks/useSettings'
import { useAuth } from '../hooks/useAuth'
import { ApiError, api } from '../lib/api'

/**
 * Trang Tài khoản: tổng vốn (đồng bộ server) + tham số theo giải (cục bộ)
 * + phiên đăng nhập + xuất JSON/CSV.
 */
export function AccountPage() {
    const { settings, update } = useSettings()
    const { user, setBankroll, logout } = useAuth()
    const [bankroll, setBankrollLocal] = useState(String(user?.bankroll ?? settings.bankroll))
    const [saving, setSaving] = useState(false)
    const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

    useEffect(() => {
        if (user) setBankrollLocal(String(user.bankroll))
    }, [user])

    const exportJson = () => {
        const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'football-quant-settings.json'
        a.click()
        URL.revokeObjectURL(url)
    }

    const exportCsv = () => {
        const rows = ['league,lg_home,lg_away']
        for (const [k, v] of Object.entries(settings.leagueParams)) {
            rows.push(`${k},${v.lg_home},${v.lg_away}`)
        }
        const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'football-quant-league-params.csv'
        a.click()
        URL.revokeObjectURL(url)
    }

    const saveBankroll = async () => {
        setSaving(true)
        setMsg(null)
        try {
            await setBankroll(Number(bankroll) || 0)
            setMsg({ ok: true, text: 'Đã lưu tổng vốn.' })
        } catch (e) {
            setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Không lưu được tổng vốn.' })
        } finally {
            setSaving(false)
        }
    }

    const logoutAll = async () => {
        setMsg(null)
        try {
            await api.logoutAll()
            await logout()
        } catch (e) {
            setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Không đăng xuất được.' })
        }
    }

    return (
        <div className="flex flex-col gap-5">
            <GlassCard>
                <p className="font-display text-sm font-bold text-ink-100">Tổng vốn</p>
                <p className="mt-1 text-xs text-ink-500">
                    Lưu trên server theo tài khoản — dùng để quy đổi stake % ra số tiền ở các trang khác.
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Field label="Tổng vốn (đơn vị tiền)">
                        <TextInput
                            type="number"
                            inputMode="numeric"
                            value={bankroll}
                            onChange={(e) => setBankrollLocal(e.target.value)}
                        />
                    </Field>
                    <div className="flex items-end">
                        <Button onClick={() => void saveBankroll()} disabled={saving} className="w-full sm:w-auto">
                            {saving ? 'Đang lưu…' : 'Lưu'}
                        </Button>
                    </div>
                </div>
                {msg && (
                    <p className={`mt-2 text-xs ${msg.ok ? 'text-value-400' : 'text-danger-400'}`}>{msg.text}</p>
                )}
            </GlassCard>

            <GlassCard>
                <p className="font-display text-sm font-bold text-ink-100">Tham số theo giải</p>
                <p className="mt-1 text-xs text-ink-500">
                    lg_home / lg_away dùng để ước lượng λ. Mặc định 1.45 / 1.15. Lưu cục bộ trên thiết bị.
                </p>
                <div className="mt-3 overflow-x-auto rounded-xl border border-white/10">
                    <table className="min-w-full text-sm">
                        <thead className="bg-white/5 text-xs text-ink-500">
                            <tr>
                                <th className="px-3 py-2 text-left">Giải</th>
                                <th className="px-3 py-2 text-left">lg_home</th>
                                <th className="px-3 py-2 text-left">lg_away</th>
                            </tr>
                        </thead>
                        <tbody>
                            {Object.entries(settings.leagueParams).map(([name, v]) => (
                                <tr key={name} className="border-t border-white/8">
                                    <td className="px-3 py-1.5">{name}</td>
                                    <td className="px-3 py-1.5">
                                        <TextInput
                                            type="number"
                                            step={0.05}
                                            value={String(v.lg_home)}
                                            className="!py-1.5"
                                            onChange={(e) =>
                                                update({
                                                    leagueParams: {
                                                        ...settings.leagueParams,
                                                        [name]: { ...v, lg_home: Number(e.target.value) || v.lg_home },
                                                    },
                                                })
                                            }
                                        />
                                    </td>
                                    <td className="px-3 py-1.5">
                                        <TextInput
                                            type="number"
                                            step={0.05}
                                            value={String(v.lg_away)}
                                            className="!py-1.5"
                                            onChange={(e) =>
                                                update({
                                                    leagueParams: {
                                                        ...settings.leagueParams,
                                                        [name]: { ...v, lg_away: Number(e.target.value) || v.lg_away },
                                                    },
                                                })
                                            }
                                        />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </GlassCard>

            <GlassCard>
                <p className="font-display text-sm font-bold text-ink-100">Phiên đăng nhập</p>
                <p className="mt-1 text-xs text-ink-500">
                    Token nằm trong cookie HttpOnly — không lưu localStorage. Nhấn "Đăng xuất tất cả" sẽ thu hồi mọi
                    thiết bị (kể cả phiên hiện tại).
                </p>
                <div className="mt-3 rounded-xl border border-white/10 bg-white/5 px-3 py-3 text-sm text-ink-300">
                    <p>
                        <span className="text-ink-500">Email:</span> {user?.email ?? '—'}
                    </p>
                    <p className="mt-1">
                        <span className="text-ink-500">Vai trò:</span> {user?.role ?? '—'} ·{' '}
                        <span className="text-ink-500">Tạo lúc:</span>{' '}
                        {user ? new Date(user.createdAt).toLocaleString('vi-VN') : '—'}
                    </p>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                    <Button variant="ghost" onClick={() => void logout()}>
                        Đăng xuất thiết bị này
                    </Button>
                    <Button variant="ghost" onClick={() => void logoutAll()}>
                        Đăng xuất tất cả thiết bị
                    </Button>
                </div>
            </GlassCard>

            <GlassCard>
                <p className="font-display text-sm font-bold text-ink-100">Xuất dữ liệu</p>
                <div className="mt-3 flex flex-wrap gap-2">
                    <Button variant="ghost" onClick={exportJson}>
                        Xuất JSON
                    </Button>
                    <Button variant="ghost" onClick={exportCsv}>
                        Xuất CSV
                    </Button>
                </div>
            </GlassCard>
        </div>
    )
}
