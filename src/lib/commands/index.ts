import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { IncomingHttpHeaders } from 'http'
import path from 'path'

import { ATTACHABLE_RESOURCES, FINANCIAL_RESOURCES, ForzClient } from '../../api'
import * as config from '../config'
import { HttpError, normalizeBaseUrl, UsageError } from '../http'

const unwrap = (body: unknown): unknown =>
  body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)
    ? (body as { data: unknown }).data
    : body

/** Shape of the GET /api/v2/me payload (after `unwrap`). */
export interface MeIdentity {
  account?: { id?: number; name?: string } | null
  user?: { id?: number; name?: string; email?: string } | null
  api_key?: { id?: string; scopes?: string[] } | null
  api_version?: string | null
}

/**
 * One-line stderr summary for `forz whoami`. There is a single environment, so
 * the line is "# connected to <account name> as <email>" — no (env) segment.
 */
export const whoamiSummary = (me: MeIdentity): string => {
  const account = me?.account?.name ?? 'unknown account'
  const email = me?.user?.email ?? 'unknown user'
  return `# connected to ${account} as ${email}`
}

export interface ParsedArgs {
  positional: string[]
  flags: Record<string, string | boolean>
}

/** Flags that never take a value, so `--include /path` keeps `/path` positional. */
const BOOLEAN_FLAGS = new Set(['help', 'version', 'include'])

// A flag's value may itself start with '-' (`--sort -created_at`, `--add "-foo"`,
// `--body @-`); only a following `--flag` token means "no value".
export const parseArgs = (argv: string[]): ParsedArgs => {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = a.slice(2, eq >= 0 ? eq : undefined)
      if (eq >= 0) flags[name] = a.slice(eq + 1)
      else if (!BOOLEAN_FLAGS.has(name) && i + 1 < argv.length && !argv[i + 1].startsWith('--'))
        flags[name] = argv[++i]
      else flags[name] = true
    } else if (a.startsWith('-') && a.length > 1) {
      flags[a.slice(1)] = true
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

export { UsageError }

/** String value of a flag; a flag given with no value is a usage error, never a silent fallback. */
const flag = (args: ParsedArgs, name: string): string | undefined => {
  const v = args.flags[name]
  if (v === undefined) return undefined
  if (typeof v !== 'string' || v === '')
    throw new UsageError(
      `--${name} requires a value (for one starting with --, use --${name}=<value>)`
    )
  return v
}

/** Full CRUD resources (list, get, create, update, delete). */
export const CRUD_RESOURCES = [
  'customers',
  'sites',
  'contacts',
  'jobs',
  'estimates',
  'invoices',
  'sales_orders',
  'items',
  'tasks',
  'leads',
  'deals',
  'projects',
] as const

/** Read-only records: `list`, `get <id>` and `notes` — no create/update/delete in v2. */
export const READONLY_RESOURCES = [
  'assets',
  'vendors',
  'tickets',
  'purchase_orders',
  'recurring_jobs',
  'recurring_invoices',
] as const

/** Read-only lookups (list only, except `custom_field_definitions` which also supports `get`). */
export const LOOKUPS = [
  'payment_terms',
  'tax_rates',
  'job_types',
  'item_categories',
  'system_options',
  'labels',
  'statuses',
  'custom_field_definitions',
] as const

/** Lookups that additionally expose a `get <id>` endpoint. */
export const GETTABLE_LOOKUPS = new Set(['custom_field_definitions'])

/** List + create only (no get/update/delete/notes in v2). */
export const LIST_CREATE_RESOURCES = ['systems'] as const

/** CRUD resources with no `/{id}/notes` route in v2. */
const NO_NOTES = new Set(['items'])

const print = (value: unknown): void => {
  if (value === undefined) return
  if (typeof value === 'string') console.log(value)
  else console.log(JSON.stringify(value, null, 2))
}

const printPage = (page: { data: unknown[]; hasMore: boolean; nextCursor?: string }): void => {
  print(page.data)
  if (page.hasMore && page.nextCursor) {
    console.error(`# more available — re-run with --cursor ${page.nextCursor}`)
  }
}

const readBodyFile = (file: string): string => {
  try {
    return readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      throw new UsageError(`--body file not found: ${file}`)
    throw e
  }
}

const readBodyFlag = (args: ParsedArgs): unknown => {
  const raw = flag(args, 'body')
  if (raw === undefined) return undefined
  const text = !raw.startsWith('@')
    ? raw
    : raw === '@-'
    ? readFileSync(0, 'utf8')
    : readBodyFile(raw.slice(1))
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new UsageError(`--body is not valid JSON: ${(e as Error).message}`)
  }
}

