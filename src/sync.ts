import type { Federation } from '@fedify/fedify'
import { getLogger } from '@logtape/logtape'
import type { Config } from './config.ts'
import { fetchFeed as defaultFetchFeed, normalizeFeed } from './feed.ts'
import { diff } from './diff.ts'
import type { Store } from './store.ts'
import { activityFor } from './federation.ts'

const logger = getLogger(['warmhole', 'sync'])
const emailLogger = getLogger(['warmhole', 'email'])

export type SyncResult = { new: number; updated: number; deleted: number; emails: number }

export type SyncDeps = {
  config: Config
  store: Store
  federation: Federation<void>
  fetchFeed?: (url: URL) => Promise<string>
}

export class UnknownSiteError extends Error {
  name = 'UnknownSiteError'
}

export class Syncer {
  deps: SyncDeps
  locks = new Map<string, Promise<unknown>>()

  constructor(deps: SyncDeps) {
    this.deps = deps
  }

  async sync(siteId: string): Promise<SyncResult> {
    const previous = this.locks.get(siteId) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(() => this.run(siteId))
    this.locks.set(siteId, run)
    try {
      return await run
    } finally {
      if (this.locks.get(siteId) === run) this.locks.delete(siteId)
    }
  }

  async run(siteId: string): Promise<SyncResult> {
    const { config, store } = this.deps
    const site = config.sites.find((s) => s.id === siteId)
    if (!site) throw new UnknownSiteError(`unknown site ${siteId}`)

    const fetchFeed = this.deps.fetchFeed ?? defaultFetchFeed
    const entries = normalizeFeed(await fetchFeed(site.feedUrl), new Date(), site.feedUrl)
    const stored = store.listPosts(siteId).map((p) => ({ entryId: p.entryId, contentHash: p.contentHash, deleted: p.deletedAt !== null, published: p.published }))
    const changes = diff(stored, entries, { deleteMissing: site.deleteMissing })

    const emails = store.applyChanges(siteId, changes, new Date(), { email: Boolean(site.email && config.smtp) })
    if (emails > 0) {
      const count = store.countConfirmedSubscribers(siteId)
      for (const created of changes.create) emailLogger.info('{site}: emailing {title} to {count} subscribers', { site: siteId, title: created.title, count })
    }
    await this.flushPending(siteId)

    const result = { new: changes.create.length, updated: changes.update.length, deleted: changes.delete.length, emails }
    if (changes.silent) logger.info('first sync of {site} stored {new} posts without sending them', { site: siteId, ...result })
    else logger.info('synced {site}: {new} new, {updated} updated, {deleted} deleted, {emails} emails', { site: siteId, ...result })
    return result
  }

  async flushPending(siteId: string): Promise<void> {
    const { config, store, federation } = this.deps
    const ctx = federation.createContext(config.publicUrl, undefined)
    for (const post of store.listPending(siteId)) {
      await ctx.sendActivity({ identifier: siteId }, 'followers', activityFor(ctx, siteId, post, post.pendingActivity!), { preferSharedInbox: true })
      store.clearPending(siteId, post.entryId)
    }
  }
}
