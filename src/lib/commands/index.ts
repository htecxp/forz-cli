import { ForzClient } from '../../api'
import * as config from '../config'
import { HttpError } from '../http'

const unwrap = (body: unknown): unknown =>
  body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)
    ? (body as { data: unknown }).data
    : body

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
    const fs = require('fs') as typeof import('fs')
    const path = raw.slice(1)
    const text = path === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path, 'utf8')
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
  // Forward any --filter[key]=value style filters as raw query params.
  for (const [k, v] of Object.entries(args.flags)) {
    if (k === 'cursor' || k === 'limit') continue
    if (k.startsWith('filter.')) params[k.slice('filter.'.length)] = typeof v === 'boolean' ? v : v
  }
  return params
}

const client = async (): Promise<ForzClient> => {
  const cfg = await config.load()
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
    throw new Error('Missing --token. Mint a key at /settings/api_keys, then run:\n  forz login --token fz_live_<uuid>')
  }
  if (!/^fz_(live|test)_[0-9a-fA-F-]{36}$/.test(token)) {
    console.error(`# warning: token does not match expected format fz_(live|test)_<UUIDv7>`)
  }
  const next = await config.update({ token, ...(baseUrl ? { baseUrl } : {}) })
  console.log(`Saved credentials to ${config.configPath()}`)
  console.log(`Base URL: ${next.baseUrl}`)
}

const logout = async (): Promise<void> => {
  await config.clear()
  console.log('Logged out.')
}

const ping = async (): Promise<void> => {
  const c = await client()
  // GET /api/v2/system_options is a cheap authenticated read.
  const res = await c.raw('/api/v2/system_options', { query: { limit: 1 } })
  const limit = res.headers['ratelimit-limit']
  const remaining = res.headers['ratelimit-remaining']
  console.log(`OK — HTTP ${res.status} from ${c.baseUrl}`)
  if (limit && remaining) console.log(`RateLimit: ${remaining}/${limit} remaining`)
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
  const c = await client()

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

  if (!(CRUD_RESOURCES as readonly string[]).includes(resource)) {
    throw new Error(`Unknown resource: ${resource}`)
  }

  const r = c.resource(resource)

  switch (verb) {
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
    throw new Error('Usage: forz raw <path> [--method GET] [--body JSON|@file] [--header K=V ...]')
  }
  const method = typeof args.flags.method === 'string' ? args.flags.method : 'GET'
  const body = readBodyFlag(args.flags.body)
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(args.flags)) {
    if (k.startsWith('header.') && typeof v === 'string') headers[k.slice('header.'.length)] = v
  }
  const c = await client()
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
  login --token fz_live_<uuid> [--base-url URL]   Save API credentials
  logout                                           Clear stored credentials
  ping                                             Authenticated health check
  config [show]                                    Print current config (token redacted)
  config set <key> <value>                         Update a config value
  raw <path> [--method M] [--body J] [--header K=V] Call any v2 path
  help                                             Show this help

Resources (full CRUD: list, get, create, update, delete):
  ${CRUD_RESOURCES.join(', ')}

Lookups (list only; custom_field_definitions also supports \`get <id>\`):
  ${LOOKUPS.join(', ')}

Examples:
  forz customers list --limit 50
  forz customers get cust_01J...
  forz jobs create --body @./new-job.json
  forz invoices create --body @./invoice.json     # auto-generates Idempotency-Key
  forz customers update <id> --if-match '"W/abc"' --body '{"name":"New"}'
  forz custom_field_definitions get cfd_01J...
  forz raw /api/v2/system_options

Conventions:
  - Mutations require --if-match <etag> (get the ETag from a prior \`get\`).
  - Financial creates (invoices, sales_orders) auto-generate an Idempotency-Key;
    override with --idempotency-key <uuid>.
  - List responses paginate via --cursor; --limit max 100 (default 25).
  - --filter.<key> <value> forwards arbitrary query params on list calls.
  - Config file: ~/.forz/config.json
`)
}

export const dispatch = async (argv: string[]): Promise<void> => {
  const [cmd, ...rest] = argv
  const args = parseArgs(rest)

  if (cmd === undefined || cmd === 'help' || cmd === '-h' || cmd === '--help') return help()
  if (cmd === 'login') return login(args)
  if (cmd === 'logout') return logout()
  if (cmd === 'ping') return ping()
  if (cmd === 'config') return configCmd(args)
  if (cmd === 'raw') return raw(args)

  if (
    (CRUD_RESOURCES as readonly string[]).includes(cmd) ||
    (LOOKUPS as readonly string[]).includes(cmd)
  ) {
    return dispatchResource(cmd, args)
  }

  help()
  throw new Error(`Unknown command: ${cmd}`)
}

export const formatError = (e: unknown): string => {
  if (e instanceof HttpError) {
    const code = e.code ? ` [${e.code}]` : ''
    const detail = typeof e.body === 'string' ? e.body : JSON.stringify(e.body, null, 2)
    return `HTTP ${e.status}${code}: ${e.message}\n${detail}`
  }
  if (e instanceof Error) return e.message
  return String(e)
}
