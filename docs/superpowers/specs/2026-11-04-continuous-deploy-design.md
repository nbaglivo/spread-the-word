# Continuous deploy to the Hetzner box

## Why

Deploys are manual today, and the box has quietly fallen behind: `/opt/warmhole`
runs code copied up on 2026-10-16, and nothing since has shipped. Nico wants a
push to `main` to put the new code live without anyone ssh-ing in.

## How it works

```
 push to main
     │
     ▼
 GitHub Actions
  1. test       npm ci, npm test, npm run typecheck
  2. image      build linux/amd64, push ghcr.io/nbaglivo/warmhole:<sha> and :main
  3. deploy     ssh deploy key ──► box runs /opt/warmhole/deploy.sh <sha>
                                      │
                                      ▼
                         pull image, restart only the warmhole service,
                         check https://ap.nbaglivo.dev/healthz,
                         roll back to the previous image if it fails
```

The box no longer builds anything. It pulls a finished image that already passed
CI.

## Current state of the box (checked 2026-11-04)

- Hetzner, x86_64, Docker 29.1.3, Compose 2.40.3, reached as `ssh hetzner`.
- `/opt/warmhole` is not a git checkout. It holds a copy of the repo from
  2026-10-16, plus `.env` and `warmhole.json` that exist only there.
- `compose.yml` and `Caddyfile` on the box differ from the repo. Caddy also
  routes `ghost.nbaglivo.dev` to `ghost-blog:2368`, and the caddy service joins
  an external `edge` network to reach it. Caddy is shared infrastructure now.
- The running image is `warmhole-warmhole`, built on the box.

## Goals

- A push to `main` that passes tests and typecheck ends with that commit running
  on the box.
- If the new container doesn't pass the health check, the box goes back to the
  previous image and the GitHub run fails (GitHub's failure email is the alert).
- Deploys can't break anything else on the box.

## Non-goals

- Managing Caddy, the `Caddyfile`, Ghost, or the `edge` network. Those stay
  hand-managed on the box (Nico's decision).
- Syncing `compose.yml`, `.env` or `warmhole.json` to the box.
- Zero-downtime deploys. A few seconds of warmhole downtime per deploy is fine;
  Mastodon retries deliveries.
- Staging environments, multi-arch images, chat notifications.

## Anti-goals

- A deploy that takes the Ghost blog or Caddy down.
- A deploy that overwrites or reads out `.env` or `warmhole.json`.
- A leaked GitHub secret that gives someone a shell on the box.

## Decisions

### Nico's

- Ship the app as a Docker image built in CI, not as source copied to the box.
- Deploys touch only the warmhole service, never Caddy or the box's config
  files.
- On a failed health check: roll back automatically and fail the run.
- The GitHub deploy key can only run the deploy script: forced command in
  `authorized_keys`, no shell.
- Registry: GHCR. The repo is public, so the image is public and the box pulls
  without logging in.

### My calls

- Trigger on push to `main`, plus `workflow_dispatch` to redeploy by hand. Other
  branches run nothing.
- One image, `linux/amd64`, matching the box.
- Tags: the full commit sha (what gets deployed) and `main` (convenience).
- The deploy job passes only the sha. The box script accepts only a 40-character
  hex sha and refuses anything else, so the forced command can't be used to run
  arbitrary images or commands.
- Health check from the box against `https://ap.nbaglivo.dev/healthz` through
  Caddy (the real path a visitor takes), using
  `curl --resolve ap.nbaglivo.dev:443:127.0.0.1` so it doesn't depend on the
  box reaching its own public IP: poll every 2 seconds for up to 30, expecting
  `ok`.
- On the very first deploy, the rollback target is the box-built
  `warmhole-warmhole` image. Keep it until a GHCR deploy has succeeded.
- `workflow_dispatch` runs the same pipeline for the current `main`: test,
  build, deploy.
- Pruning never removes the running image or the rollback image.
- Rollback restores only the image. The data volume is never touched, so a
  release that migrates the database in an incompatible way can't be undone by
  the rollback. Nothing in the code does that today.
- Pin the box's SSH host key as a secret (`DEPLOY_KNOWN_HOSTS`). Don't use
  `StrictHostKeyChecking=no`.
- One deploy at a time: a GitHub `concurrency` group that doesn't cancel the
  running job, plus `flock` in the box script.
- `deploy.sh` lives in the repo at `scripts/deploy.sh` for review, but is
  installed on the box by hand. CD never updates it, so a commit can't widen
  what the deploy key can do.
- After a successful deploy, prune warmhole images older than the last three.
- The repo's `compose.yml` switches from `build: .` to the GHCR image, so the
  repo shows how the box actually runs. `docker build` instructions stay in the
  README for local use.

## Requirements for the box script

- Plain `docker compose ps/logs/restart/up -d` by hand must keep working and
  must keep running the last deployed image, not `:main` or a stale build.
  How the current tag is stored is up to the builder, but it must not mean
  editing `.env`.
- Only the `warmhole` service is pulled and recreated (`--no-deps`).
- Output goes to stdout/stderr so it shows up in the GitHub run log.
- Exit non-zero on any failure, including a successful rollback.

## One-time setup on the box (manual, documented)

1. Generate an ed25519 deploy key. Add its public half to root's
   `authorized_keys` with `restrict,command="/opt/warmhole/deploy.sh"`. The
   script reads the sha from `SSH_ORIGINAL_COMMAND`.
2. Add repo secrets: `DEPLOY_SSH_KEY`, `DEPLOY_HOST` (91.98.0.37) and
   `DEPLOY_KNOWN_HOSTS`.
3. After the first image push, make the GHCR package public. New GHCR packages
   start private even when the repo is public.
4. Copy `scripts/deploy.sh` to `/opt/warmhole/deploy.sh` and `chmod 700` it.
5. On the box's `compose.yml`, change only the warmhole service from `build: .`
   to the image reference. Keep the `edge` network and everything else.
6. After the first successful deploy, remove the leftover source files from
   `/opt/warmhole`. Keep `compose.yml`, `Caddyfile`, `.env`, `warmhole.json`
   and `deploy.sh`.

## Docs

- `docs/hosting.md`: replace "after pulling changes" with the CD flow, the
  rollback behaviour, how to redeploy or roll back by hand, and the one-time
  setup.
- `README.md`: a short note that `main` deploys automatically.

## Left to the builder

- Workflow file layout and action versions.
- How the box script remembers the current and previous tags.
- Whether the test job uses mise or `actions/setup-node` with Node 26.

## Notes

- The first deploy jumps from the 2026-10-16 build to current `main`. Since
  then, `main` has gained email subscriptions, so the first deploy ships that
  feature. The box's `warmhole.json` and `.env` have no `smtp` settings, and
  `smtp` is optional, so the app should start with email turned off. If it
  doesn't, the health check catches it and rolls back.
