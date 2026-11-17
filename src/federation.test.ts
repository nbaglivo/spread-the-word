import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { InProcessMessageQueue, MemoryKvStore } from '@fedify/fedify'
import { Store } from './store.ts'
import { buildFederation, activityFor } from './federation.ts'
import { startFakeRemote, TEST_CONFIG, type FakeRemote } from '../test/fake-remote.ts'
import { entry } from '../test/feeds.ts'
import { captureLogs } from '../test/logs.ts'

let remote: FakeRemote
before(async () => {
  remote = await startFakeRemote()
})
after(() => remote.close())

function setup() {
  const store = new Store(new DatabaseSync(':memory:'))
  store.migrate()
  const federation = buildFederation({
    config: TEST_CONFIG,
    store,
    kv: new MemoryKvStore(),
    allowPrivateAddress: true,
    skipSignatureVerification: true,
  })
  const get = (path: string) =>
    federation.fetch(new Request(`https://ap.test${path}`, { headers: { accept: 'application/activity+json' } }), { contextData: undefined })
  const post = (path: string, body: unknown) =>
    federation.fetch(
      new Request(`https://ap.test${path}`, { method: 'POST', headers: { 'content-type': 'application/activity+json' }, body: JSON.stringify(body) }),
      { contextData: undefined },
    )
  return { store, federation, get, post }
}

test('serves the actor with keys created on first request', async () => {
  const { store, get } = setup()
  const res = await get('/users/example-blog')
  assert.equal(res.status, 200)
  const actor = (await res.json()) as Record<string, any>
  assert.equal(actor.type, 'Person')
  assert.equal(actor.id, 'https://ap.test/users/example-blog')
  assert.equal(actor.preferredUsername, 'you')
  assert.equal(actor.name, 'Example Blog')
  assert.equal(actor.inbox, 'https://ap.test/users/example-blog/inbox')
  assert.equal(actor.url, 'https://blog.test/')
  assert.ok(actor.publicKey)
  assert.equal(store.getKeys('example-blog').length, 2)

  const again = (await (await get('/users/example-blog')).json()) as Record<string, any>
  assert.equal(again.publicKey.publicKeyPem, actor.publicKey.publicKeyPem)
})

test('unknown actors are 404', async () => {
  const { get } = setup()
  assert.equal((await get('/users/nobody')).status, 404)
})

test('Follow stores the follower and sends Accept; Undo removes it', async () => {
  const { store, post } = setup()
  const follow = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${remote.origin}/follows/1`,
    type: 'Follow',
    actor: remote.actorId,
    object: 'https://ap.test/users/example-blog',
  }
  const res = await post('/users/example-blog/inbox', follow)
  assert.equal(res.status, 202)
  assert.deepEqual(store.listFollowers('example-blog', { offset: 0, limit: 10 }), [
    { actorId: remote.actorId, inbox: remote.inbox, sharedInbox: remote.sharedInbox },
  ])
  const accept = remote.deliveries.find((d) => d.type === 'Accept')
  assert.ok(accept)
  assert.equal(accept.path, '/users/alice/inbox')
  assert.equal(accept.body.actor, 'https://ap.test/users/example-blog')

  const undo = await post('/inbox', {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${remote.origin}/undos/1`,
    type: 'Undo',
    actor: remote.actorId,
    object: follow,
  })
  assert.equal(undo.status, 202)
  assert.equal(store.countFollowers('example-blog'), 0)
})

