import { describe, expect, it } from 'vitest'
import config from './vite.config.js'

describe('Vite API proxies', () => {
  it('proxies auth and vault routes to the backend', () => {
    expect(config.server.proxy['/auth']).toBe('http://127.0.0.1:3000')
    expect(config.server.proxy['/vaults']).toBe('http://127.0.0.1:3000')
  })
})
