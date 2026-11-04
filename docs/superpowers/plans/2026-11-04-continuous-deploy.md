# Continuous Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A push to `main` that passes tests and typecheck builds a warmhole image, pushes it to GHCR and swaps it in on the Hetzner box, rolling back if `/healthz` fails.

**Architecture:** A GitHub Actions workflow runs three jobs: test, image and deploy. The deploy job sshes to the box with a key that is locked to `/opt/warmhole/deploy.sh <sha>`. The script pulls `ghcr.io/nbaglivo/warmhole:<sha>` and retags it as the local `warmhole:current`, which the box's `compose.yml` runs with `pull_policy: never`. It then restarts only the warmhole service and health-checks through Caddy. The image that was running before is kept as `warmhole:previous` for rollback. Plain `docker compose` commands typed by hand keep running `warmhole:current`, and nothing is written to `.env`.

**Tech Stack:** GitHub Actions, GHCR, Docker Compose, bash, and `node --test` for the script's tests.

**Spec:** `docs/superpowers/specs/2026-11-04-continuous-deploy-design.md`

## Global Constraints

- Image: `ghcr.io/nbaglivo/warmhole`, tags are the full 40-char commit sha and `main`, platform `linux/amd64` only.
- The deploy script accepts only `^[0-9a-f]{40}$`, taken from `$1` or else `$SSH_ORIGINAL_COMMAND`.
- Health check: `curl --resolve ap.nbaglivo.dev:443:127.0.0.1 https://ap.nbaglivo.dev/healthz`, body `ok`. It polls every 2s for up to 30s by default (15 tries).
- Only the `warmhole` service is touched (`docker compose up -d --no-deps warmhole`). Nothing touches caddy, `Caddyfile`, `.env` or `warmhole.json`.
- Script exit codes: `0` deployed, `1` failed but the box runs the previous image (or nothing changed), `2` invalid input, `3` rollback impossible or also failed.
- Keep the 3 newest `ghcr.io/nbaglivo/warmhole` sha tags on the box. Remove older ones by `repo:tag`, never by image id.
- No comments in JSON/YAML config files (Nico's rule). Conventional, lowercase commit messages.
- Work on branch `feat/continuous-deploy` off `main`.

## Review Focus

- A garbage or hostile `SSH_ORIGINAL_COMMAND` (`latest`, `$(reboot)`, a sha followed by `; rm -rf /`) must exit 2 before any docker call. Covered by Task 1, test "rejects anything but a full sha".
- A health check that fails on a box with no previous image (a fresh box) must exit 3 and say so, not loop or exit 0. Covered by Task 1, test "exits 3 when there is nothing to roll back to".
- When two deploys overlap, the second must fail fast with a clear message when the lock is held, without touching images. Covered by Task 1, test "refuses to run while another deploy holds the lock".
- Pruning must never remove the running or rollback image. Removing by `repo:tag` only untags them, and the prune runs only after a healthy deploy. Covered by Task 1, test "prunes all but the three newest sha tags after a healthy deploy".
- A failed `docker pull`, for example while the GHCR package is still private, must leave the running container alone. Covered by Task 1, test "leaves everything alone when the pull fails".

---

### Task 0: Branch and commit the design

- [ ] **Step 1:** `git switch -c feat/continuous-deploy`
- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-11-04-continuous-deploy-design.md docs/superpowers/plans/2026-11-04-continuous-deploy.md
git commit -m "docs: add continuous deploy design and plan"
```

### Task 1: Box deploy script

**Files:**
- Create: `scripts/deploy.sh` (executable, `#!/usr/bin/env bash`, `set -euo pipefail`)
- Create: `scripts/deploy.test.ts`
- Create: `test/fake-bin.ts`, a helper that writes the fake `docker`, `curl` and `flock` scripts into a temp dir
- Modify: `package.json`, where the `test` script becomes `node --test "src/**/*.test.ts" "scripts/**/*.test.ts"`

**Interfaces:**
- Produces: `deploy.sh <sha>` (or a sha in `SSH_ORIGINAL_COMMAND`), returning the exit codes from Global Constraints.
- Env overrides, for tests only. A forced ssh command can't set them:
  - `DEPLOY_DIR` (default `/opt/warmhole`)
  - `DEPLOY_HEALTH_TRIES` (default `15`)
  - `DEPLOY_HEALTH_INTERVAL` (default `2`)
- Produces: `fakeBin(opts): { dir: string, env: NodeJS.ProcessEnv, calls(): string[] }` in `test/fake-bin.ts`, with these options:
  - `images: string[]`: refs that `docker image inspect` treats as existing. `docker tag A B` adds `B`.
  - `ghcrTags: string[]`: newest first, printed by `docker image ls ghcr.io/nbaglivo/warmhole --format {{.Tag}}`.
  - `health: ('ok' | 'fail')[]`: consumed one per curl call, with `fail` once it runs out.
  - `pullFails?: boolean`
  - `lockHeld?: boolean`: fake `flock` exits 1.
  - Every `docker` and `curl` invocation is appended as one line, `docker <args>` or `curl <args>`, to a log that `calls()` reads.

Script flow:
1. Validate the sha. On anything else, exit 2.
2. `cd $DEPLOY_DIR`. Take `flock -n` on `.deploy.lock`. If the lock is held, exit 1 with "another deploy is running".
3. `docker pull ghcr.io/nbaglivo/warmhole:<sha>`. If it fails, exit 1.
4. Save the rollback image:
   - If `warmhole:current` exists, `docker tag warmhole:current warmhole:previous`.
   - Otherwise, if `warmhole-warmhole` exists (the first deploy), `docker tag warmhole-warmhole warmhole:previous`.
5. `docker tag ghcr.io/nbaglivo/warmhole:<sha> warmhole:current`, then `docker compose up -d --no-deps warmhole`.
6. Run the health loop. If it passes, prune, print `deployed <sha>` and exit 0.
7. If it fails:
   - With no `warmhole:previous`, exit 3.
   - Otherwise `docker tag warmhole:previous warmhole:current`, run `up` again and repeat the health loop. If that passes, print `health check failed, rolled back` to stderr and exit 1. If it fails too, exit 3.

- [ ] **Step 1: Write the failing tests** in `scripts/deploy.test.ts`. Run the script with `spawnSync('bash', ['scripts/deploy.sh', ...])`, using the `fakeBin` env, `DEPLOY_DIR` set to a temp dir, `DEPLOY_HEALTH_TRIES=2` and `DEPLOY_HEALTH_INTERVAL=0`. Let `SHA` be `'a'.repeat(40)`.
  - `rejects anything but a full sha`: for each of `latest`, `abc`, `$(reboot)`, `` `${SHA}; rm -rf /` `` and `SHA.toUpperCase()`, the status is 2 and `calls()` has no `docker` lines.
  - `reads the sha from SSH_ORIGINAL_COMMAND`: no argument and `SSH_ORIGINAL_COMMAND=SHA`, with healthy health. The status is 0 and the first call is `docker pull ghcr.io/nbaglivo/warmhole:${SHA}`.
  - `swaps the image and keeps the old one for rollback`: images `['warmhole:current']` and health `['ok']`. The docker calls, in order:
    - `docker pull ghcr.io/nbaglivo/warmhole:${SHA}`
    - `docker tag warmhole:current warmhole:previous`
    - `docker tag ghcr.io/nbaglivo/warmhole:${SHA} warmhole:current`
    - `docker compose up -d --no-deps warmhole`

    The status is 0, stdout includes `deployed ${SHA}`, and the curl call includes `--resolve ap.nbaglivo.dev:443:127.0.0.1` and `https://ap.nbaglivo.dev/healthz`.
  - `keeps the box-built image as rollback on the first deploy`: images `['warmhole-warmhole']`. The calls include `docker tag warmhole-warmhole warmhole:previous`.
  - `rolls back when the new image is unhealthy`: images `['warmhole:current']` and health `['fail', 'fail', 'ok']`. The status is 1, stderr includes `rolled back`, the calls include `docker tag warmhole:previous warmhole:current`, and `docker compose up -d --no-deps warmhole` appears twice.
  - `exits 3 when the rollback is unhealthy too`: health `[]`. The status is 3.
  - `exits 3 when there is nothing to roll back to`: images `[]` and health `[]`. The status is 3, stderr includes `no previous image`, and there are no `warmhole:previous` calls.
  - `leaves everything alone when the pull fails`: `pullFails: true`. The status is 1, and the calls hold only the pull, with no `tag`, `compose` or `rmi`.
  - `refuses to run while another deploy holds the lock`: `lockHeld: true`. The status is 1, stderr includes `another deploy`, and there are no docker calls.
  - `prunes all but the three newest sha tags after a healthy deploy`: `ghcrTags` holds 5 shas, newest first, with health `['ok']`. The `rmi` calls are exactly `docker rmi ghcr.io/nbaglivo/warmhole:<4th>` and `…:<5th>`. On the rollback path there are no `rmi` calls.
  - `never touches caddy or the config files`: across the happy and rollback runs, no call includes `caddy`, `.env` or `warmhole.json`.
- [ ] **Step 2:** Run `npm test`. Expected: the new tests FAIL because `scripts/deploy.sh` is missing, and the existing tests pass.
- [ ] **Step 3:** Write `test/fake-bin.ts` and `scripts/deploy.sh` following the flow above. `chmod +x scripts/deploy.sh`.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: all pass.
- [ ] **Step 5:** Run `docker run --rm -v "$PWD:/mnt" koalaman/shellcheck:stable scripts/deploy.sh`. Expected: no findings.
- [ ] **Step 6: Commit**

```bash
git add scripts/deploy.sh scripts/deploy.test.ts test/fake-bin.ts package.json
git commit -m "feat: add a box deploy script that swaps the image and rolls back"
```

### Task 2: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: `deploy.sh` via ssh. The client sends just the sha: `ssh root@$DEPLOY_HOST "$GITHUB_SHA"`.
- Secrets: `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS`.

Contents:
- Name it `deploy`. Trigger on `push` to `branches: [main]` and on `workflow_dispatch`.
- Set `concurrency: { group: deploy, cancel-in-progress: false }` and top-level `permissions: { contents: read }`.
- Job `test` (ubuntu-latest):
  - `actions/checkout`
  - `jdx/mise-action`, so Node comes from `mise.toml`
  - `npm ci`
  - `npm test`
  - `npm run typecheck`
- Job `image` (`needs: test`, `permissions: { contents: read, packages: write }`):
  - `docker/login-action` to `ghcr.io` with `github.actor` and `secrets.GITHUB_TOKEN`
  - `docker/setup-buildx-action`
  - `docker/build-push-action` with `platforms: linux/amd64`, `push: true` and tags `ghcr.io/nbaglivo/warmhole:${{ github.sha }}` and `ghcr.io/nbaglivo/warmhole:main`, using the GitHub Actions cache (`cache-from: type=gha`, `cache-to: type=gha,mode=max`)
- Job `deploy` (`needs: image`, `environment: production`):
  - Write `DEPLOY_SSH_KEY` to `~/.ssh/deploy` with mode 600, and `DEPLOY_KNOWN_HOSTS` to `~/.ssh/known_hosts`.
  - Run `ssh -i ~/.ssh/deploy -o StrictHostKeyChecking=yes root@${{ secrets.DEPLOY_HOST }} ${{ github.sha }}`.
  - Never `StrictHostKeyChecking=no`.

- [ ] **Step 1:** Write the workflow.
- [ ] **Step 2:** Run `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest`. Expected: no output, exit 0.
- [ ] **Step 3:** Run `docker buildx build --platform linux/amd64 -t warmhole:ci-check .`. Expected: the image builds.
- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "feat: test, build and deploy to hetzner on push to main"
```

### Task 3: Compose and docs

**Files:**
- Modify: `compose.yml`. The warmhole service drops `build: .` and becomes `image: ghcr.io/nbaglivo/warmhole:main`.
- Modify: `docs/hosting.md`. Replace the "after pulling changes" line and add a "Deploys" section.
- Modify: `README.md`. The compose snippet becomes `docker compose up -d`, plus one line saying that pushes to `main` deploy automatically (see `docs/hosting.md`).

The `docs/hosting.md` "Deploys" section must cover:
- An ASCII flow diagram in the existing style: push → test → image → ssh → `deploy.sh` → health check → rollback.
- What a deploy touches (only the warmhole service) and what it never touches (caddy, `Caddyfile`, Ghost, `.env`, `warmhole.json`).
- How to tell what's running: `docker image inspect warmhole:current --format '{{index .RepoTags}}'`.
- Redeploying by hand:
  - Run the workflow from the Actions tab.
  - Or, on the box: `/opt/warmhole/deploy.sh <sha>`.
- Rolling back by hand: `docker tag warmhole:previous warmhole:current && docker compose up -d --no-deps warmhole`.
- The script's exit codes.
- The one-time setup, numbered as in the spec. For step 5, use this exact replacement for the box's warmhole service:

```yaml
    image: warmhole:current
    pull_policy: never
```

  Then give the `authorized_keys` line: `restrict,command="/opt/warmhole/deploy.sh" ssh-ed25519 AAAA… github-deploy`.
- Fetching the known-hosts value: `ssh-keyscan -t ed25519 91.98.0.37`.

- [ ] **Step 1:** Make the edits.
- [ ] **Step 2:** Run `docker compose config --quiet` with a throwaway `.env` and `warmhole.json` copied from the examples. Expected: exit 0. Delete the throwaway files afterwards.
- [ ] **Step 3: Commit**

```bash
git add compose.yml docs/hosting.md README.md
git commit -m "docs: document continuous deploy and pull the published image"
```

### Task 4: Rollout (with Nico, after the branch merges)

These steps touch the box and GitHub settings. Run each one only with Nico's go-ahead.

- [ ] **Step 1:** Generate the key, `ssh-keygen -t ed25519 -N '' -C github-deploy -f <scratch>/deploy`. Add the three repo secrets with `gh secret set`, and create the `production` environment.
- [ ] **Step 2:** On the box:
  - Copy `scripts/deploy.sh` to `/opt/warmhole/deploy.sh` and `chmod 700` it.
  - Append the `authorized_keys` line.
  - Edit the warmhole service in `compose.yml` as documented.
  - Don't restart anything yet.
- [ ] **Step 3:** Merge to `main`, which triggers the workflow. The first deploy job fails at `docker pull` because the GHCR package starts private, and the box keeps running the old container (exit 1). Make the package public: GitHub → Packages → warmhole → Settings → Change visibility.
- [ ] **Step 4:** Re-run the failed deploy job. Expected:
  - The job is green.
  - `curl https://ap.nbaglivo.dev/healthz` returns `ok`.
  - `curl -I https://ghost.nbaglivo.dev` still answers.
- [ ] **Step 5:** Remove the leftover source files from `/opt/warmhole`, keeping `compose.yml`, `Caddyfile`, `.env`, `warmhole.json` and `deploy.sh`. Keep the `warmhole-warmhole` image until a second deploy has succeeded.
