import { useState } from 'react'
import { GlassCard } from './ui/GlassCard'
import { Button } from './ui/Button'
import type {
    ExternalCallLog,
    MatchData,
    AnalysisResult,
    ProviderStatusCode,
    ProviderSummary,
} from '../lib/types'

interface DataSourcePanelProps {
    data?: MatchData | null
    result?: AnalysisResult | null
    onForceRefresh?: () => void
    isRunning?: boolean
}

function formatHHMM(isoString?: string | null): string {
    if (!isoString) return '—'
    try {
        const d = new Date(isoString)
        if (isNaN(d.getTime())) return '—'
        const hh = String(d.getHours()).padStart(2, '0')
        const mm = String(d.getMinutes()).padStart(2, '0')
        return `${hh}:${mm}`
    } catch {
        return '—'
    }
}

function renderStatusBadge(status: ProviderStatusCode) {
    switch (status) {
        case 'OK':
            return (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    OK
                </span>
            )
        case 'EMPTY':
            return (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                    EMPTY
                </span>
            )
        case 'ERROR':
            return (
                <span className="inline-flex items-center gap-1 rounded-full border border-rose-400/30 bg-rose-500/10 px-2 py-0.5 text-[11px] font-semibold text-rose-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
                    ERROR
                </span>
            )
        case 'SKIPPED':
            return (
                <span className="inline-flex items-center gap-1 rounded-full border border-sky-400/30 bg-sky-500/10 px-2 py-0.5 text-[11px] font-semibold text-sky-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
                    SKIPPED (cache)
                </span>
            )
        case 'NOT_CALLED':
        default:
            return (
                <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] font-medium text-neutral-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-neutral-400" />
                    NOT CALLED
                </span>
            )
    }
}

