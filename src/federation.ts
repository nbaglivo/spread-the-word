import {
  createFederation,
  exportJwk,
  generateCryptoKeyPair,
  importJwk,
  type Context,
  type Federation,
  type KvStore,
  type MessageQueue,
} from '@fedify/fedify'
import {
  Accept,
  Article,
  Create,
  Delete,
  Endpoints,
  Follow,
  Image,
  Person,
  PUBLIC_COLLECTION,
  Tombstone,
  Undo,
  Update,
  isActor,
  type Activity,
  type Recipient,
} from '@fedify/vocab'
import { getLogger } from '@logtape/logtape'
import type { Config } from './config.ts'
import type { Follower, PendingActivity, PostRow, Store, StoredKey } from './store.ts'

const PAGE_SIZE = 20
const logger = getLogger(['stw', 'followers'])

export type FederationDeps = {
  config: Config
  store: Store
  kv: KvStore
  queue?: MessageQueue
  allowPrivateAddress?: boolean
  skipSignatureVerification?: boolean
}

export function articleFor(ctx: Context<void>, siteId: string, post: PostRow): Article {
  return new Article({
    id: ctx.getObjectUri(Article, { identifier: siteId, slug: post.slug }),
    attribution: ctx.getActorUri(siteId),
    to: PUBLIC_COLLECTION,
    cc: ctx.getFollowersUri(siteId),
    name: post.title,
    summary: post.summary,
    content: post.html,
    url: new URL(post.url),
    published: Temporal.Instant.from(post.published),
    updated: post.updated !== post.published ? Temporal.Instant.from(post.updated) : null,
  })
}

export function activityFor(ctx: Context<void>, siteId: string, post: PostRow, kind: PendingActivity): Activity {
  const object = articleFor(ctx, siteId, post)
  const objectId = object.id!
  const shared = { actor: ctx.getActorUri(siteId), to: PUBLIC_COLLECTION, cc: ctx.getFollowersUri(siteId) }
  if (kind === 'Create') {
    return new Create({ ...shared, id: new URL('#create', objectId), object, published: object.published })
  }
  if (kind === 'Update') {
    return new Update({ ...shared, id: new URL(`#update-${post.contentHash.slice(0, 12)}`, objectId), object, updated: Temporal.Now.instant() })
  }
  return new Delete({ ...shared, id: new URL('#delete', objectId), object: new Tombstone({ id: objectId }) })
}

async function generateKeys(): Promise<StoredKey[]> {
  const rsa = await generateCryptoKeyPair('RSASSA-PKCS1-v1_5')
  const ed = await generateCryptoKeyPair('Ed25519')
  return [
    { kind: 'rsa', privateJwk: await exportJwk(rsa.privateKey), publicJwk: await exportJwk(rsa.publicKey) },
    { kind: 'ed25519', privateJwk: await exportJwk(ed.privateKey), publicJwk: await exportJwk(ed.publicKey) },
  ]
}

function recipients(followers: Follower[]): Recipient[] {
  return followers.map((f) => ({
    id: new URL(f.actorId),
    inboxId: new URL(f.inbox),
    endpoints: f.sharedInbox ? { sharedInbox: new URL(f.sharedInbox) } : null,
  }))
}

function nextCursor(offset: number, total: number): string | null {
  return offset + PAGE_SIZE < total ? String(offset + PAGE_SIZE) : null
}

