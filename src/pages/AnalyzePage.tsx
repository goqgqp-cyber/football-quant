import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { GlassCard } from '../components/ui/GlassCard'
import { Button } from '../components/ui/Button'
import { Field, TextInput } from '../components/ui/Field'
import { PickCard } from '../components/PickCard'
import { ProgressSteps, type Step } from '../components/ui/ProgressSteps'
import { Skeleton } from '../components/ui/RefractionFilter'
import { analyzeMatch } from '../lib/engine'
import { MOCK_MATCH_DATA, MOCK_MATCH_INPUT, MOCK_ODDS } from '../lib/mock'
import { useSettings } from '../hooks/useSettings'
import type { MatchData, MatchInput, OddsLine } from '../lib/types'

type AnalysisStepId = 'collect' | 'extract' | 'compute' | 'explain'

interface ConfirmRow {
    line: OddsLine
    note: string
}

/**
 * Trang Phân tích (G1): form nhập + ô upload ảnh (placeholder cho G3)
 * + bảng xác nhận số liệu giả + stream tiến trình giả + kết quả kèo.
 */
export function AnalyzePage() {
    const { settings } = useSettings()

    // ---- Nhập trận ----
    const [input, setInput] = useState<MatchInput>(MOCK_MATCH_INPUT)
    const [data, setData] = useState<MatchData>(MOCK_MATCH_DATA)
    const [oddsLines, setOddsLines] = useState<OddsLine[]>(MOCK_ODDS)
    const [bankroll, setBankroll] = useState(settings.bankroll)

    // ---- Ảnh (G3 placeholder) ----
    const [imagePreviews, setImagePreviews] = useState<string[]>([])
    const [confirmRows, setConfirmRows] = useState<ConfirmRow[] | null>(null)
    const [parseHint, setParseHint] = useState<string | null>(null)

    // ---- Stream + kết quả ----
    const [steps, setSteps] = useState<Step[]>([
        { id: 'collect', label: 'Đang tìm dữ liệu', status: 'pending' },
        { id: 'extract', label: 'Trích xuất số liệu', status: 'pending' },
        { id: 'compute', label: 'Tính xác suất (Poisson · Dixon-Coles)', status: 'pending' },
        { id: 'explain', label: 'Viết phân tích', status: 'pending' },
    ])
    const [running, setRunning] = useState(false)
    const [result, setResult] = useState<ReturnType<typeof analyzeMatch> | null>(null)

    const setStepStatus = (id: string, status: Step['status']) => {
        setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, status } : s)))
    }

    const resetSteps = () => {
        setSteps((prev) => prev.map((s) => ({ ...s, status: 'pending' as const })))
    }

    const runAnalysis = async () => {
        setRunning(true)
        resetSteps()
        setResult(null)

        const ids: AnalysisStepId[] = ['collect', 'extract', 'compute', 'explain']
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i]
            setStepStatus(id, 'active')
            // Giả lập streaming: mỗi bước 550ms (G4 sẽ thay bằng SSE thật)
            await new Promise<void>((r) => window.setTimeout(r, 550))
            setStepStatus(id, 'done')
        }

        const r = analyzeMatch(data, oddsLines, input.lg_home, input.lg_away)
        setResult(r)
        setRunning(false)
    }

    const handleFiles = (files: FileList | File[] | null) => {
        if (!files || files.length === 0) return
        const chosen = Array.from(files).slice(0, 4)
        const urls: string[] = []
        for (const f of chosen) {
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) {
                setParseHint('Chỉ nhận JPEG/PNG/WebP.')
                continue
            }
            if (f.size > 8 * 1024 * 1024) {
                setParseHint('Mỗi ảnh tối đa 8 MB.')
                continue
            }
            urls.push(URL.createObjectURL(f))
        }
        setImagePreviews(urls)
        // Giả lập số liệu trích từ ảnh (G3: Gemini đọc ảnh trả JSON + confidence)
        // Cho G1, ta hiển thị odds hiện tại như "đọc được", người dùng sửa rồi xác nhận.
        setConfirmRows(
            oddsLines.map((l) => ({
                line: { ...l },
                note: 'Giả lập (G3 thay bằng Gemini đọc ảnh)',
            })),
        )
        setParseHint(null)
    }

    const valuePicks = useMemo(
        () => (result ? result.picks.filter((p) => p.status === 'value') : []),
        [result],
    )

    return (
        <div className="flex flex-col gap-5">
            {/* Form nhập trận */}
            <GlassCard>
                <p className="mb-3 font-display text-sm font-bold tracking-wide text-ink-100">Trận đấu</p>
                <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Đội nhà">
                        <TextInput
                            value={input.homeTeam}
                            onChange={(e) => setInput((p) => ({ ...p, homeTeam: e.target.value }))}
                            placeholder="Ví dụ: Man City"
                        />
                    </Field>
                    <Field label="Đội khách">
                        <TextInput
                            value={input.awayTeam}
                            onChange={(e) => setInput((p) => ({ ...p, awayTeam: e.target.value }))}
                            placeholder="Ví dụ: Liverpool"
                        />
                    </Field>
                    <Field label="Giải đấu">
                        <TextInput
                            value={input.league}
                            onChange={(e) => setInput((p) => ({ ...p, league: e.target.value }))}
                            placeholder="Premier League"
                        />
                    </Field>
                    <Field label="Giờ đá (ISO)">
                        <TextInput
                            type="datetime-local"
                            value={input.kickoff.slice(0, 16)}
                            onChange={(e) =>
                                setInput((p) => ({ ...p, kickoff: new Date(e.target.value).toISOString() }))
                            }
                        />
                    </Field>
                </div>
                <details className="mt-3">
                    <summary className="cursor-pointer text-sm text-violet-400">Tham số giải (nâng cao)</summary>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                        <Field label="lg_home">
                            <TextInput
                                type="number"
                                step={0.05}
                                value={String(input.lg_home ?? 1.45)}
                                onChange={(e) =>
                                    setInput((p) => ({ ...p, lg_home: Number(e.target.value) || 1.45 }))
                                }
                            />
                        </Field>
                        <Field label="lg_away">
                            <TextInput
                                type="number"
                                step={0.05}
                                value={String(input.lg_away ?? 1.15)}
                                onChange={(e) =>
                                    setInput((p) => ({ ...p, lg_away: Number(e.target.value) || 1.15 }))
                                }
                            />
                        </Field>
                    </div>
                </details>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <Field label="Tổng vốn (để quy ra số tiền)" hint="Dùng cho hiển thị, không gửi server">
                        <TextInput
                            type="number"
                            inputMode="numeric"
                            value={String(bankroll)}
                            onChange={(e) => setBankroll(Number(e.target.value) || 0)}
                        />
                    </Field>
                    <Field label="Nguồn (giả)">
                        <TextInput
                            value={`${data.sources.length} nguồn`}
                            readOnly
                            className="!bg-white/5"
                        />
                    </Field>
                    <Field label="λ (sẽ tính sau khi chạy)">
                        <TextInput
                            value={result ? `λH=${result.lambdaHome.toFixed(2)} · λA=${result.lambdaAway.toFixed(2)}` : '—'}
                            readOnly
                            className="!bg-white/5"
                        />
                    </Field>
                </div>
            </GlassCard>

            {/* Số liệu nền tảng (mock) */}
            <GlassCard>
                <div className="flex items-center justify-between gap-2">
                    <p className="font-display text-sm font-bold text-ink-100">Số liệu nền tảng (giả lập)</p>
                    <button
                        className="text-xs text-violet-400 hover:text-violet-300"
                        onClick={() => setData(MOCK_MATCH_DATA)}
                    >
                        Nạp lại dữ liệu mẫu
                    </button>
                </div>
                <p className="mt-1 text-xs text-ink-500">
                    G4 sẽ thay bằng Gemini + Google Search grounding, kèm nguồn và thời điểm.
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <TeamBox label={`Chủ nhà: ${input.homeTeam}`} team={data.home} />
                    <TeamBox label={`Khách: ${input.awayTeam}`} team={data.away} />
                </div>
                {data.missing.length > 0 && (
                    <p className="mt-2 text-xs text-warn-400">Thiếu: {data.missing.join(', ')}</p>
                )}
                {data.conflicts.length > 0 && (
                    <p className="mt-1 text-xs text-danger-400">Mâu thuẫn: {data.conflicts.join(' · ')}</p>
                )}
            </GlassCard>

            {/* Upload ảnh (G3 placeholder) */}
            <GlassCard>
                <div className="flex items-center justify-between gap-2">
                    <p className="font-display text-sm font-bold text-ink-100">Upload ảnhodds</p>
                    <span className="text-xs text-ink-500">Tối đa 4 ảnh · JPEG/PNG/WebP · 8 MB/ảnh</span>
                </div>
                <div
                    className="mt-3 grid place-items-center rounded-xl border border-dashed border-white/15 bg-white/5 px-4 py-8 text-center"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                        e.preventDefault()
                        handleFiles(e.dataTransfer.files)
                    }}
                >
                    <p className="text-sm text-ink-300">
                        Kéo-thả ảnh vào đây, hoặc dán ảnh từ clipboard (Ctrl+V), hoặc chọn file.
                    </p>
                    <label className="mt-3 inline-flex cursor-pointer rounded-xl bg-violet-500 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-600">
                        Chọn ảnh
                        <input
                            type="file"
                            multiple
                            accept="image/jpeg,image/png,image/webp"
                            className="hidden"
                            onChange={(e) => handleFiles(e.target.files)}
                        />
                    </label>
                    {parseHint && <p className="mt-2 text-xs text-danger-400">{parseHint}</p>}
                </div>
                {imagePreviews.length > 0 && (
                    <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                        {imagePreviews.map((src, i) => (
                            <img
                                key={i}
                                src={src}
                                alt={`Ảnh ${i + 1}`}
                                className="h-28 w-full rounded-xl object-cover"
                            />
                        ))}
                    </div>
                )}
            </GlassCard>

            {/* Bảng xác nhận số liệu từ ảnh */}
            {confirmRows && (
                <GlassCard>
                    <div className="flex items-center justify-between gap-2">
                        <p className="font-display text-sm font-bold text-ink-100">
                            Xác nhận số liệu Gemini đọc được (G1: giả lập)
                        </p>
                        <span className="rounded-full bg-warn-500/15 px-2 py-1 text-[11px] font-semibold text-warn-400">
                            Xác nhận trước khi tính — bắt buộc
                        </span>
                    </div>
                    <p className="mt-1 text-xs text-ink-500">
                        G3 sẽ trích odds/xG/đội hình từ ảnh. G1 hiển thị odds hiện tại để bạn làm quen luồng sửa → xác nhận.
                    </p>
                    <div className="mt-3 overflow-x-auto rounded-xl border border-white/10">
                        <table className="min-w-full text-sm">
                            <thead className="bg-white/5 text-xs text-ink-500">
                                <tr>
                                    <th className="px-3 py-2 text-left">Loại</th>
                                    <th className="px-3 py-2 text-left">Bên</th>
                                    <th className="px-3 py-2 text-left">Mốc</th>
                                    <th className="px-3 py-2 text-left">Odds</th>
                                    <th className="px-3 py-2 text-left">Ghi chú</th>
                                </tr>
                            </thead>
                            <tbody>
                                {confirmRows.map((r, idx) => (
                                    <tr key={r.line.id} className="border-t border-white/8">
                                        <td className="px-3 py-1.5">{r.line.kind === 'totals' ? 'Tài/Xỉu' : 'Chấp'}</td>
                                        <td className="px-3 py-1.5">
                                            <TextInput
                                                value={r.line.side}
                                                onChange={(e) =>
                                                    setConfirmRows((prev) =>
                                                        prev ? prev.map((x, j) => (j === idx ? { ...x, line: { ...x.line, side: e.target.value as never } } : x)) : prev,
                                                    )
                                                }
                                                className="!py-1.5"
                                            />
                                        </td>
                                        <td className="px-3 py-1.5">
                                            <TextInput
                                                type="number"
                                                step={0.25}
                                                value={String(r.line.line)}
                                                onChange={(e) =>
                                                    setConfirmRows((prev) =>
                                                        prev ? prev.map((x, j) => (j === idx ? { ...x, line: { ...x.line, line: Number(e.target.value) } } : x)) : prev,
                                                    )
                                                }
                                                className="!py-1.5"
                                            />
                                        </td>
                                        <td className="px-3 py-1.5">
                                            <TextInput
                                                type="number"
                                                step={0.05}
                                                value={String(r.line.odds)}
                                                onChange={(e) =>
                                                    setConfirmRows((prev) =>
                                                        prev ? prev.map((x, j) => (j === idx ? { ...x, line: { ...x.line, odds: Number(e.target.value) } } : x)) : prev,
                                                    )
                                                }
                                                className="!py-1.5"
                                            />
                                        </td>
                                        <td className="px-3 py-1.5 text-xs text-ink-500">{r.note}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="mt-3 flex gap-2">
                        <Button
                            onClick={() => {
                                if (confirmRows) setOddsLines(confirmRows.map((r) => r.line))
                            }}
                        >
                            Xác nhận và đưa vào tính
                        </Button>
                        <Button variant="ghost" onClick={() => setConfirmRows(null)}>
                            Hủy
                        </Button>
                    </div>
                </GlassCard>
            )}

            {/* Danh sách odds hiện tại */}
            <GlassCard>
                <div className="flex items-center justify-between gap-2">
                    <p className="font-display text-sm font-bold text-ink-100">Kèo đã nhập</p>
                    <Button
                        variant="ghost"
                        onClick={() => {
                            const id = `x-${Date.now()}`
                            setOddsLines((prev) => [...prev, { id, kind: 'totals', side: 'over', line: 2.5, odds: 1.95 }])
                        }}
                    >
                        + Thêm kèo
                    </Button>
                </div>
                {oddsLines.length === 0 ? (
                    <p className="mt-2 text-sm text-ink-500">Chưa có kèo nào.</p>
                ) : (
                    <div className="mt-3 overflow-x-auto rounded-xl border border-white/10">
                        <table className="min-w-full text-sm">
                            <thead className="bg-white/5 text-xs text-ink-500">
                                <tr>
                                    <th className="px-3 py-2 text-left">Loại</th>
                                    <th className="px-3 py-2 text-left">Bên</th>
                                    <th className="px-3 py-2 text-left">Mốc</th>
                                    <th className="px-3 py-2 text-left">Odds</th>
                                    <th className="px-3 py-2">Xóa</th>
                                </tr>
                            </thead>
                            <tbody>
                                {oddsLines.map((o) => (
                                    <tr key={o.id} className="border-t border-white/8">
                                        <td className="px-3 py-1.5">{o.kind === 'totals' ? 'Tài/Xỉu' : 'Chấp'}</td>
                                        <td className="px-3 py-1.5">{o.side}</td>
                                        <td className="px-3 py-1.5">{o.line}</td>
                                        <td className="px-3 py-1.5">{o.odds.toFixed(2)}</td>
                                        <td className="px-3 py-1.5 text-center">
                                            <button
                                                className="text-danger-400 hover:text-danger-300"
                                                onClick={() => setOddsLines((prev) => prev.filter((x) => x.id !== o.id))}
                                            >
                                                ×
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                <div className="mt-4">
                    <Button onClick={runAnalysis} disabled={running || oddsLines.length === 0}>
                        {running ? 'Đang phân tích…' : 'Phân tích ngay'}
                    </Button>
                </div>
            </GlassCard>

            {/* Stream tiến trình (mỗi lần chạy phân tích đều hiển thị, không màn hình trống) */}
            {(running || result) && (
                <GlassCard>
                    <p className="font-display text-sm font-bold text-ink-100">Tiến trình phân tích</p>
                    <div className="mt-3">
                        {running ? (
                            <ProgressSteps steps={steps} />
                        ) : (
                            <div className="flex items-center gap-2 text-sm text-value-400">
                                <span>✓</span> Hoàn tất ({steps.filter((s) => s.status === 'done').length}/{steps.length} bước)
                            </div>
                        )}
                    </div>
                </GlassCard>
            )}

            {/* Kết quả */}
            {running && !result && (
                <div className="grid gap-3 sm:grid-cols-2">
                    <Skeleton className="h-36" />
                    <Skeleton className="h-36" />
                </div>
            )}

            {result && (
                <>
                    {result.noBet ? (
                        <GlassCard>
                            <p className="font-display text-2xl font-black tracking-tight text-ink-100">NO BET</p>
                            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-300">
                                {result.noBetReasons.map((r, i) => (
                                    <li key={i}>{r}</li>
                                ))}
                            </ul>
                        </GlassCard>
                    ) : (
                        <div className="grid gap-3 md:grid-cols-2">
                            {valuePicks.map((pick, i) => (
                                <PickCard key={pick.oddsLineId} pick={pick} bankroll={bankroll} index={i} />
                            ))}
                        </div>
                    )}

                    {/* Top tỉ số Poisson */}
                    <GlassCard>
                        <p className="font-display text-sm font-bold text-ink-100">Tỉ số khả dĩ nhất (Poisson 0..10)</p>
                        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                            {result.topScorelines.map((s) => (
                                <div key={s.score} className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-center">
                                    <p className="font-display text-lg font-bold text-ink-100">{s.score}</p>
                                    <p className="text-xs text-ink-500">{(s.p * 100).toFixed(2)}%</p>
                                </div>
                            ))}
                        </div>
                        {result.picks.length > 0 && (
                            <>
                                <p className="mt-4 font-display text-sm font-bold text-ink-100">Toàn bộ kèo</p>
                                <div className="mt-2 grid gap-3 md:grid-cols-2">
                                    {result.picks.map((p, i) => (
                                        <PickCard key={p.oddsLineId} pick={p} bankroll={bankroll} index={i} />
                                    ))}
                                </div>
                            </>
                        )}
                        <p className="mt-4 text-xs text-ink-500">
                            λ nhà = {result.lambdaHome.toFixed(2)} · λ khách = {result.lambdaAway.toFixed(2)} · rho = -0.08
                        </p>
                    </GlassCard>

                    {/* 4 phần giải thích — placeholder cho Bước C (Gemini sẽ viết) */}
                    <GlassCard>
                        <p className="font-display text-sm font-bold text-ink-100">Giải thích (G5: Gemini — hiện tại là mẫu cục bộ)</p>
                        <AnimatePresence>
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                className="mt-3 space-y-3 text-sm leading-relaxed text-ink-300"
                            >
                                <p>
                                    <span className="font-semibold text-ink-100">(1) Đối soát chỉ số:</span> chênh lệch tấn công/thủ dựa trên
                                    shr(x,n) và Dixon-Coles. Dữ liệu giả — chưa phải dữ liệu thật từ web.
                                </p>
                                <p>
                                    <span className="font-semibold text-ink-100">(2) Chiến thuật &amp; nhân sự:</span> G4/G5 sẽ trích đội hình
                                    dự kiến và chấn thương từ web/ảnh; G1 để trống.
                                </p>
                                <p>
                                    <span className="font-semibold text-ink-100">(3) Đánh giá từng kèo &amp; kịch bản thua:</span> xem bảng
                                    trên; kèo 1/4 được chia đôi tiền vào 2 mốc kề nhau.
                                </p>
                                <p>
                                    <span className="font-semibold text-ink-100">(4) Tổng kết:</span>{' '}
                                    {valuePicks.length === 0
                                        ? 'NO BET — không kèo nào đủ Edge/EV và lệch mô hình chấp nhận được.'
                                        : `${valuePicks.length} kèo VALUE đạt chuẩn; top tỉ số ${result.topScorelines[0].score}.`}
                                </p>
                            </motion.div>
                        </AnimatePresence>
                    </GlassCard>
                </>
            )}
        </div>
    )
}

function TeamBox({ label, team }: { label: string; team: MatchData['home'] }) {
    return (
        <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <p className="text-sm font-semibold text-ink-100">{label}</p>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <div>
                    <p className="text-ink-500">xGF</p>
                    <p className="font-display font-semibold text-ink-100">{team.xgf ?? '—'}</p>
                </div>
                <div>
                    <p className="text-ink-500">xGA</p>
                    <p className="font-display font-semibold text-ink-100">{team.xga ?? '—'}</p>
                </div>
                <div>
                    <p className="text-ink-500">Ghi / trận</p>
                    <p className="font-display font-semibold text-ink-100">{team.goals_for ?? '—'}</p>
                </div>
                <div>
                    <p className="text-ink-500">Thủng / trận</p>
                    <p className="font-display font-semibold text-ink-100">{team.goals_against ?? '—'}</p>
                </div>
            </div>
            <p className="mt-2 text-xs text-ink-500">
                Mẫu: {team.n} trận · chấn thương: {team.injuries.length ? team.injuries.join(', ') : 'không có'} ·{' '}
                {team.lineup_confirmed ? 'đội hình xác nhận' : 'chưa xác nhận đội hình'}
            </p>
        </div>
    )
}
