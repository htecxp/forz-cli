import { ForzClient } from '../src/api'
import { dispatch, formatError } from '../src/lib/commands'
import * as config from '../src/lib/config'
import { HttpError } from '../src/lib/http'

jest.mock('../src/api')
jest.mock('../src/lib/config')

// `phone_numbers` is a nested array on Contact with snapshot-replace semantics
// (same as `lineitems`): an existing id absent from the array is discarded, `[]`
// clears every number, and omitting the key leaves the stored list untouched.
// It travels through the generic `--body` path, so these tests pin the guarantee
// that the CLI forwards exactly the JSON it was given — nothing added, nothing dropped.
describe('contacts phone_numbers via --body', () => {
  const loadMock = config.load as unknown as jest.Mock
  const fromConfigMock = ForzClient.fromConfig as unknown as jest.Mock
  let create: jest.Mock
  let update: jest.Mock

  beforeEach(() => {
    loadMock.mockResolvedValue({ baseUrl: 'https://app.forz.io', token: 'fz_x' })
    create = jest.fn().mockResolvedValue({ id: 'c1' })
    update = jest.fn().mockResolvedValue({ id: 'c1' })
    fromConfigMock.mockReturnValue({ resource: () => ({ create, update }) })
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  // The one bug that silently wipes a partner's numbers: a body with no
  // `phone_numbers` key must reach the server with no `phone_numbers` key.
  it('sends no phone_numbers key when the body omits it', async () => {
    await dispatch([
      'contacts',
      'update',
      'c1',
      '--if-match',
      'W/"1-2"',
      '--body',
      '{"contact":{"title":"Ops Lead"}}',
    ])
    const [, body] = update.mock.calls[0]
    expect(body).toEqual({ contact: { title: 'Ops Lead' } })
    expect(JSON.stringify(body)).not.toContain('phone_numbers')
  })

  it('round-trips phone_numbers on create', async () => {
    await dispatch([
      'contacts',
      'create',
      '--body',
      '{"contact":{"first_name":"Ada","phone_numbers":[{"label":"Office","number":"415-555-0100"}]}}',
    ])
    expect(create.mock.calls[0][0]).toEqual({
      contact: {
        first_name: 'Ada',
        phone_numbers: [{ label: 'Office', number: '415-555-0100' }],
      },
    })
  })

  // A partial edit carries `id` and omits `number` — the server keeps the stored
  // value, so the CLI must not helpfully fill one in.
  it('round-trips a partial update entry without inventing a number', async () => {
    await dispatch([
      'contacts',
      'update',
      'c1',
      '--if-match',
      'W/"1-2"',
      '--body',
      '{"contact":{"phone_numbers":[{"id":"p1","extension":"204"}]}}',
    ])
    expect(update.mock.calls[0][1]).toEqual({
      contact: { phone_numbers: [{ id: 'p1', extension: '204' }] },
    })
  })

  // Clearing is destructive and must stay explicit: it only happens when the
  // caller literally types an empty array.
  it('only clears the list when an explicit empty array is sent', async () => {
    await dispatch([
      'contacts',
      'update',
      'c1',
      '--if-match',
      'W/"1-2"',
      '--body',
      '{"contact":{"phone_numbers":[]}}',
    ])
    expect(update.mock.calls[0][1]).toEqual({ contact: { phone_numbers: [] } })
  })
})

// A 422 names the offending field in the problem+json `errors` extra. Surface
// that instead of dumping the 8-key RFC 9457 envelope at the user.
describe('formatError with problem+json field errors', () => {
  const problem = (errors: Record<string, string[]>) => ({
    type: 'https://forz.io/api/errors/validation.failed',
    title: 'Validation failed',
    status: 422,
    code: 'validation.failed',
    detail: null,
    instance: '/api/v2/contacts/c1',
    request_id: 'req_1',
    doc_url: 'https://forz.io/api/errors/validation-failed',
    errors,
  })

  it('renders a bad phone label readably', () => {
    const body = problem({
      'phone_numbers.label': ['must be one of Mobile, Office, Fax, Other'],
    })
    const out = formatError(new HttpError(422, body, 'PATCH /api/v2/contacts/c1 → HTTP 422'))
    expect(out).toBe(
      'HTTP 422 [validation.failed]: Validation failed\n' +
        '  phone_numbers.label: must be one of Mobile, Office, Fax, Other'
    )
    expect(out).not.toContain('doc_url')
  })

  it('lists every offending field', () => {
    const out = formatError(
      new HttpError(
        422,
        problem({
          'phone_numbers.number': ["can't be blank"],
          'phone_numbers.id': ['p9 was not found on this contact'],
        }),
        'msg'
      )
    )
    expect(out).toContain("  phone_numbers.number: can't be blank")
    expect(out).toContain('  phone_numbers.id: p9 was not found on this contact')
  })

  // Error bodies without an `errors` map (404s, 412s) keep the full dump.
  it('falls back to the raw body when there is no errors map', () => {
    const body = { code: 'resource.not_found', title: 'Not found', status: 404 }
    const out = formatError(new HttpError(404, body, 'GET /api/v2/contacts/nope → HTTP 404'))
    expect(out).toContain('HTTP 404 [resource.not_found]')
    expect(out).toContain('"title": "Not found"')
  })
})
