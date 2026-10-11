import { motion, useReducedMotion } from 'framer-motion'

interface FieldProps {
    label: string
    children: React.ReactNode
    hint?: string
}

/** Nhãn + input, hỗ trợ độ tương phản sắc nét WCAG AAA. */
export function Field({ label, children, hint }: FieldProps) {
    return (
        <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.12em] text-slate-200">
                {label}
            </span>
            {children}
            {hint && <span className="mt-1 block text-xs text-slate-400 font-medium">{hint}</span>}
        </label>
    )
}

const baseInput =
    'w-full rounded-xl border border-white/16 bg-neutral-900/90 px-3.5 py-2.5 text-sm text-white placeholder-slate-400 ' +
    'shadow-inner transition-colors focus:border-white/60 focus:bg-neutral-900 focus:outline-none focus:ring-1 focus:ring-white/40'

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
    return <input {...props} className={`${baseInput} ${props.className ?? ''}`} />
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
    return (
        <select {...props} className={`${baseInput} ${props.className ?? ''}`}>
            {props.children}
        </select>
    )
}

/** Badge trạng thái kèo: value / trap / rejected có màu sắc sống động. */
export function StatusBadge({
    status,
    confidence,
}: {
    status: string
    confidence?: string
}) {
    const map: Record<string, string> = {
        value: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/40 shadow-xs shadow-emerald-500/10',
        trap: 'bg-amber-500/20 text-amber-300 border-amber-400/40 shadow-xs shadow-amber-500/10',
        rejected: 'bg-rose-500/20 text-rose-300 border-rose-400/40',
        no_bet: 'bg-slate-800 text-slate-300 border-white/20',
    }
    const label: Record<string, string> = {
        value: 'VALUE',
        trap: 'TRAP',
        rejected: 'Loại',
        no_bet: 'NO BET',
    }
    return (
        <span className="flex flex-wrap items-center gap-1.5">
            <motion.span
                initial={{ scale: 0.85, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] font-bold tracking-[0.12em] ${map[status] ?? map.rejected}`}
            >
                {label[status] ?? status}
            </motion.span>
            {confidence && (
                <span className="rounded-full border border-white/16 bg-neutral-800/80 px-2 py-0.5 text-[11px] font-medium text-slate-200">
                    {confidence === 'high' ? 'Tin cậy cao' : confidence === 'medium' ? 'TB' : 'Thấp'}
                </span>
            )}
        </span>
    )
}

export { useReducedMotion }
