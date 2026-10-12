import React from 'react'
import { compressImageToJpegBase64 } from '../lib/ocr-client'

export { compressImageToJpegBase64 }

export const OCR_CANVAS_CONFIG = {
    maxWidth: 2560,
    jpegQuality: 0.95,
    maxDirectFileSize: 3.5 * 1024 * 1024, // 3.5 MB
    maxAllowedFileSize: 8 * 1024 * 1024, // 8 MB
}

export interface OddsUploadProps {
    onFilesSelected: (files: File[]) => void
    disabled?: boolean
    extracting?: boolean
    parseHint?: string | null
    maxImages?: number
}

/**
 * High-Clarity Odds Upload Component & Pre-processing Hub.
 *
 * UN-COMPRESS & PRESERVE IMAGE CLARITY SPEC:
 * 1. If uploaded image is under 4MB (< 3.5MB), DO NOT downscale down to 1280px.
 * 2. Increase max canvas dimension: maxWidth = 2560px (retaining native resolution if < 3.5MB).
 * 3. Increase JPEG export quality: canvas.toDataURL("image/jpeg", 0.95) or send PNG directly.
 * 4. Ensures tiny odds numbers (e.g. 1.74 vs 1.86) and small Vietnamese section titles remain razor-sharp.
 */
export const OddsUpload: React.FC<OddsUploadProps> = ({
    onFilesSelected,
    disabled = false,
    extracting = false,
    parseHint,
    maxImages = 4,
}) => {
    const fileInputRef = React.useRef<HTMLInputElement | null>(null)

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files) return
        const files = Array.from(e.target.files).slice(0, maxImages)
        if (files.length > 0) {
            onFilesSelected(files)
        }
        e.target.value = ''
    }

    return (
        <div className="flex flex-col items-center justify-center p-4 border border-dashed border-white/20 rounded-2xl bg-white/5 hover:border-emerald-400/50 transition-colors">
            <p className="text-sm text-ink-300 text-center">
                Kéo-thả ảnh bảng kèo vào đây, dán từ clipboard (Ctrl+V), hoặc chọn file.
            </p>
            <p className="mt-1 text-[11px] text-ink-500">
                Chế độ sắc nét Ultra-HD: Giữ nguyên độ phân giải gốc cho ảnh &lt; 3.5MB (chất lượng 95%).
            </p>
            <label
                className={`mt-3 inline-flex cursor-pointer items-center justify-center rounded-xl px-4 py-2 text-sm font-semibold text-black transition-all ${
                    extracting || disabled
                        ? 'cursor-not-allowed bg-white/35 text-ink-500'
                        : 'bg-white hover:bg-neutral-200'
                }`}
            >
                {extracting ? 'Đang bóc tách ma trận kèo…' : 'Chọn ảnh bảng kèo'}
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    disabled={disabled || extracting}
                    onChange={handleFileChange}
                />
            </label>
            {parseHint && <p className="mt-2 text-xs text-danger-400 text-center">{parseHint}</p>}
        </div>
    )
}

export default OddsUpload
