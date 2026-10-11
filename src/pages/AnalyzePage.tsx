import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GlassCard } from '../components/ui/GlassCard'
import { Button } from '../components/ui/Button'
import { Field, TextInput } from '../components/ui/Field'
import { PickCard } from '../components/PickCard'
import { ExplanationPanel } from '../components/ExplanationPanel'
import { ProgressSteps, type Step } from '../components/ui/ProgressSteps'
import { Skeleton } from '../components/ui/RefractionFilter'
import { api, collectStream, type ExtractedRow } from '../lib/api'
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

    // ---- Nhập trận (Khởi tạo sạch 100%, không dữ liệu giả) ----
    const [input, setInput] = useState<MatchInput>({
        homeTeam: '',
        awayTeam: '',
        league: '',
        kickoff: '',
        lg_home: 1.45,
        lg_away: 1.15,
    })
    const setHomeTeam = useCallback((team: string) => {
        setInput((p) => ({ ...p, homeTeam: team }))
    }, [])
    const setAwayTeam = useCallback((team: string) => {
        setInput((p) => ({ ...p, awayTeam: team }))
    }, [])
    const [data, setData] = useState<MatchData | null>(null)
    const [oddsLines, setOddsLines] = useState<OddsLine[]>([])
    const [bankroll] = useState(settings.bankroll)

    // ---- In-Play Live temporal state ----
    const [isLive, setIsLive] = useState(false)
    const [currentMinute, setCurrentMinute] = useState<number | null>(null)
    const [currentScore, setCurrentScore] = useState<{ home: number; away: number } | null>(null)
    const [period, setPeriod] = useState<string>('')

    // ---- Ảnh → Qwen OCR đọc kèo (G3) ----
    const [imagePreviews, setImagePreviews] = useState<string[]>([])
    const [confirmRows, setConfirmRows] = useState<ConfirmRow[] | null>(null)
    const [parseHint, setParseHint] = useState<string | null>(null)
    const [extracting, setExtracting] = useState(false)
    const [extractStatusText, setExtractStatusText] = useState<string>('AI đang bóc tách trực tiếp ma trận kèo qua Qwen Omni Flash...')
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
    const fileInputRef = useRef<HTMLInputElement | null>(null)
    const previewsRef = useRef<string[]>([])

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

    const triggerAnalysis = useCallback(
        (overrides?: {
            home?: string
            away?: string
            league?: string
            kickoff?: string | null
            eventId?: number
            oddsLines?: OddsLine[]
            isLive?: boolean
            currentMinute?: number | null
            currentScore?: { home: number; away: number } | null
        }) => {
            const h = (overrides?.home !== undefined ? overrides.home : input.homeTeam).trim()
            const a = (overrides?.away !== undefined ? overrides.away : input.awayTeam).trim()
            const currentLines = overrides?.oddsLines ?? oddsLines

            if (!h || !a || currentLines.length === 0) return

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

            const cleanOddsLines: OddsLine[] = currentLines.map((o) => ({
                id: String(o.id),
                kind: o.kind,
                side: o.side,
                line: Number(o.line),
                odds: Number(o.odds),
            }))

            const liveFlag = overrides?.isLive !== undefined ? overrides.isLive : isLive
            const minute = overrides?.currentMinute !== undefined ? overrides.currentMinute : currentMinute
            const score = overrides?.currentScore !== undefined ? overrides.currentScore : currentScore

            const inPlay = liveFlag
                ? {
                      isLive: true,
                      currentMinute: minute,
                      currentScore: score,
                  }
                : undefined

            const evId =
                overrides?.eventId !== undefined
                    ? overrides.eventId
                    : sofaEventId
                        ? Number(sofaEventId)
                        : undefined
            const leg = overrides?.league !== undefined ? overrides.league : input.league
            const kof = overrides?.kickoff !== undefined ? overrides.kickoff : input.kickoff

            const { abort } = collectStream(
                {
                    home: h,
                    away: a,
                    league: leg?.trim() || undefined,
                    kickoff: kof || null,
                    eventId: evId,
                    lg_home: input.lg_home,
                    lg_away: input.lg_away,
                    oddsLines: cleanOddsLines,
                    inPlay,
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

                            // Lưu ngay vào LocalStorage và phát event để tab Lịch sử hiển thị lập tức
                            try {
                                const recPicks = filterRecommendedPicks(e.result.picks)
                                prependLocalHistoryItem({
                                    id: e.recordId,
                                    createdAt: Date.now(),
                                    meta: {
                                        home: h,
                                        away: a,
                                        league: leg?.trim() || undefined,
                                        kickoff: kof || null,
                                        eventId: evId,
                                        inPlay,
                                    },
                                    analysis: e.result,
                                    picks: recPicks,
                                    result: null,
                                    explanation: latestExplanationRef.current,
                                })
                            } catch {
                                /* ignore */
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
        },
        [input, oddsLines, isLive, currentMinute, currentScore, sofaEventId],
    )

    const runAnalysis = () => triggerAnalysis()

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
            setExtractStatusText('AI đang bóc tách trực tiếp ma trận kèo qua Qwen Omni Flash...')
            setParseHint(null)
            setError(null)
            setExtractNote(null)
            setConfirmRows(null)
            try {
                const hint = {
                    home: input.homeTeam.trim() || undefined,
                    away: input.awayTeam.trim() || undefined,
                    league: input.league.trim() || undefined,
                }

                // Gửi ảnh trực tiếp từ trình duyệt đến xKiro Vision API (bỏ qua trần 10s Vercel)
                const res = await api.extract(files, hint)

                // CẬP NHẬT TÊN ĐỘI TỪ OCR NGAY LẬP TỨC:
                const extractedHome = (res.homeTeam || res.meta?.home || (res as unknown as { home?: string }).home || '').trim()
                const extractedAway = (res.awayTeam || res.meta?.away || (res as unknown as { away?: string }).away || '').trim()
                const extractedLeague = (res.league || res.meta?.league || (res as unknown as { league?: string }).league || '').trim()
                const extractedKickoff = (res.meta?.kickoff || (res as unknown as { kickoff?: string }).kickoff || '').trim()

                if (extractedHome) {
                    setHomeTeam(extractedHome)
                }
                if (extractedAway) {
                    setAwayTeam(extractedAway)
                }
                if (extractedLeague) {
                    setInput((p) => ({ ...p, league: extractedLeague }))
                }
                if (extractedKickoff) {
                    setInput((p) => ({ ...p, kickoff: extractedKickoff }))
                }

                if (res.isLive !== undefined) setIsLive(Boolean(res.isLive))
                if (res.currentMinute !== undefined) setCurrentMinute(res.currentMinute)
                if (res.currentScore !== undefined) setCurrentScore(res.currentScore)
                if (res.period !== undefined) setPeriod(res.period)

                const rows = res.rows.map(toConfirmRow)
                setConfirmRows(rows)
                const cleanLines = rows.map((r) => r.line)
                setOddsLines(cleanLines)
                setExtractNote(res.note ?? null)
                setError(null)
                setParseHint(null)

                if (rows.length === 0) {
                    setParseHint(
                        res.note
                            ? `Không đọc được kèo nào từ ảnh. ${res.note}`
                            : 'Không đọc được kèo nào từ ảnh. Hãy chụp rõ bảng odds hoặc nhập tay.',
                    )
                    return
                }

                setParseHint(
                    res.lowConfidence
                        ? `Có ${rows.filter((r) => r.confidence < 0.8).length} dòng độ tin cậy thấp (ảnh có thể mờ). Bắt buộc kiểm tra lại trước khi tính.`
                        : null,
                )

                // TỰ ĐỘNG KÍCH HOẠT PHÂN TÍCH ĐỊNH LƯỢNG & SOFASCORE SYNC KHÔNG CẦN BẤM CHUỘT
                const h = extractedHome || input.homeTeam.trim()
                const a = extractedAway || input.awayTeam.trim()

                if (h && a && cleanLines.length > 0) {
                    setExtractStatusText('Đã nạp kèo! Đang tự động phân tích định lượng Poisson & Dixon-Coles...')
                    api.sofascoreSearch(h, a)
                        .then((sRes) => {
                            const evId = sRes?.eventId ? Number(sRes.eventId) : undefined
                            if (evId) {
                                setSofaEventId(String(evId))
                                setSofaMsg({
                                    type: 'success',
                                    text: `Tự động khớp SofaScore Event ID: ${evId}`,
                                })
                            }
                            triggerAnalysis({
                                home: h,
                                away: a,
                                league: extractedLeague || input.league?.trim(),
                                kickoff: extractedKickoff || input.kickoff,
                                eventId: evId,
                                oddsLines: cleanLines,
                                isLive: Boolean(res.isLive),
                                currentMinute: res.currentMinute,
                                currentScore: res.currentScore,
                            })
                        })
                        .catch(() => {
                            triggerAnalysis({
                                home: h,
                                away: a,
                                league: extractedLeague || input.league?.trim(),
                                kickoff: extractedKickoff || input.kickoff,
                                oddsLines: cleanLines,
                                isLive: Boolean(res.isLive),
                                currentMinute: res.currentMinute,
                                currentScore: res.currentScore,
                            })
                        })
                }
            } catch (e) {
                setParseHint(
                    e instanceof Error
                        ? e.message
                        : 'Trích xuất ảnh thất bại. Vui lòng kiểm tra lại ảnh hoặc thử lại.',
                )
            } finally {
                setExtracting(false)
            }
        },
        [input, setHomeTeam, setAwayTeam, triggerAnalysis],
    )

    const handleFiles = async (files: FileList | File[] | null) => {
        if (!files || files.length === 0) return
        // Xóa ngay lập tức mọi thông báo lỗi trước đó khi bắt đầu upload mới
        setError(null)
        setParseHint(null)

        const chosen = Array.from(files).slice(0, 4)
        const valid: File[] = []
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
        }
        if (rejected.length > 0) setParseHint(`Bỏ qua — ${rejected.join('; ')}`)
        if (valid.length === 0) return

        setExtracting(true)
        setExtractStatusText('AI đang bóc tách trực tiếp ma trận kèo qua Qwen Omni Flash...')
        try {
            const urls = valid.map((vf) => URL.createObjectURL(vf))
            setImagePreviews(urls)
            await runExtract(valid)
        } catch {
            setExtracting(false)
        }
    }

    // Đồng bộ previewsRef để thu hồi memory khi unmount
    useEffect(() => {
        previewsRef.current = imagePreviews
    }, [imagePreviews])

    useEffect(() => {
        return () => {
            previewsRef.current.forEach((url) => {
                try {
                    URL.revokeObjectURL(url)
                } catch {
                    /* ignore */
                }
            })
        }
    }, [])

    /** Xóa một ảnh cụ thể theo index */
    const removeImage = (indexToRemove: number) => {
        const urlToRevoke = imagePreviews[indexToRemove]
        if (urlToRevoke) {
            try {
                URL.revokeObjectURL(urlToRevoke)
            } catch {
                /* ignore */
            }
        }

        const nextPreviews = imagePreviews.filter((_, i) => i !== indexToRemove)
        setImagePreviews(nextPreviews)

        // Xóa thông báo lỗi nếu có
        setParseHint(null)
        setError(null)

        // Nếu ảnh bị xóa là ảnh duy nhất hoặc danh sách đã rỗng:
        if (nextPreviews.length === 0) {
            if (fileInputRef.current) {
                fileInputRef.current.value = ''
            }
            // Reset toàn bộ thông tin kèo OCR và trạng thái đội về rỗng
            setConfirmRows(null)
            setExtractNote(null)
            setOddsLines([])
            setInput((prev) => ({
                ...prev,
                homeTeam: '',
                awayTeam: '',
                league: '',
                kickoff: '',
            }))
            setIsLive(false)
            setCurrentMinute(null)
            setCurrentScore(null)
            setPeriod('')
            setSofaEventId('')
            setSofaMsg(null)
            setResult(null)
        }
    }

    /** Xóa toàn bộ ảnh đang tải lên */
    const clearAllImages = () => {
        for (const url of imagePreviews) {
            try {
                URL.revokeObjectURL(url)
            } catch {
                /* ignore */
            }
        }
        setImagePreviews([])
        setParseHint(null)
        setError(null)
        if (fileInputRef.current) {
            fileInputRef.current.value = ''
        }
        setConfirmRows(null)
        setExtractNote(null)
        setOddsLines([])
        setInput((prev) => ({
            ...prev,
            homeTeam: '',
            awayTeam: '',
            league: '',
            kickoff: '',
        }))
        setIsLive(false)
        setCurrentMinute(null)
        setCurrentScore(null)
        setPeriod('')
        setSofaEventId('')
        setSofaMsg(null)
        setResult(null)
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

    // LỌC SẠCH KÈO RÁC: Chỉ giữ các kèo value đạt chuẩn (Edge >= 5%, EV > 0, Odds >= 1.50, confidence !== 'low')
    const qualifyingPicks = useMemo(
        () =>
            result
                ? result.picks.filter(
                      (p) =>
                          p.status === 'value' &&
                          p.edge >= 0.05 &&
                          p.ev > 0 &&
                          p.odds >= 1.50 &&
                          p.confidence !== 'low',
                  )
                : [],
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

                {isLive && (
                    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-950/20 px-3.5 py-2 text-xs text-rose-300">
                        <span className="flex h-2 w-2 rounded-full bg-rose-500 animate-ping" />
                        <span className="font-bold">Đang đá trực tiếp (In-Play)</span>
                        {period && <span className="rounded bg-rose-500/20 px-1.5 py-0.5 font-medium">{period}</span>}
                        {currentMinute != null && (
                            <span className="font-mono font-semibold">Phút {currentMinute}&apos;</span>
                        )}
                        {currentScore && (
                            <span className="font-mono font-bold text-white">
                                Tỉ số: {currentScore.home} - {currentScore.away}
                            </span>
                        )}
                    </div>
                )}

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
            <LiveMatchTracker
                key={`${input.homeTeam}-${input.awayTeam}-${sofaEventId}`}
                home={input.homeTeam}
                away={input.awayTeam}
                eventId={sofaEventId ? Number(sofaEventId) : undefined}
                recordId={savedId}
                onSettled={(settled) => {
                    console.log('Trận đấu đã tự động đối soát kết quả:', settled)
                }}
            />

            {/* Số liệu nền tảng: thật từ Qwen AI Engine & SofaScore (Bước A) */}
            <GlassCard>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                        <p className="font-display text-sm font-bold text-ink-100">Số liệu nền tảng</p>
                        {grounded && (
                            <span className="rounded-full border border-value-400/40 bg-value-400/10 px-2 py-0.5 text-[11px] font-semibold text-value-400">
                                Dữ liệu thật · SofaScore & Web Grounding
                            </span>
                        )}
                    </div>
                </div>
                {!data ? (
                    <div className="mt-3 rounded-lg border border-dashed border-white/10 bg-white/5 p-6 text-center text-xs text-ink-500">
                        Chưa có dữ liệu nền tảng. Hãy tải ảnh bảng cược hoặc nhập SofaScore Event ID rồi bấm "Phân tích ngay" để AI thu thập dữ liệu thật.
                    </div>
                ) : (
                    <>
                        <p className="mt-1 text-xs text-ink-500">
                            Số liệu định lượng cho trận đấu (xG, Poisson, ép sân, phạt góc).
                        </p>
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                            <TeamBox label={`Chủ nhà: ${input.homeTeam || 'Đội nhà'}`} team={data.home} />
                            <TeamBox label={`Khách: ${input.awayTeam || 'Đội khách'}`} team={data.away} />
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
                    </>
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
                        <div className="flex flex-col items-center gap-1.5 py-1">
                            <span className="flex h-3 w-3 rounded-full bg-violet-400 animate-ping mb-1" />
                            <p className="text-sm font-semibold text-violet-300 animate-pulse">
                                {extractStatusText || 'AI đang bóc tách trực tiếp ma trận kèo qua Qwen Omni Flash...'}
                            </p>
                            <span className="text-xs text-neutral-400">
                                Kết nối trực tiếp xKiro Vision API (bỏ qua trần 10s Vercel, triệt tiêu lỗi 504)...
                            </span>
                        </div>
                    ) : (
                        <p className="text-sm text-ink-300">
                            Kéo-thả ảnh vào đây, hoặc dán ảnh từ clipboard (Ctrl+V), hoặc chọn file.
                        </p>
                    )}
                    <label
                        className={`mt-3 inline-flex cursor-pointer rounded-xl px-4 py-2 text-sm font-semibold text-black ${extracting ? 'cursor-not-allowed bg-white/35 text-ink-500' : 'bg-white hover:bg-platinum-300'
                            }`}
                    >
                        {extracting ? 'Đang bóc tách trực tiếp qua xKiro…' : 'Chọn ảnh'}
                        <input
                            ref={fileInputRef}
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
                    <div className="mt-3">
                        <div className="mb-2 flex items-center justify-between">
                            <span className="text-xs font-semibold text-neutral-300">
                                Ảnh đã tải lên ({imagePreviews.length}/4)
                            </span>
                            {imagePreviews.length > 1 && (
                                <button
                                    type="button"
                                    onClick={clearAllImages}
                                    className="text-xs font-medium text-rose-400 hover:text-rose-300 transition hover:underline"
                                >
                                    ✕ Xóa tất cả ảnh
                                </button>
                            )}
                        </div>
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                            {imagePreviews.map((src, i) => (
                                <div
                                    key={i}
                                    className="group relative overflow-hidden rounded-xl border border-white/10 bg-black/40"
                                >
                                    <img
                                        src={src}
                                        alt={`Ảnh ${i + 1}`}
                                        className="h-28 w-full object-cover transition duration-200 group-hover:scale-105"
                                    />
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            removeImage(i)
                                        }}
                                        className="absolute top-1.5 right-1.5 bg-black/75 hover:bg-red-600 text-white rounded-full p-1 cursor-pointer transition-all z-10"
                                        title="Xóa ảnh này"
                                        aria-label="Xóa ảnh này"
                                    >
                                        <svg
                                            className="h-3.5 w-3.5"
                                            viewBox="0 0 20 20"
                                            fill="currentColor"
                                        >
                                            <path
                                                fillRule="evenodd"
                                                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                                                clipRule="evenodd"
                                            />
                                        </svg>
                                    </button>
                                    <span className="absolute bottom-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white/80 backdrop-blur-sm">
                                        Ảnh {i + 1}
                                    </span>
                                </div>
                            ))}
                        </div>
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
                                        <td className="px-3 py-1.5 font-medium">
                                            {o.kind === 'totals'
                                                ? (o.side === 'over' ? 'Tài' : 'Xỉu')
                                                : (o.side === 'home' ? (input.homeTeam || 'Chủ nhà') : (input.awayTeam || 'Đội khách'))
                                            }
                                        </td>
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
                    {qualifyingPicks.length === 0 ? (
                        <GlassCard className="border border-amber-500/30 bg-gradient-to-r from-amber-950/40 via-neutral-900/60 to-neutral-900/40 p-5 shadow-lg">
                            <div className="flex items-start gap-3.5">
                                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-500/40 bg-amber-500/20 text-xl font-bold text-amber-400">
                                    ⚠️
                                </span>
                                <div>
                                    <h3 className="font-display text-base font-bold text-amber-300">
                                        NO BET — Thị trường không có kèo nào đạt biên an toàn (Edge &gt;= 5%, EV &gt; 0). Khuyến nghị bỏ qua trận này.
                                    </h3>
                                    <p className="mt-1 text-xs text-neutral-400">
                                        Toàn bộ các mốc cược trên thị trường hiện tại đều bị âm kỳ vọng (EV ≤ 0), lệch tỷ lệ hoặc có rủi ro bẫy giá (TRAP). Không giải ngân vốn vào trận đấu này.
                                    </p>
                                </div>
                            </div>
                        </GlassCard>
                    ) : (
                        <div className="flex flex-col gap-3">
                            <div className="flex items-center justify-between gap-2">
                                <h3 className="font-display text-sm font-bold text-ink-100">
                                    KÈO VALUE KHUYẾN NGHỊ ({qualifyingPicks.length})
                                </h3>
                                <span className="rounded-full border border-value-400/30 bg-value-400/10 px-2.5 py-0.5 text-[11px] font-semibold text-value-400">
                                    Edge ≥ 5% · EV &gt; 0 · Odds ≥ 1.50
                                </span>
                            </div>
                            <div className="grid gap-3 md:grid-cols-2">
                                {qualifyingPicks.map((pick, i) => (
                                    <PickCard
                                        key={pick.oddsLineId}
                                        pick={pick}
                                        bankroll={bankroll}
                                        index={i}
                                        homeTeam={input.homeTeam}
                                        awayTeam={input.awayTeam}
                                    />
                                ))}
                            </div>
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
