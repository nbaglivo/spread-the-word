# Email Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Readers subscribe by email (double opt-in) on a site and get an email with an excerpt and link for each new post, fully isolated from fediverse delivery.

**Architecture:** Sync writes one `email_deliveries` row per confirmed subscriber per new post inside the same transaction that writes posts. A separate in-process `EmailWorker` drains that outbox over SMTP with per-row retries, so neither channel can block the other. Subscribe/confirm/unsubscribe are Hono routes backed by a `Subscriptions` service; all email and page markup lives in one pure rendering module.

**Tech Stack:** Node 26 (type stripping, `node:sqlite`, `node:test`), Hono 4, LogTape, `nodemailer` (+ `@types/nodemailer` dev).

**Spec:** `docs/superpowers/specs/2026-11-03-email-subscriptions-design.md`

## Global Constraints

- Builds on current `main`. The reader API (2026-10-16 plan) is out of scope; don't touch it.
- Node 26 via `mise.toml`; erasable-only TypeScript; relative imports with `.ts`; no build step.
- Tests: `node:test` + `node:assert/strict`, colocated `src/*.test.ts`; shared helpers in `test/`. Run all with `npm test`; types with `npm run typecheck`.
- JSON files contain no comments.
- Conventional lowercase commits, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.
- Dates stored as ISO strings (`toISOString()`), like the existing tables.
- Logs: LogTape category `['warmhole', 'email']`; recipients always masked (`n***@gmail.com`).
- Email strings in English, exactly as in the spec ("Keep reading →", "Confirm your subscription to {site name}", etc.).
- No tracking pixels, no link rewriting.
- Confirmation link expiry: 48 h. Throttles: 1 confirmation per address per 10 min; 30 per site per hour.
- Retry delays after failed attempt n: 1 m, 5 m, 30 m, 2 h, 6 h, 12 h; the 7th failed attempt marks the row `failed`.
- Only an SMTP 5xx reply at the recipient (`RCPT TO`) stage is permanent.
- `smtp.port` 465 → implicit TLS; any other port → STARTTLS required. Defaults: port 587, `pauseMs` 1000.

## Review Focus

- **Titles and excerpts with HTML specials or entities** (`Tom & Jerry <3`, `It&#8217;s`): escaped once in HTML (no `&amp;amp;`), decoded to plain characters in the text part and in the excerpt. Test in Task 4.
- **Email address case and whitespace** (` Nico@Example.COM ` then `nico@example.com`): one subscriber row, one confirmation within the throttle window. Test in Task 5.
- **Old or reused confirm link** (re-subscribing replaces the token; clicking a link twice): expired-link page, no crash, status stays correct. Test in Task 5.
- **Subscriber leaves or post is deleted while deliveries are queued**: rows dropped, nothing sent, no error logged. Test in Task 8.
- **Several new posts in one sync**: each confirmed subscriber gets one email per post, oldest post first, and a restart mid-fan-out resumes the queued rows. Test in Task 2 (fan-out) and Task 8 (order and resume).

---

## File Structure

```
src/
  address.ts          (new)  email syntax check, normalize, mask
  config.ts           (mod)  smtp + per-site email config
  store.ts            (mod)  subscribers, email_deliveries, fan-out in applyChanges
  mail.ts             (new)  Mailer interface, MailError, SMTP implementation, error classification
  emails.ts           (new)  pure rendering: excerpt, both emails, two warmhole pages, link builders
  subscriptions.ts    (new)  subscribe / confirm / unsubscribe logic, throttles, logs
  email-worker.ts     (new)  outbox loop with retries and cleanup
  sync.ts             (mod)  emails count, fan-out log before the fediverse hand-off
  app.ts              (mod)  subscribe / confirm / unsubscribe routes
  server.ts           (mod)  wiring
  logview.test.ts     (mod)  short lines for email logs
test/
  fake-mailer.ts      (new)
  fake-remote.ts      (mod)  TEST_CONFIG gains smtp/email fields
README.md, warmhole.example.json, .env.example, .gitignore (mod)
```

---

### Task 1: Config and address helpers

**Files:**
- Create: `src/address.ts`, `src/address.test.ts`
- Modify: `src/config.ts`, `src/config.test.ts`, `test/fake-remote.ts`

