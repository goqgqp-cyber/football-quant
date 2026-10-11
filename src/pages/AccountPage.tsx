import { useState } from 'react'
import { GlassCard } from '../components/ui/GlassCard'
import { Button } from '../components/ui/Button'
import { Field, TextInput } from '../components/ui/Field'
import { useSettings } from '../hooks/useSettings'

/**
 * Trang Tài khoản (G1): tổng vốn + tham số theo giải + xuất JSON/CSV.
 * G2 thêm phần "Phiên đăng nhập" (danh sách thiết bị, đăng xuất từng thiết bị).
 */
export function AccountPage() {
    const { settings, update } = useSettings()
    const [bankroll, setBankroll] = useState(String(settings.bankroll))

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

    return (
        <div className="flex flex-col gap-5">
            <GlassCard>
                <p className="font-display text-sm font-bold text-ink-100">Tổng vốn</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Field label="Tổng vốn (đơn vị tiền)">
                        <TextInput
                            type="number"
                            inputMode="numeric"
                            value={bankroll}
                            onChange={(e) => setBankroll(e.target.value)}
                        />
                    </Field>
                    <div className="flex items-end">
                        <Button
                            onClick={() => update({ bankroll: Number(bankroll) || 0 })}
                            className="w-full sm:w-auto"
                        >
                            Lưu
                        </Button>
                    </div>
                </div>
            </GlassCard>

            <GlassCard>
                <p className="font-display text-sm font-bold text-ink-100">Tham số theo giải</p>
                <p className="mt-1 text-xs text-ink-500">
                    lg_home / lg_away dùng để ước lượng λ. Mặc định 1.45 / 1.15.
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
                    G2 sẽ hiển thị danh sách thiết bị (lưu trong Redis: session:&#123;userId&#125;:&#123;sessionId&#125;) và cho
                    đăng xuất từng thiết bị hoặc tất cả. Token nằm trong cookie HttpOnly — không lưu localStorage.
                </p>
                <div className="mt-3 rounded-xl border border-white/10 bg-white/5 px-3 py-3 text-sm text-ink-500">
                    Chưa có phiên nào (G1 chưa bật backend).
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