/** Like readBodyFlag, but create/update/linkage bodies must be a JSON object. */
const readObjectBody = (args: ParsedArgs): Record<string, unknown> | undefined => {
  const body = readBodyFlag(args)
  if (body === undefined) return undefined
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new UsageError('--body must be a JSON object')
  return body as Record<string, unknown>
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type CfTemplate = { parent_id: string | null; fields: { id: string; label: string }[] }

/**
 * Custom fields may be named by label as well as id: returns a resolver mapping a non-UUID
 * key (case-insensitively) to its field id via custom_field_definitions, fetched once, lazily.
 */
const customFieldResolver = (c: ForzClient, resource: string) => {
  let fields: CfTemplate['fields'] | undefined
  return async (key: string): Promise<string> => {
    if (UUID_RE.test(key)) return key
    if (!fields) {
      // customers → Customer, sales_orders → SalesOrder (the template's related_name).
      const relatedName = resource
        .replace(/s$/, '')
        .split('_')
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join('')
      const { data } = await c
        .lookup<CfTemplate>('custom_field_definitions')
        .list({ related_name: relatedName, limit: 100 })
      fields = ([] as CfTemplate['fields']).concat(
        ...data.filter((t) => !t.parent_id).map((t) => t.fields)
      )
    }
    const hit = fields.find((f) => f.label.trim().toLowerCase() === key.trim().toLowerCase())
    if (hit) return hit.id
    const known = fields.map((f) => `"${f.label}"`).join(', ') || 'none defined'
    throw new UsageError(`Unknown custom field "${key}" on ${resource}. Fields: ${known}`)
  }
}

/** Resolve label keys in a create/update body's `custom_fields` (flat or wrapped). Mutates `body`. */
const resolveCustomFieldLabels = async (
  c: ForzClient,
  resource: string,
  body: Record<string, unknown>
): Promise<void> => {
  const wrapped = body[resource.replace(/s$/, '')]
  const target = (wrapped && typeof wrapped === 'object' ? wrapped : body) as Record<
    string,
    unknown
  >
  const cf = target.custom_fields
  if (!cf || typeof cf !== 'object' || Array.isArray(cf)) return
  const resolve = customFieldResolver(c, resource)
  const resolved: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(cf as Record<string, unknown>)) resolved[await resolve(k)] = v
  target.custom_fields = resolved
}

/** `--filter.custom_fields[<label>] v` → `custom_fields[<field id>]=v`. Mutates `params`. */
const resolveCustomFieldFilters = async (
  c: ForzClient,
  resource: string,
  params: Record<string, unknown>
): Promise<void> => {
  const resolve = customFieldResolver(c, resource)
  for (const k of Object.keys(params)) {
    const m = /^custom_fields\[(.+)\]$/.exec(k)
    if (!m || UUID_RE.test(m[1])) continue
    params[`custom_fields[${await resolve(m[1])}]`] = params[k]
    delete params[k]
  }
}

const buildListParams = (
  args: ParsedArgs
): { cursor?: string; limit?: number; [k: string]: string | number | boolean | undefined } => {
  const params: Record<string, string | number | boolean | undefined> = {}
  const cursor = flag(args, 'cursor')
  if (cursor !== undefined) params.cursor = cursor
  const limit = flag(args, 'limit')
  if (limit !== undefined) {
    if (!/^[1-9]\d*$/.test(limit))
      throw new UsageError(`--limit must be a positive integer (got ${limit})`)
    params.limit = Number(limit)
  }
  // First-class sort + free-text search (allowed on every CRUD list endpoint).
  const sort = flag(args, 'sort')
  if (sort !== undefined) params.sort = sort
  const q = flag(args, 'q')
  if (q !== undefined) params.q = q
  // Forward any --filter.<key> <value> filters as raw query params, e.g.
  // `--filter.status Open` or `--filter.created_at[gte] 2026-01-01T00:00:00Z`.
  for (const k of Object.keys(args.flags)) {
    if (k.startsWith('filter.')) params[k.slice('filter.'.length)] = flag(args, k)
  }
  return params
}

