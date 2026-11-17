import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MemoryKvStore } from '@fedify/fedify'
import { Store } from './store.ts'
import { buildFederation } from './federation.ts'
import { buildApp, findSiteByResource } from './app.ts'
import { FeedError } from './feed.ts'
import { GuardError } from './diff.ts'
import { TEST_CONFIG } from '../test/fake-remote.ts'
import type { SyncResult } from './sync.ts'
import { captureLogs } from '../test/logs.ts'
import { expiredLinkPage, unsubscribePage, unsubscribeUrl } from './emails.ts'
import type { Config } from './config.ts'

function setup(sync: (siteId: string) => Promise<SyncResult> = async () => ({ new: 1, updated: 0, deleted: 0, emails: 0 })) {
  const store = new Store(new DatabaseSync(':memory:'))
  store.migrate()
  const federation = buildFederation({ config: TEST_CONFIG, store, kv: new MemoryKvStore() })
  const calls: string[] = []
  const app = buildApp({
    config: TEST_CONFIG,
    federation,
    syncer: {
      sync: (siteId) => {
        calls.push(siteId)
        return sync(siteId)
      },
    },
  })
  const request = (path: string, init?: RequestInit) => app.request(`https://ap.test${path}`, init)
  return { app, calls, request }
}

test('findSiteByResource accepts the usual resource forms', () => {
  for (const resource of [
    'acct:you@blog.test',
    'you@blog.test',
    'acct:YOU@Blog.TEST',
    'acct:you@ap.test',
    'https://ap.test/users/example-blog',
  ]) {
    assert.equal(findSiteByResource(TEST_CONFIG, resource)?.id, 'example-blog', resource)
  }
  for (const resource of ['acct:you@other.test', 'acct:someone@blog.test', 'https://ap.test/users/nope', 'garbage']) {
    assert.equal(findSiteByResource(TEST_CONFIG, resource), undefined, resource)
  }
})

test('webfinger answers with the site handle and the actor link', async () => {
  const { request } = setup()
  const res = await request('/.well-known/webfinger?resource=acct:you@ap.test')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /application\/jrd\+json/)
  assert.deepEqual(await res.json(), {
    subject: 'acct:you@blog.test',
    aliases: ['https://ap.test/users/example-blog'],
    links: [
      { rel: 'self', type: 'application/activity+json', href: 'https://ap.test/users/example-blog' },
      { rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: 'https://blog.test/' },
    ],
  })
})

test('webfinger errors', async () => {
  const { request } = setup()
  assert.equal((await request('/.well-known/webfinger')).status, 400)
  assert.equal((await request('/.well-known/webfinger?resource=acct:x@y.test')).status, 404)
})

test('site webfinger file matches the webfinger answer', async () => {
  const { request } = setup()
  const file = await (await request('/sites/example-blog/webfinger.json')).json()
  const answer = await (await request('/.well-known/webfinger?resource=acct:you@blog.test')).json()
  assert.deepEqual(file, answer)
  assert.equal((await request('/sites/nope/webfinger.json')).status, 404)
})

