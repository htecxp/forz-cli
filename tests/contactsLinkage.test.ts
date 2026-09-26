import { ForzClient } from '../src/api'
import { dispatch, linkageWarning } from '../src/lib/commands'
import * as config from '../src/lib/config'

jest.mock('../src/lib/config')
jest.mock('../src/api')

// `POST /api/v2/contacts` has been seen returning 201 with linkable_* nulled,
// silently orphaning the contact. linkageWarning detects that symptom on the response rather than
// asserting the server is broken, so it goes quiet once linkage is echoed back.
describe('linkageWarning', () => {
  const linked = { linkable_id: '0190a1b2-9c3d-7e4f-8a1b-2c3d4e5f6071', linkable_type: 'Customer' }

  it('warns when both requested linkage fields come back null', () => {
    const line = linkageWarning('contacts', linked, {
      id: '0190a1b2-0000-7000-8000-000000000001',
      linkable_id: null,
      linkable_type: null,
    })
    expect(line).toContain('linkable_id + linkable_type')
    expect(line).toContain('contacts linkages')
    expect(line?.startsWith('# ')).toBe(true)
  })

  it('warns when the fields are absent from the response entirely', () => {
    expect(linkageWarning('contacts', linked, { id: 'c1' })).toContain(
      'linkable_id + linkable_type'
    )
  })

  it('names only the field that was actually dropped', () => {
    const line = linkageWarning(
      'contacts',
      { linkable_id: '0190a1b2-9c3d-7e4f-8a1b-2c3d4e5f6071' },
      { linkable_id: null, linkable_type: null }
    )
    expect(line).toContain('linkable_id')
    expect(line).not.toContain('linkable_id + linkable_type')
  })

  it('reads linkage from a {contact: ...} wrapped body', () => {
    expect(linkageWarning('contacts', { contact: linked }, { id: 'c1' })).toContain(
      'linkable_id + linkable_type'
    )
  })

  it('stays silent once the server echoes the linkage back', () => {
    expect(linkageWarning('contacts', linked, { id: 'c1', ...linked })).toBeUndefined()
  })

  it('stays silent when the request never asked for linkage', () => {
    expect(
      linkageWarning('contacts', { first_name: 'Jane' }, { id: 'c1', linkable_id: null })
    ).toBeUndefined()
  })

  it('does not treat an explicit null request value as a dropped field', () => {
    expect(linkageWarning('contacts', { linkable_id: null }, { linkable_id: null })).toBeUndefined()
  })

  it('only applies to contacts', () => {
    expect(
      linkageWarning('customers', linked, { id: 'c1', linkable_id: null, linkable_type: null })
    ).toBeUndefined()
  })

  it('tolerates non-object request and response bodies', () => {
    expect(linkageWarning('contacts', 'not-json', { linkable_id: null })).toBeUndefined()
    expect(linkageWarning('contacts', linked, null)).toBeUndefined()
  })
})

// The load-bearing contract: the created record still goes to stdout as clean
// JSON (pipeable to jq); the warning is a stderr side-channel line, like
// `# ETag:` and `# more available`. A dropped linkage is not an error — the
// server returned 201 — so the command must still exit zero.
describe('forz contacts create (handler)', () => {
  const loadMock = config.load as unknown as jest.Mock
  const fromConfigMock = ForzClient.fromConfig as unknown as jest.Mock
  let logSpy: jest.SpyInstance
  let errSpy: jest.SpyInstance

  beforeEach(() => {
    loadMock.mockResolvedValue({ baseUrl: 'https://app.forz.io', token: 'fz_x' })
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    logSpy.mockRestore()
    errSpy.mockRestore()
    jest.clearAllMocks()
  })

  const mockCreate = (created: unknown): jest.Mock => {
    const create = jest.fn().mockResolvedValue(created)
    fromConfigMock.mockReturnValue({ resource: () => ({ create }) })
    return create
  }

  it('prints the record to stdout and the warning to stderr when linkage is dropped', async () => {
    mockCreate({ id: 'c1', first_name: 'Jane', linkable_id: null, linkable_type: null })

    await dispatch([
      'contacts',
      'create',
      '--body',
      '{"first_name":"Jane","linkable_id":"0190a1b2-9c3d-7e4f-8a1b-2c3d4e5f6071","linkable_type":"Customer"}',
    ])

    // stdout stays clean JSON — the warning must not leak into it
    const stdout = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(stdout).toContain('"first_name"')
    expect(stdout).not.toContain('# warning')

    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(errSpy.mock.calls[0][0]).toContain('linkable_id + linkable_type')
  })

  it('says nothing on stderr when the linkage comes back intact', async () => {
    mockCreate({
      id: 'c1',
      linkable_id: '0190a1b2-9c3d-7e4f-8a1b-2c3d4e5f6071',
      linkable_type: 'Customer',
    })

    await dispatch([
      'contacts',
      'create',
      '--body',
      '{"linkable_id":"0190a1b2-9c3d-7e4f-8a1b-2c3d4e5f6071","linkable_type":"Customer"}',
    ])

    expect(errSpy).not.toHaveBeenCalled()
  })

  it('does not warn on other resources that null a same-named field', async () => {
    mockCreate({ id: 'j1', linkable_id: null })

    await dispatch([
      'jobs',
      'create',
      '--body',
      '{"linkable_id":"0190a1b2-9c3d-7e4f-8a1b-2c3d4e5f6071"}',
    ])

    expect(errSpy).not.toHaveBeenCalled()
  })
})
