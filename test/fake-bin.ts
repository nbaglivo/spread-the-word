import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type FakeBinOptions = {
  images?: string[]
  ghcrTags?: string[]
  health?: ('ok' | 'fail')[]
  pullFails?: boolean
  lockHeld?: boolean
}

export type FakeBin = {
  dir: string
  env: NodeJS.ProcessEnv
  calls(): string[]
}

const DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_STATE/calls"
case "$1" in
  pull)
    [[ -f "$FAKE_STATE/pull-fails" ]] && exit 1
    echo "$2" >> "$FAKE_STATE/images"
    ;;
  image)
    if [[ "$2" == inspect ]]; then grep -qxF -- "\${@: -1}" "$FAKE_STATE/images"; exit $?; fi
    if [[ "$2" == ls ]]; then cat "$FAKE_STATE/ghcr-tags"; fi
    ;;
  tag)
    grep -qxF -- "$2" "$FAKE_STATE/images" || exit 1
    echo "$3" >> "$FAKE_STATE/images"
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
  writeFileSync(join(state, 'calls'), '')
  writeFileSync(join(state, 'curl-count'), '0')
  writeFileSync(join(state, 'images'), lines(opts.images ?? []))
  writeFileSync(join(state, 'ghcr-tags'), lines(opts.ghcrTags ?? []))
  writeFileSync(join(state, 'health'), lines(opts.health ?? []))
  if (opts.pullFails) writeFileSync(join(state, 'pull-fails'), '')
  if (opts.lockHeld) writeFileSync(join(state, 'lock-held'), '')
  return {
    dir,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_STATE: state },
    calls: () => readFileSync(join(state, 'calls'), 'utf8').split('\n').filter(Boolean),
  }
}
