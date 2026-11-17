import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig, ConfigError } from './config.ts'

const env = { BLOG_TOKEN: 'secret' }

function site(overrides: Record<string, unknown> = {}) {
  return {
    id: 'example-blog',
    handle: 'You',
    domain: 'Blog.Example.dev',
    feedUrl: 'https://blog.example.dev/feed.xml',
    name: 'Example Blog',
    syncTokenEnv: 'BLOG_TOKEN',
    ...overrides,
  }
}

test('parses a valid config and normalizes handle and domain', () => {
  const config = parseConfig({ publicUrl: 'https://ap.example.dev', sites: [site()] }, env)
  assert.equal(config.publicUrl.origin, 'https://ap.example.dev')
  const [s] = config.sites
  assert.equal(s.handle, 'you')
  assert.equal(s.domain, 'blog.example.dev')
  assert.equal(s.feedUrl.href, 'https://blog.example.dev/feed.xml')
  assert.equal(s.syncToken, 'secret')
  assert.equal(s.deleteMissing, false)
  assert.equal(s.summary, undefined)
  assert.equal(s.icon, undefined)
})

test('reads deleteMissing, summary and icon', () => {
  const config = parseConfig(
    { publicUrl: 'https://ap.example.dev', sites: [site({ deleteMissing: true, summary: 'hi', icon: 'https://x.dev/a.png' })] },
    env,
  )
  assert.equal(config.sites[0].deleteMissing, true)
  assert.equal(config.sites[0].summary, 'hi')
  assert.equal(config.sites[0].icon?.href, 'https://x.dev/a.png')
})

test('rejects duplicate site ids', () => {
  assert.throws(
    () => parseConfig({ publicUrl: 'https://ap.example.dev', sites: [site(), site({ handle: 'other' })] }, env),
    { name: 'ConfigError', message: /sites\[1\]\.id duplicates "example-blog"/ },
  )
})

test('rejects duplicate handles, case-insensitively', () => {
  assert.throws(
    () => parseConfig({ publicUrl: 'https://ap.example.dev', sites: [site(), site({ id: 'other', handle: 'YOU' })] }, env),
    { name: 'ConfigError', message: /sites\[1\]\.handle duplicates "you"/ },
  )
})

test('rejects non-https URLs except localhost', () => {
  assert.throws(
    () => parseConfig({ publicUrl: 'http://ap.example.dev', sites: [site()] }, env),
    { name: 'ConfigError', message: /publicUrl must use https/ },
  )
  assert.throws(
    () => parseConfig({ publicUrl: 'https://ap.example.dev', sites: [site({ feedUrl: 'http://x.dev/feed.xml' })] }, env),
    { name: 'ConfigError', message: /sites\[0\]\.feedUrl must use https/ },
  )
  const local = parseConfig({ publicUrl: 'http://localhost:8080', sites: [site({ feedUrl: 'http://127.0.0.1:9000/feed.xml' })] }, env)
  assert.equal(local.publicUrl.origin, 'http://localhost:8080')
})

test('rejects a publicUrl with a path', () => {
  assert.throws(
    () => parseConfig({ publicUrl: 'https://example.dev/ap', sites: [site()] }, env),
    { name: 'ConfigError', message: /publicUrl must not have a path or query/ },
  )
})

test('rejects an unset token variable', () => {
  assert.throws(
    () => parseConfig({ publicUrl: 'https://ap.example.dev', sites: [site()] }, {}),
    { name: 'ConfigError', message: /environment variable BLOG_TOKEN is not set/ },
  )
})

test('rejects missing fields and bad shapes', () => {
  assert.throws(() => parseConfig(null, env), ConfigError)
  assert.throws(() => parseConfig({ publicUrl: 'https://ap.example.dev', sites: [] }, env), /sites must be a non-empty array/)
  assert.throws(() => parseConfig({ publicUrl: 'https://ap.example.dev', sites: [site({ name: undefined })] }, env), /sites\[0\]\.name is required/)
  assert.throws(() => parseConfig({ publicUrl: 'https://ap.example.dev', sites: [site({ id: 'Bad Id' })] }, env), /sites\[0\]\.id must match/)
  assert.throws(() => parseConfig({ publicUrl: 'https://ap.example.dev', sites: [site({ handle: 'a-b' })] }, env), /sites\[0\]\.handle must match/)
  assert.throws(() => parseConfig({ publicUrl: 'https://ap.example.dev', sites: [site({ domain: 'localhost' })] }, env), /sites\[0\]\.domain must be a hostname/)
  assert.throws(() => parseConfig({ publicUrl: 'https://ap.example.dev', sites: [site({ deleteMissing: 'yes' })] }, env), /sites\[0\]\.deleteMissing must be true or false/)
})

const emailBlock = {
  from: 'Inner <you@example.dev>',
  checkInboxUrl: 'https://blog.example.dev/check-inbox',
  confirmedUrl: 'https://blog.example.dev/confirmed',
  unsubscribedUrl: 'https://blog.example.dev/unsubscribed',
}
const smtpBlock = { host: 'smtp.migadu.com', userEnv: 'SMTP_USER', passwordEnv: 'SMTP_PASSWORD' }
const smtpEnv = { ...env, SMTP_USER: 'u', SMTP_PASSWORD: 'p' }
const withEmail = (email: Record<string, unknown> = {}, smtp: Record<string, unknown> | undefined = smtpBlock, e: Record<string, string> = smtpEnv) =>
  parseConfig({ publicUrl: 'https://ap.example.dev', smtp, sites: [site({ email: { ...emailBlock, ...email } })] }, e)

test('parses smtp and site email', () => {
  const config = withEmail()
  assert.deepEqual(config.smtp, { host: 'smtp.migadu.com', port: 587, user: 'u', password: 'p', pauseMs: 1000 })
  assert.ok(config.sites[0].email?.confirmedUrl instanceof URL)
  assert.equal(config.sites[0].email?.from, 'Inner <you@example.dev>')
})

test('sites without email need no smtp', () => {
  const config = parseConfig({ publicUrl: 'https://ap.example.dev', sites: [site()] }, env)
  assert.equal(config.smtp, undefined)
  assert.equal(config.sites[0].email, undefined)
})

test('accepts from as bare address or with a display name', () => {
  assert.ok(withEmail({ from: 'you@example.dev' }))
  assert.ok(withEmail({ from: 'Name <you@example.dev>' }))
})

test('rejects bad smtp and email config', () => {
  assert.throws(
    () => parseConfig({ publicUrl: 'https://ap.example.dev', sites: [site({ email: emailBlock })] }, smtpEnv),
    /smtp is required/,
  )
  assert.throws(() => withEmail({}, smtpBlock, env), /smtp\.userEnv/)
  assert.throws(() => withEmail({}, { ...smtpBlock, port: 0 }), /smtp\.port/)
  assert.throws(() => withEmail({}, { ...smtpBlock, port: '587' }), /smtp\.port/)
  assert.throws(() => withEmail({}, { ...smtpBlock, pauseMs: -1 }), /smtp\.pauseMs/)
  assert.throws(() => withEmail({ from: 'not an address' }), /email\.from/)
  assert.throws(() => withEmail({ confirmedUrl: 'http://example.dev/x' }), /email\.confirmedUrl must use https/)
})
