import { describe, expect, it } from 'vitest'
import { sanitizeCleanText } from '../../server/services/gemini.js'

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
