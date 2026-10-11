import { motion, useReducedMotion } from 'framer-motion'

interface FieldProps {
    label: string
    children: React.ReactNode
    hint?: string
}

/** Nhãn + input, hỗ trợ độ tương phản WCAG AA. */
export function Field({ label, children, hint }: FieldProps) {
    return (
        <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-ink-300">
                {label}
            </span>
            {children}
            {hint && <span className="mt-1 block text-xs text-ink-500">{hint}</span>}
        </label>
    )
}

const baseInput =
    'w-full rounded-xl border border-white/12 bg-white/6 px-3 py-2.5 text-sm text-ink-100 placeholder-ink-500 ' +
    'backdrop-blur-md transition-colors focus:border-violet-400/70 focus:bg-white/8'

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

/** Badge trạng thái kèo: value / trap / rejected. */
export function StatusBadge({
    status,
    confidence,
}: {
    status: string
    confidence?: string
}) {
    const map: Record<string, string> = {
        value: 'bg-value-500/18 text-value-400 border-value-400/40',
        trap: 'bg-warn-500/18 text-warn-400 border-warn-400/40',
        rejected: 'bg-white/6 text-ink-500 border-white/12',
        no_bet: 'bg-white/6 text-ink-300 border-white/15',
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
                className={`rounded-full border px-2 py-0.5 text-[11px] font-bold tracking-wider ${map[status] ?? map.rejected}`}
            >
                {label[status] ?? status}
            </motion.span>
            {confidence && (
                <span className="rounded-full border border-white/12 bg-white/5 px-2 py-0.5 text-[11px] text-ink-300">
                    {confidence === 'high' ? 'Tin cậy cao' : confidence === 'medium' ? 'TB' : 'Thấp'}
                </span>
            )}
        </span>
    )
}

export { useReducedMotion }