import http from 'http'
import { AddressInfo } from 'net'

import { HttpError, normalizeBaseUrl, request, retryDelayMs, UsageError } from '../src/lib/http'

// A throwaway local server; `handler` decides each response.
let server: http.Server
let base: string
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void

beforeAll(async () => {
  server = http.createServer((req, res) => handler(req, res))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise((r) => server.close(r)))

describe('request retries', () => {
  it('retries 503 honoring Retry-After, then succeeds', async () => {
    let calls = 0
    handler = (_req, res) => {
      calls++
      if (calls < 3) res.writeHead(503, { 'Retry-After': '0' }).end()
      else res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
    }
    const res = await request(base, '/x')
    expect(res.body).toEqual({ ok: true })
    expect(calls).toBe(3)
  })

  it('does not retry a POST 502 without an Idempotency-Key, and keeps headers', async () => {
    let calls = 0
    handler = (_req, res) => {
      calls++
      res.writeHead(502, { 'X-Test': 'yes' }).end('bad gateway')
    }
    const err = await request(base, '/x', { method: 'POST', body: {} }).catch((e) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect(err.headers['x-test']).toBe('yes')
    expect(calls).toBe(1)
  })

  it('does not replay a POST 503 without an Idempotency-Key, but does with one', async () => {
    let calls = 0
    handler = (_req, res) => {
      calls++
      res.writeHead(503, { 'Retry-After': '0' }).end()
    }
    await expect(request(base, '/x', { method: 'POST', body: {} })).rejects.toThrow(/503/)
    expect(calls).toBe(1)
    calls = 0
    const keyed = { method: 'POST', body: {}, headers: { 'Idempotency-Key': 'k' } }
    await expect(request(base, '/x', keyed)).rejects.toThrow(/503/)
    expect(calls).toBe(4)
  })

  it('reads Retry-After as seconds or an HTTP-date', () => {
    expect(retryDelayMs(0, '2')).toBe(2000)
    expect(retryDelayMs(0, new Date(Date.now() - 1000).toUTCString())).toBe(0)
  })
})

describe('request safety', () => {
  it('times out a stalled server', async () => {
    handler = () => undefined // never respond
    await expect(request(base, '/x', { timeout: 100 })).rejects.toThrow(/timed out/)
  })

  it('refuses to send the token to another origin', async () => {
    const p = request('https://app.forz.io', 'https://evil.example/steal', { token: 'fz_x' })
    await expect(p).rejects.toThrow(/Refusing to send the API token/)
    await expect(p).rejects.toBeInstanceOf(UsageError) // exit 2: no request was made
  })

  it('accepts a relative path without a leading slash', async () => {
    handler = (req, res) => res.writeHead(200).end(req.url)
    expect((await request(`${base}/`, 'api/v2/me')).body).toBe('/api/v2/me')
  })

  it('names the error code and host on connection failure', async () => {
    await expect(request('http://127.0.0.1:1', '/x')).rejects.toThrow(
      /127\.0\.0\.1:1: .*ECONNREFUSED/
    )
  })
})

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes and /api/v2', () => {
    expect(normalizeBaseUrl('https://app.forz.io/api/v2/')).toBe('https://app.forz.io')
    expect(normalizeBaseUrl('http://localhost:3000/')).toBe('http://localhost:3000')
  })
})
