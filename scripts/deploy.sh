#!/usr/bin/env bash
# Runs on the box as the forced command of the GitHub deploy key.
# Usage: deploy.sh <sha>, or the sha alone as the ssh command.
# Exit codes: 0 deployed, 1 failed and the previous image runs (or nothing
# changed), 2 invalid input, 3 rollback impossible or also failed.
set -euo pipefail

REPO=ghcr.io/nbaglivo/warmhole
HOST=ap.nbaglivo.dev
KEEP=3
dir="${DEPLOY_DIR:-/opt/warmhole}"
tries="${DEPLOY_HEALTH_TRIES:-15}"
interval="${DEPLOY_HEALTH_INTERVAL:-2}"

sha="${1:-${SSH_ORIGINAL_COMMAND:-}}"
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: deploy.sh <40-character commit sha>" >&2
  exit 2
fi

cd "$dir"
exec 9>.deploy.lock
if ! flock -n 9; then
  echo "another deploy is running" >&2
  exit 1
fi

exists() { docker image inspect "$1" >/dev/null 2>&1; }

up() { docker compose up -d --no-deps warmhole; }

healthy() {
  local i body
  for ((i = 1; i <= tries; i++)); do
    body="$(curl -fsS --max-time 5 --resolve "$HOST:443:127.0.0.1" "https://$HOST/healthz" 2>/dev/null || true)"
    if [[ "$body" == ok ]]; then return 0; fi
    if ((i < tries)); then sleep "$interval"; fi
  done
  return 1
}

prune() {
  docker image ls "$REPO" --format '{{.Tag}}' | grep -E '^[0-9a-f]{40}$' | tail -n +$((KEEP + 1)) |
    while read -r old; do docker rmi "$REPO:$old" || true; done
}

runs_current() {
  local cid running wanted
  cid="$(docker compose ps -q warmhole)"
  [[ -n "$cid" ]] || return 1
  running="$(docker inspect -f '{{.Image}}' "$cid")"
  wanted="$(docker image inspect -f '{{.Id}}' warmhole:current)"
  [[ "$running" == "$wanted" ]]
}

switch() {
  if ! up; then
    echo "docker compose up failed" >&2
    return 1
  fi
  if ! healthy; then
    echo "health check failed" >&2
    return 1
  fi
  if ! runs_current; then
    echo "the warmhole container is not running warmhole:current (is compose.yml still on build: .?)" >&2
    return 1
  fi
}

if ! docker pull "$REPO:$sha"; then
  echo "pull of $REPO:$sha failed, nothing changed" >&2
  exit 1
fi

if exists warmhole:current; then
  docker tag warmhole:current warmhole:previous
elif exists warmhole-warmhole; then
  docker tag warmhole-warmhole warmhole:previous
fi

docker tag "$REPO:$sha" warmhole:current

if switch; then
  prune || true
  echo "deployed $sha"
  exit 0
fi

if ! exists warmhole:previous; then
  echo "deploy of $sha failed and there is no previous image to roll back to" >&2
  exit 3
fi

echo "deploy of $sha failed, rolling back" >&2
docker tag warmhole:previous warmhole:current
if switch; then
  echo "rolled back to the previous image" >&2
  exit 1
fi
echo "rollback failed too" >&2
exit 3
