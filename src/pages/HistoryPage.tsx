import { useMemo, useState } from 'react'
import { GlassCard } from '../components/ui/GlassCard'
import { Button } from '../components/ui/Button'
import { TextInput } from '../components/ui/Field'
import { settlePick } from '../lib/settle'
import { MOCK_MATCH_DATA, MOCK_MATCH_INPUT, MOCK_ODDS } from '../lib/mock'
import { analyzeMatch } from '../lib/engine'
import type { ActualResult, SettledPick } from '../lib/types'

type Filter = 'all' | 'pending' | 'settled' | 'value'

/** Bản ghi lịch sử (G1: dựng từ dữ liệu giả). G2 sẽ đọc từ Upstash. */
interface HistoryItem {
    id: string
    home: string
    away: string
    league: string
    kickoff: string
    status: 'pending' | 'settled'
    result?: ActualResult
}

const OUTCOME_LABEL: Record<SettledPick['outcome'], string> = {
    win: 'Thắng',
    win_half: 'Thắng nửa',
    push: 'Hoàn',
    lose_half: 'Thua nửa',
    lose: 'Thua',
}

const OUTCOME_CLASS: Record<SettledPick['outcome'], string> = {
    win: 'text-value-400',
    win_half: 'text-value-400',
    push: 'text-ink-300',
    lose_half: 'text-warn-400',
    lose: 'text-danger-400',
}

export function HistoryPage() {
    const [items, setItems] = useState<HistoryItem[]>([
        {
            id: 'demo-1',
            home: MOCK_MATCH_INPUT.homeTeam,
            away: MOCK_MATCH_INPUT.awayTeam,
            league: MOCK_MATCH_INPUT.league,
            kickoff: MOCK_MATCH_INPUT.kickoff,
            status: 'pending',
        },
    ])
    const [filter, setFilter] = useState<Filter>('all')

    const analysis = useMemo(
        () => analyzeMatch(MOCK_MATCH_DATA, MOCK_ODDS, MOCK_MATCH_INPUT.lg_home, MOCK_MATCH_INPUT.lg_away),
        [],
    )

    const filtered = items.filter((it) => {
        if (filter === 'all') return true
        if (filter === 'pending') return it.status === 'pending'
        if (filter === 'settled') return it.status === 'settled'
        return true
    })

    const enterResult = (id: string, r: ActualResult) => {
        setItems((prev) => prev.map((it) => (it.id === id ? { ...it, status: 'settled', result: r } : it)))
    }

    return (
        <div className="flex flex-col gap-5">
            <GlassCard>
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="font-display text-sm font-bold text-ink-100">Bộ lọc</p>
                    <div className="flex flex-wrap gap-2">
                        {(['all', 'pending', 'settled'] as Filter[]).map((f) => (
                            <Button
                                key={f}
                                variant={filter === f ? 'primary' : 'ghost'}
                                onClick={() => setFilter(f)}
                            >
                                {f === 'all' ? 'Tất cả' : f === 'pending' ? 'Chưa có kết quả' : 'Đã đối soát'}
                            </Button>
                        ))}
                    </div>
                </div>
            </GlassCard>

            {filtered.length === 0 && (
                <GlassCard>
                    <p className="text-sm text-ink-500">Không có bản ghi nào khớp bộ lọc.</p>
                </GlassCard>
            )}

            {filtered.map((it) => (
                <HistoryRow
                    key={it.id}
                    item={it}
                    picks={analysis.picks}
                    onSettle={(r) => enterResult(it.id, r)}
                />
            ))}
        </div>
    )
}

