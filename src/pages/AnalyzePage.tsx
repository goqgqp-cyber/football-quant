import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GlassCard } from '../components/ui/GlassCard'
import { Button } from '../components/ui/Button'
import { Field, TextInput } from '../components/ui/Field'
import { PickCard } from '../components/PickCard'
import { ExplanationPanel } from '../components/ExplanationPanel'
import { ProgressSteps, type Step } from '../components/ui/ProgressSteps'
import { Skeleton } from '../components/ui/RefractionFilter'
import { ApiError, api, collectStream, type ExtractedRow } from '../lib/api'
import { MOCK_MATCH_DATA, MOCK_MATCH_INPUT, MOCK_ODDS } from '../lib/mock'
import { useSettings } from '../hooks/useSettings'
import { LiveMatchTracker } from '../components/LiveMatchTracker'
import { filterRecommendedPicks } from '../lib/engine'
import { prependLocalHistoryItem } from '../lib/historyStorage'
import type { AnalysisResult, Explanation, MatchData, MatchInput, OddsLine } from '../lib/types'

interface ConfirmRow {
    line: OddsLine
    /** 0..1 — AI tự chấm. Dưới 0.8 sẽ hiện cảnh báo đỏ. */
    confidence: number
    note: string
}

/** Sinh id ổn định cho dòng kèo đọc từ ảnh (OddsLine cần id duy nhất). */
function newLineId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
    return `x-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Chuẩn hoá dòng AI đọc được thành OddsLine + confidence. */
function toConfirmRow(r: ExtractedRow): ConfirmRow {
    return {
        line: { id: newLineId(), kind: r.kind, side: r.side, line: r.line, odds: r.odds },
        confidence: r.confidence,
        note: r.note ?? '',
    }
}

/**
 * Trang Phân tích.
 *  - G3: upload ảnh → `POST /api/extract` (Qwen OCR) → bảng xác nhận kèo có confidence.
 *  - G4: `POST /api/collect/stream` (SSE) — Bước A dùng xKiro AI Engine
 *    để lấy số liệu định lượng, phát tiến trình thật về UI, rồi engine thuần TS tính toán.
 * Phần tính toán KHÔNG dùng LLM; AI chỉ thu thập dữ liệu và (G5) viết giải thích.
 */
export function AnalyzePage() {
    const { settings } = useSettings()

    // ---- Nhập trận ----
    const [input, setInput] = useState<MatchInput>(MOCK_MATCH_INPUT)
    const [data, setData] = useState<MatchData>(MOCK_MATCH_DATA)
    const [oddsLines, setOddsLines] = useState<OddsLine[]>(MOCK_ODDS)
    const [bankroll] = useState(settings.bankroll)

    // ---- Ảnh → Qwen OCR đọc kèo (G3) ----
    const [imagePreviews, setImagePreviews] = useState<string[]>([])
    const [confirmRows, setConfirmRows] = useState<ConfirmRow[] | null>(null)
    const [parseHint, setParseHint] = useState<string | null>(null)
    const [extracting, setExtracting] = useState(false)
    const [extractNote, setExtractNote] = useState<string | null>(null)

    // ---- Stream + kết quả ----
    const [steps, setSteps] = useState<Step[]>([
        { id: 'collect', label: 'Đang tìm dữ liệu', status: 'pending' },
        { id: 'extract', label: 'Trích xuất số liệu', status: 'pending' },
        { id: 'compute', label: 'Tính xác suất (Poisson · Dixon-Coles)', status: 'pending' },
        { id: 'explain', label: 'Viết phân tích', status: 'pending' },
    ])
    const [running, setRunning] = useState(false)
    const [result, setResult] = useState<AnalysisResult | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [savedId, setSavedId] = useState<string | null>(null)
    /** Bước C: văn giải thích do Qwen viết (số do engine cấp qua token). */
    const [explanation, setExplanation] = useState<Explanation | null>(null)
    const [explanationError, setExplanationError] = useState<string | null>(null)
    /** true khi bước giải thích đang chạy (đã qua compute, chưa có kết quả C). */
    const [explaining, setExplaining] = useState(false)
    /** Text thô AI đang phát ra — cho người dùng thấy tiến trình thật. */
    const [liveText, setLiveText] = useState('')
    /** true khi đã nhận dữ liệu nền từ Google Search. */
    const [grounded, setGrounded] = useState(false)
    const abortRef = useRef<(() => void) | null>(null)
    const latestExplanationRef = useRef<Explanation | null>(null)

    // ---- Nạp tự động từ SofaScore Event ID ----
    const [sofaEventId, setSofaEventId] = useState('')
    const [fetchingSofa, setFetchingSofa] = useState(false)
    const [sofaMsg, setSofaMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

    const handleFetchSofaScore = useCallback(async (idStr: string) => {
        const cleanId = idStr.trim()
        const numId = Number(cleanId)
        if (!numId || isNaN(numId)) {
            setSofaMsg({ type: 'error', text: 'Vui lòng nhập SofaScore Event ID hợp lệ (chữ số, ví dụ: 11868359).' })
            return
        }
        setFetchingSofa(true)
        setSofaMsg(null)
        try {
            const data = await api.getLiveMatch('', '', numId)
            if (!data.found || (!data.homeTeam && !data.awayTeam)) {
                setSofaMsg({
                    type: 'error',
                    text: `Không tìm thấy thông tin trận với ID ${numId}. Vui lòng kiểm tra lại ID trên SofaScore.`,
                })
                return
            }
            setInput((prev) => ({
                ...prev,
                homeTeam: data.homeTeam || prev.homeTeam,
                awayTeam: data.awayTeam || prev.awayTeam,
                league: data.league || prev.league,
                kickoff: data.kickoff || prev.kickoff,
            }))
            setSofaMsg({
                type: 'success',
                text: `Đã nạp tự động: ${data.homeTeam} vs ${data.awayTeam}${data.league ? ` (${data.league})` : ''}`,
            })
        } catch (err) {
            setSofaMsg({
                type: 'error',
                text: err instanceof Error ? err.message : 'Lỗi khi nạp dữ liệu trận từ SofaScore.',
            })
        } finally {
            setFetchingSofa(false)
        }
    }, [])

    const setStepStatus = (id: string, status: Step['status']) => {
        setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, status } : s)))
    }

    const resetSteps = () => {
        setSteps((prev) => prev.map((s) => ({ ...s, status: 'pending' as const })))
    }

    const runAnalysis = () => {
        if (running || oddsLines.length === 0) return
        setRunning(true)
        setError(null)
        resetSteps()
        setResult(null)
        setSavedId(null)
        setLiveText('')
        setGrounded(false)
        setExplanation(null)
        latestExplanationRef.current = null
        setExplanationError(null)
        setExplaining(false)

        const cleanOddsLines: OddsLine[] = oddsLines.map((o) => ({
            id: String(o.id),
            kind: o.kind,
            side: o.side,
            line: Number(o.line),
            odds: Number(o.odds),
        }))

        const { abort } = collectStream(
            {
                home: input.homeTeam.trim(),
                away: input.awayTeam.trim(),
                league: input.league?.trim() || undefined,
                kickoff: input.kickoff || null,
                lg_home: input.lg_home,
                lg_away: input.lg_away,
                oddsLines: cleanOddsLines,
            },
            (e) => {
                switch (e.type) {
                    case 'step':
                        setStepStatus(e.id, e.status)
                        if (e.id === 'explain' && e.status === 'active') setExplaining(true)
                        if (e.id === 'explain' && e.status === 'error') {
                            setExplaining(false)
                            setExplanationError(
                                'Bước giải thích gặp lỗi — kết quả tính toán vẫn dùng được bình thường.',
                            )
                        }
                        break
                    case 'delta':
                        // Giới hạn độ dài để không dồn text vô hạn vào state
                        setLiveText((prev) => (prev.length > 4000 ? prev : prev + e.text))
                        break
                    case 'data':
                        setData(e.matchData)
                        setGrounded(true)
                        break
                    case 'explanation':
                        setExplanation(e.explanation)
                        latestExplanationRef.current = e.explanation
                        setExplaining(false)
                        break
                    case 'result':
                        setResult(e.result)
                        setSavedId(e.recordId)
                        setRunning(false)
                        setExplaining(false)
                        abortRef.current = null

                        // Lưu ngay vào LocalStorage và phát event để tab Lịch sử hiển thị lập tức không cần F5
                        try {
                            const recPicks = filterRecommendedPicks(e.result.picks)
                            prependLocalHistoryItem({
                                id: e.recordId,
                                createdAt: Date.now(),
                                meta: {
                                    home: input.homeTeam.trim(),
                                    away: input.awayTeam.trim(),
                                    league: input.league?.trim() || undefined,
                                    kickoff: input.kickoff || null,
                                },
                                analysis: e.result,
                                picks: recPicks,
                                result: null,
                                explanation: latestExplanationRef.current,
                            })
                        } catch {
                            /* ignore local cache errors */
                        }
                        break
                    case 'error':
                        setError(e.message)
                        setRunning(false)
                        setExplaining(false)
                        abortRef.current = null
                        break
                }
            },
        )
        abortRef.current = abort
    }

    /** Dừng luồng đang chạy. */
    const cancelAnalysis = () => {
        abortRef.current?.()
        abortRef.current = null
        setRunning(false)
    }

    // Dừng luồng nếu người dùng rời trang khi đang chạy
    useEffect(() => () => abortRef.current?.(), [])

    const runExtract = useCallback(
        async (files: File[]) => {
            setExtracting(true)
            setParseHint(null)
            setExtractNote(null)
            setConfirmRows(null)
            try {
                const res = await api.extract(files, {
                    home: input.homeTeam,
                    away: input.awayTeam,
                    league: input.league,
                })
                const rows = res.rows.map(toConfirmRow)
                setConfirmRows(rows)
                setExtractNote(res.note ?? null)

                if (rows.length === 0) {
                    setParseHint(
                        res.note
                            ? `Không đọc được kèo nào từ ảnh. ${res.note}`
                            : 'Không đọc được kèo nào từ ảnh. Hãy chụp rõ bảng odds hoặc nhập tay.',
                    )
                    return
                }

                // Tự động gán kết quả homeTeam, awayTeam, league, kickoff trực tiếp vào state và hiển thị lên các ô này
                if (res.meta.home) {
                    setInput((p) => ({ ...p, homeTeam: res.meta.home as string }))
                }
                if (res.meta.away) {
                    setInput((p) => ({ ...p, awayTeam: res.meta.away as string }))
                }
                if (res.meta.league) {
                    setInput((p) => ({ ...p, league: res.meta.league as string }))
                }
                if (res.meta.kickoff) {
                    setInput((p) => ({ ...p, kickoff: res.meta.kickoff as string }))
                }

                setParseHint(
                    res.lowConfidence
                        ? `Có ${rows.filter((r) => r.confidence < 0.8).length} dòng độ tin cậy thấp (ảnh có thể mờ). Bắt buộc kiểm tra lại trước khi tính.`
                        : null,
                )
            } catch (e) {
                setParseHint(
                    e instanceof ApiError
                        ? e.message
                        : 'Trích xuất ảnh thất bại. Vui lòng kiểm tra lại ảnh hoặc thử lại.',
                )
            } finally {
                setExtracting(false)
            }
        },
        [input.homeTeam, input.awayTeam, input.league],
    )

    const handleFiles = (files: FileList | File[] | null) => {
        if (!files || files.length === 0) return
        const chosen = Array.from(files).slice(0, 4)
        const valid: File[] = []
        const urls: string[] = []
        const rejected: string[] = []
        for (const f of chosen) {
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) {
                rejected.push(`${f.name}: sai định dạng`)
                continue
            }
            if (f.size > 8 * 1024 * 1024) {
                rejected.push(`${f.name}: vượt 8 MB`)
                continue
            }
            valid.push(f)
            urls.push(URL.createObjectURL(f))
        }
        setImagePreviews(urls)
        if (rejected.length > 0) setParseHint(`Bỏ qua — ${rejected.join('; ')}`)
        if (valid.length > 0) void runExtract(valid)
    }

    /** Dán ảnh từ clipboard. */
    useEffect(() => {
        const onPaste = (e: ClipboardEvent) => {
            const items = e.clipboardData?.items
            if (!items) return
            const imgs: File[] = []
            for (const it of Array.from(items)) {
                if (it.type.startsWith('image/')) {
                    const f = it.getAsFile()
                    if (f) imgs.push(f)
                }
            }
            if (imgs.length > 0) handleFiles(imgs)
        }
        window.addEventListener('paste', onPaste)
        return () => window.removeEventListener('paste', onPaste)
    })

    const valuePicks = useMemo(
        () => (result ? result.picks.filter((p) => p.status === 'value') : []),
        [result],
    )

    return (
        <div className="flex flex-col gap-5">
            {/* Form nhập trận */}
            <GlassCard>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="font-display text-sm font-bold tracking-wide text-ink-100">Thông tin trận đấu</p>
                    <span className="rounded-full border border-sky-400/30 bg-sky-500/10 px-2.5 py-0.5 text-[11px] font-medium text-sky-300">
                        🔒 Khóa chỉnh sửa tay · Dữ liệu tự động
                    </span>
                </div>

                {/* Thanh nạp trận tự động qua SofaScore Event ID */}
                <div className="mb-4 rounded-xl border border-sky-500/25 bg-gradient-to-r from-sky-950/40 via-neutral-900/60 to-neutral-900/40 p-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <div className="flex items-center gap-2">
                                <span className="inline-block h-2 w-2 rounded-full bg-sky-400 animate-pulse" />
                                <span className="font-display text-xs font-bold text-sky-300">
                                    Nạp dữ liệu tự động qua SofaScore Event ID
                                </span>
                            </div>
                            <p className="mt-0.5 text-[11px] text-neutral-400">
                                Nhập ID trận (ví dụ: 11868359) để tự động cập nhật Đội nhà, Đội khách, Giải đấu & Giờ đá.
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                placeholder="vd: 11868359"
                                value={sofaEventId}
                                onChange={(e) => setSofaEventId(e.target.value.trim())}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') void handleFetchSofaScore(sofaEventId)
                                }}
                                className="w-36 rounded-lg border border-sky-500/30 bg-neutral-950 px-2.5 py-1.5 font-mono text-xs text-white placeholder-neutral-600 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400/40"
                            />
                            <Button
                                variant="primary"
                                onClick={() => void handleFetchSofaScore(sofaEventId)}
                                disabled={fetchingSofa || !sofaEventId}
                                className="px-3 py-1.5 text-xs font-semibold"
                            >
                                {fetchingSofa ? 'Đang nạp…' : 'Nạp dữ liệu'}
                            </Button>
                        </div>
                    </div>
                    {sofaMsg && (
                        <p className={`mt-2 text-xs font-medium ${sofaMsg.type === 'success' ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {sofaMsg.type === 'success' ? '✓ ' : '⚠️ '}
                            {sofaMsg.text}
                        </p>
                    )}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Đội nhà" hint="Tự động trích xuất từ OCR / SofaScore">
                        <TextInput
                            readOnly
                            tabIndex={-1}
                            value={input.homeTeam}
                            className="cursor-not-allowed opacity-80 bg-neutral-900/60 border-neutral-800 select-none text-white/90"
                            placeholder="Chờ trích xuất OCR hoặc SofaScore..."
                        />
                    </Field>
                    <Field label="Đội khách" hint="Tự động trích xuất từ OCR / SofaScore">
                        <TextInput
                            readOnly
                            tabIndex={-1}
                            value={input.awayTeam}
                            className="cursor-not-allowed opacity-80 bg-neutral-900/60 border-neutral-800 select-none text-white/90"
                            placeholder="Chờ trích xuất OCR hoặc SofaScore..."
                        />
                    </Field>
                    <Field label="Giải đấu" hint="Tự động trích xuất từ OCR / SofaScore">
                        <TextInput
                            readOnly
                            tabIndex={-1}
                            value={input.league}
                            className="cursor-not-allowed opacity-80 bg-neutral-900/60 border-neutral-800 select-none text-white/90"
                            placeholder="Chờ trích xuất OCR hoặc SofaScore..."
                        />
                    </Field>
                    <Field label="Giờ đá (ISO)" hint="Tự động trích xuất từ OCR / SofaScore">
                        <TextInput
                            readOnly
                            tabIndex={-1}
                            type="datetime-local"
                            value={input.kickoff.slice(0, 16)}
                            className="cursor-not-allowed opacity-80 bg-neutral-900/60 border-neutral-800 select-none text-white/90"
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
                
            </GlassCard>

            {/* Theo dõi trận đấu Live & Tự động đối soát (SofaScore Direct Live Match Tracker) */}
            {input.homeTeam.trim() && input.awayTeam.trim() && (
                <LiveMatchTracker
                    home={input.homeTeam}
                    away={input.awayTeam}
                    eventId={sofaEventId ? Number(sofaEventId) : undefined}
                    recordId={savedId}
                    onSettled={(settled) => {
                        console.log('Trận đấu đã tự động đối soát kết quả:', settled)
                    }}
                />
            )}

            {/* Số liệu nền tảng: thật từ Google Search grounding (G4) hoặc dữ liệu mẫu */}
            <GlassCard>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                        <p className="font-display text-sm font-bold text-ink-100">Số liệu nền tảng</p>
                        {grounded && (
                            <span className="rounded-full border border-value-400/40 bg-value-400/10 px-2 py-0.5 text-[11px] font-semibold text-value-400">
                                Dữ liệu thật · Google Search
                            </span>
                        )}
                    </div>
                    <button
                        className="text-xs text-violet-400 hover:text-violet-300"
                        onClick={() => {
                            setData(MOCK_MATCH_DATA)
                            setGrounded(false)
                        }}
                    >
                        Nạp lại dữ liệu mẫu
                    </button>
                </div>
                <p className="mt-1 text-xs text-ink-500">
                    {grounded
                        ? 'AI phân tích số liệu định lượng cho trận đấu (xG, Poisson, ép sân, phạt góc).'
                        : 'Chưa có dữ liệu. Bấm “Phân tích ngay” để AI phân tích định lượng trận đấu.'}
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
                {data.sources.length > 0 && (
                    <details className="mt-3">
                        <summary className="cursor-pointer text-xs text-violet-400">
                            Nguồn ({data.sources.length})
                        </summary>
                        <ul className="mt-2 space-y-1">
                            {data.sources.map((s) => (
                                <li key={s.url} className="truncate text-xs">
                                    <a
                                        href={s.url}
                                        target="_blank"
                                        rel="noreferrer noopener"
                                        className="text-ink-300 underline decoration-white/20 hover:text-violet-300"
                                        title={s.url}
                                    >
                                        {s.title}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </details>
                )}
            </GlassCard>

            {/* Upload ảnh → AI đọc kèo (G3) */}
            <GlassCard>
                <div className="flex items-center justify-between gap-2">
                    <p className="font-display text-sm font-bold text-ink-100">Upload ảnh odds (Qwen OCR)</p>
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
                    {extracting ? (
                        <p className="text-sm text-violet-300">Đang đọc ảnh bằng AI (Qwen)…</p>
                    ) : (
                        <p className="text-sm text-ink-300">
                            Kéo-thả ảnh vào đây, hoặc dán ảnh từ clipboard (Ctrl+V), hoặc chọn file.
                        </p>
                    )}
                    <label
                        className={`mt-3 inline-flex cursor-pointer rounded-xl px-4 py-2 text-sm font-semibold text-black ${extracting ? 'cursor-not-allowed bg-white/35 text-ink-500' : 'bg-white hover:bg-platinum-300'
                            }`}
                    >
                        {extracting ? 'Đang xử lý…' : 'Chọn ảnh'}
                        <input
                            type="file"
                            multiple
                            accept="image/jpeg,image/png,image/webp"
                            className="hidden"
                            disabled={extracting}
                            onChange={(e) => {
                                handleFiles(e.target.files)
                                e.target.value = ''
                            }}
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

            {/* Bảng xác nhận số liệu AI đọc từ ảnh */}
            {confirmRows && (
                <GlassCard>
                    <div className="flex items-center justify-between gap-2">
                        <p className="font-display text-sm font-bold text-ink-100">
                            Xác nhận số liệu AI đọc được
                        </p>
                        <span className="rounded-full bg-warn-500/15 px-2 py-1 text-[11px] font-semibold text-warn-400">
                            Sửa nếu sai rồi mới xác nhận
                        </span>
                    </div>
                    <p className="mt-1 text-xs text-ink-500">
                        Đây là gợi ý do AI đọc từ ảnh, KHÔNG tự động tin. Cột “Tin cậy” là mức tự chấm của model —
                        dòng dưới 80% nên kiểm tra kỹ.
                    </p>
                    {extractNote && <p className="mt-1 text-xs text-ink-500">Ghi chú AI: {extractNote}</p>}
                    <div className="mt-3 overflow-x-auto rounded-xl border border-white/10">
                        <table className="min-w-full text-sm">
                            <thead className="bg-white/5 text-xs text-ink-500">
                                <tr>
                                    <th className="px-3 py-2 text-left">Loại</th>
                                    <th className="px-3 py-2 text-left">Bên</th>
                                    <th className="px-3 py-2 text-left">Mốc</th>
                                    <th className="px-3 py-2 text-left">Odds</th>
                                    <th className="px-3 py-2 text-left">Tin cậy</th>
                                    <th className="px-3 py-2 text-left">Ghi chú</th>
                                    <th className="px-3 py-2" />
                                </tr>
                            </thead>
                            <tbody>
                                {confirmRows.map((r, idx) => (
                                    <tr key={r.line.id} className="border-t border-white/8">
                                        <td className="px-3 py-1.5">
                                            <select
                                                value={r.line.kind}
                                                onChange={(e) =>
                                                    setConfirmRows((prev) =>
                                                        prev
                                                            ? prev.map((x, j) =>
                                                                j === idx
                                                                    ? {
                                                                        ...x,
                                                                        line: {
                                                                            ...x.line,
                                                                            kind: e.target.value as OddsLine['kind'],
                                                                            side:
                                                                                e.target.value === 'totals'
                                                                                    ? 'over'
                                                                                    : 'home',
                                                                        },
                                                                    }
                                                                    : x,
                                                            )
                                                            : prev,
                                                    )
                                                }
                                                className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-ink-100"
                                            >
                                                <option value="totals">Tài/Xỉu</option>
                                                <option value="ah">Chấp</option>
                                            </select>
                                        </td>
                                        <td className="px-3 py-1.5">
                                            <select
                                                value={r.line.side}
                                                onChange={(e) =>
                                                    setConfirmRows((prev) =>
                                                        prev
                                                            ? prev.map((x, j) =>
                                                                j === idx
                                                                    ? {
                                                                        ...x,
                                                                        line: {
                                                                            ...x.line,
                                                                            side: e.target.value as OddsLine['side'],
                                                                        },
                                                                    }
                                                                    : x,
                                                            )
                                                            : prev,
                                                    )
                                                }
                                                className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-ink-100"
                                            >
                                                {(r.line.kind === 'totals'
                                                    ? ['over', 'under']
                                                    : ['home', 'away']
                                                ).map((s) => (
                                                    <option key={s} value={s}>
                                                        {s}
                                                    </option>
                                                ))}
                                            </select>
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
                                        <td className="px-3 py-1.5">
                                            <span
                                                className={`rounded-full px-2 py-1 text-[11px] font-semibold ${r.confidence >= 0.8
                                                    ? 'bg-value-500/15 text-value-400'
                                                    : r.confidence >= 0.6
                                                        ? 'bg-warn-500/15 text-warn-400'
                                                        : 'bg-danger-500/15 text-danger-400'
                                                    }`}
                                            >
                                                {Math.round(r.confidence * 100)}%
                                            </span>
                                        </td>
                                        <td className="px-3 py-1.5 text-xs text-ink-500">{r.note || '—'}</td>
                                        <td className="px-3 py-1.5 text-center">
                                            <button
                                                className="text-danger-400 hover:text-danger-300"
                                                onClick={() =>
                                                    setConfirmRows((prev) =>
                                                        prev ? prev.filter((_, j) => j !== idx) : prev,
                                                    )
                                                }
                                            >
                                                ×
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="mt-3 flex gap-2">
                        <Button
                            onClick={() => {
                                if (confirmRows) {
                                    setOddsLines(confirmRows.map((r) => r.line))
                                    setConfirmRows(null)
                                }
                            }}
                            disabled={confirmRows.length === 0}
                        >
                            Xác nhận và đưa vào tính ({confirmRows.length})
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
                    <button
                        type="button"
                        onClick={() => void runAnalysis()}
                        disabled={running || oddsLines.length === 0}
                        className="inline-flex items-center justify-center gap-2 px-6 py-2.5 rounded-lg bg-white text-black font-semibold hover:bg-neutral-100 transition shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {running ? 'Đang phân tích…' : 'Phân tích ngay'}
                    </button>
                </div>
                {error && <p className="mt-2 text-xs text-danger-400">{error}</p>}
                {savedId && !error && (
                    <p className="mt-2 text-xs text-ink-500">
                        Đã lưu vào Lịch sử (mã <span className="font-display text-ink-300">{savedId}</span>).
                    </p>
                )}
            </GlassCard>

            {/* Stream tiến trình thật (SSE) */}
            {(running || result) && (
                <GlassCard>
                    <div className="flex items-center justify-between gap-2">
                        <p className="font-display text-sm font-bold text-ink-100">Tiến trình phân tích</p>
                        {running && (
                            <Button variant="ghost" onClick={cancelAnalysis}>
                                Hủy
                            </Button>
                        )}
                    </div>
                    <div className="mt-3">
                        {running ? (
                            <ProgressSteps steps={steps} />
                        ) : (
                            <div className="flex items-center gap-2 text-sm text-value-400">
                                <span>✓</span> Hoàn tất ({steps.filter((s) => s.status === 'done').length}/{steps.length} bước)
                            </div>
                        )}
                    </div>
                    {running && liveText && (
                        <div className="mt-3 max-h-40 overflow-y-auto rounded-xl border border-white/10 bg-black/20 p-3">
                            <p className="mb-1 text-[11px] uppercase tracking-wide text-ink-500">
                                AI đang phát (thô)
                            </p>
                            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-400">
                                {liveText}
                            </pre>
                        </div>
                    )}
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

                    {/* Bước C — 4 phần giải thích do Qwen viết, số do engine cấp qua token */}
                    <ExplanationPanel
                        explanation={explanation}
                        loading={explaining}
                        error={explanationError}
                    />
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
