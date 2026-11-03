import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig, ConfigError } from './config.ts'

const env = { BLOG_TOKEN: 'secret' }

function site(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inner-monologue',
    handle: 'Nico',
    domain: 'InnerMonologue.nbaglivo.dev',
    feedUrl: 'https://innermonologue.nbaglivo.dev/feed.xml',
    name: 'The Open Inner Monologue',
    syncTokenEnv: 'BLOG_TOKEN',
    ...overrides,
  }
}

test('parses a valid config and normalizes handle and domain', () => {
  const config = parseConfig({ publicUrl: 'https://ap.nbaglivo.dev', sites: [site()] }, env)
  assert.equal(config.publicUrl.origin, 'https://ap.nbaglivo.dev')
  const [s] = config.sites
  assert.equal(s.handle, 'nico')
  assert.equal(s.domain, 'innermonologue.nbaglivo.dev')
  assert.equal(s.feedUrl.href, 'https://innermonologue.nbaglivo.dev/feed.xml')
  assert.equal(s.syncToken, 'secret')
  assert.equal(s.deleteMissing, false)
  assert.equal(s.summary, undefined)
  assert.equal(s.icon, undefined)
})

test('reads deleteMissing, summary and icon', () => {
  const config = parseConfig(
    { publicUrl: 'https://ap.nbaglivo.dev', sites: [site({ deleteMissing: true, summary: 'hi', icon: 'https://x.dev/a.png' })] },
    env,
  )
  assert.equal(config.sites[0].deleteMissing, true)
  assert.equal(config.sites[0].summary, 'hi')
  assert.equal(config.sites[0].icon?.href, 'https://x.dev/a.png')
})

test('rejects duplicate site ids', () => {
  assert.throws(
    () => parseConfig({ publicUrl: 'https://ap.nbaglivo.dev', sites: [site(), site({ handle: 'other' })] }, env),
    { name: 'ConfigError', message: /sites\[1\]\.id duplicates "inner-monologue"/ },
  )
})

test('rejects duplicate handles, case-insensitively', () => {
  assert.throws(
    () => parseConfig({ publicUrl: 'https://ap.nbaglivo.dev', sites: [site(), site({ id: 'other', handle: 'NICO' })] }, env),
    { name: 'ConfigError', message: /sites\[1\]\.handle duplicates "nico"/ },
  )
})

test('rejects non-https URLs except localhost', () => {
  assert.throws(
    () => parseConfig({ publicUrl: 'http://ap.nbaglivo.dev', sites: [site()] }, env),
    { name: 'ConfigError', message: /publicUrl must use https/ },
  )
  assert.throws(
    () => parseConfig({ publicUrl: 'https://ap.nbaglivo.dev', sites: [site({ feedUrl: 'http://x.dev/feed.xml' })] }, env),
    { name: 'ConfigError', message: /sites\[0\]\.feedUrl must use https/ },
  )
  const local = parseConfig({ publicUrl: 'http://localhost:8080', sites: [site({ feedUrl: 'http://127.0.0.1:9000/feed.xml' })] }, env)
  assert.equal(local.publicUrl.origin, 'http://localhost:8080')
})

test('rejects a publicUrl with a path', () => {
  assert.throws(
    () => parseConfig({ publicUrl: 'https://nbaglivo.dev/ap', sites: [site()] }, env),
    { name: 'ConfigError', message: /publicUrl must not have a path or query/ },
  )
})

test('rejects an unset token variable', () => {
  assert.throws(
    () => parseConfig({ publicUrl: 'https://ap.nbaglivo.dev', sites: [site()] }, {}),
    { name: 'ConfigError', message: /environment variable BLOG_TOKEN is not set/ },
  )
})

test('rejects missing fields and bad shapes', () => {
  assert.throws(() => parseConfig(null, env), ConfigError)
  assert.throws(() => parseConfig({ publicUrl: 'https://ap.nbaglivo.dev', sites: [] }, env), /sites must be a non-empty array/)
  assert.throws(() => parseConfig({ publicUrl: 'https://ap.nbaglivo.dev', sites: [site({ name: undefined })] }, env), /sites\[0\]\.name is required/)
  assert.throws(() => parseConfig({ publicUrl: 'https://ap.nbaglivo.dev', sites: [site({ id: 'Bad Id' })] }, env), /sites\[0\]\.id must match/)
  assert.throws(() => parseConfig({ publicUrl: 'https://ap.nbaglivo.dev', sites: [site({ handle: 'a-b' })] }, env), /sites\[0\]\.handle must match/)
  assert.throws(() => parseConfig({ publicUrl: 'https://ap.nbaglivo.dev', sites: [site({ domain: 'localhost' })] }, env), /sites\[0\]\.domain must be a hostname/)
  assert.throws(() => parseConfig({ publicUrl: 'https://ap.nbaglivo.dev', sites: [site({ deleteMissing: 'yes' })] }, env), /sites\[0\]\.deleteMissing must be true or false/)
})

const emailBlock = {
  from: 'Inner <nico@nbaglivo.dev>',
  checkInboxUrl: 'https://innermonologue.nbaglivo.dev/check-inbox',
  confirmedUrl: 'https://innermonologue.nbaglivo.dev/confirmed',
  unsubscribedUrl: 'https://innermonologue.nbaglivo.dev/unsubscribed',
}
const smtpBlock = { host: 'smtp.migadu.com', userEnv: 'SMTP_USER', passwordEnv: 'SMTP_PASSWORD' }
const smtpEnv = { ...env, SMTP_USER: 'u', SMTP_PASSWORD: 'p' }
const withEmail = (email: Record<string, unknown> = {}, smtp: Record<string, unknown> | undefined = smtpBlock, e: Record<string, string> = smtpEnv) =>
  parseConfig({ publicUrl: 'https://ap.nbaglivo.dev', smtp, sites: [site({ email: { ...emailBlock, ...email } })] }, e)

test('parses smtp and site email', () => {
  const config = withEmail()
  assert.deepEqual(config.smtp, { host: 'smtp.migadu.com', port: 587, user: 'u', password: 'p', pauseMs: 1000 })
  assert.ok(config.sites[0].email?.confirmedUrl instanceof URL)
  assert.equal(config.sites[0].email?.from, 'Inner <nico@nbaglivo.dev>')
})

test('sites without email need no smtp', () => {
  const config = parseConfig({ publicUrl: 'https://ap.nbaglivo.dev', sites: [site()] }, env)
  assert.equal(config.smtp, undefined)
  assert.equal(config.sites[0].email, undefined)
})

test('accepts from as bare address or with a display name', () => {
  assert.ok(withEmail({ from: 'nico@nbaglivo.dev' }))
  assert.ok(withEmail({ from: 'Name <nico@nbaglivo.dev>' }))
})

test('rejects bad smtp and email config', () => {
  assert.throws(
    () => parseConfig({ publicUrl: 'https://ap.nbaglivo.dev', sites: [site({ email: emailBlock })] }, smtpEnv),
    /smtp is required/,
  )
  assert.throws(() => withEmail({}, smtpBlock, env), /smtp\.userEnv/)
  assert.throws(() => withEmail({}, { ...smtpBlock, port: 0 }), /smtp\.port/)
  assert.throws(() => withEmail({}, { ...smtpBlock, port: '587' }), /smtp\.port/)
  assert.throws(() => withEmail({}, { ...smtpBlock, pauseMs: -1 }), /smtp\.pauseMs/)
  assert.throws(() => withEmail({ from: 'not an address' }), /email\.from/)
  assert.throws(() => withEmail({ confirmedUrl: 'http://example.dev/x' }), /email\.confirmedUrl must use https/)
})
