import { describe, expect, it } from 'vitest'
import {
    sanitizeCleanText,
    stripJsonFence,
    XKIRO_MODEL,
    XKIRO_ENDPOINT,
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

describe('stripJsonFence (Pure JSON Handling)', () => {
    it('loại bỏ khối markdown code block ```json ... ```', () => {
        const raw = '```json\n{"home":{"xgf":1.8}}\n```'
        expect(stripJsonFence(raw)).toBe('{"home":{"xgf":1.8}}')
    })

    it('loại bỏ khối markdown code block không định danh ``` ... ```', () => {
        const raw = '```\n{"test": true}\n```'
        expect(stripJsonFence(raw)).toBe('{"test": true}')
    })

    it('giữ nguyên chuỗi JSON thuần không có markdown', () => {
        const raw = '{"pure": "json"}'
        expect(stripJsonFence(raw)).toBe('{"pure": "json"}')
    })
})

describe('xKiro Model & Endpoint Standards', () => {
    it('sử dụng model chuẩn qwen/qwen3.8-max:free', () => {
        expect(XKIRO_MODEL).toBe('qwen/qwen3.8-max:free')
        expect(GEMINI_MODEL).toBe('qwen/qwen3.8-max:free')
    })

    it('endpoint gọi đúng chuẩn OpenAI https://api.xkiro.com/v1/chat/completions', () => {
        expect(XKIRO_ENDPOINT).toBe('https://api.xkiro.com/v1/chat/completions')
        expect(GEMINI_ENDPOINT).toBe('https://api.xkiro.com/v1/chat/completions')
        expect(GEMINI_STREAM_ENDPOINT).toBe('https://api.xkiro.com/v1/chat/completions')
    })

    it('appendApiKey gắn query param key chính xác khi cần', () => {
        const url = 'https://api.xkiro.com/v1/chat/completions'
        expect(appendApiKey(url, 'my-key')).toBe(`${url}?key=my-key`)
    })

    it('getModelCandidates chứa model chính xKiro', () => {
        const candidates = getModelCandidates()
        expect(candidates).toContain('qwen/qwen3.8-max:free')
        expect(candidates[0]).toBe(XKIRO_MODEL)
    })
})
