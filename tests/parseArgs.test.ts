import { parseArgs } from '../src/lib/commands'

describe('parseArgs', () => {
  it('separates positional args and flags', () => {
    const r = parseArgs(['list', '--limit', '10', '--q', 'foo', 'extra'])
    expect(r.positional).toEqual(['list', 'extra'])
    expect(r.flags).toEqual({ limit: '10', q: 'foo' })
  })

  it('supports --key=value form', () => {
    const r = parseArgs(['--token=abc', '--workspace=ws1'])
    expect(r.flags).toEqual({ token: 'abc', workspace: 'ws1' })
  })

  it('treats trailing flag with no value as boolean true', () => {
    const r = parseArgs(['cmd', '--verbose'])
    expect(r.flags.verbose).toBe(true)
    expect(r.positional).toEqual(['cmd'])
  })

  it('greedily consumes the next non-flag arg as value', () => {
    const r = parseArgs(['--verbose', 'cmd'])
    expect(r.flags.verbose).toBe('cmd')
    expect(r.positional).toEqual([])
  })
})
