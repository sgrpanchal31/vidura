import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    envPrefix: ['VITE_', 'LANGFUSE_'],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'workers/embed.worker': resolve('src/main/workers/embed.worker.ts'),
          'workers/tts.worker': resolve('src/main/workers/tts.worker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
    },
    plugins: [react()],
  },
})
