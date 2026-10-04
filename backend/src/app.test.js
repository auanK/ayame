import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from './app.js'

test('serves Nia only for GET /', async (t) => {
  const app = createApp()
  t.after(() => app.close())
  assert.equal(app.server.listening, false)
  const response = await app.inject({ method: 'GET', url: '/' })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8')
  assert.equal(response.body, 'Nia')

  for (const [method, url] of [
    ['GET', '/missing'],
    ['POST', '/'],
    ['HEAD', '/'],
  ]) {
    const response = await app.inject({ method, url })
    assert.equal(response.statusCode, 404)
  }
})
