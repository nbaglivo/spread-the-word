import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { Store, slugFor } from './store.ts'
import { contentHash } from './diff.ts'
import { entry } from '../test/feeds.ts'

function freshStore(): Store {
  const store = new Store(new DatabaseSync(':memory:'))
  store.migrate()
  return store
}

const none = { create: [], update: [], delete: [], silent: false }

test('migrate is idempotent', () => {
  const store = freshStore()
  store.migrate()
  assert.deepEqual(store.listPosts('s'), [])
})

test('slugFor uses the last meaningful path segment', () => {
  assert.equal(slugFor('https://x.dev/writing/notes-to-self.html', new Set()), 'notes-to-self')
  assert.equal(slugFor('https://x.dev/2026/My Post/', new Set()), 'my-post')
  assert.equal(slugFor('https://x.dev/', new Set()), 'post')
  assert.equal(slugFor('https://x.dev/a.html', new Set(['a'])), 'a-2')
  assert.equal(slugFor('https://x.dev/a.html', new Set(['a', 'a-2'])), 'a-3')
  assert.equal(slugFor('https://blog.test/50%-off', new Set()), '50-off')
})

test('index.html posts get distinct slugs from their folders', () => {
  const store = freshStore()
  store.applyChanges('s', {
    ...none,
    create: [
      entry('x', { id: '1', url: 'https://x.dev/2026/first/index.html' }),
      entry('x', { id: '2', url: 'https://x.dev/2026/second/index.html' }),
      entry('x', { id: '3', url: 'https://x.dev/2027/first/index.html' }),
    ],
  })
  assert.deepEqual(store.listPosts('s').map((p) => p.slug).sort(), ['first', 'first-2', 'second'])
})

test('created posts are pending Create unless silent', () => {
  const store = freshStore()
  store.applyChanges('s', { ...none, create: [entry('a')], silent: true })
  assert.equal(store.listPending('s').length, 0)
  store.applyChanges('s', { ...none, create: [entry('b')] })
  const pending = store.listPending('s')
  assert.deepEqual(pending.map((p) => [p.slug, p.pendingActivity]), [['b', 'Create']])
  assert.equal(pending[0].contentHash, contentHash(entry('b')))
  assert.equal(pending[0].published, '2026-10-01T00:00:00.000Z')
})

test('update marks Update, but keeps an unsent Create', () => {
  const store = freshStore()
  store.applyChanges('s', { ...none, create: [entry('a')], silent: true })
  store.applyChanges('s', { ...none, create: [entry('b')] })
  store.applyChanges('s', { ...none, update: [entry('a', { title: 'A2' }), entry('b', { title: 'B2' })] })
  const bySlug = Object.fromEntries(store.listPosts('s').map((p) => [p.slug, p]))
  assert.equal(bySlug.a.pendingActivity, 'Update')
  assert.equal(bySlug.a.title, 'A2')
  assert.equal(bySlug.b.pendingActivity, 'Create')
  assert.equal(bySlug.b.title, 'B2')
})

test('delete sets deletedAt and pending Delete; published list skips it', () => {
  const store = freshStore()
  store.applyChanges('s', { ...none, create: [entry('a'), entry('b')], silent: true })
  store.applyChanges('s', { ...none, delete: [entry('a').id] }, new Date('2026-10-15T00:00:00Z'))
  const a = store.getPostBySlug('s', 'a')!
  assert.equal(a.deletedAt, '2026-10-15T00:00:00.000Z')
  assert.equal(a.pendingActivity, 'Delete')
  assert.deepEqual(store.listPublishedPosts('s', { offset: 0, limit: 10 }).map((p) => p.slug), ['b'])
  assert.equal(store.countPublishedPosts('s'), 1)
})

test('clearPending clears one post', () => {
  const store = freshStore()
  store.applyChanges('s', { ...none, create: [entry('a')] })
  store.clearPending('s', entry('a').id)
  assert.deepEqual(store.listPending('s'), [])
})

test('published posts are newest first and paged', () => {
  const store = freshStore()
  store.applyChanges('s', {
    ...none,
    create: [
      entry('old', { published: new Date('2026-01-01T00:00:00Z') }),
      entry('new', { published: new Date('2026-03-01T00:00:00Z') }),
      entry('mid', { published: new Date('2026-02-01T00:00:00Z') }),
    ],
    silent: true,
  })
  assert.deepEqual(store.listPublishedPosts('s', { offset: 0, limit: 2 }).map((p) => p.slug), ['new', 'mid'])
  assert.deepEqual(store.listPublishedPosts('s', { offset: 2, limit: 2 }).map((p) => p.slug), ['old'])
})

test('sites do not see each other', () => {
  const store = freshStore()
  store.applyChanges('a', { ...none, create: [entry('x')] })
  assert.deepEqual(store.listPosts('b'), [])
  assert.equal(store.getPostBySlug('b', 'x'), undefined)
})

