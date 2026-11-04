import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeBin, type FakeBinOptions } from '../test/fake-bin.ts'

const SCRIPT = join(import.meta.dirname, 'deploy.sh')
const SHA = 'a'.repeat(40)
const IMAGE = `ghcr.io/nbaglivo/spread-the-word:${SHA}`
const UP = 'docker compose up -d --no-deps warmhole'

function deploy(opts: FakeBinOptions, args: string[] = [SHA], extraEnv: NodeJS.ProcessEnv = {}) {
  const bin = fakeBin(opts)
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...bin.env,
      DEPLOY_DIR: mkdtempSync(join(tmpdir(), 'warmhole-deploy-dir-')),
      DEPLOY_HEALTH_TRIES: '2',
      DEPLOY_HEALTH_INTERVAL: '0',
      ...extraEnv,
    },
  })
  const calls = bin.calls()
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls,
    actions: calls.filter(
      (c) =>
        c.startsWith('docker ') &&
        !c.startsWith('docker image ') &&
        !c.startsWith('docker compose ps') &&
        !c.startsWith('docker inspect'),
    ),
  }
}

test('rejects anything but a full sha', () => {
  for (const bad of ['latest', 'abc', '$(reboot)', `${SHA}; rm -rf /`, SHA.toUpperCase()]) {
    const run = deploy({ images: ['warmhole:current'], health: ['ok'] }, [bad])
    assert.equal(run.status, 2, bad)
    assert.deepEqual(run.calls.filter((c) => c.startsWith('docker')), [], bad)
  }
})

test('reads the sha from SSH_ORIGINAL_COMMAND', () => {
  const run = deploy({ images: ['warmhole:current'], health: ['ok'] }, [], { SSH_ORIGINAL_COMMAND: SHA })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.calls[0], `docker pull ${IMAGE}`)
})

test('swaps the image and keeps the old one for rollback', () => {
  const run = deploy({ images: ['warmhole:current'], health: ['ok'] })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(run.actions, [
    `docker pull ${IMAGE}`,
    'docker tag warmhole:current warmhole:previous',
    `docker tag ${IMAGE} warmhole:current`,
    UP,
  ])
  assert.match(run.stdout, new RegExp(`deployed ${SHA}`))
  const curl = run.calls.find((c) => c.startsWith('curl ')) ?? ''
  assert.ok(curl.includes('--resolve ap.nbaglivo.dev:443:127.0.0.1'), curl)
  assert.ok(curl.includes('https://ap.nbaglivo.dev/healthz'), curl)
})

test('keeps the box-built image as rollback on the first deploy', () => {
  const run = deploy({ images: ['warmhole-warmhole'], health: ['ok'] })
  assert.equal(run.status, 0, run.stderr)
  assert.ok(run.actions.includes('docker tag warmhole-warmhole warmhole:previous'), run.actions.join('\n'))
})

test('rolls back when the new image is unhealthy', () => {
  const run = deploy({ images: ['warmhole:current'], health: ['fail', 'fail', 'ok'] })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /rolled back/)
  assert.ok(run.actions.includes('docker tag warmhole:previous warmhole:current'), run.actions.join('\n'))
  assert.equal(run.actions.filter((c) => c === UP).length, 2)
})

test('rolls back when compose up fails for the new image', () => {
  const run = deploy({ images: ['warmhole:current'], health: ['ok'], upFails: 1 })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /rolled back/)
  assert.ok(run.actions.includes('docker tag warmhole:previous warmhole:current'), run.actions.join('\n'))
})

test('exits 3 when compose up fails during the rollback too', () => {
  const run = deploy({ images: ['warmhole:current'], health: ['ok'], upFails: 2 })
  assert.equal(run.status, 3)
})

test('does not report success while compose still runs the old image', () => {
  const run = deploy({ images: ['warmhole-warmhole'], health: ['ok', 'ok'], staleCompose: true })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /not running warmhole:current/)
  assert.doesNotMatch(run.stdout, /deployed/)
})

test('exits 3 when the rollback is unhealthy too', () => {
  const run = deploy({ images: ['warmhole:current'], health: [] })
  assert.equal(run.status, 3)
})

test('exits 3 when there is nothing to roll back to', () => {
  const run = deploy({ images: [], health: [] })
  assert.equal(run.status, 3)
  assert.match(run.stderr, /no previous image/)
  assert.deepEqual(run.actions.filter((c) => c.includes('warmhole:previous')), [])
})

test('leaves everything alone when the pull fails', () => {
  const run = deploy({ images: ['warmhole:current'], health: ['ok'], pullFails: true })
  assert.equal(run.status, 1)
  assert.deepEqual(run.actions, [`docker pull ${IMAGE}`])
})

test('refuses to run while another deploy holds the lock', () => {
  const run = deploy({ images: ['warmhole:current'], health: ['ok'], lockHeld: true })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /another deploy/)
  assert.deepEqual(run.calls.filter((c) => c.startsWith('docker')), [])
})

test('prunes all but the three newest sha tags after a healthy deploy', () => {
  const tags = ['1', '2', '3', '4', '5'].map((c) => c.repeat(40))
  const healthy = deploy({ images: ['warmhole:current'], ghcrTags: tags, health: ['ok'] })
  assert.equal(healthy.status, 0, healthy.stderr)
  assert.deepEqual(healthy.actions.filter((c) => c.startsWith('docker rmi')), [
    `docker rmi ghcr.io/nbaglivo/spread-the-word:${tags[3]}`,
    `docker rmi ghcr.io/nbaglivo/spread-the-word:${tags[4]}`,
  ])

  const rolledBack = deploy({ images: ['warmhole:current'], ghcrTags: tags, health: ['fail', 'fail', 'ok'] })
  assert.equal(rolledBack.status, 1)
  assert.deepEqual(rolledBack.actions.filter((c) => c.startsWith('docker rmi')), [])
})

test('never touches caddy or the config files', () => {
  const runs = [
    deploy({ images: ['warmhole:current'], health: ['ok'] }),
    deploy({ images: ['warmhole:current'], health: ['fail', 'fail', 'ok'] }),
  ]
  for (const run of runs) {
    for (const call of run.calls) {
      assert.ok(!/caddy|\.env|warmhole\.json/.test(call), call)
    }
  }
})
