# Hosting

How warmhole runs on the Hetzner box and how requests reach it.

## The pieces

```
  Cloudflare DNS                Hetzner box  91.98.0.37  (ssh hetzner)
  ┌──────────────────────┐      ┌──────────────────────────────────────────┐
  │ ap  A  91.98.0.37    │      │  /opt/warmhole   docker compose          │
  │     (grey cloud)     │      │                                          │
  └──────────────────────┘      │  ┌────────────┐        ┌──────────────┐  │
                                │  │   caddy    │        │   warmhole   │  │
   only 80 and 443 are open ───►│  │ :80  :443  │───────►│    :8080     │  │
                                │  └────────────┘        └──────────────┘  │
                                │   caddy-data            warmhole-data    │
                                │   (certificates)        (db + keys)      │
                                └──────────────────────────────────────────┘
```

## A request, end to end

```
 Mastodon server
       │  1. "where is ap.nbaglivo.dev?"
       ▼
 Cloudflare DNS ──► 91.98.0.37   (grey cloud: the real IP, no proxy)
       │
       │  2. HTTPS to 91.98.0.37:443, asking for ap.nbaglivo.dev
       ▼
 Caddy  ── terminates TLS with its Let's Encrypt certificate
       │  3. matches the hostname against the Caddyfile
       ▼
 warmhole:8080  (docker network only, not reachable from outside)
```

Port 80 only redirects to HTTPS and answers Let's Encrypt's challenge.

## How Caddy gets its certificate

```
 Caddy ── "I want a cert for ap.nbaglivo.dev" ──► Let's Encrypt
                                                       │
       ◄── "prove it: serve this token on :80" ────────┘
                                                       │
 Let's Encrypt looks up ap.nbaglivo.dev ──► must be 91.98.0.37
                                                       │
       ◄── certificate (renewed automatically) ────────┘
```

If DNS points elsewhere (an orange-cloud proxy, Vercel), the challenge fails
and HTTPS on the box breaks with a TLS "internal error".

## Grey cloud vs orange cloud

```
 grey   visitor ───────────────────────────► 91.98.0.37 (Caddy)
 orange visitor ──► Cloudflare edge ───────► 91.98.0.37 (Caddy)
                    (own cert, cache, bot checks: breaks Let's Encrypt
                     and can interfere with signed ActivityPub requests)
```

Use grey for anything Caddy serves. The blogs on Cloudflare Pages stay as they are.

## Adding more

More blogs on the fediverse: one warmhole, more `sites` in `warmhole.json`.

```
 @nico@innermonologue.nbaglivo.dev ─┐
 @nico@engineering.nbaglivo.dev ────┼──► ap.nbaglivo.dev ──► warmhole
 @nico@nbaglivo.dev ────────────────┘     (one site entry each)
```

More apps on the box: one subdomain each, routed by hostname, not by port.

```
 ap.nbaglivo.dev    ─┐                    ┌──► warmhole:8080
                     ├──► Caddy :443 ─────┤
 other.nbaglivo.dev ─┘   (Caddyfile)      └──► otherapp:3000
```

```
ap.nbaglivo.dev {
	reverse_proxy warmhole:8080
}
other.nbaglivo.dev {
	reverse_proxy otherapp:3000
}
```

Each new subdomain needs a grey-cloud `A` record to 91.98.0.37. Apps in other
compose folders need a shared Docker network so Caddy can reach them.

## Day to day

```bash
ssh hetzner
cd /opt/warmhole
docker compose ps
docker compose logs -f caddy      # certificate issues
docker compose restart caddy      # retry a certificate now
docker compose up -d --no-deps warmhole   # restart warmhole on warmhole:current
```

From the laptop: `WARMHOLE_SSH=hetzner scripts/logs -f`.

## Deploys

Every push to `main` deploys itself. Only the warmhole container changes.

```
 push to main
     │
     ▼
 GitHub Actions ── test ──► image ──► ghcr.io/nbaglivo/warmhole:<sha>
     │                                          │
     │ deploy: ssh with the sha only            │ pull
     ▼                                          ▼
 Hetzner box ── /opt/warmhole/deploy.sh <sha>
     │  tag warmhole:current as warmhole:previous
     │  tag the new image as warmhole:current
     │  docker compose up -d --no-deps warmhole
     │  check https://ap.nbaglivo.dev/healthz through Caddy
     ▼
   "ok"            ──► done, keep the 3 newest images
   no "ok" in 30s  ──► put warmhole:previous back, the run fails
```

A deploy never touches Caddy, the `Caddyfile`, Ghost, `.env` or
`warmhole.json`. Those stay hand-managed on the box.

The deploy key in GitHub can only run `deploy.sh` with a commit sha. It
can't open a shell or run anything else.

`deploy.sh` exits with:

- `0`: deployed.
- `1`: failed, and the previous image is running (or nothing changed).
- `2`: not a commit sha.
- `3`: rollback impossible or also unhealthy. Look now.

### By hand

```bash
ssh hetzner
cd /opt/warmhole
docker image inspect warmhole:current --format '{{.RepoTags}}'   # what runs
/opt/warmhole/deploy.sh <full sha>                                 # redeploy a commit
docker tag warmhole:previous warmhole:current && docker compose up -d --no-deps warmhole   # roll back
```

To redeploy `main` without a push, run the `deploy` workflow from the Actions
tab.

### One-time setup

Do steps 1, 2, 4 and 5 before the workflow first reaches `main`. The first
run then fails safely at the pull (step 3), and nothing on the box changes.

1. Create a deploy key. In `/root/.ssh/authorized_keys` on the box, add its
   public half locked to the script:

   ```
   restrict,command="/opt/warmhole/deploy.sh" ssh-ed25519 AAAA… github-deploy
   ```

2. Add the repo secrets `DEPLOY_SSH_KEY` (the private key), `DEPLOY_HOST`
   (`91.98.0.37`) and `DEPLOY_KNOWN_HOSTS` (the output of
   `ssh-keyscan -t ed25519 91.98.0.37`). Create a `production` environment
   and limit its deployment branches to `main`.
3. After the first image push, make the GHCR package public: GitHub →
   Packages → warmhole → Settings → Change visibility. New packages start
   private even when the repo is public. Then re-run the `deploy` workflow.
4. Copy `scripts/deploy.sh` to `/opt/warmhole/deploy.sh` and `chmod 700` it.
   Deploys never update it, so copy it again by hand when it changes.
5. In the box's `compose.yml`, replace the warmhole service's `build: .`
   with:

   ```yaml
       image: warmhole:current
       pull_policy: never
   ```

   Keep everything else, including Caddy's `edge` network.
6. After the first successful deploy, remove the old source files from
   `/opt/warmhole`. Keep `compose.yml`, `Caddyfile`, `.env`, `warmhole.json`
   and `deploy.sh`.
