# warmhole: email subscriptions (design addendum)

warmhole already turns a static site's feed into a fediverse account. This
adds the second way out: people subscribe with their email address and get an
email each time a new post is published.

Builds on [`2026-10-15-warmhole-design.md`](2026-10-15-warmhole-design.md).
Mockups from the brainstorm: `.superpowers/brainstorm/` (not committed).

## Why

warmhole should be *the* server for publishing updates from a static site.
Plenty of readers don't use the fediverse; email reaches them. The owner
publishes exactly as today (deploy, ping sync) and both channels follow.

## Goal and success criteria

- A reader enters their email in a form at the bottom of a post on
  `innermonologue.nbaglivo.dev`, clicks the confirmation link, and from then on
  gets an email for each new post: title, date, a short excerpt, a link to the
  post.
- Each site has its own subscriber list and its own From address. Both of
  Nico's blogs (The Open Inner Monologue, Engineering ideas and projects) send
  the same-looking email, only the site name changes.
- **Failures are isolated.** Email failing (one recipient, all recipients, or
  SMTP being down) never affects fediverse delivery or the sync response.
  Fediverse failing never affects email. One email failing never affects any
  other email. Every failure is logged with enough detail to act on.

### Non-goals (for now)

- Full post content in the email (excerpt + link only).
- Owner-editable templates. Likely later; keep rendering in one module so it
  can be swapped, but don't build template loading now.
- A subscriber admin UI, list export or import. The owner sees a subscriber
  count in the logs and nothing more.
- Emails for edits or deletions.
- Digests, scheduling, open/click tracking. No tracking pixels, no link
  rewriting, ever.
- Bounce processing (reading bounce mail). Not needed at this scale.
- The reader API (2026-10-16 spec). Comes later; this builds on current `main`.

### Anti-goals

- Sending someone mail they didn't confirm.
- Sending the whole archive when email is first turned on.
- Sending the same post twice to the same person on a re-sync.
- Email becoming the reason the fediverse side breaks, or vice versa.

## Decisions

| Topic | Decision |
|---|---|
| Opt-in | Double opt-in. Subscribe → confirmation email → link → subscribed. Link expires after 48 hours. |
| Signup form | Plain HTML form on the static site posting to warmhole. No JavaScript required. Hidden honeypot field rejects bots. |
| After submit / confirm / unsubscribe | warmhole redirects (303) to pages the site owner hosts: check-your-inbox, confirmed, unsubscribed. URLs per site in config. |
| What triggers an email | Only a post that is *new* in a sync that is not the site's first sync (the same rule that triggers `Create` on the fediverse side). Not edits, not deletions, not the silent first sync, not a re-sync. |
| Email content | Site name, post title, date, short excerpt, "Keep reading →" link to the post, footer with why you got it and an unsubscribe link. HTML plus a plain-text part. |
| Look | nbaglivo.dev style (see "Email design"). Same for all sites; only the site name changes. |
| Unsubscribe | Link in every email, no login. It opens a small warmhole page (email style) with one "Unsubscribe" button; only the button's POST removes the subscriber, so link scanners can't unsubscribe anyone. Also `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers so Gmail/Apple Mail's built-in button works. |
| Transport | Plain SMTP via `nodemailer`. Migadu to start (port 587, STARTTLS). Switching provider (Postmark, Resend, SES) is a config change only. |
| SMTP config | One SMTP account for the instance; each site sets its own From address. |
| Owner visibility | Subscriber count logged on every subscribe confirmation and unsubscribe, and with each post fan-out. |
| Language | English strings, hard-coded in the rendering module. |

### Why not run our own mail server

Hetzner Cloud blocks outbound 25/465 for new accounts and fresh IPs land in
spam. Submitting to a provider over 587 is unaffected. Migadu's terms and daily
outgoing caps suit a small list; if the list grows, move to a transactional
provider by changing `smtp` in config.

## Architecture

Email is a second, independent outbox next to Fedify's queue. The sync writes
work for both in the same transaction, then each side drains on its own.

```
CI ─ping─▶ sync ─▶ feed ─▶ diff ─▶ one transaction:
                                    ├─ posts (pending_activity)      ─▶ Fedify queue ─▶ followers
                                    └─ email_deliveries (one per     ─▶ email worker ─▶ SMTP ─▶ inboxes
                                        confirmed subscriber)