/** --timeout <sec> > FORZ_TIMEOUT > the client's 30s default. Returns ms. */
const timeoutMs = (args: ParsedArgs): number | undefined => {
  const raw = flag(args, 'timeout') ?? process.env.FORZ_TIMEOUT
  if (raw === undefined || raw === '') return undefined
  const secs = Number(raw)
  // setTimeout treats > 2^31-1 ms as 1 ms, so a huge value would time out instantly.
  if (!(secs > 0) || secs > 2_147_483)
    throw new UsageError(
      `--timeout / FORZ_TIMEOUT must be a positive number of seconds up to 2147483 (got ${raw})`
    )
  return secs * 1000
}

/** Normalized http(s) base URL, or a usage error naming where the bad value came from. */
const checkBaseUrl = (value: string, source: string): string => {
  const url = normalizeBaseUrl(value)
  let ok = false
  try {
    ok = ['http:', 'https:'].includes(new URL(url).protocol)
  } catch {
    // not a URL
  }
  if (!ok) throw new UsageError(`${source} must be an http(s) URL (got ${value})`)
  return url
}

/** --base-url flag > FORZ_BASE_URL env (validated); undefined means use the saved config. */
const baseUrlOverride = (args: ParsedArgs): string | undefined => {
  const fromFlag = flag(args, 'base-url')
  if (fromFlag !== undefined) return checkBaseUrl(fromFlag, '--base-url')
  const fromEnv = process.env.FORZ_BASE_URL
  return fromEnv ? checkBaseUrl(fromEnv, 'FORZ_BASE_URL') : undefined
}

// Precedence: --base-url / --token flag > FORZ_BASE_URL / FORZ_TOKEN env > saved config.
const client = async (args: ParsedArgs): Promise<ForzClient> => {
  const baseUrl = baseUrlOverride(args)
  const token = flag(args, 'token') ?? (process.env.FORZ_TOKEN || undefined)
  const timeout = timeoutMs(args)
  const cfg = await config.load()
  cfg.baseUrl = baseUrl ?? checkBaseUrl(cfg.baseUrl, `baseUrl in ${config.configPath()}`)
  if (token) cfg.token = token
  if (!cfg.token) {
    throw new UsageError('Not authenticated. Run `forz login --token <api-key>` or set FORZ_TOKEN.')
  }
  return ForzClient.fromConfig({ ...cfg, timeout })
}

// --- Top-level command handlers ---

const login = async (args: ParsedArgs): Promise<void> => {
  const token = flag(args, 'token')
  if (!token) {
    throw new UsageError(
      'Missing --token. Mint a key at /settings/api_keys, then run:\n  forz login --token fz_<uuid>'
    )
  }
  if (!/^fz_[0-9a-fA-F-]{36}$/.test(token)) {
    console.error(`# warning: token does not match expected format fz_<UUIDv7>`)
  }
  // Save the host the key is verified against (flag > env), never silently the default.
  const baseUrl = baseUrlOverride(args)
  // Verify against /me before saving so a typo'd key never lands in the config.
  const c = await client({
    ...args,
    flags: { ...args.flags, token, ...(baseUrl ? { 'base-url': baseUrl } : {}) },
  })
  const res = await c.raw('/api/v2/me')
  const next = await config.update({ token, ...(baseUrl ? { baseUrl } : {}) })
  console.log(`Saved credentials to ${config.configPath()}`)
  console.log(`Base URL: ${next.baseUrl}`)
  console.error(whoamiSummary(unwrap(res.body) as MeIdentity))
}

const logout = async (): Promise<void> => {
  await config.clear()
  console.log('Logged out.')
}

const ping = async (args: ParsedArgs): Promise<void> => {
  const c = await client(args)
  // GET /api/v2/me needs no scope, so any valid key passes. RateLimit-* here is the
  // read (GET) bucket; writes are throttled separately.
  const res = await c.raw('/api/v2/me')
  const limit = res.headers['ratelimit-limit']
  const remaining = res.headers['ratelimit-remaining']
  console.log(`OK — HTTP ${res.status} from ${c.baseUrl}`)
  if (limit && remaining) console.log(`RateLimit: ${remaining}/${limit} remaining`)
}

// `forz whoami` — confirm which account/user this key belongs to before mutating.
// JSON payload to stdout (pipeable: `forz whoami | jq .account`); a single human
// summary line to stderr so it never pollutes the JSON.
const whoami = async (args: ParsedArgs): Promise<void> => {
  const c = await client(args)
  const res = await c.raw('/api/v2/me')
  const me = unwrap(res.body) as MeIdentity
  print(me)
  console.error(whoamiSummary(me))
}

