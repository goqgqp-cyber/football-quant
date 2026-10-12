import { useState } from 'react'
import { api, type SystemSelfTestReport, ApiError } from '../lib/api'
import { GlassCard } from './ui/GlassCard'
import { Button } from './ui/Button'

export function ConnectionSelfTest() {
    const [report, setReport] = useState<SystemSelfTestReport | null>(null)
    const [testing, setTesting] = useState(false)
    const [errorMsg, setErrorMsg] = useState<string | null>(null)

    const handleRunSelfTest = async () => {
        setTesting(true)
        setErrorMsg(null)
        try {
            const data = await api.systemSelfTest()
            setReport(data)
        } catch (e) {
            setErrorMsg(e instanceof ApiError ? e.message : 'Không thể thực hiện kiểm tra kết nối.')
        } finally {
            setTesting(false)
        }
    }

    const providers = report
        ? [
            {
                name: 'API-Football',
                desc: 'Lấy lịch thi đấu, kết quả HT/FT, H2H, chấn thương & BXH',
                status: report.apiFootball.status,
                latency: report.apiFootball.latencyMs,
                error: report.apiFootball.error,
                extra: report.apiFootball.quota
                    ? `Quota ngày: ${report.apiFootball.quota.requestsRemainingDay ?? '?'} / ${report.apiFootball.quota.requestsLimitDay ?? '?'}`
                    : undefined,
            },
            {
                name: 'Brave Search',
                desc: 'Truy vấn web trực tiếp, tin chấn thương & đội hình',
                status: report.brave.status,
                latency: report.brave.latencyMs,
                error: report.brave.error,
                extra: report.brave.resultCount != null ? `${report.brave.resultCount} kết quả web` : undefined,
            },
            {
                name: 'Tavily Search',
                desc: 'AI Web Search & tổng hợp nội dung trang thể thao',
                status: report.tavily.status,
                latency: report.tavily.latencyMs,
                error: report.tavily.error,
                extra: report.tavily.resultCount != null ? `${report.tavily.resultCount} trang trích xuất` : undefined,
            },
            {
                name: 'xKiro AI (Qwen)',
                desc: 'LLM suy luận chiến thuật & bóc tách ảnh bảng kèo OCR',
                status: report.qwen.status,
                latency: report.qwen.latencyMs,
                error: report.qwen.error,
            },
        ]
        : []

    const allOk = report && providers.every((p) => p.status === 'OK')

    return (
        <GlassCard className="relative overflow-hidden">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <div className="flex items-center gap-2">
                        <span className="flex h-2.5 w-2.5 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.7)]" />
                        <h3 className="font-display text-sm font-bold text-ink-100">
                            Kiểm tra kết nối dịch vụ (Self-Test)
                        </h3>
                    </div>
                    <p className="mt-1 text-xs text-ink-400">
                        Chạy truy vấn tối thiểu tới từng nhà cung cấp để kiểm tra API key, hạn ngạch (quota) và độ trễ.
                    </p>
                </div>

                <Button
                    onClick={() => void handleRunSelfTest()}
                    disabled={testing}
                    className="self-start sm:self-auto bg-gradient-to-r from-cyan-500/20 to-blue-500/20 border-cyan-500/30 hover:border-cyan-400 text-cyan-200"
                >
                    {testing ? (
                        <span className="flex items-center gap-2">
                            <svg className="h-4 w-4 animate-spin text-cyan-400" viewBox="0 0 24 24" fill="none">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                            </svg>
                            Đang kiểm tra…
                        </span>
                    ) : (
                        'Kiểm tra kết nối'
                    )}
                </Button>
            </div>

            {errorMsg && (
                <div className="mt-3 rounded-xl border border-red-500/30 bg-red-950/20 p-3 text-xs text-red-300">
                    <span className="font-semibold text-red-200">Lỗi kiểm tra:</span> {errorMsg}
                </div>
            )}

            {report && (
                <div className="mt-4 flex flex-col gap-3">
                    <div className="flex items-center justify-between border-t border-white/8 pt-3 text-xs text-ink-400">
                        <span className="flex items-center gap-2">
                            {allOk ? (
                                <span className="text-emerald-400 font-semibold flex items-center gap-1.5">
                                    <span className="h-2 w-2 rounded-full bg-emerald-400 inline-block" />
                                    Tất cả 4 dịch vụ hoạt động bình thường
                                </span>
                            ) : (
                                <span className="text-amber-400 font-semibold flex items-center gap-1.5">
                                    <span className="h-2 w-2 rounded-full bg-amber-400 inline-block" />
                                    Cảnh báo: Có dịch vụ gặp lỗi kết nối hoặc giới hạn plan
                                </span>
                            )}
                        </span>
                        <span className="text-ink-500 font-mono text-[11px]">
                            {new Date(report.timestamp).toLocaleTimeString('vi-VN')} {new Date(report.timestamp).toLocaleDateString('vi-VN')}
                        </span>
                    </div>

                    <div className="grid gap-2.5 sm:grid-cols-2">
                        {providers.map((p) => {
                            const isOk = p.status === 'OK'
                            return (
                                <div
                                    key={p.name}
                                    className={`rounded-xl border p-3 transition-colors ${
                                        isOk
                                            ? 'border-emerald-500/25 bg-emerald-950/10'
                                            : 'border-red-500/35 bg-red-950/20'
                                    }`}
                                >
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <span
                                                className={`h-2.5 w-2.5 rounded-full ${
                                                    isOk ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]' : 'bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.8)]'
                                                }`}
                                            />
                                            <span className="font-display text-xs font-bold text-ink-100">{p.name}</span>
                                        </div>
                                        <span
                                            className={`rounded-full px-2 py-0.5 text-[10px] font-mono font-bold tracking-wide ${
                                                isOk
                                                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                                    : 'bg-red-500/20 text-red-300 border border-red-500/30'
                                            }`}
                                        >
                                            {isOk ? 'OK' : 'ERROR'}
                                        </span>
                                    </div>

                                    <p className="mt-1 text-[11px] text-ink-400 leading-relaxed">{p.desc}</p>

                                    <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11px] font-mono">
                                        <span className="rounded bg-white/5 px-2 py-0.5 text-ink-300 border border-white/5">
                                            {p.latency}ms
                                        </span>
                                        {p.extra && (
                                            <span className="rounded bg-cyan-500/10 px-2 py-0.5 text-cyan-300 border border-cyan-500/20">
                                                {p.extra}
                                            </span>
                                        )}
                                    </div>

                                    {p.error && (
                                        <div className="mt-2.5 rounded-lg bg-black/40 border border-red-500/30 p-2 text-[11px] text-red-300 break-words leading-tight">
                                            <span className="font-semibold text-red-200">Chi tiết lỗi: </span>
                                            {p.error}
                                        </div>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                </div>
            )}
        </GlassCard>
    )
}
