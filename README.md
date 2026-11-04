<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
  <img src="docs/logo.svg" alt="A knife spreading butter on a slice of bread" width="160">
</picture>

# spread-the-word

Spread the word when your site publishes something new, across the fediverse
and by email.

spread-the-word is a small, self-hosted server that takes each new item in your
site's feed to the people who want it. They can follow `@you@your-site.dev`
from Mastodon and see it in their timeline, or subscribe by email and find it
in their inbox. Your site stays static.

## How it works

Your site keeps publishing its RSS, Atom or JSON Feed. After each deploy, it
pings spread-the-word, which reads the feed and works out what's new, edited
or removed. Your fediverse followers get all of that, and email subscribers get
each new post. Follows are accepted automatically. Likes, boosts and replies
are ignored for now.

Design and diagrams: [`docs/design.html`](docs/design.html).

## Reading the fediverse (planned)

v1 only publishes: your feed goes out to your followers. The reader API adds
the other direction. Your site's account follows other fediverse accounts,
spread-the-word keeps what they post and boost, and one private reader (Coffee
Companion) pulls it over HTTP:

- `POST` / `DELETE /reader/v1/sites/{siteId}/following` to follow or unfollow
  by handle or actor URL
- `GET /reader/v1/sites/{siteId}/items` to page through what arrived

It serves posts from accounts you follow, not your own published posts. A blog
appears only if it publishes over ActivityPub (another spread-the-word site, or
WordPress with the ActivityPub plugin). Plain RSS feeds aren't fetched. The
following is done by your blog's own account, so the accounts you follow see
a follow from it.

