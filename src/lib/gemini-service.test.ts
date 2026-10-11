import { describe, expect, it } from 'vitest'
import {
    sanitizeCleanText,
    GEMINI_MODEL,
    GEMINI_ENDPOINT,
    GEMINI_STREAM_ENDPOINT,
    appendApiKey,
    getModelCandidates,
} from '../../server/services/gemini.js'

describe('sanitizeCleanText (Payload Hygiene)', () => {
    it('giữ nguyên văn bản text sạch thông thường', () => {
        const text = 'Trận đấu giữa Arsenal vs Chelsea tại Premier League'
        expect(sanitizeCleanText(text)).toBe(text)
    })

    it('loại bỏ hoàn toàn chuỗi base64 data URI của ảnh để tránh token spike', () => {
        const raw = 'Trận Arsenal vs Chelsea data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg== kết thúc'
        const sanitized = sanitizeCleanText(raw)
        expect(sanitized).not.toContain('data:image/png;base64')
        expect(sanitized).toContain('[IMAGE_REMOVED]')
        expect(sanitized).toContain('Trận Arsenal vs Chelsea')
        expect(sanitized).toContain('kết thúc')
    })

    it('loại bỏ các blob nhị phân dài ngẫu nhiên (>250 chars)', () => {
        const longBlob = 'A'.repeat(300)
        const raw = `Đội bóng ${longBlob} thi đấu`
        const sanitized = sanitizeCleanText(raw)
        expect(sanitized).not.toContain(longBlob)
        expect(sanitized).toContain('[BLOB_REMOVED]')
    })

    it('xử lý chuỗi rỗng an toàn', () => {
        expect(sanitizeCleanText('')).toBe('')
    })
})

describe('Gemini Model & Endpoint Standards', () => {
    it('sử dụng model chuẩn gemini-3.8-flash (hoặc các model chính thức)', () => {
        expect(['gemini-3.8-flash', 'gemini-2.0-flash', 'gemini-1.5-flash']).toContain(GEMINI_MODEL)
    })

    it('endpoint gọi đúng chuẩn https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent', () => {
        expect(GEMINI_ENDPOINT).toBe(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        )
    })

    it('endpoint streaming gọi đúng chuỗi streamGenerateContent?alt=sse', () => {
        expect(GEMINI_STREAM_ENDPOINT).toBe(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`,
        )
    })

    it('appendApiKey gắn query param key chính xác cho cả endpoint thường và stream', () => {
        const url1 = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent'
        expect(appendApiKey(url1, 'my-key')).toBe(`${url1}?key=my-key`)

        const url2 = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse'
        expect(appendApiKey(url2, 'my-key')).toBe(`${url2}&key=my-key`)
    })

    it('getModelCandidates chứa model chính và các model dự phòng chuẩn', () => {
        const candidates = getModelCandidates()
        expect(candidates.length).toBeGreaterThanOrEqual(2)
        expect(candidates[0]).toBe(GEMINI_MODEL)
        expect(candidates).toContain('gemini-2.0-flash')
    })
})
