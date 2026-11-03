import { getLogger } from '@logtape/logtape'
import { maskEmail } from './address.ts'
import type { Config } from './config.ts'
import { newPostEmail, unsubscribeUrl } from './emails.ts'
import { classifyMailError, type Mailer } from './mail.ts'
import type { EmailDelivery, Store } from './store.ts'

const logger = getLogger(['warmhole', 'email'])

export const RETRY_DELAYS_MS: readonly number[] = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000]

const BATCH_SIZE = 20
const CLEANUP_EVERY_MS = 60 * 60_000

export type EmailWorkerDeps = {
  config: Config
  store: Store
  mailer: Mailer
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}

export class EmailWorker {
  private deps: EmailWorkerDeps
  private now: () => Date
  private sleep: (ms: number) => Promise<void>
  private lastCleanup: number | null = null
  private timer: NodeJS.Timeout | null = null
  private running: Promise<unknown> | null = null
  private stopped = true

  constructor(deps: EmailWorkerDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => new Date())
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  async tick(): Promise<number> {
    const { store, config } = this.deps
    const now = this.now()
    if (this.lastCleanup === null || now.getTime() - this.lastCleanup >= CLEANUP_EVERY_MS) {
      this.lastCleanup = now.getTime()
      store.deleteExpiredPending(now)
    }

    const due = store.listDueDeliveries(now, BATCH_SIZE)
    const pauseMs = config.smtp?.pauseMs ?? 1000
    let attempted = false
    for (const delivery of due) {
      try {
        const pause = async () => {
          if (attempted && pauseMs > 0) await this.sleep(pauseMs)
          attempted = true
        }
        await this.deliver(delivery, pause)
      } catch (error) {
        logger.error('{site}: email worker failed on delivery {id}: {reason}', {
          site: delivery.siteId,
          id: delivery.id,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return due.length
  }

  private async deliver(delivery: EmailDelivery, beforeSend: () => Promise<void>): Promise<void> {
    const { config, store, mailer } = this.deps
    const subscriber = store.getSubscriberById(delivery.subscriberId)
    const post = store.getPost(delivery.siteId, delivery.entryId)
    const site = config.sites.find((s) => s.id === delivery.siteId)
    if (!subscriber || !post || post.deletedAt || !site?.email) {
      store.deleteDelivery(delivery.id)
      return
    }

    const url = unsubscribeUrl(config, site.id, subscriber.unsubscribeToken)
    const recipient = maskEmail(subscriber.email)
    await beforeSend()
    try {
      const email = newPostEmail(site, post, url)
      await mailer.send({
        from: site.email.from,
        to: subscriber.email,
        subject: email.subject,
        html: email.html,
        text: email.text,
        headers: { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      })
    } catch (error) {
      const failure = classifyMailError(error)
      const attempts = delivery.attempts + 1
      if (failure.permanent || attempts > RETRY_DELAYS_MS.length) {
        store.markDeliveryFailed(delivery.id, attempts, failure.message)
        logger.error('{site}: gave up emailing {post} to {recipient}: {reason}', {
          site: site.id,
          post: post.slug,
          recipient,
          reason: failure.message,
        })
      } else {
        const next = new Date(this.now().getTime() + RETRY_DELAYS_MS.at(attempts - 1)!)
        store.markDeliveryRetry(delivery.id, attempts, next, failure.message)
        logger.warn('{site}: email of {post} to {recipient} failed (attempt {attempt}): {reason}', {
          site: site.id,
          post: post.slug,
          recipient,
          attempt: attempts,
          reason: failure.message,
        })
      }
      return
    }
    store.markDeliverySent(delivery.id, this.now())
    logger.info('{site}: emailed {post} to {recipient}', { site: site.id, post: post.slug, recipient })
  }

  start(intervalMs = 5000): void {
    if (!this.stopped) return
    this.stopped = false
    const loop = () => {
      this.timer = setTimeout(async () => {
        this.running = this.tick().catch((error) => {
          logger.error('email worker tick failed: {reason}', { reason: error instanceof Error ? error.message : String(error) })
        })
        await this.running
        this.running = null
        if (!this.stopped) loop()
      }, intervalMs)
    }
    loop()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.running
  }
}