const CONFIG_KEYS = ['baseUrl', 'token']

const configCmd = async (args: ParsedArgs): Promise<void> => {
  const [sub, key, value] = args.positional
  if (!sub || sub === 'show') {
    const cfg = await config.load()
    print({ ...cfg, token: cfg.token ? '***' : undefined })
    return
  }
  if (sub === 'set') {
    if (!key || !value)
      throw new UsageError(`Usage: forz config set <${CONFIG_KEYS.join('|')}> <value>`)
    if (!CONFIG_KEYS.includes(key)) {
      throw new UsageError(`Unknown config key: ${key} (known: ${CONFIG_KEYS.join(', ')})`)
    }
    await config.update({ [key]: key === 'baseUrl' ? checkBaseUrl(value, 'baseUrl') : value })
    console.log(`Set ${key}`)
    return
  }
  throw new UsageError(`Unknown config subcommand: ${sub}`)
}

// --- Resource dispatcher ---

const is = (list: readonly string[], name: string): boolean => list.includes(name)

const dispatchResource = async (resource: string, args: ParsedArgs): Promise<void> => {
  const [verb, ...rest] = args.positional
  const usage = (msg: string) =>
    new UsageError(`${msg}\nRun \`forz ${resource} --help\` for its commands.`)

  // Lookups: list-only (plus `get <id>` for gettable lookups).
  if (is(LOOKUPS, resource)) {
    const gettable = GETTABLE_LOOKUPS.has(resource)
    if (verb && verb !== 'list' && !(verb === 'get' && gettable)) {
      throw usage(`${resource} is a read-only lookup (list only${gettable ? ', get <id>' : ''}).`)
    }
    if (verb === 'get') {
      const [id] = rest
      if (!id) throw usage(`Usage: forz ${resource} get <id>`)
      const c = await client(args)
      const res = await c.raw(`/api/v2/${resource}/${encodeURIComponent(id)}`)
      print(unwrap(res.body))
      return
    }
    const params = buildListParams(args)
    printPage(await (await client(args)).lookup(resource).list(params))
    return
  }

  const readonly = is(READONLY_RESOURCES, resource)
  const listCreate = is(LIST_CREATE_RESOURCES, resource)
  if (readonly && ['create', 'update', 'delete'].includes(verb)) {
    throw usage(`${resource} is read-only in API v2 (list, get, notes only).`)
  }
  if (listCreate && verb && !['list', 'create'].includes(verb)) {
    throw usage(`${resource} supports only list and create in API v2.`)
  }

  switch (verb) {
    case 'notes': {
      if (NO_NOTES.has(resource)) throw usage(`${resource} has no notes in API v2.`)
      const [id] = rest
      if (!id) throw usage(`Usage: forz ${resource} notes <id> [--add <text>]`)
      const text = flag(args, 'add')
      if (text !== undefined) {
        print(await (await client(args)).resource(resource).createNote(id, text))
        return
      }
      const params = buildListParams(args)
      printPage(await (await client(args)).resource(resource).listNotes(id, params))
      return
    }
    case 'linkages': {
      if (resource !== 'contacts')
        throw usage(`Unknown verb for ${resource}: linkages (contacts only)`)
      const [id] = rest
      const updateId = flag(args, 'update')
      const deleteId = flag(args, 'delete')
      if ([args.flags.add, updateId, deleteId].filter(Boolean).length > 1)
        throw usage('Use only one of --add, --update, --delete')
      if (!id) {
        throw usage(
          'Usage: forz contacts linkages <id> [--add --body J | --update <linkage_id> --body J | --delete <linkage_id>]'
        )
      }
      const body = readObjectBody(args)
      if ((args.flags.add || updateId) && !body) throw usage('--body must be a JSON object')
      const obj = body as Record<string, unknown>
      const r = (await client(args)).resource(resource)
      if (args.flags.add) print(await r.createLinkage(id, obj))
      else if (updateId) print(await r.updateLinkage(id, updateId, obj))
      else if (deleteId) {
        await r.deleteLinkage(id, deleteId)
        console.log(`Deleted contacts/${id}/linkages/${deleteId}`)
      } else print(await r.listLinkages(id))
      return
    }
    case undefined:
    case 'list': {
      const params = buildListParams(args)
      const c = await client(args)
      await resolveCustomFieldFilters(c, resource, params)
      printPage(await c.resource(resource).list(params))
      return
    }
    case 'attach': {
      if (!ATTACHABLE_RESOURCES.has(resource))
        throw usage(`${resource} has no attachment custom fields via the API`)
      const [id, field] = rest
      const file = flag(args, 'file')
      if (!id || !field || (!file && !args.flags.clear) || (file && args.flags.clear))
        throw usage(
          `Usage: forz ${resource} attach <id> <field id|label> (--file <path> | --clear) --if-match <etag>`
        )
      const ifMatch = flag(args, 'if-match')
      if (!ifMatch) throw usage('Missing --if-match <etag> (run `get` first to obtain it).')
      let data: Buffer | undefined
      try {
        data = file ? readFileSync(file) : undefined
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw usage(`--file not found: ${file}`)
        throw e
      }
      const c = await client(args)
      const fieldId = await customFieldResolver(c, resource)(field)
      const r = c.resource(resource)
      const res = data
        ? await r.setCustomFieldAttachment(
            id,
            fieldId,
            { filename: path.basename(file as string), data },
            { ifMatch }
          )
        : await r.clearCustomFieldAttachment(id, fieldId, { ifMatch })
      print(res.data)
      if (res.etag) console.error(`# ETag: ${res.etag}`)
      return
    }
    case 'get': {
      const [id] = rest
      if (!id) throw usage(`Usage: forz ${resource} get <id>`)
      const { data, etag } = await (await client(args)).resource(resource).get(id)
      print(data)
      if (etag) console.error(`# ETag: ${etag}`)
      return
    }
    case 'create': {
      const body = readObjectBody(args)
      if (body === undefined) throw usage(`Usage: forz ${resource} create --body JSON|@file|@-`)
      // Generate the financial Idempotency-Key here so a failed create can show it for a safe retry.
      const idk =
        flag(args, 'idempotency-key') ??
        (FINANCIAL_RESOURCES.has(resource) ? randomUUID() : undefined)
      const c = await client(args)
      await resolveCustomFieldLabels(c, resource, body)
      const r = c.resource(resource)
      try {
        print(await r.create(body, { idempotencyKey: idk }))
      } catch (e) {
        if (idk && e instanceof HttpError && e.code === 'idempotency_key.in_use')
          console.error(
            `# Idempotency-Key ${idk} was used with a different body: send that body or use a new key`
          )
        else if (idk)
          console.error(`# Idempotency-Key: ${idk} (retry with --idempotency-key ${idk})`)
        throw e
      }
      return
    }
    case 'update': {
      const [id] = rest
      if (!id)
        throw usage(`Usage: forz ${resource} update <id> --if-match <etag> --body JSON|@file`)
      const body = readObjectBody(args)
      if (body === undefined) throw usage('Missing --body')
      const ifMatch = flag(args, 'if-match')
      if (!ifMatch) throw usage('Missing --if-match <etag> (run `get` first to obtain it).')
      const c = await client(args)
      await resolveCustomFieldLabels(c, resource, body)
      print(await c.resource(resource).update(id, body, { ifMatch }))
      return
    }
    case 'delete': {
      const [id] = rest
      if (!id) throw usage(`Usage: forz ${resource} delete <id> --if-match <etag>`)
      const ifMatch = flag(args, 'if-match')
      if (!ifMatch) throw usage('Missing --if-match <etag> (run `get` first to obtain it).')
      await (await client(args)).resource(resource).delete(id, { ifMatch })
      console.log(`Deleted ${resource}/${id}`)
      return
    }
    default:
      throw usage(`Unknown verb for ${resource}: ${verb}`)
  }
}

