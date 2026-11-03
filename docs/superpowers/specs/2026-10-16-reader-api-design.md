# warmhole: reading the fediverse (design addendum)

warmhole v1 speaks outward: a site's feed becomes an account others follow.
This addendum lets the same account listen. The site follows other fediverse
accounts, keeps what they post, and hands it to one private reader over HTTP.

The first reader is Coffee Companion (in `nmail`), a Go program that composes a
calm, newspaper-like edition every morning from email newsletters and the new
posts of accounts the user follows. It asks warmhole "what arrived since
yesterday's edition?" and renders each post without fetching anything else.

Builds on [the v1 design](2026-10-15-warmhole-design.md); everything there
still holds unless this document says otherwise. The API contract is
[`docs/reader-api.openapi.json`](../../reader-api.openapi.json).

## Goal and success criteria

- `@nico@innermonologue.nbaglivo.dev` follows `@alice@mastodon.social` with one
  API call. Alice posts, and within a minute the post is returned by
  `GET /reader/v1/sites/inner-monologue/items`, with author, content and media
  ready to print.
- Coffee Companion can build a morning edition from one paged request
  sequence, never sees an item twice, and never misses one because something
  arrived while it was paging.
- A site without a reader token behaves exactly like v1.

## Decisions

| Topic | Decision |
|---|---|
| Who reads | One private reader per site, authenticated with a per-site bearer token (`readerTokenEnv`). No users, no OAuth, no Mastodon client API. |
| Following | Through the reader API only, by handle (WebFinger) or actor URL. Signed `Follow`, `Undo(Follow)` to unfollow. State `pending` → `accepted` / `rejected` from the remote server's `Accept` / `Reject`. |
| Who is kept | Only accounts the site follows with state `accepted`. Pending follows don't count; everything from everyone else is still verified, answered with 202 and dropped, as in v1. |
| What is kept | `Create` of `Note`, `Article`, `Page`, `Question`, `Image`, `Video`, `Audio`. `Update` and `Delete` from the item's author. |
| Boosts | Kept. The boosted post becomes an item with `boost` naming the booster; the post's own author stays `author`. `Undo(Announce)` removes it. |
| Visibility | Public, unlisted and followers-only posts are kept and labelled. Direct messages are dropped. |
| Replies and mentions | Replies from followed accounts are kept, with `in_reply_to`; the parent isn't fetched. Mentions of the site from accounts it doesn't follow are dropped, as in v1. |
| Dedup | One item per `(site, object id)`. Redelivery, a second boost, or a boost of something already received never adds a second item. |
| Order and paging | Arrival order, keyset paging on an internal sequence number, opaque cursors. Stable under inserts. `since`/`until` filter on `received_at`. |
| Content | HTML sanitized on arrival with a fixed allowlist, plus a plain-text rendering. Readers can trust `content_html` as is. |
| Media | Attachment metadata and remote URLs only. No downloading, resizing or proxying. |
| Retention | Items pruned by `received_at` after `retentionDays` (per site, default 30). |
| API namespace | `/reader/v1/...`, mounted before Fedify. |
| Following collection | Not published. Who the site reads stays private; the actor doesn't advertise a `following` collection. |

### Out of scope

A Mastodon-compatible client API, OAuth, more than one reader token per site,
fetching reply parents or whole threads, poll options and results, custom emoji
images, link preview cards, quote posts, `Event` objects, media proxying or
caching, `Move` (account migration; logged and ignored), `Like` and `Flag`
handling, notifications, posting or replying from the site (the feed stays the
only way to publish), muting and blocking, full-text search, a push or
streaming API, importing a follow list.

### Why our own API and not the Mastodon client API

ActivityPub has two halves. Server-to-server federation is what every
fediverse server speaks, and it's what warmhole uses to follow accounts and
receive their posts. Client-to-server (C2S), the standard's own way for apps to
read and post, is barely implemented anywhere.