site form ─POST─▶ /sites/{id}/subscribe ─▶ subscribers (pending) ─▶ confirmation email (direct send)
email link ─GET─▶ /sites/{id}/confirm    ─▶ subscribers (confirmed)
email link ─GET─▶ /sites/{id}/unsubscribe ─▶ page with button ─POST─▶ subscriber removed
```

### Units (new or changed)

| Unit | Does | Depends on |
|---|---|---|
| `config` (changed) | Parses top-level `smtp` and per-site `email`. | nothing |
| `store` (changed) | `subscribers` and `email_deliveries` tables; fan-out inside `applyChanges`. | `node:sqlite` |
| `mail` (new) | `Mailer` interface `{ send(message): Promise<void> }`; nodemailer SMTP implementation; a fake for tests. Classifies errors as temporary or permanent. | `nodemailer` |
| `emails` (new) | Pure rendering: confirmation and new-post messages (subject, HTML, text, headers) from site + post + links, plus the two small warmhole pages (expired link, unsubscribe button). Excerpt extraction. Only place the look lives. | nothing |
| `subscriptions` (new) | Subscribe, confirm, unsubscribe logic: validation, tokens, throttling, sending confirmations, logging counts. | `store`, `mail`, `emails` |
| `email-worker` (new) | Background loop draining `email_deliveries` with retries. | `store`, `mail`, `emails` |
| `sync` (changed) | Logs the email fan-out before the fediverse hand-off; on success returns `emails` (delivery rows queued) alongside `new/updated/deleted`. | as before |
| `app` (changed) | Subscribe, confirm, unsubscribe routes. | `subscriptions` |
| `logview` (changed) | Short lines for the new log messages. | nothing |

Email is optional per site: a site without `email` in config has none of the
routes (404) and no fan-out. If no site has `email`, `smtp` isn't required and
the worker doesn't start.

## Data

| Table | Columns | Purpose |
|---|---|---|
| `subscribers` | `id` (integer PK), `site_id`, `email` (lowercased), `status` (`pending` \| `confirmed`), `confirm_token_hash`, `confirm_expires_at`, `confirm_sent_at`, `unsubscribe_token`, `created_at`, `confirmed_at` | One row per address per site. `UNIQUE (site_id, email)`. |
| `email_deliveries` | `id` (integer PK), `site_id`, `entry_id`, `subscriber_id`, `status` (`queued` \| `sent` \| `failed`), `attempts`, `next_attempt_at`, `last_error`, `created_at`, `sent_at` | The email outbox. `UNIQUE (site_id, entry_id, subscriber_id)` makes duplicates impossible. |

- Confirmation tokens: 32 random bytes, base64url in the link, SHA-256 stored.
- Unsubscribe tokens: 32 random bytes, created at subscribe time, stored as-is
  (it's embedded in every email, so it has to be recoverable; the DB already
  holds private keys and is treated as secret).
- Unsubscribing deletes the subscriber row and their queued deliveries.
- Pending rows whose confirmation has expired are deleted by the worker's loop
  (any cadence, e.g. hourly).

## Flows

### Subscribe

`POST /sites/{siteId}/subscribe`, `application/x-www-form-urlencoded`, fields
`email` and honeypot `website`.

1. Honeypot filled → redirect to check-inbox as if it worked; nothing stored.
2. Email fails a basic syntax check (one `@`, a dot in the domain, ≤ 254
   chars) → redirect to check-inbox with `?error=invalid` appended so the page
   can show a message if it wants.
3. Already confirmed → redirect to check-inbox; send nothing (don't reveal
   whether an address is subscribed, don't spam).
4. New or pending → upsert as pending with a fresh confirmation token and
   expiry, send the confirmation email directly (not via the outbox), redirect
   to check-inbox.
5. Throttles: at most one confirmation email per address per 10 minutes, and at
   most 30 confirmation emails per site per hour. Over a limit → redirect to
   check-inbox, send nothing, log a warning.
6. If the confirmation send fails, still redirect to check-inbox and log an
   error with the reason. The reader can resubmit after the throttle window.

The response is always the same redirect so the form can't be used to probe
the list.

### Confirm

`GET /sites/{siteId}/confirm?token=…`

- Valid, unexpired → status `confirmed`, clear the token, redirect to the
  site's confirmed page, log `{site}: new subscriber, {count} subscribers`.
- Already confirmed via this link (token cleared) or invalid/expired → a small
  warmhole-rendered page in the email style: "This link has expired or was
  already used." with a link back to the site.

Confirmation by GET is the norm and keeps it one click. Accepted risk: a
corporate link scanner can confirm on someone's behalf; the address still
belongs to someone who asked.

### New post

1. Inside `applyChanges`' transaction, for each created post when the sync
   isn't silent, insert one `email_deliveries` row (`queued`,
   `next_attempt_at = now`) per confirmed subscriber of that site.
2. Sync logs `emailing {post} to {count} subscribers`.
3. The worker sends it. Nothing in the sync request waits on SMTP.

Subscribers who confirm after the sync don't get that post.

### Unsubscribe

- `GET /sites/{siteId}/unsubscribe?token=…` changes nothing. It renders a
  small warmhole page in the email style: "Unsubscribe from {site name}?" and
  one "Unsubscribe" button (a form POSTing to the same URL with the token).
  Link scanners that open the link therefore unsubscribe nobody.
- `POST` from that form removes the subscriber and redirects (303) to the
  site's unsubscribed page. Logs `{site}: subscriber left, {count}
  subscribers`. Unknown token → same redirect (idempotent).
- `POST` with body `List-Unsubscribe=One-Click` (RFC 8058, from Gmail / Apple
  Mail's built-in button) removes the subscriber and returns 200 with an empty
  body.

## Email worker

- One in-process loop. Every ~5 s it takes due `queued` rows (oldest first,
  small batch), sends each, and updates that row. One send at a time; a
  configurable pause between sends (`smtp.pauseMs`, default 1000) to stay
  gentle with Migadu.
- Success → `sent`, `sent_at`.
- Temporary failure (connection errors, timeouts, SMTP 4xx, rate limits) →
  `attempts + 1`, `last_error`, `next_attempt_at` after 1 m, 5 m, 30 m, 2 h,
  6 h, 12 h. After the last one → `failed`.
- Permanent failure: only a 5xx reply to the recipient address (RCPT stage,
  e.g. mailbox doesn't exist) → `failed` immediately. The subscriber stays; the
  owner sees it in the logs. Account-level 5xx (auth failure, sender rejected,
  daily quota) counts as temporary, so a bad password or Migadu's cap never
  wipes out a whole fan-out.
- Every failed attempt logs a warning; a row reaching `failed` logs an error.
  Each line includes site, post slug, masked recipient (`n***@gmail.com`),
  attempt number and the SMTP response.
- Rows left `queued` by a restart are picked up on boot. A crash between SMTP
  accepting and the row being marked `sent` can send one duplicate; accepted.
- If the subscriber or post is gone (unsubscribed, deleted) when a row comes
  due, drop it silently.
- Each row is handled in its own try/catch; nothing one row does can stop the
  loop. The loop itself is guarded so an unexpected error logs and the loop
  carries on at the next tick.

## Isolation

The rules from the success criteria, made concrete:

- **Email never blocks fediverse.** Email rows are written in the same
  transaction as the posts; no SMTP call happens during sync. The worker runs
  separately.
- **Fediverse never blocks email.** Today `flushPending` throws on the first
  failing `sendActivity`, failing the sync with 500. That stays as-is: CI's
  `curl --fail --retry 3` re-pings, the retry finishes the fediverse hand-off,
  and it queues no duplicate emails (the posts are already stored, and
  deliveries are unique per post and subscriber). Because email rows were
  committed before the hand-off, they go out regardless. The
  `emailing {post} to {count} subscribers` line is logged before the hand-off
  so the 500 doesn't hide it.
- **One email never blocks another.** One row per recipient per post, each
  retried on its own schedule.
- **Confirmation emails** are sent directly in the subscribe request; a failure
  there affects only that request and is logged.
- **Startup.** A bad `smtp` config fails startup like any other config error.
  SMTP being unreachable at runtime does not; the worker just retries.

## Email design

Matches nbaglivo.dev (`style.css`). Inline styles, table layout for client
support, max width 42rem (672px), centered.

| Element | Style |
|---|---|
| Background | `#faf8f4` |
| Body text | `#38352f`, IBM Plex Sans → `-apple-system, "Segoe UI", Roboto, sans-serif` fallback, 16.5px / 1.7 |
| Site name (top) | IBM Plex Mono → `ui-monospace, Menlo, monospace`, 12.5px, `#726d62` |
| Post title | 30px, weight 300, letter-spacing -.01em, `#38352f` |
| Date | Mono, 12.5px, `#8a857b`, format `3 Nov 2026` |
| Links | `#38352f`, no underline, `border-bottom: 2px dotted #cfc7b8`, weight 500 |
| Confirm button | `#38352f` background, `#faf8f4` text, 10px 18px padding, square corners |
| Footer | 14px / 1.7, `#6f6a60`, `border-top: 1px solid #ebe6dc`, 52px above |