// --- Raw escape hatch ---

const raw = async (args: ParsedArgs): Promise<void> => {
  const [pathArg] = args.positional
  if (!pathArg) {
    throw new UsageError(
      'Usage: forz raw <path> [--method GET] [--body JSON|@file] [--header.<Name> <value> ...] [--include]'
    )
  }
  const method = flag(args, 'method') ?? 'GET'
  const body = readBodyFlag(args)
  const headers: Record<string, string> = {}
  for (const k of Object.keys(args.flags)) {
    if (k.startsWith('header.')) headers[k.slice('header.'.length)] = flag(args, k) as string
  }
  const c = await client(args)
  // Like `gh api -i`, but on stderr so stdout stays pipeable JSON; errors too (Retry-After, request id).
  const dump = (r: { status: number; headers: IncomingHttpHeaders }): void => {
    if (!args.flags.include && !args.flags.i) return
    console.error(`HTTP ${r.status}`)
    for (const [k, v] of Object.entries(r.headers)) console.error(`${k}: ${v}`)
  }
  let res
  try {
    res = await c.raw(pathArg, { method, body, headers })
  } catch (e) {
    if (e instanceof HttpError) dump(e)
    throw e
  }
  dump(res)
  print(res.body)
}

// --- Help ---

const help = (): void => {
  console.log(`forz — CLI for app.forz.io (Public API v2)

Usage:
  forz <command> [args] [--flag value]
  forz <resource> <verb> [args] [--flag value]

Top-level commands:
  login --token fz_<uuid> [--base-url URL]         Save API credentials
  logout                                           Clear stored credentials
  ping                                             Authenticated health check
  whoami                                           Show the account/user this key belongs to
  config [show]                                    Print current config (token redacted)
  config set <key> <value>                         Update a config value
  raw <path> [--method M] [--body J] [--header.<Name> <value>] [--include|-i]
                                                   Call any v2 path; --include prints status + headers
                                                   to stderr. The token is only sent to the base URL's origin.
  version | --version | -v                         Print the CLI version
  help | <resource> --help                         Show this help / one resource's commands (no network)

Global flags:
  --base-url URL, --token KEY                      Override config for one call (flag > env > config)
  --timeout <sec>                                  Request timeout (default 30; also FORZ_TIMEOUT)

Environment:
  FORZ_TOKEN, FORZ_BASE_URL, FORZ_TIMEOUT

Resources (full CRUD: list, get, create, update, delete, notes; items has no notes):
  ${CRUD_RESOURCES.join(', ')}

Contacts also have linkages (the Customer / Lead / Site records a contact is linked to):
  contacts linkages <id> [--add --body J | --update <linkage_id> --body J | --delete <linkage_id>]

List + create only: ${LIST_CREATE_RESOURCES.join(
    ', '
  )} (list --filter.site_id|--filter.customer_id <uuid>)

Read-only resources (list, get, notes):
  ${READONLY_RESOURCES.join(', ')}

Lookups (list only; custom_field_definitions also supports \`get <id>\`):
  ${LOOKUPS.join(', ')}

Examples:
  forz whoami                                     # confirm this key's account before mutating
  forz customers list --limit 50 --sort=-created_at
  forz customers list --q "acme" --filter.status Open
  forz customers get 0190a1b2-9c3d-7e4f-8a1b-2c3d4e5f6071
  forz jobs create --body @./new-job.json
  forz invoices create --body @./invoice.json     # auto-generates Idempotency-Key
  forz customers update <id> --if-match 'W/"1745596800-3"' --body '{"organization":"Acme Inc"}'
  forz contacts update <id> --if-match '<etag>' --body '{"contact":{"phone_numbers":[{"id":"<uuid>","extension":"204"}]}}'  # full list: ids left out are removed
  forz jobs notes <id>                          # list comments on a record
  forz jobs notes <id> --add "Called back, wants a quote by Friday"
  forz custom_field_definitions get 0190a1b2-9c3d-7e4f-8a1b-2c3d4e5f6071
  forz contacts linkages <id> --add --body '{"linkable_type":"Customer","linkable_id":"<uuid>"}'
  forz systems list --filter.site_id <site-id>
  forz raw /api/v2/system_options
  forz raw /api/v2/customers/<id> --include      # status + headers (ETag) on stderr

Conventions:
  - Record ids are UUIDs (e.g. 0190a1b2-9c3d-7e4f-8a1b-2c3d4e5f6071).
  - update/delete require --if-match <etag> (get the ETag from a prior \`get\`); the value is a
    weak ETag like W/"1745596800-3" — quote it whole in the shell: --if-match 'W/"1745596800-3"'.
  - Financial creates (invoices, sales_orders) auto-generate an Idempotency-Key;
    override with --idempotency-key <key>.
  - List responses paginate via --cursor; --limit max 100 (default 25).
  - List filtering/sorting/search (per-endpoint allow-list): --sort <field> ascending
    (--sort=-<field> for descending), --q <text> free-text, and --filter.<key> <value> with
    operators --filter.<key>[gte|lte|gt|lt|in] <value>. An unknown --sort field is 400
    sort.invalid; an unknown filter/query key is 400 filter.invalid naming the allowed keys. Lookups labels,
    statuses and custom_field_definitions accept --filter.related_name <Type>.
  - create/update bodies are sent under the singular resource key ({"job":{...}}); pass
    flat fields or the wrapped form (raw bodies may be flat too).
  - Errors are RFC 9457 problem+json with a stable dotted \`code\` (e.g. validation.failed).
  - Nested arrays (lineitems, contact phone_numbers) and labels / project user_ids replace
    the whole list: an existing entry absent from what you send is removed. Omit the key to
    leave the list untouched; send [] to clear it. \`get\` first and echo back what you keep.
  - custom_fields merges per key (null clears one); keys are field ids from
    custom_field_definitions, or field labels (create/update resolve them).
    Filter lists with --filter.custom_fields[<id|label>] <value>; upload attachment
    fields with \`forz <resource> attach <id> <field> --file <path> --if-match <etag>\`. Unaccepted body keys are silently ignored (200, no 422).
  - Failed financial creates print the Idempotency-Key used on stderr; retry with the same key.
  - 429 is retried up to 3 times honoring Retry-After; 502/503/504 too, but only for GET
    or with an Idempotency-Key (never a replay that could double-apply a write).
  - Config file: ~/.forz/config.json (mode 0600)
  - Exit codes: 0 success, 1 API/network error, 2 usage error.
`)
}

