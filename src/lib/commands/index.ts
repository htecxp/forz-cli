import { readFileSync } from 'fs'

import { ForzClient } from '../../api'
import * as config from '../config'
import { HttpError } from '../http'

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

export const parseArgs = (argv: string[]): ParsedArgs => {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1)
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) flags[a.slice(2)] = argv[++i]
      else flags[a.slice(2)] = true
    } else if (a.startsWith('-') && a.length > 1) {
      flags[a.slice(1)] = true
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
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

const readBodyFlag = (raw: string | boolean | undefined): unknown => {
  if (raw === undefined || raw === true || raw === false) return undefined
  if (raw.startsWith('@')) {
    const path = raw.slice(1)
    const text = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8')
    return JSON.parse(text)
  }
  return JSON.parse(raw)
}

const buildListParams = (
  args: ParsedArgs
): { cursor?: string; limit?: number; [k: string]: string | number | boolean | undefined } => {
  const params: Record<string, string | number | boolean | undefined> = {}
  if (typeof args.flags.cursor === 'string') params.cursor = args.flags.cursor
  if (typeof args.flags.limit === 'string') params.limit = Number(args.flags.limit)
  // First-class sort + free-text search (allowed on every CRUD list endpoint).
  if (typeof args.flags.sort === 'string') params.sort = args.flags.sort
  if (typeof args.flags.q === 'string') params.q = args.flags.q
  // Forward any --filter.<key> <value> filters as raw query params, e.g.
  // `--filter.status Open` or `--filter.created_at[gte] 2026-01-01T00:00:00Z`.
  for (const [k, v] of Object.entries(args.flags)) {
    if (k === 'cursor' || k === 'limit' || k === 'sort' || k === 'q') continue
    if (k.startsWith('filter.')) params[k.slice('filter.'.length)] = v
  }
  return params
}

// `--base-url` / `--token` override the saved config for one invocation.
const client = async (args?: ParsedArgs): Promise<ForzClient> => {
  const cfg = await config.load()
  if (typeof args?.flags['base-url'] === 'string') cfg.baseUrl = args.flags['base-url']
  if (typeof args?.flags.token === 'string') cfg.token = args.flags.token
  if (!cfg.token) {
    throw new Error('Not authenticated. Run `forz login --token <api-key>` first.')
  }
  return ForzClient.fromConfig(cfg)
}

// --- Top-level command handlers ---

const login = async (args: ParsedArgs): Promise<void> => {
  const token = typeof args.flags.token === 'string' ? args.flags.token : undefined
  const baseUrl = typeof args.flags['base-url'] === 'string' ? args.flags['base-url'] : undefined
  if (!token) {
    throw new Error('Missing --token. Mint a key at /settings/api_keys, then run:\n  forz login --token fz_<uuid>')
  }
  if (!/^fz_[0-9a-fA-F-]{36}$/.test(token)) {
    console.error(`# warning: token does not match expected format fz_<UUIDv7>`)
  }
  const next = await config.update({ token, ...(baseUrl ? { baseUrl } : {}) })
  console.log(`Saved credentials to ${config.configPath()}`)
  console.log(`Base URL: ${next.baseUrl}`)
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

const configCmd = async (args: ParsedArgs): Promise<void> => {
  const [sub, key, value] = args.positional
  if (!sub || sub === 'show') {
    const cfg = await config.load()
    print({ ...cfg, token: cfg.token ? '***' : undefined })
    return
  }
  if (sub === 'set') {
    if (!key) throw new Error('Usage: forz config set <key> <value>')
    await config.update({ [key]: value } as Partial<config.Config>)
    console.log(`Set ${key}`)
    return
  }
  throw new Error(`Unknown config subcommand: ${sub}`)
}

// --- Resource dispatcher ---

const dispatchResource = async (resource: string, args: ParsedArgs): Promise<void> => {
  const [verb, ...rest] = args.positional
  const c = await client(args)

  // Lookups: list-only (plus `get <id>` for gettable lookups).
  if ((LOOKUPS as readonly string[]).includes(resource)) {
    const lookup = c.lookup(resource)
    if (verb === 'get' && GETTABLE_LOOKUPS.has(resource)) {
      const [id] = rest
      if (!id) throw new Error(`Usage: forz ${resource} get <id>`)
      const res = await c.raw(`/api/v2/${resource}/${encodeURIComponent(id)}`)
      print(unwrap(res.body))
      return
    }
    if (verb && verb !== 'list') {
      throw new Error(`Unknown verb for ${resource}: ${verb}`)
    }
    printPage(await lookup.list(buildListParams(args)))
    return
  }

  const readonly = (READONLY_RESOURCES as readonly string[]).includes(resource)
  if (!readonly && !(CRUD_RESOURCES as readonly string[]).includes(resource)) {
    throw new Error(`Unknown resource: ${resource}`)
  }
  if (readonly && ['create', 'update', 'delete'].includes(verb)) {
    throw new Error(`${resource} is read-only in API v2 (list, get, notes only).`)
  }

  const r = c.resource(resource)

  switch (verb) {
    case 'notes': {
      if (NO_NOTES.has(resource)) throw new Error(`${resource} has no notes in API v2.`)
      const [id] = rest
      if (!id) throw new Error(`Usage: forz ${resource} notes <id> [--add <text>]`)
      const text = args.flags.add
      if (typeof text === 'string') {
        print(await r.createNote(id, text))
        return
      }
      printPage(await r.listNotes(id, buildListParams(args)))
      return
    }
    case undefined:
    case 'list': {
      printPage(await r.list(buildListParams(args)))
      return
    }
    case 'get': {
      const [id] = rest
      if (!id) throw new Error(`Usage: forz ${resource} get <id>`)
      const { data, etag } = await r.get(id)
      print(data)
      if (etag) console.error(`# ETag: ${etag}`)
      return
    }
    case 'create': {
      const body = readBodyFlag(args.flags.body)
      if (body === undefined) {
        throw new Error(`Usage: forz ${resource} create --body JSON|@file|@-`)
      }
      const idk = typeof args.flags['idempotency-key'] === 'string' ? args.flags['idempotency-key'] : undefined
      print(await r.create(body as Record<string, unknown>, { idempotencyKey: idk }))
      return
    }
    case 'update': {
      const [id] = rest
      if (!id) throw new Error(`Usage: forz ${resource} update <id> --if-match <etag> --body JSON|@file`)
      const body = readBodyFlag(args.flags.body)
      if (body === undefined) throw new Error('Missing --body')
      const ifMatch = typeof args.flags['if-match'] === 'string' ? args.flags['if-match'] : undefined
      if (!ifMatch) throw new Error('Missing --if-match <etag> (run `get` first to obtain it).')
      print(await r.update(id, body as Record<string, unknown>, { ifMatch }))
      return
    }
    case 'delete': {
      const [id] = rest
      if (!id) throw new Error(`Usage: forz ${resource} delete <id> --if-match <etag>`)
      const ifMatch = typeof args.flags['if-match'] === 'string' ? args.flags['if-match'] : undefined
      if (!ifMatch) throw new Error('Missing --if-match <etag> (run `get` first to obtain it).')
      await r.delete(id, { ifMatch })
      console.log(`Deleted ${resource}/${id}`)
      return
    }
    default:
      throw new Error(`Unknown verb for ${resource}: ${verb}`)
  }
}

// --- Raw escape hatch ---

const raw = async (args: ParsedArgs): Promise<void> => {
  const [pathArg] = args.positional
  if (!pathArg) {
    throw new Error('Usage: forz raw <path> [--method GET] [--body JSON|@file] [--header.<Name> <value> ...]')
  }
  const method = typeof args.flags.method === 'string' ? args.flags.method : 'GET'
  const body = readBodyFlag(args.flags.body)
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(args.flags)) {
    if (k.startsWith('header.') && typeof v === 'string') headers[k.slice('header.'.length)] = v
  }
  const c = await client(args)
  const res = await c.raw(pathArg, { method, body, headers })
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
  raw <path> [--method M] [--body J] [--header.<Name> <value>]  Call any v2 path
  help                                             Show this help

Resources (full CRUD: list, get, create, update, delete, notes; items has no notes):
  ${CRUD_RESOURCES.join(', ')}

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
  forz raw /api/v2/system_options

Conventions:
  - Record ids are UUIDs (e.g. 0190a1b2-9c3d-7e4f-8a1b-2c3d4e5f6071).
  - update/delete require --if-match <etag> (get the ETag from a prior \`get\`); the value is a
    weak ETag like W/"1745596800-3" — quote it whole in the shell: --if-match 'W/"1745596800-3"'.
  - Financial creates (invoices, sales_orders) auto-generate an Idempotency-Key;
    override with --idempotency-key <key>.
  - List responses paginate via --cursor; --limit max 100 (default 25).
  - List filtering/sorting/search (per-endpoint allow-list): --sort <field> ascending
    (--sort=-<field> for descending), --q <text> free-text, and --filter.<key> <value> with
    operators --filter.<key>[gte|lte|gt|lt|in] <value>. An unknown --sort field is a 400, but
    an unknown filter key is silently ignored (you get the unfiltered list). Lookups labels,
    statuses and custom_field_definitions accept --filter.related_name <Type>.
  - create/update bodies are sent under the singular resource key ({"job":{...}}); pass
    flat fields or the wrapped form. Via raw, wrap yourself or lineitems are dropped.
  - Errors are RFC 9457 problem+json with a stable dotted \`code\` (e.g. validation.failed).
  - Nested arrays (lineitems, contact phone_numbers) and labels / project user_ids replace
    the whole list: an existing entry absent from what you send is removed. Omit the key to
    leave the list untouched; send [] to clear it. \`get\` first and echo back what you keep.
  - custom_fields merges per key (null clears one); keys are field ids from
    custom_field_definitions. Unaccepted body keys are silently ignored (200, no 422).
  - Config file: ~/.forz/config.json
`)
}

export const dispatch = async (argv: string[]): Promise<void> => {
  const [cmd, ...rest] = argv
  const args = parseArgs(rest)

  if (cmd === undefined || cmd === 'help' || cmd === '-h' || cmd === '--help') return help()
  if (cmd === 'login') return login(args)
  if (cmd === 'logout') return logout()
  if (cmd === 'ping') return ping(args)
  if (cmd === 'whoami') return whoami(args)
  if (cmd === 'config') return configCmd(args)
  if (cmd === 'raw') return raw(args)

  if (
    (CRUD_RESOURCES as readonly string[]).includes(cmd) ||
    (READONLY_RESOURCES as readonly string[]).includes(cmd) ||
    (LOOKUPS as readonly string[]).includes(cmd)
  ) {
    return dispatchResource(cmd, args)
  }

  help()
  throw new Error(`Unknown command: ${cmd}`)
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
      .filter((e): e is { field?: string; code?: string; detail?: string } => !!e && typeof e === 'object')
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
    const detail = typeof e.body === 'string' ? e.body : JSON.stringify(e.body, null, 2)
    return `HTTP ${e.status}${code}: ${e.message}\n${detail}`
  }
  if (e instanceof Error) return e.message
  return String(e)
}
