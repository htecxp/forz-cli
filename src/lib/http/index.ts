import http from 'http'
import https from 'https'
import { URL } from 'url'

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  token?: string
  query?: { [key: string]: string | number | boolean | undefined }
  /** Socket idle timeout in ms; unset = none. */
  timeout?: number
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
  /** Response headers (Retry-After, ETag, Location, content-type, …). */
  headers: http.IncomingHttpHeaders
  constructor(
    status: number,
    body: unknown,
    message: string,
    headers: http.IncomingHttpHeaders = {}
  ) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.body = body
    this.headers = headers
    if (body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string') {
      this.code = (body as { code: string }).code
    }
  }
}

/** Bad invocation (exit code 2), as opposed to an API/network failure (exit code 1). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:\/\//i

/** Strip trailing slashes and a trailing `/api/v2` (paths already carry it). */
export const normalizeBaseUrl = (url: string): string =>
  url.replace(/\/+$/, '').replace(/\/api\/v2$/i, '')

const buildUrl = (baseUrl: string, p: string, query?: RequestOptions['query']): URL => {
  const base = normalizeBaseUrl(baseUrl)
  const url = new URL(ABSOLUTE.test(p) ? p : `${base}${p.startsWith('/') ? '' : '/'}${p}`)
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

const RETRY_MAX = 3

/**
 * 429 is rejected before the app runs, so always safe to retry. A proxy can send
 * 502/503/504 after the app already applied a write, so those only when a replay
 * can't double-apply (GET/HEAD or an Idempotency-Key).
 */
const retryable = (status: number, method: string, idempotent: boolean): boolean =>
  status === 429 ||
  ([502, 503, 504].includes(status) && (method === 'GET' || method === 'HEAD' || idempotent))

/** Retry-After (seconds or HTTP-date), else exponential backoff with jitter. */
export const retryDelayMs = (attempt: number, retryAfter?: string): number => {
  if (retryAfter) {
    const secs = Number(retryAfter)
    const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(retryAfter) - Date.now()
    // ponytail: capped at 60s so a hostile/buggy header can't park the CLI for hours.
    if (!Number.isNaN(ms)) return Math.min(Math.max(ms, 0), 60_000)
  }
  return 2 ** attempt * 500 + Math.random() * 250
}

export const request = async <T = unknown>(
  baseUrl: string,
  path: string,
  options: RequestOptions = {}
): Promise<Response<T>> => {
  const method = (options.method || 'GET').toUpperCase()
  const idempotent = Object.keys(options.headers || {}).some(
    (k) => k.toLowerCase() === 'idempotency-key'
  )
  for (let attempt = 0; ; attempt++) {
    try {
      return await once<T>(baseUrl, path, options)
    } catch (e) {
      if (
        !(e instanceof HttpError) ||
        attempt >= RETRY_MAX ||
        !retryable(e.status, method, idempotent)
      )
        throw e
      const retryAfter = e.headers['retry-after']
      await new Promise((r) =>
        setTimeout(
          r,
          retryDelayMs(attempt, typeof retryAfter === 'string' ? retryAfter : undefined)
        )
      )
    }
  }
}

const once = <T>(baseUrl: string, path: string, options: RequestOptions): Promise<Response<T>> =>
  new Promise((resolve, reject) => {
    const url = buildUrl(baseUrl, path, options.query)
    // Never hand the Bearer token to a host other than the configured API.
    if (options.token && url.origin !== new URL(normalizeBaseUrl(baseUrl)).origin) {
      throw new UsageError(
        `Refusing to send the API token to ${url.origin} (base URL is ${normalizeBaseUrl(
          baseUrl
        )}).`
      )
    }
    const lib = url.protocol === 'http:' ? http : https
    const method = (options.method || 'GET').toUpperCase()

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'forz-cli',
      ...(options.headers || {}),
    }
    if (options.token) headers['Authorization'] = `Bearer ${options.token}`

    let payload: string | Buffer | undefined
    if (options.body !== undefined && options.body !== null) {
      payload =
        typeof options.body === 'string' || Buffer.isBuffer(options.body)
          ? options.body
          : JSON.stringify(options.body)
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
            reject(
              new HttpError(status, body, `${method} ${url.pathname} → HTTP ${status}`, res.headers)
            )
          }
        })
      }
    )

    // Node's ECONNREFUSED can be an AggregateError with an empty message; name code + host.
    req.on('error', (e: NodeJS.ErrnoException) =>
      reject(
        Object.assign(new Error(`${method} ${url.host}: ${e.message || e.code}`), { code: e.code })
      )
    )
    // Wall-clock deadline, not req.setTimeout: Node 19+'s keep-alive globalAgent sets a 5s
    // socket idle timeout that would fire first and be misreported as ours.
    const timeout = options.timeout
    if (timeout) {
      const timer = setTimeout(
        () =>
          req.destroy(
            Object.assign(new Error(`timed out after ${timeout / 1000}s`), { code: 'ETIMEDOUT' })
          ),
        timeout
      )
      req.on('close', () => clearTimeout(timer))
    }
    if (payload) req.write(payload)
    req.end()
  })