test('followers: upsert, remove, remove by inbox, page', () => {
  const store = freshStore()
  store.addFollower('s', { actorId: 'https://m.social/users/a', inbox: 'https://m.social/users/a/inbox', sharedInbox: 'https://m.social/inbox' })
  store.addFollower('s', { actorId: 'https://m.social/users/a', inbox: 'https://m.social/users/a/inbox2', sharedInbox: 'https://m.social/inbox' })
  store.addFollower('s', { actorId: 'https://m.social/users/b', inbox: 'https://m.social/users/b/inbox', sharedInbox: 'https://m.social/inbox' })
  store.addFollower('s', { actorId: 'https://p.social/users/c', inbox: 'https://p.social/users/c/inbox', sharedInbox: null })
  assert.equal(store.countFollowers('s'), 3)
  assert.equal(store.listFollowers('s', { offset: 0, limit: 10 }).find((f) => f.actorId.endsWith('/a'))?.inbox, 'https://m.social/users/a/inbox2')
  assert.equal(store.listFollowers('s', { offset: 0, limit: 2 }).length, 2)

  store.removeFollower('s', 'https://p.social/users/c')
  assert.equal(store.countFollowers('s'), 2)

  assert.equal(store.removeFollowersByInbox('https://m.social/inbox'), 2)
  assert.equal(store.countFollowers('s'), 0)
})

test('keys round-trip and are not overwritten', () => {
  const store = freshStore()
  const key = { kind: 'rsa' as const, privateJwk: { kty: 'RSA', d: '1' }, publicJwk: { kty: 'RSA' } }
  store.saveKeys('s', [key])
  store.saveKeys('s', [{ ...key, privateJwk: { kty: 'RSA', d: '2' } }])
  assert.deepEqual(store.getKeys('s'), [key])
  assert.deepEqual(store.getKeys('other'), [])
})

const fields = (n: number) => ({
  confirmTokenHash: `hash-${n}`,
  confirmExpiresAt: '2026-11-05T00:00:00.000Z',
  confirmSentAt: '2026-11-03T00:00:00.000Z',
  unsubscribeToken: `unsub-${n}`,
})

function confirmed(store: Store, siteId: string, email: string, n: number) {
  store.savePendingSubscriber(siteId, email, fields(n))
  return store.confirmSubscriber(siteId, `hash-${n}`, new Date('2026-11-03T01:00:00Z'))!
}

test('savePendingSubscriber creates then refreshes a pending row', () => {
  const store = freshStore()
  const first = store.savePendingSubscriber('s', 'a@x.dev', fields(1))
  assert.equal(first.status, 'pending')
  const second = store.savePendingSubscriber('s', 'a@x.dev', { ...fields(2), unsubscribeToken: 'other' })
  assert.equal(second.id, first.id)
  assert.equal(second.confirmTokenHash, 'hash-2')
  assert.equal(second.unsubscribeToken, first.unsubscribeToken)
  assert.deepEqual(store.getSubscriber('s', 'a@x.dev'), second)
  assert.deepEqual(store.getSubscriberById(first.id), second)
  assert.equal(store.getSubscriber('s', 'b@x.dev'), undefined)
})

test('confirmSubscriber matches hash and expiry once', () => {
  const store = freshStore()
  store.savePendingSubscriber('s', 'a@x.dev', fields(1))
  assert.equal(store.confirmSubscriber('s', 'nope', new Date('2026-11-03T01:00:00Z')), undefined)
  assert.equal(store.confirmSubscriber('s', 'hash-1', new Date('2026-11-06T00:00:00Z')), undefined)
  const sub = store.confirmSubscriber('s', 'hash-1', new Date('2026-11-03T01:00:00Z'))!
  assert.equal(sub.status, 'confirmed')
  assert.equal(sub.confirmTokenHash, null)
  assert.equal(sub.confirmedAt, '2026-11-03T01:00:00.000Z')
  assert.equal(store.confirmSubscriber('s', 'hash-1', new Date('2026-11-03T01:00:00Z')), undefined)
})

test('countConfirmedSubscribers counts only confirmed rows for that site', () => {
  const store = freshStore()
  confirmed(store, 's', 'a@x.dev', 1)
  store.savePendingSubscriber('s', 'b@x.dev', fields(2))
  confirmed(store, 'other', 'c@x.dev', 3)
  assert.equal(store.countConfirmedSubscribers('s'), 1)
})

test('fan-out queues one delivery per confirmed subscriber per new post', () => {
  const store = freshStore()
  confirmed(store, 's', 'a@x.dev', 1)
  confirmed(store, 's', 'b@x.dev', 2)
  store.savePendingSubscriber('s', 'c@x.dev', fields(3))
  confirmed(store, 'other', 'd@x.dev', 4)
  const queued = store.applyChanges('s', { ...none, create: [entry('a'), entry('b')] }, new Date(), { email: true })
  assert.equal(queued, 4)
  const due = store.listDueDeliveries(new Date(), 10)
  assert.equal(due.length, 4)
  assert.ok(due.every((d) => d.status === 'queued' && d.attempts === 0 && d.siteId === 's' && d.lastError === null))
  assert.equal(store.getPost('s', entry('a').id)?.slug, 'a')
  assert.equal(store.getPost('s', 'missing'), undefined)
})

