import { ForzClient } from '../src/api'
import { dispatch } from '../src/lib/commands'
import * as config from '../src/lib/config'

jest.mock('../src/api')
jest.mock('../src/lib/config')

// `forz <resource> notes <id>` lists comments; `--add <text>` creates one.
// Read-only resources (assets, vendors, …) accept list/get/notes but refuse mutations.
describe('forz <resource> notes', () => {
  const loadMock = config.load as unknown as jest.Mock
  const fromConfigMock = ForzClient.fromConfig as unknown as jest.Mock
  let listNotes: jest.Mock
  let createNote: jest.Mock

  beforeEach(() => {
    loadMock.mockResolvedValue({ baseUrl: 'https://app.forz.io', token: 'fz_x' })
    listNotes = jest.fn().mockResolvedValue({ data: [], hasMore: false })
    createNote = jest.fn().mockResolvedValue({ id: 'n1', description: 'hi' })
    fromConfigMock.mockReturnValue({ resource: () => ({ listNotes, createNote }) })
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  it('lists notes with pagination params', async () => {
    await dispatch(['jobs', 'notes', 'j1', '--limit', '10', '--cursor', 'C1'])
    expect(listNotes).toHaveBeenCalledWith('j1', { limit: 10, cursor: 'C1' })
    expect(createNote).not.toHaveBeenCalled()
  })

  it('creates a note with --add', async () => {
    await dispatch(['tickets', 'notes', 't1', '--add', 'Called back'])
    expect(createNote).toHaveBeenCalledWith('t1', 'Called back')
    expect(listNotes).not.toHaveBeenCalled()
  })

  it('refuses mutations on read-only resources before touching the API', async () => {
    await expect(
      dispatch(['assets', 'update', 'a1', '--if-match', 'x', '--body', '{}'])
    ).rejects.toThrow(/read-only/)
  })
})
