import { AnimatePresence, motion } from 'framer-motion'
import { GlassCard } from './ui/GlassCard'
import type { Explanation } from '../lib/types'

const PART_TITLES = [
    '(1) Đối soát chỉ số',
    '(2) Chiến thuật & nhân sự',
    '(3) Đánh giá kèo & kịch bản thua',
    '(4) Tổng kết',
] as const

/**
 * Hiển thị 4 phần giải thích do Gemini viết ở Bước C.
 *
 * Mọi con số trong văn bản đã được engine tính sẵn và server thay token
 * `{{U..}}` trước khi gửi xuống; `verified` cho biết quét lại có còn số nào
 * không truy được về engine hay không — hiển thị cảnh báo đỏ nếu có.
 */
export function ExplanationPanel({
    explanation,
    loading = false,
    error = null,
}: {
    explanation: Explanation | null
    loading?: boolean
    error?: string | null
}) {
    return (
        <GlassCard>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-display text-sm font-bold text-ink-100">Giải thích (Bước C)</p>
                {explanation && (
                    <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${explanation.verified
                            ? 'bg-value-500/15 text-value-400'
                            : 'bg-warn-500/15 text-warn-400'
                            }`}
                        title={explanation.model}
                    >
                        {explanation.verified ? 'Số đã được kiểm chứng' : 'Có số chưa khớp engine'}
                    </span>
                )}
            </div>
            <p className="mt-1 text-xs text-ink-500">
                AI chỉ viết văn; mọi con số đều do engine tính rồi chèn vào, sau đó server quét lại
                toàn bộ văn bản.
            </p>

            {error && <p className="mt-3 text-xs text-danger-400">{error}</p>}

            {loading && (
                <div className="mt-3 space-y-2" aria-busy>
                    {PART_TITLES.map((t) => (
                        <div key={t} className="animate-pulse">
                            <div className="h-3 w-40 rounded bg-white/8" />
                            <div className="mt-1.5 h-3 w-full rounded bg-white/5" />
                            <div className="mt-1 h-3 w-4/5 rounded bg-white/5" />
                        </div>
                    ))}
                </div>
            )}

            {!loading && explanation && (
                <AnimatePresence>
                    <motion.div
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.25 }}
                        className="mt-3 space-y-3"
                    >
                        {PART_TITLES.map((title, i) => {
                            const body = explanation.parts[i]?.trim()
                            return (
                                <div key={title}>
                                    <p className="text-sm font-semibold text-ink-100">{title}</p>
                                    <p className="mt-1 text-sm leading-relaxed text-ink-300">
                                        {body || <span className="text-ink-500">—</span>}
                                    </p>
                                </div>
                            )
                        })}

                        {explanation.caveats.length > 0 && (
                            <div className="rounded-xl border border-warn-400/30 bg-warn-500/10 px-3 py-2">
                                <p className="text-[11px] font-semibold uppercase tracking-wider text-warn-400">
                                    Lưu ý về dữ liệu
                                </p>
                                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-warn-400">
                                    {explanation.caveats.map((c, i) => (
                                        <li key={i}>{c}</li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {!explanation.verified && explanation.unverifiedNumbers.length > 0 && (
                            <div className="rounded-xl border border-danger-400/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-400">
                                Cảnh báo: văn bản có số không khớp số engine tính (
                                {explanation.unverifiedNumbers.join(', ')}). Hãy kiểm tra lại trước khi dùng.
                            </div>
                        )}
                    </motion.div>
                </AnimatePresence>
            )}

            {!loading && !explanation && !error && (
                <p className="mt-3 text-sm text-ink-500">Chưa có giải thích cho lượt phân tích này.</p>
            )}
        </GlassCard>
    )
}