const RESOURCE_HELP: Record<string, string> = {
  crud: `list [--limit N] [--cursor C] [--sort F] [--q T] [--filter.<key> V]
  get <id>                                   ETag printed on stderr
  create --body JSON|@file|@-
  update <id> --if-match <etag> --body JSON|@file
  delete <id> --if-match <etag>`,
  notes: `notes <id> [--limit N] [--cursor C]        list comments
  notes <id> --add <text>                    add a comment`,
}

const resourceHelp = (resource: string): void => {
  const lines = [`Usage: forz ${resource} <verb> [args]`, '']
  if (is(LOOKUPS, resource)) {
    lines.push('  list [--limit N] [--cursor C] [--filter.<key> V]')
    if (GETTABLE_LOOKUPS.has(resource)) lines.push('  get <id>')
  } else if (is(LIST_CREATE_RESOURCES, resource)) {
    lines.push(
      '  list [--limit N] [--cursor C] [--filter.site_id <uuid>] [--filter.customer_id <uuid>]'
    )
    lines.push('  create --body JSON|@file|@-')
  } else if (is(READONLY_RESOURCES, resource)) {
    lines.push('  list [--limit N] [--cursor C]', '  get <id>', `  ${RESOURCE_HELP.notes}`)
  } else {
    lines.push(`  ${RESOURCE_HELP.crud}`)
    if (!NO_NOTES.has(resource)) lines.push(`  ${RESOURCE_HELP.notes}`)
    if (ATTACHABLE_RESOURCES.has(resource))
      lines.push(
        '  attach <id> <field id|label> --file <path> --if-match E   upload into an attachment custom field',
        '  attach <id> <field id|label> --clear --if-match E         clear it'
      )
    if (FINANCIAL_RESOURCES.has(resource))
      lines.push('  create auto-sets an Idempotency-Key; override with --idempotency-key <key>')
    if (resource === 'contacts') {
      lines.push(
        '  linkages <id>                              list linked Customers / Leads / Sites',
        '  linkages <id> --add --body \'{"linkable_type":"Customer","linkable_id":"<uuid>"}\'',
        '  linkages <id> --update <linkage_id> --body \'{"primary":true}\'',
        '  linkages <id> --delete <linkage_id>'
      )
    }
  }
  console.log(lines.join('\n'))
}

