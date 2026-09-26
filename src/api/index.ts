import { randomUUID } from 'crypto'

import { Config } from '../lib/config'
import { normalizeBaseUrl, request, RequestOptions, Response } from '../lib/http'

export interface ForzClientOptions {
  baseUrl?: string
  token?: string
  /** Per-request socket timeout in ms (default 30000). */
  timeout?: number
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

/** A user-authored comment on a record (`/api/v2/<resource>/{id}/notes`). */
export interface Note {
  id: string
  description: string
  author_id?: number | null
  author_name?: string | null
  created_at: string
  updated_at: string
}

/** Link from a contact to a Customer / Lead / Site (`/api/v2/contacts/{id}/linkages`). */
export interface ContactLinkage {
  id: string
  linkable_id?: string
  linkable_type?: string
  relationship_type?: string
  primary?: boolean
  [k: string]: unknown
}

/** Resources that require an `Idempotency-Key` on POST (financial). */
export const FINANCIAL_RESOURCES = new Set(['invoices', 'sales_orders'])

/** Resources whose attachment-type custom fields can be uploaded via the API. */
export const ATTACHABLE_RESOURCES = new Set([
  'customers',
  'sites',
  'contacts',
  'jobs',
  'estimates',
  'invoices',
  'sales_orders',
  'items',
  'leads',
  'deals',
])

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

  // The server reads `params.require(:job)`, and Rails only auto-wraps a flat body's
  // column names, so a flat `lineitems` / project `user_ids` would be silently dropped.
  // Send `{job: {...}}`; a body already carrying the key passes through.
  private wrap(body: unknown): unknown {
    const key = this.name.replace(/s$/, '')
    if (!body || typeof body !== 'object' || Array.isArray(body) || key in body) return body
    return { [key]: body }
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
      body: this.wrap(input),
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
      body: this.wrap(patch),
      headers: { 'If-Match': options.ifMatch },
    })
    return unwrap<T>(res.body)
  }

  /**
   * PUT /api/v2/<resource>/{id}/custom_fields/{field_id} — upload a file into an
   * attachment-type custom field (multipart `file` part). Returns the updated record.
   */
  async setCustomFieldAttachment(
    id: string,
    fieldId: string,
    file: { filename: string; data: Buffer },
    options: MutationOptions
  ): Promise<Fetched<T>> {
    const boundary = `forz-${randomUUID()}`
    const name = file.filename.replace(/["\r\n]/g, '_')
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n'
      ),
      file.data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const res = await this.client.raw<{ data: T } | T>(this.cfPath(id, fieldId), {
      method: 'PUT',
      body,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'If-Match': this.requireIfMatch('setCustomFieldAttachment', options),
      },
    })
    return { data: unwrap<T>(res.body), etag: res.headers.etag as string | undefined }
  }

  /** DELETE /api/v2/<resource>/{id}/custom_fields/{field_id} — clear an attachment field. */
  async clearCustomFieldAttachment(
    id: string,
    fieldId: string,
    options: MutationOptions
  ): Promise<Fetched<T>> {
    const res = await this.client.raw<{ data: T } | T>(this.cfPath(id, fieldId), {
      method: 'DELETE',
      headers: { 'If-Match': this.requireIfMatch('clearCustomFieldAttachment', options) },
    })
    return { data: unwrap<T>(res.body), etag: res.headers.etag as string | undefined }
  }

  private cfPath(id: string, fieldId: string): string {
    return `${this.path(id)}/custom_fields/${encodeURIComponent(fieldId)}`
  }

  private requireIfMatch(op: string, options: MutationOptions): string {
    if (!options.ifMatch) throw new Error(`${this.name}.${op} requires an ETag (options.ifMatch)`)
    return options.ifMatch
  }

  /** GET /api/v2/<resource>/{id}/notes — user-authored comments on a record. */
  async listNotes(id: string, params: ListParams = {}): Promise<Page<Note>> {
    const res = await this.client.raw<{ data: Note[]; has_more: boolean }>(
      `${this.path(id)}/notes`,
      { query: params }
    )
    return {
      data: res.body.data,
      hasMore: res.body.has_more,
      nextCursor: parseLinkNextCursor(res.headers.link as string | undefined),
    }
  }

  /** POST /api/v2/<resource>/{id}/notes — body is wrapped as `{note: {description}}`. */
  async createNote(id: string, description: string): Promise<Note> {
    const res = await this.client.raw<{ data: Note }>(`${this.path(id)}/notes`, {
      method: 'POST',
      body: { note: { description } },
    })
    return unwrap<Note>(res.body)
  }

  /** GET /api/v2/contacts/{id}/linkages — not paginated. */
  async listLinkages(id: string): Promise<ContactLinkage[]> {
    const res = await this.client.raw<{ data: ContactLinkage[] }>(`${this.path(id)}/linkages`)
    return unwrap<ContactLinkage[]>(res.body)
  }

  /** POST /api/v2/contacts/{id}/linkages — body wrapped as `{linkage: {...}}`. */
  async createLinkage(id: string, body: Record<string, unknown>): Promise<ContactLinkage> {
    const res = await this.client.raw(`${this.path(id)}/linkages`, {
      method: 'POST',
      body: 'linkage' in body ? body : { linkage: body },
    })
    return unwrap<ContactLinkage>(res.body)
  }

  /** PATCH /api/v2/contacts/{id}/linkages/{linkage_id} — no ETag on linkages. */
  async updateLinkage(
    id: string,
    linkageId: string,
    body: Record<string, unknown>
  ): Promise<ContactLinkage> {
    const res = await this.client.raw(
      `${this.path(id)}/linkages/${encodeURIComponent(linkageId)}`,
      {
        method: 'PATCH',
        body: 'linkage' in body ? body : { linkage: body },
      }
    )
    return unwrap<ContactLinkage>(res.body)
  }

  /** DELETE /api/v2/contacts/{id}/linkages/{linkage_id} — 409 contact.primary_linkage on a primary. */
  async deleteLinkage(id: string, linkageId: string): Promise<void> {
    await this.client.raw(`${this.path(id)}/linkages/${encodeURIComponent(linkageId)}`, {
      method: 'DELETE',
    })
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
  readonly timeout: number

  constructor(options: ForzClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl || 'https://app.forz.io')
    this.token = options.token
    this.timeout = options.timeout ?? 30_000
  }

  static fromConfig(config: Config & Pick<ForzClientOptions, 'timeout'>): ForzClient {
    return new ForzClient({ baseUrl: config.baseUrl, token: config.token, timeout: config.timeout })
  }

  raw<T = unknown>(path: string, options: RequestOptions = {}): Promise<Response<T>> {
    return request<T>(this.baseUrl, path, { timeout: this.timeout, ...options, token: this.token })
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
