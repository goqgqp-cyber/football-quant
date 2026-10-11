import { useMemo, useState } from 'react'
import type { MatchEventItem } from '../lib/types'

interface MatchEventsTimelineProps {
    events?: MatchEventItem[]
    homeTeam: string
    awayTeam: string
    periodScore?: { htHome?: number; htAway?: number; ftHome?: number; ftAway?: number }
    score?: { home: number; away: number }
}

type FilterType = 'all' | 'goals_cards'

export function MatchEventsTimeline({
    events = [],
    homeTeam,
    awayTeam,
    periodScore,
    score,
}: MatchEventsTimelineProps) {
    const [filter, setFilter] = useState<FilterType>('all')

    const filteredEvents = useMemo(() => {
        if (!events || events.length === 0) return []
        if (filter === 'goals_cards') {
            return events.filter((e) => e.type === 'goal' || e.type === 'card')
        }
        return events
    }, [events, filter])

    // Phân chia sự kiện trước và sau hiệp 1
    const firstHalfEvents = filteredEvents.filter((e) => e.time <= 45)
    const secondHalfEvents = filteredEvents.filter((e) => e.time > 45)

    const htScoreLabel =
        periodScore?.htHome !== undefined && periodScore?.htAway !== undefined
            ? `${periodScore.htHome} - ${periodScore.htAway}`
            : '—'

    const ftScoreLabel =
        score ? `${score.home} - ${score.away}` : '—'

    return (
        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 shadow-xl backdrop-blur-md">
            {/* Header & Filter Toggle */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
                <div className="flex items-center gap-2">
                    <span className="text-base font-bold text-white flex items-center gap-2">
                        <span>⏱️</span> Diễn biến sự kiện (Timeline)
                    </span>
                    <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] font-semibold text-slate-400">
                        {filteredEvents.length} sự kiện
                    </span>
                </div>

                <div className="flex items-center rounded-xl border border-white/10 bg-slate-950/60 p-1">
                    <button
                        onClick={() => setFilter('all')}
                        className={`rounded-lg px-3 py-1 text-xs font-semibold transition-all ${
                            filter === 'all'
                                ? 'bg-sky-500/20 text-sky-400 shadow-sm'
                                : 'text-slate-400 hover:text-slate-200'
                        }`}
                    >
                        Tất cả
                    </button>
                    <button
                        onClick={() => setFilter('goals_cards')}
                        className={`rounded-lg px-3 py-1 text-xs font-semibold transition-all ${
                            filter === 'goals_cards'
                                ? 'bg-sky-500/20 text-sky-400 shadow-sm'
                                : 'text-slate-400 hover:text-slate-200'
                        }`}
                    >
                        Chỉ bàn thắng & thẻ
                    </button>
                </div>
            </div>

            {/* Team Column Header Indicator */}
            <div className="mb-4 grid grid-cols-12 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                <div className="col-span-5 text-left text-sky-400 truncate">{homeTeam}</div>
                <div className="col-span-2 text-center text-slate-500">Phút</div>
                <div className="col-span-5 text-right text-amber-400 truncate">{awayTeam}</div>
            </div>

            {/* Timeline Spine Container */}
            <div className="relative py-2">
                {/* Center Spine Line */}
                <div className="absolute left-1/2 top-0 bottom-0 w-0.5 -translate-x-1/2 bg-gradient-to-b from-sky-500/20 via-slate-700/40 to-amber-500/20" />

                {filteredEvents.length === 0 ? (
                    <div className="py-8 text-center text-sm text-slate-400">
                        Chưa có sự kiện nào được ghi nhận cho trận đấu này.
                    </div>
                ) : (
                    <div className="space-y-4">
                        {/* 1st Half Events */}
                        {firstHalfEvents.map((evt, idx) => (
                            <TimelineRow key={`1h-${idx}`} evt={evt} />
                        ))}

                        {/* Half-Time Divider */}
                        <div className="relative z-10 flex items-center justify-center py-2">
                            <div className="rounded-full border border-white/10 bg-slate-800/90 px-4 py-1 text-xs font-bold text-slate-300 shadow-md backdrop-blur-md">
                                ⏸️ Nghỉ giữa hiệp · HT {htScoreLabel}
                            </div>
                        </div>

                        {/* 2nd Half Events */}
                        {secondHalfEvents.map((evt, idx) => (
                            <TimelineRow key={`2h-${idx}`} evt={evt} />
                        ))}

                        {/* Full-Time Divider if match has events past 85' or finished */}
                        <div className="relative z-10 flex items-center justify-center py-2">
                            <div className="rounded-full border border-white/10 bg-slate-800/90 px-4 py-1 text-xs font-bold text-slate-300 shadow-md backdrop-blur-md">
                                🏁 Kết thúc trận đấu · FT {ftScoreLabel}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}

function TimelineRow({ evt }: { evt: MatchEventItem }) {
    const isHome = evt.isHome
    const minuteDisplay = evt.addedTime ? `${evt.time}+${evt.addedTime}'` : `${evt.time}'`

    return (
        <div className="relative grid grid-cols-12 items-center gap-2">
            {/* Left Column (Home Event) */}
            <div className="col-span-5 flex justify-end">
                {isHome && <EventBadge evt={evt} isLeft={true} />}
            </div>

            {/* Center Minute Marker */}
            <div className="col-span-2 relative z-10 flex items-center justify-center">
                <div className="flex h-7 w-7 items-center justify-center rounded-full border border-white/20 bg-slate-900 font-mono text-[11px] font-black text-slate-200 shadow-md">
                    {minuteDisplay}
                </div>
            </div>

            {/* Right Column (Away Event) */}
            <div className="col-span-5 flex justify-start">
                {!isHome && <EventBadge evt={evt} isLeft={false} />}
            </div>
        </div>
    )
}

function EventBadge({ evt, isLeft }: { evt: MatchEventItem; isLeft: boolean }) {
    const alignClass = isLeft ? 'text-right items-end' : 'text-left items-start'

    // Goal
    if (evt.type === 'goal') {
        return (
            <div className={`flex flex-col ${alignClass} rounded-xl border border-emerald-500/30 bg-emerald-950/30 p-2 shadow-sm max-w-[95%]`}>
                <div className="flex items-center gap-1.5 font-bold text-emerald-400 text-xs">
                    <span>⚽</span>
                    <span>{evt.detail}</span>
                    {evt.score && (
                        <span className="rounded bg-emerald-500/20 px-1.5 py-0.2 font-mono font-black text-emerald-300 text-[11px]">
                            [{evt.score}]
                        </span>
                    )}
                </div>
                <div className="mt-0.5 text-xs font-semibold text-white">
                    {evt.player || 'Cầu thủ ghi bàn'}
                </div>
                {evt.assist && (
                    <div className="text-[11px] text-slate-400">
                        Kiến tạo: {evt.assist}
                    </div>
                )}
            </div>
        )
    }

    // Card
    if (evt.type === 'card') {
        const isRed = evt.detail.toLowerCase().includes('đỏ') || evt.detail.toLowerCase().includes('red')
        return (
            <div
                className={`flex flex-col ${alignClass} rounded-xl border ${
                    isRed ? 'border-rose-500/30 bg-rose-950/30 text-rose-300' : 'border-amber-500/30 bg-amber-950/30 text-amber-300'
                } p-2 shadow-sm max-w-[95%]`}
            >
                <div className="flex items-center gap-1.5 font-bold text-xs">
                    <span>{isRed ? '🟥' : '🟨'}</span>
                    <span>{evt.detail}</span>
                </div>
                <div className="mt-0.5 text-xs font-semibold text-white">
                    {evt.player || 'Cầu thủ'}
                </div>
                {evt.comments && (
                    <div className="text-[10px] text-slate-400">
                        {evt.comments}
                    </div>
                )}
            </div>
        )
    }

    // Substitution
    if (evt.type === 'subst') {
        return (
            <div className={`flex flex-col ${alignClass} rounded-xl border border-white/10 bg-slate-800/40 p-2 shadow-sm max-w-[95%]`}>
                <div className="flex items-center gap-1 font-bold text-[11px] text-slate-300">
                    <span>🔄</span> Thay người
                </div>
                {evt.playerIn && (
                    <div className="mt-0.5 flex items-center gap-1 text-[11px] font-semibold text-emerald-400">
                        <span>🟢 Vào:</span> <span className="truncate">{evt.playerIn}</span>
                    </div>
                )}
                {evt.playerOut && (
                    <div className="flex items-center gap-1 text-[11px] font-medium text-rose-400">
                        <span>🔴 Ra:</span> <span className="truncate">{evt.playerOut}</span>
                    </div>
                )}
                {!evt.playerIn && !evt.playerOut && evt.player && (
                    <div className="text-[11px] text-slate-300">{evt.player}</div>
                )}
            </div>
        )
    }

    // VAR Check
    if (evt.type === 'var') {
        return (
            <div className={`flex flex-col ${alignClass} rounded-xl border border-purple-500/30 bg-purple-950/30 p-2 shadow-sm max-w-[95%]`}>
                <div className="flex items-center gap-1.5 font-bold text-xs text-purple-300">
                    <span>🖥️</span> VAR Check
                </div>
                <div className="mt-0.5 text-xs text-slate-200">
                    {evt.detail}
                </div>
                {evt.comments && (
                    <div className="text-[10px] text-purple-400/80">
                        {evt.comments}
                    </div>
                )}
            </div>
        )
    }

    // Fallback / Other
    return (
        <div className={`flex flex-col ${alignClass} rounded-xl border border-white/10 bg-slate-800/30 p-2 max-w-[95%]`}>
            <div className="text-xs font-semibold text-slate-300">
                {evt.detail || evt.type}
            </div>
            {evt.player && <div className="text-[11px] text-slate-400">{evt.player}</div>}
        </div>
    )
}
