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

  it('never lets --clear swallow a positional', () => {
    const r = parseArgs(['customers', 'attach', '--clear', 'c1', 'f1'])
    expect(r.flags.clear).toBe(true)
    expect(r.positional).toEqual(['customers', 'attach', 'c1', 'f1'])
  })

  it('greedily consumes the next non-flag arg as value', () => {
    const r = parseArgs(['--verbose', 'cmd'])
    expect(r.flags.verbose).toBe('cmd')
    expect(r.positional).toEqual([])
  })
})

describe('parseArgs dash-leading values', () => {
  it('keeps a value that starts with a single dash', () => {
    const r = parseArgs(['--sort', '-created_at', '--add', '-foo', '--body', '@-'])
    expect(r.flags).toEqual({ sort: '-created_at', add: '-foo', body: '@-' })
  })

  it('does not consume a following --flag, and boolean flags never take a value', () => {
    const r = parseArgs(['--add', '--body', '{}', '--include', '/api/v2/me'])
    expect(r.flags).toEqual({ add: true, body: '{}', include: true })
    expect(r.positional).toEqual(['/api/v2/me'])
  })
})
