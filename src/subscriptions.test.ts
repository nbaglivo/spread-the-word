import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { Store } from './store.ts'
import { MailError } from './mail.ts'
import { Subscriptions, hashToken } from './subscriptions.ts'
import type { Config } from './config.ts'
import { TEST_CONFIG } from '../test/fake-remote.ts'
import { fakeMailer } from '../test/fake-mailer.ts'
import { captureLogs } from '../test/logs.ts'

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

function setup(config: Config = CONFIG) {
  const store = new Store(new DatabaseSync(':memory:'))
  store.migrate()
  const mailer = fakeMailer()
  let current = new Date('2026-11-03T10:00:00Z')
  const subs = new Subscriptions({ config, store, mailer, now: () => current })
  return {
    store,
    mailer,
    subs,
    advance: (ms: number) => (current = new Date(current.getTime() + ms)),
  }
}

function tokenFrom(text: string): string {
  const match = text.match(/token=([^\s&"]+)/)
  assert.ok(match, 'confirm url in body')
  return decodeURIComponent(match[1])
}

test('honeypot filled is ignored', async () => {
  const { subs, store, mailer } = setup()
  assert.equal(await subs.subscribe(SITE, { email: 'a@example.com', website: 'spam' }), 'ignored')
  assert.equal(store.getSubscriber(SITE, 'a@example.com'), undefined)
  assert.equal(mailer.sent.length, 0)
})

test('invalid address is rejected', async () => {
  const { subs, mailer } = setup()
  assert.equal(await subs.subscribe(SITE, { email: 'nope', website: '' }), 'invalid')
  assert.equal(mailer.sent.length, 0)
})

test('new address gets a pending row and a confirmation mail', async () => {
  const { subs, store, mailer } = setup()
  assert.equal(await subs.subscribe(SITE, { email: 'Nico@Example.COM', website: '' }), 'sent')
  await subs.settled()
  const row = store.getSubscriber(SITE, 'nico@example.com')
  assert.equal(row?.status, 'pending')
  assert.equal(mailer.sent.length, 1)
  const mail = mailer.sent[0]
  assert.equal(mail.to, 'nico@example.com')
  assert.equal(mail.from, 'Nico <nico@innermonologue.test>')
  assert.equal(mail.subject, 'Confirm your subscription to The Open Inner Monologue')
  assert.equal(hashToken(tokenFrom(mail.text)), row?.confirmTokenHash)
})

test('repeat within 10 minutes is throttled, later resend invalidates the old link', async () => {
  const { subs, store, mailer, advance } = setup()
  await subs.subscribe(SITE, { email: ' Nico@Example.COM ', website: '' })
  await subs.settled()
  assert.equal(await subs.subscribe(SITE, { email: 'nico@example.com', website: '' }), 'throttled')
  await subs.settled()
  assert.equal(mailer.sent.length, 1)
  const first = tokenFrom(mailer.sent[0].text)
  const unsub = store.getSubscriber(SITE, 'nico@example.com')?.unsubscribeToken

  advance(10 * 60 * 1000)
  assert.equal(await subs.subscribe(SITE, { email: 'nico@example.com', website: '' }), 'sent')
  await subs.settled()
  assert.equal(mailer.sent.length, 2)
  const second = tokenFrom(mailer.sent[1].text)
  assert.notEqual(second, first)
  assert.equal(store.getSubscriber(SITE, 'nico@example.com')?.unsubscribeToken, unsub)
  assert.equal(subs.confirm(SITE, first), 'invalid')
  assert.equal(subs.confirm(SITE, second), 'confirmed')
})

test('already confirmed is ignored', async () => {
  const { subs, mailer } = setup()
  await subs.subscribe(SITE, { email: 'a@example.com', website: '' })
  await subs.settled()
  subs.confirm(SITE, tokenFrom(mailer.sent[0].text))
  assert.equal(await subs.subscribe(SITE, { email: 'a@example.com', website: '' }), 'ignored')
  assert.equal(mailer.sent.length, 1)
})

test('site throttle caps confirmations at 30 per hour', async () => {
  const logs = await captureLogs()
  const { subs, mailer } = setup()
  for (let i = 0; i < 30; i++) {
    assert.equal(await subs.subscribe(SITE, { email: `user${i}@example.com`, website: '' }), 'sent')
    await subs.settled()
  }
  assert.equal(await subs.subscribe(SITE, { email: 'nico@example.com', website: '' }), 'throttled')
  await subs.settled()
  assert.equal(mailer.sent.length, 30)
  assert.ok(logs.lines('warmhole.email').includes(`${SITE}: subscribe throttled for n***@example.com`))
})

test('mailer failure still returns sent, logs, and keeps the row pending', async () => {
  const logs = await captureLogs()
  const { subs, store, mailer } = setup()
  mailer.failAll(new MailError('boom', false))
  assert.equal(await subs.subscribe(SITE, { email: 'nico@example.com', website: '' }), 'sent')
  await subs.settled()
  assert.equal(store.getSubscriber(SITE, 'nico@example.com')?.status, 'pending')
  const line = logs.lines('warmhole.email').find((l) => l.includes('confirmation to'))
  assert.ok(line?.includes('n***@example.com'))
  assert.ok(line?.includes('boom'))
})

test('subscribe does not wait for a stalled mail server', async () => {
  const store = new Store(new DatabaseSync(':memory:'))
  store.migrate()
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const sent: string[] = []
  const subs = new Subscriptions({
    config: CONFIG,
    store,
    mailer: { send: async (m) => { await gate; sent.push(m.to) } },
  })
  assert.equal(await subs.subscribe(SITE, { email: 'a@example.com', website: '' }), 'sent')
  assert.deepEqual(sent, [])
  release()
  await subs.settled()
  assert.deepEqual(sent, ['a@example.com'])
})

test('confirm confirms once, logs, and rejects reuse, expiry and garbage', async () => {
  const logs = await captureLogs()
  const { subs, mailer, advance } = setup()
  await subs.subscribe(SITE, { email: 'a@example.com', website: '' })
  await subs.settled()
  const token = tokenFrom(mailer.sent[0].text)
  assert.equal(subs.confirm(SITE, token), 'confirmed')
  assert.ok(logs.lines('warmhole.email').includes(`${SITE}: new subscriber, 1 subscribers`))
  assert.equal(subs.confirm(SITE, token), 'invalid')
  assert.equal(subs.confirm(SITE, 'garbage'), 'invalid')

  await subs.subscribe(SITE, { email: 'b@example.com', website: '' })
  await subs.settled()
  const late = tokenFrom(mailer.sent[1].text)
  advance(48 * 60 * 60 * 1000 + 1000)
  assert.equal(subs.confirm(SITE, late), 'invalid')
})

test('unsubscribe removes a known token and logs', async () => {
  const logs = await captureLogs()
  const { subs, store, mailer } = setup()
  await subs.subscribe(SITE, { email: 'a@example.com', website: '' })
  await subs.settled()
  subs.confirm(SITE, tokenFrom(mailer.sent[0].text))
  const unsub = store.getSubscriber(SITE, 'a@example.com')!.unsubscribeToken
  const before = logs.lines('warmhole.email').length
  assert.equal(subs.unsubscribe(SITE, 'unknown'), false)
  assert.equal(logs.lines('warmhole.email').length, before)
  assert.equal(subs.unsubscribe(SITE, unsub), true)
  assert.ok(logs.lines('warmhole.email').includes(`${SITE}: subscriber left, 0 subscribers`))
})

test('site without email ignores everything', async () => {
  const { subs, mailer } = setup(TEST_CONFIG)
  assert.equal(await subs.subscribe(SITE, { email: 'a@example.com', website: '' }), 'ignored')
  assert.equal(await subs.subscribe('nope', { email: 'a@example.com', website: '' }), 'ignored')
  assert.equal(subs.confirm(SITE, 'x'), 'invalid')
  assert.equal(subs.unsubscribe(SITE, 'x'), false)
  assert.equal(mailer.sent.length, 0)
})