**Interfaces:**
- Produces:
  ```ts
  // address.ts
  export function normalizeEmail(raw: string): string          // trim + lowercase
  export function isEmailAddress(value: string): boolean        // one '@', non-empty local, domain with a dot, no spaces/<>, ≤ 254 chars
  export function maskEmail(email: string): string              // 'nico@gmail.com' → 'n***@gmail.com'
  // config.ts
  export type SmtpConfig = { host: string; port: number; user: string; password: string; pauseMs: number }
  export type SiteEmailConfig = { from: string; checkInboxUrl: URL; confirmedUrl: URL; unsubscribedUrl: URL }
  SiteConfig gains: email: SiteEmailConfig | undefined
  Config gains:     smtp: SmtpConfig | undefined
  ```

- [ ] **Step 1: Write failing tests**

`address.test.ts`:
- `normalizeEmail(' Nico@Example.COM ') === 'nico@example.com'`
- `isEmailAddress` true for `a@b.co`; false for `''`, `'a'`, `'a@b'`, `'a@@b.co'`, `'a b@c.co'`, `'<a@b.co>'`, a 255-char address.
- `maskEmail('nico@gmail.com') === 'n***@gmail.com'`, `maskEmail('n@x.dev') === 'n***@x.dev'`.

`config.test.ts` (add):
- `parses smtp and site email`: raw `smtp: { host: 'smtp.migadu.com', userEnv: 'SMTP_USER', passwordEnv: 'SMTP_PASSWORD' }`, site `email: { from: 'Inner <nico@nbaglivo.dev>', checkInboxUrl, confirmedUrl, unsubscribedUrl }` (https URLs), env with both vars → `smtp` deep-equals `{ host: 'smtp.migadu.com', port: 587, user, password, pauseMs: 1000 }`; `sites[0].email.confirmedUrl` is a `URL`.
- `sites without email need no smtp`: existing valid config → `smtp === undefined`, `sites[0].email === undefined`.
- Rejections (`ConfigError`): a site has `email` but no `smtp` (`/smtp is required/`); `smtp.userEnv` env var unset; `smtp.port` `0` or `'587'`; `smtp.pauseMs` `-1`; `email.from` `'not an address'`; `email.confirmedUrl` `http://example.dev/x`.
- `from` accepted both as `nico@nbaglivo.dev` and `Name <nico@nbaglivo.dev>`.

- [ ] **Step 2: Run and confirm they fail** — `npm test` → failures in address/config tests.

- [ ] **Step 3: Implement**

`address.ts` as specified. In `config.ts`, parse `raw.smtp` (optional object: `host` required, `port` integer 1–65535 default 587, `userEnv`/`passwordEnv` required and set in env, `pauseMs` integer ≥ 0 default 1000) and `entry.email` (optional object: `from` required — the address inside `<…>` if present, else the whole value, must pass `isEmailAddress`; three URLs through `secureUrl`). After sites: if any site has `email` and `smtp` is undefined → `ConfigError('smtp is required when a site has email')`. Add `email: undefined` to each site and `smtp: undefined` to `TEST_CONFIG` in `test/fake-remote.ts`.

- [ ] **Step 4: Run** — `npm test && npm run typecheck` → all pass.

- [ ] **Step 5: Commit** — `feat: parse smtp and per-site email config`

---

### Task 2: Store — subscribers, deliveries, fan-out

