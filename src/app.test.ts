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
    'acct:nico@innermonologue.test',
    'nico@innermonologue.test',
    'acct:NICO@InnerMonologue.TEST',
    'acct:nico@ap.test',
    'https://ap.test/users/inner-monologue',
  ]) {
    assert.equal(findSiteByResource(TEST_CONFIG, resource)?.id, 'inner-monologue', resource)
  }
  for (const resource of ['acct:nico@other.test', 'acct:someone@innermonologue.test', 'https://ap.test/users/nope', 'garbage']) {
    assert.equal(findSiteByResource(TEST_CONFIG, resource), undefined, resource)
  }
})

test('webfinger answers with the site handle and the actor link', async () => {
  const { request } = setup()
  const res = await request('/.well-known/webfinger?resource=acct:nico@ap.test')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /application\/jrd\+json/)
  assert.deepEqual(await res.json(), {
    subject: 'acct:nico@innermonologue.test',
    aliases: ['https://ap.test/users/inner-monologue'],
    links: [
      { rel: 'self', type: 'application/activity+json', href: 'https://ap.test/users/inner-monologue' },
      { rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: 'https://innermonologue.test/' },
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
  const file = await (await request('/sites/inner-monologue/webfinger.json')).json()
  const answer = await (await request('/.well-known/webfinger?resource=acct:nico@innermonologue.test')).json()
  assert.deepEqual(file, answer)
  assert.equal((await request('/sites/nope/webfinger.json')).status, 404)
})

test('sync requires the right bearer token', async () => {
  const { request, calls } = setup()
  assert.equal((await request('/sites/inner-monologue/sync', { method: 'POST' })).status, 401)
  assert.equal((await request('/sites/inner-monologue/sync', { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status, 401)
  assert.equal((await request('/sites/nope/sync', { method: 'POST', headers: { authorization: 'Bearer secret' } })).status, 401)
  assert.deepEqual(calls, [])

  const res = await request('/sites/inner-monologue/sync', { method: 'POST', headers: { authorization: 'Bearer secret' } })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { new: 1, updated: 0, deleted: 0, emails: 0 })
  assert.deepEqual(calls, ['inner-monologue'])
})

test('sync maps feed errors to 502 and guards to 422', async () => {
  const headers = { authorization: 'Bearer secret' }
  const feedDown = setup(async () => {
    throw new FeedError('fetching https://innermonologue.test/feed.xml returned 500')
  })
  const down = await feedDown.request('/sites/inner-monologue/sync', { method: 'POST', headers })
  assert.equal(down.status, 502)
  assert.deepEqual(await down.json(), { error: 'fetching https://innermonologue.test/feed.xml returned 500' })

  const guarded = setup(async () => {
    throw new GuardError('feed has no entries')
  })
  const refused = await guarded.request('/sites/inner-monologue/sync', { method: 'POST', headers })
  assert.equal(refused.status, 422)
  assert.deepEqual(await refused.json(), { error: 'feed has no entries' })
})

test('failed syncs are logged', async () => {
  const logs = await captureLogs()
  const headers = { authorization: 'Bearer secret' }
  await setup(async () => {
    throw new FeedError('fetching https://innermonologue.test/feed.xml returned 500')
  }).request('/sites/inner-monologue/sync', { method: 'POST', headers })
  const crashed = await setup(async () => {
    throw new Error('disk full')
  }).request('/sites/inner-monologue/sync', { method: 'POST', headers })
  assert.equal(crashed.status, 500)
  assert.deepEqual(logs.lines('warmhole.sync'), [
    'sync of inner-monologue failed: fetching https://innermonologue.test/feed.xml returned 500',
    'sync of inner-monologue crashed: Error: disk full',
  ])
  assert.deepEqual(logs.records.filter((r) => r.category.join('.') === 'warmhole.sync').map((r) => r.level), ['warning', 'error'])
})

test('healthz and Fedify routes are reachable', async () => {
  const { request } = setup()
  assert.equal(await (await request('/healthz')).text(), 'ok')
  const actor = await request('/users/inner-monologue', { headers: { accept: 'application/activity+json' } })
  assert.equal(actor.status, 200)
  assert.equal((await request('/nothing-here')).status, 404)
})

const EMAIL = {
  from: 'nico@innermonologue.test',
  checkInboxUrl: new URL('https://innermonologue.test/check-inbox'),
  confirmedUrl: new URL('https://innermonologue.test/confirmed'),
  unsubscribedUrl: new URL('https://innermonologue.test/unsubscribed'),
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
    const res = await form('/sites/inner-monologue/subscribe', 'email=a@b.co&website=')
    assert.equal(res.status, 303)
    assert.equal(res.headers.get('location'), EMAIL.checkInboxUrl.href, outcome)
    assert.deepEqual(calls, [['subscribe', 'inner-monologue', { email: 'a@b.co', website: '' }]])
  }
})

test('subscribe flags invalid addresses and defaults a missing website', async () => {
  const { form, calls } = setupEmail({ subscribe: 'invalid' })
  const res = await form('/sites/inner-monologue/subscribe', 'email=nope')
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), 'https://innermonologue.test/check-inbox?error=invalid')
  assert.deepEqual(calls, [['subscribe', 'inner-monologue', { email: 'nope', website: '' }]])
})

