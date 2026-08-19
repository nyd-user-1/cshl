import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Heavy libraries get their own long-cached chunks so a deploy that
        // only touches app code never re-downloads them.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          markdown: ['react-markdown', 'remark-math', 'rehype-katex'],
          katex: ['katex'],
          recharts: ['recharts'],
          xyflow: ['@xyflow/react'],
        },
      },
    },
  },
  server: {
    port: 3000,
    // /api/* → production so every page works locally against real data
    // (Vercel functions don't run under vite).
    proxy: { "/api": { target: "https://nsr.nysgpt.com", changeOrigin: true } },
  },
})
