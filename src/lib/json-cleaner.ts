/**
 * Robust JSON Sanitization & Parsing Helper
 * ─────────────────────────────────────────────────────────────────────────────
 * Xử lý triệt để các phản hồi từ AI (xKiro Qwen Vision OCR, LLMs):
 * 1. Bóc tách markdown code fences (```json ... ```)
 * 2. Cắt bỏ các đoạn văn bản trò chuyện/chú thích ở đầu hoặc cuối JSON
 * 3. Tự động sửa các lỗi cú pháp phổ biến (dấu phẩy thừa trailing commas, thiếu ngoặc đóng do đứt token)
 */

/**
 * Trích xuất và parse JSON an toàn từ phản hồi của AI.
 */
export function extractValidJson<T = unknown>(rawText: string): T {
    if (!rawText || typeof rawText !== 'string' || !rawText.trim()) {
        throw new Error('Phản hồi từ AI rỗng')
    }

    // 1. Loại bỏ triệt để markdown code fences
    let cleaned = rawText
        .replace(/```json\s*/gi, '')
        .replace(/```\s*$/gi, '')
        .replace(/```/g, '')
        .trim()

    // 2. Tìm khoảng bao quanh từ dấu ngoặc mở đầu tiên đến dấu ngoặc đóng cuối cùng
    const firstBrace = cleaned.indexOf('{')
    const lastBrace = cleaned.lastIndexOf('}')
    const firstBracket = cleaned.indexOf('[')
    const lastBracket = cleaned.lastIndexOf(']')

    // Xác định xem root là Object ({}) hay Array ([])
    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
        if (lastBrace > firstBrace) {
            cleaned = cleaned.substring(firstBrace, lastBrace + 1)
        } else {
            cleaned = cleaned.substring(firstBrace)
        }
    } else if (firstBracket !== -1 && lastBracket > firstBracket) {
        cleaned = cleaned.substring(firstBracket, lastBracket + 1)
    }

    // 3. Thử parse trực tiếp
    try {
        return JSON.parse(cleaned) as T
    } catch {
        // Tiếp tục các bước phục hồi phía dưới
    }

    // 4. Sửa lỗi phổ biến: Loại bỏ trailing commas (dấu phẩy thừa trước } hoặc ])
    let repaired = cleaned.replace(/,\s*([}\]])/g, '$1').trim()

    try {
        return JSON.parse(repaired) as T
    } catch {
        // Tiếp tục các bước phục hồi nâng cao
    }

    // 5. Phục hồi JSON bị cắt cụt do giới hạn token (Truncated JSON Repair)
    repaired = repairTruncatedJson(repaired)
    try {
        return JSON.parse(repaired) as T
    } catch (err) {
        throw new Error(
            `Không thể phân tích cú pháp JSON từ phản hồi AI: ${err instanceof Error ? err.message : String(err)}`,
        )
    }
}

/**
 * Sửa chữa JSON bị cắt cụt giữa chừng do chạm trần token output của LLM.
 */
function repairTruncatedJson(jsonStr: string): string {
    let s = jsonStr.trim()

    // Nếu kết thúc bằng dấu phẩy hoặc hai chấm lơ lửng, loại bỏ
    s = s.replace(/,\s*$/, '').replace(/:\s*$/, ': null')

    // Nếu đang trong một chuỗi chưa đóng (số dấu nháy kép lẻ), thêm nháy kép đóng
    let inString = false
    let isEscaped = false
    const stack: string[] = []

    for (let i = 0; i < s.length; i++) {
        const char = s[i]
        if (char === '\\' && inString) {
            isEscaped = !isEscaped
            continue
        }
        if (char === '"' && !isEscaped) {
            inString = !inString
        } else if (!inString) {
            if (char === '{') stack.push('}')
            else if (char === '[') stack.push(']')
            else if (char === '}' || char === ']') {
                if (stack.length > 0 && stack[stack.length - 1] === char) {
                    stack.pop()
                }
            }
        }
        isEscaped = false
    }

    if (inString) {
        s += '"'
    }

    // Loại bỏ dấu phẩy thừa trước khi đóng ngoặc
    s = s.replace(/,\s*$/, '')

    // Đóng toàn bộ các ngoặc chưa đóng theo đúng thứ tự LIFO
    while (stack.length > 0) {
        s += stack.pop()
    }

    // Loại bỏ trailing commas lần nữa
    return s.replace(/,\s*([}\]])/g, '$1').trim()
}
