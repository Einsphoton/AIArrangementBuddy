import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

const API_TARGET = process.env.AIAB_API_URL || 'http://127.0.0.1:8787'
const WEB_PORT = Number(process.env.AIAB_WEB_PORT || 5183)

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@aiab/core': path.resolve(__dirname, '../../packages/core/src/index.ts'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
  optimizeDeps: {
    exclude: ['@aiab/core'],
  },
  server: {
    port: WEB_PORT,
    // 端口被占用时自动顺延（开发机上 5183 可能被别的项目占着）
    strictPort: false,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/soundfonts': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
})
