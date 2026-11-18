import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/auth': 'http://127.0.0.1:3000',
      '/vaults': 'http://127.0.0.1:3000',
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'codemirror-view', test: /node_modules[\\/]@codemirror[\\/]view/, priority: 30 },
            { name: 'codemirror-core', test: /node_modules[\\/]@codemirror[\\/]/, priority: 20 },
            { name: 'codemirror-lezer', test: /node_modules[\\/]@lezer[\\/]/, priority: 20 },
            { name: 'vue-vendor', test: /node_modules[\\/](@vue|vue|vue-router)[\\/]/, priority: 20 },
            { name: 'vendor', test: /node_modules[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
  },
})