Apps read through the Mastodon client API instead. It isn't part of any
standard; it's Mastodon's own REST API. It became the de facto default because
the popular apps (Ivory, Tusky, Elk, Phanpy) are built on it, and Pleroma,
Akkoma, GoToSocial, Pixelfed, Friendica, snac and others implement a
compatible subset so those apps work with them.

warmhole has a small API of its own instead:

- **One known reader.** Coffee Companion is the only client. A
  Mastodon-compatible API would mean OAuth apps, accounts, home timelines,
  statuses and notifications, and existing apps expect most of it to be
  there. A half-built version fails in confusing ways.
- **Shaped for the reader.** Paging in arrival order with stable cursors, and
  HTML that has already been sanitized and is ready to print, plus a
  plain-text version. Nothing else to fetch.
- **Smaller attack surface.** One bearer token per site, five routes.

The cost: Mastodon apps can't open this timeline. If that's wanted later, a
Mastodon-compatible layer can sit on top of the same `items` and `following`
tables, without changing the federation side.

## Architecture

The v1 container, with two more paths through it.

```
reader ──bearer──▶ Reader API ─┬─▶ SQLite (items, following, actors)
                               └─▶ Follows ──signed Follow / Undo──▶ followed servers

followed servers ──signed Create / Update / Delete / Announce / Accept / Reject──▶ Fedify inbox ─▶ Receive ─▶ SQLite
```

### Units

New units, and v1 units that change.

| Unit | Does | Depends on |
|---|---|---|
| `config` (changed) | Also reads `readerTokenEnv` and `retentionDays`. | nothing |
| `content` | Pure: sanitizes remote HTML with the allowlist, renders HTML to plain text. | `sanitize-html`, `htmlparser2` |
| `objects` | Turns a Fedify vocab object into an `ItemDraft`: type, url, title, summary, sanitized content, language, visibility, attachments, hashtags, mentions. | `content`, Fedify vocab |
| `store` (changed) | Adds `actors`, `following` and `items` tables, keyset listing and pruning. | `node:sqlite` |
| `actors` | Builds an actor cache row from a Fedify actor, including the WebFinger-confirmed handle; refreshes rows older than a day. | Fedify, `store` |
| `following` | Resolves an account, sends `Follow` and `Undo(Follow)`, keeps `following` rows. | Fedify, `store`, `actors` |
| `receive` | Inbox handlers for `Accept`, `Reject`, `Create`, `Update`, `Delete`, `Announce`, `Undo(Announce)`. Applies the inbound rules below. | Fedify, `store`, `actors`, `objects` |
| `federation` (changed) | Registers the new listeners next to the v1 `Follow` / `Undo(Follow)` ones. | `receive` |
| `reader` | Hono sub-app: the reader API, its auth, limits, cursors and JSON shapes. | `store`, `following` |
| `retention` | Prunes expired items and unused actor rows, hourly and at start. | `store` |
| `app` (changed) | Mounts `reader` at `/reader/v1`; adds body limits on inboxes. | `reader` |

## Data

New tables in the same SQLite file. v1 tables are unchanged.

