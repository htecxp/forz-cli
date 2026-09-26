import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

import * as config from '../src/lib/config'

// Real config module against a throwaway HOME (never touch ~/.forz).
describe('config file', () => {
  let home: string
  const realHome = process.env.HOME

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'forz-home-'))
    process.env.HOME = home
  })
  afterEach(async () => {
    process.env.HOME = realHome
    await fs.rm(home, { recursive: true, force: true })
  })

  it('writes the file with mode 0600, fixing a looser existing mode', async () => {
    await fs.mkdir(config.configDir(), { recursive: true })
    await fs.writeFile(config.configPath(), '{}', { mode: 0o644 })
    await config.update({ token: 'fz_x' })
    expect((await fs.stat(config.configPath())).mode & 0o777).toBe(0o600)
    expect((await config.load()).token).toBe('fz_x')
  })

  it('names the file when the config is corrupt', async () => {
    await fs.mkdir(config.configDir(), { recursive: true })
    await fs.writeFile(config.configPath(), '{nope')
    await expect(config.load()).rejects.toThrow(config.configPath())
  })
})
