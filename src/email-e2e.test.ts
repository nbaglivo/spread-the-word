import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MemoryKvStore } from '@fedify/fedify'
import { Store } from './store.ts'
import { buildFederation } from './federation.ts'
import { buildApp } from './app.ts'
import { Syncer } from './sync.ts'
import { Subscriptions } from './subscriptions.ts'
import { EmailWorker } from './email-worker.ts'
import type { Config } from './config.ts'
import type { FeedEntry } from './feed.ts'
import { TEST_CONFIG } from '../test/fake-remote.ts'
import { fakeMailer } from '../test/fake-mailer.ts'
import { entry, rss } from '../test/feeds.ts'

const SITE = 'inner-monologue'
const CONFIG: Config = {
  ...TEST_CONFIG,
  smtp: { host: 'smtp.test', port: 587, user: 'u', password: 'p', pauseMs: 0 },
  sites: [
    {
      ...TEST_CONFIG.sites[0],
      email: {
        from: 'Nico <nico@innermonologue.test>',
        checkInboxUrl: new URL('https://innermonologue.test/check-inbox'),
        confirmedUrl: new URL('https://innermonologue.test/confirmed'),
        unsubscribedUrl: new URL('https://innermonologue.test/unsubscribed'),
      },
    },
  ],
}

test('subscribe, confirm, receive a new post and unsubscribe through the real app', async () => {
  const store = new Store(new DatabaseSync(':memory:'))
  store.migrate()
  const mailer = fakeMailer()
  let current = new Date()
  const now = () => current
  const federation = buildFederation({ config: CONFIG, store, kv: new MemoryKvStore() })
  let feed: FeedEntry[] = []
  const syncer = new Syncer({ config: CONFIG, store, federation, fetchFeed: async () => rss(feed) })
  const subscriptions = new Subscriptions({ config: CONFIG, store, mailer, now })
  const worker = new EmailWorker({ config: CONFIG, store, mailer, now, sleep: async () => {} })
  const app = buildApp({ config: CONFIG, federation, syncer, subscriptions })
  const request = (path: string, init?: RequestInit) => app.request(`https://ap.test${path}`, init)
  const form = (path: string, body: string) =>
    request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })

  const subscribed = await form(`/sites/${SITE}/subscribe`, 'email=reader@example.com&website=')
  assert.equal(subscribed.status, 303)
  await subscriptions.settled()
  assert.equal(mailer.sent.length, 1)
  const confirmLink = mailer.sent[0].text.match(/https:\/\/ap\.test\/sites\/[^\s]+\/confirm\?token=[^\s]+/)?.[0]
  assert.ok(confirmLink)

  const confirmed = await request(new URL(confirmLink).pathname + new URL(confirmLink).search)
  assert.equal(confirmed.status, 303)
  assert.equal(confirmed.headers.get('location'), 'https://innermonologue.test/confirmed')
  assert.equal(store.countConfirmedSubscribers(SITE), 1)

  feed = [entry('a')]
  assert.equal((await syncer.sync(SITE)).emails, 0)
  feed = [entry('a'), entry('b')]
  assert.equal((await syncer.sync(SITE)).emails, 1)

  current = new Date(current.getTime() + 3_600_000)
  assert.equal(await worker.tick(), 1)
  assert.equal(mailer.sent.length, 2)
  const mail = mailer.sent[1]
  assert.equal(mail.to, 'reader@example.com')
  assert.match(mail.subject, /Title b/)
  const header = mail.headers?.['List-Unsubscribe']
  const unsubscribeLink = header?.match(/<([^>]+)>/)?.[1]
  assert.ok(unsubscribeLink)
  assert.equal(mail.headers?.['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
  const unsubscribeUrl = new URL(unsubscribeLink)
  assert.ok(unsubscribeUrl.searchParams.get('token'))

  const left = await form(unsubscribeUrl.pathname + unsubscribeUrl.search, 'List-Unsubscribe=One-Click')
  assert.equal(left.status, 200)
  assert.equal(store.countConfirmedSubscribers(SITE), 0)
})
