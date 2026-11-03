import { createHash, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { federation as fedifyMiddleware } from '@fedify/hono'
import type { Federation } from '@fedify/fedify'
import { getLogger } from '@logtape/logtape'
import type { Config, SiteConfig } from './config.ts'
import type { SyncResult } from './sync.ts'
import { FeedError } from './feed.ts'
import { GuardError } from './diff.ts'
import type { Subscriptions } from './subscriptions.ts'
import { expiredLinkPage, unsubscribePage, unsubscribeUrl } from './emails.ts'

const logger = getLogger(['warmhole', 'sync'])

export type AppDeps = {
  config: Config
  federation: Federation<void>
  syncer: { sync(siteId: string): Promise<SyncResult> }
  subscriptions?: Pick<Subscriptions, 'subscribe' | 'confirm' | 'unsubscribe'>
}

function actorUrl(config: Config, site: SiteConfig): string {
  return new URL(`/users/${site.id}`, config.publicUrl).href
}

export function webfingerFor(config: Config, site: SiteConfig): Record<string, unknown> {
  const actor = actorUrl(config, site)
  return {
    subject: `acct:${site.handle}@${site.domain}`,
    aliases: [actor],
    links: [
      { rel: 'self', type: 'application/activity+json', href: actor },
      { rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: `https://${site.domain}/` },
    ],
  }
}

export function findSiteByResource(config: Config, resource: string): SiteConfig | undefined {
  if (/^https?:\/\//i.test(resource)) {
    return config.sites.find((s) => actorUrl(config, s) === resource)
  }
  const match = /^(?:acct:)?([^@]+)@([^@]+)$/i.exec(resource.trim())
  if (!match) return undefined
  const handle = match[1].toLowerCase()
  const host = match[2].toLowerCase()
  return config.sites.find((s) => s.handle === handle && (host === s.domain || host === config.publicUrl.host))
}

function sameToken(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

export function buildApp({ config, federation, syncer, subscriptions }: AppDeps): Hono {
  const app = new Hono()
  const sites = new Map(config.sites.map((s) => [s.id, s]))

  app.get('/.well-known/webfinger', (c) => {
    const resource = c.req.query('resource')
    if (!resource) return c.json({ error: 'resource is required' }, 400)
    const site = findSiteByResource(config, resource)
    if (!site) return c.json({ error: 'not found' }, 404)
    return c.body(JSON.stringify(webfingerFor(config, site)), 200, {
      'content-type': 'application/jrd+json',
      'access-control-allow-origin': '*',
    })
  })

  app.get('/sites/:id/webfinger.json', (c) => {
    const site = sites.get(c.req.param('id'))
    if (!site) return c.json({ error: 'not found' }, 404)
    return c.json(webfingerFor(config, site))
  })

  app.post('/sites/:id/sync', async (c) => {
    const site = sites.get(c.req.param('id'))
    const header = c.req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    if (!site || !sameToken(token, site.syncToken)) return c.json({ error: 'unauthorized' }, 401)
    try {
      return c.json(await syncer.sync(site.id))
    } catch (error) {
      if (error instanceof FeedError || error instanceof GuardError) {
        logger.warn('sync of {site} failed: {reason}', { site: site.id, reason: error.message })
        return c.json({ error: error.message }, error instanceof FeedError ? 502 : 422)
      }
      logger.error('sync of {site} crashed: {error}', { site: site.id, error })
      return c.json({ error: 'internal error' }, 500)
    }
  })

  const emailSite = (id: string) => {
    const site = sites.get(id)
    return site?.email && subscriptions ? { site, email: site.email, subscriptions } : undefined
  }

  const field = (body: Record<string, unknown>, name: string): string => {
    const value = body[name]
    return typeof value === 'string' ? value : ''
  }

  app.post('/sites/:id/subscribe', async (c) => {
    const found = emailSite(c.req.param('id'))
    if (!found) return c.json({ error: 'not found' }, 404)
    const body = await c.req.parseBody()
    const outcome = await found.subscriptions.subscribe(found.site.id, {
      email: field(body, 'email'),
      website: field(body, 'website'),
    })
    const target = new URL(found.email.checkInboxUrl)
    if (outcome === 'invalid') target.searchParams.set('error', 'invalid')
    return c.redirect(target.href, 303)
  })

  app.get('/sites/:id/confirm', (c) => {
    const found = emailSite(c.req.param('id'))
    if (!found) return c.json({ error: 'not found' }, 404)
    const token = c.req.query('token')
    if (!token || found.subscriptions.confirm(found.site.id, token) === 'invalid') {
      return c.html(expiredLinkPage(found.site), 410)
    }
    return c.redirect(found.email.confirmedUrl.href, 303)
  })

  app.get('/sites/:id/unsubscribe', (c) => {
    const found = emailSite(c.req.param('id'))
    if (!found) return c.json({ error: 'not found' }, 404)
    const token = c.req.query('token')
    if (!token) return c.html(expiredLinkPage(found.site), 410)
    return c.html(unsubscribePage(found.site, unsubscribeUrl(config, found.site.id, token)))
  })

  app.post('/sites/:id/unsubscribe', async (c) => {
    const found = emailSite(c.req.param('id'))
    if (!found) return c.json({ error: 'not found' }, 404)
    const token = c.req.query('token')
    if (token) found.subscriptions.unsubscribe(found.site.id, token)
    const body = await c.req.parseBody()
    if (field(body, 'List-Unsubscribe') === 'One-Click') return c.body(null, 200)
    return c.redirect(found.email.unsubscribedUrl.href, 303)
  })

  app.get('/healthz', (c) => c.text('ok'))

  app.use(fedifyMiddleware(federation, () => undefined))

  return app
}
