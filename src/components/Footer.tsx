export function Footer() {
    return (
        <footer className="mt-8 border-t border-white/10 pt-5 pb-6 text-center text-xs leading-relaxed text-ink-500">
            <p className="font-semibold text-ink-400">
                Football Quant <span className="font-mono text-ink-500">v0.1.0</span> · Poisson · Dixon-Coles · Qwen
            </p>
            <p className="mt-1">
                ⚠️ Phân tích xác suất toán học, không bảo đảm kết quả. Chỉ cược số tiền bạn chấp nhận mất.
            </p>
            <p className="mt-0.5 text-[11px] text-ink-600">
                Hệ thống tuân thủ nguyên tắc quản lý vốn (Kelly Criterion). Tuyệt đối không có tính năng All-in hay gấp thếp.
            </p>
        </footer>
    )
}
