import { createHash, randomBytes } from 'node:crypto'
import { getLogger } from '@logtape/logtape'
import { isEmailAddress, maskEmail, normalizeEmail } from './address.ts'
import type { Config } from './config.ts'
import { confirmUrl, confirmationEmail } from './emails.ts'
import type { Mailer } from './mail.ts'
import type { Store } from './store.ts'

const logger = getLogger(['warmhole', 'email'])

const CONFIRM_TTL_MS = 48 * 60 * 60 * 1000
const ADDRESS_THROTTLE_MS = 10 * 60 * 1000
const SITE_THROTTLE_WINDOW_MS = 60 * 60 * 1000
const SITE_THROTTLE_LIMIT = 30

export type SubscribeOutcome = 'sent' | 'ignored' | 'invalid' | 'throttled'
export type ConfirmOutcome = 'confirmed' | 'invalid'
export type SubscriptionsDeps = { config: Config; store: Store; mailer: Mailer; now?: () => Date }

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export class Subscriptions {
  private config: Config
  private store: Store
  private mailer: Mailer
  private now: () => Date
  private pending = new Set<Promise<void>>()

  constructor(deps: SubscriptionsDeps) {
    this.config = deps.config
    this.store = deps.store
    this.mailer = deps.mailer
    this.now = deps.now ?? (() => new Date())
  }

  async subscribe(siteId: string, input: { email: string; website: string }): Promise<SubscribeOutcome> {
    const site = this.config.sites.find((s) => s.id === siteId)
    if (!site?.email) return 'ignored'
    if (input.website !== '') return 'ignored'
    const email = normalizeEmail(input.email)
    if (!isEmailAddress(email)) return 'invalid'

    const existing = this.store.getSubscriber(siteId, email)
    if (existing?.status === 'confirmed') return 'ignored'

    const now = this.now()
    const recipient = maskEmail(email)
    const addressThrottled =
      existing?.confirmSentAt != null && now.getTime() - new Date(existing.confirmSentAt).getTime() < ADDRESS_THROTTLE_MS
    const siteThrottled =
      this.store.countConfirmationsSince(siteId, new Date(now.getTime() - SITE_THROTTLE_WINDOW_MS)) >= SITE_THROTTLE_LIMIT
    if (addressThrottled || siteThrottled) {
      logger.warn('{site}: subscribe throttled for {recipient}', { site: siteId, recipient })
      return 'throttled'
    }

    const token = newToken()
    this.store.savePendingSubscriber(siteId, email, {
      confirmTokenHash: hashToken(token),
      confirmExpiresAt: new Date(now.getTime() + CONFIRM_TTL_MS).toISOString(),
      confirmSentAt: now.toISOString(),
      unsubscribeToken: existing?.unsubscribeToken ?? newToken(),
    })

    const rendered = confirmationEmail(site, confirmUrl(this.config, siteId, token))
    const sending: Promise<void> = this.mailer
      .send({ from: site.email.from, to: email, ...rendered })
      .catch((error) => {
        const reason = error instanceof Error ? error.message : String(error)
        logger.error('{site}: confirmation to {recipient} failed: {reason}', { site: siteId, recipient, reason })
      })
      .finally(() => this.pending.delete(sending))
    this.pending.add(sending)
    return 'sent'
  }

  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending)
  }

  confirm(siteId: string, token: string): ConfirmOutcome {
    const site = this.config.sites.find((s) => s.id === siteId)
    if (!site?.email) return 'invalid'
    const subscriber = this.store.confirmSubscriber(siteId, hashToken(token), this.now())
    if (!subscriber) return 'invalid'
    logger.info('{site}: new subscriber, {count} subscribers', {
      site: siteId,
      count: this.store.countConfirmedSubscribers(siteId),
    })
    return 'confirmed'
  }

  unsubscribe(siteId: string, token: string): boolean {
    const site = this.config.sites.find((s) => s.id === siteId)
    if (!site?.email) return false
    if (!this.store.removeSubscriberByToken(siteId, token)) return false
    logger.info('{site}: subscriber left, {count} subscribers', {
      site: siteId,
      count: this.store.countConfirmedSubscribers(siteId),
    })
    return true
  }
}