Web fonts: reference IBM Plex from nbaglivo.dev via `@font-face` in a
`<style>` block for clients that allow it; everyone else gets the fallbacks.

New-post email: Subject = post title. From = site's `from`. Body: site name,
title, date, excerpt, "Keep reading →" (post URL), footer "You're getting this
because you subscribed at {site domain}. Unsubscribe".

Confirmation email: Subject "Confirm your subscription to {site name}". Body:
site name, "One click and you're in", "Someone (hopefully you) asked to get
new posts from {site name} by email.", button "Confirm my subscription",
footer "If this wasn't you, ignore this email and nothing happens. The link
expires in 48 hours."

### Excerpt

The feed entry's `summary` with HTML stripped; if empty, the text of `html`.
Collapse whitespace, cut to ~280 characters at a word boundary, append `…` if
cut.

## Configuration

```json
{
  "publicUrl": "https://ap.nbaglivo.dev",
  "smtp": {
    "host": "smtp.migadu.com",
    "port": 587,
    "userEnv": "SMTP_USER",
    "passwordEnv": "SMTP_PASSWORD",
    "pauseMs": 1000
  },
  "sites": [
    {
      "id": "inner-monologue",
      "name": "The Open Inner Monologue",
      "email": {
        "from": "The Open Inner Monologue <nico@nbaglivo.dev>",
        "checkInboxUrl": "https://innermonologue.nbaglivo.dev/subscribe/check-your-inbox/",
        "confirmedUrl": "https://innermonologue.nbaglivo.dev/subscribe/confirmed/",
        "unsubscribedUrl": "https://innermonologue.nbaglivo.dev/subscribe/unsubscribed/"
      }
    }
  ]
}
```

