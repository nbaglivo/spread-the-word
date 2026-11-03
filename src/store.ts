import type { webcrypto } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { contentHash, type Changes } from './diff.ts'

export type PendingActivity = 'Create' | 'Update' | 'Delete'

export type PostRow = {
  siteId: string
  entryId: string
  slug: string
  title: string
  summary: string | null
  html: string
  url: string
  published: string
  updated: string
  contentHash: string
  deletedAt: string | null
  pendingActivity: PendingActivity | null
}

export type Follower = { actorId: string; inbox: string; sharedInbox: string | null }

type JsonWebKey = webcrypto.JsonWebKey

export type StoredKey = { kind: 'rsa' | 'ed25519'; privateJwk: JsonWebKey; publicJwk: JsonWebKey }

export type SubscriberStatus = 'pending' | 'confirmed'

export type Subscriber = {
  id: number
  siteId: string
  email: string
  status: SubscriberStatus
  confirmTokenHash: string | null
  confirmExpiresAt: string | null
  confirmSentAt: string | null
  unsubscribeToken: string
  createdAt: string
  confirmedAt: string | null
}

export type DeliveryStatus = 'queued' | 'sent' | 'failed'

export type EmailDelivery = {
  id: number
  siteId: string
  entryId: string
  subscriberId: number
  status: DeliveryStatus
  attempts: number
  nextAttemptAt: string
  lastError: string | null
}