function HistoryRow({
    item,
    picks,
    onSettle,
}: {
    item: HistoryItem
    picks: ReturnType<typeof analyzeMatch>['picks']
    onSettle: (r: ActualResult) => void
}) {
    const [htHome, setHtHome] = useState('0')
    const [htAway, setHtAway] = useState('0')
    const [ftHome, setFtHome] = useState('')
    const [ftAway, setFtAway] = useState('')

    const settled: SettledPick[] | null = useMemo(() => {
        if (item.status !== 'settled' || !item.result) return null
        return picks.map((p) => settlePick(p, item.result as ActualResult, 'ft'))
    }, [item, picks])

    const totalProfit = settled ? settled.reduce((s, x) => s + x.profit, 0) : 0

    return (
        <GlassCard>
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                    <p className="font-display text-base font-bold text-ink-100">
                        {item.home} <span className="text-ink-500">vs</span> {item.away}
                    </p>
                    <p className="text-xs text-ink-500">
                        {item.league} · {new Date(item.kickoff).toLocaleString('vi-VN')}
                    </p>
                </div>
                <span
                    className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${item.status === 'settled'
                            ? 'border-value-400/40 bg-value-500/15 text-value-400'
                            : 'border-warn-400/40 bg-warn-500/15 text-warn-400'
                        }`}
                >
                    {item.status === 'settled' ? 'Đã đối soát' : 'Chưa có kết quả'}
                </span>
            </div>

            {item.status === 'pending' ? (
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div>
                        <p className="mb-1 text-xs text-ink-500">Hiệp 1 — nhà</p>
                        <TextInput value={htHome} onChange={(e) => setHtHome(e.target.value)} inputMode="numeric" />
                    </div>
                    <div>
                        <p className="mb-1 text-xs text-ink-500">Hiệp 1 — khách</p>
                        <TextInput value={htAway} onChange={(e) => setHtAway(e.target.value)} inputMode="numeric" />
                    </div>
                    <div>
                        <p className="mb-1 text-xs text-ink-500">Cả trận — nhà</p>
                        <TextInput value={ftHome} onChange={(e) => setFtHome(e.target.value)} inputMode="numeric" />
                    </div>
                    <div>
                        <p className="mb-1 text-xs text-ink-500">Cả trận — khách</p>
                        <TextInput value={ftAway} onChange={(e) => setFtAway(e.target.value)} inputMode="numeric" />
                    </div>
                    <div className="col-span-2 sm:col-span-4">
                        <Button
                            onClick={() =>
                                onSettle({
                                    htHome: Number(htHome) || 0,
                                    htAway: Number(htAway) || 0,
                                    ftHome: Number(ftHome) || 0,
                                    ftAway: Number(ftAway) || 0,
                                })
                            }
                            disabled={ftHome === '' || ftAway === ''}
                        >
                            Lưu kết quả & đối soát
                        </Button>
                    </div>
                </div>
            ) : (
                <>
                    <p className="mt-2 text-sm text-ink-300">
                        Kết quả: H1 {item.result?.htHome}-{item.result?.htAway} · FT {item.result?.ftHome}-
                        {item.result?.ftAway}
                    </p>
                    <div className="mt-3 overflow-x-auto rounded-xl border border-white/10">
                        <table className="min-w-full text-sm">
                            <thead className="bg-white/5 text-xs text-ink-500">
                                <tr>
                                    <th className="px-3 py-2 text-left">Kèo</th>
                                    <th className="px-3 py-2 text-left">Odds</th>
                                    <th className="px-3 py-2 text-left">Kết quả</th>
                                    <th className="px-3 py-2 text-right">Lợi nhuận (đv)</th>
                                </tr>
                            </thead>
                            <tbody>
                                {settled?.map((s) => (
                                    <tr key={s.pick.oddsLineId} className="border-t border-white/8">
                                        <td className="px-3 py-1.5">
                                            {s.pick.kind === 'totals' ? 'T/X' : 'AH'} {s.pick.side} {s.pick.line}
                                        </td>
                                        <td className="px-3 py-1.5">{s.pick.odds.toFixed(2)}</td>
                                        <td className={`px-3 py-1.5 font-semibold ${OUTCOME_CLASS[s.outcome]}`}>
                                            {OUTCOME_LABEL[s.outcome]}
                                        </td>
                                        <td className="px-3 py-1.5 text-right font-display">
                                            {s.profit >= 0 ? '+' : ''}
                                            {s.profit.toFixed(3)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot>
                                <tr className="border-t border-white/12">
                                    <td className="px-3 py-2 font-semibold" colSpan={3}>
                                        Tổng
                                    </td>
                                    <td className="px-3 py-2 text-right font-display font-bold text-value-400">
                                        {totalProfit >= 0 ? '+' : ''}
                                        {totalProfit.toFixed(3)}
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </>
            )}
        </GlassCard>
    )
}
