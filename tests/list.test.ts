import { ForzClient } from '../src/api'
import { dispatch } from '../src/lib/commands'
import * as config from '../src/lib/config'

jest.mock('../src/api')
jest.mock('../src/lib/config')

// `forz <resource> list` turns flags into query params: cursor/limit plus the
// first-class --sort/--q and any --filter.<key>. This pins that wiring so a
// regression can't silently drop sort/search the way --filter-only did before.
describe('forz <resource> list — flag → query-param forwarding', () => {
  const loadMock = config.load as unknown as jest.Mock
  const fromConfigMock = ForzClient.fromConfig as unknown as jest.Mock
  let listMock: jest.Mock

  beforeEach(() => {
    loadMock.mockResolvedValue({ baseUrl: 'https://app.forz.io', token: 'fz_x' })
    listMock = jest.fn().mockResolvedValue({ data: [], hasMore: false })
    fromConfigMock.mockReturnValue({
      resource: () => ({ list: listMock }),
      lookup: () => ({ list: listMock }),
    })
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  it('forwards --limit, --cursor, --sort, --q and --filter.* as query params', async () => {
    await dispatch([
      'customers',
      'list',
      '--limit',
      '50',
      '--cursor',
      'C1',
      '--sort=-created_at',
      '--q',
      'acme',
      '--filter.status',
      'Open',
    ])
    expect(listMock).toHaveBeenCalledWith({
      limit: 50,
      cursor: 'C1',
      sort: '-created_at',
      q: 'acme',
      status: 'Open',
    })
  })

  it('passes no list params when none are supplied', async () => {
    await dispatch(['customers', 'list'])
    expect(listMock).toHaveBeenCalledWith({})
  })
})