export function buildFederation({ config, store, kv, queue, allowPrivateAddress = false, skipSignatureVerification = false }: FederationDeps): Federation<void> {
  const sites = new Map(config.sites.map((s) => [s.id, s]))

  const federation = createFederation<void>({
    kv,
    queue,
    manuallyStartQueue: queue !== undefined,
    origin: config.publicUrl.origin,
    allowPrivateAddress,
    skipSignatureVerification,
  })

  federation
    .setActorDispatcher('/users/{identifier}', async (ctx, identifier) => {
      const site = sites.get(identifier)
      if (!site) return null
      const keys = await ctx.getActorKeyPairs(identifier)
      return new Person({
        id: ctx.getActorUri(identifier),
        preferredUsername: site.handle,
        name: site.name,
        summary: site.summary ?? null,
        url: new URL(`https://${site.domain}/`),
        icon: site.icon ? new Image({ url: site.icon }) : null,
        inbox: ctx.getInboxUri(identifier),
        outbox: ctx.getOutboxUri(identifier),
        followers: ctx.getFollowersUri(identifier),
        endpoints: new Endpoints({ sharedInbox: ctx.getInboxUri() }),
        publicKey: keys[0]?.cryptographicKey,
        assertionMethods: keys.map((k) => k.multikey),
        manuallyApprovesFollowers: false,
        discoverable: true,
      })
    })
    .setKeyPairsDispatcher(async (_ctx, identifier) => {
      if (!sites.has(identifier)) return []
      if (store.getKeys(identifier).length === 0) store.saveKeys(identifier, await generateKeys())
      return Promise.all(
        store.getKeys(identifier).map(async (k) => ({
          privateKey: await importJwk(k.privateJwk, 'private'),
          publicKey: await importJwk(k.publicJwk, 'public'),
        })),
      )
    })

  federation
    .setOutboxDispatcher('/users/{identifier}/outbox', (ctx, identifier, cursor) => {
      if (!sites.has(identifier) || cursor === null) return null
      const offset = Number(cursor) || 0
      const posts = store.listPublishedPosts(identifier, { offset, limit: PAGE_SIZE })
      return {
        items: posts.map((p) => activityFor(ctx, identifier, p, 'Create')),
        nextCursor: nextCursor(offset, store.countPublishedPosts(identifier)),
      }
    })
    .setCounter((_ctx, identifier) => (sites.has(identifier) ? store.countPublishedPosts(identifier) : null))
    .setFirstCursor(() => '0')

  federation
    .setFollowersDispatcher('/users/{identifier}/followers', (_ctx, identifier, cursor) => {
      if (!sites.has(identifier)) return null
      if (cursor === null) return { items: recipients(store.listFollowers(identifier, { offset: 0, limit: -1 })) }
      const offset = Number(cursor) || 0
      const items = recipients(store.listFollowers(identifier, { offset, limit: PAGE_SIZE }))
      return { items, nextCursor: nextCursor(offset, store.countFollowers(identifier)) }
    })
    .setCounter((_ctx, identifier) => (sites.has(identifier) ? store.countFollowers(identifier) : null))
    .setFirstCursor(() => '0')

  federation.setObjectDispatcher(Article, '/users/{identifier}/posts/{slug}', (ctx, { identifier, slug }) => {
    const post = store.getPostBySlug(identifier, slug)
    if (!post) return null
    if (post.deletedAt) {
      return new Tombstone({ id: ctx.getObjectUri(Article, { identifier, slug }), deleted: Temporal.Instant.from(post.deletedAt) })
    }
    return articleFor(ctx, identifier, post)
  })

  federation
    .setInboxListeners('/users/{identifier}/inbox', '/inbox')
    .on(Follow, async (ctx, follow) => {
      if (follow.id === null || follow.objectId === null) return
      const parsed = ctx.parseUri(follow.objectId)
      if (parsed?.type !== 'actor' || !sites.has(parsed.identifier)) return
      const follower = await follow.getActor(ctx)
      if (follower === null || !isActor(follower) || follower.id === null || follower.inboxId === null) return
      store.addFollower(parsed.identifier, {
        actorId: follower.id.href,
        inbox: follower.inboxId.href,
        sharedInbox: follower.endpoints?.sharedInbox?.href ?? null,
      })
      logger.info('{follower} followed {site}', { follower: follower.id.href, site: parsed.identifier })
      await ctx.sendActivity(
        { identifier: parsed.identifier },
        follower,
        new Accept({
          id: new URL(`#accepts/${crypto.randomUUID()}`, ctx.getActorUri(parsed.identifier)),
          actor: follow.objectId,
          object: follow,
        }),
      )
    })
    .on(Undo, async (ctx, undo) => {
      const object = await undo.getObject(ctx)
      if (!(object instanceof Follow) || undo.actorId === null || object.objectId === null) return
      const parsed = ctx.parseUri(object.objectId)
      if (parsed?.type !== 'actor' || !sites.has(parsed.identifier)) return
      store.removeFollower(parsed.identifier, undo.actorId.href)
      logger.info('{follower} unfollowed {site}', { follower: undo.actorId.href, site: parsed.identifier })
    })

  federation.setOutboxPermanentFailureHandler((_ctx, { inbox, reason, statusCode }) => {
    const count = store.removeFollowersByInbox(inbox.href)
    logger.warn('removed {count} followers at {inbox} after delivery failed for good ({reason})', { count, inbox: inbox.href, reason, statusCode })
  })

  return federation
}