export function DataSourcePanel({
    data,
    result,
    onForceRefresh,
    isRunning = false,
}: DataSourcePanelProps) {
    const [showDetails, setShowDetails] = useState(false)

    const providerSummaries: ProviderSummary[] =
        result?.providerSummaries ||
        data?.providerSummaries ||
        []

    const callLogs: ExternalCallLog[] =
        result?.callLogs ||
        data?.callLogs ||
        []

    const webSummary =
        result?.webSearchSummary ||
        data?.webSearchSummary

    const fetchedTimes = data?.fetchedAtTimes || {}

    // Tìm quota của API-Football nếu có
    const afSummary = providerSummaries.find((s) => s.provider === 'api-football')
    const afQuota = afSummary?.quotaInfo
    const isQuotaExhausted = afQuota?.remaining !== null && afQuota?.remaining !== undefined && afQuota.remaining <= 0

    return (
        <GlassCard className="border border-white/15 bg-neutral-900/60 p-4 shadow-lg">
            {/* Header: Tiêu đề + Nút Làm mới dữ liệu */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
                <div className="flex items-center gap-2">
                    <span className="text-base">📡</span>
                    <h3 className="font-display text-sm font-bold tracking-wide text-ink-100">
                        Nguồn dữ liệu & Đối soát minh bạch
                    </h3>
                </div>

                <div className="flex items-center gap-2">
                    {onForceRefresh && (
                        <Button
                            variant="ghost"
                            onClick={onForceRefresh}
                            disabled={isRunning}
                            className="!px-3 !py-1 text-xs border border-white/10 hover:border-white/20 text-neutral-200"
                        >
                            🔄 Làm mới dữ liệu
                        </Button>
                    )}
                </div>
            </div>

            {/* Cảnh báo Hết Quota nếu có */}
            {isQuotaExhausted && (
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-950/30 p-2.5 text-xs text-rose-300">
                    <span className="text-base">⚠️</span>
                    <span className="font-bold">Hết quota API-Football (0 requests remaining). Các truy vấn tới API-Football đã bị tạm dừng.</span>
                </div>
            )}

            {/* Dòng tóm tắt ngôn ngữ tự nhiên bắt buộc */}
            <div className="mt-3 rounded-lg border border-white/10 bg-black/30 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-white">
                        {webSummary?.text || 'Đang xác định trạng thái tìm kiếm web...'}
                    </p>
                    {afQuota?.remaining !== null && afQuota?.remaining !== undefined && (
                        <span className="rounded bg-white/5 px-2 py-0.5 font-mono text-[11px] text-neutral-400">
                            Quota API-Football: {afQuota.remaining}/{afQuota.limit ?? '—'}
                        </span>
                    )}
                </div>

                {/* Thời điểm lấy dữ liệu theo từng nhóm */}
                <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-neutral-400 border-t border-white/5 pt-2">
                    <span>
                        API-Football: <b className="text-neutral-200 font-medium">{formatHHMM(fetchedTimes.apiFootball)}</b>
                    </span>
                    <span>
                        Phong độ đội nhà: <b className="text-neutral-200 font-medium">{formatHHMM(fetchedTimes.homeForm)}</b>
                    </span>
                    <span>
                        Phong độ đội khách: <b className="text-neutral-200 font-medium">{formatHHMM(fetchedTimes.awayForm)}</b>
                    </span>
                    <span>
                        Đối đầu H2H: <b className="text-neutral-200 font-medium">{formatHHMM(fetchedTimes.h2h)}</b>
                    </span>
                </div>
            </div>

            {/* Bảng nhà cung cấp (API-Football, Brave, Tavily, Qwen) */}
            <div className="mt-3 space-y-2">
                {['api-football', 'brave', 'tavily', 'qwen'].map((pKey) => {
                    const item = providerSummaries.find((s) => s.provider === pKey) || {
                        provider: pKey as ProviderSummary['provider'],
                        status: 'NOT_CALLED' as ProviderStatusCode,
                        summary: 'Không được gọi',
                        resultCount: 0,
                        queryCount: 0,
                    }

                    const displayName =
                        pKey === 'api-football'
                            ? 'API-Football'
                            : pKey === 'brave'
                              ? 'Brave Search'
                              : pKey === 'tavily'
                                ? 'Tavily Search'
                                : 'Qwen Quantitative AI'

                    return (
                        <div
                            key={pKey}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/5 bg-white/[0.02] p-2.5 text-xs hover:bg-white/[0.04] transition"
                        >
                            <div className="flex items-center gap-2.5 min-w-[140px]">
                                <span className="font-semibold text-neutral-200">{displayName}</span>
                                {renderStatusBadge(item.status)}
                            </div>

                            <div className="flex items-center gap-3 text-neutral-400 text-right">
                                <span className="text-[11px]">{item.summary}</span>
                                {item.errorMessage && item.status === 'ERROR' && (
                                    <span className="max-w-[200px] truncate text-[10px] text-rose-400" title={item.errorMessage}>
                                        ({item.errorMessage})
                                    </span>
                                )}
                            </div>
                        </div>
                    )
                })}
            </div>

            {/* Expandable Accordion: Chi tiết truy vấn và URL thực tế */}
            <div className="mt-3 border-t border-white/10 pt-2">
                <button
                    type="button"
                    onClick={() => setShowDetails((p) => !p)}
                    className="flex w-full items-center justify-between text-xs font-semibold text-neutral-400 hover:text-white transition py-1"
                >
                    <span>
                        🔍 Danh sách chi tiết các cuộc gọi external ({callLogs.length})
                    </span>
                    <span className="text-xs">{showDetails ? '▲ Thu gọn' : '▼ Mở rộng'}</span>
                </button>

                {showDetails && (
                    <div className="mt-2.5 max-h-60 space-y-2 overflow-y-auto rounded-lg border border-white/10 bg-black/40 p-2.5">
                        {callLogs.length === 0 ? (
                            <p className="text-center text-xs text-neutral-500 py-2">
                                Chưa có nhật ký cuộc gọi external nào được ghi nhận.
                            </p>
                        ) : (
                            callLogs.map((log, idx) => (
                                <div
                                    key={idx}
                                    className="rounded border border-white/5 bg-neutral-900/50 p-2 text-[11px] space-y-1 font-mono"
                                >
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div className="flex items-center gap-1.5">
                                            <span className="rounded bg-sky-950/60 border border-sky-500/30 px-1.5 py-0.2 text-[10px] font-bold text-sky-400 uppercase">
                                                {log.provider}
                                            </span>
                                            <span className="text-neutral-300 font-sans font-medium">{log.purpose}</span>
                                        </div>
                                        <div className="flex items-center gap-2 text-[10px] text-neutral-400">
                                            {log.servedFromCache && (
                                                <span className="text-sky-300 font-sans">[Từ Cache]</span>
                                            )}
                                            <span>{log.durationMs}ms</span>
                                            <span>HTTP {log.httpStatus ?? '—'}</span>
                                            <span className="text-emerald-400">{log.resultCount} kết quả</span>
                                        </div>
                                    </div>
                                    <p className="truncate text-neutral-400" title={log.requestSummary}>
                                        {log.requestSummary}
                                    </p>
                                    {log.errorMessage && (
                                        <p className="text-rose-400 text-[10px] truncate" title={log.errorMessage}>
                                            Lỗi: {log.errorMessage}
                                        </p>
                                    )}
                                </div>
                            ))
                        )}

                        {/* Danh sách các trang web / URL đã đọc và ngày tìm thấy */}
                        {data?.sources && data.sources.length > 0 && (
                            <div className="mt-3 border-t border-white/10 pt-2 font-sans">
                                <p className="text-[11px] font-semibold text-neutral-300 mb-1.5">
                                    📄 Danh sách trang web / nguồn tin đã đối soát ({data.sources.length}):
                                </p>
                                <div className="space-y-1.5 font-mono">
                                    {data.sources.map((s, sIdx) => (
                                        <div key={sIdx} className="rounded border border-white/5 bg-neutral-900/60 p-2 text-[11px]">
                                            <div className="flex items-center justify-between gap-2">
                                                <span className="truncate font-sans font-medium text-neutral-200" title={s.title}>
                                                    {s.title}
                                                </span>
                                                <span className="shrink-0 text-[10px] text-neutral-400 font-sans">
                                                    Ngày/giờ: {new Date(s.fetched_at).toLocaleDateString('vi-VN')} {formatHHMM(s.fetched_at)}
                                                </span>
                                            </div>
                                            <a
                                                href={s.url}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="truncate text-[10px] text-cyan-400 hover:underline block mt-1"
                                                title={s.url}
                                            >
                                                {s.url}
                                            </a>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </GlassCard>
    )
}
