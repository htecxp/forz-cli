import { readFileSync } from 'fs'

import { ForzClient } from '../src/api'
import { dispatch, formatError, suggest, UsageError } from '../src/lib/commands'
import * as config from '../src/lib/config'
import { HttpError } from '../src/lib/http'

jest.mock('../src/api', () => ({
  ...jest.requireActual('../src/api'),
  ForzClient: { fromConfig: jest.fn() },
}))
jest.mock('../src/lib/config')

describe('forz CLI surface', () => {
  const loadMock = config.load as unknown as jest.Mock
  const updateMock = config.update as unknown as jest.Mock
  const fromConfigMock = ForzClient.fromConfig as unknown as jest.Mock
  let logSpy: jest.SpyInstance
  let errSpy: jest.SpyInstance

  beforeEach(() => {
    loadMock.mockResolvedValue({ baseUrl: 'https://app.forz.io', token: 'fz_cfg' })
    updateMock.mockResolvedValue({ baseUrl: 'https://app.forz.io', token: 'fz_new' })
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    delete process.env.FORZ_TOKEN
    delete process.env.FORZ_BASE_URL
    delete process.env.FORZ_TIMEOUT
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  it('<resource> --help and <resource> <verb> --help print locally with no client', async () => {
    await dispatch(['customers', '--help'])
    await dispatch(['contacts', 'list', '-h'])
    expect(fromConfigMock).not.toHaveBeenCalled()
    expect(logSpy.mock.calls.join('\n')).toContain('linkages <id>')
  })

  it('--version prints the package.json version', async () => {
    await dispatch(['--version'])
    expect(logSpy).toHaveBeenCalledWith(JSON.parse(readFileSync('package.json', 'utf8')).version)
  })

  it('unknown command is a UsageError with a suggestion', async () => {
    await expect(dispatch(['custmers'])).rejects.toThrow(/Did you mean `forz customers`/)
    await expect(dispatch(['custmers'])).rejects.toBeInstanceOf(UsageError)
    expect(suggest('zzzzzzzz')).toBeUndefined()
  })

  it('global flags may precede the command; linkage modes are exclusive', async () => {
    await expect(dispatch(['--limit', 'abc', 'customers', 'list'])).rejects.toThrow(
      /--limit must be a positive integer/
    )
    await expect(
      dispatch(['contacts', 'linkages', 'c1', '--add', '--delete', 'l1', '--body', '{}'])
    ).rejects.toThrow(/only one of --add, --update, --delete/)
    expect(fromConfigMock).not.toHaveBeenCalled()
  })

  it('create/update refuse a non-object --body before any request', async () => {
    await expect(dispatch(['projects', 'create', '--body', '"str"'])).rejects.toThrow(
      /--body must be a JSON object/
    )
    await expect(
      dispatch(['projects', 'update', 'p1', '--if-match', 'e', '--body', '[1]'])
    ).rejects.toBeInstanceOf(UsageError)
    expect(fromConfigMock).not.toHaveBeenCalled()
  })

  it('--limit must be a positive integer; bare --token is a usage error', async () => {
    await expect(dispatch(['customers', 'list', '--limit', 'abc'])).rejects.toBeInstanceOf(
      UsageError
    )
    await expect(dispatch(['customers', 'list', '--token'])).rejects.toThrow(
      /--token requires a value \(for one starting with --, use --token=<value>\)/
    )
    // Past setTimeout's 2^31-1 ms limit Node fires after 1 ms instead.
    await expect(dispatch(['customers', 'list', '--timeout', '1e12'])).rejects.toBeInstanceOf(
      UsageError
    )
    expect(fromConfigMock).not.toHaveBeenCalled()
  })

  it('flag > env > config for token and base URL', async () => {
    const list = jest.fn().mockResolvedValue({ data: [], hasMore: false })
    fromConfigMock.mockReturnValue({ resource: () => ({ list }) })
    process.env.FORZ_TOKEN = 'fz_env'
    process.env.FORZ_BASE_URL = 'http://env.test'
    process.env.FORZ_TIMEOUT = '5'
    await dispatch(['customers', 'list'])
    expect(fromConfigMock).toHaveBeenLastCalledWith({
      baseUrl: 'http://env.test',
      token: 'fz_env',
      timeout: 5000,
    })
    await dispatch(['customers', 'list', '--token', 'fz_flag', '--timeout', '1'])
    expect(fromConfigMock).toHaveBeenLastCalledWith({
      baseUrl: 'http://env.test',
      token: 'fz_flag',
      timeout: 1000,
    })
  })

  it('resolves custom field labels to ids on create/update', async () => {
    const ID = '01a0def8-32c8-7de7-8da2-322c2dc3182c'
    const OTHER = '01a0def8-3294-7f24-9f22-8b370b36a54c'
    const defs = jest.fn().mockResolvedValue({
      data: [{ parent_id: null, fields: [{ id: ID, label: 'Tier' }] }],
    })
    const update = jest.fn().mockResolvedValue({})
    fromConfigMock.mockReturnValue({ lookup: () => ({ list: defs }), resource: () => ({ update }) })
    await dispatch([
      'sales_orders',
      'update',
      's1',
      '--if-match',
      'e',
      '--token',
      't',
      '--body',
      `{"sales_order":{"custom_fields":{" tier ":"Gold","${OTHER}":null}}}`,
    ])
    expect(defs).toHaveBeenCalledWith({ related_name: 'SalesOrder', limit: 100 })
    expect(update.mock.calls[0][1]).toEqual({
      sales_order: { custom_fields: { [ID]: 'Gold', [OTHER]: null } },
    })
    await expect(
      dispatch([
        'sales_orders',
        'update',
        's1',
        '--if-match',
        'e',
        '--token',
        't',
        '--body',
        '{"custom_fields":{"Nope":1}}',
      ])
    ).rejects.toThrow(/Unknown custom field "Nope" on sales_orders. Fields: "Tier"/)
  })

  it('attach uploads by field label; list resolves custom_fields[<label>] filters', async () => {
    const ID = '01a0df3d-2931-7a88-b8bb-37f0baba8fad'
    const defs = jest.fn().mockResolvedValue({
      data: [{ parent_id: null, fields: [{ id: ID, label: 'Contract' }] }],
    })
    const setCustomFieldAttachment = jest.fn().mockResolvedValue({ data: {}, etag: 'e2' })
    const list = jest.fn().mockResolvedValue({ data: [], hasMore: false })
    fromConfigMock.mockReturnValue({
      lookup: () => ({ list: defs }),
      resource: () => ({ setCustomFieldAttachment, list }),
    })
    await dispatch([
      'customers',
      'attach',
      'c1',
      'contract',
      '--file',
      'package.json',
      '--if-match',
      'e1',
      '--token',
      't',
    ])
    const [id, field, file, opts] = setCustomFieldAttachment.mock.calls[0]
    expect([id, field, file.filename, opts]).toEqual(['c1', ID, 'package.json', { ifMatch: 'e1' }])
    expect(Buffer.isBuffer(file.data)).toBe(true)
    await dispatch(['customers', 'list', '--filter.custom_fields[Contract]', 'x', '--token', 't'])
    expect(list).toHaveBeenCalledWith({ [`custom_fields[${ID}]`]: 'x' })
    await expect(
      dispatch([
        'customers',
        'attach',
        'c1',
        'contract',
        '--file',
        'x',
        '--clear',
        '--if-match',
        'e',
      ])
    ).rejects.toBeInstanceOf(UsageError)
  })

  it('prints the auto-generated Idempotency-Key when a financial create fails', async () => {
    const create = jest.fn().mockRejectedValue(new HttpError(502, null, 'boom'))
    fromConfigMock.mockReturnValue({ resource: () => ({ create }) })
    await expect(dispatch(['invoices', 'create', '--body', '{}'])).rejects.toBeInstanceOf(HttpError)
    const key = create.mock.calls[0][1].idempotencyKey
    expect(key).toMatch(/^[0-9a-f-]{36}$/)
    expect(errSpy).toHaveBeenCalledWith(
      `# Idempotency-Key: ${key} (retry with --idempotency-key ${key})`
    )
  })

  it('contacts linkages list/add/update/delete', async () => {
    const r = {
      listLinkages: jest.fn().mockResolvedValue([]),
      createLinkage: jest.fn().mockResolvedValue({}),
      updateLinkage: jest.fn().mockResolvedValue({}),
      deleteLinkage: jest.fn().mockResolvedValue(undefined),
    }
    fromConfigMock.mockReturnValue({ resource: () => r })
    await dispatch(['contacts', 'linkages', 'c1'])
    await dispatch(['contacts', 'linkages', 'c1', '--add', '--body', '{"linkable_type":"Site"}'])
    await dispatch(['contacts', 'linkages', 'c1', '--update', 'l1', '--body', '{"primary":true}'])
    await dispatch(['contacts', 'linkages', 'c1', '--delete', 'l1'])
    expect(r.listLinkages).toHaveBeenCalledWith('c1')
    expect(r.createLinkage).toHaveBeenCalledWith('c1', { linkable_type: 'Site' })
    expect(r.updateLinkage).toHaveBeenCalledWith('c1', 'l1', { primary: true })
    expect(r.deleteLinkage).toHaveBeenCalledWith('c1', 'l1')
  })

  it('systems supports list with filters and create, nothing else', async () => {
    const list = jest.fn().mockResolvedValue({ data: [], hasMore: false })
    fromConfigMock.mockReturnValue({ resource: () => ({ list }) })
    await dispatch(['systems', 'list', '--filter.site_id', 's1'])
    expect(list).toHaveBeenCalledWith({ site_id: 's1' })
    await expect(dispatch(['systems', 'get', 'x'])).rejects.toBeInstanceOf(UsageError)
  })

  it('config set rejects unknown keys and a missing value', async () => {
    await expect(dispatch(['config', 'set', 'bogus', 'x'])).rejects.toThrow(/Unknown config key/)
    await expect(dispatch(['config', 'set', 'token'])).rejects.toBeInstanceOf(UsageError)
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('login verifies the token via /me before saving', async () => {
    const raw = jest.fn().mockRejectedValue(new HttpError(401, null, 'nope'))
    fromConfigMock.mockReturnValue({ raw })
    await expect(dispatch(['login', '--token', 'fz_bad'])).rejects.toBeInstanceOf(HttpError)
    expect(raw).toHaveBeenCalledWith('/api/v2/me')
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('login saves the FORZ_BASE_URL it verified against', async () => {
    fromConfigMock.mockReturnValue({ raw: jest.fn().mockResolvedValue({ body: {} }) })
    process.env.FORZ_BASE_URL = 'http://localhost:3100/'
    await dispatch(['login', '--token', 'fz_x'])
    expect(updateMock).toHaveBeenCalledWith({ token: 'fz_x', baseUrl: 'http://localhost:3100' })
  })

  it('rejects a non-http(s) base URL as a usage error, never saving it', async () => {
    await expect(dispatch(['config', 'set', 'baseUrl', 'not-a-url'])).rejects.toThrow(
      /baseUrl must be an http\(s\) URL/
    )
    await expect(dispatch(['whoami', '--base-url', 'ftp://x'])).rejects.toBeInstanceOf(UsageError)
    loadMock.mockResolvedValue({ baseUrl: 'not-a-url', token: 'fz_cfg' })
    await expect(dispatch(['whoami'])).rejects.toBeInstanceOf(UsageError)
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('--body @missing-file is a usage error', async () => {
    await expect(dispatch(['tasks', 'create', '--body', '@/nonexistent.json'])).rejects.toThrow(
      new UsageError('--body file not found: /nonexistent.json')
    )
  })

  it('on 409 idempotency_key.in_use says to use a new key, not retry the same one', async () => {
    const err = new HttpError(409, { code: 'idempotency_key.in_use' }, 'conflict')
    fromConfigMock.mockReturnValue({
      resource: () => ({ create: jest.fn().mockRejectedValue(err) }),
    })
    await expect(
      dispatch(['invoices', 'create', '--body', '{}', '--idempotency-key', 'k1'])
    ).rejects.toBe(err)
    expect(errSpy.mock.calls.join('\n')).toMatch(/k1 was used with a different body/)
    expect(errSpy.mock.calls.join('\n')).not.toMatch(/retry with/)
  })

  it('read-only resource help indents every verb', async () => {
    await dispatch(['assets', '--help'])
    expect(logSpy.mock.calls[0][0]).toContain('\n  notes <id> [--limit N]')
  })

  it('raw --include prints status and headers to stderr', async () => {
    const raw = jest.fn().mockResolvedValue({ status: 200, headers: { etag: 'W/"1-2"' }, body: {} })
    fromConfigMock.mockReturnValue({ raw })
    await dispatch(['raw', '--include', 'api/v2/me'])
    expect(raw.mock.calls[0][0]).toBe('api/v2/me')
    expect(errSpy).toHaveBeenCalledWith('HTTP 200')
    expect(errSpy).toHaveBeenCalledWith('etag: W/"1-2"')
  })

  it('raw --include prints status and headers on an error response too', async () => {
    const err = new HttpError(404, null, 'nf', { 'x-request-id': 'r1' })
    fromConfigMock.mockReturnValue({ raw: jest.fn().mockRejectedValue(err) })
    await expect(dispatch(['raw', '-i', '/api/v2/customers/x'])).rejects.toBe(err)
    expect(errSpy).toHaveBeenCalledWith('HTTP 404')
    expect(errSpy).toHaveBeenCalledWith('x-request-id: r1')
  })

  it('missing credentials is a usage error', async () => {
    loadMock.mockResolvedValue({ baseUrl: 'https://app.forz.io' })
    await expect(dispatch(['whoami'])).rejects.toBeInstanceOf(UsageError)
  })
})

describe('formatError', () => {
  it('truncates non-JSON bodies and hints on 401', () => {
    const html = '<html>' + 'x'.repeat(5000)
    const out = formatError(
      new HttpError(401, html, 'GET /x → HTTP 401', { 'content-type': 'text/html' })
    )
    expect(out.length).toBeLessThan(1000)
    expect(out).toContain('text/html, 5006 chars, truncated')
    expect(out).toContain('Hint:')
  })
})
