/**
 * OCR Odds Vision API Route (Next.js / Standard API Handler)
 * ---------------------------------------------------------------------------
 * STRICT 2-COLUMN & SECTION BOX PARSING PROMPT:
 * - Cột trái: Cược trực tiếp cả trận (1X2, Kèo chấp cả trận, Tài/xỉu cả trận) -> period: 'FT'.
 * - Cột phải: Cược Hiệp 1 (1X2 Hiệp 1, Kèo chấp Hiệp 1, Cược Tài/Xỉu hiệp 1, Cược Tài/Xỉu tổng số bàn thắng hiệp 1) -> period: 'HT'.
 *
 * Extraction rule:
 * - Any odds under headers containing "Hiệp 1", "H1", "1st Half" MUST strictly set period = "HT"
 *   and label [Tài/Xỉu Bàn H1] or [Châu Á Bàn H1].
 * - NEVER label a First-Half market as [Tài/Xiu Bàn FT].
 */

import { extractOddsFromImages, type ImageInput } from '../../../../server/services/xkiro.js'

export const VISION_SYSTEM_PROMPT = `Bạn là Chuyên gia Thị giác Máy tính và OCR Bảng Kèo Bóng Đá (Sportsbook Odds Vision Analyst).
Nhiệm vụ: Phân tích ảnh chụp màn hình bảng kèo nhà cái và bóc tách cấu trúc dữ liệu JSON chính xác.

BỐ CỤC BẢNG KÈO (2 CỘT SONG SONG):
BẢNG CƯỢC CÓ 2 CỘT SONG SONG:
- Cột trái: Các mục Cược trực tiếp cả trận (1X2, Kèo chấp cả trận, Tài/xỉu cả trận). TẤT CẢ các dòng thuộc cụm này đều mang period: 'FT'.
- Cột phải: Các mục Cược Hiệp 1 (1X2 Hiệp 1, Kèo chấp Hiệp 1, Cược Tài/Xỉu hiệp 1, Cược Tài/Xỉu tổng số bàn thắng hiệp 1). TẤT CẢ các dòng thuộc cụm này BẮT BUỘC mang period: 'HT'.

QUY TẮC BẮT BUỘC:
1. Mọi kèo nằm dưới tiêu đề chứa "Hiệp 1", "H1", "1st Half" BẮT BUỘC gán period: "HT" và phân loại đối tượng rõ ràng [Tài/Xỉu Bàn H1] hoặc [Châu Á Bàn H1].
2. TUYỆT ĐỐI KHÔNG BAO GIỜ dán nhãn kèo Hiệp 1 thành [Tài/Xỉu Bàn FT] hay FT!
3. Phân biệt RÕ RÀNG kèo Bàn Thắng ("goals") và Phạt Góc ("corners"), cũng như Toàn Trận ("FT") và Hiệp 1 ("HT").
4. BẮT BUỘC trả về DUY NHẤT một chuỗi JSON thuần hợp lệ, TUYỆT ĐỐI KHÔNG dùng markdown block (\`\`\`json hoặc \`\`\`), không có văn bản hay lời chào nào ngoài JSON.
`

export async function POST(req: Request) {
    try {
        const body = (await req.json()) as {
            images?: ImageInput[]
            home?: string
            away?: string
            league?: string
        }

        if (!body.images || !Array.isArray(body.images) || body.images.length === 0) {
            return new Response(JSON.stringify({ error: 'Cần ít nhất 1 ảnh bảng kèo.' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            })
        }

        const result = await extractOddsFromImages(body.images, {
            home: body.home,
            away: body.away,
            league: body.league,
        })

        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })
    } catch (err) {
        return new Response(
            JSON.stringify({ error: err instanceof Error ? err.message : 'Lỗi OCR bảng kèo.' }),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            },
        )
    }
}
