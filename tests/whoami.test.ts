import { ForzClient } from '../src/api'
import { dispatch, whoamiSummary } from '../src/lib/commands'
import * as config from '../src/lib/config'
import { HttpError } from '../src/lib/http'

jest.mock('../src/lib/config')
jest.mock('../src/api')

// `forz whoami` prints the GET /api/v2/me payload as JSON to stdout and a single
// human summary line to stderr. whoamiSummary builds that stderr line. There is
// one environment, so the line is "# connected to <account name> as <email>" —
// no (env) segment.
describe('whoamiSummary', () => {
  it('formats the account name and user email into a stderr summary line', () => {
    expect(
      whoamiSummary({
        account: { id: 42, name: 'Acme Co' },
        user: { id: 7, name: 'Jane Doe', email: 'jane@acme.com' },
        api_key: { id: '0190a1b2', scopes: ['customers:read'] },
        api_version: '2026-04-30',
      })
    ).toBe('# connected to Acme Co as jane@acme.com')
  })

  it('falls back gracefully when the payload is empty', () => {
    expect(whoamiSummary({})).toBe('# connected to unknown account as unknown user')
  })

  it('tolerates a partial payload (account present, user missing)', () => {
    expect(whoamiSummary({ account: { name: 'Acme Co' } })).toBe(
      '# connected to Acme Co as unknown user'
    )
  })

  it('never embeds an environment segment', () => {
    const line = whoamiSummary({
      account: { name: 'Acme Co' },
      user: { email: 'jane@acme.com' },
    })
    expect(line).not.toMatch(/\(.*\)/)
    expect(line).not.toMatch(/live|test|environment/i)
  })
})

// The handler is the load-bearing contract: the JSON payload goes to stdout
// (pipeable to jq) and the human summary goes to stderr, never the reverse.
describe('forz whoami (handler)', () => {
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

  it('sends the identity JSON to stdout and only the summary to stderr', async () => {
    const raw = jest.fn().mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        data: {
          account: { id: 42, name: 'Acme Co' },
          user: { id: 7, name: 'Jane Doe', email: 'jane@acme.com' },
          api_key: { id: 'k1', scopes: ['customers:read'] },
          api_version: '2026-04-30',
        },
      },
    })
    fromConfigMock.mockReturnValue({ raw })

    await dispatch(['whoami'])

    expect(raw).toHaveBeenCalledWith('/api/v2/me')

    // stdout = the unwrapped JSON payload, and NOT the summary line
    const stdout = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(stdout).toContain('"account"')
    expect(stdout).toContain('Acme Co')
    expect(stdout).not.toContain('# connected')

    // stderr = exactly the one human summary line
    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalledWith('# connected to Acme Co as jane@acme.com')
  })

  it('propagates an auth error (so the CLI exits non-zero) and prints nothing to stdout', async () => {
    const raw = jest
      .fn()
      .mockRejectedValue(new HttpError(401, { code: 'auth.invalid_token' }, 'Invalid or expired API key'))
    fromConfigMock.mockReturnValue({ raw })

    await expect(dispatch(['whoami'])).rejects.toBeInstanceOf(HttpError)
    expect(logSpy).not.toHaveBeenCalled()
  })
})
