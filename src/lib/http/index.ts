import http from 'http'
import https from 'https'
import { URL } from 'url'

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  token?: string
  query?: { [key: string]: string | number | boolean | undefined }
}

export interface Response<T> {
  status: number
  headers: http.IncomingHttpHeaders
  body: T
  raw: string
}

export class HttpError extends Error {
  status: number
  body: unknown
  /** Stable error code from RFC 9457 `application/problem+json` body. */
  code?: string
  constructor(status: number, body: unknown, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.body = body
    if (body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string') {
      this.code = (body as { code: string }).code
    }
  }
}

const buildUrl = (baseUrl: string, p: string, query?: RequestOptions['query']): URL => {
  const url = new URL(p.startsWith('http') ? p : `${baseUrl.replace(/\/$/, '')}${p}`)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue
      url.searchParams.set(k, String(v))
    }
  }
  return url
}

const parseBody = (raw: string, contentType?: string): unknown => {
  if (!raw) return null
  const ct = (contentType || '').toLowerCase()
  // Forz returns application/problem+json for errors (RFC 9457) and application/json for success.
  if (ct.includes('json')) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  return raw
}

export const request = <T = unknown>(
  baseUrl: string,
  path: string,
  options: RequestOptions = {}
): Promise<Response<T>> =>
  new Promise((resolve, reject) => {
    const url = buildUrl(baseUrl, path, options.query)
    const lib = url.protocol === 'http:' ? http : https
    const method = (options.method || 'GET').toUpperCase()

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'forz-cli',
      ...(options.headers || {}),
    }
    if (options.token) headers['Authorization'] = `Bearer ${options.token}`

    let payload: string | undefined
    if (options.body !== undefined && options.body !== null) {
      payload = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(Buffer.byteLength(payload))
    }

    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          const body = parseBody(raw, res.headers['content-type']) as T
          const status = res.statusCode || 0
          if (status >= 200 && status < 300) {
            resolve({ status, headers: res.headers, body, raw })
          } else {
            reject(new HttpError(status, body, `${method} ${url.pathname} → HTTP ${status}`))
          }
        })
      }
    )

    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