const version = (): void => {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'))
  console.log(pkg.version)
}

const COMMANDS = ['login', 'logout', 'ping', 'whoami', 'config', 'raw', 'help', 'version']
const RESOURCES: readonly string[] = [
  ...CRUD_RESOURCES,
  ...LIST_CREATE_RESOURCES,
  ...READONLY_RESOURCES,
  ...LOOKUPS,
]

const editDistance = (a: string, b: string): number => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

export const suggest = (cmd: string): string | undefined => {
  const [best] = [...COMMANDS, ...RESOURCES]
    .map((c) => ({ c, d: editDistance(cmd, c) }))
    .sort((x, y) => x.d - y.d)
  return best && best.d <= Math.max(2, Math.floor(cmd.length / 3)) ? best.c : undefined
}

export const dispatch = async (argv: string[]): Promise<void> => {
  // Parse the whole argv so global flags may come before the command (`forz --token X whoami`).
  const parsed = parseArgs(argv)
  const [cmd, ...positional] = parsed.positional
  const args = { positional, flags: parsed.flags }
  const wantsHelp = args.flags.help === true || args.flags.h === true

  if (cmd === undefined && (args.flags.version === true || args.flags.v === true)) return version()
  if (cmd === undefined || cmd === 'help') return help()
  if (cmd === 'version') return version()
  if (RESOURCES.includes(cmd)) return wantsHelp ? resourceHelp(cmd) : dispatchResource(cmd, args)
  if (COMMANDS.includes(cmd) && wantsHelp) return help()
  if (cmd === 'login') return login(args)
  if (cmd === 'logout') return logout()
  if (cmd === 'ping') return ping(args)
  if (cmd === 'whoami') return whoami(args)
  if (cmd === 'config') return configCmd(args)
  if (cmd === 'raw') return raw(args)

  const guess = suggest(cmd)
  throw new UsageError(
    `Unknown command: ${cmd}${
      guess ? `. Did you mean \`forz ${guess}\`?` : ''
    }\nRun \`forz help\` for usage.`
  )
}