test('sync requires the right bearer token', async () => {
  const { request, calls } = setup()
  assert.equal((await request('/sites/example-blog/sync', { method: 'POST' })).status, 401)
  assert.equal((await request('/sites/example-blog/sync', { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status, 401)
  assert.equal((await request('/sites/nope/sync', { method: 'POST', headers: { authorization: 'Bearer secret' } })).status, 401)
  assert.deepEqual(calls, [])

  const res = await request('/sites/example-blog/sync', { method: 'POST', headers: { authorization: 'Bearer secret' } })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { new: 1, updated: 0, deleted: 0, emails: 0 })
  assert.deepEqual(calls, ['example-blog'])
})

test('sync maps feed errors to 502 and guards to 422', async () => {
  const headers = { authorization: 'Bearer secret' }
  const feedDown = setup(async () => {
    throw new FeedError('fetching https://blog.test/feed.xml returned 500')
  })
  const down = await feedDown.request('/sites/example-blog/sync', { method: 'POST', headers })
  assert.equal(down.status, 502)
  assert.deepEqual(await down.json(), { error: 'fetching https://blog.test/feed.xml returned 500' })

  const guarded = setup(async () => {
    throw new GuardError('feed has no entries')
  })
  const refused = await guarded.request('/sites/example-blog/sync', { method: 'POST', headers })
  assert.equal(refused.status, 422)
  assert.deepEqual(await refused.json(), { error: 'feed has no entries' })
})

test('failed syncs are logged', async () => {
  const logs = await captureLogs()
  const headers = { authorization: 'Bearer secret' }
  await setup(async () => {
    throw new FeedError('fetching https://blog.test/feed.xml returned 500')
  }).request('/sites/example-blog/sync', { method: 'POST', headers })
  const crashed = await setup(async () => {
    throw new Error('disk full')
  }).request('/sites/example-blog/sync', { method: 'POST', headers })
  assert.equal(crashed.status, 500)
  assert.deepEqual(logs.lines('stw.sync'), [
    'sync of example-blog failed: fetching https://blog.test/feed.xml returned 500',
    'sync of example-blog crashed: Error: disk full',
  ])
  assert.deepEqual(logs.records.filter((r) => r.category.join('.') === 'stw.sync').map((r) => r.level), ['warning', 'error'])
})

test('healthz and Fedify routes are reachable', async () => {
  const { request } = setup()
  assert.equal(await (await request('/healthz')).text(), 'ok')
  const actor = await request('/users/example-blog', { headers: { accept: 'application/activity+json' } })
  assert.equal(actor.status, 200)
  assert.equal((await request('/nothing-here')).status, 404)
})

const EMAIL = {
  from: 'you@blog.test',
  checkInboxUrl: new URL('https://blog.test/check-inbox'),
  confirmedUrl: new URL('https://blog.test/confirmed'),
  unsubscribedUrl: new URL('https://blog.test/unsubscribed'),
}
const EMAIL_CONFIG: Config = { ...TEST_CONFIG, sites: [{ ...TEST_CONFIG.sites[0], email: EMAIL }] }
const EMAIL_SITE = EMAIL_CONFIG.sites[0]

function setupEmail(
  outcomes: { subscribe?: string; confirm?: string; unsubscribe?: boolean } = {},
  config: Config = EMAIL_CONFIG,
  withSubscriptions = true,
) {
  const store = new Store(new DatabaseSync(':memory:'))
  store.migrate()
  const calls: unknown[][] = []
  const subscriptions = {
    subscribe: async (siteId: string, input: { email: string; website: string }) => {
      calls.push(['subscribe', siteId, input])
      return (outcomes.subscribe ?? 'sent') as 'sent'
    },
    confirm: (siteId: string, token: string) => {
      calls.push(['confirm', siteId, token])
      return (outcomes.confirm ?? 'confirmed') as 'confirmed'
    },
    unsubscribe: (siteId: string, token: string) => {
      calls.push(['unsubscribe', siteId, token])
      return outcomes.unsubscribe ?? true
    },
  }
  const app = buildApp({
    config,
    federation: buildFederation({ config, store, kv: new MemoryKvStore() }),
    syncer: { sync: async () => ({ new: 0, updated: 0, deleted: 0, emails: 0 }) },
    subscriptions: withSubscriptions ? subscriptions : undefined,
  })
  const request = (path: string, init?: RequestInit) => app.request(`https://ap.test${path}`, init)
  const form = (path: string, body: string) =>
    request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
  return { calls, request, form }
}

test('subscribe redirects to check-inbox and passes the form fields', async () => {
  for (const outcome of ['sent', 'ignored', 'throttled']) {
    const { form, calls } = setupEmail({ subscribe: outcome })
    const res = await form('/sites/example-blog/subscribe', 'email=a@b.co&website=')
    assert.equal(res.status, 303)
    assert.equal(res.headers.get('location'), EMAIL.checkInboxUrl.href, outcome)
    assert.deepEqual(calls, [['subscribe', 'example-blog', { email: 'a@b.co', website: '' }]])
  }
})

test('subscribe flags invalid addresses and defaults a missing website', async () => {
  const { form, calls } = setupEmail({ subscribe: 'invalid' })
  const res = await form('/sites/example-blog/subscribe', 'email=nope')
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), 'https://blog.test/check-inbox?error=invalid')
  assert.deepEqual(calls, [['subscribe', 'example-blog', { email: 'nope', website: '' }]])
})