export type Page = { offset: number; limit: number }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS keys (
  site_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  private_jwk TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  PRIMARY KEY (site_id, kind)
);
CREATE TABLE IF NOT EXISTS followers (
  site_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  inbox TEXT NOT NULL,
  shared_inbox TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (site_id, actor_id)
);
CREATE TABLE IF NOT EXISTS posts (
  site_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  html TEXT NOT NULL,
  url TEXT NOT NULL,
  published TEXT NOT NULL,
  updated TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  deleted_at TEXT,
  pending_activity TEXT,
  PRIMARY KEY (site_id, entry_id),
  UNIQUE (site_id, slug)
);
CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL,
  confirm_token_hash TEXT,
  confirm_expires_at TEXT,
  confirm_sent_at TEXT,
  unsubscribe_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  confirmed_at TEXT,
  UNIQUE (site_id, email)
);
CREATE TABLE IF NOT EXISTS email_deliveries (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  subscriber_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  UNIQUE (site_id, entry_id, subscriber_id)
);
CREATE INDEX IF NOT EXISTS email_deliveries_due ON email_deliveries (status, next_attempt_at);
`

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export function slugFor(url: string, taken: Set<string>): string {
  const segments = new URL(url).pathname
    .split('/')
    .filter(Boolean)
    .map((s) => safeDecode(s).replace(/\.[a-z0-9]+$/i, ''))
  const meaningful = segments.filter((s) => s.toLowerCase() !== 'index')
  const base =
    (meaningful.at(-1) ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'post'
  let slug = base
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
  return slug
}

type Row = Record<string, unknown>

function toPost(row: Row): PostRow {
  return {
    siteId: row.site_id as string,
    entryId: row.entry_id as string,
    slug: row.slug as string,
    title: row.title as string,
    summary: (row.summary as string | null) ?? null,
    html: row.html as string,
    url: row.url as string,
    published: row.published as string,
    updated: row.updated as string,
    contentHash: row.content_hash as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
    pendingActivity: (row.pending_activity as PendingActivity | null) ?? null,
  }
}

function toFollower(row: Row): Follower {
  return { actorId: row.actor_id as string, inbox: row.inbox as string, sharedInbox: (row.shared_inbox as string | null) ?? null }
}

function toSubscriber(row: Row): Subscriber {
  return {
    id: Number(row.id),
    siteId: row.site_id as string,
    email: row.email as string,
    status: row.status as SubscriberStatus,
    confirmTokenHash: (row.confirm_token_hash as string | null) ?? null,
    confirmExpiresAt: (row.confirm_expires_at as string | null) ?? null,
    confirmSentAt: (row.confirm_sent_at as string | null) ?? null,
    unsubscribeToken: row.unsubscribe_token as string,
    createdAt: row.created_at as string,
    confirmedAt: (row.confirmed_at as string | null) ?? null,
  }
}

function toDelivery(row: Row): EmailDelivery {
  return {
    id: Number(row.id),
    siteId: row.site_id as string,
    entryId: row.entry_id as string,
    subscriberId: Number(row.subscriber_id),
    status: row.status as DeliveryStatus,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at as string,
    lastError: (row.last_error as string | null) ?? null,
  }
}

export class Store {
  db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  migrate(): void {
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getKeys(siteId: string): StoredKey[] {
    return this.db
      .prepare('SELECT kind, private_jwk, public_jwk FROM keys WHERE site_id = ? ORDER BY kind DESC')
      .all(siteId)
      .map((row) => ({
        kind: row.kind as StoredKey['kind'],
        privateJwk: JSON.parse(row.private_jwk as string),
        publicJwk: JSON.parse(row.public_jwk as string),
      }))
  }

  saveKeys(siteId: string, keys: StoredKey[]): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO keys (site_id, kind, private_jwk, public_jwk) VALUES (?, ?, ?, ?)')
    this.transaction(() => {
      for (const k of keys) insert.run(siteId, k.kind, JSON.stringify(k.privateJwk), JSON.stringify(k.publicJwk))
    })
  }

  addFollower(siteId: string, f: Follower): void {
    this.db
      .prepare(
        `INSERT INTO followers (site_id, actor_id, inbox, shared_inbox) VALUES (?, ?, ?, ?)
         ON CONFLICT (site_id, actor_id) DO UPDATE SET inbox = excluded.inbox, shared_inbox = excluded.shared_inbox`,
      )
      .run(siteId, f.actorId, f.inbox, f.sharedInbox)
  }

  removeFollower(siteId: string, actorId: string): void {
    this.db.prepare('DELETE FROM followers WHERE site_id = ? AND actor_id = ?').run(siteId, actorId)
  }

  removeFollowersByInbox(inbox: string): number {
    return Number(this.db.prepare('DELETE FROM followers WHERE inbox = ? OR shared_inbox = ?').run(inbox, inbox).changes)
  }

  listFollowers(siteId: string, { offset, limit }: Page): Follower[] {
    return this.db
      .prepare('SELECT actor_id, inbox, shared_inbox FROM followers WHERE site_id = ? ORDER BY created_at, actor_id LIMIT ? OFFSET ?')
      .all(siteId, limit, offset)
      .map(toFollower)
  }

  countFollowers(siteId: string): number {
    return Number(this.db.prepare('SELECT count(*) AS n FROM followers WHERE site_id = ?').get(siteId)!.n)
  }

  listPosts(siteId: string): PostRow[] {
    return this.db.prepare('SELECT * FROM posts WHERE site_id = ?').all(siteId).map(toPost)
  }

  getPostBySlug(siteId: string, slug: string): PostRow | undefined {
    const row = this.db.prepare('SELECT * FROM posts WHERE site_id = ? AND slug = ?').get(siteId, slug)
    return row ? toPost(row) : undefined
  }

  listPublishedPosts(siteId: string, { offset, limit }: Page): PostRow[] {
    return this.db
      .prepare('SELECT * FROM posts WHERE site_id = ? AND deleted_at IS NULL ORDER BY published DESC, entry_id LIMIT ? OFFSET ?')
      .all(siteId, limit, offset)
      .map(toPost)
  }

  countPublishedPosts(siteId: string): number {
    return Number(this.db.prepare('SELECT count(*) AS n FROM posts WHERE site_id = ? AND deleted_at IS NULL').get(siteId)!.n)
  }

  applyChanges(siteId: string, changes: Changes, now: Date = new Date()): number {
    const taken = new Set(this.listPosts(siteId).map((p) => p.slug))
    const insert = this.db.prepare(
      `INSERT INTO posts (site_id, entry_id, slug, title, summary, html, url, published, updated, content_hash, pending_activity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const update = this.db.prepare(
      `UPDATE posts SET title = ?, summary = ?, html = ?, url = ?, published = ?, updated = ?, content_hash = ?,
         pending_activity = CASE WHEN pending_activity = 'Create' THEN 'Create' ELSE 'Update' END
       WHERE site_id = ? AND entry_id = ?`,
    )
    const remove = this.db.prepare(
      `UPDATE posts SET deleted_at = ?, pending_activity = 'Delete' WHERE site_id = ? AND entry_id = ?`,
    )

    const fanOut = this.db.prepare(
      `INSERT OR IGNORE INTO email_deliveries (site_id, entry_id, subscriber_id, next_attempt_at)
       SELECT site_id, ?, id, ? FROM subscribers WHERE site_id = ? AND status = 'confirmed'`,
    )

    return this.transaction(() => {
      let queued = 0
      for (const e of changes.create) {
        const slug = slugFor(e.url, taken)
        taken.add(slug)
        insert.run(siteId, e.id, slug, e.title, e.summary, e.html, e.url, e.published.toISOString(), e.updated.toISOString(), contentHash(e), changes.silent ? null : 'Create')
        if (!changes.silent) queued += Number(fanOut.run(e.id, now.toISOString(), siteId).changes)
      }
      for (const e of changes.update) {
        update.run(e.title, e.summary, e.html, e.url, e.published.toISOString(), e.updated.toISOString(), contentHash(e), siteId, e.id)
      }
      for (const entryId of changes.delete) remove.run(now.toISOString(), siteId, entryId)
      return queued
    })
  }

  getPost(siteId: string, entryId: string): PostRow | undefined {
    const row = this.db.prepare('SELECT * FROM posts WHERE site_id = ? AND entry_id = ?').get(siteId, entryId)
    return row ? toPost(row) : undefined
  }

  getSubscriber(siteId: string, email: string): Subscriber | undefined {
    const row = this.db.prepare('SELECT * FROM subscribers WHERE site_id = ? AND email = ?').get(siteId, email)
    return row ? toSubscriber(row) : undefined
  }

  getSubscriberById(id: number): Subscriber | undefined {
    const row = this.db.prepare('SELECT * FROM subscribers WHERE id = ?').get(id)
    return row ? toSubscriber(row) : undefined
  }

  savePendingSubscriber(
    siteId: string,
    email: string,
    fields: { confirmTokenHash: string; confirmExpiresAt: string; confirmSentAt: string; unsubscribeToken: string },
  ): Subscriber {
    this.db
      .prepare(
        `INSERT INTO subscribers (site_id, email, status, confirm_token_hash, confirm_expires_at, confirm_sent_at, unsubscribe_token)
         VALUES (?, ?, 'pending', ?, ?, ?, ?)
         ON CONFLICT (site_id, email) DO UPDATE SET
           confirm_token_hash = excluded.confirm_token_hash,
           confirm_expires_at = excluded.confirm_expires_at,
           confirm_sent_at = excluded.confirm_sent_at`,
      )
      .run(siteId, email, fields.confirmTokenHash, fields.confirmExpiresAt, fields.confirmSentAt, fields.unsubscribeToken)
    return this.getSubscriber(siteId, email)!
  }

  confirmSubscriber(siteId: string, confirmTokenHash: string, now: Date): Subscriber | undefined {
    const row = this.db
      .prepare(
        `UPDATE subscribers SET status = 'confirmed', confirm_token_hash = NULL, confirmed_at = ?
         WHERE site_id = ? AND confirm_token_hash = ? AND status = 'pending' AND confirm_expires_at > ?
         RETURNING *`,
      )
      .get(now.toISOString(), siteId, confirmTokenHash, now.toISOString())
    return row ? toSubscriber(row) : undefined
  }

  removeSubscriberByToken(siteId: string, unsubscribeToken: string): boolean {
    return this.transaction(() => {
      const row = this.db
        .prepare('DELETE FROM subscribers WHERE site_id = ? AND unsubscribe_token = ? RETURNING id')
        .get(siteId, unsubscribeToken)
      if (!row) return false
      this.db.prepare('DELETE FROM email_deliveries WHERE subscriber_id = ?').run(row.id)
      return true
    })
  }

  countConfirmedSubscribers(siteId: string): number {
    return Number(this.db.prepare("SELECT count(*) AS n FROM subscribers WHERE site_id = ? AND status = 'confirmed'").get(siteId)!.n)
  }

  countConfirmationsSince(siteId: string, since: Date): number {
    return Number(
      this.db.prepare('SELECT count(*) AS n FROM subscribers WHERE site_id = ? AND confirm_sent_at >= ?').get(siteId, since.toISOString())!.n,
    )
  }

  deleteExpiredPending(now: Date): number {
    return Number(
      this.db.prepare("DELETE FROM subscribers WHERE status = 'pending' AND confirm_expires_at < ?").run(now.toISOString()).changes,
    )
  }

  listDueDeliveries(now: Date, limit: number): EmailDelivery[] {
    return this.db
      .prepare(
        `SELECT d.* FROM email_deliveries d
         JOIN posts p ON p.site_id = d.site_id AND p.entry_id = d.entry_id
         WHERE d.status = 'queued' AND d.next_attempt_at <= ?
         ORDER BY p.published, d.id LIMIT ?`,
      )
      .all(now.toISOString(), limit)
      .map(toDelivery)
  }

  markDeliverySent(id: number, now: Date): void {
    this.db.prepare("UPDATE email_deliveries SET status = 'sent', next_attempt_at = ?, last_error = NULL WHERE id = ?").run(now.toISOString(), id)
  }

  markDeliveryRetry(id: number, attempts: number, nextAttemptAt: Date, error: string): void {
    this.db
      .prepare('UPDATE email_deliveries SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?')
      .run(attempts, nextAttemptAt.toISOString(), error, id)
  }

  markDeliveryFailed(id: number, attempts: number, error: string): void {
    this.db.prepare("UPDATE email_deliveries SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?").run(attempts, error, id)
  }

  deleteDelivery(id: number): void {
    this.db.prepare('DELETE FROM email_deliveries WHERE id = ?').run(id)
  }

  listPending(siteId: string): PostRow[] {
    return this.db
      .prepare('SELECT * FROM posts WHERE site_id = ? AND pending_activity IS NOT NULL ORDER BY published, entry_id')
      .all(siteId)
      .map(toPost)
  }

  clearPending(siteId: string, entryId: string): void {
    this.db.prepare('UPDATE posts SET pending_activity = NULL WHERE site_id = ? AND entry_id = ?').run(siteId, entryId)
  }
}