**Files:**
- Modify: `src/store.ts`, `src/store.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces:
  ```ts
  export type SubscriberStatus = 'pending' | 'confirmed'
  export type Subscriber = {
    id: number; siteId: string; email: string; status: SubscriberStatus
    confirmTokenHash: string | null; confirmExpiresAt: string | null; confirmSentAt: string | null
    unsubscribeToken: string; createdAt: string; confirmedAt: string | null
  }
  export type DeliveryStatus = 'queued' | 'sent' | 'failed'
  export type EmailDelivery = {
    id: number; siteId: string; entryId: string; subscriberId: number; status: DeliveryStatus
    attempts: number; nextAttemptAt: string; lastError: string | null
  }
  // Store methods
  getSubscriber(siteId: string, email: string): Subscriber | undefined
  getSubscriberById(id: number): Subscriber | undefined
  savePendingSubscriber(siteId: string, email: string, fields: { confirmTokenHash: string; confirmExpiresAt: string; confirmSentAt: string; unsubscribeToken: string }): Subscriber
  confirmSubscriber(siteId: string, confirmTokenHash: string, now: Date): Subscriber | undefined
  removeSubscriberByToken(siteId: string, unsubscribeToken: string): boolean
  countConfirmedSubscribers(siteId: string): number
  countConfirmationsSince(siteId: string, since: Date): number
  deleteExpiredPending(now: Date): number
  applyChanges(siteId: string, changes: Changes, now?: Date): number   // now returns email deliveries queued
  getPost(siteId: string, entryId: string): PostRow | undefined
  listDueDeliveries(now: Date, limit: number): EmailDelivery[]
  markDeliverySent(id: number, now: Date): void
  markDeliveryRetry(id: number, attempts: number, nextAttemptAt: Date, error: string): void
  markDeliveryFailed(id: number, attempts: number, error: string): void
  deleteDelivery(id: number): void
  ```

- [ ] **Step 1: Write failing tests** (`store.test.ts`)
- `savePendingSubscriber creates then refreshes a pending row`: second call with new token fields returns the same `id`, new `confirmTokenHash`, **same** `unsubscribeToken` as the first call.
- `confirmSubscriber`: wrong hash → `undefined`; expired (`now` after `confirmExpiresAt`) → `undefined`; valid → status `confirmed`, `confirmTokenHash === null`, `confirmedAt` set; same hash again → `undefined`.
- `countConfirmedSubscribers` counts only confirmed rows for that site.
- `fan-out queues one delivery per confirmed subscriber per new post`: two confirmed + one pending subscriber on `s`, one confirmed on site `other`; `applyChanges('s', { create: [a, b], silent: false })` returns `4`; `listDueDeliveries(now, 10)` has 4 rows, all `queued`, `attempts 0`.
- `silent first sync, updates and deletes queue nothing`: each returns `0`.
- `removeSubscriberByToken` deletes the subscriber and its queued deliveries; returns `false` for unknown token.
- `listDueDeliveries` excludes rows with `nextAttemptAt` in the future and non-`queued` rows; orders by post `published`, then `id`.
- `deleteExpiredPending` removes pending rows past `confirmExpiresAt`, keeps confirmed.
- `countConfirmationsSince` counts rows with `confirmSentAt >= since`.

- [ ] **Step 2: Run and confirm they fail.**

- [ ] **Step 3: Implement**

Add tables to `SCHEMA`:
- `subscribers`: columns per spec, `id INTEGER PRIMARY KEY`, `UNIQUE (site_id, email)`, `unsubscribe_token TEXT NOT NULL UNIQUE`.
- `email_deliveries`: columns per spec, `id INTEGER PRIMARY KEY`, `UNIQUE (site_id, entry_id, subscriber_id)`, index on `(status, next_attempt_at)`.

`savePendingSubscriber`: `INSERT … ON CONFLICT (site_id, email) DO UPDATE SET confirm_* = excluded.confirm_*` (never overwrite `unsubscribe_token`, never touch a confirmed row's status — callers only call it for new/pending). Fan-out: inside the existing transaction, for each created entry when `!changes.silent`, `INSERT OR IGNORE INTO email_deliveries (…) SELECT … FROM subscribers WHERE site_id = ? AND status = 'confirmed'` with `next_attempt_at = now`; sum `changes`. Update existing callers/tests that ignored the old `void` return as needed.

- [ ] **Step 4: Run** — `npm test && npm run typecheck` → pass.

- [ ] **Step 5: Commit** — `feat: store subscribers and queue email deliveries on new posts`

---

### Task 3: Mailer

**Files:**
- Create: `src/mail.ts`, `src/mail.test.ts`, `test/fake-mailer.ts`
- Modify: `package.json` (add `nodemailer`, dev `@types/nodemailer`)

**Interfaces:**
- Consumes: `SmtpConfig`
- Produces:
  ```ts
  export type MailMessage = { from: string; to: string; subject: string; html: string; text: string; headers?: Record<string, string> }
  export interface Mailer { send(message: MailMessage): Promise<void> }
  export class MailError extends Error { name = 'MailError'; permanent: boolean; constructor(message: string, permanent: boolean) }
  export function classifyMailError(error: unknown): MailError
  export function smtpMailer(smtp: SmtpConfig): Mailer
  // test/fake-mailer.ts
  export type FakeMailer = Mailer & { sent: MailMessage[]; failFor(to: string, error: MailError): void; failAll(error: MailError | null): void }
  export function fakeMailer(): FakeMailer
  ```

- [ ] **Step 1: Write failing tests** (`mail.test.ts`, on plain objects shaped like nodemailer errors)
- `{ responseCode: 550, command: 'RCPT TO', response: '550 no such user' }` → `permanent === true`, message includes `550 no such user`.
- `{ responseCode: 535, code: 'EAUTH', command: 'AUTH PLAIN' }` → temporary.
- `{ responseCode: 554, command: 'MAIL FROM' }` → temporary (sender/quota rejection).
- `{ responseCode: 451, command: 'RCPT TO' }` → temporary.
- `{ code: 'ECONNECTION' }`, `{ code: 'ETIMEDOUT' }`, `new Error('boom')`, `'string'` → temporary.
- An existing `MailError` is returned unchanged.

- [ ] **Step 2: Run and confirm they fail.**

- [ ] **Step 3: Implement**

`npm install nodemailer && npm install -D @types/nodemailer`. `classifyMailError`: permanent iff `responseCode` in 500–599 and (`command === 'RCPT TO'` or `code === 'EENVELOPE'`); verify against nodemailer's rejected-recipient error shape and adjust the test fixture if the real field differs. Message = `response ?? message`. `smtpMailer`: `nodemailer.createTransport({ host, port, secure: port === 465, requireTLS: port !== 465, auth: { user, pass } })`; `send` awaits `sendMail` and rethrows via `classifyMailError`. `fakeMailer` records successful sends in `sent` and throws the configured error for matching `to` (or for all).

- [ ] **Step 4: Run** — pass.

- [ ] **Step 5: Commit** — `feat: add smtp mailer with permanent and temporary failures`

---

### Task 4: Rendering

**Files:**
- Create: `src/emails.ts`, `src/emails.test.ts`

**Interfaces:**
- Consumes: `Config`, `SiteConfig`, `PostRow`
- Produces:
  ```ts
  export type RenderedEmail = { subject: string; html: string; text: string }
  export function excerpt(post: { summary: string | null; html: string }, max?: number): string   // default 280
  export function formatDate(iso: string): string                                                 // '3 Nov 2026', UTC
  export function confirmUrl(config: Config, siteId: string, token: string): string               // {publicUrl}/sites/{id}/confirm?token=…
  export function unsubscribeUrl(config: Config, siteId: string, token: string): string           // {publicUrl}/sites/{id}/unsubscribe?token=…
  export function newPostEmail(site: SiteConfig, post: PostRow, unsubscribe: string): RenderedEmail
  export function confirmationEmail(site: SiteConfig, confirm: string): RenderedEmail
  export function expiredLinkPage(site: SiteConfig): string
  export function unsubscribePage(site: SiteConfig, action: string): string
  ```

- [ ] **Step 1: Write failing tests**
- `excerpt`: uses summary when non-empty, else `html`; strips tags; decodes `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`, `&#8217;`, `&#x2019;`, `&nbsp;`; collapses whitespace; text ≤ 280 → unchanged; longer → cut at last space before 280 with `…` appended, result length ≤ 281.
- `formatDate('2026-11-03T23:30:00Z') === '3 Nov 2026'`.
- `newPostEmail` for post titled `Tom & Jerry <3` with summary `It&#8217;s here`: `subject === 'Tom & Jerry <3'`; `html` contains `Tom &amp; Jerry &lt;3` and not `&amp;amp;`; `text` contains `It’s here`, the post URL, `Keep reading`, and the unsubscribe URL; `html` contains the site name, `Keep reading →`, the post URL, `You're getting this because you subscribed at innermonologue.test`, the unsubscribe URL, and `#faf8f4`.
- `confirmationEmail`: `subject === 'Confirm your subscription to The Open Inner Monologue'`; `html` contains `One click and you're in`, `Confirm my subscription`, the confirm URL, `The link expires in 48 hours.`; `text` contains the confirm URL.
- `unsubscribePage` contains `<form method="post" action="{action}">`, a button `Unsubscribe`, and `Unsubscribe from The Open Inner Monologue?`; `expiredLinkPage` contains `This link has expired or was already used.` and a link to `https://innermonologue.test/`.
- `confirmUrl`/`unsubscribeUrl` URL-encode the token.

