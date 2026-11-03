import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeLine } from './logview.ts'

const at = '2026-10-16T12:43:49.208Z'

function line(fields: Record<string, unknown>): string {
  return JSON.stringify({ '@timestamp': at, level: 'INFO', properties: {}, ...fields })
}

test('deliveries show the activity, the post and the receiving host', () => {
  const sent = line({
    logger: 'fedify.federation.outbox',
    message: 'Successfully sent activity "https://ap.test/users/inner-monologue/posts/creating-a-life#create" to "https://mastodon.social/inbox".',
    properties: { activityId: 'https://ap.test/users/inner-monologue/posts/creating-a-life#create', inbox: 'https://mastodon.social/inbox' },
  })
  assert.equal(describeLine(sent, 'UTC'), '12:43:49 sent Create creating-a-life → mastodon.social')

  const accept = line({
    logger: 'fedify.federation.outbox',
    message: 'Successfully sent activity ...',
    properties: { activityId: 'https://ap.test/users/inner-monologue#accepts/1b2c', inbox: 'https://mastodon.social/users/bob/inbox' },
  })
  assert.equal(describeLine(accept, 'UTC'), '12:43:49 sent Accept → mastodon.social')
})

test('requests are one short line and health checks are hidden', () => {
  const request = line({
    logger: 'fedify.federation.http',
    level: 'WARN',
    message: '"GET" "/favicon.ico": 404',
    properties: { method: 'GET', path: '/favicon.ico', status: 404 },
  })
  assert.equal(describeLine(request, 'UTC'), '12:43:49 GET /favicon.ico 404')
  const health = line({ logger: 'fedify.federation.http', message: '', properties: { method: 'GET', path: '/healthz', status: 200 } })
  assert.equal(describeLine(health, 'UTC'), null)
})

test('other lines keep their message, without quotes, and flag warnings and errors', () => {
  const synced = line({ logger: 'warmhole.sync', message: 'synced "inner-monologue": 1 new, 0 updated, 0 deleted' })
  assert.equal(describeLine(synced, 'UTC'), '12:43:49 synced inner-monologue: 1 new, 0 updated, 0 deleted')
  const failed = line({ logger: 'warmhole.sync', level: 'ERROR', message: 'sync of "inner-monologue" crashed: Error: disk full' })
  assert.equal(describeLine(failed, 'UTC'), '12:43:49 ERROR sync of inner-monologue crashed: Error: disk full')
})

test('email lines stay short, with quoted values unquoted', () => {
  const joined = line({ logger: 'warmhole.email', message: '"inner-monologue": new subscriber, 3 subscribers' })
  assert.equal(describeLine(joined, 'UTC'), '12:43:49 inner-monologue: new subscriber, 3 subscribers')
  const retry = line({
    logger: 'warmhole.email',
    level: 'WARN',
    message: '"inner-monologue": email of "Title b" to "n***@gmail.com" failed (attempt 2): "421 try later"',
  })
  assert.equal(describeLine(retry, 'UTC'), '12:43:49 WARN inner-monologue: email of Title b to n***@gmail.com failed (attempt 2): 421 try later')
})

test('lines that are not json pass through unchanged', () => {
  assert.equal(describeLine('Listening on :8080', 'UTC'), 'Listening on :8080')
  assert.equal(describeLine('', 'UTC'), null)
})
