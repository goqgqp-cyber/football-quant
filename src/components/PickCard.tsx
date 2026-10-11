import { motion } from 'framer-motion'
import type { Pick } from '../lib/types'
import { GlassCard } from './ui/GlassCard'
import { AnimatedNumber } from './ui/AnimatedNumber'
import { StatusBadge } from './ui/Field'

const SIDE_LABEL: Record<string, string> = {
    over: 'Tài',
    under: 'Xỉu',
    home: 'Đội nhà',
    away: 'Đội khách',
}

const FLAG_LABEL: Record<string, string> = {
    odds_below_min: 'Odds < 1.50',
    edge_below_min: 'Edge < 5%',
    ev_non_positive: 'EV ≤ 0',
    model_disagreement: 'Mô hình lệch thị trường > 15 điểm %',
    trap_high_odds_negative_edge: 'Cảnh báo TRAP: odds cao nhưng Edge âm',
}

function marketLabel(p: Pick): string {
    const kind = p.kind === 'totals' ? 'Tài/Xỉu' : 'Chấp châu Á'
    return `${kind} · ${SIDE_LABEL[p.side] ?? p.side} ${p.line > 0 ? '+' : ''}${p.line}`
}

/** Thẻ một kèo: tỉ lệ thắng, P_implied, Edge, EV, tin cậy, vốn. */
export function PickCard({
    pick,
    bankroll,
    index = 0,
}: {
    pick: Pick
    bankroll: number
    index?: number
}) {
    const stakeAmount = bankroll * pick.stakePct
    const isValue = pick.status === 'value'

    return (
        <GlassCard
            interactive
            className={`!p-4 ${isValue ? 'ring-1 ring-value-400/25' : ''}`}
        >
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05, type: 'spring', stiffness: 320, damping: 30 }}
            >
                <div className="flex items-start justify-between gap-2">
                    <div>
                        <p className="text-sm font-semibold text-ink-100">{marketLabel(pick)}</p>
                        <p className="mt-0.5 text-xs text-ink-500">
                            Odds <span className="font-display text-ink-300">{pick.odds.toFixed(2)}</span>
                        </p>
                    </div>
                    <StatusBadge status={pick.status} confidence={pick.confidence} />
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Metric
                        label="Tỉ lệ thắng"
                        value={pick.pWin * 100}
                        digits={1}
                        suffix="%"
                        tone="default"
                    />
                    <Metric
                        label="P_implied"
                        value={pick.pImplied * 100}
                        digits={1}
                        suffix="%"
                        tone="muted"
                    />
                    <Metric
                        label="Edge"
                        value={pick.edge * 100}
                        digits={1}
                        suffix="%"
                        tone={pick.edge >= 0.05 ? 'value' : 'muted'}
                    />
                    <Metric
                        label="EV / 1đv"
                        value={pick.ev}
                        digits={3}
                        tone={pick.ev > 0 ? 'value' : 'danger'}
                    />
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-500">
                    <span>
                        Hoàn:{' '}
                        <span className="font-display text-ink-300">{(pick.pPush * 100).toFixed(1)}%</span>
                    </span>
                    <span>
                        Thua:{' '}
                        <span className="font-display text-ink-300">{(pick.pLose * 100).toFixed(1)}%</span>
                    </span>
                    <span>
                        Lệch thị trường:{' '}
                        <span className="font-display text-ink-300">
                            {(pick.marketDelta * 100).toFixed(1)} điểm %
                        </span>
                    </span>
                </div>

                {pick.stakePct > 0 && (
                    <div className="mt-3 rounded-xl border border-value-400/25 bg-value-500/10 px-3 py-2 text-sm">
                        <span className="text-ink-300">Vốn đề xuất: </span>
                        <span className="font-display font-bold text-value-400">
                            {(pick.stakePct * 100).toFixed(2)}%
                        </span>
                        {bankroll > 0 && (
                            <>
                                <span className="text-ink-300"> ≈ </span>
                                <span className="font-display font-bold text-value-400">
                                    {stakeAmount.toLocaleString('vi-VN', { maximumFractionDigits: 0 })}
                                </span>
                            </>
                        )}
                    </div>
                )}

                {pick.flags.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                        {pick.flags.map((f) => (
                            <li
                                key={f}
                                className={`rounded-full border px-2 py-0.5 text-[11px] ${f === 'trap_high_odds_negative_edge'
                                        ? 'border-warn-400/40 bg-warn-500/15 text-warn-400'
                                        : 'border-white/12 bg-white/5 text-ink-500'
                                    }`}
                            >
                                {FLAG_LABEL[f] ?? f}
                            </li>
                        ))}
                    </ul>
                )}
            </motion.div>
        </GlassCard>
    )
}

function Metric({
    label,
    value,
    digits,
    suffix,
    tone,
}: {
    label: string
    value: number
    digits: number
    suffix?: string
    tone: 'default' | 'value' | 'danger' | 'muted'
}) {
    const color =
        tone === 'value'
            ? 'text-value-400'
            : tone === 'danger'
                ? 'text-danger-400'
                : tone === 'muted'
                    ? 'text-ink-300'
                    : 'text-ink-100'
    return (
        <div className="rounded-xl border border-white/8 bg-white/4 px-2.5 py-2">
            <p className="text-[10px] uppercase tracking-wider text-ink-500">{label}</p>
            <p className={`mt-0.5 text-lg font-bold ${color}`}>
                <AnimatedNumber value={value} digits={digits} suffix={suffix} />
            </p>
        </div>
    )
}
