import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type FakeBinOptions = {
  images?: string[]
  ghcrTags?: string[]
  health?: ('ok' | 'fail')[]
  pullFails?: boolean
  lockHeld?: boolean
  upFails?: number
  staleCompose?: boolean
}

export type FakeBin = {
  dir: string
  env: NodeJS.ProcessEnv
  calls(): string[]
}

const DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_STATE/calls"
id_of() { awk -v r="$1" '$1 == r { id = $2 } END { print id }' "$FAKE_STATE/images"; }
case "$1" in
  pull)
    [[ -f "$FAKE_STATE/pull-fails" ]] && exit 1
    echo "$2 id-pulled" >> "$FAKE_STATE/images"
    ;;
  image)
    if [[ "$2" == inspect ]]; then
      id="$(id_of "\${@: -1}")"
      [[ -n "$id" ]] || exit 1
      [[ "$3" == -f ]] && echo "$id"
      exit 0
    fi
    if [[ "$2" == ls ]]; then cat "$FAKE_STATE/ghcr-tags"; fi
    ;;
  tag)
    id="$(id_of "$2")"
    [[ -n "$id" ]] || exit 1
    echo "$3 $id" >> "$FAKE_STATE/images"
    ;;
  compose)
    if [[ "$2" == ps ]]; then [[ -s "$FAKE_STATE/running" ]] && echo c1; exit 0; fi
    if [[ "$2" == up ]]; then
      n=$(( $(cat "$FAKE_STATE/up-count") + 1 ))
      echo "$n" > "$FAKE_STATE/up-count"
      (( n <= $(cat "$FAKE_STATE/up-fails") )) && exit 1
      [[ -f "$FAKE_STATE/stale-compose" ]] || id_of warmhole:current > "$FAKE_STATE/running"
    fi
    ;;
  inspect)
    cat "$FAKE_STATE/running"
    ;;
esac
exit 0
`

const CURL = `#!/usr/bin/env bash
echo "curl $*" >> "$FAKE_STATE/calls"
n=$(( $(cat "$FAKE_STATE/curl-count") + 1 ))
echo "$n" > "$FAKE_STATE/curl-count"
if [[ "$(sed -n "\${n}p" "$FAKE_STATE/health")" == ok ]]; then printf ok; exit 0; fi
exit 22
`

const FLOCK = `#!/usr/bin/env bash
[[ -f "$FAKE_STATE/lock-held" ]] && exit 1
exit 0
`

const lines = (items: string[]) => items.map((item) => `${item}\n`).join('')

export function fakeBin(opts: FakeBinOptions = {}): FakeBin {
  const dir = mkdtempSync(join(tmpdir(), 'warmhole-fake-bin-'))
  const state = mkdtempSync(join(tmpdir(), 'warmhole-fake-state-'))
  for (const [name, body] of [['docker', DOCKER], ['curl', CURL], ['flock', FLOCK]]) {
    writeFileSync(join(dir, name), body)
    chmodSync(join(dir, name), 0o755)
  }
  const images = opts.images ?? []
  const idOf = (ref: string) => `id-${images.indexOf(ref)}`
  const running = images.includes('warmhole:current')
    ? idOf('warmhole:current')
    : images.includes('warmhole-warmhole')
      ? idOf('warmhole-warmhole')
      : ''
  writeFileSync(join(state, 'calls'), '')
  writeFileSync(join(state, 'curl-count'), '0')
  writeFileSync(join(state, 'up-count'), '0')
  writeFileSync(join(state, 'up-fails'), String(opts.upFails ?? 0))
  writeFileSync(join(state, 'images'), lines(images.map((ref) => `${ref} ${idOf(ref)}`)))
  writeFileSync(join(state, 'running'), running ? `${running}\n` : '')
  writeFileSync(join(state, 'ghcr-tags'), lines(opts.ghcrTags ?? []))
  writeFileSync(join(state, 'health'), lines(opts.health ?? []))
  if (opts.pullFails) writeFileSync(join(state, 'pull-fails'), '')
  if (opts.lockHeld) writeFileSync(join(state, 'lock-held'), '')
  if (opts.staleCompose) writeFileSync(join(state, 'stale-compose'), '')
  return {
    dir,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_STATE: state },
    calls: () => readFileSync(join(state, 'calls'), 'utf8').split('\n').filter(Boolean),
  }
}
