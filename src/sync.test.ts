import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MemoryKvStore } from '@fedify/fedify'
import type { Config } from './config.ts'
import { Store } from './store.ts'
import { buildFederation } from './federation.ts'
import type { Federation } from '@fedify/fedify'
import { Syncer, UnknownSiteError } from './sync.ts'
import { FeedError, type FeedEntry } from './feed.ts'
import { GuardError } from './diff.ts'
import { startFakeRemote, TEST_CONFIG, type FakeRemote } from '../test/fake-remote.ts'
import { entry, rss } from '../test/feeds.ts'
import { captureLogs } from '../test/logs.ts'

let remote: FakeRemote
before(async () => {
  remote = await startFakeRemote()
})
after(() => remote.close())

const EMAIL_CONFIG: Config = {
  ...TEST_CONFIG,
  sites: [
    {
      ...TEST_CONFIG.sites[0],
      email: {
        from: 'Inner <nico@innermonologue.test>',
        checkInboxUrl: new URL('https://innermonologue.test/check-inbox'),
        confirmedUrl: new URL('https://innermonologue.test/confirmed'),
        unsubscribedUrl: new URL('https://innermonologue.test/unsubscribed'),
      },
    },
  ],
  smtp: { host: 'smtp.test', port: 587, user: 'u', password: 'p', pauseMs: 0 },
}

function setup(config: Config = TEST_CONFIG) {
  const store = new Store(new DatabaseSync(':memory:'))
  store.migrate()
  const federation = buildFederation({ config, store, kv: new MemoryKvStore(), allowPrivateAddress: true, skipSignatureVerification: true })
  let feed: FeedEntry[] = []
  const syncer = new Syncer({ config, store, federation, fetchFeed: async () => rss(feed) })
  store.addFollower('inner-monologue', { actorId: remote.actorId, inbox: remote.inbox, sharedInbox: remote.sharedInbox })
  return { store, syncer, setFeed: (entries: FeedEntry[]) => (feed = entries) }
}

function deliveredTypes(since: number): string[] {
  return remote.deliveries.slice(since).map((d) => d.type)
}

test('first sync stores silently, then new posts are delivered', async () => {
  const { syncer, setFeed } = setup()
  const start = remote.deliveries.length

  setFeed([entry('a'), entry('b')])
  assert.deepEqual(await syncer.sync('inner-monologue'), { new: 2, updated: 0, deleted: 0, emails: 0 })
  assert.deepEqual(deliveredTypes(start), [])

  setFeed([entry('a'), entry('b'), entry('c')])
  assert.deepEqual(await syncer.sync('inner-monologue'), { new: 1, updated: 0, deleted: 0, emails: 0 })
  const delivered = remote.deliveries.slice(start)
  assert.deepEqual(delivered.map((d) => d.type), ['Create'])
  assert.equal(delivered[0].path, '/inbox')
  assert.equal((delivered[0].body.object as Record<string, unknown>).name, 'Title c')
})

test('re-sync with nothing new returns zeros and sends nothing', async () => {
  const { syncer, setFeed } = setup()
  setFeed([entry('a')])
  await syncer.sync('inner-monologue')
  const start = remote.deliveries.length
  assert.deepEqual(await syncer.sync('inner-monologue'), { new: 0, updated: 0, deleted: 0, emails: 0 })
  assert.deepEqual(deliveredTypes(start), [])
})

test('edits send Update and removals send Delete', async () => {
  const { syncer, setFeed } = setup()
  setFeed([entry('a'), entry('b'), entry('c')])
  await syncer.sync('inner-monologue')
  const start = remote.deliveries.length

  setFeed([entry('a', { title: 'Edited' }), entry('b')])
  assert.deepEqual(await syncer.sync('inner-monologue'), { new: 0, updated: 1, deleted: 1, emails: 0 })
  assert.deepEqual(deliveredTypes(start).sort(), ['Delete', 'Update'])
})

test('guards and feed errors change nothing', async () => {
  const { store, syncer, setFeed } = setup()
  setFeed([entry('a'), entry('b')])
  await syncer.sync('inner-monologue')

  setFeed([])
  await assert.rejects(syncer.sync('inner-monologue'), GuardError)
  assert.equal(store.countPublishedPosts('inner-monologue'), 2)

  const broken = new Syncer({
    config: TEST_CONFIG,
    store,
    federation: buildFederation({ config: TEST_CONFIG, store, kv: new MemoryKvStore() }),
    fetchFeed: async () => {
      throw new FeedError('down')
    },
  })
  await assert.rejects(broken.sync('inner-monologue'), FeedError)
})

test('unknown site is rejected', async () => {
  const { syncer } = setup()
  await assert.rejects(syncer.sync('nope'), UnknownSiteError)
})

test('pending activities left by a crash are sent on the next sync', async () => {
  const { store, syncer, setFeed } = setup()
  setFeed([entry('a')])
  await syncer.sync('inner-monologue')
  store.applyChanges('inner-monologue', { create: [entry('z')], update: [], delete: [], silent: false })
  const start = remote.deliveries.length

  setFeed([entry('a'), entry('z')])
  assert.deepEqual(await syncer.sync('inner-monologue'), { new: 0, updated: 0, deleted: 0, emails: 0 })
  assert.deepEqual(deliveredTypes(start), ['Create'])
  assert.deepEqual(store.listPending('inner-monologue'), [])
})

