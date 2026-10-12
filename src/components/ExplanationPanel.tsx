import { AnimatePresence, motion } from 'framer-motion'
import { GlassCard } from './ui/GlassCard'
import type { Explanation } from '../lib/types'

export const SPEC_NARRATIVE_TITLES = [
    '(1) Tóm tắt đối đầu (H2H)',
    '(2) Phong độ sân nhà của đội nhà',
    '(3) Phong độ sân khách của đội khách',
    '(4) Tin tức lực lượng và bối cảnh',
    '(5) Dữ liệu còn thiếu và mâu thuẫn nguồn',
    '(6) Dữ liệu gợi ý điều gì (Mô tả khách quan)',
    '(7) Kết luận đúng theo thuật toán định lượng',
    '(8) Rủi ro lớn nhất đối với kết luận',
    '(9) Danh sách nguồn dữ liệu',
] as const

const LEGACY_PART_TITLES = [
    '(1) Đối soát chỉ số',
    '(2) Chiến thuật & nhân sự',
    '(3) Đánh giá kèo & kịch bản thua',
    '(4) Tổng kết',
] as const

/**
 * Hiển thị 9 phần giải thích định lượng chuẩn (Spec Section 8).
 *
 * Mọi con số trong văn bản đã được engine tính sẵn và server thay token
 * `{{U..}}` trước khi gửi xuống; `verified` cho biết quét lại có còn số nào
 * không truy được về engine hay không. Nếu có số bịa, server tự động kích hoạt
 * mẫu chuẩn xác định và thông báo rõ ràng cho người dùng.
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
    const titles = explanation && explanation.parts.length === 9 ? SPEC_NARRATIVE_TITLES : (explanation && explanation.parts.length > 4 ? SPEC_NARRATIVE_TITLES.slice(0, explanation.parts.length) : LEGACY_PART_TITLES)

    return (
        <GlassCard>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-display text-sm font-bold text-ink-100">Báo cáo Phân tích Định lượng (Spec Section 8)</p>
                {explanation && (
                    <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${explanation.verified
                            ? 'bg-value-500/15 text-value-400'
                            : 'bg-warn-500/15 text-warn-400'
                            }`}
                        title={explanation.model}
                    >
                        {explanation.verified ? 'Số đã được kiểm chứng' : 'Mẫu chuẩn an toàn (Đã đối soát)'}
                    </span>
                )}
            </div>
            <p className="mt-1 text-xs text-ink-500">
                AI chỉ viết văn thuyết minh; toàn bộ xác suất, mốc cược và phân bổ vốn do thuật toán tính toán độc lập.
            </p>

            {error && <p className="mt-3 text-xs text-danger-400">{error}</p>}

            {loading && (
                <div className="mt-3 space-y-2" aria-busy>
                    {SPEC_NARRATIVE_TITLES.slice(0, 5).map((t) => (
                        <div key={t} className="animate-pulse">
                            <div className="h-3 w-48 rounded bg-white/8" />
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
                        {explanation.isFallbackTemplate && (
                            <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                                <strong>Lưu ý:</strong> Văn bản đã được tự động thay thế bằng mẫu chuẩn do phát hiện con số không có trong kết quả tính toán ({explanation.unverifiedNumbers.join(', ')}). Tất cả con số dưới đây đều lấy trực tiếp từ dữ liệu máy tính.
                            </div>
                        )}

                        {titles.map((title, i) => {
                            const body = explanation.parts[i]?.trim()
                            if (!body && i >= explanation.parts.length) return null
                            return (
                                <div key={title} className="rounded-lg bg-white/[0.02] p-2.5">
                                    <p className="text-xs font-semibold text-primary-300">{title}</p>
                                    <p className="mt-1 text-sm leading-relaxed text-ink-200">
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

                        {!explanation.verified && !explanation.isFallbackTemplate && explanation.unverifiedNumbers.length > 0 && (
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

