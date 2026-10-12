import { useState } from 'react'

interface MatchHeaderProps {
    homeTeam: string
    awayTeam: string
    homeLogo?: string
    awayLogo?: string
    score: { home: number; away: number }
    minute?: number | string
    periodScore?: { htHome?: number; htAway?: number; ftHome?: number; ftAway?: number }
    status?: 'notstarted' | 'inprogress' | 'finished'
    league?: string
    homeForm?: string[]
    awayForm?: string[]
}

function TeamLogo({ name, logoUrl, isHome }: { name: string; logoUrl?: string; isHome: boolean }) {
    const [failedUrl, setFailedUrl] = useState<string | null>(null)
    const initial = (name.trim()[0] || (isHome ? 'H' : 'A')).toUpperCase()
    const imgFailed = logoUrl ? failedUrl === logoUrl : true

    if (!logoUrl || imgFailed) {
        return (
            <div
                className={`flex h-12 w-12 md:h-14 md:w-14 shrink-0 items-center justify-center rounded-2xl border ${
                    isHome
                        ? 'border-sky-500/30 bg-gradient-to-br from-sky-500/20 to-sky-950/40 text-sky-300'
                        : 'border-amber-500/30 bg-gradient-to-br from-amber-500/20 to-amber-950/40 text-amber-300'
                } font-display text-lg font-black shadow-lg shadow-black/40`}
            >
                {initial}
            </div>
        )
    }

    return (
        <div className="relative flex h-12 w-12 md:h-14 md:w-14 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] p-1.5 shadow-lg shadow-black/40 backdrop-blur-sm">
            <img
                src={logoUrl}
                alt={name}
                referrerPolicy="no-referrer"
                onError={() => setFailedUrl(logoUrl)}
                className="h-full w-full object-contain filter drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]"
                loading="lazy"
            />
        </div>
    )
}

function FormBadgeList({ form, isHome }: { form?: string[]; isHome: boolean }) {
    if (!form || form.length === 0) return null
    const list = form.slice(-5)

    return (
        <div className={`flex items-center gap-1 ${isHome ? 'justify-start' : 'justify-end'}`}>
            <span className="text-[10px] font-medium text-slate-500 mr-0.5 hidden sm:inline">5 trận:</span>
            {list.map((res, i) => {
                const char = res.toUpperCase()
                if (char === 'W') {
                    return (
                        <span
                            key={i}
                            title="Thắng (Win)"
                            className="bg-emerald-600 text-white font-bold text-xs w-5 h-5 rounded-full flex items-center justify-center shadow-sm shadow-emerald-950"
                        >
                            W
                        </span>
                    )
                }
                if (char === 'D') {
                    return (
                        <span
                            key={i}
                            title="Hòa (Draw)"
                            className="bg-amber-500 text-white font-bold text-xs w-5 h-5 rounded-full flex items-center justify-center shadow-sm shadow-amber-950"
                        >
                            D
                        </span>
                    )
                }
                return (
                    <span
                        key={i}
                        title="Thua (Loss)"
                        className="bg-rose-600 text-white font-bold text-xs w-5 h-5 rounded-full flex items-center justify-center shadow-sm shadow-rose-950"
                    >
                        L
                    </span>
                )
            })}
        </div>
    )
}

