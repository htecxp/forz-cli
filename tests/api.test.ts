import { FINANCIAL_RESOURCES, ForzClient } from '../src/api'
import type { Response } from '../src/lib/http'

// Minimal stub for ForzClient.raw — only the fields the api layer reads.
const stubResponse = <T>(body: T, headers: Record<string, string> = {}): Response<T> => ({
  status: 200,
  headers,
  body,
  raw: '',
})

afterEach(() => jest.restoreAllMocks())

describe('FINANCIAL_RESOURCES', () => {
  it('matches the financial resources from the v2 spec', () => {
    expect([...FINANCIAL_RESOURCES].sort()).toEqual(['invoices', 'sales_orders'])
  })
})

describe('ForzClient', () => {
  it('defaults baseUrl to app.forz.io', () => {
    expect(new ForzClient().baseUrl).toBe('https://app.forz.io')
  })

  it('exposes Resource and ListResource factories', () => {
    const client = new ForzClient({ token: 'fz_x' })
    expect(client.resource('customers').name).toBe('customers')
    expect(client.lookup('job_types').name).toBe('job_types')
  })
})

// The spec ETag is a weak ETag W/"<epoch>-<lock>" and must be passed back to the
// server verbatim as If-Match. A "helpful" quote-strip would silently break updates.
describe('Resource.get ETag', () => {
  it('returns the ETag header verbatim (W/ prefix and quotes intact)', async () => {
    const client = new ForzClient({ token: 'fz_x' })
    jest
      .spyOn(client, 'raw')
      .mockResolvedValue(stubResponse({ data: { id: 'x' } }, { etag: 'W/"1745596800-3"' }))
    const { etag } = await client.resource('customers').get('x')
    expect(etag).toBe('W/"1745596800-3"')
  })
})

// update/delete are optimistic-concurrency guarded: without an If-Match ETag they must
// throw locally and never reach the API (the server would otherwise return 428).
describe('optimistic concurrency guards', () => {
  it('refuses update without an If-Match ETag and never calls the API', async () => {
    const client = new ForzClient({ token: 'fz_x' })
    const rawSpy = jest.spyOn(client, 'raw')
    await expect(
      client.resource('customers').update('x', { organization: 'New' })
    ).rejects.toThrow(/If-Match/)
    expect(rawSpy).not.toHaveBeenCalled()
  })

  it('refuses delete without an If-Match ETag and never calls the API', async () => {
    const client = new ForzClient({ token: 'fz_x' })
    const rawSpy = jest.spyOn(client, 'raw')
    await expect(client.resource('customers').delete('x')).rejects.toThrow(/If-Match/)
    expect(rawSpy).not.toHaveBeenCalled()
  })

  it('sends the If-Match header on update when an ETag is supplied', async () => {
    const client = new ForzClient({ token: 'fz_x' })
    const rawSpy = jest.spyOn(client, 'raw').mockResolvedValue(stubResponse({ data: {} }))
    await client.resource('customers').update('x', { organization: 'New' }, { ifMatch: 'W/"1-2"' })
    expect(rawSpy).toHaveBeenCalledWith(
      '/api/v2/customers/x',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({ 'If-Match': 'W/"1-2"' }),
      })
    )
  })
})

// Idempotency-Key is auto-injected only on financial creates (invoices, sales_orders).
describe('idempotency scoping', () => {
  const headersOf = (spy: jest.SpyInstance): Record<string, string | undefined> =>
    (spy.mock.calls[0][1] as unknown as { headers: Record<string, string | undefined> }).headers

  it('auto-generates an Idempotency-Key for financial creates', async () => {
    const client = new ForzClient({ token: 'fz_x' })
    const rawSpy = jest.spyOn(client, 'raw').mockResolvedValue(stubResponse({ data: {} }))
    await client.resource('invoices').create({})
    const key = headersOf(rawSpy)['Idempotency-Key']
    expect(typeof key).toBe('string')
    expect((key as string).length).toBeGreaterThan(0)
  })

  it('omits the Idempotency-Key for non-financial creates', async () => {
    const client = new ForzClient({ token: 'fz_x' })
    const rawSpy = jest.spyOn(client, 'raw').mockResolvedValue(stubResponse({ data: {} }))
    await client.resource('customers').create({ organization: 'Acme' })
    expect(headersOf(rawSpy)['Idempotency-Key']).toBeUndefined()
  })

  it('honors an explicit idempotency key override on a financial create', async () => {
    const client = new ForzClient({ token: 'fz_x' })
    const rawSpy = jest.spyOn(client, 'raw').mockResolvedValue(stubResponse({ data: {} }))
    await client.resource('invoices').create({}, { idempotencyKey: 'my-key' })
    expect(headersOf(rawSpy)['Idempotency-Key']).toBe('my-key')
  })
})

// list unwraps the {data, has_more} envelope and pulls the next cursor out of the
// RFC 5988 Link header so callers can drive --cursor pagination.
describe('list pagination', () => {
  it('unwraps {data, has_more} and extracts the next cursor from the Link header', async () => {
    const client = new ForzClient({ token: 'fz_x' })
    jest.spyOn(client, 'raw').mockResolvedValue(
      stubResponse(
        { data: [{ id: '1' }], has_more: true },
        { link: '<https://app.forz.io/api/v2/customers?cursor=ABC&limit=25>; rel="next"' }
      )
    )
    const page = await client.resource('customers').list({ limit: 25 })
    expect(page.data).toEqual([{ id: '1' }])
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).toBe('ABC')
  })

  it('reports no next cursor when the Link header is absent', async () => {
    const client = new ForzClient({ token: 'fz_x' })
    jest.spyOn(client, 'raw').mockResolvedValue(stubResponse({ data: [], has_more: false }))
    const page = await client.resource('customers').list()
    expect(page.hasMore).toBe(false)
    expect(page.nextCursor).toBeUndefined()
  })
})