- [ ] **Step 2: Run and confirm they fail.**

- [ ] **Step 3: Implement**

Exact copy, colors, sizes and fonts from the spec's "Email design" table; table-based, inline styles, 672 px max width, `@font-face` for IBM Plex Sans/Mono pointing at `https://nbaglivo.dev/public/fonts/…` in a `<style>` block. The two pages are full HTML documents in the same look (no email footer). Escape every interpolated value with one `escapeHtml` helper.

- [ ] **Step 4: Run** — pass.

- [ ] **Step 5: Commit** — `feat: render subscription emails and pages in the nbaglivo.dev style`

---

### Task 5: Subscriptions service

**Files:**
- Create: `src/subscriptions.ts`, `src/subscriptions.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 2), `Mailer`/`MailError` (Task 3), `confirmationEmail`, `confirmUrl` (Task 4), `normalizeEmail`/`isEmailAddress`/`maskEmail` (Task 1)
- Produces:
  ```ts
  export type SubscribeOutcome = 'sent' | 'ignored' | 'invalid' | 'throttled' | 'failed'
  export type ConfirmOutcome = 'confirmed' | 'invalid'
  export type SubscriptionsDeps = { config: Config; store: Store; mailer: Mailer; now?: () => Date }
  export class Subscriptions {
    constructor(deps: SubscriptionsDeps)
    subscribe(siteId: string, input: { email: string; website: string }): Promise<SubscribeOutcome>
    confirm(siteId: string, token: string): ConfirmOutcome
    unsubscribe(siteId: string, token: string): boolean
  }
  export function hashToken(token: string): string   // sha256 hex
  ```

- [ ] **Step 1: Write failing tests** (in-memory store, `fakeMailer`, controllable `now`, `captureLogs`; a test config with one email-enabled site)
- honeypot filled → `'ignored'`, no row, nothing sent.
- invalid address → `'invalid'`, nothing sent.
- new address → `'sent'`; one pending row; one mail to the normalized address, `from` = site's `from`, subject `Confirm your subscription to …`, body contains a confirm URL whose token hashes to the stored `confirmTokenHash`.
- ` Nico@Example.COM ` then `nico@example.com` within 10 min → second `'throttled'`, one row, one mail; after 10 min → `'sent'` with a new token; the first link's token now gives `confirm → 'invalid'`.
- already confirmed → `'ignored'`, nothing sent.
- 31st confirmation for the site within an hour (different addresses) → `'throttled'`; warning logged `subscribe throttled for n***@…`.
- mailer throws → `'failed'`; error log line contains `confirmation to` and the masked address; row stays pending.
- `confirm`: valid → `'confirmed'`, log line `inner-monologue: new subscriber, 1 subscribers`; second time → `'invalid'`; after 48 h → `'invalid'`; garbage token → `'invalid'`.
- `unsubscribe`: known token → `true`, log `inner-monologue: subscriber left, 0 subscribers`; unknown → `false`, no log.
- site without `email` → `subscribe` resolves `'ignored'`, `confirm` `'invalid'`, `unsubscribe` `false`.

- [ ] **Step 2: Run and confirm they fail.**

- [ ] **Step 3: Implement**

Tokens `randomBytes(32).toString('base64url')`; store `hashToken(confirmToken)`; reuse the existing `unsubscribeToken` for an existing pending row, else generate one. Per-address throttle uses the existing row's `confirmSentAt`; per-site uses `countConfirmationsSince(now − 1 h) >= 30`. Logger `getLogger(['warmhole', 'email'])`; messages exactly as the spec's "Logs" list.

- [ ] **Step 4: Run** — pass.

- [ ] **Step 5: Commit** — `feat: subscribe, confirm and unsubscribe with throttling`

---

### Task 6: Routes

**Files:**
- Modify: `src/app.ts`, `src/app.test.ts`

**Interfaces:**
- Consumes: `Subscriptions` (Task 5), `expiredLinkPage`, `unsubscribePage`, `unsubscribeUrl` (Task 4)
- Produces: `AppDeps` gains `subscriptions?: Pick<Subscriptions, 'subscribe' | 'confirm' | 'unsubscribe'>`

- [ ] **Step 1: Write failing tests** (stub `subscriptions` recording calls; a site with `email`)
- `POST /sites/inner-monologue/subscribe` form `email=a@b.co&website=` → `303`, `location` = `checkInboxUrl`; stub called with `{ email: 'a@b.co', website: '' }`. Outcome `'invalid'` → location has `error=invalid` added to the URL's query. Outcomes `sent|ignored|throttled|failed` → plain `checkInboxUrl`.
- Missing `website` field is passed as `''`.
- Site without `email`, unknown site, or no `subscriptions` dep → `404` for all three routes.
- `GET /confirm?token=t` → `'confirmed'` → `303` to `confirmedUrl`; `'invalid'` or missing token → `410`, HTML body from `expiredLinkPage`.
- `GET /unsubscribe?token=t` → `200` HTML with a form posting to `unsubscribeUrl(config, id, 't')`; stub **not** called. Missing token → `410` expired page.
- `POST /unsubscribe?token=t` with form body `List-Unsubscribe=One-Click` → `200`, empty body, stub called; with an empty body → `303` to `unsubscribedUrl`, stub called (also when it returns `false`).
- Routes resolve before the Fedify middleware (existing webfinger/sync tests still pass).

- [ ] **Step 2: Run and confirm they fail.**

- [ ] **Step 3: Implement** — routes in `buildApp` above `app.use(fedifyMiddleware…)`, using `c.req.parseBody()`.

- [ ] **Step 4: Run** — pass.

- [ ] **Step 5: Commit** — `feat: add subscribe, confirm and unsubscribe routes`

---

### Task 7: Sync reports and logs email fan-out

**Files:**
- Modify: `src/sync.ts`, `src/sync.test.ts`, `src/app.test.ts` (sync stub shape)

**Interfaces:**
- Consumes: `applyChanges(...): number`, `countConfirmedSubscribers` (Task 2)
- Produces: `SyncResult = { new: number; updated: number; deleted: number; emails: number }`

- [ ] **Step 1: Write failing tests** (`sync.test.ts`; config with email on the site; confirmed subscribers inserted via the store)
- Existing assertions gain `emails: 0`.
- `new posts queue emails and report them`: 2 confirmed subscribers, first sync `[a]`, then `[a, b]` → `{ new: 1, updated: 0, deleted: 0, emails: 2 }`; log line `inner-monologue: emailing "Title b" to 2 subscribers`.
- `edits and re-syncs queue no emails` → `emails: 0`.
- `fediverse hand-off failing still leaves emails queued`: a `federation` whose context's `sendActivity` throws → `sync` rejects; `store.listDueDeliveries(now, 10).length === 2`; the `emailing …` log line was written. A retry with a working federation returns `emails: 0` and the queue still has exactly 2 rows.

- [ ] **Step 2: Run and confirm they fail.**

- [ ] **Step 3: Implement** — take the count from `applyChanges`; when `> 0`, for each created entry log `{site}: emailing "{title}" to {count} subscribers` with `count = countConfirmedSubscribers(siteId)` **before** `flushPending`. Include `emails` in the result and the existing sync log line.

- [ ] **Step 4: Run** — pass.

- [ ] **Step 5: Commit** — `feat: queue emails during sync independently of the fediverse`

---

### Task 8: Email worker

**Files:**
- Create: `src/email-worker.ts`, `src/email-worker.test.ts`

**Interfaces:**
- Consumes: `Store` delivery methods (Task 2), `Mailer`/`MailError` (Task 3), `newPostEmail`, `unsubscribeUrl` (Task 4), `maskEmail`
- Produces:
  ```ts
  export const RETRY_DELAYS_MS: readonly number[]   // [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000]
  export type EmailWorkerDeps = { config: Config; store: Store; mailer: Mailer; now?: () => Date; sleep?: (ms: number) => Promise<void> }
  export class EmailWorker {
    constructor(deps: EmailWorkerDeps)
    tick(): Promise<number>          // processes up to 20 due rows; returns rows handled
    start(intervalMs?: number): void // default 5000; never overlaps ticks
    stop(): Promise<void>            // waits for a running tick
  }
  ```

- [ ] **Step 1: Write failing tests** (in-memory store, fake mailer, fake clock, `sleep` stub recording pauses)
- `sends queued deliveries`: 2 subscribers, 1 new post → `tick()` returns 2; 2 mails with subject = post title, `from` = site's `from`, headers `List-Unsubscribe: <{unsubscribeUrl}>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`; rows `sent`; `sleep` called with `smtp.pauseMs` between sends (once for 2 sends).
- `one recipient failing doesn't stop the others`: `failFor(a, temporary)` → b's row `sent`, a's row `queued`, `attempts 1`, `nextAttemptAt = now + 1 m`, warning log contains masked address and `attempt 1`.
- `retry schedule then gives up`: advance the clock past each delay; after attempt 7 fails the row is `failed` and an error log `gave up emailing` is written; further ticks don't touch it.
- `permanent failure gives up immediately`: `failFor(a, new MailError('550 no such user', true))` → `failed` after one attempt.
- `everyone failing (SMTP down)` → all rows `queued` with `attempts 1`; `tick` resolves (doesn't throw).
- `gone subscriber or deleted post`: unsubscribe one subscriber and soft-delete the post for another row before `tick` → those rows removed, nothing sent, no warning/error logs.
- `oldest post first and resume after restart`: 2 new posts in one sync, a new `EmailWorker` instance (simulated restart) → mails for the older post come before the newer one.
- `site no longer has email in config`: rows for that site are removed without sending.
- `cleanup`: a pending subscriber past expiry is removed by `tick` (no more than once per hour).
- `a throwing store or mailer bug inside one row is contained`: mailer throwing a non-`MailError` → treated as temporary, loop continues.

- [ ] **Step 2: Run and confirm they fail.**

- [ ] **Step 3: Implement** — per-row try/catch; `classifyMailError` on unknown errors; log messages exactly as the spec's "Logs" list; `start` uses a `setTimeout` chain with the tick wrapped in try/catch that logs and continues.

- [ ] **Step 4: Run** — pass.

- [ ] **Step 5: Commit** — `feat: deliver queued emails with retries in a background worker`

---

### Task 9: Wiring, logs view and docs

**Files:**
- Modify: `src/server.ts`, `src/logview.test.ts`, `README.md`, `warmhole.example.json`, `.env.example`, `.gitignore`

- [ ] **Step 1: Write failing logview tests** — `describeLine` on INFO `inner-monologue: new subscriber, 3 subscribers` → `12:43:49 inner-monologue: new subscriber, 3 subscribers`; WARN `inner-monologue: email of "Title b" to n***@gmail.com failed (attempt 2): 421 try later` → line prefixed `WARN ` with quotes stripped. Change `logview.ts` only if these fail.

- [ ] **Step 2: Wire `server.ts`** — when `config.smtp`: `mailer = smtpMailer(config.smtp)`, `subscriptions = new Subscriptions(...)`, `worker = new EmailWorker(...)`, `worker.start()`; pass `subscriptions` to `buildApp`. Log `email enabled for {sites}` at startup with each site's confirmed count (`{site}: {count} subscribers`).

- [ ] **Step 3: Docs** — README "Email subscriptions" section: SMTP config (Migadu, port 587), SPF/DKIM for the From domain, the three site pages, the form HTML from the spec, what triggers an email. `warmhole.example.json`: add `smtp` and a site `email` block. `.env.example`: `SMTP_USER`, `SMTP_PASSWORD`. `.gitignore`: `.superpowers/`.

- [ ] **Step 4: Verify** — `npm test && npm run typecheck` → pass. Then run locally with a config that has `email` and a throwaway SMTP (e.g. `npx smtp4dev` or Migadu): subscribe through `curl -i -d 'email=…&website=' …/subscribe`, confirm via the logged/received link, ping sync with a new post, see the email and the `scripts/logs` lines.

- [ ] **Step 5: Commit** — `feat: wire email subscriptions into the server and document setup`

---

**Manual before release** (from the spec): real send through Migadu to Gmail and Apple Mail; check rendering, SPF/DKIM pass, and the built-in unsubscribe button.