(Other site fields as today.) Port 465 implies implicit TLS; anything else uses
STARTTLS and requires it. The page URLs must be HTTPS. `from` must parse as an
address; its domain must be one the SMTP account may send for (Migadu: SPF and
DKIM set up for it) — not checked by warmhole, documented in the README.

### Site setup

1. Create the three pages on the site.
2. Add the form:

```html
<form method="post" action="https://ap.nbaglivo.dev/sites/inner-monologue/subscribe">
  <input type="email" name="email" required placeholder="you@example.com">
  <input type="text" name="website" tabindex="-1" autocomplete="off" hidden>
  <button>Subscribe</button>
</form>
```

## Logs

New messages, all through LogTape under `['warmhole', 'email']`, and short
`logview` lines for each:

- `{site}: new subscriber, {count} subscribers`
- `{site}: subscriber left, {count} subscribers`
- `{site}: emailing {post} to {count} subscribers`
- `{site}: emailed {post} to {recipient}` (info)
- `{site}: email of {post} to {recipient} failed (attempt {n}): {reason}` (warning)
- `{site}: gave up emailing {post} to {recipient}: {reason}` (error)
- `{site}: confirmation to {recipient} failed: {reason}` (error)
- `{site}: subscribe throttled for {recipient}` (warning)

Recipients are always masked.

## Testing

- **Unit:** config parsing for `smtp`/`email`; excerpt extraction; rendering
  (subject, headers, links, unsubscribe header, text part); error
  classification; throttling.
- **Integration (fake `Mailer`, in-memory SQLite):** subscribe → confirm → sync
  a new post → one delivery per confirmed subscriber; first sync sends no
  emails; re-sync and edits send no emails; unsubscribe removes queued rows;
  honeypot and invalid input; expired token page.
- **Isolation:** Fedify `sendActivity` throwing still leaves email rows queued
  and sent; the fake mailer failing for one recipient leaves the others sent;
  the mailer failing for everyone leaves the fediverse side and sync response
  untouched; temporary vs permanent failure scheduling.
- **Manual before release:** real send through Migadu to Gmail and Apple Mail;
  check rendering, SPF/DKIM pass, and the built-in unsubscribe button.

## Left to the builder

- Exact table/index layout beyond the columns above, and the migration
  mechanics (current schema uses `CREATE TABLE IF NOT EXISTS`; new tables fit
  that).
- Worker tick, batch size, cleanup cadence.
- Exact HTML/table markup of the emails within the style table above.
- README and `warmhole.example.json` / `.env.example` updates.

## Calls made without asking

- Redirect targets are site-owned pages (confirmed by Nico); the
  expired/invalid-link page is warmhole-rendered.
- Confirm by GET (one click).
- One SMTP account per instance, From per site.
- Throttles: 1 confirmation / address / 10 min, 30 / site / hour.
- Retry schedule and permanent-failure handling; no automatic removal of
  addresses that bounce.
- Unsubscribe deletes the row rather than keeping a record.
- Masked recipients in logs.
- `nodemailer` as the SMTP library.
- Sync still answers 500 when the fediverse hand-off fails; email is unaffected and CI's retry is safe.
- Only recipient-level 5xx is a permanent email failure.