test('email routes 404 without email config, unknown site or subscriptions', async () => {
  const cases = [setupEmail({}, TEST_CONFIG), setupEmail({}, EMAIL_CONFIG, false)]
  for (const { request, form } of cases) {
    assert.equal((await form('/sites/inner-monologue/subscribe', 'email=a@b.co')).status, 404)
    assert.equal((await request('/sites/inner-monologue/confirm?token=t')).status, 404)
    assert.equal((await request('/sites/inner-monologue/unsubscribe?token=t')).status, 404)
    assert.equal((await form('/sites/inner-monologue/unsubscribe?token=t', '')).status, 404)
  }
  const { request, form } = setupEmail()
  assert.equal((await form('/sites/nope/subscribe', 'email=a@b.co')).status, 404)
  assert.deepEqual(await (await request('/sites/nope/confirm?token=t')).json(), { error: 'not found' })
})

test('confirm redirects on success and answers 410 otherwise', async () => {
  const ok = setupEmail()
  const res = await ok.request('/sites/inner-monologue/confirm?token=t')
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), EMAIL.confirmedUrl.href)
  assert.deepEqual(ok.calls, [['confirm', 'inner-monologue', 't']])

  const bad = setupEmail({ confirm: 'invalid' })
  const gone = await bad.request('/sites/inner-monologue/confirm?token=t')
  assert.equal(gone.status, 410)
  assert.equal(await gone.text(), expiredLinkPage(EMAIL_SITE))

  const missing = setupEmail()
  assert.equal((await missing.request('/sites/inner-monologue/confirm')).status, 410)
  assert.deepEqual(missing.calls, [])
})

test('GET unsubscribe shows a confirmation form without unsubscribing', async () => {
  const { request, calls } = setupEmail()
  const res = await request('/sites/inner-monologue/unsubscribe?token=t')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/html/)
  assert.equal(await res.text(), unsubscribePage(EMAIL_SITE, unsubscribeUrl(EMAIL_CONFIG, 'inner-monologue', 't')))
  assert.deepEqual(calls, [])
  const missing = await request('/sites/inner-monologue/unsubscribe')
  assert.equal(missing.status, 410)
  assert.equal(await missing.text(), expiredLinkPage(EMAIL_SITE))
})

test('POST unsubscribe answers one-click with 200 and forms with a redirect', async () => {
  const oneClick = setupEmail()
  const res = await oneClick.form('/sites/inner-monologue/unsubscribe?token=t', 'List-Unsubscribe=One-Click')
  assert.equal(res.status, 200)
  assert.equal(await res.text(), '')
  assert.deepEqual(oneClick.calls, [['unsubscribe', 'inner-monologue', 't']])

  const browser = setupEmail({ unsubscribe: false })
  const redirect = await browser.form('/sites/inner-monologue/unsubscribe?token=t', '')
  assert.equal(redirect.status, 303)
  assert.equal(redirect.headers.get('location'), EMAIL.unsubscribedUrl.href)
  assert.deepEqual(browser.calls, [['unsubscribe', 'inner-monologue', 't']])

  const noToken = setupEmail()
  assert.equal((await noToken.form('/sites/inner-monologue/unsubscribe', '')).status, 303)
  assert.equal((await noToken.form('/sites/inner-monologue/unsubscribe', 'List-Unsubscribe=One-Click')).status, 200)
  assert.deepEqual(noToken.calls, [])
})