It's our own small API, not the Mastodon client API, so Mastodon apps can't
read it. Why: [spec](docs/superpowers/specs/2026-10-16-reader-api-design.md#why-our-own-api-and-not-the-mastodon-client-api).
Contract: [`docs/reader-api.openapi.json`](docs/reader-api.openapi.json).
Plan: [`docs/superpowers/plans/2026-10-16-reader-api.md`](docs/superpowers/plans/2026-10-16-reader-api.md).

## Run it

1. Copy `warmhole.example.json` to `warmhole.json` and fill in one entry per
   site. `syncTokenEnv` names an environment variable holding a long random
   token for that site.
2. Run the container, with the database on a volume you back up (it holds
   each site's private keys):

   ```bash
   docker build -t warmhole .
   docker run -d -p 8080:8080 \
     -e MY_BLOG_SYNC_TOKEN="$(openssl rand -hex 32)" \
     -v "$PWD/warmhole.json:/config/warmhole.json:ro" \
     -v warmhole-data:/data \
     warmhole
   ```

3. Put it behind HTTPS at the `publicUrl` from your config.

On a server of your own, `compose.yml` runs spread-the-word behind Caddy, which
gets the HTTPS certificate for you. Point your domain's DNS at the server, then:

```bash
cp warmhole.example.json warmhole.json
cp .env.example .env
docker compose up -d
```

This pulls the latest release, `ghcr.io/nbaglivo/warmhole:latest`. Each
release is also tagged with its version (`:v0.1.0`) to pin one, and `:main`
follows every push. Every push to `main` that passes the tests deploys itself
to the author's server; see [docs/hosting.md](docs/hosting.md#deploys).

`.env` sets `WARMHOLE_DOMAIN` (the host of `publicUrl`) and each site's sync
token. To move to another server, copy `warmhole.json`, `.env` and the
`warmhole-data` volume, then point the DNS at the new machine. Keep
`publicUrl` the same: it is your account's identity in the fediverse.

Without Docker: `mise install && npm ci && npm start`. Settings come from
`WARMHOLE_CONFIG` (default `./warmhole.json`), `WARMHOLE_DB` (default
`./data/warmhole.db`) and `PORT` (default `8080`).

## Connect a site

1. **WebFinger.** Download `https://<publicUrl>/sites/<id>/webfinger.json` and
   publish it on your site at `/.well-known/webfinger`, served as
   `application/jrd+json`. On Cloudflare Pages, add to `_headers`:

   ```
   /.well-known/webfinger
     Content-Type: application/jrd+json
     Access-Control-Allow-Origin: *
   ```

2. **Ping after deploy.** In GitHub Actions:

   ```yaml
   - name: Notify spread-the-word
     run: >
       curl --fail --retry 3 -X POST
       -H "Authorization: Bearer ${{ secrets.WARMHOLE_SYNC_TOKEN }}"
       https://ap.example.dev/sites/my-blog/sync
   ```

   The response says what happened, for example
   `{"new":1,"updated":0,"deleted":0}`. Pinging again is always safe.

The first ping for a site saves the existing posts without sending them, so new
followers aren't flooded.

With `"deleteMissing": true`, a post that disappears from the feed is deleted
for followers too. Posts older than the oldest entry in the feed are left
alone, so feeds that list only the latest posts are safe.

## Email subscriptions

Optional. Readers can also subscribe by email and get each new post in their
inbox. It works on its own, with or without any fediverse followers.

1. **SMTP.** Add an `smtp` block to `warmhole.json` and, for each site that
   should send email, an `email` block (see `warmhole.example.json`):

   ```json
   {
     "smtp": {
       "host": "smtp.migadu.com",
       "port": 587,
       "userEnv": "SMTP_USER",
       "passwordEnv": "SMTP_PASSWORD"
     },
     "sites": [
       {
         "id": "my-blog",
         "email": {
           "from": "My Blog <me@blog.example.dev>",
           "checkInboxUrl": "https://blog.example.dev/subscribe/check-your-inbox/",
           "confirmedUrl": "https://blog.example.dev/subscribe/confirmed/",
           "unsubscribedUrl": "https://blog.example.dev/subscribe/unsubscribed/"
         }
       }
     ]
   }
   ```

   `userEnv` and `passwordEnv` name environment variables (`SMTP_USER` and
   `SMTP_PASSWORD` in `.env`). Port 465 uses implicit TLS, any other port
   uses STARTTLS and requires it. The three page URLs must be HTTPS.
   Two optional `smtp` keys: `port` (default 587) and `pauseMs` (default 1000),
   the pause between consecutive emails.

2. **Sender domain.** The domain in `from` must be one your SMTP account may
   send for. With Migadu, set up SPF and DKIM for it, or mail lands in spam.
   spread-the-word doesn't check this.

3. **Three pages on your site.** One telling people to check their inbox, one
   for a confirmed subscription, one for an unsubscribe.

4. **The form**, pointing at your spread-the-word server:

   ```html
   <form method="post" action="https://ap.example.dev/sites/my-blog/subscribe">
     <input type="email" name="email" required placeholder="you@example.com">
     <input type="text" name="website" tabindex="-1" autocomplete="off" hidden>
     <button>Subscribe</button>
   </form>
   ```

   The hidden `website` field is a honeypot for bots. An invalid address
   redirects to the check-inbox page with `?error=invalid` appended, so that
   page can show a message.

Subscribing sends a confirmation link; only confirmed addresses get posts.
Every email carries an unsubscribe link and the one-click unsubscribe button
mail apps show.

An email goes out for each new post found by a sync. Edits, deletions and the
first sync of a site send nothing. Delivery runs in the background with
retries, so a mail server outage doesn't hold up syncs or federation.

## Check it works

- `npx @fedify/cli lookup @you@your-site.dev` should show your actor.
- `npx @fedify/cli inbox` gives you a throwaway account to follow from.
- Then follow from a real Mastodon account, publish a post and ping.

## Watch what it does

spread-the-word logs one JSON line per event: each sync and what it found, each
follow and unfollow, each delivery and any follower it gave up on. With email
on, it also logs subscribers joining and leaving and each email sent or failed
(addresses are masked).
`scripts/logs` reads them over SSH and prints them one short line each:

```bash
export WARMHOLE_SSH=root@203.0.113.7
scripts/logs              # last 200 lines
scripts/logs -f           # follow live
scripts/logs --since 1h
```

```
12:43:48 synced inner-monologue: 1 new, 0 updated, 0 deleted
12:43:49 sent Create creating-a-life → mastodon.social
```

`WARMHOLE_SSH_KEY` picks an SSH key and `WARMHOLE_DIR` the folder on the server
(default `/opt/warmhole`).

## Development

```bash
npm test
npm run typecheck
```