/**
 * Field errors from a problem+json `errors` extra: a map like
 * `{"phone_numbers.label": ["must be one of Mobile, Office, Fax, Other"]}`, or
 * (custom_fields / labels) an array of `{field, code, detail}`.
 * Returns undefined for error bodies that carry neither.
 */
const formatFieldErrors = (body: unknown): string | undefined => {
  if (!body || typeof body !== 'object') return undefined
  const errors = (body as { errors?: unknown }).errors
  if (!errors || typeof errors !== 'object') return undefined
  if (Array.isArray(errors)) {
    const lines = errors
      .filter(
        (e): e is { field?: string; code?: string; detail?: string } => !!e && typeof e === 'object'
      )
      .map((e) => `  ${e.field ?? '?'}: ${e.detail ?? e.code ?? ''}`)
    return lines.length ? lines.join('\n') : undefined
  }
  const lines = Object.entries(errors as Record<string, unknown>).map(([key, messages]) => {
    const list = Array.isArray(messages) ? messages : [messages]
    return `  ${key}: ${list.join('; ')}`
  })
  return lines.length ? lines.join('\n') : undefined
}

export const formatError = (e: unknown): string => {
  if (e instanceof HttpError) {
    const code = e.code ? ` [${e.code}]` : ''
    // When the server names the offending fields, show those instead of dumping
    // the 8-key RFC 9457 envelope — the field map is the actionable part.
    const fields = formatFieldErrors(e.body)
    if (fields) {
      const body = e.body as { title?: string; detail?: string }
      const detail = typeof body.detail === 'string' ? `\n${body.detail}` : ''
      return `HTTP ${e.status}${code}: ${body.title || e.message}${detail}\n${fields}`
    }
    let detail: string
    if (typeof e.body === 'string') {
      // Non-JSON (e.g. a Rails HTML 500 page): show the head, not 120 KB.
      const ct = e.headers?.['content-type'] ?? 'unknown content-type'
      detail =
        e.body.length > 500
          ? `${e.body.slice(0, 500)}\n… (${ct}, ${e.body.length} chars, truncated)`
          : e.body
    } else detail = JSON.stringify(e.body, null, 2)
    const location = e.headers?.location ? `\nLocation: ${e.headers.location}` : ''
    const retryAfter = e.headers?.['retry-after']
    const hint =
      e.status === 401
        ? '\nHint: the API key is missing, invalid or revoked — check `forz login`, FORZ_TOKEN or --token.'
        : e.status === 429
        ? `\nHint: rate limited${
            retryAfter ? `; retry after ${retryAfter}s` : ''
          } — slow down or retry later.`
        : ''
    return `HTTP ${e.status}${code}: ${e.message}${location}\n${detail}${hint}`
  }
  if (e instanceof Error) return e.message || String((e as NodeJS.ErrnoException).code ?? e.name)
  return String(e)
}
