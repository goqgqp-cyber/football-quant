import { motion } from 'framer-motion'

export type StepStatus = 'pending' | 'active' | 'done' | 'error'

export interface Step {
    id: string
    label: string
    status: StepStatus
}

/**
 * Thanh tiến trình các bước phân tích với hiệu ứng ánh sáng chạy ở bước active.
 */
export function ProgressSteps({ steps }: { steps: Step[] }) {
    const done = steps.filter((s) => s.status === 'done').length
    const pct = steps.length ? (done / steps.length) * 100 : 0

    return (
        <div className="w-full">
            <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-white/8">
                <motion.div
                    className="relative h-full overflow-hidden rounded-full bg-gradient-to-r from-violet-400 via-magenta-500 to-indigo-500 progress-sweep"
                    animate={{ width: `${pct}%` }}
                    transition={{ type: 'spring', stiffness: 120, damping: 24 }}
                />
            </div>
            <ol className="flex flex-col gap-2">
                {steps.map((s, i) => (
                    <motion.li
                        key={s.id}
                        initial={{ opacity: 0, x: -8 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: i * 0.04 }}
                        className="flex items-center gap-3 text-sm"
                    >
                        <span
                            className={[
                                'grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[11px]',
                                s.status === 'done'
                                    ? 'border-value-400/60 bg-value-500/20 text-value-400'
                                    : s.status === 'active'
                                        ? 'border-violet-400/70 bg-violet-500/25 text-violet-400'
                                        : s.status === 'error'
                                            ? 'border-danger-400/60 bg-danger-500/20 text-danger-400'
                                            : 'border-white/12 bg-white/5 text-ink-500',
                            ].join(' ')}
                        >
                            {s.status === 'done' ? '✓' : s.status === 'error' ? '!' : i + 1}
                        </span>
                        <span
                            className={
                                s.status === 'pending'
                                    ? 'text-ink-500'
                                    : s.status === 'error'
                                        ? 'text-danger-400'
                                        : 'text-ink-100'
                            }
                        >
                            {s.label}
                        </span>
                        {s.status === 'active' && (
                            <motion.span
                                className="ml-auto h-1.5 w-1.5 rounded-full bg-violet-400"
                                animate={{ opacity: [1, 0.2, 1] }}
                                transition={{ repeat: Infinity, duration: 1.1 }}
                            />
                        )}
                    </motion.li>
                ))}
            </ol>
        </div>
    )
}
