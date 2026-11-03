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
docker compose up -d --build      # after pulling changes
```

From the laptop: `WARMHOLE_SSH=hetzner scripts/logs -f`.
