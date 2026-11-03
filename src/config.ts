import { readFileSync } from 'node:fs'
import { isEmailAddress } from './address.ts'

export type SmtpConfig = { host: string; port: number; user: string; password: string; pauseMs: number }

export type SiteEmailConfig = { from: string; checkInboxUrl: URL; confirmedUrl: URL; unsubscribedUrl: URL }

export type SiteConfig = {
  id: string
  handle: string
  domain: string
  feedUrl: URL
  name: string
  summary: string | undefined
  icon: URL | undefined
  syncToken: string
  deleteMissing: boolean
  email: SiteEmailConfig | undefined
}

export type Config = { publicUrl: URL; sites: SiteConfig[]; smtp: SmtpConfig | undefined }

export type Env = Record<string, string | undefined>

export class ConfigError extends Error {
  name = 'ConfigError'
}

const ID = /^[a-z0-9][a-z0-9-]*$/
const HANDLE = /^[a-z0-9_]+$/
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(obj: Record<string, unknown>, key: string, at: string): string {
  const value = obj[key]
  if (typeof value !== 'string' || value.trim() === '') throw new ConfigError(`${at}.${key} is required`)
  return value.trim()
}

function optionalString(obj: Record<string, unknown>, key: string, at: string): string | undefined {
  const value = obj[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new ConfigError(`${at}.${key} must be a string`)
  return value
}

function secureUrl(value: unknown, field: string): URL {
  if (typeof value !== 'string') throw new ConfigError(`${field} is required`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(`${field} is not a valid URL: ${value}`)
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new ConfigError(`${field} must use https: ${value}`)
  }
  return url
}

function integerIn(obj: Record<string, unknown>, key: string, at: string, min: number, max: number, fallback: number): number {
  const value = obj[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${at}.${key} must be an integer between ${min} and ${max}`)
  }
  return value
}

function envValue(obj: Record<string, unknown>, key: string, at: string, env: Env): string {
  const name = requiredString(obj, key, at)
  const value = env[name]
  if (!value) throw new ConfigError(`${at}.${key}: environment variable ${name} is not set`)
  return value
}

function parseSmtp(raw: unknown, env: Env): SmtpConfig | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) throw new ConfigError('smtp must be an object')
  return {
    host: requiredString(raw, 'host', 'smtp'),
    port: integerIn(raw, 'port', 'smtp', 1, 65535, 587),
    user: envValue(raw, 'userEnv', 'smtp', env),
    password: envValue(raw, 'passwordEnv', 'smtp', env),
    pauseMs: integerIn(raw, 'pauseMs', 'smtp', 0, Number.MAX_SAFE_INTEGER, 1000),
  }
}

function parseSiteEmail(raw: unknown, at: string): SiteEmailConfig | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) throw new ConfigError(`${at}.email must be an object`)
  const from = requiredString(raw, 'from', `${at}.email`)
  const address = from.match(/<([^<>]*)>\s*$/)?.[1] ?? from
  if (!isEmailAddress(address.trim())) throw new ConfigError(`${at}.email.from is not a valid address: ${from}`)
  return {
    from,
    checkInboxUrl: secureUrl(raw.checkInboxUrl, `${at}.email.checkInboxUrl`),
    confirmedUrl: secureUrl(raw.confirmedUrl, `${at}.email.confirmedUrl`),
    unsubscribedUrl: secureUrl(raw.unsubscribedUrl, `${at}.email.unsubscribedUrl`),
  }
}

export function parseConfig(raw: unknown, env: Env): Config {
  if (!isRecord(raw)) throw new ConfigError('config must be a JSON object')

  const publicUrl = secureUrl(raw.publicUrl, 'publicUrl')
  if (publicUrl.pathname !== '/' || publicUrl.search !== '') {
    throw new ConfigError('publicUrl must not have a path or query')
  }

  if (!Array.isArray(raw.sites) || raw.sites.length === 0) throw new ConfigError('sites must be a non-empty array')

  const smtp = parseSmtp(raw.smtp, env)

  const ids = new Set<string>()
  const handles = new Set<string>()

  const sites = raw.sites.map((entry: unknown, i: number): SiteConfig => {
    const at = `sites[${i}]`
    if (!isRecord(entry)) throw new ConfigError(`${at} must be an object`)

    const id = requiredString(entry, 'id', at)
    if (!ID.test(id)) throw new ConfigError(`${at}.id must match ${ID}`)
    if (ids.has(id)) throw new ConfigError(`${at}.id duplicates "${id}"`)
    ids.add(id)

    const handle = requiredString(entry, 'handle', at).toLowerCase()
    if (!HANDLE.test(handle)) throw new ConfigError(`${at}.handle must match ${HANDLE}`)
    if (handles.has(handle)) throw new ConfigError(`${at}.handle duplicates "${handle}"`)
    handles.add(handle)

    const domain = requiredString(entry, 'domain', at).toLowerCase()
    if (!HOSTNAME.test(domain)) throw new ConfigError(`${at}.domain must be a hostname like blog.example.dev`)

    const feedUrl = secureUrl(entry.feedUrl, `${at}.feedUrl`)
    const name = requiredString(entry, 'name', at)
    const summary = optionalString(entry, 'summary', at)
    const icon = entry.icon === undefined ? undefined : secureUrl(entry.icon, `${at}.icon`)

    const tokenEnv = requiredString(entry, 'syncTokenEnv', at)
    const syncToken = env[tokenEnv]
    if (!syncToken) throw new ConfigError(`${at}.syncTokenEnv: environment variable ${tokenEnv} is not set`)

    if (entry.deleteMissing !== undefined && typeof entry.deleteMissing !== 'boolean') {
      throw new ConfigError(`${at}.deleteMissing must be true or false`)
    }

    const email = parseSiteEmail(entry.email, at)

    return { id, handle, domain, feedUrl, name, summary, icon, syncToken, deleteMissing: entry.deleteMissing === true, email }
  })

  if (!smtp && sites.some((site) => site.email)) throw new ConfigError('smtp is required when a site has email')

  return { publicUrl, sites, smtp }
}

export function loadConfig(path: string, env: Env = process.env): Config {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (error) {
    throw new ConfigError(`could not read config at ${path}: ${(error as Error).message}`)
  }
  return parseConfig(raw, env)
}