test('email routes 404 without email config, unknown site or subscriptions', async () => {
  const cases = [setupEmail({}, TEST_CONFIG), setupEmail({}, EMAIL_CONFIG, false)]
  for (const { request, form } of cases) {
    assert.equal((await form('/sites/example-blog/subscribe', 'email=a@b.co')).status, 404)
    assert.equal((await request('/sites/example-blog/confirm?token=t')).status, 404)
    assert.equal((await request('/sites/example-blog/unsubscribe?token=t')).status, 404)
    assert.equal((await form('/sites/example-blog/unsubscribe?token=t', '')).status, 404)
  }
  const { request, form } = setupEmail()
  assert.equal((await form('/sites/nope/subscribe', 'email=a@b.co')).status, 404)
  assert.deepEqual(await (await request('/sites/nope/confirm?token=t')).json(), { error: 'not found' })
})

test('confirm redirects on success and answers 410 otherwise', async () => {
  const ok = setupEmail()
  const res = await ok.request('/sites/example-blog/confirm?token=t')
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), EMAIL.confirmedUrl.href)
  assert.deepEqual(ok.calls, [['confirm', 'example-blog', 't']])

  const bad = setupEmail({ confirm: 'invalid' })
  const gone = await bad.request('/sites/example-blog/confirm?token=t')
  assert.equal(gone.status, 410)
  assert.equal(await gone.text(), expiredLinkPage(EMAIL_SITE))

  const missing = setupEmail()
  assert.equal((await missing.request('/sites/example-blog/confirm')).status, 410)
  assert.deepEqual(missing.calls, [])
})

test('GET unsubscribe shows a confirmation form without unsubscribing', async () => {
  const { request, calls } = setupEmail()
  const res = await request('/sites/example-blog/unsubscribe?token=t')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/html/)
  assert.equal(await res.text(), unsubscribePage(EMAIL_SITE, unsubscribeUrl(EMAIL_CONFIG, 'example-blog', 't')))
  assert.deepEqual(calls, [])
  const missing = await request('/sites/example-blog/unsubscribe')
  assert.equal(missing.status, 410)
  assert.equal(await missing.text(), expiredLinkPage(EMAIL_SITE))
})

test('POST unsubscribe answers one-click with 200 and forms with a redirect', async () => {
  const oneClick = setupEmail()
  const res = await oneClick.form('/sites/example-blog/unsubscribe?token=t', 'List-Unsubscribe=One-Click')
  assert.equal(res.status, 200)
  assert.equal(await res.text(), '')
  assert.deepEqual(oneClick.calls, [['unsubscribe', 'example-blog', 't']])

  const browser = setupEmail({ unsubscribe: false })
  const redirect = await browser.form('/sites/example-blog/unsubscribe?token=t', '')
  assert.equal(redirect.status, 303)
  assert.equal(redirect.headers.get('location'), EMAIL.unsubscribedUrl.href)
  assert.deepEqual(browser.calls, [['unsubscribe', 'example-blog', 't']])

  const noToken = setupEmail()
  assert.equal((await noToken.form('/sites/example-blog/unsubscribe', '')).status, 303)
  assert.equal((await noToken.form('/sites/example-blog/unsubscribe', 'List-Unsubscribe=One-Click')).status, 200)
  assert.deepEqual(noToken.calls, [])
})