test('syncs for the same site never overlap', async () => {
  const store = new Store(new DatabaseSync(':memory:'))
  store.migrate()
  const federation = buildFederation({ config: TEST_CONFIG, store, kv: new MemoryKvStore() })
  let running = 0
  let maxRunning = 0
  const syncer = new Syncer({
    config: TEST_CONFIG,
    store,
    federation,
    fetchFeed: async () => {
      running++
      maxRunning = Math.max(maxRunning, running)
      await new Promise((resolve) => setTimeout(resolve, 20))
      running--
      return rss([entry('a')])
    },
  })
  const results = await Promise.all([syncer.sync('inner-monologue'), syncer.sync('inner-monologue'), syncer.sync('inner-monologue')])
  assert.equal(maxRunning, 1)
  assert.deepEqual(results.map((r) => r.new), [1, 0, 0])
})

test('each sync logs one line with what changed', async () => {
  const logs = await captureLogs()
  const { syncer, setFeed } = setup()
  setFeed([entry('a'), entry('b')])
  await syncer.sync('inner-monologue')
  setFeed([entry('a', { title: 'Edited' }), entry('b'), entry('c')])
  await syncer.sync('inner-monologue')
  assert.deepEqual(logs.lines('warmhole.sync'), [
    'first sync of inner-monologue stored 2 posts without sending them',
    'synced inner-monologue: 1 new, 1 updated, 0 deleted, 0 emails',
  ])
})

function subscribe(store: Store, n: number) {
  for (let i = 0; i < n; i++) {
    const hash = `hash${i}`
    store.savePendingSubscriber('inner-monologue', `s${i}@example.com`, {
      confirmTokenHash: hash,
      confirmExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      confirmSentAt: new Date().toISOString(),
      unsubscribeToken: `unsub${i}`,
    })
    store.confirmSubscriber('inner-monologue', hash, new Date())
  }
}

test('new posts queue emails and report them', async () => {
  const logs = await captureLogs()
  const { store, syncer, setFeed } = setup(EMAIL_CONFIG)
  subscribe(store, 2)
  setFeed([entry('a')])
  await syncer.sync('inner-monologue')
  setFeed([entry('a'), entry('b')])
  assert.deepEqual(await syncer.sync('inner-monologue'), { new: 1, updated: 0, deleted: 0, emails: 2 })
  assert.deepEqual(logs.lines('warmhole.email'), ['inner-monologue: emailing Title b to 2 subscribers'])
})

test('a site without email queues nothing and logs nothing', async () => {
  const logs = await captureLogs()
  const { store, syncer, setFeed } = setup()
  subscribe(store, 2)
  setFeed([entry('a')])
  await syncer.sync('inner-monologue')
  setFeed([entry('a'), entry('b')])
  assert.deepEqual(await syncer.sync('inner-monologue'), { new: 1, updated: 0, deleted: 0, emails: 0 })
  assert.equal(store.listDueDeliveries(new Date(Date.now() + 1000), 10).length, 0)
  assert.deepEqual(logs.lines('warmhole.email'), [])
})

test('edits and re-syncs queue no emails', async () => {
  const { store, syncer, setFeed } = setup(EMAIL_CONFIG)
  subscribe(store, 2)
  setFeed([entry('a')])
  await syncer.sync('inner-monologue')
  setFeed([entry('a', { title: 'Edited' })])
  assert.deepEqual(await syncer.sync('inner-monologue'), { new: 0, updated: 1, deleted: 0, emails: 0 })
  assert.deepEqual(await syncer.sync('inner-monologue'), { new: 0, updated: 0, deleted: 0, emails: 0 })
  assert.equal(store.listDueDeliveries(new Date(Date.now() + 1000), 10).length, 0)
})

test('fediverse hand-off failing still leaves emails queued', async () => {
  const logs = await captureLogs()
  const { store, syncer, setFeed } = setup(EMAIL_CONFIG)
  subscribe(store, 2)
  setFeed([entry('a')])
  await syncer.sync('inner-monologue')
  setFeed([entry('a'), entry('b')])

  const real = syncer.deps.federation
  const broken = {
    createContext: (...args: Parameters<Federation<void>['createContext']>) => {
      const ctx = real.createContext(...args)
      ctx.sendActivity = async () => {
        throw new Error('fedi down')
      }
      return ctx
    },
  } as unknown as Federation<void>
  const failing = new Syncer({ ...syncer.deps, federation: broken })
  await assert.rejects(failing.sync('inner-monologue'), /fedi down/)

  const later = new Date(Date.now() + 1000)
  assert.equal(store.listDueDeliveries(later, 10).length, 2)
  assert.deepEqual(logs.lines('warmhole.email'), ['inner-monologue: emailing Title b to 2 subscribers'])

  assert.deepEqual(await syncer.sync('inner-monologue'), { new: 0, updated: 0, deleted: 0, emails: 0 })
  assert.equal(store.listDueDeliveries(later, 10).length, 2)
})