test('fan-out is skipped unless email is enabled', () => {
  const store = freshStore()
  confirmed(store, 's', 'a@x.dev', 1)
  assert.equal(store.applyChanges('s', { ...none, create: [entry('a')] }), 0)
  assert.equal(store.listDueDeliveries(new Date(), 10).length, 0)
})

test('silent first sync, updates and deletes queue nothing', () => {
  const store = freshStore()
  confirmed(store, 's', 'a@x.dev', 1)
  assert.equal(store.applyChanges('s', { ...none, create: [entry('a')], silent: true }), 0)
  assert.equal(store.applyChanges('s', { ...none, update: [entry('a', { title: 'A2' })] }), 0)
  assert.equal(store.applyChanges('s', { ...none, delete: [entry('a').id] }), 0)
  assert.equal(store.applyChanges('s', none), 0)
  assert.equal(store.listDueDeliveries(new Date(), 10).length, 0)
})

test('removeSubscriberByToken deletes the subscriber and its queued deliveries', () => {
  const store = freshStore()
  const sub = confirmed(store, 's', 'a@x.dev', 1)
  store.applyChanges('s', { ...none, create: [entry('a')] }, new Date(), { email: true })
  assert.equal(store.removeSubscriberByToken('s', 'nope'), false)
  assert.equal(store.removeSubscriberByToken('s', sub.unsubscribeToken), true)
  assert.equal(store.getSubscriberById(sub.id), undefined)
  assert.equal(store.listDueDeliveries(new Date(), 10).length, 0)
})

test('listDueDeliveries skips future and non-queued rows, ordered by published then id', () => {
  const store = freshStore()
  confirmed(store, 's', 'a@x.dev', 1)
  confirmed(store, 's', 'b@x.dev', 2)
  const now = new Date('2026-11-03T02:00:00Z')
  store.applyChanges('s', { ...none, create: [entry('late', { published: new Date('2026-10-05T00:00:00Z') })] }, now, { email: true })
  store.applyChanges('s', { ...none, create: [entry('early', { published: new Date('2026-10-02T00:00:00Z') })] }, now, { email: true })
  const all = store.listDueDeliveries(now, 10)
  assert.deepEqual(all.map((d) => d.entryId), [entry('early').id, entry('early').id, entry('late').id, entry('late').id])
  assert.ok(all[0].id < all[1].id)
  assert.equal(store.listDueDeliveries(now, 3).length, 3)
  assert.equal(store.listDueDeliveries(new Date('2026-11-03T01:00:00Z'), 10).length, 0)

  store.markDeliverySent(all[0].id, now)
  store.markDeliveryRetry(all[1].id, 1, new Date('2026-11-03T03:00:00Z'), 'boom')
  store.markDeliveryFailed(all[2].id, 7, 'bad')
  assert.deepEqual(store.listDueDeliveries(now, 10).map((d) => d.id), [all[3].id])
  const retried = store.listDueDeliveries(new Date('2026-11-03T03:00:00Z'), 10).find((d) => d.id === all[1].id)!
  assert.equal(retried.attempts, 1)
  assert.equal(retried.lastError, 'boom')
  store.deleteDelivery(all[3].id)
  assert.equal(store.listDueDeliveries(now, 10).length, 0)
})

test('deleteExpiredPending removes pending rows past expiry, keeps confirmed', () => {
  const store = freshStore()
  confirmed(store, 's', 'a@x.dev', 1)
  store.savePendingSubscriber('s', 'b@x.dev', fields(2))
  assert.equal(store.deleteExpiredPending(new Date('2026-11-04T00:00:00Z')), 0)
  assert.equal(store.deleteExpiredPending(new Date('2026-11-06T00:00:00Z')), 1)
  assert.equal(store.getSubscriber('s', 'b@x.dev'), undefined)
  assert.ok(store.getSubscriber('s', 'a@x.dev'))
})

test('countConfirmationsSince counts rows with confirmSentAt at or after since', () => {
  const store = freshStore()
  store.savePendingSubscriber('s', 'a@x.dev', { ...fields(1), confirmSentAt: '2026-11-03T00:00:00.000Z' })
  store.savePendingSubscriber('s', 'b@x.dev', { ...fields(2), confirmSentAt: '2026-11-03T00:30:00.000Z' })
  store.savePendingSubscriber('other', 'c@x.dev', { ...fields(3), confirmSentAt: '2026-11-03T00:30:00.000Z' })
  assert.equal(store.countConfirmationsSince('s', new Date('2026-11-03T00:00:00Z')), 2)
  assert.equal(store.countConfirmationsSince('s', new Date('2026-11-03T00:10:00Z')), 1)
})