test('other activities are accepted and ignored', async () => {
  const { store, post } = setup()
  const res = await post('/users/example-blog/inbox', {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${remote.origin}/likes/1`,
    type: 'Like',
    actor: remote.actorId,
    object: 'https://ap.test/users/example-blog/posts/a',
  })
  assert.equal(res.status, 202)
  assert.equal(store.countFollowers('example-blog'), 0)
})

test('serves articles, tombstones and the outbox', async () => {
  const { store, get } = setup()
  store.applyChanges('example-blog', {
    create: [entry('a', { summary: 'Sub' }), entry('b', { published: new Date('2026-10-02T00:00:00Z') })],
    update: [],
    delete: [],
    silent: true,
  })
  const article = (await (await get('/users/example-blog/posts/a')).json()) as Record<string, any>
  assert.equal(article.type, 'Article')
  assert.equal(article.id, 'https://ap.test/users/example-blog/posts/a')
  assert.equal(article.name, 'Title a')
  assert.equal(article.summary, 'Sub')
  assert.equal(article.content, '<p>Body of a</p>')
  assert.equal(article.url, 'https://blog.test/writing/a.html')
  assert.equal(article.attributedTo, 'https://ap.test/users/example-blog')

  store.applyChanges('example-blog', { create: [], update: [], delete: [entry('a').id], silent: false })
  const tombstone = (await (await get('/users/example-blog/posts/a')).json()) as Record<string, any>
  assert.equal(tombstone.type, 'Tombstone')

  const outbox = (await (await get('/users/example-blog/outbox')).json()) as Record<string, any>
  assert.equal(outbox.totalItems, 1)
  const page = (await (await get('/users/example-blog/outbox?cursor=0')).json()) as Record<string, any>
  const items = page.orderedItems as Record<string, any>[]
  assert.equal(items.length, 1)
  assert.equal(items[0].type, 'Create')
})

test('activityFor builds Create, Update and Delete with stable ids', async () => {
  const { store, federation } = setup()
  store.applyChanges('example-blog', { create: [entry('a')], update: [], delete: [], silent: false })
  const ctx = federation.createContext(new URL('https://ap.test'), undefined)
  const post = store.getPostBySlug('example-blog', 'a')!
  const create = activityFor(ctx, 'example-blog', post, 'Create')
  const update = activityFor(ctx, 'example-blog', post, 'Update')
  const remove = activityFor(ctx, 'example-blog', post, 'Delete')
  assert.equal(create.id?.href, 'https://ap.test/users/example-blog/posts/a#create')
  assert.equal(update.id?.href, `https://ap.test/users/example-blog/posts/a#update-${post.contentHash.slice(0, 12)}`)
  assert.equal(remove.id?.href, 'https://ap.test/users/example-blog/posts/a#delete')
})

test('follows and unfollows are logged', async () => {
  const logs = await captureLogs()
  const { post } = setup()
  const follow = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${remote.origin}/follows/2`,
    type: 'Follow',
    actor: remote.actorId,
    object: 'https://ap.test/users/example-blog',
  }
  await post('/users/example-blog/inbox', follow)
  await post('/inbox', { '@context': 'https://www.w3.org/ns/activitystreams', id: `${remote.origin}/undos/2`, type: 'Undo', actor: remote.actorId, object: follow })
  assert.deepEqual(logs.lines('stw.followers'), [`${remote.actorId} followed example-blog`, `${remote.actorId} unfollowed example-blog`])
})

test('followers on an inbox that is gone are removed and logged', async () => {
  const logs = await captureLogs()
  const store = new Store(new DatabaseSync(':memory:'))
  store.migrate()
  const federation = buildFederation({ config: TEST_CONFIG, store, kv: new MemoryKvStore(), queue: new InProcessMessageQueue(), allowPrivateAddress: true })
  const stop = new AbortController()
  const queue = federation.startQueue(undefined, { signal: stop.signal })
  const gone = `${remote.origin}/gone/inbox`
  store.addFollower('example-blog', { actorId: `${remote.origin}/users/bob`, inbox: gone, sharedInbox: null })
  store.addFollower('example-blog', { actorId: remote.actorId, inbox: remote.inbox, sharedInbox: remote.sharedInbox })
  store.applyChanges('example-blog', { create: [entry('a')], update: [], delete: [], silent: false })
  const ctx = federation.createContext(new URL('https://ap.test'), undefined)
  const activity = activityFor(ctx, 'example-blog', store.getPostBySlug('example-blog', 'a')!, 'Create')
  await ctx.sendActivity({ identifier: 'example-blog' }, 'followers', activity, { preferSharedInbox: true })
  for (let i = 0; i < 100 && store.countFollowers('example-blog') > 1; i++) await new Promise((resolve) => setTimeout(resolve, 20))
  stop.abort()
  await queue
  assert.deepEqual(store.listFollowers('example-blog', { offset: 0, limit: 10 }).map((f) => f.actorId), [remote.actorId])
  assert.deepEqual(logs.lines('stw.followers'), [`removed 1 followers at ${gone} after delivery failed for good (http)`])
})

test('sending to followers reads them in one go', async () => {
  const logs = await captureLogs()
  const { store, federation, get } = setup()
  store.addFollower('example-blog', { actorId: remote.actorId, inbox: remote.inbox, sharedInbox: remote.sharedInbox })
  store.applyChanges('example-blog', { create: [entry('a')], update: [], delete: [], silent: false })
  const ctx = federation.createContext(new URL('https://ap.test'), undefined)
  const activity = activityFor(ctx, 'example-blog', store.getPostBySlug('example-blog', 'a')!, 'Create')
  await ctx.sendActivity({ identifier: 'example-blog' }, 'followers', activity, { preferSharedInbox: true })
  assert.deepEqual(logs.records.filter((r) => r.level === 'warning').map((r) => r.rawMessage), [])

  const collection = (await (await get('/users/example-blog/followers')).json()) as Record<string, any>
  assert.equal(collection.totalItems, 1)
  assert.ok(collection.first)
  assert.equal(collection.items, undefined)
})