export function MatchHeader({
    homeTeam,
    awayTeam,
    homeLogo,
    awayLogo,
    score,
    minute,
    periodScore,
    status,
    league,
    homeForm,
    awayForm,
}: MatchHeaderProps) {
    const minuteLabel = (() => {
        if (minute === 'FT' || status === 'finished') return 'Hết giờ (FT)'
        if (minute === 'HT') return 'Nghỉ giữa hiệp (HT)'
        if (typeof minute === 'number') {
            if (minute > 90 && minute <= 100) return `Phút 90+${minute - 90}'`
            if (minute > 100) return status === 'inprogress' ? `Phút ${minute}'` : 'Hết giờ (FT)'
            return `Phút ${minute}'`
        }
        if (typeof minute === 'string' && minute && minute !== '—') {
            const parsed = parseInt(minute.replace(/[^0-9]/g, ''), 10)
            if (!isNaN(parsed) && parsed > 100) {
                return status === 'inprogress' ? `Phút ${parsed}'` : 'Hết giờ (FT)'
            }
            return minute
        }
        return status === 'inprogress' ? 'Đang đá' : 'Chưa đấu'
    })()

    const htLabel =
        periodScore?.htHome !== undefined && periodScore?.htAway !== undefined
            ? `(HT ${periodScore.htHome} - ${periodScore.htAway})`
            : null

    return (
        <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-slate-900/90 via-slate-900/60 to-slate-950/90 p-4 shadow-xl backdrop-blur-md">
            {/* Background Glows */}
            <div className="pointer-events-none absolute -left-10 -top-10 h-36 w-36 rounded-full bg-sky-500/10 blur-3xl" />
            <div className="pointer-events-none absolute -right-10 -top-10 h-36 w-36 rounded-full bg-amber-500/10 blur-3xl" />

            {/* League Banner */}
            {league && (
                <div className="mb-3 flex items-center justify-center">
                    <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-0.5 text-[11px] font-semibold tracking-wider text-slate-300">
                        🏆 {league}
                    </span>
                </div>
            )}

            {/* Main Header Content */}
            <div className="grid grid-cols-12 items-center gap-2">
                {/* Home Team */}
                <div className="col-span-4 flex items-center gap-2 md:gap-3.5">
                    <TeamLogo name={homeTeam} logoUrl={homeLogo} isHome={true} />
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />
                            <h3 className="truncate font-display text-sm md:text-base font-bold text-white tracking-tight" title={homeTeam}>
                                {homeTeam}
                            </h3>
                        </div>
                        <div className="mt-1">
                            <FormBadgeList form={homeForm} isHome={true} />
                        </div>
                    </div>
                </div>

                {/* Score & Time Milestones */}
                <div className="col-span-4 flex flex-col items-center justify-center text-center">
                    <div className="flex items-baseline justify-center gap-2">
                        <span className="font-display text-3xl md:text-5xl font-black tracking-tight text-white tabular-nums drop-shadow">
                            {score.home}
                        </span>
                        <span className="text-xl md:text-2xl font-bold text-slate-600">–</span>
                        <span className="font-display text-3xl md:text-5xl font-black tracking-tight text-white tabular-nums drop-shadow">
                            {score.away}
                        </span>
                    </div>

                    {/* Minute & Halftime Score */}
                    <div className="mt-1.5 flex flex-wrap items-center justify-center gap-1.5 text-[11px]">
                        <span
                            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-bold ${
                                status === 'inprogress'
                                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                    : status === 'finished'
                                      ? 'bg-slate-800 text-slate-300 border border-white/10'
                                      : 'bg-white/5 text-slate-400 border border-white/10'
                            }`}
                        >
                            {status === 'inprogress' && (
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            )}
                            {minuteLabel}
                        </span>
                        {htLabel && (
                            <span className="text-slate-400 font-semibold tabular-nums">
                                {htLabel}
                            </span>
                        )}
                    </div>
                </div>

                {/* Away Team */}
                <div className="col-span-4 flex items-center justify-end gap-2 md:gap-3.5 text-right">
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-end gap-1.5">
                            <h3 className="truncate font-display text-sm md:text-base font-bold text-white tracking-tight" title={awayTeam}>
                                {awayTeam}
                            </h3>
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                        </div>
                        <div className="mt-1">
                            <FormBadgeList form={awayForm} isHome={false} />
                        </div>
                    </div>
                    <TeamLogo name={awayTeam} logoUrl={awayLogo} isHome={false} />
                </div>
            </div>
        </div>
    )
}
