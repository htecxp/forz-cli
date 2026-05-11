import { FINANCIAL_RESOURCES, ForzClient } from '../src/api'

describe('FINANCIAL_RESOURCES', () => {
  it('matches the three financial resources from the v2 spec', () => {
    expect([...FINANCIAL_RESOURCES].sort()).toEqual([
      'inventory_transfers',
      'invoices',
      'sales_orders',
    ])
  })
})

describe('ForzClient', () => {
  it('defaults baseUrl to app.forz.io', () => {
    expect(new ForzClient().baseUrl).toBe('https://app.forz.io')
  })

  it('exposes Resource and ListResource factories', () => {
    const client = new ForzClient({ token: 'fz_test_x' })
    expect(client.resource('customers').name).toBe('customers')
    expect(client.lookup('job_types').name).toBe('job_types')
  })
})
