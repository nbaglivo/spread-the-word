import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { Store } from './store.ts'
import { MailError } from './mail.ts'
import { EmailWorker, RETRY_DELAYS_MS } from './email-worker.ts'
import { unsubscribeUrl } from './emails.ts'
import type { Config } from './config.ts'
import type { FeedEntry } from './feed.ts'
import { TEST_CONFIG } from '../test/fake-remote.ts'
import { fakeMailer } from '../test/fake-mailer.ts'
import { captureLogs } from '../test/logs.ts'

const SITE = 'inner-monologue'
const CONFIG: Config = {
  ...TEST_CONFIG,
  smtp: { host: 'smtp.test', port: 587, user: 'u', password: 'p', pauseMs: 250 },
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
const START = new Date('2026-11-03T10:00:00Z')

function entry(id: string, published = '2026-11-01T00:00:00Z'): FeedEntry {
  return {
    id,
    url: `https://innermonologue.test/${id}`,
    title: `Post ${id}`,
    summary: `About ${id}`,
    html: `<p>${id}</p>`,
    published: new Date(published),
    updated: new Date(published),
  }
}

function setup(config: Config = CONFIG) {
  const store = new Store(new DatabaseSync(':memory:'))
  store.migrate()
  const mailer = fakeMailer()
  const clock = { current: START }
  const pauses: number[] = []
  const deps = {
    config,
    store,
    mailer,
    now: () => clock.current,
    sleep: async (ms: number) => {
      pauses.push(ms)
    },
  }
  const worker = new EmailWorker(deps)
  let n = 0
  function subscribe(email: string) {
    n += 1
    store.savePendingSubscriber(SITE, email, {
      confirmTokenHash: `hash${n}`,
      confirmExpiresAt: '2026-12-01T00:00:00.000Z',
      confirmSentAt: START.toISOString(),
      unsubscribeToken: `unsub${n}`,
    })
    return store.confirmSubscriber(SITE, `hash${n}`, START)!
  }
  function publish(...entries: FeedEntry[]) {
    return store.applyChanges(SITE, { create: entries, update: [], delete: [], silent: false }, START, { email: true })
  }
  function rows() {
    return store.db.prepare('SELECT * FROM email_deliveries ORDER BY id').all() as Record<string, unknown>[]
  }
  return {
    store,
    mailer,
    worker,
    deps,
    pauses,
    subscribe,
    publish,
    rows,
    advance: (ms: number) => (clock.current = new Date(clock.current.getTime() + ms)),
  }
}

test('sends queued deliveries', async () => {
  const { worker, mailer, subscribe, publish, rows, pauses } = setup()
  const a = subscribe('a@example.com')
  subscribe('b@example.com')
  publish(entry('p1'))
  assert.equal(await worker.tick(), 2)
  assert.equal(mailer.sent.length, 2)
  assert.deepEqual(mailer.sent.map((m) => m.to), ['a@example.com', 'b@example.com'])
  for (const m of mailer.sent) {
    assert.equal(m.subject, 'Post p1')
    assert.equal(m.from, 'Nico <nico@innermonologue.test>')
  }
  const url = unsubscribeUrl(CONFIG, SITE, a.unsubscribeToken)
  assert.equal(mailer.sent[0].headers?.['List-Unsubscribe'], `<${url}>`)
  assert.equal(mailer.sent[0].headers?.['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
  assert.deepEqual(rows().map((r) => r.status), ['sent', 'sent'])
  assert.deepEqual(pauses, [250])
})

test("one recipient failing doesn't stop the others", async () => {
  const logs = await captureLogs()
  const { worker, mailer, subscribe, publish, rows } = setup()
  subscribe('abe@example.com')
  subscribe('bob@example.com')
  publish(entry('b'))
  mailer.failFor('abe@example.com', new MailError('421 try later', false))
  await worker.tick()
  const [first, second] = rows()
  assert.equal(first.status, 'queued')
  assert.equal(first.attempts, 1)
  assert.equal(first.next_attempt_at, new Date(START.getTime() + 60_000).toISOString())
  assert.equal(second.status, 'sent')
  const warnings = logs.lines('warmhole.email')
  assert.ok(warnings.includes('inner-monologue: email of b to a***@example.com failed (attempt 1): 421 try later'), warnings.join('\n'))
})

test('retry schedule then gives up', async () => {
  const logs = await captureLogs()
  const { worker, mailer, subscribe, publish, rows, advance } = setup()
  subscribe('a@example.com')
  publish(entry('b'))
  mailer.failAll(new MailError('421 busy', false))
  for (let attempt = 1; attempt <= 6; attempt++) {
    assert.equal(await worker.tick(), 1)
    const [row] = rows()
    assert.equal(row.status, 'queued')
    assert.equal(row.attempts, attempt)
    assert.equal(row.next_attempt_at, new Date(START.getTime() + (advanceTotal(attempt - 1)) + RETRY_DELAYS_MS[attempt - 1]).toISOString())
    assert.equal(await worker.tick(), 0)
    advance(RETRY_DELAYS_MS[attempt - 1])
  }
  assert.equal(await worker.tick(), 1)
  const [row] = rows()
  assert.equal(row.status, 'failed')
  assert.equal(row.attempts, 7)
  assert.ok(logs.lines('warmhole.email').includes('inner-monologue: gave up emailing b to a***@example.com: 421 busy'))
  advance(100_000_000)
  assert.equal(await worker.tick(), 0)
  assert.equal(rows()[0].attempts, 7)
})

function advanceTotal(done: number): number {
  return RETRY_DELAYS_MS.slice(0, done).reduce((a, b) => a + b, 0)
}

test('permanent failure gives up immediately', async () => {
  const { worker, mailer, subscribe, publish, rows } = setup()
  subscribe('a@example.com')
  publish(entry('b'))
  mailer.failFor('a@example.com', new MailError('550 no such user', true))
  await worker.tick()
  const [row] = rows()
  assert.equal(row.status, 'failed')
  assert.equal(row.attempts, 1)
  assert.equal(row.last_error, '550 no such user')
})

test('everyone failing (SMTP down) leaves all rows queued', async () => {
  const { worker, mailer, subscribe, publish, rows } = setup()
  subscribe('a@example.com')
  subscribe('b@example.com')
  publish(entry('p'))
  mailer.failAll(new MailError('connect ECONNREFUSED', false))
  assert.equal(await worker.tick(), 2)
  assert.deepEqual(rows().map((r) => [r.status, r.attempts]), [['queued', 1], ['queued', 1]])
})

test('gone subscriber or deleted post drops the row silently', async () => {
  const logs = await captureLogs()
  const { worker, mailer, store, subscribe, publish, rows } = setup()
  const a = subscribe('a@example.com')
  subscribe('b@example.com')
  publish(entry('p1'), entry('p2'))
  store.removeSubscriberByToken(SITE, a.unsubscribeToken)
  store.applyChanges(SITE, { create: [], update: [], delete: ['p1'], silent: false }, START)
  await worker.tick()
  assert.equal(mailer.sent.length, 1)
  assert.equal(mailer.sent[0].subject, 'Post p2')
  assert.equal(rows().length, 1)
  assert.equal(rows()[0].status, 'sent')
  assert.deepEqual(logs.lines('warmhole.email'), ['inner-monologue: emailed p2 to b***@example.com'])
})

test('a row whose subscriber vanished without cascade is dropped', async () => {
  const logs = await captureLogs()
  const { worker, mailer, store, subscribe, publish, rows } = setup()
  const a = subscribe('a@example.com')
  publish(entry('p1'))
  store.db.prepare('DELETE FROM subscribers WHERE id = ?').run(a.id)
  await worker.tick()
  assert.equal(mailer.sent.length, 0)
  assert.equal(rows().length, 0)
  assert.deepEqual(logs.lines('warmhole.email'), [])
})

test('oldest post first and resume after restart', async () => {
  const { deps, mailer, subscribe, publish } = setup()
  subscribe('a@example.com')
  publish(entry('newer', '2026-11-02T00:00:00Z'), entry('older', '2026-10-01T00:00:00Z'))
  const restarted = new EmailWorker(deps)
  await restarted.tick()
  assert.deepEqual(mailer.sent.map((m) => m.subject), ['Post older', 'Post newer'])
})

test('site no longer has email in config', async () => {
  const { deps, mailer, subscribe, publish, rows } = setup()
  subscribe('a@example.com')
  publish(entry('p'))
  const worker = new EmailWorker({ ...deps, config: TEST_CONFIG })
  await worker.tick()
  assert.equal(mailer.sent.length, 0)
  assert.equal(rows().length, 0)
})

test('cleanup removes expired pending subscribers at most once an hour', async () => {
  const { worker, store, advance } = setup()
  const pending = (email: string, token: string) =>
    store.savePendingSubscriber(SITE, email, {
      confirmTokenHash: token,
      confirmExpiresAt: new Date(START.getTime() - 1000).toISOString(),
      confirmSentAt: START.toISOString(),
      unsubscribeToken: token,
    })
  pending('old@example.com', 't1')
  await worker.tick()
  assert.equal(store.getSubscriber(SITE, 'old@example.com'), undefined)
  pending('old2@example.com', 't2')
  advance(30 * 60_000)
  await worker.tick()
  assert.ok(store.getSubscriber(SITE, 'old2@example.com'))
  advance(31 * 60_000)
  await worker.tick()
  assert.equal(store.getSubscriber(SITE, 'old2@example.com'), undefined)
})

test('a mailer bug inside one row is contained', async () => {
  const { deps, mailer, subscribe, publish, rows } = setup()
  subscribe('a@example.com')
  subscribe('b@example.com')
  publish(entry('p'))
  const realSend = mailer.send
  let calls = 0
  mailer.send = async (message) => {
    calls += 1
    if (calls === 1) throw new TypeError('boom')
    return realSend(message)
  }
  await new EmailWorker(deps).tick()
  assert.deepEqual(rows().map((r) => [r.status, r.attempts]), [['queued', 1], ['sent', 0]])
  assert.equal(mailer.sent.length, 1)
})

test('a mail that was sent but not recorded is marked failed and never resent', async () => {
  const logs = await captureLogs()
  const { deps, store, mailer, subscribe, publish, rows, advance } = setup()
  subscribe('a@example.com')
  subscribe('b@example.com')
  publish(entry('p'))
  const aId = Number(rows()[0].id)
  const realSent = store.markDeliverySent.bind(store)
  store.markDeliverySent = (id, now) => {
    if (id === aId) throw new Error('disk full')
    realSent(id, now)
  }
  const worker = new EmailWorker(deps)
  await worker.tick()
  advance(24 * 3_600_000)
  assert.equal(await worker.tick(), 0)
  assert.deepEqual(mailer.sent.map((m) => m.to), ['a@example.com', 'b@example.com'])
  const [a, b] = rows()
  assert.equal(a.status, 'failed')
  assert.equal(a.attempts, 1)
  assert.equal(a.last_error, 'sent but not recorded: disk full')
  assert.equal(b.status, 'sent')
  assert.ok(logs.lines('warmhole.email').some((l) => l.includes('was sent but not recorded: disk full')))
})

test('a mail that was sent but cannot be marked failed either is only logged', async () => {
  const logs = await captureLogs()
  const { deps, store, mailer, subscribe, publish } = setup()
  subscribe('a@example.com')
  publish(entry('p'))
  store.markDeliverySent = () => {
    throw new Error('disk full')
  }
  store.markDeliveryFailed = () => {
    throw new Error('still full')
  }
  const worker = new EmailWorker(deps)
  await worker.tick()
  assert.equal(mailer.sent.length, 1)
  assert.ok(logs.lines('warmhole.email').some((l) => l.includes('could not mark delivery') && l.includes('still full')))
})

test('overlapping ticks share one pass', async () => {
  const { worker, mailer, subscribe, publish } = setup()
  subscribe('a@example.com')
  publish(entry('p'))
  const [x, y] = await Promise.all([worker.tick(), worker.tick()])
  assert.equal(x, 1)
  assert.equal(y, 1)
  assert.equal(mailer.sent.length, 1)
})

test('start and stop run ticks in the background', async () => {
  const { deps, mailer, subscribe, publish, rows } = setup()
  subscribe('a@example.com')
  publish(entry('p'))
  const worker = new EmailWorker(deps)
  worker.start(5)
  await new Promise((resolve) => setTimeout(resolve, 50))
  await worker.stop()
  assert.equal(mailer.sent.length, 1)
  assert.equal(rows()[0].status, 'sent')
})
