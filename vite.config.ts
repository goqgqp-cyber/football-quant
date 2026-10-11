import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
        },
    },
    server: {
        host: true,
        port: 5173,
        // G2 sẽ thêm proxy cho /api -> backend server. Frontend KHÔNG bao giờ gọi
        // Gemini/Upstash trực tiếp.
        proxy: {
            '/api': {
                target: process.env.VITE_DEV_API_TARGET || 'http://localhost:8787',
                changeOrigin: true,
            },
        },
    },
    build: {
        target: 'es2020',
        sourcemap: false,
        rollupOptions: {
            output: {
                manualChunks: {
                    react: ['react', 'react-dom'],
                    motion: ['framer-motion'],
                },
            },
        },
    },
})
