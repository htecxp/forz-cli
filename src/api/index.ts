import { randomUUID } from 'crypto'

import { Config } from '../lib/config'
import { request, RequestOptions, Response } from '../lib/http'

export interface ForzClientOptions {
  baseUrl?: string
  token?: string
}

export interface Page<T> {
  /** The rows on this page. */
  data: T[]
  /** True when more pages remain — pass `nextCursor` to fetch the next page. */
  hasMore: boolean
  /** Cursor to pass as `cursor` on the next list request. */
  nextCursor?: string
}

export interface ListParams {
  cursor?: string
  /** 1–100, default 25 (server-enforced per CONT-07). */
  limit?: number
  [k: string]: string | number | boolean | undefined
}

export interface MutationOptions {
  /** ETag from a prior GET — required for update/delete (optimistic concurrency). */
  ifMatch?: string
  /** Override the idempotency key (auto-generated for financial creates). */
  idempotencyKey?: string
}

export interface Fetched<T> {
  data: T
  /** ETag from response — pass to `ifMatch` on the next update or delete. */
  etag?: string
}

/** Resources that require an `Idempotency-Key` on POST (financial). */
export const FINANCIAL_RESOURCES = new Set(['invoices', 'sales_orders'])

const parseLinkNextCursor = (link?: string): string | undefined => {
  if (!link) return undefined
  // RFC 5988 `Link: <url>; rel="next"` — extract `cursor` query param.
  const match = link.match(/<([^>]+)>\s*;\s*rel="next"/i)
  if (!match) return undefined
  try {
    const url = new URL(match[1], 'https://app.forz.io')
    return url.searchParams.get('cursor') || undefined
  } catch {
    return undefined
  }
}

/** Unwrap the `{data: ...}` envelope every Forz v2 response uses. */
const unwrap = <T>(body: unknown): T => {
  if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
    return (body as { data: T }).data
  }
  return body as T
}

export class Resource<T = Record<string, unknown>> {
  constructor(
    private readonly client: ForzClient,
    /** URL segment, e.g. `customers`. */
    readonly name: string,
    /** True if `Idempotency-Key` is required on POST. */
    private readonly financial = FINANCIAL_RESOURCES.has(name)
  ) {}

  private path(id?: string): string {
    const base = `/api/v2/${this.name}`
    return id ? `${base}/${encodeURIComponent(id)}` : base
  }

  async list(params: ListParams = {}): Promise<Page<T>> {
    const res = await this.client.raw<{ data: T[]; has_more: boolean }>(this.path(), {
      query: params,
    })
    return {
      data: res.body.data,
      hasMore: res.body.has_more,
      nextCursor: parseLinkNextCursor(res.headers.link as string | undefined),
    }
  }

  async get(id: string): Promise<Fetched<T>> {
    const res = await this.client.raw<{ data: T } | T>(this.path(id))
    // ETag is returned verbatim so it can be passed straight back as If-Match — the
    // weak-ETag form W/"<epoch>-<lock_version>" (quotes included) must not be altered.
    return { data: unwrap<T>(res.body), etag: res.headers.etag as string | undefined }
  }

  async create(input: Partial<T>, options: MutationOptions = {}): Promise<T> {
    const headers: Record<string, string> = {}
    if (this.financial) {
      headers['Idempotency-Key'] = options.idempotencyKey || randomUUID()
    } else if (options.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey
    }
    const res = await this.client.raw<{ data: T } | T>(this.path(), {
      method: 'POST',
      body: input,
      headers,
    })
    return unwrap<T>(res.body)
  }

  async update(id: string, patch: Partial<T>, options: MutationOptions = {}): Promise<T> {
    if (!options.ifMatch) {
      throw new Error(
        `${this.name}.update requires an If-Match ETag (run \`get\` first to obtain one).`
      )
    }
    const res = await this.client.raw<{ data: T } | T>(this.path(id), {
      method: 'PATCH',
      body: patch,
      headers: { 'If-Match': options.ifMatch },
    })
    return unwrap<T>(res.body)
  }

  async delete(id: string, options: MutationOptions = {}): Promise<void> {
    if (!options.ifMatch) {
      throw new Error(
        `${this.name}.delete requires an If-Match ETag (run \`get\` first to obtain one).`
      )
    }
    await this.client.raw(this.path(id), {
      method: 'DELETE',
      headers: { 'If-Match': options.ifMatch },
    })
  }
}

/** Read-only list resource (e.g. lookups, custom field definitions). */
export class ListResource<T = Record<string, unknown>> {
  constructor(private readonly client: ForzClient, readonly name: string) {}
  async list(params: ListParams = {}): Promise<Page<T>> {
    const res = await this.client.raw<{ data: T[]; has_more: boolean }>(`/api/v2/${this.name}`, {
      query: params,
    })
    return {
      data: res.body.data,
      hasMore: res.body.has_more,
      nextCursor: parseLinkNextCursor(res.headers.link as string | undefined),
    }
  }
}

/**
 * Client for the Forz Public API v2 (https://app.forz.io).
 *
 * Authenticates with a Bearer API key in the form `fz_<UUIDv7>`, minted at
 * /settings/api_keys.
 */
export class ForzClient {
  readonly baseUrl: string
  readonly token?: string

  constructor(options: ForzClientOptions = {}) {
    this.baseUrl = options.baseUrl || 'https://app.forz.io'
    this.token = options.token
  }

  static fromConfig(config: Config): ForzClient {
    return new ForzClient({ baseUrl: config.baseUrl, token: config.token })
  }

  raw<T = unknown>(path: string, options: RequestOptions = {}): Promise<Response<T>> {
    return request<T>(this.baseUrl, path, { ...options, token: this.token })
  }

  resource<T = Record<string, unknown>>(name: string): Resource<T> {
    return new Resource<T>(this, name)
  }

  lookup<T = Record<string, unknown>>(name: string): ListResource<T> {
    return new ListResource<T>(this, name)
  }
}

export default {
  ForzClient,
  Resource,
  ListResource,
  FINANCIAL_RESOURCES,
}