| Table | Columns | Purpose |
|---|---|---|
| `actors` | `id` (PK), `handle`, `name`, `avatar_url`, `profile_url`, `inbox`, `shared_inbox`, `followers_url`, `fetched_at` | Cache of remote actors that are followed, authors of items, or boosters. Shared by all sites (it's public data). `followers_url` decides followers-only visibility; `inbox` and `shared_inbox` address `Undo(Follow)`. |
| `following` | `site_id`, `actor_id`, `state` (`pending`, `accepted`, `rejected`), `follow_id` (unique), `created_at`, `state_changed_at` | Who each site follows. PK `(site_id, actor_id)`. `follow_id` is the id of the last `Follow` sent, matched against incoming `Accept` / `Reject`. |
| `items` | `seq` (`INTEGER PRIMARY KEY AUTOINCREMENT`), `site_id`, `object_id`, `type`, `url`, `author_id`, `visibility`, `published`, `updated`, `title`, `summary`, `sensitive`, `content_html`, `content_text`, `language`, `in_reply_to`, `attachments`, `hashtags`, `mentions` (JSON arrays), `boost_actor_id`, `boost_activity_id`, `boosted_at`, `received_at`, `deleted_at` | What arrived. `UNIQUE (site_id, object_id)`. A row with `deleted_at` set is a tombstone: content columns are emptied, it's never listed, and it stops a late or replayed `Create` from bringing the post back. |

Indexes: `items (site_id, seq)` for listing, `items (site_id, received_at)` for
pruning, `items (author_id)` for author deletes, `items (boost_activity_id)`
(partial, non-null) for `Undo(Announce)`.

`seq` uses `AUTOINCREMENT` so a number is never reused after pruning: cursors
stay valid forever, and a cursor from before a prune simply continues with
what's left. All timestamps are ISO 8601 UTC strings with milliseconds, as in
v1.

Followers-only posts now live in the database, so the backup advice of v1
applies twice: the file holds private keys and private posts.

## URLs

Added to the v1 table, all on `publicUrl`:

| Path | Served by |
|---|---|
| `GET /reader/v1/sites/{siteId}/items` | Hono, reader token |
| `GET /reader/v1/sites/{siteId}/items/lookup?id=` | Hono, reader token |
| `GET /reader/v1/sites/{siteId}/following` | Hono, reader token |
| `POST /reader/v1/sites/{siteId}/following` | Hono, reader token |
| `DELETE /reader/v1/sites/{siteId}/following?account=` | Hono, reader token |

### Why `/reader/v1`

- It can't collide with Fedify: Fedify owns `/users/...`, `/inbox` and
  `/.well-known/*` here, and would own `/nodeinfo/...` if enabled. The reader
  routes are mounted before the Fedify middleware anyway, as v1's are.
- It's not `/api/v1`. Mastodon clients, crawlers and instance directories probe
  `/api/v1/instance`, `/api/v2/instance` and `/api/v1/timelines/public`. A
  warmhole that answered under `/api/v1` would look like a broken Mastodon
  server. Under `/reader` those probes get a plain 404.
- It's versioned on its own. v1's `/sites/{siteId}/sync` and
  `/sites/{siteId}/webfinger.json` are operational endpoints for the site's CI
  and stay as they are; the reader contract can move to `/reader/v2` without
  touching them.
- One prefix is easy to rate-limit or restrict at a reverse proxy.

Ids that are URLs (an item id, an account to unfollow) travel as query
parameters, not path segments, because encoded slashes in paths are often
rewritten by proxies.

## Following others

1. The reader calls `POST /reader/v1/sites/{siteId}/following` with
   `{ "account": "@alice@mastodon.social" }` or an actor URL.
2. Parse: `@user@host`, `user@host` and `acct:user@host` are handles; an
   `https://` URL (or `http://` to localhost, for tests) is an actor URL;
   anything else is 400.
3. Resolve with `ctx.lookupObject`, using the site's signing key so servers
   with authorized fetch answer. 10 s timeout. Not found: 422
   `account_not_found`. Not an actor or no inbox: 422 `not_an_actor`. Network
   failure or timeout: 502 `remote_unreachable`.
4. Refuse any actor that is a warmhole site on this instance (422
   `cannot_follow_self`), and a 2001st follow (422 `following_limit`).
5. Upsert the actor cache row, then the `following` row with a fresh
   `follow_id` (`{actor}#follows/{uuid}`), state `pending`.
6. Send `Follow` through Fedify's queue. Respond 202 with the follow.

| Current state | `POST following` does |
|---|---|
| None | Create as `pending`, send `Follow`, 202 |
| `pending` | New `follow_id`, send `Follow` again, 202 (a safe retry when an `Accept` never came) |
| `rejected` | New `follow_id`, back to `pending`, send `Follow`, 202 |
| `accepted` | Nothing, 200 |

| Incoming | Effect |
|---|---|
| `Accept` whose object id is a stored `follow_id`, from that row's actor | State `accepted` |
| `Accept` with an object we can't match, on a site's own inbox, from an actor that site has `pending` | State `accepted` (fallback for servers that don't echo the `Follow` id) |
| `Reject`, matched the same way, while `pending` or `accepted` | State `rejected` (after `accepted`, this is how Mastodon says "removed you as a follower") |
| `Delete` of the followed actor itself | Row removed; their items become tombstones |

`DELETE /reader/v1/sites/{siteId}/following?account=` matches the account
against stored actor ids, or stored handles case-insensitively, with no remote
lookup. It sends `Undo(Follow)` (wrapping a `Follow` with the stored
`follow_id`) unless the state was `rejected`, removes the row and answers 204.
Items already received stay until retention prunes them.

Follow requests are limited to 30 per site per minute (429 with
`Retry-After`), since each one makes remote requests.

## Keeping what arrives

Fedify verifies HTTP signatures before any listener runs, as in v1. Each
activity is then matched to the sites it's for: on a site's own inbox, that
site; on the shared inbox, every site. Of those, only sites with a reader token
that follow the activity's actor with state `accepted` are kept. If none
remain, the activity is answered with 202 and dropped.

### Inbound rules

| Activity | Kept when | Effect |
|---|---|---|
| `Create` of a supported type | Actor followed (`accepted`); object on the actor's origin and attributed to the actor; visibility isn't direct | Insert an item. If one exists as a boost, it becomes a direct item (boost cleared, content refreshed, `seq` and `received_at` kept). If one exists as a direct item or tombstone, nothing. |
| `Create` of anything else | never | Dropped |
| `Announce` | Actor followed (`accepted`); boosted object fetched by id, a supported type, `attributedTo` on the object's origin, visibility public or unlisted | Insert an item with `boost` set (booster, `boosted_at`, Announce id). If the object already has an item (direct, boosted, or tombstone), nothing: first arrival wins. |
| `Undo(Announce)` | Actor is the item's booster and the Announce id matches | Item removed outright |
| `Update` of a stored object | Actor is the item's author; object id on the actor's origin | Content, title, summary, attachments and tags replaced; `updated` from the object. `seq` and `received_at` unchanged, so an edit doesn't move the item. An update that turns it into a direct message makes it a tombstone. |
| `Update` of the actor itself | Actor is the object | Actor cache row refreshed |
| `Delete` of a stored object | Actor is the item's author | Item becomes a tombstone, on every site |
| `Delete` of the actor itself | Actor is the object | All their items become tombstones; their `following` rows and cache row are removed. (Best effort: some servers sign these with a key that is already gone, and Fedify rejects them.) |
| `Accept`, `Reject` | See Following others | Follow state |
| `Follow`, `Undo(Follow)` | As in v1 | Followers of the site |
| Anything else (`Like`, `Move`, `Flag`, `Add`, ...) | never | 202, dropped |

`Update` and `Delete` are accepted from an item's author whether or not the
site still follows them, so a boosted post from someone the site doesn't follow
can still be edited or withdrawn.

### Object authenticity

- `Create` and `Update`: the object id must be on the same origin as the
  activity's signature-verified actor, and its `attributedTo` must be that
  actor. A followed account's posts live on its own server, so an embedded
  object that passes both checks is that server's word and is used as is;
  anything else is dropped without fetching.
- `Announce`: the boosted object is on someone else's server, so it is always
  fetched by id, with the site's key, and never taken from the activity. A
  fetched object counts as genuine for its own origin; one whose
  `attributedTo` is on a different origin than its id is dropped.
- `Delete` and `Undo(Announce)` carry no content, only ids; they apply only to
  rows whose author (or booster) is the activity's actor.

### Visibility

From the object's `to` and `cc`, with `as:Public` in any of its spellings:

| Addressing | Visibility |
|---|---|
| Public in `to` | `public` |
| Public in `cc` only | `unlisted` |
| The author's `followers` collection in `to` or `cc` | `followers` |
| Anything else | direct: dropped |

### Normalizing an object

| Field | From |
|---|---|
| `id` | Object `id` |
| `url` | First `url` link with media type `text/html`, else the first http(s) `url`, else `id` |
| `type` | The vocab class |
| `title` | `name` as plain text; always null for `Note` |
| `summary` | `summary` as plain text |
| `sensitive` | `sensitive`, default false |
| `content_html` | `content` (or the first `contentMap` entry), sanitized, relative URLs resolved against the object id |
| `content_text` | Plain-text rendering of `content_html` |
| `language` | The `contentMap` key, or the language of `content` if tagged |
| `published` | `published`, else `received_at` |
| `updated` | `updated`, else null |
| `in_reply_to` | `inReplyTo` id |
| `attachments` | `attachment` entries that are `Document`, `Image`, `Video`, `Audio` or `Link` with an http(s) URL: `url`, `mediaType`, `name` as alt text, `width`, `height`. First 20. |
| `hashtags` | `Hashtag` tags: name without `#`, `href`. First 50. |
| `mentions` | `Mention` tags: `href` as actor id, `name` as handle text. First 50. |

Objects whose sanitized content is over 256 KB are dropped and logged.

### Sanitizing

Done once, on arrival, with `sanitize-html` and this fixed configuration. The
reader never sees unsanitized HTML.

| Rule | Value |
|---|---|
| Allowed elements | `p`, `br`, `a`, `span`, `strong`, `b`, `em`, `i`, `u`, `s`, `del`, `ins`, `code`, `pre`, `blockquote`, `ul`, `ol`, `li`, `h1`–`h6`, `hr`, `sup`, `sub`, `img`, `figure`, `figcaption`, `table`, `thead`, `tbody`, `tr`, `th`, `td` |
| Allowed attributes | `a`: `href`, `class`, `rel`. `img`: `src`, `alt`, `title`, `width`, `height`. `span`: `class`. `ol`: `start`. `th`, `td`: `colspan`, `rowspan`. Nothing else: no `style`, `id`, `on*`, `data-*`. |
| Allowed classes | `a`: `mention`, `hashtag`, `u-url`. `span`: `h-card`, `invisible`, `ellipsis` (Mastodon's link and mention markup, so readers can style or hide them). |
| URL schemes | `a href`: `http`, `https`, `mailto`. `img src`: `https` only. No protocol-relative URLs. Relative URLs resolved against the object id first. A link with a disallowed URL keeps its text and loses the `href`. |
| Links | `rel="nofollow noopener noreferrer"` forced on every `a`; `target` removed. |
| Numbers | `width`, `height`, `start`, `colspan`, `rowspan` kept only if 1 to 5 digits. |
| Dropped with content | `script`, `style`, `template`, `noscript`, `textarea`, `option`, `iframe`, `object`, `embed`, `svg`, `math` |
| Other elements | Unwrapped: the tag goes, its text stays (`div`, `section`, `font`, ...) |
| Comments | Removed |

Plain fields (`title`, `summary`, display names, alt text) go through the
plain-text renderer, so they never carry markup.

### Plain text

Rendered from the sanitized HTML: block elements (`p`, headings, `blockquote`,
`pre`, `figure`, `table` rows) separated by a blank line; `br` a line break;
`li` prefixed with `- ` or `1. `; `blockquote` lines prefixed with `> `; `pre`
whitespace kept; elsewhere whitespace collapsed; links become their text;
images become `[alt]` when they have alt text; entities decoded; Mastodon's
`invisible` spans kept, so links read in full.

### Actors

The cache row for an actor is built from its document: `name` as plain text,
`icon` URL, `url` as profile, inbox, shared inbox, followers collection. The
handle comes from Fedify's `getActorHandle`, which looks up WebFinger for
`preferredUsername@host` and follows the subject across domains (so a warmhole
site shows as `@nico@innermonologue.nbaglivo.dev`, not as the server's host).
If WebFinger fails, the handle is `@{preferredUsername}@{actor host}`, or null
with no `preferredUsername`. Rows older than a day are refreshed when the actor
sends something; a failed refresh keeps the old row.

## Reader API

The full contract, with every schema and example, is
[`docs/reader-api.openapi.json`](../../reader-api.openapi.json). This section
records the rules behind it.

### Authentication

`Authorization: Bearer <token>`, where the token is the value of the env var
named by the site's `readerTokenEnv`. Compared in constant time (SHA-256 both
sides, then `timingSafeEqual`, as v1's sync token). A missing or wrong token,
an unknown site id, and a site without `readerTokenEnv` all answer 401 with
`WWW-Authenticate: Bearer realm="warmhole"`, so site ids can't be probed. The
reader token can't do what the sync token does and vice versa; config refuses
the same value for both.

### Item

| Field | Type |
|---|---|
| `id` | string (AP object id) |
| `url` | string |
| `type` | `Note` \| `Article` \| `Page` \| `Question` \| `Image` \| `Video` \| `Audio` |
| `visibility` | `public` \| `unlisted` \| `followers` |
| `published` | date-time |
| `updated` | date-time or null |
| `title` | string or null (null for `Note`) |
| `summary` | string or null |
| `sensitive` | boolean |
| `content_html` | string (sanitized, may be empty) |
| `content_text` | string |
| `language` | string or null |
| `author` | Account |
| `boost` | `{ by: Account, boosted_at: date-time, activity_id: string }` or null |
| `in_reply_to` | string or null |
| `attachments` | `{ url, media_type (or null), kind (image \| video \| audio \| other), description (or null), width (or null), height (or null) }[]` |
| `hashtags` | `{ name, url (or null) }[]` |
| `mentions` | `{ actor_id, handle (or null) }[]` |
| `received_at` | date-time |

Account is `{ id, handle, name, avatar_url, profile_url }`, all but `id`
nullable. Every field is always present; nullable ones are `null`, never
missing. JSON is snake_case.

### Paging

- Sort key is `seq`: arrival order. `order=desc` (default) is newest first,
  `order=asc` oldest first.
- `since` (exclusive) and `until` (inclusive) bound `received_at`, so
  consecutive windows `(a, b]`, `(b, c]` never overlap. They filter on arrival,
  not `published`: a boost of an old post is news the morning it's boosted.
- `limit` 1 to 200, default 50. warmhole reads `limit + 1` rows to know whether
  there's more.
- The cursor is base64url JSON `{ v, o, s, a, b }`: version, order, last `seq`,
  `since`, `until`. Clients treat it as opaque. Repeating `order`, `since` or
  `until` next to a cursor is fine if the values match; different values are
  400 `invalid_cursor`.
- Stable under inserts: new items get a higher `seq`, so they appear before
  the first desc page or after the last asc page, never in the middle. Edits
  don't move an item. Deletes and prunes only remove rows.
- `next_cursor` is null only when nothing more can match. In asc order without
  `until` it's always present: a reader can store it and resume next morning
  to get exactly what arrived since. Coffee Companion uses this.
- `received_at` comes from the clock; `seq` doesn't. If the clock steps
  backwards, order follows `seq`.

### Errors

Every error is `{ "error": "<message>", "code": "<code>" }`. `error` keeps the
v1 shape (`{ "error": "..." }`), so one error type serves the whole server;
`code` is stable for programs.

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_request` | Bad parameter or body (`limit`, `order`, timestamps, `since` ≥ `until`, missing `id` or `account`, unparseable account) |
| 400 | `invalid_cursor` | Cursor can't be decoded or contradicts the parameters |
| 401 | `unauthorized` | Token missing or wrong, unknown site, reader disabled |
| 404 | `not_found` | No such item, follow or route |
| 410 | `gone` | Item was deleted by its author |
| 413 | `payload_too_large` | Body over 4 KB |
| 422 | `account_not_found`, `not_an_actor`, `cannot_follow_self`, `following_limit` | Follow refused |
| 429 | `rate_limited` | Auth failures or follow requests over the limit; `Retry-After` set |
| 500 | `internal` | Bug; logged |
| 502 | `remote_unreachable` | WebFinger or actor fetch failed or timed out |

Responses carry `Cache-Control: no-store`. No CORS headers: the reader is a
program, not a page.

### Versioning

The path carries the major version. Within `/reader/v1`, warmhole may add
fields, endpoints, query parameters and enum values; it never removes, renames
or changes the meaning of one. Clients ignore unknown fields and treat an
unknown `type` like `Note` and an unknown attachment `kind` like `other`.
Anything else is `/reader/v2`, served next to v1 for a while.

## Retention

- Per site, `retentionDays` (integer 1 to 3650, default 30).
- Hourly and at start, delete items (tombstones included) with `received_at`
  older than the window. By arrival, not `published`, matching how the API
  filters.
- Then delete actor rows that no item and no `following` row references and
  that weren't fetched within the longest window.
- `following` rows are never pruned; unfollow removes them.

## Configuration

Two optional site fields:

```json
{
  "id": "inner-monologue",
  "handle": "nico",
  "domain": "innermonologue.nbaglivo.dev",
  "feedUrl": "https://innermonologue.nbaglivo.dev/feed.xml",
  "name": "The Open Inner Monologue",
  "syncTokenEnv": "INNER_MONOLOGUE_SYNC_TOKEN",
  "readerTokenEnv": "INNER_MONOLOGUE_READER_TOKEN",
  "retentionDays": 30,
  "deleteMissing": true
}
```

Validation also fails startup on: a `readerTokenEnv` that is unset, a reader
token under 32 characters, a reader token equal to the site's sync token, or a
`retentionDays` that isn't an integer from 1 to 3650.

Without `readerTokenEnv` the site is v1: reader API 401, inbound posts dropped.
Removing it later keeps the tables but stops storing; follows stay in place on
the remote servers until unfollowed.

## Errors and safety

- Reader tokens compared in constant time; 32 characters minimum.
- Failed reader authentications limited to 10 per client address per minute,
  then 429 for the rest of that minute. Behind a reverse proxy every request
  shares one address, so the limit is effectively global; token length is the
  real defense, and the limit keeps logs quiet.
- Follow requests limited to 30 per site per minute.
- Body limits: 1 MB on `/inbox` and `/users/{siteId}/inbox` (413), 4 KB on
  reader request bodies.
- Remote lookups (WebFinger, actors, boosted objects): 10 s timeout, the
  site's signing key, Fedify's private-address protection left on in
  production.
- Stored content capped: 256 KB of sanitized HTML, 20 attachments, 50 hashtags,
  50 mentions per item.
- Sanitization happens before storage, so a bug fixed in the allowlist needs a
  re-fetch to apply to old items; with 30-day retention that's a short tail.
- Followers-only posts are served to whoever holds the reader token. Keep it
  out of browsers and logs.
- Log lines for dropped activities are `debug`, so a busy followed account
  doesn't flood stdout.

## Testing

- **Unit:** sanitizer against hostile HTML (scripts, `javascript:` and
  protocol-relative URLs, event handlers, styles, nested unknown tags) and real
  Mastodon, WriteFreely and PeerTube content; plain-text rendering; visibility
  classification; object normalization from Fedify vocab objects, including
  missing fields, `contentMap`, `Link` arrays and attachment limits; account
  parsing; cursor encoding and mismatch checks; config validation.
- **Store:** dedup, boost upgrade, tombstones blocking resurrection, keyset
  paging in both orders with inserts between pages, `since`/`until`
  boundaries, pruning and actor cleanup.
- **Integration:** the fake remote from v1 grows a followed account with
  posts. Follow → `Accept` → `Create` → item listed; `Reject`; `Announce` and
  `Undo(Announce)`; `Update`; `Delete`; posts from accounts not followed and
  direct messages dropped. The reader API through `app.request`, with every
  response body validated against `docs/reader-api.openapi.json`, so the
  contract and the code can't drift.
- **Manual before release:** follow a real Mastodon account by handle, check
  `state` goes to `accepted`, post from it (public, followers-only, a boost, a
  direct message) and read the result with `curl`; unfollow and check the
  Mastodon account loses the follower.

## Dependencies

Adds `sanitize-html` and `htmlparser2` (which `sanitize-html` already uses).
Dev only: `ajv` and `ajv-formats`, for the contract test.
