/**
 * Re-export từ server/services/xkiro.ts
 * Giữ các alias tương thích ngược nếu có module cũ tham chiếu.
 */
import {
    XKIRO_MODEL,
    XKIRO_ENDPOINT,
    XKiroError,
    callXKiroChat,
} from './xkiro.js'

export * from './xkiro.js'

export const GEMINI_MODEL = XKIRO_MODEL
export const GEMINI_ENDPOINT = XKIRO_ENDPOINT
export const GEMINI_STREAM_ENDPOINT = XKIRO_ENDPOINT
export const GeminiError = XKiroError

export async function callGeminiApiWithRetry(
    _endpointUrl: string,
    body: unknown,
    _contextName = 'xkiro',
): Promise<Response> {
    const b = body as { contents?: Array<{ parts?: Array<{ text?: string }> }> }
    const textPrompt = b?.contents?.[0]?.parts?.map((p) => p.text).join('\n') || ''
    return callXKiroChat([{ role: 'user', content: textPrompt }])
}
