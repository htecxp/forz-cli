import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

export interface Config {
  /** API base URL — defaults to https://app.forz.io (staging: https://staging.forz.io). */
  baseUrl: string
  /** API key in the form `fz_(live|test)_<UUIDv7>` (Bearer token). */
  token?: string
}

const DEFAULT_BASE_URL = 'https://app.forz.io'

export const configDir = (): string => path.join(os.homedir(), '.forz')
export const configPath = (): string => path.join(configDir(), 'config.json')

const defaults: Config = {
  baseUrl: DEFAULT_BASE_URL,
}

export const load = async (): Promise<Config> => {
  try {
    const raw = await fs.readFile(configPath(), { encoding: 'utf8' })
    return { ...defaults, ...JSON.parse(raw) }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaults }
    throw e
  }
}

export const save = async (config: Config): Promise<void> => {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 })
  await fs.writeFile(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 })
}

export const update = async (patch: Partial<Config>): Promise<Config> => {
  const current = await load()
  const next = { ...current, ...patch }
  await save(next)
  return next
}

export const clear = async (): Promise<void> => {
  try {
    await fs.unlink(configPath())
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}
